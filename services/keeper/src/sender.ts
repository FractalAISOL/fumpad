/**
 * Transaction sending for the keeper: dynamic priority fee, simulate-only dry-run,
 * polling confirmation with rebroadcast, bounded retries on expiry, program-error
 * classification (so callers can treat e.g. NothingToSkim as "nothing to do").
 *
 * S-3 / ONC-4 / L-9: reads go through the read connection; every send and every rebroadcast goes through `sendConn`
 * (the keeper's private, keyed RPC — config refuses a public endpoint in production) with preflight ON. MEV-sensitive
 * sends (`mev: true`: execute_buyback) can instead go to Jito's block engine as a revert-protected single-transaction
 * bundle (`bundleOnly=true`, with a tip). Jito always skips preflight, so the keeper simulates first itself and never
 * rebroadcasts such a transaction through a regular RPC. record_samples can't carry a tip (`require_isolated` allows
 * only compute-budget instructions beside it), so samples always use the private RPC.
 */
import {
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Logger } from "pino";

import { type BuiltTx, COMPUTE_BUDGET_PROGRAM_ID, confirmSignature, customErrorCode, TxFailedError } from "@fumpad/sdk";

export interface SendResult {
  ok: boolean;
  signature?: string;
  /** Custom program error code, if the failure was a program error. */
  code?: number | null;
  error?: string;
  logs?: string[] | null;
  simulated?: boolean;
  unitsConsumed?: number;
}

export interface SenderOpts {
  dryRun: boolean;
  priorityPercentile: number;
  priorityMinMicroLamports: number;
  priorityMaxMicroLamports: number;
  /** Cap on one tx's priority fee in lamports (µ-lamports/CU × CU limit / 1e6). */
  priorityMaxLamportsPerTx?: number;
  /** S-3 / L-9: all sends + rebroadcasts (the private RPC). Defaults to the read connection. */
  sendConn?: Connection;
  /** S-3: Jito block engine `…/api/v1/transactions` URL + tip (lamports), used for `mev: true` sends. */
  jito?: { url: string; tipLamports: number };
}

/** Jito's 8 tip accounts (block engine getTipAccounts, verified 2026-10-17; fixed by Jito's tip-payment program). */
export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((k) => new PublicKey(k));

/** Jito's sendTransaction URL with bundleOnly=true (revert protection: the tx only ever lands inside a bundle). */
export function jitoSendUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.set("bundleOnly", "true");
  return u.toString();
}

/** CU limit a tx requests (SetComputeUnitLimit), else the runtime default 200k per instruction. */
export function computeUnitLimit(ixs: TransactionInstruction[]): number {
  const lim = ixs.find((i) => i.programId.equals(COMPUTE_BUDGET_PROGRAM_ID) && i.data[0] === 2 && i.data.length >= 5);
  if (lim) return Buffer.from(lim.data).readUInt32LE(1);
  return 200_000 * Math.max(1, ixs.filter((i) => !i.programId.equals(COMPUTE_BUDGET_PROGRAM_ID)).length);
}

/** M-7: clamp µ-lamports/CU so the whole tx pays at most `maxLamports` in priority fees. */
export function capPriority(microLamports: number, cuLimit: number, maxLamports: number | undefined): number {
  if (maxLamports === undefined || cuLimit <= 0) return microLamports;
  return Math.max(0, Math.min(microLamports, Math.floor((maxLamports * 1_000_000) / cuLimit)));
}

export class Sender {
  stats = { sent: 0, failed: 0, simulated: 0, quiet: 0, lastPriority: 0, cappedPriority: 0, jito: 0 };
  private sendConn: Connection;

  constructor(private conn: Connection, private payer: Keypair, private opts: SenderOpts, private log: Logger) {
    this.sendConn = opts.sendConn ?? conn;
  }

  /** Percentile of recent prioritization fees on the accounts this tx write-locks. */
  async priorityFee(writable: PublicKey[]): Promise<number> {
    try {
      const fees = await this.conn.getRecentPrioritizationFees({ lockedWritableAccounts: writable.slice(0, 128) });
      const v = fees.map((f) => f.prioritizationFee).sort((a, b) => a - b);
      const p = v.length ? v[Math.min(v.length - 1, Math.floor((v.length * this.opts.priorityPercentile) / 100))] : 0;
      const fee = Math.min(this.opts.priorityMaxMicroLamports, Math.max(this.opts.priorityMinMicroLamports, p));
      this.stats.lastPriority = fee;
      return fee;
    } catch {
      return this.opts.priorityMinMicroLamports;
    }
  }

  private withPriority(ixs: TransactionInstruction[], microLamports: number): TransactionInstruction[] {
    // Drop any existing SetComputeUnitPrice (discriminator 3), keep the limit, append ours.
    const rest = ixs.filter((i) => !(i.programId.equals(COMPUTE_BUDGET_PROGRAM_ID) && i.data[0] === 3));
    return [ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...rest];
  }

