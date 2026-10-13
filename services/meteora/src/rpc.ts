/**
 * Minimal read-only JSON-RPC client (fetch). Exists because web3.js v1's `getTransaction` response
 * schema only accepts `version: 0 | "legacy"`: a mainnet version-1 transaction (no lookup tables,
 * `transactionConfig` in the message) fails its validation. Here the raw JSON is returned as-is and
 * `maxSupportedTransactionVersion: 1` is always sent.
 *
 * Backoff: 429 / 5xx / "rate limit" errors retry with exponential delay; `minGapMs` spaces requests.
 * The URL (which carries the API key) never appears in errors.
 */
import type { ConfirmedTx } from "./tx.js";

export interface RpcOptions {
  minGapMs?: number;
  attempts?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime?: number | null;
  confirmationStatus?: string | null;
}

export interface SignatureStatus {
  slot: number;
  err: unknown;
  confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
}

export class RpcError extends Error {
  constructor(readonly method: string, message: string, readonly code?: number) {
    super(`${method}: ${message}`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MeteoraRpc {
  private last = 0;
  private readonly o: Required<Omit<RpcOptions, "fetchImpl">> & { fetchImpl: typeof fetch };

  constructor(private readonly url: string, opts: RpcOptions = {}) {
    this.o = { minGapMs: opts.minGapMs ?? 0, attempts: opts.attempts ?? 6, timeoutMs: opts.timeoutMs ?? 20_000, fetchImpl: opts.fetchImpl ?? fetch };
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr = "";
    for (let a = 0; a < this.o.attempts; a++) {
      const wait = this.last + this.o.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      let res: Response;
      try {
        res = await this.o.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: AbortSignal.timeout(this.o.timeoutMs),
        });
      } catch (e) {
        lastErr = (e as Error).name || "network error"; // never the message: it can contain the URL
        await sleep(300 * 2 ** a);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(300 * 2 ** a);
        continue;
      }
      if (!res.ok) throw new RpcError(method, `HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { code?: number; message?: string } };
      if (j.error) {
        if (j.error.code === 429 || /rate limit/i.test(String(j.error.message))) {
          lastErr = "rate limited";
          await sleep(300 * 2 ** a);
          continue;
        }
        throw new RpcError(method, String(j.error.message).slice(0, 300), j.error.code);
      }
      return j.result as T;
    }
    throw new RpcError(method, `gave up after ${this.o.attempts} attempts (${lastErr})`);
  }

  /** Full transaction (json encoding, any version up to 1) or null if the node doesn't know it. */
  getTransaction(signature: string, commitment: "confirmed" | "finalized" = "confirmed", encoding: "json" | "jsonParsed" = "json"): Promise<ConfirmedTx | null> {
    return this.call<ConfirmedTx | null>("getTransaction", [signature, { encoding, commitment, maxSupportedTransactionVersion: 1 }]);
  }

  getSignaturesForAddress(address: string, opts: { before?: string; until?: string; limit?: number; commitment?: "confirmed" | "finalized" } = {}): Promise<SignatureInfo[]> {
    const { commitment = "confirmed", ...rest } = opts;
    return this.call<SignatureInfo[]>("getSignaturesForAddress", [address, { ...rest, commitment }]);
  }

  async getSignatureStatuses(signatures: string[]): Promise<(SignatureStatus | null)[]> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>("getSignatureStatuses", [signatures, { searchTransactionHistory: true }]);
    return r.value;
  }

  getSlot(commitment: "confirmed" | "finalized" = "confirmed"): Promise<number> {
    return this.call<number>("getSlot", [{ commitment }]);
  }
}
