/**
 * FUMPAD keeper (SPEC §5.4 keeper policy, §7). One loop, chain state only (no DB):
 *
 *  sample    record_samples: heartbeat EVERY graduated coin < 10 min (batched); full rate
 *            (15 s) for coins whose spot ≥ 50% of their lowest open trigger and coins with
 *            buyback_lamports ≥ threshold. ≤5 coins per legacy tx, 6–10 via v0 + ALT.
 *            Isolated tx (compute-budget ixs only besides record_samples).
 *  graduate  Complete coins → graduate (400k CU), then init_observations, 9× init_claim_queue (one tx)
 *            and (once) PumpSwap user_volume_accumulator for the pool authority.
 *            D20 (v0.5): graduate refunds the caller's rent and pre-funds the observations +
 *            claim-queue PDAs out of the coin's graduation fee (default 0.65 SOL), so this
 *            whole step costs the keeper only tx fees (it still advances graduate's 0.05 SOL
 *            rent loan, returned in-instruction). Coins whose snapshotted fee is lower
 *            (devnet scaled params, pre-v0.5 coins) leave the shortfall to the keeper.
 *  buyback   execute_buyback when buyback_lamports ≥ threshold, a keeper median exists and
 *            spot is within the program's ±deviation band (pre-checked → no failing txs).
 *  queue     process_queue when the head entries fit; creates missing owner ATAs first.
 *  autoclaim (D17, v0.4) claim_for every Open ticket whose trigger holds on the covered
 *            keeper median, unless its owner opted out (Position.auto_claim_opt_out); oldest
 *            first; skips wallets at the D16 queue limit unless the claim pays now; the
 *            owner's ATA is created (keeper-paid, idempotent) in the same tx. Respects pause.
 *  skim      create ATA(coin, WSOL) + skim + settle_lp_fees per graduated coin periodically
 *            (simulated first; NothingToSkim = skip).
 *  fees      withdraw_platform_fees above a threshold (permissionless, pays the treasury).
 *  params    execute_params once a queued change's 48 h timelock has elapsed.
 *
 * Idempotency: every action is derived from fresh chain state and guarded by an in-flight
 * key, so a restart or a parallel keeper at worst sends a tx the program rejects.
 */
import { createServer, type Server } from "node:http";

import {
  type AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  PublicKey,
} from "@solana/web3.js";
import { pino, type Logger } from "pino";

import {
  BPS_DENOM,
  type CoinAccount,
  coinAddresses,
  decodeCoin,
  decodeObservations,
  decodePumpPool,
  decodeTokenAccount,
  FumpadClient,
  LOCKER_ERROR,
  FUMPAD_ERROR,
  MAX_SAMPLE_COINS,
  MAX_SAMPLE_COINS_LEGACY,
  MAX_QUEUED_PER_WALLET,
  medianPriceQ64,
  meetsMultiple,
  type ObservationsAccount,
  PAUSE_CLAIMS,
  type Params,
  type PoolReserves,
  decodePosition,
  positionPda,
  priceQ64,
  type TicketAccount,
} from "@fumpad/sdk";

import { Alerter } from "./alerts.js";
import type { KeeperConfig } from "./config.js";
import { Sender } from "./sender.js";

interface CoinState {
  mint: PublicKey;
  coin: CoinAccount;
  obs?: ObservationsAccount | null;
  pool?: PoolReserves | null;
  /** Lowest trigger price (Q64) among open tickets, if any. */
  minTriggerQ64?: bigint;
  openTickets: number;
  lastSkimAt: number;
  lastBuybackAt: number;
  lastFeesAt: number;
  lastQueueAt: number;
  lastAutoClaimAt?: number;
  setupDone: boolean;
}

export interface AutoClaimCandidate {
  key: PublicKey;
  ticket: Pick<TicketAccount, "owner" | "tokens" | "sellPriceQ64" | "sellTs" | "status">;
}

