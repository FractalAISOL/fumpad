/**
 * FUMPAD v0.7 LIVE devnet scenario — mirrors scripts/local/e2e.ts against the deployed program
 * (5YMF…S9Fb), the live Railway API and the live keeper / attestors / watcher. User actions only;
 * everything else must be done by the running services.
 *
 *   npx tsx scripts/devnet/live-v07.ts --step status        # balances, coin + tickets summary (default)
 *   npx tsx scripts/devnet/live-v07.ts --step launch        # 1. creator launches via POST /v1/launch/prepare (+ first buy)
 *   npx tsx scripts/devnet/live-v07.ts --step buys          # 2. alice direct DBC buy, bob routed buy (after the 8-slot window)
 *   npx tsx scripts/devnet/live-v07.ts --step sells         # 3. after the 60 s hold: alice direct sell, bob routed sell (≥ $5 each)
 *   npx tsx scripts/devnet/live-v07.ts --step attest        # 4. wait for both TicketAttested (chain + API)
 *   npx tsx scripts/devnet/live-v07.ts --step graduate      # 5. whale PartialFill completes the curve → keeper migrates + graduates
 *   npx tsx scripts/devnet/live-v07.ts --step post          # 6. alice trades on DAMM v2 directly; samples; API venues
 *   npx tsx scripts/devnet/live-v07.ts --step pump [--lamports N]   # 6b. optional: whale routed DAMM v2 buy (lift price past 10x)
 *   npx tsx scripts/devnet/live-v07.ts --step verify        # one local watcher tick (independent re-derivation, Hermes price)
 *   npx tsx scripts/devnet/live-v07.ts --step claims [--wait]  # 7. claimable time, 10x trigger, keeper auto-claim
 *   npx tsx scripts/devnet/live-v07.ts --step all           # 1 → 7 (each step skips what the state file says is done)
 *
 * State (resumable): ~/fumpad-keys/devnet/v07/live-state.json. Keys: ~/fumpad-keys/devnet/v07/{creator,alice,bob,whale}.json.
 * RPC: RPC_URL from ~/fumpad-keys/devnet/rpc.env — never printed (errors are redacted); refuses a non-devnet genesis.
 * Spends only the test wallets' SOL.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";

import {
  type CoinRefs,
  coinPda,
  confirmSignature,
  dbcQuoteToComplete,
  decodeCoin,
  decodeDammPool,
  decodeDbcConfig,
  decodeDbcPool,
  decodeFumpadEvents,
  decodeGlobal,
  decodeObservations,
  decodePosition,
  decodeTicket,
  decodeTokenAccount,
  FUMPAD_PROGRAM_ID,
  globalPda,
  inspectLaunchTx,
  isFumpadVanityMint,
  medianPriceQ64,
  observationsPda,
  positionPda,
  quoteDbcBuy,
  quoteDbcSell,
  rewardVault,
  SNIPE_PERIODS,
  solPerTokenFromSqrt,
  type TicketAccount,
  ticketPda,
  type TxLike,
} from "@fumpad/sdk";
import { signLaunchAuth } from "@fumpad/api";

import { directDammBuy, directDammSell, directDbcBuy, directDbcSell, routedBuy, routedSell, tokenBalance } from "../local/actors.js";
import { readRpcUrl } from "./bootstrap-v07.js";
import { Watcher } from "../../keeper/src/watch/run.js";
import { deriveLimitsFromEnv, pythSourceFromEnv } from "../../keeper/src/attest/run.js";
import { RpcChainView } from "../../keeper/src/attest/chain.js";
import { deriveCoin } from "../../keeper/src/attest/derive.js";
import { MeteoraRpc } from "@fumpad/meteora";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const KEYS = join(homedir(), "fumpad-keys/devnet/v07");
const STATE_FILE = join(KEYS, "live-state.json");
const API = process.env.FUMPAD_API ?? "https://api-production-66441.up.railway.app";
const SOL = BigInt(LAMPORTS_PER_SOL);
const Q64 = 1n << 64n;
const sol = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(5);
const tx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
const acct = (a: string | PublicKey) => `https://solscan.io/account/${a.toString()}?cluster=devnet`;
const iso = (secs: number | bigint) => new Date(Number(secs) * 1000).toISOString();
const nowSecs = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Step = "status" | "pump" | "verify" | "launch" | "buys" | "sells" | "attest" | "graduate" | "post" | "claims";
const ORDER: Step[] = ["launch", "buys", "sells", "attest", "graduate", "post", "claims"];

interface Trade { sig: string; ts: number; slot: number; lamports?: string; tokens?: string; usdEst?: number }
interface State {
  mint?: string;
  launch?: Trade & { creatorTokens: string; feeLamports: string; feeBps: number };
  buys?: { alice?: Trade; bob?: Trade };
  sells?: { alice?: Trade; bob?: Trade };
  tickets?: Record<string, { ticket: string; source: string; tokens: string; usdCents: string; effectiveAt: number; claimableAt: number; status: string; sellPriceQ64: string }>;
  whale?: Trade;
  graduated?: { at: number; dammPool: string; dammPosition: string; vault: string; launchFeesSettled: boolean };
  post?: { buy?: Trade; sell?: Trade };
  pump?: Trade;
  claims?: { checkedAt: number; result: Record<string, unknown> };
  checks: { step: string; name: string; ok: boolean; detail?: string; at: number }[];
}

const loadState = (): State => (existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : { checks: [] });
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });
const kp = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(KEYS, `${name}.json`), "utf8")) as number[]));

class Run {
  conn: Connection;
  st: State;
  creator = kp("creator");
  alice = kp("alice");
  bob = kp("bob");
  whale = kp("whale");
  ssr = existsSync(join(homedir(), "fumpad-keys/devnet/api_ssr_secret")) ? readFileSync(join(homedir(), "fumpad-keys/devnet/api_ssr_secret"), "utf8").trim() : "";
  step: Step = "status";
  failed = 0;

  constructor(rpcUrl: string) {
    this.conn = new Connection(rpcUrl, "confirmed");
    this.st = loadState();
  }

  check(name: string, ok: boolean, detail?: string) {
    console.log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) this.failed++;
    this.st.checks.push({ step: this.step, name, ok, detail, at: nowSecs() });
    saveState(this.st);
  }

  async get<T>(path: string): Promise<T> {
    const r = await fetch(API + path, { headers: this.ssr ? { "x-fumpad-ssr": this.ssr } : {} });
    if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }

  async waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 5_000): Promise<T | null> {
    const t0 = Date.now();
    let last = 0;
    for (;;) {
      const v = await fn().catch((e) => {
        console.log(`    (${what}: ${String(e).slice(0, 160)})`);
        return null;
      });
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      if (Date.now() - last > 60_000) {
        console.log(`    … waiting for ${what} (${Math.round((Date.now() - t0) / 1000)} s)`);
        last = Date.now();
      }
      await sleep(everyMs);
    }
  }

  get mint() {
    if (!this.st.mint) throw new Error("no coin yet: run --step launch first");
    return new PublicKey(this.st.mint);
  }
  async coin() {
    const a = await this.conn.getAccountInfo(coinPda(this.mint));
    if (!a) throw new Error("coin account missing");
    return decodeCoin(new Uint8Array(a.data));
  }
  async refs(): Promise<CoinRefs> {
    const c = await this.coin();
    return { mint: this.mint, dbcConfig: c.dbcConfig, dbcPool: c.dbcPool, dammPool: c.status === "graduated" ? c.dammPool : undefined, creator: c.creator };
  }
  async dbc(c?: { dbcConfig: PublicKey; dbcPool: PublicKey }) {
    const coin = c ?? (await this.coin());
    const [cfgA, poolA] = await this.conn.getMultipleAccountsInfo([coin.dbcConfig, coin.dbcPool]);
    return { cfg: decodeDbcConfig(new Uint8Array(cfgA!.data)), pool: decodeDbcPool(new Uint8Array(poolA!.data)) };
  }
  async txInfo(sig: string) {
    const t = await this.conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!t) throw new Error(`tx ${sig} not found`);
    return t;
  }
  async solUsd(): Promise<number> {
    return (await this.get<{ solUsd: number }>("/v1/sol-usd")).solUsd;
  }

  // ── status ──────────────────────────────────────────────────────────────
  async status() {
    for (const [n, k] of Object.entries({ creator: this.creator, alice: this.alice, bob: this.bob, whale: this.whale })) {
      const b = await this.conn.getBalance(k.publicKey);
      const t = this.st.mint ? await tokenBalance(this.conn, k.publicKey, this.mint) : 0n;
      console.log(`  ${n.padEnd(8)} ${k.publicKey.toBase58()}  ${sol(b)} SOL${this.st.mint ? `  ${Number(t) / 1e6} tokens` : ""}`);
    }
    if (!this.st.mint) return;
    const c = await this.coin();
    console.log(`  coin ${this.st.mint} status=${c.status} launchFeesSettled=${c.launchFeesSettled} feesClaimed=${sol(c.feesClaimedLamports)} buybackSpent=${sol(c.buybackSpentLamports)} tickets=${c.ticketsCreated} paidOut=${c.tokensPaidOut}`);
    for (const [n, k] of [["alice", this.alice], ["bob", this.bob]] as const) {
      const a = await this.conn.getAccountInfo(ticketPda(this.mint, k.publicKey, 0n));
      if (!a) console.log(`  ${n} ticket #0: none`);
      else {
        const t = decodeTicket(new Uint8Array(a.data));
        console.log(`  ${n} ticket #0: ${t.status} ${t.source} tokens=${t.tokens} $${Number(t.sellUsdCents) / 100} effectiveAt=${iso(t.attestedAt)} claimable≥${iso(t.attestedAt + 3600n)}`);
      }
    }
  }

  // ── 1. launch ───────────────────────────────────────────────────────────
  async launch() {
    if (this.st.launch) return console.log(`  (done) ${this.st.mint} ${tx(this.st.launch.sig)}`);
    const initialBuy = SOL / 50n; // 0.02 SOL
    const g = decodeGlobal(new Uint8Array((await this.conn.getAccountInfo(globalPda()))!.data));
    const symbol = "LIVE7";
    const auth = signLaunchAuth(this.creator.secretKey, { creator: this.creator.publicKey.toBase58(), symbol });
    const r = await fetch(`${API}/v1/launch/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creator: this.creator.publicKey.toBase58(), name: "Fumpad Live v07", symbol, uri: "https://fumpad.fun/m/live7.json", initialBuyLamports: String(initialBuy), auth }),
    });
    if (!r.ok) throw new Error(`prepare → ${r.status} ${await r.text()}`);
    const prepared = (await r.json()) as { mint: string; transaction: string; lastValidBlockHeight: number; firstBuy?: { tokensOut: string; minTokensOut: string } };
    const ltx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
    const info = inspectLaunchTx(ltx);
    const launchSigner = g.params.launchSigner.toBase58();
    const cfgKey = g.configs.find((k) => !k.equals(PublicKey.default))!;
    this.check(
      "prepare: creator = fee payer, pre-signed only by the …fmbL mint + launch_signer, our DBC config, 0.02 SOL first buy",
      info.feePayer === this.creator.publicKey.toBase58() && [...info.signed].sort().join() === [prepared.mint, launchSigner].sort().join() && info.dbcConfig === cfgKey.toBase58() && info.buyLamports === initialBuy && isFumpadVanityMint(prepared.mint),
      `mint ${prepared.mint}, signed by ${info.signed.join(", ")}`,
    );
    const before = await this.conn.getBalance(this.creator.publicKey);
    ltx.sign([this.creator]);
    const raw = ltx.serialize();
    const sig = await this.conn.sendRawTransaction(raw, { maxRetries: 0 });
    await confirmSignature(this.conn, sig, prepared.lastValidBlockHeight, "confirmed", raw);
    console.log(`  → launch ${tx(sig)}`);
    this.st.mint = prepared.mint;
    saveState(this.st);
    const t = await this.txInfo(sig);
    const coin = await this.coin();
    this.check("coin registered on chain (status curve, our config, creator)", coin.status === "curve" && coin.dbcConfig.equals(cfgKey) && coin.creator.equals(this.creator.publicKey), acct(coinPda(this.mint)));
    this.check("launch tx emitted CoinRegistered", decodeFumpadEvents(t as unknown as TxLike).some((e) => e.name === "CoinRegistered"));
    const creatorTokens = await tokenBalance(this.conn, this.creator.publicKey, this.mint);
    const { cfg, pool } = await this.dbc(coin);
    const fee = pool.partnerQuoteFee + pool.protocolQuoteFee;
    const feeBps = Number((fee * 10_000n) / initialBuy);
    const fresh = { sqrtPrice: cfg.sqrtStartPrice, activationPoint: 0n, quoteReserve: 0n } as Parameters<typeof quoteDbcBuy>[1];
    const q99 = quoteDbcBuy(cfg, fresh, initialBuy, 0n);
    const q125 = quoteDbcBuy(cfg, fresh, initialBuy, 0n, { firstSwapMinFee: true });
    this.check(
      "creator's first buy paid the 1.25% min fee, not the 99% launch-window fee",
      feeBps >= 100 && feeBps <= 150 && creatorTokens >= (q125.amountOut * 99n) / 100n,
      `pool fees ${sol(fee)} SOL = ${feeBps / 100}% of 0.02; tokens ${Number(creatorTokens) / 1e6} (quote@1.25% ${Number(q125.amountOut) / 1e6}, @99% would be ${Number(q99.amountOut) / 1e6}); creator SOL spent ${sol(before - (await this.conn.getBalance(this.creator.publicKey)))}`,
    );
    this.st.launch = { sig, ts: t.blockTime ?? nowSecs(), slot: t.slot, creatorTokens: creatorTokens.toString(), feeLamports: fee.toString(), feeBps };
    saveState(this.st);
    const api = await this.waitFor("API shows the coin", async () => {
      const c = await this.get<{ mint: string; status: string; creator: string }>(`/v1/coins/by-mint/${prepared.mint}`).catch(() => null);
      return c && c.mint === prepared.mint ? c : null;
    }, 180_000, 5_000);
    this.check("API /v1/coins/by-mint shows the coin", !!api, api ? `status ${api.status}, creator ${api.creator}` : "not indexed within 3 min");
  }

  // ── 2. buys ─────────────────────────────────────────────────────────────
  async buys() {
    const st = (this.st.buys ??= {});
    const coin = await this.refs();
    const launchSlot = this.st.launch!.slot;
    await this.waitFor("launch window (8 slots) over", async () => ((await this.conn.getSlot("confirmed")) > launchSlot + SNIPE_PERIODS + 2 ? true : null), 60_000, 1_000);
    const amt = SOL / 10n;
    for (const [name, who, routed] of [["alice", this.alice, false], ["bob", this.bob, true]] as const) {
      if (st[name]) {
        console.log(`  (done) ${name} buy ${tx(st[name]!.sig)}`);
        continue;
      }
      const b0 = await tokenBalance(this.conn, who.publicKey, coin.mint);
      const { cfg, pool } = await this.dbc(coin as { dbcConfig: PublicKey; dbcPool: PublicKey });
      const slot = BigInt(await this.conn.getSlot("confirmed"));
      const q = quoteDbcBuy(cfg, pool, amt, slot);
      const sig = routed ? await routedBuy(this.conn, who, coin, "dbc", amt) : await directDbcBuy(this.conn, who, coin, amt);
      const t = await this.txInfo(sig);
      const got = (await tokenBalance(this.conn, who.publicKey, coin.mint)) - b0;
      const usesRouter = t.transaction.message.staticAccountKeys.some((k) => k.equals(FUMPAD_PROGRAM_ID));
      console.log(`  → ${name} ${routed ? "ROUTER" : "DIRECT DBC"} buy 0.1 SOL: ${tx(sig)}`);
      this.check(`${name} bought ${routed ? "via the FUMPAD router" : "directly on Meteora DBC (no FUMPAD program in the tx)"}; fee ≈ min`, got > 0n && usesRouter === routed && got >= (q.amountOut * 97n) / 100n, `${Number(got) / 1e6} tokens (quote ${Number(q.amountOut) / 1e6} @ ${Number(q.feeNumerator) / 1e7}% fee)`);
      st[name] = { sig, ts: t.blockTime ?? nowSecs(), slot: t.slot, lamports: amt.toString(), tokens: got.toString() };
      saveState(this.st);
    }
  }

  // ── 3. sells ────────────────────────────────────────────────────────────
  async sells() {
    const st = (this.st.sells ??= {});
    const coin = await this.refs();
    const lastBuy = Math.max(this.st.buys!.alice!.ts, this.st.buys!.bob!.ts);
    const holdUntil = lastBuy + 60 + 15;
    if (nowSecs() < holdUntil) {
      console.log(`  waiting ${holdUntil - nowSecs()} s for the 60 s hold (+15 s margin)`);
      await sleep((holdUntil - nowSecs()) * 1000);
    }
    const TARGET_CENTS = 700; // ≥ $5 minimum with margin for price moves between quote and attestation
    for (const [name, who, routed] of [["alice", this.alice, false], ["bob", this.bob, true]] as const) {
      if (st[name]) {
        console.log(`  (done) ${name} sell ${tx(st[name]!.sig)}`);
        continue;
      }
      const usd = await this.solUsd();
      const bal = await tokenBalance(this.conn, who.publicKey, coin.mint);
      const { cfg, pool } = await this.dbc(coin as { dbcConfig: PublicKey; dbcPool: PublicKey });
      const slot = BigInt(await this.conn.getSlot("confirmed"));
      const cents = (tokens: bigint) => {
        const q = quoteDbcSell(cfg, pool, tokens, slot);
        return (Number(q.amountOut + q.fee) / 1e9) * usd * 100;
      };
      let tokens = bal / 2n;
      if (cents(tokens) < TARGET_CENTS) {
        let lo = tokens, hi = (bal * 95n) / 100n;
        if (cents(hi) < TARGET_CENTS) throw new Error(`${name}: even 95% of the position is worth < $${TARGET_CENTS / 100} (${cents(hi).toFixed(0)}c)`);
        while (hi - lo > bal / 1000n) {
          const mid = (lo + hi) / 2n;
          if (cents(mid) >= TARGET_CENTS) hi = mid;
          else lo = mid;
        }
        tokens = hi;
        console.log(`  ${name}: half is worth only $${(cents(bal / 2n) / 100).toFixed(2)} → selling ${Number((tokens * 1000n) / bal) / 10}% instead`);
      }
      const est = cents(tokens) / 100;
      const sig = routed ? await routedSell(this.conn, who, coin, "dbc", tokens) : await directDbcSell(this.conn, who, coin, tokens);
      const t = await this.txInfo(sig);
      const left = await tokenBalance(this.conn, who.publicKey, coin.mint);
      console.log(`  → ${name} ${routed ? "ROUTER" : "DIRECT DBC"} sell ${Number(tokens) / 1e6} tokens (~$${est.toFixed(2)} at SOL $${usd.toFixed(2)}): ${tx(sig)}`);
      this.check(`${name} sold ${routed ? "via router" : "directly on DBC"} ≥ $5 after the hold`, bal - left === tokens && est >= 5 && (t.blockTime ?? 0) - this.st.buys![name]!.ts >= 60, `held ${(t.blockTime ?? 0) - this.st.buys![name]!.ts} s, est $${est.toFixed(2)}`);
      st[name] = { sig, ts: t.blockTime ?? nowSecs(), slot: t.slot, tokens: tokens.toString(), usdEst: est };
      saveState(this.st);
    }
  }

  // ── 4. attestations ─────────────────────────────────────────────────────
  recordTicket(name: string, addr: PublicKey, t: TicketAccount) {
    (this.st.tickets ??= {})[name] = {
      ticket: addr.toBase58(),
      source: t.source,
      tokens: t.tokens.toString(),
      usdCents: t.sellUsdCents.toString(),
      effectiveAt: Number(t.attestedAt),
      claimableAt: Number(t.attestedAt) + 3600,
      status: t.status,
      sellPriceQ64: t.sellPriceQ64.toString(),
    };
    saveState(this.st);
  }

  async attest() {
    const sells = this.st.sells!;
    for (const [name, who, src] of [["alice", this.alice, "outside"], ["bob", this.bob, "router"]] as const) {
      const addr = ticketPda(this.mint, who.publicKey, 0n);
      const t0 = nowSecs();
      const t = await this.waitFor(`${name}'s ticket attested`, async () => {
        const a = await this.conn.getAccountInfo(addr);
        return a ? decodeTicket(new Uint8Array(a.data)) : null;
      }, 15 * 60_000, 5_000);
      if (!t) {
        this.check(`${name}'s sell → TicketAttested within ${Math.round((nowSecs() - t0) / 60)} min of waiting`, false, `ticket ${addr.toBase58()} does not exist (sell ${tx(sells[name]!.sig)})`);
        continue;
      }
      const sigs = await this.conn.getSignaturesForAddress(addr, { limit: 20 });
      const attestSig = sigs.at(-1)?.signature;
      this.check(
        `${name}: ticket attested on chain (source ${src})`,
        t.source === src && t.tokens > 0n && t.status === "open" && t.sellUsdCents >= 500n,
        `${t.status} ${t.source} ${Number(t.tokens) / 1e6} tokens $${Number(t.sellUsdCents) / 100}, sell@${iso(t.sellTs)} effective_at ${iso(t.attestedAt)} (+${Number(t.attestedAt - t.sellTs)} s after sell), challenge until ${iso(t.attestedAt + 3600n)}${attestSig ? `; attest tx ${tx(attestSig)}` : ""}`,
      );
      if (attestSig) {
        const at = await this.txInfo(attestSig);
        const ev = decodeFumpadEvents(at as unknown as TxLike).find((e) => e.name === "TicketAttested");
        const ed = at.transaction.message.staticAccountKeys.some((k) => k.toBase58() === "Ed25519SigVerify111111111111111111111111111");
        this.check(`${name}: TicketAttested event in an attest tx with Ed25519 signatures (2-of-3)`, !!ev && ed, `fee payer ${at.transaction.message.staticAccountKeys[0].toBase58()}`);
      }
      this.recordTicket(name, addr, t);
      const api = await this.waitFor(`API shows ${name}'s ticket`, async () => {
        const list = await this.get<{ id: string; source: string; attestedAt?: number; state?: string; chainStatus?: string; inChallenge?: boolean; sellSignature?: string }[]>(`/v1/wallets/${who.publicKey.toBase58()}/tickets`);
        return list.find((x) => x.id === addr.toBase58()) ?? null;
      }, 120_000, 5_000);
      this.check(`API /v1/wallets/${name}/tickets: source ${src}, attested, in challenge`, !!api && api.source === src && !!api.attestedAt, api ? JSON.stringify({ source: api.source, state: api.state, chainStatus: api.chainStatus, attestedAt: api.attestedAt, inChallenge: (api as Record<string, unknown>).inChallenge, sellSignature: api.sellSignature?.slice(0, 12) }) : "missing");
    }
    // the creator never gets a ticket (creator sells nothing here), positions track tickets
    for (const [name, who] of [["alice", this.alice], ["bob", this.bob]] as const) {
      const p = await this.conn.getAccountInfo(positionPda(this.mint, who.publicKey));
      if (p) console.log(`    ${name} position: ticketsCreated=${decodePosition(new Uint8Array(p.data)).ticketsCreated}`);
    }
  }

  // ── 5. graduation ───────────────────────────────────────────────────────
  async graduate() {
    let coin = await this.coin();
    const refs = await this.refs();
    if (!this.st.whale && coin.status === "curve") {
      const { cfg, pool } = await this.dbc(coin);
      const need = dbcQuoteToComplete(cfg, pool);
      const bal = BigInt(await this.conn.getBalance(this.whale.publicKey));
      const avail = bal - SOL / 20n; // keep 0.05 SOL for rent + fees
      const slot = BigInt(await this.conn.getSlot("confirmed"));
      const q = quoteDbcBuy(cfg, pool, avail, slot, { partialFill: true });
      console.log(`  curve: ${sol(pool.quoteReserve)} / ${sol(cfg.migrationQuoteThreshold)} SOL; ${sol(need)} SOL to complete; whale has ${sol(bal)}; PartialFill quote uses ${sol(q.amountIn)} (completes=${q.completesCurve})`);
      if (!q.completesCurve) throw new Error("whale cannot complete the curve with its balance (would need a top-up)");
      const amount = q.amountIn + q.amountIn / 50n < avail ? q.amountIn + q.amountIn / 50n : avail;
      const sig = await routedBuy(this.conn, this.whale, refs, "dbc", amount, 1);
      const t = await this.txInfo(sig);
      console.log(`  → whale routed PartialFill buy (max ${sol(amount)} SOL): ${tx(sig)}`);
      this.st.whale = { sig, ts: t.blockTime ?? nowSecs(), slot: t.slot, lamports: amount.toString() };
      saveState(this.st);
      const p2 = (await this.dbc(coin)).pool;
      this.check("whale's PartialFill buy completed the curve", p2.quoteReserve >= cfg.migrationQuoteThreshold, `quote reserve ${sol(p2.quoteReserve)} SOL, whale spent ${sol(bal - BigInt(await this.conn.getBalance(this.whale.publicKey)))} SOL`);
    }
    const t0 = this.st.whale?.ts ?? nowSecs();
    const g = await this.waitFor("keeper migrate_pool + graduate", async () => {
      const c = await this.coin();
      return c.status === "graduated" ? c : null;
    }, 15 * 60_000, 5_000);
    if (!g) {
      coin = await this.coin();
      const { pool } = await this.dbc(coin);
      this.check("graduated within 15 min", false, `coin status ${coin.status}, DBC migrationProgress ${pool.migrationProgress} isMigrated ${pool.isMigrated}`);
      return;
    }
    const sigs = await this.conn.getSignaturesForAddress(coinPda(this.mint), { limit: 30 });
    const gradSig = sigs.find((s) => !s.err && (s.blockTime ?? 0) >= g.graduatedAt - 1n && (s.blockTime ?? 0) <= Number(g.graduatedAt) + 1)?.signature;
    const vault = decodeTokenAccount(new Uint8Array((await this.conn.getAccountInfo(rewardVault(this.mint)))!.data)).amount;
    this.check("Graduated: DAMM v2 pool + locked position recorded", !g.dammPool.equals(PublicKey.default) && !g.dammPosition.equals(PublicKey.default), `${Number(g.graduatedAt) - t0} s after completion; pool ${acct(g.dammPool)}${gradSig ? `; graduate tx ${tx(gradSig)}` : ""}; migrator ${g.migrator.toBase58()}`);
    this.check("reward vault holds the 8% DBC leftover (80M tokens)", vault >= 80_000_000_000_000n && vault < 90_000_000_000_000n, `${Number(vault) / 1e6} tokens`);
    this.check("launch-window fees settled (routed to buyback)", g.launchFeesSettled, `buybackLamports ${sol(g.buybackLamports)}, feesClaimed ${sol(g.feesClaimedLamports)}`);
    this.st.graduated = { at: Number(g.graduatedAt), dammPool: g.dammPool.toBase58(), dammPosition: g.dammPosition.toBase58(), vault: vault.toString(), launchFeesSettled: g.launchFeesSettled };
    saveState(this.st);
    const fees = await this.waitFor("keeper fee claim / buyback activity", async () => {
      const c = await this.coin();
      return c.feesClaimedLamports > 0n || c.buybackSpentLamports > 0n ? c : null;
    }, 5 * 60_000, 10_000);
    this.check("keeper fee claims / buyback on the coin", !!fees, fees ? `feesClaimed ${sol(fees.feesClaimedLamports)} SOL, buybackSpent ${sol(fees.buybackSpentLamports)} SOL → ${Number(fees.buybackTokens) / 1e6} tokens, creatorFees ${sol(fees.creatorFeesUnclaimed)}, platformFees ${sol(fees.platformFeesUnclaimed)}` : "none in 5 min");
  }

  // ── 6. post-graduation ──────────────────────────────────────────────────
  async post() {
    const st = (this.st.post ??= {});
    const refs = await this.refs();
    const pool = new PublicKey(this.st.graduated!.dammPool);
    if (!st.buy) {
      const b0 = await tokenBalance(this.conn, this.alice.publicKey, this.mint);
      const sig = await directDammBuy(this.conn, this.alice, refs, pool, SOL / 100n);
      const t = await this.txInfo(sig);
      const got = (await tokenBalance(this.conn, this.alice.publicKey, this.mint)) - b0;
      console.log(`  → alice DIRECT DAMM v2 buy 0.01 SOL: ${tx(sig)}`);
      this.check("alice bought directly on DAMM v2", got > 0n, `${Number(got) / 1e6} tokens`);
      st.buy = { sig, ts: t.blockTime ?? nowSecs(), slot: t.slot, tokens: got.toString() };
      saveState(this.st);
    }
    if (!st.sell) {
      const tokens = BigInt(st.buy.tokens!) / 2n;
      const sig = await directDammSell(this.conn, this.alice, refs, pool, tokens);
      const t = await this.txInfo(sig);
      console.log(`  → alice DIRECT DAMM v2 sell ${Number(tokens) / 1e6} tokens: ${tx(sig)}`);
      this.check("alice sold directly on DAMM v2", true);
      st.sell = { sig, ts: t.blockTime ?? nowSecs(), slot: t.slot, tokens: tokens.toString() };
      saveState(this.st);
    }
    // samples
    const obsOf = async () => {
      const a = await this.conn.getAccountInfo(observationsPda(this.mint));
      return a ? decodeObservations(new Uint8Array(a.data)) : null;
    };
    const o1 = await obsOf();
    await sleep(75_000);
    const o2 = await obsOf();
    if (!o2) this.check("observations account exists", false);
    else {
      const recent = o2.samples.filter((s) => !s.fallback).slice(-12);
      const gaps = recent.slice(1).map((s, i) => Number(s.ts - recent[i].ts));
      const added = (o2.len ?? 0) - (o1?.len ?? 0);
      this.check("keeper samples recorded every ~15 s", added >= 3 && gaps.length > 0 && Math.max(...gaps.slice(-4)) <= 30, `${o2.len} samples (${added} new in 75 s), recent gaps ${gaps.join(",")} s, last ${iso(o2.lastKeeperSampleTs)}`);
    }
    const trades = await this.waitFor("API trades on both venues", async () => {
      const tr = await this.get<{ signature: string; venue?: string; app?: string; routed?: boolean; wallet: string; isBuy?: boolean }[]>(`/v1/coins/${this.st.mint}/trades?limit=100`);
      const v = new Set(tr.map((x) => x.venue));
      return v.has("dbc") && v.has("damm") && tr.some((x) => x.signature === st.sell!.sig) ? tr : null;
    }, 180_000, 10_000);
    const venues = trades ? [...new Set(trades.map((t) => `${t.venue}/${t.app ?? "?"}`))].join(", ") : "";
    this.check("API /v1/coins/:mint/trades shows trades from all venues (DBC direct + router, DAMM v2 direct)", !!trades && trades.some((t) => t.app === "fumpad" || t.routed), trades ? `${trades.length} trades: ${venues}` : "incomplete within 3 min");
    const detail = await this.get<{ status: string; dammPool?: string }>(`/v1/coins/by-mint/${this.st.mint}`);
    this.check("API coin detail graduated with the DAMM v2 pool", detail.status === "graduated" && detail.dammPool === this.st.graduated!.dammPool, `status ${detail.status}`);
  }

  // ── 6b. (optional) whale lifts the DAMM v2 price past the sellers' 10x (as the local e2e does) ─────────
  async pump(lamportsArg?: string) {
    if (this.st.pump) return console.log(`  (done) ${tx(this.st.pump.sig)}`);
    const lamports = BigInt(lamportsArg ?? String((SOL * 3n) / 10n));
    const refs = await this.refs();
    const sig = await routedBuy(this.conn, this.whale, refs, "damm_v2", lamports);
    const t = await this.txInfo(sig);
    const p = decodeDammPool(new Uint8Array((await this.conn.getAccountInfo(new PublicKey(this.st.graduated!.dammPool)))!.data));
    console.log(`  → whale ROUTER DAMM v2 buy ${sol(lamports)} SOL: ${tx(sig)}; spot now ${solPerTokenFromSqrt(p.sqrtPrice).toExponential(4)} SOL/token`);
    this.check("whale routed DAMM v2 buy landed", true);
    this.st.pump = { sig, ts: t.blockTime ?? nowSecs(), slot: t.slot, lamports: lamports.toString() };
    saveState(this.st);
  }

  // ── watcher re-derivation, run locally (the live watcher has no public domain) ─────────
  async verify(rpcUrl: string) {
    // PYTH_SOURCE=onchain reads the SOL/USD push account on MAINNET (same Helius key, host devnet→mainnet)
    const pythRpc = new URL(rpcUrl);
    pythRpc.hostname = pythRpc.hostname.replace("devnet", "mainnet");
    const env: Record<string, string | undefined> = { PYTH_SOURCE: "onchain", PYTH_RPC_URL: pythRpc.hostname.includes("mainnet") ? pythRpc.toString() : "https://api.mainnet-beta.solana.com" };
    const pyth = pythSourceFromEnv(env as NodeJS.ProcessEnv);
    const { caches, maxRpcCalls, priceCache } = deriveLimitsFromEnv({});
    const rpc = new MeteoraRpc(rpcUrl, { minGapMs: 50 });
    const chain = new RpcChainView(this.conn, "finalized");
    const w = new Watcher({
      coins: async () => (await chain.coins()).filter((c) => c.mint.equals(this.mint)),
      global: () => chain.global(),
      derive: (coin, g) => deriveCoin({ rpc, fetchPrice: (t, d) => pyth.priceAt(t, d), caches, priceCache, maxRpcCalls }, coin, g),
      graceSecs: 900,
    });
    await w.tick();
    const c = w.feed(this.st.mint).coins[0];
    if (!c) return this.check("watcher re-derivation produced a result", false, JSON.stringify(w.stats));
    const err = (c as { error?: string }).error;
    for (const v of c.verdicts) console.log(`    ${v.kind} ${v.verdict} ticket ${v.ticket.slice(0, 8)}… owner ${v.owner.slice(0, 8)}…${v.verdict === "mismatch" ? ` diffs ${JSON.stringify((v as { diffs?: unknown }).diffs)}` : ""}`);
    for (const m of c.missing) console.log(`    MISSING ${m.kind} owner ${m.owner.slice(0, 8)}… sig ${m.signature.slice(0, 12)}… age ${m.ageSecs} s`);
    const mism = c.verdicts.filter((v) => v.verdict !== "match");
    this.check("watcher (local tick): every TicketAttested / TicketDebited matches the independent re-derivation", !err && mism.length === 0 && c.verdicts.length >= 2, `${c.verdicts.length} verdicts (${c.verdicts.map((v) => v.kind).join(",")}), ${mism.length} mismatches, ${c.missing.length} missing${err ? `, error ${err}` : ""}`);
  }

  // ── 7. claims ───────────────────────────────────────────────────────────
  async claims(wait: boolean) {
    const g = decodeGlobal(new Uint8Array((await this.conn.getAccountInfo(globalPda()))!.data));
    const challenge = Number(g.params.ticketChallengeSecs);
    const result: Record<string, unknown> = {};
    for (const [name, who] of [["alice", this.alice], ["bob", this.bob]] as const) {
      const addr = ticketPda(this.mint, who.publicKey, 0n);
      const a = await this.conn.getAccountInfo(addr);
      if (!a) {
        result[name] = { ticket: addr.toBase58(), state: "no ticket account (never attested, or closed after claim)" };
        console.log(`  ${name}: no ticket account at ${addr.toBase58()}`);
        continue;
      }
      const t = decodeTicket(new Uint8Array(a.data));
      this.recordTicket(name, addr, t);
      const claimableAt = Number(t.attestedAt) + challenge;
      const obsA = await this.conn.getAccountInfo(observationsPda(this.mint));
      const now = BigInt(nowSecs());
      const median = obsA ? medianPriceQ64(decodeObservations(new Uint8Array(obsA.data)), now, g.params.oracleWindowSecs, g.params.oracleMinSamples) : null;
      const multiple = median !== null && t.sellPriceQ64 > 0n ? Number((median * 1000n) / t.sellPriceQ64) / 1000 : null;
      const meets = median !== null && median * 10_000n >= t.sellPriceQ64 * BigInt(g.params.triggerMultipleBps);
      result[name] = { ticket: addr.toBase58(), status: t.status, tokens: t.tokens.toString(), effectiveAt: iso(t.attestedAt), claimableAt: iso(claimableAt), claimableNow: nowSecs() >= claimableAt, medianMultiple: multiple, trigger10x: meets };
      console.log(`  ${name}: ${t.status}, claimable from ${iso(claimableAt)} (${claimableAt - nowSecs()} s from now); median/sell = ${multiple ?? "no median (not enough samples)"}x → 10x trigger ${meets ? "MET" : "not met"}; sell price ${(Number(t.sellPriceQ64) / Number(Q64) / 1e3).toExponential(4)} SOL/token`);
    }
    const c = await this.coin();
    if (c.status === "graduated") {
      const p = decodeDammPool(new Uint8Array((await this.conn.getAccountInfo(c.dammPool))!.data));
      console.log(`  DAMM v2 spot ${solPerTokenFromSqrt(p.sqrtPrice).toExponential(4)} SOL/token`);
    }
    this.st.claims = { checkedAt: nowSecs(), result };
    saveState(this.st);
    if (!wait) return;
    for (const [name, who] of [["alice", this.alice], ["bob", this.bob]] as const) {
      const r = result[name] as { claimableAt?: string; trigger10x?: boolean; tokens?: string };
      if (!r?.claimableAt) continue;
      const at = Date.parse(r.claimableAt) / 1000;
      if (nowSecs() < at) {
        console.log(`  waiting ${at - nowSecs()} s until ${name}'s ticket is claimable`);
        await sleep((at - nowSecs() + 5) * 1000);
      }
      const b0 = await tokenBalance(this.conn, who.publicKey, this.mint);
      const addr = ticketPda(this.mint, who.publicKey, 0n);
      const done = await this.waitFor(`keeper auto-claims ${name}'s ticket`, async () => {
        const a = await this.conn.getAccountInfo(addr);
        if (!a) return "closed";
        const t = decodeTicket(new Uint8Array(a.data));
        return t.status === "claimed" || t.status === "queued" || t.status === "escrowed" ? t.status : null;
      }, 10 * 60_000, 10_000);
      const b1 = await tokenBalance(this.conn, who.publicKey, this.mint);
      const obsNow = await this.conn.getAccountInfo(observationsPda(this.mint));
      const medNow = obsNow ? medianPriceQ64(decodeObservations(new Uint8Array(obsNow.data)), BigInt(nowSecs()), g.params.oracleWindowSecs, g.params.oracleMinSamples) : null;
      const sellQ64 = BigInt((this.st.tickets?.[name]?.sellPriceQ64) ?? "0");
      r.trigger10x = medNow !== null && sellQ64 > 0n && medNow * 10_000n >= sellQ64 * BigInt(g.params.triggerMultipleBps);
      const want = BigInt(r.tokens ?? "0") / 10n;
      // queued = claim_for ran but 10% of the ticket > max_claim_pool_bps of the reward pool: paid by process_queue as the pool grows
      this.check(`keeper auto-claim of ${name}'s ticket pays 10% of its tokens (or queues it when the pool cap binds)`, done === "claimed" || done === "closed" ? b1 - b0 >= (want * 99n) / 100n : done === "queued", `status ${done ?? "still open"}; balance +${Number(b1 - b0) / 1e6} tokens (10% = ${Number(want) / 1e6}); 10x trigger now ${r.trigger10x ? "met" : "NOT met"}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const stepArg = (arg("--step") ?? "status") as Step | "all";
  const steps: Step[] = stepArg === "all" ? ORDER : [stepArg];
  for (const s of steps) if (s !== "status" && s !== "pump" && s !== "verify" && !ORDER.includes(s)) throw new Error(`unknown step ${s}`);
  const rpc = readRpcUrl();
  const run = new Run(rpc);
  try {
    if ((await run.conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("refusing: the RPC is not devnet");
    console.log(`FUMPAD v0.7 live devnet scenario · program ${acct(FUMPAD_PROGRAM_ID)} · API ${API} · state ${STATE_FILE}`);
    for (const s of steps) {
      run.step = s;
      console.log(`\n▶ ${s}  (${new Date().toISOString()})`);
      if (s === "status") await run.status();
      else if (s === "claims") await run.claims(argv.includes("--wait"));
      else if (s === "pump") await run.pump(arg("--lamports"));
      else if (s === "verify") await run.verify(rpc);
      else await (run[s] as () => Promise<void>).call(run);
    }
    if (stepArg === "all") await run.status();
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error(`✘ aborted: ${msg.split(rpc).join("<RPC_URL>")}`);
    process.exit(2);
  }
  console.log(run.failed ? `\n${run.failed} check(s) failed` : "\nall checks passed");
  process.exit(run.failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
