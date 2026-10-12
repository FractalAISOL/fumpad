/**
 * M-2: proof of wallet control for `POST /v1/launch/prepare`.
 *
 * The creator signs (wallet `signMessage`, ed25519 over the UTF-8 bytes) this exact text:
 *
 *   FUMPAD launch
 *   creator: <creator base58>
 *   symbol: <SYMBOL as submitted>
 *   nonce: <16-64 chars [A-Za-z0-9_-]>
 *   issuedAt: <unix milliseconds>
 *
 * and sends `auth: { message, signature }` (signature base58, or base64) with the prepare
 * body. The server checks the signature against `creator`, that creator/symbol match the
 * body, and that `issuedAt` is within the accepted age (default 10 min; 60 s ahead of the
 * server clock tolerated). Re-preparing the same launch (expired blockhash) may reuse the
 * same signed message while it is fresh: a replay can only re-reserve the mint that wallet
 * already holds.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";

import type { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export const LAUNCH_AUTH_HEADER = "FUMPAD launch";

export function launchAuthMessage(a: { creator: string; symbol: string; nonce: string; issuedAt: number }): string {
  return [LAUNCH_AUTH_HEADER, `creator: ${a.creator}`, `symbol: ${a.symbol}`, `nonce: ${a.nonce}`, `issuedAt: ${a.issuedAt}`].join("\n");
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function decodeSig(sig: string): Buffer | null {
  if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) {
    try {
      const b = Buffer.from(bs58.decode(sig));
      return b.length === 64 ? b : null;
    } catch {
      return null;
    }
  }
  if (/^[A-Za-z0-9+/]{86}={0,2}$/.test(sig)) {
    const b = Buffer.from(sig, "base64");
    return b.length === 64 ? b : null;
  }
  return null;
}

/** null = valid; otherwise the reason (400 message). */
export function launchAuthError(
  auth: unknown,
  expect: { creator: PublicKey; symbol: string },
  opts: { maxAgeSecs: number; now?: number },
): string | null {
  if (!auth || typeof auth !== "object") return "auth required: sign the launch message with the creator wallet";
  const { message, signature } = auth as { message?: unknown; signature?: unknown };
  if (typeof message !== "string" || message.length > 512 || typeof signature !== "string") return "invalid auth";
  const lines = message.split("\n");
  if (lines.length !== 5 || lines[0] !== LAUNCH_AUTH_HEADER) return "invalid auth message";
  const field = (i: number, k: string) => (lines[i].startsWith(`${k}: `) ? lines[i].slice(k.length + 2) : null);
  const creator = field(1, "creator");
  const symbol = field(2, "symbol");
  const nonce = field(3, "nonce");
  const issuedAt = Number(field(4, "issuedAt"));
  if (creator !== expect.creator.toBase58()) return "auth message is for another wallet";
  if (symbol !== expect.symbol) return "auth message is for another symbol";
  if (!nonce || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return "invalid auth nonce";
  const now = opts.now ?? Date.now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > opts.maxAgeSecs * 1000) return "auth message expired, sign again";
  const sig = decodeSig(signature);
  if (!sig) return "invalid auth signature";
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, expect.creator.toBuffer()]), format: "der", type: "spki" });
  let ok = false;
  try {
    ok = verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    ok = false;
  }
  return ok ? null : "auth signature does not match the creator wallet";
}

/** Node-side signer for the launch message (tests, scripts; wallets use `signMessage`). */
export function signLaunchAuth(secretKey: Uint8Array, a: { creator: string; symbol: string; nonce?: string; issuedAt?: number }): { message: string; signature: string } {
  const message = launchAuthMessage({ creator: a.creator, symbol: a.symbol, nonce: a.nonce ?? randomBytes(12).toString("hex"), issuedAt: a.issuedAt ?? Date.now() });
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return { message, signature: bs58.encode(sign(null, Buffer.from(message, "utf8"), key)) };
}
