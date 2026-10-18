/**
 * M-2 / L-3: proof of wallet control for `POST /v1/launch/metadata` and `POST /v1/launch/prepare`.
 *
 * The creator signs (wallet `signMessage`, ed25519 over the UTF-8 bytes) this exact text:
 *
 *   FUMPAD launch
 *   domain: <host of the app page that asked, e.g. fumpad.app>
 *   cluster: <mainnet | devnet | testnet | localnet>
 *   creator: <creator base58>
 *   symbol: <SYMBOL as submitted>
 *   nonce: <16-64 chars [A-Za-z0-9_-]>
 *   issuedAt: <unix milliseconds>
 *
 * and sends `auth: { message, signature }` (signature base58, or base64) with the body. The server checks the
 * signature against `creator`, that creator/symbol match the body, that `domain` is one of LAUNCH_AUTH_DOMAINS
 * (default: the CORS_ORIGINS hosts) and `cluster` is this API's FUMPAD_CLUSTER (a devnet signature can't be replayed
 * on mainnet, nor one made on another site here), and that `issuedAt` is within the accepted age (default 10 min;
 * 60 s ahead of the server clock tolerated).
 *
 * L-3 single use: each route accepts a nonce once (`NonceStore`, kept until the message would have expired anyway),
 * so one signature covers the metadata upload and the prepare of one launch, and a captured message can't be
 * replayed. A request that fails before it reserved or stored anything gives its nonce back (the app retries with
 * the same signature). Re-preparing after the blockhash expired needs a new signature (the app re-signs on the 401).
 *
 * Legacy: the five-line message without `domain:` / `cluster:` (apps from before L-3) is accepted while
 * LAUNCH_AUTH_LEGACY=true (the default during the app rollout), single-use as well.
 */
import { createPrivateKey, createPublicKey, randomBytes, sign, verify } from "node:crypto";

import type { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

export const LAUNCH_AUTH_HEADER = "FUMPAD launch";

export interface LaunchAuthFields {
  creator: string;
  symbol: string;
  nonce: string;
  issuedAt: number;
  /** Both set (L-3 message) or both unset (legacy five-line message). */
  domain?: string;
  cluster?: string;
}

/** The exact text to sign: the L-3 seven-line form when `domain` / `cluster` are given, else the legacy five lines. */
export function launchAuthMessage(a: LaunchAuthFields): string {
  const scope = a.domain !== undefined || a.cluster !== undefined ? [`domain: ${a.domain ?? ""}`, `cluster: ${a.cluster ?? ""}`] : [];
  return [LAUNCH_AUTH_HEADER, ...scope, `creator: ${a.creator}`, `symbol: ${a.symbol}`, `nonce: ${a.nonce}`, `issuedAt: ${a.issuedAt}`].join("\n");
}

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const DOMAIN = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

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

/**
 * Single-use nonces (L-3), per route scope, in memory (one API instance; a restart forgets them, which only re-opens
 * the ≤ 10 min window of messages signed before it). Bounded: expired entries are dropped first; when every slot is
 * still live the store refuses new nonces (503) rather than forget a used one.
 */
export class NonceStore {
  private used = new Map<string, number>();
  constructor(private max = 200_000) {}
  get size() {
    return this.used.size;
  }
  private key(scope: string, creator: string, nonce: string) {
    return `${scope}|${creator}|${nonce}`;
  }
  /** Marks `scope`/`creator`/`nonce` used until `expiresAt` (ms). False if it already is. Throws (503) when full. */
  consume(scope: string, creator: string, nonce: string, expiresAt: number, now = Date.now()): boolean {
    const k = this.key(scope, creator, nonce);
    const at = this.used.get(k);
    if (at !== undefined && at > now) return false;
    if (this.used.size >= this.max) {
      for (const [key, exp] of this.used) if (exp <= now) this.used.delete(key);
      if (this.used.size >= this.max) throw Object.assign(new Error("too many launch signatures in flight, try again in a minute"), { statusCode: 503 });
    }
    this.used.set(k, expiresAt);
    return true;
  }
  /** Gives a nonce back (the request failed before it reserved or stored anything). */
  release(scope: string, creator: string, nonce: string) {
    this.used.delete(this.key(scope, creator, nonce));
  }
}

export interface LaunchAuthPolicy {
  maxAgeSecs: number;
  now?: number;
  /** Accepted `domain:` values (lower-case hosts); null/undefined = any well-formed host. */
  domains?: string[] | null;
  /** Required `cluster:` value; undefined = not checked. */
  cluster?: string;
  /** Accept the legacy five-line form (default true). */
  allowLegacy?: boolean;
}

export type LaunchAuthResult = { ok: true; fields: LaunchAuthFields; legacy: boolean; expiresAt: number } | { ok: false; error: string };

/** Parses and verifies `auth` (see the header comment). Single use is the caller's (`NonceStore`, `expiresAt`). */
export function verifyLaunchAuth(auth: unknown, expect: { creator: PublicKey; symbol: string }, opts: LaunchAuthPolicy): LaunchAuthResult {
  const fail = (error: string): LaunchAuthResult => ({ ok: false, error });
  if (!auth || typeof auth !== "object") return fail("auth required: sign the launch message with the creator wallet");
  const { message, signature } = auth as { message?: unknown; signature?: unknown };
  if (typeof message !== "string" || message.length > 512 || typeof signature !== "string") return fail("invalid auth");
  const lines = message.split("\n");
  if ((lines.length !== 5 && lines.length !== 7) || lines[0] !== LAUNCH_AUTH_HEADER) return fail("invalid auth message");
  const legacy = lines.length === 5;
  if (legacy && opts.allowLegacy === false) return fail("outdated launch message: reload the page and sign again");
  const field = (i: number, k: string) => (lines[i].startsWith(`${k}: `) ? lines[i].slice(k.length + 2) : null);
  const o = legacy ? 0 : 2;
  let domain: string | undefined;
  let cluster: string | undefined;
  if (!legacy) {
    const d = field(1, "domain");
    const c = field(2, "cluster");
    if (d === null || c === null || !DOMAIN.test(d)) return fail("invalid auth message");
    if (opts.domains && !opts.domains.includes(d)) return fail("auth message is for another site");
    if (opts.cluster !== undefined && c !== opts.cluster) return fail("auth message is for another cluster");
    domain = d;
    cluster = c;
  }
  const creator = field(1 + o, "creator");
  const symbol = field(2 + o, "symbol");
  const nonce = field(3 + o, "nonce");
  const issuedAtRaw = field(4 + o, "issuedAt");
  if (creator === null || creator !== expect.creator.toBase58()) return fail("auth message is for another wallet");
  if (symbol === null || symbol !== expect.symbol) return fail("auth message is for another symbol");
  if (!nonce || !NONCE.test(nonce)) return fail("invalid auth nonce");
  const issuedAt = Number(issuedAtRaw);
  const now = opts.now ?? Date.now();
  if (issuedAtRaw === null || !/^\d{1,16}$/.test(issuedAtRaw) || !Number.isSafeInteger(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > opts.maxAgeSecs * 1000)
    return fail("auth message expired, sign again");
  const sig = decodeSig(signature);
  if (!sig) return fail("invalid auth signature");
  const key = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, expect.creator.toBuffer()]), format: "der", type: "spki" });
  let ok = false;
  try {
    ok = verify(null, Buffer.from(message, "utf8"), key, sig);
  } catch {
    ok = false;
  }
  if (!ok) return fail("auth signature does not match the creator wallet");
  return { ok: true, fields: { creator, symbol, nonce, issuedAt, ...(legacy ? {} : { domain, cluster }) }, legacy, expiresAt: issuedAt + opts.maxAgeSecs * 1000 + 60_000 };
}

