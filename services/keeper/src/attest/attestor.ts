/**
 * Attestor (keeper mode, run ×3 with separate keys + RPC providers, SPEC v0.7 §5).
 *
 * Every tick, for every registered coin: re-derive the coin's ticket decisions from this keeper's own
 * finalized chain view (derive.ts), turn them into the exact attestation messages (records.ts), skip what
 * is already consumed on chain, sign the rest, publish the signature on the shared board (board.ts) and
 * submit `[Ed25519(2 sigs), attest_sell | attest_rebuy]` once two distinct ACTIVE keepers signed the same
 * bytes. One designated submitter per message (lowest key among the valid signers); the others take over
 * after `fallbackSubmitSecs`. Respects PAUSE_ATTEST, the per-coin hourly cap (checked locally before
 * sending; `AttestRateLimited` backs the coin off), consumed markers and the attestation age limit.
 */
import { type PublicKey, type TransactionInstruction, ComputeBudgetProgram } from "@solana/web3.js";
import type { Logger } from "pino";

import {
  activeKeepers,
  attestRateAllows,
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
  accountsExist(keys: PublicKey[]): Promise<boolean[]>;
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
  alerts?: Alerter;
  /** Unix seconds (injectable for tests). */
  now?: () => number;
  /** A non-designated signer submits after this long (s). */
  fallbackSubmitSecs?: number;
  /** Back-off after AttestRateLimited (s). */
  rateLimitBackoffSecs?: number;
  computeUnits?: number;
  /** Only derive coins whose mint is in this set (tests / ops). */
  onlyMints?: Set<string>;
}

/** Program errors that mean "the program disagrees with the engine": never retried, always alerted. */
const PERMANENT = new Set([
  "AttestationExpired",
  "WrongCluster",
  "PoolNotOfCoin",
  "CreatorSell",
  "BelowMinimumUsd",
  "InvalidTicketAmount",
  "StalePythPrice",
  "RebuyOutOfWindow",
  "TicketNotOpen",
  "InvalidAttestation",
  "ZeroAmount",
]);

export interface AttestorStats {
  ticks: number;
  coins: number;
  candidates: number;
  signed: number;
  submitted: number;
  landed: number;
  dropped: number;
  errors: number;
  state: "idle" | "not_active_keeper" | "paused" | "running";
  lastTickAt: number;
}