/**
 * Which open tickets the keeper should `claim_for` now (pure; mirrors claim.rs): Open,
 * inside the claim window, covered median ≥ trigger, non-zero claim, owner not opted out,
 * and not a wallet already at the D16 queue limit unless the claim would pay right away.
 * Oldest sell first (the queue's own order).
 */
export function planAutoClaims(a: {
  tickets: AutoClaimCandidate[];
  optedOut: Set<string>;
  queuedPerOwner: Map<string, number>;
  medianQ64: bigint;
  now: bigint;
  params: Pick<Params, "claimWindowSecs" | "triggerMultipleBps" | "claimBps" | "maxClaimPoolBps">;
  poolTokens: bigint;
}): AutoClaimCandidate[] {
  const p = a.params;
  return a.tickets
    .filter((t) => {
      const owner = t.ticket.owner.toBase58();
      if (t.ticket.status !== "open" || a.optedOut.has(owner)) return false;
      if (t.ticket.sellTs + p.claimWindowSecs < a.now) return false;
      if (!meetsMultiple(a.medianQ64, t.ticket.sellPriceQ64, p.triggerMultipleBps)) return false;
      const amount = (t.ticket.tokens * BigInt(p.claimBps)) / BPS_DENOM;
      if (amount === 0n) return false;
      const fits = amount * BPS_DENOM <= a.poolTokens * BigInt(p.maxClaimPoolBps);
      return fits || (a.queuedPerOwner.get(owner) ?? 0) < MAX_QUEUED_PER_WALLET;
    })
    .sort((x, y) => (x.ticket.sellTs < y.ticket.sellTs ? -1 : x.ticket.sellTs > y.ticket.sellTs ? 1 : 0));
}

/** claim_for outcomes that mean "not now" rather than a keeper fault. */
const AUTOCLAIM_SKIP = () =>
  new Set(
    ["TriggerNotMet", "InsufficientSamples", "WalletQueueLimit", "AutoClaimDisabled", "TicketNotOpen", "TicketExpired", "Paused", "QueueFull", "ZeroAmount", "WrongCoinStatus"]
      .map((n) => FUMPAD_ERROR[n])
      .filter((c): c is number => c !== undefined),
  );

interface JobHealth {
  lastOkAt?: number;
  lastErrAt?: number;
  lastErr?: string;
  failures: number;
  runs: number;
  actions: number;
}

export class Keeper {
  readonly log: Logger;
  readonly conn: Connection;
  readonly client: FumpadClient;
  readonly sender: Sender;
  readonly alerts: Alerter;
  private coins = new Map<string, CoinState>();
  private params?: Params;
  private pendingEta = 0n;
  private paused = 0;
  private lastScan = 0;
  private lastTicketScan = 0;
  private chainNow = 0n;
  private inflight = new Set<string>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private server?: Server;
  private alt?: { table: AddressLookupTableAccount; addresses: Set<string> };
  private loopAt = 0;
  private balance = 0n;
  readonly jobs: Record<string, JobHealth> = {};

  constructor(readonly cfg: KeeperConfig, log?: Logger) {
    this.log = log ?? pino({ name: "keeper", level: cfg.logLevel, base: { service: "keeper" }, timestamp: pino.stdTimeFunctions.isoTime, formatters: { level: (l) => ({ level: l }) } });
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
    this.client = new FumpadClient(this.conn);
    this.sender = new Sender(this.conn, cfg.keeper, cfg, this.log);
    this.alerts = new Alerter(this.log, { botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId });
  }

  get keeperKey() {
    return this.cfg.keeper.publicKey;
  }