/** null = valid; otherwise the reason (401 message). Signature + content only; single use is the caller's. */
export function launchAuthError(auth: unknown, expect: { creator: PublicKey; symbol: string }, opts: LaunchAuthPolicy): string | null {
  const r = verifyLaunchAuth(auth, expect, opts);
  return r.ok ? null : r.error;
}

/** The route-side check: verify, then take the nonce for `scope`. Returns a release function, or the 401 reason. */
export function checkLaunchAuth(
  nonces: NonceStore,
  scope: "metadata" | "prepare",
  auth: unknown,
  expect: { creator: PublicKey; symbol: string },
  opts: LaunchAuthPolicy,
): { ok: true; release: () => void } | { ok: false; error: string } {
  const r = verifyLaunchAuth(auth, expect, opts);
  if (!r.ok) return r;
  if (!nonces.consume(scope, r.fields.creator, r.fields.nonce, r.expiresAt, opts.now)) return { ok: false, error: "auth message already used, sign again" };
  return { ok: true, release: () => nonces.release(scope, r.fields.creator, r.fields.nonce) };
}

/** Node-side signer for the launch message (tests, scripts; wallets use `signMessage`). `domain` + `cluster` = the L-3 form. */
export function signLaunchAuth(
  secretKey: Uint8Array,
  a: { creator: string; symbol: string; nonce?: string; issuedAt?: number; domain?: string; cluster?: string },
): { message: string; signature: string } {
  const message = launchAuthMessage({ creator: a.creator, symbol: a.symbol, nonce: a.nonce ?? randomBytes(12).toString("hex"), issuedAt: a.issuedAt ?? Date.now(), domain: a.domain, cluster: a.cluster });
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(secretKey.subarray(0, 32))]), format: "der", type: "pkcs8" });
  return { message, signature: bs58.encode(sign(null, Buffer.from(message, "utf8"), key)) };
}