  /** POST a signed tx to Jito's sendTransaction (base64, bundleOnly); returns its signature. */
  private async sendJito(raw: Uint8Array): Promise<string> {
    const res = await fetch(jitoSendUrl(this.opts.jito!.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendTransaction", params: [Buffer.from(raw).toString("base64"), { encoding: "base64" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => null)) as { result?: string; error?: { message?: string } } | null;
    if (!res.ok || !body?.result) throw new Error(`jito send failed (${res.status}): ${body?.error?.message ?? "no result"}`);
    return body.result;
  }

  /**
   * `quietCodes`: program errors that mean "nothing to do" for this job (e.g. NothingToClaim). They are still
   * returned (`ok: false`, `code`) but logged at debug and not counted as failed sends.
   * `mev`: the tx is sandwichable (execute_buyback): private submission via Jito when configured.
   */
  async send(label: string, b: BuiltTx, o: { lookupTables?: AddressLookupTableAccount[]; retries?: number; quietCodes?: ReadonlySet<number>; mev?: boolean } = {}): Promise<SendResult> {
    const viaJito = !!o.mev && !!this.opts.jito;
    const writable = [...new Map(b.instructions.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => [k.pubkey.toBase58(), k.pubkey]))).values()];
    const want = await this.priorityFee(writable);
    const fee = capPriority(want, computeUnitLimit(b.instructions), this.opts.priorityMaxLamportsPerTx);
    if (fee < want) this.stats.cappedPriority++;
    const ixs = this.withPriority(b.instructions, fee);
    if (viaJito) {
      const tipTo = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
      ixs.push(SystemProgram.transfer({ fromPubkey: this.payer.publicKey, toPubkey: tipTo, lamports: this.opts.jito!.tipLamports }));
    }
    const retries = o.retries ?? 2;
    for (let attempt = 0; ; attempt++) {
      const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
      const msg = new TransactionMessage({ payerKey: this.payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(o.lookupTables ?? []);
      const tx = new VersionedTransaction(msg);
      tx.sign([this.payer, ...(b.signers ?? [])]);
      if (this.opts.dryRun) {
        const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
        this.stats.simulated++;
        const ok = !sim.value.err;
        const code = customErrorCode(sim.value.err);
        if (!ok && code !== null && code !== undefined && o.quietCodes?.has(code)) {
          this.stats.quiet++;
          this.log.debug({ job: label, dryRun: true, code }, "nothing to do");
        } else this.log.info({ job: label, dryRun: true, ok, err: sim.value.err, units: sim.value.unitsConsumed, ...(ok ? {} : { logs: (sim.value.logs ?? []).slice(-25) }) }, "simulated");
        return { ok, simulated: true, code, error: ok ? undefined : JSON.stringify(sim.value.err), logs: sim.value.logs, unitsConsumed: sim.value.unitsConsumed };
      }
      try {
        const raw = tx.serialize();
        let sig: string;
        if (viaJito) {
          // Jito skips preflight: run it here (the answer an RPC preflight would give) and never send a failing tx.
          const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
          if (sim.value.err) throw new TxFailedError("(preflight)", sim.value.err, sim.value.logs);
          sig = await this.sendJito(raw);
          this.stats.jito++;
          // No rebroadcast: re-sending through a regular RPC would expose it; an expired tx is retried fresh.
          await confirmSignature(this.sendConn, sig, lastValidBlockHeight, "confirmed");
        } else {
          sig = await this.sendConn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
          await confirmSignature(this.sendConn, sig, lastValidBlockHeight, "confirmed", raw);
        }
        this.stats.sent++;
        this.log.info({ job: label, signature: sig, priority: fee, ...(viaJito ? { via: "jito" } : {}) }, "sent");
        return { ok: true, signature: sig };
      } catch (e) {
        if (e instanceof SendTransactionError || e instanceof TxFailedError) {
          const logs = e instanceof TxFailedError ? e.logs : e.logs;
          const code = customErrorCode(e instanceof TxFailedError ? e.err : e.message);
          if (code !== null && code !== undefined && o.quietCodes?.has(code)) {
            this.stats.quiet++;
            this.log.debug({ job: label, code }, "nothing to do");
            return { ok: false, code, error: e.message.split("\n")[0], logs };
          }
          this.stats.failed++;
          // The simulation / execution logs are what explains a failure ("Simulation failed" alone
          // doesn't): keep the tail, where the failing program logs its error.
          this.log.warn({ job: label, code, err: e.message.split("\n")[0], logs: (logs ?? []).slice(-8) }, "tx failed");
          return { ok: false, code, error: e.message.split("\n")[0], logs };
        }
        // Expired / timed out / RPC hiccup: retry with a fresh blockhash.
        if (attempt >= retries) {
          this.stats.failed++;
          return { ok: false, error: String(e) };
        }
        this.log.warn({ job: label, attempt, err: String(e) }, "send retry");
      }
    }
  }
}