  async start(): Promise<void> {
    this.log.info({ keeper: this.keeperKey.toBase58(), dryRun: this.cfg.dryRun, jobs: this.cfg.jobs }, "keeper starting");
    if (this.cfg.healthPort) {
      this.server = createServer((req, res) => {
        if (req.url?.startsWith("/health")) {
          const h = this.health();
          res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(h, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
        } else res.writeHead(404).end();
      });
      await new Promise<void>((r) => this.server!.listen(this.cfg.healthPort, r));
    }
    const tick = async () => {
      if (this.stopped) return;
      await this.loopOnce().catch((e) => this.log.error({ err: String(e) }, "loop failed"));
      if (!this.stopped) this.timer = setTimeout(tick, this.cfg.loopMs);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  health() {
    const now = Date.now();
    const loopFresh = now - this.loopAt < Math.max(30_000, this.cfg.loopMs * 10);
    const failing = Object.entries(this.jobs).filter(([, j]) => j.failures >= 3).map(([k]) => k);
    return {
      ok: loopFresh && failing.length === 0,
      keeper: this.keeperKey.toBase58(),
      dryRun: this.cfg.dryRun,
      msSinceLoop: now - this.loopAt,
      balanceSol: Number(this.balance) / 1e9,
      coins: this.coins.size,
      graduated: [...this.coins.values()].filter((c) => c.coin.status === "graduated").length,
      failingJobs: failing,
      jobs: this.jobs,
      sender: this.sender.stats,
      alertsSent: this.alerts.sent,
    };
  }

  // ── loop ─────────────────────────────────────────────────────────────────

  async loopOnce(): Promise<void> {
    await this.refresh();
    const j = this.cfg.jobs;
    if (j.sample) await this.job("sample", () => this.runSampling());
    if (j.graduate) await this.job("graduate", () => this.runGraduate());
    if (j.buyback) await this.job("buyback", () => this.runBuybacks());
    if (j.autoclaim) await this.job("autoclaim", () => this.runAutoClaims());
    if (j.queue) await this.job("queue", () => this.runQueues());
    if (j.skim) await this.job("skim", () => this.runSkims());
    if (j.fees) await this.job("fees", () => this.runPlatformFees());
    if (j.params) await this.job("params", () => this.runParams());
    this.loopAt = Date.now();
  }

  private async job(name: string, fn: () => Promise<number>) {
    const h = (this.jobs[name] ??= { failures: 0, runs: 0, actions: 0 });
    h.runs++;
    try {
      h.actions += await fn();
      h.lastOkAt = Date.now();
      if (h.failures >= 3) this.alerts.resolve(`job:${name}`);
      h.failures = 0;
    } catch (e) {
      h.failures++;
      h.lastErrAt = Date.now();
      h.lastErr = String(e).slice(0, 300);
      this.log.warn({ job: name, err: h.lastErr, failures: h.failures }, "job failed");
      if (h.failures >= 3) await this.alerts.alert(`job:${name}`, `job ${name} failing (${h.failures}x): ${h.lastErr}`);
    }
  }

  /** Re-read chain state: coins (gPA), open tickets (gPA), observations + pools (batched). */
  async refresh(): Promise<void> {
    const now = Date.now();
    this.chainNow = await this.client.chainTime();
    if (now - this.lastScan > this.cfg.scanIntervalSecs * 1000 || !this.params) {
      const g = await this.client.global(0);
      this.params = g.params;
      this.pendingEta = g.pendingEta;
      this.paused = g.paused;
      const all = await this.client.scanCoins();
      for (const c of all) {
        const k = c.mint.toBase58();
        const prev = this.coins.get(k);
        this.coins.set(k, prev ? { ...prev, coin: c } : { mint: c.mint, coin: c, openTickets: 0, lastSkimAt: 0, lastBuybackAt: 0, lastFeesAt: 0, lastQueueAt: 0, setupDone: false });
      }
      this.balance = BigInt(await this.conn.getBalance(this.keeperKey));
      if (this.balance < this.cfg.minKeeperLamports) await this.alerts.alert("balance", `keeper balance low: ${Number(this.balance) / 1e9} SOL`);
      this.lastScan = now;
    } else {
      // Cheap refresh of known coins' accounts.
      const list = [...this.coins.values()];
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const infos = await this.conn.getMultipleAccountsInfo(chunk.map((c) => coinAddresses(c.mint).coin));
        infos.forEach((a, j) => {
          if (a) chunk[j].coin = decodeCoinSafe(a.data) ?? chunk[j].coin;
        });
      }
    }
    if (now - this.lastTicketScan > this.cfg.ticketScanIntervalSecs * 1000) {
      const open = await this.client.scanOpenTickets();
      const byMint = new Map<string, { min: bigint; n: number }>();
      const trig = BigInt(this.params!.triggerMultipleBps);
      for (const { ticket } of open) {
        const k = ticket.mint.toBase58();
        const t = (ticket.sellPriceQ64 * trig) / BPS_DENOM;
        const e = byMint.get(k);
        byMint.set(k, { min: e && e.min < t ? e.min : t, n: (e?.n ?? 0) + 1 });
      }
      for (const [k, c] of this.coins) {
        c.minTriggerQ64 = byMint.get(k)?.min;
        c.openTickets = byMint.get(k)?.n ?? 0;
      }
      this.lastTicketScan = now;
    }
    const grads = [...this.coins.values()].filter((c) => c.coin.status === "graduated");
    for (let i = 0; i < grads.length; i += 25) {
      const chunk = grads.slice(i, i + 25);
      const keys = chunk.flatMap((c) => {
        const a = coinAddresses(c.mint);
        return [a.observations, a.pool, a.poolBase, a.poolQuote];
      });
      const infos = await this.conn.getMultipleAccountsInfo(keys);
      chunk.forEach((c, j) => {
        const [o, p, b, q] = infos.slice(j * 4, j * 4 + 4);
        c.obs = o ? decodeObservations(new Uint8Array(o.data)) : null;
        if (p && b && q) {
          const pool = decodePumpPool(new Uint8Array(p.data));
          c.pool = { base: decodeTokenAccount(new Uint8Array(b.data)).amount, quote: decodeTokenAccount(new Uint8Array(q.data)).amount + pool.virtualQuoteReserves };
        }
      });
    }
  }

  private async guard(key: string, fn: () => Promise<number>): Promise<number> {
    if (this.inflight.has(key)) return 0;
    this.inflight.add(key);
    try {
      return await fn();
    } finally {
      this.inflight.delete(key);
    }
  }

  // ── sampling ─────────────────────────────────────────────────────────────

  /** Seconds between keeper samples this coin needs right now. */
  sampleInterval(c: CoinState): number {
    const spot = c.pool && c.pool.base > 0n ? priceQ64(c.pool.quote, c.pool.base) : null;
    const nearTrigger =
      c.minTriggerQ64 !== undefined && spot !== null && spot * 1000n >= c.minTriggerQ64 * BigInt(Math.round(this.cfg.nearTriggerRatio * 1000));
    const buyback = c.coin.buybackLamports >= this.cfg.buybackMinLamports;
    return nearTrigger || buyback ? this.cfg.fullRateSecs : this.cfg.heartbeatSecs;
  }

  async runSampling(): Promise<number> {
    const p = this.params!;
    const now = this.chainNow;
    const due: { c: CoinState; overdue: bigint }[] = [];
    const fill: { c: CoinState; overdue: bigint }[] = [];
    for (const c of this.coins.values()) {
      if (c.coin.status !== "graduated" || !c.obs || !c.pool) continue;
      const lastKeeper = c.obs.keeperSampled ? c.obs.lastKeeperSampleTs : 0n;
      const since = now - lastKeeper;
      const want = BigInt(this.sampleInterval(c));
      if (since < p.oracleMinSpacingSecs) continue;
      if (since >= want) due.push({ c, overdue: since - want });
      // Past half their interval: ride along in a batch that is going out anyway (fewer txs,
      // and heartbeats of many coins converge into shared batches).
      else if (since * 2n >= want) fill.push({ c, overdue: since - want });
    }
    if (!due.length) return 0;
    due.sort((a, b) => (a.overdue > b.overdue ? -1 : 1));
    fill.sort((a, b) => (a.overdue > b.overdue ? -1 : 1));
    const cap = this.cfg.useLookupTable && !this.cfg.dryRun ? MAX_SAMPLE_COINS : MAX_SAMPLE_COINS_LEGACY;
    const room = (cap - (due.length % cap)) % cap;
    due.push(...fill.slice(0, room));
    let sent = 0;
    const alt = this.cfg.useLookupTable && due.length > MAX_SAMPLE_COINS_LEGACY ? await this.ensureAlt(due.map((d) => d.c.mint)) : undefined;
    const size = alt ? MAX_SAMPLE_COINS : MAX_SAMPLE_COINS_LEGACY;
    for (let i = 0; i < due.length; i += size) {
      const batch = due.slice(i, i + size).map((d) => d.c.mint);
      const key = `sample:${batch.map((m) => m.toBase58()).join(",")}`;
      sent += await this.guard(key, async () => {
        const r = await this.sender.send("record_samples", this.client.buildRecordSamples({ sampler: this.keeperKey, mints: batch }), { lookupTables: alt ? [alt] : undefined });
        if (!r.ok) {
          if (r.code === FUMPAD_ERROR.SampleTooSoon) return 0;
          throw new Error(`record_samples failed: ${r.error}`);
        }
        return 1;
      });
    }
    return sent;
  }

  /** Lookup table holding [coin, observations, pool, base, quote] for each sampled coin. */
  private async ensureAlt(mints: PublicKey[]): Promise<AddressLookupTableAccount | undefined> {
    if (this.cfg.dryRun) return undefined;
    const want = mints.flatMap((m) => {
      const a = coinAddresses(m);
      return [a.coin, a.observations, a.pool, a.poolBase, a.poolQuote];
    });
    if (!this.alt) {
      const slot = await this.conn.getSlot("finalized");
      const [ix, table] = AddressLookupTableProgram.createLookupTable({ authority: this.keeperKey, payer: this.keeperKey, recentSlot: slot });
      const r = await this.sender.send("alt-create", { instructions: [ix] });
      if (!r.ok) return undefined;
      this.alt = { table: { key: table, state: { addresses: [] } } as unknown as AddressLookupTableAccount, addresses: new Set() };
    }
    const missing = want.filter((k) => !this.alt!.addresses.has(k.toBase58()));
    if (this.alt.addresses.size + missing.length > 256) return undefined;
    for (let i = 0; i < missing.length; i += 25) {
      const chunk = missing.slice(i, i + 25);
      const ix = AddressLookupTableProgram.extendLookupTable({ lookupTable: this.alt.table.key, authority: this.keeperKey, payer: this.keeperKey, addresses: chunk });
      const r = await this.sender.send("alt-extend", { instructions: [ix] });
      if (!r.ok) return undefined;
      for (const k of chunk) this.alt.addresses.add(k.toBase58());
    }
    if (missing.length) await new Promise((r) => setTimeout(r, 1_000)); // new entries usable from the next slot
    const fresh = (await this.conn.getAddressLookupTable(this.alt.table.key)).value;
    if (!fresh) return undefined;
    this.alt.table = fresh;
    return fresh;
  }

  // ── graduation + setup ───────────────────────────────────────────────────

  async runGraduate(): Promise<number> {
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.coin.status === "complete") {
        n += await this.guard(`graduate:${c.mint.toBase58()}`, async () => {
          const r = await this.sender.send("graduate", this.client.buildGraduate({ payer: this.keeperKey, mint: c.mint }));
          if (!r.ok) {
            if (r.code === FUMPAD_ERROR.WrongCoinStatus) return 0; // someone else graduated it
            await this.alerts.alert(`graduate:${c.mint.toBase58()}`, `graduate ${c.mint.toBase58()} failed: ${r.error}`);
            throw new Error(`graduate failed: ${r.error}`);
          }
          this.lastScan = 0; // pick up the new status next loop
          return 1;
        });
      }
      if (c.coin.status === "graduated" && !c.setupDone) {
        n += await this.guard(`setup:${c.mint.toBase58()}`, async () => {
          const steps = await this.client.buildPostGraduation({ payer: this.keeperKey, mint: c.mint });
          for (const s of steps) {
            const r = await this.sender.send("post_graduation", s);
            if (!r.ok) throw new Error(`post-graduation setup failed: ${r.error}`);
          }
          c.setupDone = !this.cfg.dryRun || steps.length === 0;
          return steps.length;
        });
      }
    }
    return n;
  }

