/**
 * Attestor (keeper mode, run ×3 with separate keys + RPC providers, SPEC v0.7 §5).
 *
 * Every tick, for every registered coin: re-derive the coin's ticket decisions from this keeper's own
 * finalized chain view (derive.ts), turn them into the exact attestation messages (records.ts), skip what
 * is already consumed on chain, sign the rest, publish the signature on the shared board (board.ts) and
 * submit `[Ed25519(2 sigs), attest_sell | attest_rebuy]` once two distinct ACTIVE keepers signed the same
 * bytes. One designated submitter per message (lowest key among the valid signers); the others take over
 * after `fallbackSubmitSecs`. Respects PAUSE_ATTEST, consumed markers (a marker REOPENED by a guardian void
 * allows one corrected attestation with a different message) and the attestation age limit. The per-coin
 * rate cap no longer rejects (REVIEW-v0.7 M-1): over the cap a ticket is created with a later effective time.
 *
 * Trust (V7-M1, L4): "landed" is decided ONLY from the chain — the consumed marker at `finalized`. A
 * message is "dropped" only by this keeper's own simulation, and only locally. Board hints from peers are
 * advisory: a fresh "landed" hint defers this keeper's own submission once, for `landedHintSecs`, nothing
 * more; "dropped" hints are ignored. So a database writer can delay an attestation by at most that long.
 *
 * Liveness (V7-M6): coins are derived `coinConcurrency` at a time, coins with recent sells first, then the
 * least recently derived; a tick stops starting coins after `tickBudgetMs` (the rest go first next tick).
 */
