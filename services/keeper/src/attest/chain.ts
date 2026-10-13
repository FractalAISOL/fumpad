/** web3.js-backed ChainView / Submitter for the attestor and watcher (this keeper's own RPC). */
import { type Commitment, type Connection, type Keypair, type PublicKey, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { Logger } from "pino";

import {
  accountDiscriminator,
  type CoinAccount,
  coinPda,
  customErrorCode,
  decodeCoin,
  decodeConsumed,
  decodeGlobal,
  decodePosition,
  decodeTicket,
  FUMPAD_PROGRAM_ID,
  type GlobalAccount,
  globalPda,
  positionPda,
} from "@fumpad/sdk";

import type { ChainView, SubmitResult, Submitter } from "./attestor.js";

export class RpcChainView implements ChainView {
  constructor(private conn: Connection, private commitment: Commitment = "confirmed") {}

  async global(): Promise<GlobalAccount> {
    const a = await this.conn.getAccountInfo(globalPda(), this.commitment);
    if (!a) throw new Error("Global not initialized");
    return decodeGlobal(a.data);
  }

  /** Every registered coin (Coin accounts by discriminator), finalized. */
  async coins(): Promise<CoinAccount[]> {
    const disc = bs58.encode(accountDiscriminator("Coin"));
    const r = await this.conn.getProgramAccounts(FUMPAD_PROGRAM_ID, { commitment: "finalized", filters: [{ memcmp: { offset: 0, bytes: disc } }] });
    return r.map((x) => decodeCoin(x.account.data)).sort((a, b) => (a.mint.toBase58() < b.mint.toBase58() ? -1 : 1));
  }

  async coin(mint: PublicKey): Promise<CoinAccount | null> {
    const a = await this.conn.getAccountInfo(coinPda(mint), "finalized");
    return a ? decodeCoin(a.data) : null;
  }

  async accountsExist(keys: PublicKey[]): Promise<boolean[]> {
    const out: boolean[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      // consumed markers: only a FINALIZED marker means "landed" (V7-M1 / L4)
      const r = await this.conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "finalized");
      out.push(...r.map((x) => !!x && x.owner.equals(FUMPAD_PROGRAM_ID)));
    }
    return out;
  }

  async consumedMarkers(keys: PublicKey[]): Promise<({ kind: number; messageHash: Uint8Array } | null)[]> {
    const out: ({ kind: number; messageHash: Uint8Array } | null)[] = [];
    for (let i = 0; i < keys.length; i += 100) {
      const r = await this.conn.getMultipleAccountsInfo(keys.slice(i, i + 100), "finalized");
      out.push(
        ...r.map((x) => {
          if (!x || !x.owner.equals(FUMPAD_PROGRAM_ID)) return null;
          const c = decodeConsumed(x.data);
          return { kind: c.kind, messageHash: Uint8Array.from(c.messageHash) };
        }),
      );
    }
    return out;
  }

  async position(mint: PublicKey, wallet: PublicKey) {
    const a = await this.conn.getAccountInfo(positionPda(mint, wallet), this.commitment);
    return a ? decodePosition(a.data) : null;
  }

  async ticket(address: PublicKey) {
    const a = await this.conn.getAccountInfo(address, this.commitment);
    return a && a.owner.equals(FUMPAD_PROGRAM_ID) ? decodeTicket(a.data) : null;
  }
}

/** Legacy-tx submitter: fresh blockhash, send, poll confirmation; returns the program error code on failure. */
export class RpcSubmitter implements Submitter {
  constructor(private conn: Connection, private payer: Keypair, private log: Logger, private opts: { dryRun?: boolean; confirmTimeoutMs?: number } = {}) {}

  async submit(label: string, ixs: TransactionInstruction[]): Promise<SubmitResult> {
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({ payerKey: this.payer.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToLegacyMessage();
    const tx = new VersionedTransaction(msg);
    tx.sign([this.payer]);
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, commitment: "confirmed" });
    if (sim.value.err) return { ok: false, code: customErrorCode(sim.value.err), error: JSON.stringify(sim.value.err) + " " + (sim.value.logs ?? []).slice(-3).join(" | ") };
    if (this.opts.dryRun) return { ok: false, error: "dry run" };
    let sig: string;
    try {
      sig = await this.conn.sendTransaction(tx, { skipPreflight: true, maxRetries: 0 });
    } catch (e) {
      return { ok: false, code: customErrorCode(String(e)), error: String(e) };
    }
    const deadline = Date.now() + (this.opts.confirmTimeoutMs ?? 60_000);
    while (Date.now() < deadline) {
      const st = (await this.conn.getSignatureStatuses([sig])).value[0];
      if (st?.err) return { ok: false, signature: sig, code: customErrorCode(st.err), error: JSON.stringify(st.err) };
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { ok: true, signature: sig };
      if ((await this.conn.getBlockHeight("confirmed")) > lastValidBlockHeight) break;
      await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 0 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1_500));
    }
    this.log.warn({ label, sig }, "attestation tx not confirmed before expiry");
    return { ok: false, signature: sig, error: "expired" };
  }
}