export class Attestor {
  stats: AttestorStats = { ticks: 0, coins: 0, candidates: 0, signed: 0, submitted: 0, landed: 0, dropped: 0, errors: 0, state: "idle", lastTickAt: 0 };
  private signedIds = new Set<string>();
  private coinBackoff = new Map<string, number>();
  private msgBackoff = new Map<string, { until: number; tries: number }>();
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
    for (const coin of coins) {
      const mint = coin.mint.toBase58();
      if ((this.coinBackoff.get(mint) ?? 0) > now) continue;
      try {
        await this.coin(coin, g, active, now);
      } catch (e) {
        this.stats.errors++;
        log.warn({ mint, err: String(e).slice(0, 300) }, "attestor: coin derivation failed");
        await this.o.alerts?.alert(`derive:${mint}`, `attestor ${this.me.slice(0, 6)}: derivation failed for ${mint}: ${String(e).slice(0, 200)}`);
      }
    }
  }

  private async coin(coin: CoinAccount, g: GlobalAccount, active: PublicKey[], now: number): Promise<void> {
    const mint = coin.mint.toBase58();
    const der = await this.o.derive(coin, g);
    if (der.output.issues.length) {
      await this.o.alerts?.alert(`issues:${mint}`, `attestor ${this.me.slice(0, 6)}: engine issues on ${mint}: ${der.output.issues.map((i) => `${i.kind}@${i.slot}`).join(", ").slice(0, 300)}`);
    }
    const cands = candidates(mint, der.output, { clusterTag: g.clusterTag, now, maxAttestAgeSecs: Number(g.params.maxAttestAgeSecs) });
    this.stats.candidates += cands.length;
    if (!cands.length) return;
    const consumed = await this.o.chain.accountsExist(
      cands.map((c) => (c.kind === "sell" ? consumedSellPda(c.sell!.signature, c.ixKey) : consumedRebuyPda(c.rebuy!.signature, c.ixKey, c.rebuy!.ticket))),
    );
    let cap = { start: coin.attestBucketStart, cur: coin.attestBucketTokens, prev: coin.attestPrevBucketTokens };
    for (let i = 0; i < cands.length; i++) {
      if (consumed[i]) continue;
      const c = cands[i];
      const st = await this.o.board.status(c.id);
      if (st && (st.status === "landed" || st.status === "dropped")) continue;
      const bo = this.msgBackoff.get(c.id);
      if (bo && bo.until > now) continue;
      // sign + publish (idempotent)
      if (!this.signedIds.has(c.id)) {
        const sig = signAttestation(c.message, this.o.keeper.secretKey);
        await this.o.board.publish(c.id, c.kind, mint, c.message, this.me, sig);
        this.signedIds.add(c.id);
        this.stats.signed++;
      }
      const valid = validSignatures(c.message, await this.o.board.signatures(c.id), active);
      if (valid.length < 2) continue;
      const designated = valid[0].keeper.toBase58() === this.me;
      if (!designated) {
        const first = await this.o.board.firstSeen(c.id);
        if (!first || now - Math.floor(first.getTime() / 1000) < (this.o.fallbackSubmitSecs ?? 60)) continue;
      }
      if (c.kind === "sell") {
        const nextCap = attestRateAllows({
          now: BigInt(now),
          bucketStart: cap.start,
          curTokens: cap.cur,
          prevTokens: cap.prev,
          totalSupply: coin.totalSupply,
          bps: g.params.maxAttestTokensPerHourBps,
          ticketTokens: c.sell!.ticketTokens,
        });
        if (!nextCap) {
          this.coinBackoff.set(mint, now + (this.o.rateLimitBackoffSecs ?? 300));
          this.o.log.info({ mint }, "attestor: hourly attestation cap reached; retrying later");
          return;
        }
      }
      const two = pickTwo(valid, this.me);
      const res = await this.submit(c, two);
      if (res === "rate_limited") {
        this.coinBackoff.set(mint, now + (this.o.rateLimitBackoffSecs ?? 300));
        return;
      }
      if (res === "landed" && c.kind === "sell") {
        // keep the local cap estimate in step (the program rolled its buckets the same way)
        const bucket = (BigInt(now) / 3_600n) * 3_600n;
        if (bucket !== cap.start) cap = { start: bucket, prev: bucket === cap.start + 3_600n ? cap.cur : 0n, cur: 0n };
        cap.cur += c.sell!.ticketTokens;
      }
    }
  }

  private async submit(c: Candidate, sigs: KeeperSignature[]): Promise<"landed" | "dropped" | "retry" | "rate_limited"> {
    const keeper = this.o.keeper.publicKey;
    let attestIx: TransactionInstruction;
    if (c.kind === "sell") {
      const pos = await this.o.chain.position(c.sell!.mint, c.sell!.trader);
      attestIx = attestSellIx({ keeper, mint: c.sell!.mint, trader: c.sell!.trader, seq: pos?.nextTicketSeq ?? 0n, signature: c.sell!.signature, ixKey: c.ixKey });
    } else {
      const t = await this.o.chain.ticket(c.rebuy!.ticket);
      if (!t) return "retry";
      if (t.status !== "open" && t.status !== "queued") {
        await this.o.board.setStatus(c.id, "dropped", `ticket ${t.status}`);
        return "dropped";
      }
      attestIx = attestRebuyIx({ keeper, mint: c.rebuy!.mint, owner: c.rebuy!.owner, ticket: c.rebuy!.ticket, signature: c.rebuy!.signature, ixKey: c.ixKey, queued: t.status === "queued" });
    }
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: this.o.computeUnits ?? 250_000 }), ed25519Instruction(c.message, sigs), attestIx];
    this.stats.submitted++;
    const r = await this.o.submitter.submit(`attest_${c.kind}`, ixs);
    const now = this.now();
    if (r.ok) {
      this.stats.landed++;
      await this.o.board.setStatus(c.id, "landed", r.signature);
      this.o.log.info({ kind: c.kind, mint: c.mint, wallet: c.wallet, tx: r.signature }, "attested");
      return "landed";
    }
    const name = r.code !== undefined && r.code !== null ? errorName(r.code) : undefined;
    if (name === "AlreadyConsumed") {
      await this.o.board.setStatus(c.id, "landed", "already consumed");
      return "landed";
    }
    if (name === "AttestRateLimited") return "rate_limited";
    if (name && PERMANENT.has(name)) {
      this.stats.dropped++;
      await this.o.board.setStatus(c.id, "dropped", name);
      await this.o.alerts?.alert(`drop:${c.id}`, `attestor: program rejected a derived ${c.kind} (${name}) for ${c.wallet} on ${c.mint} — engine/program mismatch, check`);
      return "dropped";
    }
    const prev = this.msgBackoff.get(c.id)?.tries ?? 0;
    this.msgBackoff.set(c.id, { tries: prev + 1, until: now + Math.min(3_600, 15 * 2 ** prev) });
    this.stats.errors++;
    this.o.log.warn({ kind: c.kind, mint: c.mint, code: r.code, name, err: r.error?.slice(0, 200) }, "attestation not landed; will retry");
    return "retry";
  }
}

/** Two signatures for the Ed25519 instruction, our own first when we have one. */
export function pickTwo(valid: KeeperSignature[], me: string): KeeperSignature[] {
  const mine = valid.find((s) => s.keeper.toBase58() === me);
  const others = valid.filter((s) => s.keeper.toBase58() !== me);
  return (mine ? [mine, ...others] : others).slice(0, 2);
}
