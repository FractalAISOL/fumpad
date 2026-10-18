/**
 * Watcher process (`--mode watcher`): independently re-derives every coin from its OWN RPC (ideally a 4th
 * provider), compares every on-chain TicketAttested / TicketDebited with the derivation (verify.ts), alerts
 * on any mismatch (Telegram, so the guardian can `void_ticket` inside the challenge window) and on derived
 * attestations that never landed, alerts on every pending governance change (params / DBC config queued, authority
 * change proposed: governance.ts — the timelocks are 1 h / 6 h, SPEC v0.7 C-TL), and serves a public verification feed:
 *   GET /v1/verification            → every coin's verdicts (mismatches first)
 *   GET /v1/verification?mint=<m>   → one coin
 *   GET /v1/verification/ticket/<t> → one ticket's verdict
 *   GET /health
 * The watcher holds no key and sends nothing.
 */
import { createServer } from "node:http";

import { Connection, PublicKey } from "@solana/web3.js";
import pino, { type Logger } from "pino";

import { CrawlBudgetExceeded, PriceNotReady } from "@fumpad/engine";
import { MeteoraRpc } from "@fumpad/meteora";
import type { CoinAccount, GlobalAccount } from "@fumpad/sdk";

import { Alerter, deriveAlert } from "../alerts.js";
import { groupIssues, issueAlertKey } from "../attest/attestor.js";
import { RpcChainView } from "../attest/chain.js";
import { deriveCoin, type Derivation } from "../attest/derive.js";
import { guardHistory } from "../attest/history-check.js";
import { checkPythSource, deriveLimitsFromEnv, pythSourceFromEnv, type Running } from "../attest/run.js";
import { governanceAlerts } from "./governance.js";
import { type CoinVerification, verifyCoin } from "./verify.js";

export interface WatcherDeps {
  coins(): Promise<CoinAccount[]>;
  global(): Promise<GlobalAccount>;
  derive(coin: CoinAccount, g: GlobalAccount): Promise<Derivation>;
  alerts?: Pick<Alerter, "alert">;
  now?: () => number;
  graceSecs?: number;
  /** S-1: alert once the same coin's crawl ran out of budget this many ticks in a row (default 4). */
  crawlAlertTicks?: number;
  log?: Pick<Logger, "info">;
}

export class Watcher {
  results = new Map<string, CoinVerification & { checkedAt: number; error?: string }>();
  stats = { ticks: 0, coins: 0, matches: 0, mismatches: 0, missing: 0, issues: 0, errors: 0, governancePending: 0, lastTickAt: 0 };
  private crawlMisses = new Map<string, number>();
  constructor(private d: WatcherDeps) {}

  private now() {
    return this.d.now ? this.d.now() : Math.floor(Date.now() / 1000);
  }

  /** L-6: fire-and-forget (the Alerter dedupes synchronously and never throws): a slow Telegram never stalls a tick. */
  private notify(key: string, text: string, opts?: { cooldownMs?: number }): void {
    void Promise.resolve(this.d.alerts?.alert(key, text, opts)).catch(() => {});
  }