  // ── buyback ──────────────────────────────────────────────────────────────

  async runBuybacks(): Promise<number> {
    const p = this.params!;
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.coin.status !== "graduated" || c.coin.buybackLamports < this.cfg.buybackMinLamports || !c.obs || !c.pool) continue;
      if (Date.now() - c.lastBuybackAt < this.cfg.buybackIntervalSecs * 1000) continue;
      const median = medianPriceQ64(c.obs.samples, this.chainNow, p.oracleWindowSecs, p.oracleMinSamples);
      const spot = priceQ64(c.pool.quote, c.pool.base);
      if (!median || !spot) continue;
      const diff = spot > median ? spot - median : median - spot;
      if (diff * BPS_DENOM > median * BigInt(p.buybackMaxDeviationBps)) continue; // program would reject (PriceDeviation)
      n += await this.guard(`buyback:${c.mint.toBase58()}`, async () => {
        c.lastBuybackAt = Date.now();
        const r = await this.sender.send("execute_buyback", await this.client.buildExecuteBuyback({ cranker: this.keeperKey, mint: c.mint, maxLamports: c.coin.buybackLamports }));
        if (!r.ok) {
          if (r.code === FUMPAD_ERROR.PriceDeviation || r.code === FUMPAD_ERROR.InsufficientSamples || r.code === FUMPAD_ERROR.NothingToBuyBack) return 0;
          throw new Error(`execute_buyback failed: ${r.error}`);
        }
        return 1;
      });
    }
    return n;
  }

  // ── claim queue ──────────────────────────────────────────────────────────

  async runQueues(): Promise<number> {
    const p = this.params!;
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.coin.status !== "graduated" || Date.now() - c.lastQueueAt < this.cfg.queueIntervalSecs * 1000) continue;
      c.lastQueueAt = Date.now();
      const q = await this.client.claimQueue(c.mint);
      if (!q || q.len === 0) continue;
      const pool = await this.client.tokenBalance(coinAddresses(c.mint).rewardVault);
      const cap = (pool * BigInt(p.maxClaimPoolBps)) / BPS_DENOM;
      if (!q.entries.some((e) => e.amount > 0n && e.amount <= cap && e.amount <= pool)) continue;
      n += await this.guard(`queue:${c.mint.toBase58()}`, async () => {
        const b = await this.client.buildProcessQueue({ cranker: this.keeperKey, mint: c.mint });
        if (!b) return 0;
        for (const ata of await this.client.buildCreateAtas({ payer: this.keeperKey, mint: c.mint, owners: b.owners })) {
          const r = await this.sender.send("create_owner_atas", ata);
          if (!r.ok) this.log.warn({ err: r.error }, "owner ATA creation failed; payout may escrow");
        }
        const r = await this.sender.send("process_queue", b);
        if (!r.ok) throw new Error(`process_queue failed: ${r.error}`);
        return 1;
      });
    }
    return n;
  }

  // ── auto-claim (D17) ─────────────────────────────────────────────────────

  async runAutoClaims(): Promise<number> {
    const p = this.params!;
    if (this.paused & PAUSE_CLAIMS) return 0;
    const skip = AUTOCLAIM_SKIP();
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.coin.status !== "graduated" || !c.setupDone || !c.openTickets || !c.obs) continue;
      if (Date.now() - (c.lastAutoClaimAt ?? 0) < this.cfg.autoClaimIntervalSecs * 1000) continue;
      const median = medianPriceQ64(c.obs.samples, this.chainNow, p.oracleWindowSecs, p.oracleMinSamples);
      // Cheap pre-filter: nothing can trigger below the lowest open trigger.
      if (!median || (c.minTriggerQ64 !== undefined && median < c.minTriggerQ64)) continue;
      c.lastAutoClaimAt = Date.now();
      const [open, queue, pool] = await Promise.all([
        this.client.scanOpenTickets(c.mint),
        this.client.claimQueue(c.mint),
        this.client.tokenBalance(coinAddresses(c.mint).rewardVault),
      ]);
      if (!queue || !open.length) continue;
      const owners = [...new Set(open.map((t) => t.ticket.owner.toBase58()))].map((o) => new PublicKey(o));
      const infos = await this.conn.getMultipleAccountsInfo(owners.map((o) => positionPda(c.mint, o)));
      const optedOut = new Set(owners.filter((_, i) => infos[i] && decodePosition(new Uint8Array(infos[i]!.data)).autoClaimOptOut === 1).map((o) => o.toBase58()));
      const queuedPerOwner = new Map<string, number>();
      for (const e of queue.entries) queuedPerOwner.set(e.owner.toBase58(), (queuedPerOwner.get(e.owner.toBase58()) ?? 0) + 1);
      const picks = planAutoClaims({ tickets: open, optedOut, queuedPerOwner, medianQ64: median, now: this.chainNow, params: p, poolTokens: pool });
      for (const t of picks.slice(0, this.cfg.autoClaimMaxPerRun)) {
        n += await this.guard(`autoclaim:${t.key.toBase58()}`, async () => {
          const r = await this.sender.send("claim_for", this.client.buildClaimFor({ keeper: this.keeperKey, mint: c.mint, ticket: t.key, owner: t.ticket.owner }));
          if (!r.ok) {
            if (r.code !== undefined && r.code !== null && skip.has(r.code)) return 0;
            throw new Error(`claim_for failed: ${r.error}`);
          }
          this.log.info({ mint: c.mint.toBase58(), ticket: t.key.toBase58(), owner: t.ticket.owner.toBase58(), simulated: r.simulated }, "auto-claimed");
          return 1;
        });
      }
    }
    return n;
  }

  // ── LP skim + settle ─────────────────────────────────────────────────────

  async runSkims(): Promise<number> {
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.coin.status !== "graduated" || Date.now() - c.lastSkimAt < this.cfg.skimIntervalSecs * 1000) continue;
      n += await this.guard(`skim:${c.mint.toBase58()}`, async () => {
        c.lastSkimAt = Date.now();
        const r = await this.sender.send("skim_settle", this.client.buildSkimSettle({ payer: this.keeperKey, mint: c.mint }), { retries: 0 });
        if (!r.ok) {
          if (r.code === LOCKER_ERROR.NothingToSkim || r.code === FUMPAD_ERROR.NothingToSettle) return 0;
          throw new Error(`skim failed: ${r.error}`);
        }
        return 1;
      });
    }
    return n;
  }

  // ── platform fees + params ───────────────────────────────────────────────

  async runPlatformFees(): Promise<number> {
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.coin.platformFeesUnclaimed < this.cfg.platformFeesMinLamports || Date.now() - c.lastFeesAt < this.cfg.platformFeesIntervalSecs * 1000) continue;
      n += await this.guard(`fees:${c.mint.toBase58()}`, async () => {
        c.lastFeesAt = Date.now();
        const r = await this.sender.send("withdraw_platform_fees", await this.client.buildWithdrawPlatformFees({ caller: this.keeperKey, mint: c.mint }));
        if (!r.ok) throw new Error(`withdraw_platform_fees failed: ${r.error}`);
        return 1;
      });
    }
    return n;
  }

  async runParams(): Promise<number> {
    if (this.pendingEta === 0n || this.chainNow < this.pendingEta) return 0;
    return this.guard("params", async () => {
      const r = await this.sender.send("execute_params", this.client.buildExecuteParams(this.keeperKey));
      if (!r.ok) {
        if (r.code === FUMPAD_ERROR.NoPendingParams) return 0;
        throw new Error(`execute_params failed: ${r.error}`);
      }
      this.pendingEta = 0n;
      await this.alerts.alert("params", "executed queued params change (D15 timelock elapsed)");
      return 1;
    });
  }
}

function decodeCoinSafe(data: Uint8Array): CoinAccount | null {
  try {
    return decodeCoin(new Uint8Array(data));
  } catch {
    return null;
  }
}