import { type PublicKey, type TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import { PublicKey as Pk } from "@solana/web3.js";
import type { Logger } from "pino";

import { CrawlBudgetExceeded, LruMap } from "@fumpad/engine";
import { createHash } from "node:crypto";

import {
  activeKeepers,
  attestRebuyIx,
  attestSellIx,
  type CoinAccount,
  consumedRebuyPda,
  consumedSellPda,
  ed25519Instruction,
  errorName,
  type GlobalAccount,
  isPaused,
  type KeeperSignature,
  PAUSE,
  type PositionAccount,
  signAttestation,
  type TicketAccount,
} from "@fumpad/sdk";

import type { Alerter } from "../alerts.js";
import { type SignatureBoard, validSignatures } from "./board.js";
import type { Derivation } from "./derive.js";
import { type Candidate, candidates } from "./records.js";

export interface ChainView {
  global(): Promise<GlobalAccount>;
  coins(): Promise<CoinAccount[]>;
  /** Existence of fumpad-owned accounts at `finalized` (consumed markers: the only "landed" truth). */
  accountsExist(keys: PublicKey[]): Promise<boolean[]>;
  /**
   * Consumed markers at `finalized` with their kind (0 sell, 1 rebuy, 2 sell reopened by a guardian void) and
   * message hash. Optional: without it every existing marker counts as consumed.
   */
  consumedMarkers?(keys: PublicKey[]): Promise<({ kind: number; messageHash: Uint8Array } | null)[]>;
  position(mint: PublicKey, wallet: PublicKey): Promise<PositionAccount | null>;
  ticket(address: PublicKey): Promise<TicketAccount | null>;
}

export interface SubmitResult {
  ok: boolean;
  signature?: string;
  code?: number | null;
  error?: string;
}
export interface Submitter {
  submit(label: string, ixs: TransactionInstruction[]): Promise<SubmitResult>;
}

export interface AttestorOptions {
  keeper: { publicKey: PublicKey; secretKey: Uint8Array };
  chain: ChainView;
  derive: (coin: CoinAccount, global: GlobalAccount) => Promise<Derivation>;
  board: SignatureBoard;
  submitter: Submitter;
  log: Logger;
  alerts?: Pick<Alerter, "alert">;
  /** Unix seconds (injectable for tests). */
  now?: () => number;
  /** A non-designated signer submits after this long (s). */
  fallbackSubmitSecs?: number;
  /** After a landing at `confirmed` (own or a peer's hint), wait this long for the consumed marker to finalize (s). */
  landedHintSecs?: number;
  computeUnits?: number;
  /** Only derive coins whose mint is in this set (tests / ops). */
  onlyMints?: Set<string>;
  /** Coins derived in parallel per tick. */
  coinConcurrency?: number;
  /** Stop starting new coin derivations after this long in one tick (ms). */
  tickBudgetMs?: number;
  /** Coins whose newest sell is younger than this are derived first (s). */
  recentActivitySecs?: number;
  /** Wall clock for the tick budget (ms; tests). */
  clockMs?: () => number;
}

/** Program errors that mean "the program disagrees with the engine": never retried by THIS keeper, always alerted. */
const PERMANENT = new Set([
  "AttestationExpired",
  "WrongCluster",
  "CreatorSell",
  "BelowMinimumUsd",
  "InvalidTicketAmount",
  "StalePythPrice",
  "RebuyOutOfWindow",
  "InvalidAttestation",
  "ZeroAmount",
]);

/**
 * V7-M2: errors that depend on chain state that catches up (Coin.damm_pool recorded by `graduate`, a rebuy
 * debit freeing a ticket slot, a ticket status): retried with back-off after a re-check, never dropped.
 */
export const RETRY_AFTER_RECHECK = new Set(["PoolNotOfCoin", "TooManyOpenTickets", "TicketNotOpen"]);

export interface AttestorStats {
  ticks: number;
  coins: number;
  coinsDerived: number;
  candidates: number;
  signed: number;
  submitted: number;
  landed: number;
  dropped: number;
  deferred: number;
  errors: number;
  state: "idle" | "not_active_keeper" | "paused" | "running";
  lastTickAt: number;
}

export class Attestor {
  stats: AttestorStats = { ticks: 0, coins: 0, coinsDerived: 0, candidates: 0, signed: 0, submitted: 0, landed: 0, dropped: 0, deferred: 0, errors: 0, state: "idle", lastTickAt: 0 };
  // per-message state is bounded (V7-M6): an evicted entry only costs a re-sign / re-check
  private signedIds = new LruMap<string, true>(200_000);
  private msgBackoff = new LruMap<string, { until: number; tries: number }>(200_000);
  /** Own permanent rejections (local only, V7-M1). */
  private dropped = new LruMap<string, string>(200_000);
  /** Own landings at confirmed: id → time; wait for the consumed marker to finalize. */
  private landedAt = new LruMap<string, number>(200_000);
  /** First time a peer's "landed" hint deferred us (each message is deferred at most once). */
  private hintSeen = new LruMap<string, number>(200_000);
  private lastSummary = new Map<string, string>();
  /** Newest sell block time per mint (priority) and last tick each mint was derived (fairness). */
  private lastActivity = new Map<string, number>();
  private lastDerivedTick = new Map<string, number>();
  private readonly me: string;

  constructor(private o: AttestorOptions) {
    this.me = o.keeper.publicKey.toBase58();
  }

  private now() {
    return this.o.now ? this.o.now() : Math.floor(Date.now() / 1000);
  }

  async tick(): Promise<void> {
    const log = this.o.log;
    this.stats.ticks++;
    this.stats.lastTickAt = this.now();
    const clock = this.o.clockMs ?? Date.now;
    const started = clock();
    const g = await this.o.chain.global();
    const now = this.now();
    const active = activeKeepers(g, now);
    if (!active.some((k) => k.toBase58() === this.me)) {
      this.stats.state = "not_active_keeper";
      log.warn({ keeper: this.me }, "attestor: this key is not an active keeper (not in Global.keepers or within its 6 h freeze)");
      return;
    }
    if (isPaused(g, PAUSE.attest, now)) {
      this.stats.state = "paused";
      return;
    }
    this.stats.state = "running";
    const coins = (await this.o.chain.coins()).filter((c) => !this.o.onlyMints || this.o.onlyMints.has(c.mint.toBase58()));
    this.stats.coins = coins.length;
    const recent = this.o.recentActivitySecs ?? 86_400;
    const order = coins
      .map((c) => {
        const m = c.mint.toBase58();
        const act = this.lastActivity.get(m);
        return { c, m, hot: act !== undefined && now - act <= recent ? act : -1, last: this.lastDerivedTick.get(m) ?? -1 };
      })
      .sort((a, b) => b.hot - a.hot || a.last - b.last || (a.m < b.m ? -1 : 1));
    const budgetMs = this.o.tickBudgetMs ?? 60_000;
    let next = 0;
    const worker = async () => {
      while (next < order.length) {
        if (clock() - started > budgetMs) return; // the rest go first next tick (least recently derived)
        const { c, m } = order[next++];
        this.lastDerivedTick.set(m, this.stats.ticks);
        try {
          await this.coin(c, g, active, now);
          this.stats.coinsDerived++;
        } catch (e) {
          if (e instanceof CrawlBudgetExceeded) {
            log.info({ mint: m }, "attestor: crawl budget reached; continuing next tick");
            continue;
          }
          this.stats.errors++;
          log.warn({ mint: m, err: String(e).slice(0, 300) }, "attestor: coin derivation failed");
          await this.o.alerts?.alert(`derive:${m}`, `attestor ${this.me.slice(0, 6)}: derivation failed for ${m}: ${String(e).slice(0, 200)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.o.coinConcurrency ?? 4) }, worker));
  }

  private async coin(coin: CoinAccount, g: GlobalAccount, active: PublicKey[], now: number): Promise<void> {
    const mint = coin.mint.toBase58();
    const der = await this.o.derive(coin, g);
    const newest = der.output.sells.reduce((m, s) => Math.max(m, s.blockTime), -1);
    if (newest >= 0) this.lastActivity.set(mint, newest);
    if (der.output.issues.length) {
      // V7-H2: issues are scoped (tx / wallet); alert per coin with the scopes so the runbook can be followed
      await this.o.alerts?.alert(
        `issues:${mint}`,
        `attestor ${this.me.slice(0, 6)}: engine issues on ${mint}: ${der.output.issues
          .map((i) => `${i.kind}/${i.scope}${i.wallet ? `:${i.wallet.slice(0, 6)}` : ""}@${i.slot}`)
          .join(", ")
          .slice(0, 300)}`,
      );
    }
    const all = candidates(mint, der.output, { clusterTag: g.clusterTag, now, maxAttestAgeSecs: Number(g.params.maxAttestAgeSecs) });
    // V7-M2: a DAMM v2 sell is only valid on chain once `graduate` recorded Coin.damm_pool (finalized view).
    const graduated = !!coin.dammPool && !coin.dammPool.equals(Pk.default);
    const cands = all.filter((c) => c.kind !== "sell" || c.venue !== "damm_v2" || graduated);
    this.stats.candidates += cands.length;
    const sellReasons = der.output.sells.map((s) => (s.ticket ? "ticket" : s.reason));
    const key = JSON.stringify([sellReasons, der.output.rebuys.length, der.output.issues.length, cands.length]);
    if (this.lastSummary.get(mint) !== key) {
      this.lastSummary.set(mint, key);
      this.o.log.info(
        {
          mint,
          maxSlot: der.maxSlot,
          sells: der.output.sells.slice(-8).map((s) => ({ slot: s.slot, base: String(s.baseAmount), quote: String(s.quoteGross), result: s.ticket ? "ticket" : s.reason })),
          rebuys: der.output.rebuys.length,
          issues: der.output.issues.map((i) => `${i.kind}/${i.scope}@${i.slot}`).slice(0, 5),
          candidates: cands.length,
          waitingForGraduate: all.length - cands.length,
        },
        "attestor: derivation changed",
      );
    }
    if (!cands.length) return;
    const consumed = await this.consumed(cands);
    const grace = this.o.landedHintSecs ?? 90;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (consumed[i]) {
        this.landedAt.delete(c.id);
        continue;
      }
      if (this.dropped.has(c.id)) continue;
      const bo = this.msgBackoff.get(c.id);
      if (bo && bo.until > now) continue;
      // sign + publish (idempotent) — even while deferring, so peers can reach 2-of-3
      if (!this.signedIds.has(c.id)) {
        const sig = signAttestation(c.message, this.o.keeper.secretKey);
        await this.o.board.publish(c.id, c.kind, mint, c.message, this.me, sig);
        this.signedIds.set(c.id, true);
        this.stats.signed++;
      }
      // own landing at confirmed, not finalized yet: wait (bounded) instead of re-sending
      const mine = this.landedAt.get(c.id);
      if (mine !== undefined && now - mine < grace) continue;
      // a peer's "landed" hint defers us once, for at most `grace` (V7-M1: hints are never authoritative)
      if (await this.deferredByHint(c.id, active, now, grace)) {
        this.stats.deferred++;
        continue;
      }
      const valid = validSignatures(c.message, await this.o.board.signatures(c.id), active);
      if (valid.length < 2) continue;
      const designated = valid[0].keeper.toBase58() === this.me;
      if (!designated) {
        const first = await this.o.board.firstSeen(c.id);
        if (!first || now - Math.floor(first.getTime() / 1000) < (this.o.fallbackSubmitSecs ?? 60)) continue;
      }
      await this.submit(c, pickTwo(valid, this.me));
    }
  }

  /**
   * Per candidate: already consumed on chain (finalized)? A sell marker REOPENED by a guardian void
   * (kind 2) is not consumed for a corrected message, but still is for the exact message that was voided.
   */
  private async consumed(cands: Candidate[]): Promise<boolean[]> {
    const keys = cands.map((c) => (c.kind === "sell" ? consumedSellPda(c.sell!.signature, c.ixKey) : consumedRebuyPda(c.rebuy!.signature, c.ixKey, c.rebuy!.ticket)));
    if (!this.o.chain.consumedMarkers) return this.o.chain.accountsExist(keys);
    const markers = await this.o.chain.consumedMarkers(keys);
    return markers.map((m, i) => {
      if (!m) return false;
      if (m.kind !== 2 || cands[i].kind !== "sell") return true;
      const h = createHash("sha256").update(cands[i].message).digest().subarray(0, 16);
      return Buffer.compare(h, Buffer.from(m.messageHash)) === 0; // the voided message itself stays consumed
    });
  }

  private async deferredByHint(id: string, active: PublicKey[], now: number, grace: number): Promise<boolean> {
    const seen = this.hintSeen.get(id);
    if (seen !== undefined) return now - seen < grace;
    const keys = new Set(active.map((k) => k.toBase58()));
    const fresh = (await this.o.board.hints(id)).some(
      (h) => h.status === "landed" && h.keeper !== this.me && keys.has(h.keeper) && now - Math.floor(h.updatedAt.getTime() / 1000) < grace,
    );
    if (!fresh) return false;
    this.hintSeen.set(id, now);
    return true;
  }

  private async submit(c: Candidate, sigs: KeeperSignature[]): Promise<"landed" | "dropped" | "retry"> {
    const keeper = this.o.keeper.publicKey;
    let attestIx: TransactionInstruction;
    if (c.kind === "sell") {
      const pos = await this.o.chain.position(c.sell!.mint, c.sell!.trader);
      attestIx = attestSellIx({ keeper, mint: c.sell!.mint, trader: c.sell!.trader, seq: pos?.nextTicketSeq ?? 0n, signature: c.sell!.signature, ixKey: c.ixKey });
    } else {
      const t = await this.o.chain.ticket(c.rebuy!.ticket);
      if (!t) return this.retry(c, "ticket not found yet");
      if (t.status !== "open" && t.status !== "queued") {
        // terminal ticket: nothing to debit any more (decided from this keeper's own chain read)
        this.dropped.set(c.id, `ticket ${t.status}`);
        await this.o.board.setStatus(c.id, this.me, "dropped", `ticket ${t.status}`);
        return "dropped";
      }
      attestIx = attestRebuyIx({ keeper, mint: c.rebuy!.mint, owner: c.rebuy!.owner, ticket: c.rebuy!.ticket, signature: c.rebuy!.signature, ixKey: c.ixKey, queued: t.status === "queued" });
    }
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: this.o.computeUnits ?? 250_000 }), ed25519Instruction(c.message, sigs), attestIx];
    this.stats.submitted++;
    const r = await this.o.submitter.submit(`attest_${c.kind}`, ixs);
    if (r.ok) {
      this.stats.landed++;
      this.landedAt.set(c.id, this.now()); // confirmed; the consumed marker at finalized is the truth
      await this.o.board.setStatus(c.id, this.me, "landed", r.signature);
      this.o.log.info({ kind: c.kind, mint: c.mint, wallet: c.wallet, tx: r.signature }, "attested");
      return "landed";
    }
    const name = r.code !== undefined && r.code !== null ? errorName(r.code) : undefined;
    if (name === "AlreadyConsumed") {
      this.landedAt.set(c.id, this.now());
      return "landed";
    }
    if (name && PERMANENT.has(name)) {
      this.stats.dropped++;
      this.dropped.set(c.id, name);
      await this.o.board.setStatus(c.id, this.me, "dropped", name);
      await this.o.alerts?.alert(`drop:${c.id}`, `attestor: program rejected a derived ${c.kind} (${name}) for ${c.wallet} on ${c.mint} — engine/program mismatch, check`);
      return "dropped";
    }
    if (name && RETRY_AFTER_RECHECK.has(name)) this.o.log.info({ kind: c.kind, mint: c.mint, name }, "attestation waits for chain state (graduate / open tickets); will re-check");
    return this.retry(c, name ?? r.error ?? "unknown", r.code);
  }

  private retry(c: Candidate, why: string, code?: number | null): "retry" {
    const now = this.now();
    const prev = this.msgBackoff.get(c.id)?.tries ?? 0;
    this.msgBackoff.set(c.id, { tries: prev + 1, until: now + Math.min(3_600, 15 * 2 ** prev) });
    this.stats.errors++;
    this.o.log.warn({ kind: c.kind, mint: c.mint, code, err: why.slice(0, 200) }, "attestation not landed; will retry");
    return "retry";
  }
}

/** Two signatures for the Ed25519 instruction, our own first when we have one. */
export function pickTwo(valid: KeeperSignature[], me: string): KeeperSignature[] {
  const mine = valid.find((s) => s.keeper.toBase58() === me);
  const others = valid.filter((s) => s.keeper.toBase58() !== me);
  return (mine ? [mine, ...others] : others).slice(0, 2);
}