  async tick(): Promise<void> {
    this.stats.ticks++;
    const g = await this.d.global();
    // C-TL: pending governance changes first (the guardian has 1 h / 6 h to cancel).
    const gov = governanceAlerts(g, this.now());
    this.stats.governancePending = gov.length;
    for (const a of gov) this.notify(a.key, a.text);
    const coins = await this.d.coins();
    this.stats.coins = coins.length;
    let matches = 0;
    let mismatches = 0;
    let missing = 0;
    let issues = 0;
    for (const coin of coins) {
      const mint = coin.mint.toBase58();
      try {
        const der = await this.d.derive(coin, g);
        const v = verifyCoin(mint, der.output, der.history, this.now(), this.d.graceSecs);
        this.results.set(mint, { ...v, checkedAt: this.now() });
        for (const x of v.verdicts) {
          if (x.verdict === "match") {
            matches++;
            continue;
          }
          mismatches++;
          if (x.voided) continue; // the guardian already acted on it
          const challengeEnds = (x.effectiveAt ?? x.attestedAt) + Number(g.params.ticketChallengeSecs);
          this.notify(
            `mismatch:${x.kind}:${x.ticket}:${x.signature}`,
            `ATTESTATION MISMATCH (${x.kind}) ticket ${x.ticket} owner ${x.owner} mint ${mint} tx ${x.attestedIn}: ${Object.entries(x.diffs)
              .map(([f, [a, b]]) => `${f} chain=${a} derived=${b}`)
              .join("; ")}. Challenge window ends ${new Date(challengeEnds * 1000).toISOString()} — guardian void_ticket if confirmed.`,
          );
        }
        const maxAge = Number(g.params.maxAttestAgeSecs);
        for (const m of v.missing) {
          missing++;
          if (m.kind === "rebuy")
            this.notify(`missing:${m.ticket}:${m.signature}`, `rebuy debit not attested: ticket ${m.ticket} owner ${m.owner} mint ${mint} buy ${m.signature} (${m.ageSecs}s old)`);
          // L7: an honest sell that should have a ticket but none landed (keepers down / disagreeing /
          // suppressed). Actionable until max_attest_age; reported once more just after it expires.
          else if (m.ageSecs <= maxAge + 3_600)
            this.notify(
              `missing-sell:${m.signature}:${m.ixKey}`,
              `sell not attested: ${m.owner} on ${mint} tx ${m.signature} (${m.ageSecs}s old; ${m.ageSecs > maxAge ? "EXPIRED — can no longer be attested" : `expires in ${maxAge - m.ageSecs}s`})`,
            );
        }
        // L7: engine issues (scoped per tx / wallet, V7-H2) — follow the runbook in services/README.md
        issues += der.output.issues.length;
        // L-6: alert identity = (mint, issue kind) — stable while the problem persists (the count of issues used to be
        // part of the key, so every new issue re-alerted); a new kind alerts at once
        for (const [kind, list] of groupIssues(der.output.issues))
          this.notify(
            issueAlertKey(mint, kind),
            `engine issues (${kind}) on ${mint}: ${list.length} — ${list
              .slice(-10)
              .map((i) => `${i.scope}${i.wallet ? `:${i.wallet}` : ""} tx ${i.signature} slot ${i.slot}`)
              .join("; ")
              .slice(0, 600)}`,
          );
        if (this.crawlMisses.delete(mint)) this.d.log?.info({ mint }, "watcher: crawl completed again");
      } catch (e) {
        // a recent sell's SOL/USD window isn't finalized yet (PYTH_SOURCE=onchain): keep the last result, retry next tick
        if (e instanceof PriceNotReady) continue;
        if (e instanceof CrawlBudgetExceeded) {
          // S-1: progress is kept and the budget adapts; alert only when the same coin keeps failing
          const n = (this.crawlMisses.get(mint) ?? 0) + 1;
          this.crawlMisses.set(mint, n);
          if (n >= (this.d.crawlAlertTicks ?? 4))
            this.notify(`crawl-budget:${mint}`, `watcher: crawl of ${mint} ran out of its RPC budget (${e.calls} calls) ${n} ticks in a row — verification of this coin is stale`, {
              cooldownMs: 60 * 60_000,
            });
          continue;
        }
        this.stats.errors++;
        this.results.set(mint, { mint, verdicts: [], missing: [], checkedAt: this.now(), error: String(e).slice(0, 300) });
        // once per hour per (coin, error signature); a new kind of failure alerts at once
        const a = deriveAlert("watch", mint, e);
        this.notify(a.key, `watcher: derivation failed for ${mint}: ${String(e).slice(0, 200)} (repeats muted 1 h)`, a.opts);
      }
    }
    Object.assign(this.stats, { matches, mismatches, missing, issues, lastTickAt: this.now() });
  }

