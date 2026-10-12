/**
 * Transaction sending for the keeper: dynamic priority fee, simulate-only dry-run,
 * polling confirmation with rebroadcast, bounded retries on expiry, program-error
 * classification (so callers can treat e.g. NothingToSkim as "nothing to do").
 */
import {
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  type PublicKey,
  SendTransactionError,
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
}

export class Sender {
  stats = { sent: 0, failed: 0, simulated: 0, lastPriority: 0 };

  constructor(private conn: Connection, private payer: Keypair, private opts: SenderOpts, private log: Logger) {}

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

  async send(label: string, b: BuiltTx, o: { lookupTables?: AddressLookupTableAccount[]; retries?: number } = {}): Promise<SendResult> {
    const writable = [...new Map(b.instructions.flatMap((i) => i.keys.filter((k) => k.isWritable).map((k) => [k.pubkey.toBase58(), k.pubkey]))).values()];
    const fee = await this.priorityFee(writable);
    const ixs = this.withPriority(b.instructions, fee);
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
        this.log.info({ job: label, dryRun: true, ok, err: sim.value.err, units: sim.value.unitsConsumed, ...(ok ? {} : { logs: (sim.value.logs ?? []).slice(-25) }) }, "simulated");
        return { ok, simulated: true, code: customErrorCode(sim.value.err), error: ok ? undefined : JSON.stringify(sim.value.err), logs: sim.value.logs, unitsConsumed: sim.value.unitsConsumed };
      }
      try {
        const raw = tx.serialize();
        const sig = await this.conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });
        await confirmSignature(this.conn, sig, lastValidBlockHeight, "confirmed", raw);
        this.stats.sent++;
        this.log.info({ job: label, signature: sig, priority: fee }, "sent");
        return { ok: true, signature: sig };
      } catch (e) {
        if (e instanceof SendTransactionError || e instanceof TxFailedError) {
          const logs = e instanceof TxFailedError ? e.logs : e.logs;
          const code = customErrorCode(e instanceof TxFailedError ? e.err : e.message);
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
