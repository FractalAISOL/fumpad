/**
 * FUMPAD keeper jobs, v0.7 (SPEC v0.7 §3–§6, INTERFACE-v0.7 §3). One loop, chain state only:
 *
 *  fees      claim_fees: the coin's FIRST claim right after the launch window (slot ≥ launch_slot +
 *            launch_window_slots, D33: 100% → buyback), then whenever the DBC pool's unclaimed partner
 *            fee ≥ FEES_MIN_LAMPORTS (every FEES_INTERVAL_SECS at most); claim_lp_fees on graduated coins
 *            every LP_FEES_INTERVAL_SECS (simulated first; NothingToClaim = skip).
 *  graduate  a completed DBC pool that Meteora's keepers haven't migrated within MIGRATE_GRACE_SECS →
 *            migrate_pool (fresh position-NFT keypair, 600k CU); a migrated pool → graduate (finds the
 *            locked DAMM v2 position), then init_observations + 9× init_claim_queue.
 *  sample    record_samples: graduated coins heartbeat < 10 min (EVERY coin), full rate (15 s) when spot
 *            ≥ 50% of the lowest open trigger or buyback_lamports ≥ threshold; curve coins only right
 *            before a pre-grad buyback (its guard needs a keeper sample ≤ 60 s old). ≤ 8 coins / legacy tx.
 *  buyback   execute_buyback: pre-grad (keeper-only) within ±band of the fresh pre-grad sample, slice ≤
 *            0.5% of the curve's quote reserve and never completing the curve; post-grad within ±band of
 *            the covered 30-min keeper median, slice ≤ 0.5% of the pool's SOL. Pre-checked like the program.
 *  autoclaim claim_for every attested Open ticket past its challenge window whose trigger holds on the
 *            covered median (owner not opted out; D16 wallet queue limit respected).
 *  queue     process_queue for exactly the entries the program's skip-ahead walk pays (H-4).
 *  close     close_ticket for terminal tickets (rent back to the attesting keeper) and Open tickets past
 *            the claim window (→ Expired); close_consumed for this keeper's markers older than 7 days
 *            whose ticket is gone.
 *  platform  withdraw_platform_fees above a threshold.  params  execute_params / execute_config after
 *            their 48 h timelocks.
 * Budget (M-7): per-tx priority cap, daily spend budget (essential jobs only once exceeded), low-balance
 * alarm. Single instance per key (L-10): Postgres advisory lock when DATABASE_URL is set.
 */
import { randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";

import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { pino, type Logger } from "pino";

import {
  accountDiscriminator,
  BPS_DENOM,
  claimFeesIx,
  claimForIx,
  claimLpFeesIx,
  claimQueuePda,
  closeConsumedIx,
  closeTicketIx,
  type CoinAccount,
  type CoinRefs,
  coinPda,
  dammPoolPda,
  createAtaIdempotentIx,
  DAMM_V2_PROGRAM_ID,
  type DammPool,
  type DbcVirtualPool,
  decodeClaimQueue,
  decodeCoin,
  decodeConsumed,
  decodeDammPool,
  decodeDbcPool,
  decodeGlobal,
  decodeObservations,
  decodePosition,
  decodeTicket,
  decodeTokenAccount,
  executeBuybackIx,
  executeConfigIx,
  executeParamsIx,
  FUMPAD_ERROR,
  FUMPAD_PROGRAM_ID,
  type GlobalAccount,
  globalPda,
  graduateIx,
  initClaimQueueIx,
  initObservationsIx,
  isPaused,
  medianPriceQ64,
  meetsMultiple,
  migratePoolIx,
  type ObservationsAccount,
  observationsPda,
  PAUSE,
  planQueuePayments,
  positionPda,
  pregradMedianQ64,
  priceQ64FromSqrt,
  processQueueIx,
  recordSamplesIx,
  rewardVault,
  type TicketAccount,
  TICKET_STATUS,
  TICKET_STATUS_OFFSET,
  TOKEN_2022_PROGRAM_ID,
  withdrawPlatformFeesIx,
  CLAIM_QUEUE_CAPACITY,
  MAX_QUEUED_PER_WALLET,
} from "@fumpad/sdk";

import { Alerter } from "./alerts.js";
import type { KeeperConfig } from "./config.js";
import { type SpendState, trackSpend } from "./policy.js";
import { Sender } from "./sender.js";
import { KeeperStore } from "./store.js";

const ESSENTIAL_JOBS = new Set(["sample", "graduate", "params", "fees"]);
const OBSERVATIONS_SIZE = 8_280;
const CLAIM_QUEUE_SIZE = 81_976;
const DAMM_POSITION_SIZE = 408;
const MAX_SAMPLE_COINS = 8;
const STARTED_AT = new Date().toISOString();
const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

interface CoinState {
  coin: CoinAccount;
  dbc?: DbcVirtualPool | null;
  damm?: DammPool | null;
  obs?: ObservationsAccount | null;
  queueReady?: boolean;
  positionNftMint?: PublicKey;
  /** Lowest trigger price (Q64) among open tickets. */
  minTriggerQ64?: bigint;
  openTickets: number;
  lastFeesAt: number;
  lastLpFeesAt: number;
  lastBuybackAt: number;
  /** L5: randomized next buyback time (ms). */
  nextBuybackAt?: number;
  /** L5: this keeper's own pre-graduation spot observations (chain time, Q64), oldest first. */
  pregradObs?: SpotObservation[];
  lastQueueAt: number;
  lastAutoClaimAt: number;
  queueSkip?: number;
  queueBackoff?: number;
}

export interface AutoClaimCandidate {
  key: PublicKey;
  ticket: Pick<TicketAccount, "owner" | "tokens" | "sellPriceQ64" | "sellTs" | "status" | "attestedAt">;
}

/**
 * Which tickets to claim_for now (pure; mirrors claim.rs + the v0.7 challenge window): Open, past
 * attested_at + challenge, inside the claim window, covered median ≥ trigger, non-zero claim, owner not
 * opted out, not a wallet already at the D16 queue limit unless the claim pays now. Oldest sell first.
 */
export function planAutoClaims(a: {
  tickets: AutoClaimCandidate[];
  optedOut: Set<string>;
  queuedPerOwner: Map<string, number>;
  medianQ64: bigint;
  now: bigint;
  rewards: { claimWindowSecs: bigint; triggerMultipleBps: number; claimBps: number; maxClaimPoolBps: number };
  challengeSecs: bigint;
  poolTokens: bigint;
}): AutoClaimCandidate[] {
  const r = a.rewards;
  return a.tickets
    .filter((t) => {
      const owner = t.ticket.owner.toBase58();
      if (t.ticket.status !== "open" || a.optedOut.has(owner)) return false;
      if (t.ticket.attestedAt + a.challengeSecs > a.now) return false;
      if (t.ticket.sellTs + r.claimWindowSecs < a.now) return false;
      if (!meetsMultiple(a.medianQ64, t.ticket.sellPriceQ64, BigInt(r.triggerMultipleBps))) return false;
      const amount = (t.ticket.tokens * BigInt(r.claimBps)) / BPS_DENOM;
      if (amount === 0n) return false;
      const fits = amount * BPS_DENOM <= a.poolTokens * BigInt(r.maxClaimPoolBps);
      return fits || (a.queuedPerOwner.get(owner) ?? 0) < MAX_QUEUED_PER_WALLET;
    })
    .sort((x, y) => (x.ticket.sellTs < y.ticket.sellTs ? -1 : x.ticket.sellTs > y.ticket.sellTs ? 1 : 0));
}

/**
 * Pre-graduation buyback slice (INTERFACE §3 Buyback): min(balance, quote_reserve × bps, room before the
 * migration threshold − 1); 0 = nothing to do.
 */
export function pregradBuybackSlice(a: { buybackLamports: bigint; quoteReserve: bigint; threshold: bigint; maxPoolBps: number }): bigint {
  const cap = (a.quoteReserve * BigInt(a.maxPoolBps)) / BPS_DENOM;
  const room = a.threshold > a.quoteReserve + 1n ? a.threshold - a.quoteReserve - 1n : 0n;
  let s = a.buybackLamports;
  if (cap < s) s = cap;
  if (room < s) s = room;
  return s > 0n ? s : 0n;
}

export interface SpotObservation {
  ts: bigint;
  q64: bigint;
}

/** Append an observation if it is ≥ `spacingSecs` after the last one; keep the newest `keep`. */
export function observeSpot(obs: SpotObservation[], o: SpotObservation, spacingSecs: number, keep: number): SpotObservation[] {
  const last = obs[obs.length - 1];
  if (last && o.ts - last.ts < BigInt(spacingSecs)) return obs;
  const out = [...obs, o];
  return out.length > keep ? out.slice(out.length - keep) : out;
}

/**
 * L5: time-weighted average of the last observations (each weighted by how long it stood, the newest up to
 * `now`); null until `minSamples` exist or if the oldest is older than `maxAgeSecs` × samples (stale ring).
 * The pre-graduation buyback goes only when the live spot AND the on-chain sample are inside the band of
 * this TWAP, so pushing the spot inside the ±3% band right before one sample no longer moves the guard.
 */
export function spotTwapQ64(obs: readonly SpotObservation[], now: bigint, minSamples: number, maxGapSecs: number): bigint | null {
  if (obs.length < minSamples) return null;
  let num = 0n;
  let den = 0n;
  for (let i = 0; i < obs.length; i++) {
    const end = i + 1 < obs.length ? obs[i + 1].ts : now;
    const w = end - obs[i].ts;
    if (w > BigInt(maxGapSecs)) return null; // a gap: the ring doesn't describe the recent price
    const ww = w > 0n ? w : 1n;
    num += obs[i].q64 * ww;
    den += ww;
  }
  return den > 0n ? num / den : null;
}

/** L5: next buyback time — interval × (1 + U[0, jitter)), from a CSPRNG (not guessable by a sandwicher). */
export function nextBuybackDelayMs(intervalSecs: number, jitter: number, rand: () => number = () => randomInt(0, 1_000_000) / 1_000_000): number {
  return Math.round(intervalSecs * 1000 * (1 + Math.max(0, jitter) * rand()));
}

/** |spot − guard| ≤ band (bps) — the program's PriceDeviation check. */
export const withinBand = (spot: bigint, guard: bigint, bps: number) => (spot > guard ? spot - guard : guard - spot) * BPS_DENOM <= guard * BigInt(bps);

/** claim_for outcomes that mean "not now" rather than a keeper fault. */
const SKIP = (names: string[]) => new Set(names.map((n) => FUMPAD_ERROR[n]).filter((c): c is number => c !== undefined));

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
  readonly sender: Sender;
  readonly alerts: Alerter;
  readonly store?: KeeperStore;
  readonly jobs: Record<string, JobHealth> = {};
  private coins = new Map<string, CoinState>();
  private global?: GlobalAccount;
  private chainNow = 0n;
  private slot = 0n;
  private lastScan = 0;
  private lastTicketScan = 0;
  private lastCloseScan = 0;
  private inflight = new Set<string>();
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private server?: Server;
  private loopAt = 0;
  private balance = 0n;
  private spend: SpendState | null = null;
  private openTickets: { key: PublicKey; ticket: TicketAccount }[] = [];
  stats = { zeroPayRuns: 0, queuePaid: 0, overBudgetSkips: 0, migrations: 0, graduations: 0, feeClaims: 0 };

  constructor(readonly cfg: KeeperConfig, log?: Logger) {
    this.log = log ?? pino({ name: "keeper", level: cfg.logLevel, base: { service: "keeper" }, timestamp: pino.stdTimeFunctions.isoTime, formatters: { level: (l) => ({ level: l }) } });
    this.conn = new Connection(cfg.rpcUrl, "confirmed");
    this.sender = new Sender(this.conn, cfg.keeper, cfg, this.log);
    this.alerts = new Alerter(this.log, { botToken: cfg.telegramBotToken, chatId: cfg.telegramChatId });
    if (cfg.databaseUrl) this.store = new KeeperStore(cfg.databaseUrl, this.log);
  }

  get keeperKey() {
    return this.cfg.keeper.publicKey;
  }
  private get metaKey() {
    return `keeper:${this.keeperKey.toBase58()}`;
  }
  get overBudget(): boolean {
    return !!this.spend && BigInt(this.spend.lamports) >= this.cfg.dailyBudgetLamports;
  }

  async start(): Promise<void> {
    this.log.info({ keeper: this.keeperKey.toBase58(), dryRun: this.cfg.dryRun, jobs: this.cfg.jobs, singleInstanceLock: !!this.store }, "keeper starting");
    if (this.cfg.healthPort) {
      this.server = createServer((req, res) => {
        if (req.url?.startsWith("/health")) {
          const h = this.health();
          res.writeHead(h.ok ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(h));
        } else res.writeHead(404).end();
      });
      await new Promise<void>((r) => this.server!.listen(this.cfg.healthPort, r));
    }
    if (this.store) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;
      await this.store.acquireLock(
        (e) => {
          if (this.stopped) return;
          this.log.error({ err: e.message }, "lost the keeper lock; exiting so a single instance resumes");
          process.exit(1);
        },
        { signal: { get stopped() { return self.stopped; } } },
      );
      this.spend = await this.store.getMeta<SpendState>(`${this.metaKey}:spend`);
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
    await this.store?.close();
  }

  health() {
    const now = Date.now();
    const loopFresh = now - this.loopAt < Math.max(30_000, this.cfg.loopMs * 10);
    const failing = Object.entries(this.jobs).filter(([, j]) => j.failures >= 3).map(([k]) => k);
    return {
      ok: loopFresh && failing.length === 0,
      version: { sha: process.env.GIT_SHA || process.env.RAILWAY_GIT_COMMIT_SHA || null, startedAt: STARTED_AT },
      msSinceLoop: now - this.loopAt,
      failingJobs: failing,
      overBudget: this.overBudget,
      coins: this.coins.size,
      postGraduationSetupFailing: failing.includes("graduate"),
    };
  }

  // ── loop ─────────────────────────────────────────────────────────────────
  async loopOnce(): Promise<void> {
    await this.refresh();
    const j = this.cfg.jobs;
    if (j.fees) await this.job("fees", () => this.runFees());
    if (j.graduate) await this.job("graduate", () => this.runGraduate());
    if (j.sample) await this.job("sample", () => this.runSampling());
    if (j.buyback) await this.job("buyback", () => this.runBuybacks());
    if (j.autoclaim) await this.job("autoclaim", () => this.runAutoClaims());
    if (j.queue) await this.job("queue", () => this.runQueues());
    if (j.close) await this.job("close", () => this.runClose());
    if (j.platform) await this.job("platform", () => this.runPlatformFees());
    if (j.params) await this.job("params", () => this.runParams());
    this.loopAt = Date.now();
  }

  private async job(name: string, fn: () => Promise<number>) {
    if (this.overBudget && !ESSENTIAL_JOBS.has(name)) {
      this.stats.overBudgetSkips++;
      return;
    }
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

  private async guard(key: string, fn: () => Promise<number>): Promise<number> {
    if (this.inflight.has(key)) return 0;
    this.inflight.add(key);
    try {
      return await fn();
    } finally {
      this.inflight.delete(key);
    }
  }

  private paused(flag: number) {
    return !!this.global && isPaused(this.global, flag, this.chainNow);
  }

  private refs(c: CoinState): CoinRefs {
    const k = c.coin;
    return { mint: k.mint, dbcConfig: k.dbcConfig, dbcPool: k.dbcPool, dammPool: k.dammPool.equals(PublicKey.default) ? undefined : k.dammPool, creator: k.creator };
  }

  /** Re-read chain state. */
  async refresh(): Promise<void> {
    const now = Date.now();
    const slot = await this.conn.getSlot("confirmed");
    this.slot = BigInt(slot);
    this.chainNow = BigInt((await this.conn.getBlockTime(slot).catch(() => null)) ?? Math.floor(now / 1000));
    if (!this.global || now - this.lastScan > this.cfg.scanIntervalSecs * 1000) {
      const g = await this.conn.getAccountInfo(globalPda());
      if (!g) throw new Error("Global not initialized");
      this.global = decodeGlobal(g.data);
      const res = await this.conn.getProgramAccounts(FUMPAD_PROGRAM_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Coin")) } }] });
      for (const r of res) {
        const coin = decodeCoin(r.account.data);
        const k = coin.mint.toBase58();
        const prev = this.coins.get(k);
        this.coins.set(k, prev ? { ...prev, coin } : { coin, openTickets: 0, lastFeesAt: 0, lastLpFeesAt: 0, lastBuybackAt: 0, lastQueueAt: 0, lastAutoClaimAt: 0 });
      }
      this.balance = BigInt(await this.conn.getBalance(this.keeperKey));
      if (this.balance < this.cfg.minKeeperLamports) await this.alerts.alert("balance", `keeper balance low: ${Number(this.balance) / 1e9} SOL`);
      const wasOver = this.overBudget;
      this.spend = trackSpend(this.spend, this.balance);
      await this.store?.setMeta(`${this.metaKey}:spend`, this.spend);
      if (this.overBudget && !wasOver)
        await this.alerts.alert("budget", `keeper spent ${Number(this.spend.lamports) / 1e9} SOL today (budget ${Number(this.cfg.dailyBudgetLamports) / 1e9}); only essential jobs run until 00:00 UTC`);
      this.lastScan = now;
    } else {
      const list = [...this.coins.values()];
      for (let i = 0; i < list.length; i += 100) {
        const chunk = list.slice(i, i + 100);
        const infos = await this.conn.getMultipleAccountsInfo(chunk.map((c) => this.coinPdaOf(c)));
        infos.forEach((a, j) => {
          if (a) chunk[j].coin = decodeCoin(a.data);
        });
      }
    }
    // Venue + oracle accounts.
    const list = [...this.coins.values()];
    for (let i = 0; i < list.length; i += 25) {
      const chunk = list.slice(i, i + 25);
      const keys = chunk.flatMap((c) => [c.coin.dbcPool, c.coin.dammPool.equals(PublicKey.default) ? c.coin.dbcPool : c.coin.dammPool, observationsPda(c.coin.mint), claimQueuePda(c.coin.mint)]);
      const infos = await this.conn.getMultipleAccountsInfo(keys);
      chunk.forEach((c, j) => {
        const [d, a, o, q] = infos.slice(j * 4, j * 4 + 4);
        c.dbc = d ? decodeDbcPool(new Uint8Array(d.data)) : null;
        c.damm = c.coin.status === "graduated" && a ? decodeDammPool(new Uint8Array(a.data)) : null;
        c.obs = o && o.data.length >= OBSERVATIONS_SIZE && o.owner.equals(FUMPAD_PROGRAM_ID) ? decodeObservations(new Uint8Array(o.data)) : null;
        c.queueReady = !!q && q.data.length >= CLAIM_QUEUE_SIZE && q.owner.equals(FUMPAD_PROGRAM_ID);
      });
    }
    if (now - this.lastTicketScan > this.cfg.ticketScanIntervalSecs * 1000) {
      this.openTickets = await this.scanTickets(TICKET_STATUS.open);
      const byMint = new Map<string, { min: bigint; n: number }>();
      for (const { ticket } of this.openTickets) {
        const c = this.coins.get(ticket.mint.toBase58());
        if (!c) continue;
        const t = (ticket.sellPriceQ64 * BigInt(c.coin.rewards.triggerMultipleBps)) / BPS_DENOM;
        const e = byMint.get(ticket.mint.toBase58());
        byMint.set(ticket.mint.toBase58(), { min: e && e.min < t ? e.min : t, n: (e?.n ?? 0) + 1 });
      }
      for (const [k, c] of this.coins) {
        c.minTriggerQ64 = byMint.get(k)?.min;
        c.openTickets = byMint.get(k)?.n ?? 0;
      }
      this.lastTicketScan = now;
    }
  }

  private coinPdaOf(c: CoinState) {
    return coinPda(c.coin.mint);
  }

  private async scanTickets(status: number, mint?: PublicKey): Promise<{ key: PublicKey; ticket: TicketAccount }[]> {
    const filters = [
      { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Ticket")) } },
      { memcmp: { offset: TICKET_STATUS_OFFSET, bytes: bs58.encode(Uint8Array.from([status])) } },
      ...(mint ? [{ memcmp: { offset: 8 + 1 + 32, bytes: mint.toBase58() } }] : []),
    ];
    const res = await this.conn.getProgramAccounts(FUMPAD_PROGRAM_ID, { filters });
    return res.map((r) => ({ key: r.pubkey, ticket: decodeTicket(r.account.data) }));
  }

  // ── fees ─────────────────────────────────────────────────────────────────
  async runFees(): Promise<number> {
    let n = 0;
    const skip = SKIP(["NothingToClaim", "LaunchWindowActive", "LaunchFeesUnsettled"]);
    for (const c of this.coins.values()) {
      const k = c.coin;
      const windowEnd = k.launchSlot + k.launchWindowSlots;
      const first = !k.launchFeesSettled && this.slot >= windowEnd;
      const due = k.launchFeesSettled && c.dbc && c.dbc.partnerQuoteFee >= this.cfg.feesMinLamports && Date.now() - c.lastFeesAt > this.cfg.feesIntervalSecs * 1000;
      if (first || due) {
        n += await this.guard(`fees:${k.mint.toBase58()}`, async () => {
          c.lastFeesAt = Date.now();
          const r = await this.sender.send(first ? "claim_fees(launch window)" : "claim_fees", { instructions: [cu(200_000), claimFeesIx(this.keeperKey, this.refs(c))] }, { retries: 1 });
          if (!r.ok) {
            if (r.code !== undefined && r.code !== null && skip.has(r.code)) return 0;
            throw new Error(`claim_fees failed: ${r.error}`);
          }
          this.stats.feeClaims++;
          return 1;
        });
      }
      if (k.status === "graduated" && k.launchFeesSettled && Date.now() - c.lastLpFeesAt > this.cfg.lpFeesIntervalSecs * 1000) {
        n += await this.guard(`lpfees:${k.mint.toBase58()}`, async () => {
          c.lastLpFeesAt = Date.now();
          const nft = await this.positionNftMint(c);
          if (!nft) return 0;
          const r = await this.sender.send("claim_lp_fees", { instructions: [cu(200_000), claimLpFeesIx(this.keeperKey, { ...this.refs(c), dammPosition: k.dammPosition, positionNftMint: nft })] }, { retries: 0 });
          if (!r.ok) {
            if (r.code !== undefined && r.code !== null && skip.has(r.code)) return 0;
            throw new Error(`claim_lp_fees failed: ${r.error}`);
          }
          return 1;
        });
      }
    }
    return n;
  }

  private async positionNftMint(c: CoinState): Promise<PublicKey | null> {
    if (c.positionNftMint) return c.positionNftMint;
    if (c.coin.dammPosition.equals(PublicKey.default)) return null;
    const a = await this.conn.getAccountInfo(c.coin.dammPosition);
    if (!a) return null;
    c.positionNftMint = new PublicKey(a.data.subarray(40, 72));
    return c.positionNftMint;
  }

  /** The locked DAMM v2 position the migration created for `pool` (first position with locked liquidity). */
  private async findDammPosition(pool: PublicKey): Promise<{ position: PublicKey; nftMint: PublicKey } | null> {
    const res = await this.conn.getProgramAccounts(DAMM_V2_PROGRAM_ID, { filters: [{ dataSize: DAMM_POSITION_SIZE }, { memcmp: { offset: 8, bytes: pool.toBase58() } }] });
    const locked = (d: Buffer) => d.readBigUInt64LE(8 + 32 + 32 + 32 + 32 + 8 + 8 + 16 + 16) | (d.readBigUInt64LE(8 + 32 + 32 + 32 + 32 + 8 + 8 + 16 + 16 + 8) << 64n);
    const best = res.filter((r) => locked(r.account.data) > 0n).sort((a, b) => (locked(b.account.data) > locked(a.account.data) ? 1 : -1))[0];
    return best ? { position: best.pubkey, nftMint: new PublicKey(best.account.data.subarray(40, 72)) } : null;
  }

  // ── graduation ───────────────────────────────────────────────────────────
  async runGraduate(): Promise<number> {
    if (this.paused(PAUSE.graduate)) return 0;
    let n = 0;
    for (const c of this.coins.values()) {
      const k = c.coin;
      const mint = k.mint.toBase58();
      if (k.status !== "graduated" && c.dbc) {
        if (c.dbc.isMigrated === 1) {
          n += await this.guard(`graduate:${mint}`, async () => {
            const dammPool = dammPoolPda(k.mint);
            const pos = await this.findDammPosition(dammPool);
            if (!pos) throw new Error(`graduate ${mint}: no locked DAMM v2 position found for ${dammPool.toBase58()}`);
            const migrator = k.migrator.equals(PublicKey.default) ? this.keeperKey : k.migrator;
            const r = await this.sender.send("graduate", { instructions: [cu(400_000), graduateIx({ caller: this.keeperKey, coin: { ...this.refs(c), dammPool }, dammPosition: pos.position, positionNftMint: pos.nftMint, migrator })] });
            if (!r.ok) throw new Error(`graduate failed: ${r.error}`);
            this.stats.graduations++;
            c.positionNftMint = pos.nftMint;
            this.log.info({ mint, signature: r.signature }, "graduated");
            return 1;
          });
        } else if (c.dbc.migrationProgress >= 2 || k.status === "complete") {
          const finished = Number(c.dbc.finishCurveTimestamp);
          if (finished && Number(this.chainNow) - finished < this.cfg.migrateGraceSecs) continue;
          n += await this.guard(`migrate:${mint}`, async () => {
            const nft = Keypair.generate();
            const r = await this.sender.send("migrate_pool", { instructions: [cu(600_000), migratePoolIx({ caller: this.keeperKey, coin: this.refs(c), nftMint: nft.publicKey })], signers: [nft] });
            if (!r.ok) throw new Error(`migrate_pool failed: ${r.error}`);
            this.stats.migrations++;
            this.log.info({ mint, signature: r.signature }, "migrated (DBC → DAMM v2)");
            return 1;
          });
        }
      }
      if (k.status === "graduated" && (!c.obs || !c.queueReady)) {
        n += await this.guard(`setup:${mint}`, async () => {
          const ixs = [cu(400_000)];
          if (!c.obs) ixs.push(initObservationsIx(this.keeperKey, k.mint));
          if (!c.queueReady) for (let i = 0; i < 9; i++) ixs.push(initClaimQueueIx(this.keeperKey, k.mint));
          const r = await this.sender.send("post-graduation setup", { instructions: ixs });
          if (!r.ok) throw new Error(`post-graduation setup failed: ${r.error}`);
          return 1;
        });
      }
    }
    return n;
  }

  // ── sampling ─────────────────────────────────────────────────────────────
  private spotQ64(c: CoinState): bigint | null {
    if (c.coin.status === "graduated") return c.damm ? priceQ64FromSqrt(c.damm.sqrtPrice) : null;
    return c.dbc ? priceQ64FromSqrt(c.dbc.sqrtPrice) : null;
  }

  sampleInterval(c: CoinState): number {
    const spot = this.spotQ64(c);
    const near = c.minTriggerQ64 !== undefined && spot !== null && spot * 1000n >= c.minTriggerQ64 * BigInt(Math.round(this.cfg.nearTriggerRatio * 1000));
    const buyback = c.coin.buybackLamports >= this.cfg.buybackMinLamports;
    return near || buyback ? this.cfg.fullRateSecs : this.cfg.heartbeatSecs;
  }

  async runSampling(): Promise<number> {
    const g = this.global!;
    const now = this.chainNow;
    const due: { c: CoinState; pool: PublicKey }[] = [];
    for (const c of this.coins.values()) {
      const k = c.coin;
      if (k.status === "graduated") {
        if (!c.obs || !c.damm) continue;
        const last = c.obs.keeperSampled ? c.obs.lastKeeperSampleTs : 0n;
        const since = now - last;
        if (since >= g.params.oracleMinSpacingSecs && since >= BigInt(this.sampleInterval(c))) due.push({ c, pool: k.dammPool });
      } else if (k.status === "curve" && c.dbc && k.buybackLamports >= this.cfg.buybackMinLamports && k.launchFeesSettled && !this.paused(PAUSE.trade)) {
        // pre-grad buyback guard: keep a keeper sample ≤ 60 s old — but only anchor it at a spot that agrees
        // with this keeper's own TWAP (L5), so a pushed spot never becomes the on-chain guard
        const spot = this.observePregrad(c);
        const twap = this.pregradTwap(c);
        if (spot === null || twap === null || !withinBand(spot, twap, g.params.buybackMaxDeviationBps)) continue;
        const since = now - k.pregradSampleTs;
        if (since >= g.params.oracleMinSpacingSecs && since >= 40n) due.push({ c, pool: k.dbcPool });
      }
    }
    let sent = 0;
    for (let i = 0; i < due.length; i += MAX_SAMPLE_COINS) {
      const batch = due.slice(i, i + MAX_SAMPLE_COINS);
      sent += await this.guard(`sample:${batch.map((b) => b.c.coin.mint.toBase58()).join(",")}`, async () => {
        const r = await this.sender.send("record_samples", { instructions: [cu(60_000 + 25_000 * batch.length), recordSamplesIx(this.keeperKey, batch.map((b) => ({ mint: b.c.coin.mint, pool: b.pool })))] });
        if (!r.ok) {
          if (r.code === FUMPAD_ERROR.SampleTooSoon) return 0;
          throw new Error(`record_samples failed: ${r.error}`);
        }
        return 1;
      });
    }
    return sent;
  }

  /** Record this keeper's view of a curve coin's spot (L5); returns it. */
  private observePregrad(c: CoinState): bigint | null {
    const spot = this.spotQ64(c);
    if (spot === null) return null;
    c.pregradObs = observeSpot(c.pregradObs ?? [], { ts: this.chainNow, q64: spot }, this.cfg.pregradTwapSpacingSecs, this.cfg.pregradTwapSamples);
    return spot;
  }

  private pregradTwap(c: CoinState): bigint | null {
    const n = this.cfg.pregradTwapSamples;
    return spotTwapQ64(c.pregradObs ?? [], this.chainNow, Math.max(2, n), this.cfg.pregradTwapSpacingSecs * 4);
  }

  // ── buybacks ─────────────────────────────────────────────────────────────
  async runBuybacks(): Promise<number> {
    if (this.paused(PAUSE.trade)) return 0;
    const p = this.global!.params;
    const skip = SKIP(["PriceDeviation", "InsufficientSamples", "NothingToBuyBack", "StaleSample", "LaunchWindowActive"]);
    let n = 0;
    for (const c of this.coins.values()) {
      const k = c.coin;
      if (k.buybackLamports < this.cfg.buybackMinLamports || Date.now() < (c.nextBuybackAt ?? c.lastBuybackAt + this.cfg.buybackIntervalSecs * 1000)) continue;
      let maxIn: bigint;
      let venue: "dbc" | "damm_v2";
      const spot = this.spotQ64(c);
      if (spot === null) continue;
      if (k.status === "curve") {
        if (!c.dbc || this.slot < k.launchSlot + k.launchWindowSlots) continue;
        if (this.chainNow - k.pregradSampleTs > 60n || !withinBand(spot, k.pregradSamplePriceQ64, p.buybackMaxDeviationBps)) continue;
        // L5 (on-chain): spot must also be within the band of the median of the coin's recent keeper samples
        // (≥ 4 within 5 min spanning ≥ 60 s) — skip until the ring is warm instead of paying for InsufficientSamples
        const median = pregradMedianQ64(k.pregradRing, this.chainNow);
        if (median === null || !withinBand(spot, median, p.buybackMaxDeviationBps)) continue;
        // L5: the live spot and the on-chain sample must both agree with the TWAP of our last N observations
        this.observePregrad(c);
        const twap = this.pregradTwap(c);
        if (twap === null || !withinBand(spot, twap, p.buybackMaxDeviationBps) || !withinBand(k.pregradSamplePriceQ64, twap, p.buybackMaxDeviationBps)) continue;
        const cfg = await this.dbcThreshold(c);
        maxIn = pregradBuybackSlice({ buybackLamports: k.buybackLamports, quoteReserve: c.dbc.quoteReserve, threshold: cfg, maxPoolBps: p.buybackMaxPoolBps });
        venue = "dbc";
      } else if (k.status === "graduated") {
        if (!c.obs || !c.damm) continue;
        const med = medianPriceQ64(c.obs, this.chainNow, p.oracleWindowSecs, p.oracleMinSamples);
        if (!med || !withinBand(spot, med, p.buybackMaxDeviationBps)) continue;
        const cap = (c.damm.tokenBAmount * BigInt(p.buybackMaxPoolBps)) / BPS_DENOM;
        maxIn = k.buybackLamports < cap ? k.buybackLamports : cap;
        venue = "damm_v2";
      } else continue;
      if (maxIn <= 0n) continue;
      n += await this.guard(`buyback:${k.mint.toBase58()}`, async () => {
        c.lastBuybackAt = Date.now();
        c.nextBuybackAt = c.lastBuybackAt + nextBuybackDelayMs(this.cfg.buybackIntervalSecs, this.cfg.buybackJitter);
        const r = await this.sender.send("execute_buyback", { instructions: [cu(250_000), executeBuybackIx({ cranker: this.keeperKey, coin: this.refs(c), venue, maxIn })] });
        if (!r.ok) {
          if (r.code !== undefined && r.code !== null && skip.has(r.code)) return 0;
          throw new Error(`execute_buyback failed: ${r.error}`);
        }
        return 1;
      });
    }
    return n;
  }

  private thresholds = new Map<string, bigint>();
  private async dbcThreshold(c: CoinState): Promise<bigint> {
    const k = c.coin.dbcConfig.toBase58();
    if (!this.thresholds.has(k)) {
      const a = await this.conn.getAccountInfo(c.coin.dbcConfig);
      if (!a) throw new Error("DBC config missing");
      this.thresholds.set(k, a.data.readBigUInt64LE(264));
    }
    return this.thresholds.get(k)!;
  }

  // ── claims ───────────────────────────────────────────────────────────────
  async runAutoClaims(): Promise<number> {
    if (this.paused(PAUSE.claims)) return 0;
    const g = this.global!;
    const skip = SKIP(["TriggerNotMet", "InsufficientSamples", "WalletQueueLimit", "AutoClaimDisabled", "TicketNotOpen", "TicketExpired", "TicketInChallenge", "Paused", "QueueFull", "ZeroAmount", "WrongCoinStatus"]);
    let n = 0;
    for (const c of this.coins.values()) {
      const k = c.coin;
      if (k.status !== "graduated" || !c.obs || !c.queueReady || !c.openTickets) continue;
      if (Date.now() - c.lastAutoClaimAt < this.cfg.autoClaimIntervalSecs * 1000) continue;
      const median = medianPriceQ64(c.obs, this.chainNow, g.params.oracleWindowSecs, g.params.oracleMinSamples);
      if (!median || (c.minTriggerQ64 !== undefined && median < c.minTriggerQ64)) continue;
      c.lastAutoClaimAt = Date.now();
      const open = this.openTickets.filter((t) => t.ticket.mint.equals(k.mint));
      const [qa, va] = await this.conn.getMultipleAccountsInfo([claimQueuePda(k.mint), rewardVault(k.mint)]);
      if (!qa || !va) continue;
      const queue = decodeClaimQueue(new Uint8Array(qa.data));
      if (queue.len >= CLAIM_QUEUE_CAPACITY) continue;
      const pool = decodeTokenAccount(new Uint8Array(va.data)).amount;
      const owners = [...new Set(open.map((t) => t.ticket.owner.toBase58()))].map((o) => new PublicKey(o));
      const infos = owners.length ? await this.conn.getMultipleAccountsInfo(owners.map((o) => positionPda(k.mint, o))) : [];
      const optedOut = new Set(owners.filter((_, i) => infos[i] && decodePosition(new Uint8Array(infos[i]!.data)).autoClaimOptOut === 1).map((o) => o.toBase58()));
      const queuedPerOwner = new Map<string, number>();
      for (const e of queue.entries) queuedPerOwner.set(e.owner.toBase58(), (queuedPerOwner.get(e.owner.toBase58()) ?? 0) + 1);
      const picks = planAutoClaims({ tickets: open, optedOut, queuedPerOwner, medianQ64: median, now: this.chainNow, rewards: k.rewards, challengeSecs: g.params.ticketChallengeSecs, poolTokens: pool });
      for (const t of picks.slice(0, this.cfg.autoClaimMaxPerRun)) {
        n += await this.guard(`autoclaim:${t.key.toBase58()}`, async () => {
          const r = await this.sender.send("claim_for", {
            instructions: [cu(250_000), createAtaIdempotentIx(this.keeperKey, t.ticket.owner, k.mint, TOKEN_2022_PROGRAM_ID), claimForIx({ keeper: this.keeperKey, mint: k.mint, ticket: t.key, owner: t.ticket.owner })],
          });
          if (!r.ok) {
            if (r.code !== undefined && r.code !== null && skip.has(r.code)) return 0;
            throw new Error(`claim_for failed: ${r.error}`);
          }
          this.log.info({ mint: k.mint.toBase58(), ticket: t.key.toBase58(), owner: t.ticket.owner.toBase58() }, "auto-claimed");
          return 1;
        });
      }
    }
    return n;
  }

  async runQueues(): Promise<number> {
    if (this.paused(PAUSE.claims)) return 0;
    let n = 0;
    for (const c of this.coins.values()) {
      const k = c.coin;
      if (k.status !== "graduated" || !c.queueReady || Date.now() - c.lastQueueAt < this.cfg.queueIntervalSecs * 1000) continue;
      c.lastQueueAt = Date.now();
      if (c.queueSkip && c.queueSkip > 0) {
        c.queueSkip--;
        continue;
      }
      const [qa, va] = await this.conn.getMultipleAccountsInfo([claimQueuePda(k.mint), rewardVault(k.mint)]);
      if (!qa || !va) continue;
      const q = decodeClaimQueue(new Uint8Array(qa.data));
      if (!q.len) continue;
      const plan = planQueuePayments(q.entries, decodeTokenAccount(new Uint8Array(va.data)).amount, k.rewards.maxClaimPoolBps);
      if (!plan.pay.length) continue;
      n += await this.guard(`queue:${k.mint.toBase58()}`, async () => {
        const r = await this.sender.send("process_queue", { instructions: [cu(600_000), processQueueIx({ cranker: this.keeperKey, mint: k.mint, entries: plan.pay.map((e) => ({ ticket: e.ticket, owner: e.owner })) })] });
        if (!r.ok) throw new Error(`process_queue failed: ${r.error}`);
        if (r.simulated) return 1;
        const after = await this.conn.getAccountInfo(claimQueuePda(k.mint));
        const left = new Set((after ? decodeClaimQueue(new Uint8Array(after.data)).entries : []).map((e) => e.ticket.toBase58()));
        const paid = plan.pay.filter((e) => !left.has(e.ticket.toBase58())).length;
        this.stats.queuePaid += paid;
        if (paid === 0) {
          this.stats.zeroPayRuns++;
          c.queueBackoff = Math.min(32, (c.queueBackoff ?? 0) * 2 || 1);
          c.queueSkip = c.queueBackoff;
          await this.alerts.alert(`queue-zero-pay:${k.mint.toBase58()}`, `process_queue on ${k.mint.toBase58()} paid nothing (planned ${plan.pay.length}); backing off`);
        } else c.queueBackoff = 0;
        return 1;
      });
    }
    return n;
  }

  // ── closing (rent back to the attesting keeper) ─────────────────────────
  async runClose(): Promise<number> {
    if (Date.now() - this.lastCloseScan < this.cfg.closeIntervalSecs * 1000) return 0;
    this.lastCloseScan = Date.now();
    let n = 0;
    const terminal = [...(await this.scanTickets(TICKET_STATUS.claimed)), ...(await this.scanTickets(TICKET_STATUS.voided)), ...(await this.scanTickets(TICKET_STATUS.expired))];
    const expiredOpen = this.openTickets.filter((t) => {
      const c = this.coins.get(t.ticket.mint.toBase58());
      return c && t.ticket.sellTs + c.coin.rewards.claimWindowSecs < this.chainNow;
    });
    for (const t of [...terminal, ...expiredOpen].slice(0, this.cfg.closeMaxPerRun)) {
      n += await this.guard(`close:${t.key.toBase58()}`, async () => {
        const r = await this.sender.send("close_ticket", { instructions: [closeTicketIx({ caller: this.keeperKey, ticket: t.key, rentPayer: t.ticket.rentPayer, mint: t.ticket.mint, owner: t.ticket.owner })] }, { retries: 0 });
        if (!r.ok) {
          if (r.code === FUMPAD_ERROR.TicketNotClosable) return 0;
          throw new Error(`close_ticket failed: ${r.error}`);
        }
        return 1;
      });
    }
    // Consumed markers this keeper paid for, older than 7 days, whose ticket is gone.
    const consumed = await this.conn.getProgramAccounts(FUMPAD_PROGRAM_ID, {
      filters: [
        { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Consumed")) } },
        { memcmp: { offset: 8 + 1 + 1 + 32, bytes: this.keeperKey.toBase58() } },
      ],
    });
    const old = consumed.map((r) => ({ key: r.pubkey, c: decodeConsumed(r.account.data) })).filter((x) => x.c.blockTime + 7n * 86_400n < this.chainNow);
    for (let i = 0; i < old.length && n < this.cfg.closeMaxPerRun; i += 100) {
      const chunk = old.slice(i, i + 100);
      const live = await this.conn.getMultipleAccountsInfo(chunk.map((x) => x.c.ticket));
      for (let j = 0; j < chunk.length; j++) {
        if (live[j] && live[j]!.owner.equals(FUMPAD_PROGRAM_ID)) continue;
        const x = chunk[j];
        n += await this.guard(`consumed:${x.key.toBase58()}`, async () => {
          const r = await this.sender.send("close_consumed", { instructions: [closeConsumedIx(this.keeperKey, x.key, x.c.rentPayer, x.c.ticket)] }, { retries: 0 });
          if (!r.ok) {
            if (r.code === FUMPAD_ERROR.ConsumedNotClosable) return 0;
            throw new Error(`close_consumed failed: ${r.error}`);
          }
          return 1;
        });
      }
    }
    return n;
  }

  async runPlatformFees(): Promise<number> {
    let n = 0;
    for (const c of this.coins.values()) {
      if (c.coin.platformFeesUnclaimed < this.cfg.platformFeesMinLamports) continue;
      n += await this.guard(`platform:${c.coin.mint.toBase58()}`, async () => {
        const r = await this.sender.send("withdraw_platform_fees", { instructions: [withdrawPlatformFeesIx(this.keeperKey, c.coin.mint, this.global!.platformTreasury)] }, { retries: 0 });
        if (!r.ok) throw new Error(`withdraw_platform_fees failed: ${r.error}`);
        return 1;
      });
    }
    return n;
  }

  async runParams(): Promise<number> {
    const g = this.global!;
    let n = 0;
    if (g.pendingEta > 0n && this.chainNow >= g.pendingEta) {
      n += await this.guard("params", async () => {
        const r = await this.sender.send("execute_params", { instructions: [executeParamsIx(this.keeperKey)] }, { retries: 0 });
        if (!r.ok && r.code !== FUMPAD_ERROR.NoPendingParams && r.code !== FUMPAD_ERROR.TimelockNotElapsed) throw new Error(`execute_params failed: ${r.error}`);
        return r.ok ? 1 : 0;
      });
    }
    if (!g.pendingConfig.equals(PublicKey.default) && g.pendingConfigEta > 0n && this.chainNow >= g.pendingConfigEta) {
      n += await this.guard("config", async () => {
        const r = await this.sender.send("execute_config", { instructions: [executeConfigIx(this.keeperKey, g.pendingConfig)] }, { retries: 0 });
        if (!r.ok && r.code !== FUMPAD_ERROR.NoPendingConfig && r.code !== FUMPAD_ERROR.TimelockNotElapsed) throw new Error(`execute_config failed: ${r.error}`);
        return r.ok ? 1 : 0;
      });
    }
    return n;
  }
}