  feed(mint?: string) {
    const coins = [...this.results.values()].filter((c) => !mint || c.mint === mint);
    const rank = (c: CoinVerification) => (c.verdicts.some((v) => v.verdict === "mismatch") ? 0 : 1);
    return { generatedAt: this.stats.lastTickAt, coins: coins.sort((a, b) => rank(a) - rank(b) || (a.mint < b.mint ? -1 : 1)) };
  }

  ticket(ticket: string) {
    for (const c of this.results.values()) for (const v of c.verdicts) if (v.ticket === ticket) return v;
    return null;
  }
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export async function runWatcher(env = process.env): Promise<Running> {
  const log = pino({ level: env.LOG_LEVEL ?? "info", base: { svc: "watcher" } });
  const url = env.RPC_URL || "http://127.0.0.1:8899";
  const conn = new Connection(url, "confirmed");
  const rpc = new MeteoraRpc(url, { minGapMs: Number(env.RPC_MIN_GAP_MS ?? 0) });
  const chain = new RpcChainView(conn, "finalized");
  const pyth = pythSourceFromEnv(env);
  await checkPythSource(pyth);
  const { caches, maxRpcCalls, maxRpcCallsCeiling, engine, priceCache } = deriveLimitsFromEnv(env);
  // L7: re-alert an unresolved item every 30 min (the challenge window is 6 h: one alert per window was too few)
  const alerts = new Alerter(log, { botToken: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, prefix: "[fumpad-watcher]", cooldownMs: Number(env.WATCH_ALERT_COOLDOWN_MS ?? 30 * 60_000) });
  const derive = (coin: CoinAccount, g: GlobalAccount) =>
    deriveCoin({ rpc, fetchPrice: (t, d) => pyth.priceAt(t, d), caches, priceCache, maxRpcCalls, maxRpcCallsCeiling, engine }, coin, g);
  const w = new Watcher({
    coins: () => chain.coins(),
    global: () => chain.global(),
    derive: env.RPC_HISTORY_CHECK === "off" ? derive : guardHistory(rpc, derive),
    alerts,
    graceSecs: Number(env.WATCH_GRACE_SECS ?? 900),
    crawlAlertTicks: Number(env.ATTEST_CRAWL_ALERT_TICKS ?? 4),
    log,
  });
  let stopped = false;
  const loopMs = Number(env.WATCH_LOOP_MS ?? 30_000);
  const loop = (async () => {
    while (!stopped) {
      try {
        await w.tick();
      } catch (e) {
        log.error({ err: String(e).slice(0, 300) }, "watcher tick failed");
      }
      await new Promise((r) => setTimeout(r, loopMs));
    }
  })();
  const port = Number(env.PORT ?? env.HEALTH_PORT ?? 8790);
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    res.setHeader("content-type", "application/json");
    res.setHeader("access-control-allow-origin", "*");
    if (u.pathname === "/health") return res.end(json({ ok: true, mode: "watcher", ...w.stats }));
    if (u.pathname === "/v1/verification") {
      const mint = u.searchParams.get("mint") ?? undefined;
      if (mint && !isPk(mint)) return void res.writeHead(400).end(json({ error: "invalid mint" }));
      return res.end(json(w.feed(mint)));
    }
    const m = /^\/v1\/verification\/ticket\/([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(u.pathname);
    if (m) {
      const v = w.ticket(m[1]);
      if (!v) return void res.writeHead(404).end(json({ error: "unknown ticket" }));
      return res.end(json(v));
    }
    res.writeHead(404).end(json({ error: "not found" }));
  }).listen(port);
  log.info({ port, rpc: new URL(url).origin }, "watcher started");
  return {
    async stop() {
      stopped = true;
      server.close();
      await loop.catch(() => {});
    },
  };
}

function isPk(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}
