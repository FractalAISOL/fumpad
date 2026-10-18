/**
 * M-2 / L-3 (services/README.md): proof of wallet control for `POST /v1/launch/metadata` and
 * `POST /v1/launch/prepare`.
 *
 * The creator wallet signs (`signMessage`, ed25519 over the UTF-8 bytes) exactly
 *
 *   FUMPAD launch
 *   domain: <this page's host, e.g. fumpad.app>
 *   cluster: <mainnet | devnet | testnet | localnet, this build's CLUSTER>
 *   creator: <creator base58>
 *   symbol: <symbol as sent>
 *   nonce: <16-64 chars [A-Za-z0-9_-]>
 *   issuedAt: <unix ms>
 *
 * and both bodies carry `auth: { message, signature }`. L-3 (external audit 2026-10-17): the API
 * checks `domain` against its own list (its CORS origins) and `cluster` against its cluster, so a
 * signature made on another site or for devnet can't be replayed, and it accepts each nonce once
 * per route (one signature covers the metadata upload + the prepare of one launch). The app caches
 * one signed message per (creator, symbol) for 10 minutes; when the API answers 401 (e.g. "already
 * used" on a re-prepare after the blockhash expired) the callers drop it and sign again, once.
 *
 * Message signing is the one thing besides FUMPAD transactions the Trading wallet may do
 * without a prompt, and only for this exact text: `vetLaunchAuthMessage` is the message
 * counterpart of the transaction allow-list (`./allowlist`). Anything else (another header,
 * another wallet, an extra line, a stale or future timestamp, a symbol the program would
 * reject) is refused before a wallet sees it.
 *
 * No React, no `@/` imports: unit-tested by `launchAuth.test.ts` with `npm test`.
 */
import type { PublicKey } from "@solana/web3.js";
import { SilentSignRefused, verifySignature } from "./allowlist";
import { CLUSTER } from "./cluster";

export const LAUNCH_AUTH_HEADER = "FUMPAD launch";
/** The API's `LAUNCH_SIGNATURE_MAX_AGE_SECS` default. */
export const LAUNCH_AUTH_MAX_AGE_MS = 10 * 60_000;
/** Stop reusing a cached signature this long before the API would reject it (clock skew, slow prepare). */
export const LAUNCH_AUTH_REUSE_MARGIN_MS = 90_000;
/** The API tolerates `issuedAt` this far ahead of its clock. */
const FUTURE_TOLERANCE_MS = 60_000;

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const CREATOR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ISSUED_AT = /^[1-9][0-9]{0,15}$/;
/** A lower-case host[:port], as `location.host` gives it (the API checks the same shape). */
const DOMAIN = /^[a-z0-9.-]{1,253}(:\d{1,5})?$/;
const CLUSTERS = new Set(["mainnet", "devnet", "testnet", "localnet"]);

/**
 * The host this page runs on (`location.host`), lower-case. Outside a browser (unit tests, scripts) "localhost":
 * a message for it only works against an API that lists localhost (local stacks).
 */
export function launchAuthDomain(): string {
  const loc = (globalThis as { location?: { host?: string } }).location;
  return (loc?.host || "localhost").toLowerCase();
}

export interface LaunchAuthFields {
  /** The site that asked for the signature (L-3). */
  domain: string;
  /** The cluster the launch is for (L-3). */
  cluster: string;
  creator: string;
  symbol: string;
  nonce: string;
  issuedAt: number;
}

export interface LaunchAuth {
  message: string;
  /** base64 (the API accepts base58 or base64). */
  signature: string;
}

export function launchAuthMessage(a: LaunchAuthFields): string {
  return [LAUNCH_AUTH_HEADER, `domain: ${a.domain}`, `cluster: ${a.cluster}`, `creator: ${a.creator}`, `symbol: ${a.symbol}`, `nonce: ${a.nonce}`, `issuedAt: ${a.issuedAt}`].join("\n");
}

/** 32 base64url chars from the platform CSPRNG. */
export function newNonce(): string {
  const b = new Uint8Array(24);
  globalThis.crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The symbol rules `create_coin` enforces (≤ 10 UTF-8 bytes, non-empty), plus printable ASCII only. */
function symbolOk(s: string): boolean {
  return s.length > 0 && new TextEncoder().encode(s).length <= 10 && /^[\x21-\x7e]+$/.test(s);
}

/** Strict parse: exactly the seven canonical lines, or null. */
export function parseLaunchAuthMessage(message: string): LaunchAuthFields | null {
  const lines = message.split("\n");
  if (lines.length !== 7 || lines[0] !== LAUNCH_AUTH_HEADER) return null;
  const field = (i: number, k: string) => (lines[i].startsWith(`${k}: `) ? lines[i].slice(k.length + 2) : null);
  const domain = field(1, "domain");
  const cluster = field(2, "cluster");
  const creator = field(3, "creator");
  const symbol = field(4, "symbol");
  const nonce = field(5, "nonce");
  const issuedAtRaw = field(6, "issuedAt");
  if (domain === null || !DOMAIN.test(domain)) return null;
  if (cluster === null || !CLUSTERS.has(cluster)) return null;
  if (creator === null || !CREATOR.test(creator)) return null;
  if (symbol === null || !symbolOk(symbol)) return null;
  if (nonce === null || !NONCE.test(nonce)) return null;
  if (issuedAtRaw === null || !ISSUED_AT.test(issuedAtRaw)) return null;
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isSafeInteger(issuedAt)) return null;
  const fields = { domain, cluster, creator, symbol, nonce, issuedAt };
  // Canonical form only: re-serializing gives back the same text, byte for byte.
  return launchAuthMessage(fields) === message ? fields : null;
}

/**
 * The message allow-list. Throws `SilentSignRefused` unless `message` (text or the UTF-8
 * bytes about to be signed) is a fresh FUMPAD launch message for `wallet` (and for `symbol`,
 * when given), for this site (`domain`, default this page's host when there is a page) and
 * this build's cluster (`cluster`, default CLUSTER). Returns the parsed fields.
 */
export function vetLaunchAuthMessage(
  message: string | Uint8Array,
  wallet: PublicKey | string,
  opts: { symbol?: string; now?: number; domain?: string; cluster?: string } = {},
): LaunchAuthFields {
  let text: string;
  if (typeof message === "string") text = message;
  else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(message);
    } catch {
      throw new SilentSignRefused("the message isn't text");
    }
  }
  if (text.length > 512) throw new SilentSignRefused("the message is too long");
  const f = parseLaunchAuthMessage(text);
  if (!f) throw new SilentSignRefused("it isn't a FUMPAD launch message");
  const w = typeof wallet === "string" ? wallet : wallet.toBase58();
  if (f.creator !== w) throw new SilentSignRefused("the launch message is for another wallet");
  if (opts.symbol !== undefined && f.symbol !== opts.symbol) throw new SilentSignRefused("the launch message is for another ticker");
  if (f.domain !== (opts.domain ?? launchAuthDomain())) throw new SilentSignRefused("the launch message is for another site");
  if (f.cluster !== (opts.cluster ?? CLUSTER)) throw new SilentSignRefused("the launch message is for another network");
  const now = opts.now ?? Date.now();
  if (f.issuedAt > now + FUTURE_TOLERANCE_MS || now - f.issuedAt > LAUNCH_AUTH_MAX_AGE_MS) throw new SilentSignRefused("the launch message is out of date");
  return f;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/* ── Cache: one signed message per (creator, symbol) while the API still accepts it ── */

const cache = new Map<string, { auth: LaunchAuth; issuedAt: number }>();
const key = (creator: string, symbol: string) => `${creator}\n${symbol}`;

/** A cached auth that the API will still accept for a while, else null (expired ones are dropped). */
export function cachedLaunchAuth(creator: string, symbol: string, now = Date.now()): LaunchAuth | null {
  const k = key(creator, symbol);
  const hit = cache.get(k);
  if (!hit) return null;
  if (now - hit.issuedAt > LAUNCH_AUTH_MAX_AGE_MS - LAUNCH_AUTH_REUSE_MARGIN_MS || hit.issuedAt > now + FUTURE_TOLERANCE_MS) {
    cache.delete(k);
    return null;
  }
  return hit.auth;
}

/** Forget a cached auth (the API refused it). */
export function dropLaunchAuth(creator: string, symbol: string): void {
  cache.delete(key(creator, symbol));
}

/**
 * The auth for a prepare: the cached one, or a new message signed by `sign` (which gets the
 * exact UTF-8 bytes). The returned signature is checked against the creator key before it is
 * cached or sent, so a wallet that signs something else (a prefixed or rewritten message)
 * fails here with a clear error instead of a 401.
 */
export async function getLaunchAuth(
  creator: PublicKey,
  symbol: string,
  sign: (message: Uint8Array) => Promise<Uint8Array>,
  opts: { now?: () => number; nonce?: string; domain?: string; cluster?: string } = {},
): Promise<{ auth: LaunchAuth; fresh: boolean }> {
  const now = opts.now ?? Date.now;
  const c = creator.toBase58();
  const hit = cachedLaunchAuth(c, symbol, now());
  if (hit) return { auth: hit, fresh: false };
  const issuedAt = now();
  const domain = opts.domain ?? launchAuthDomain();
  const cluster = opts.cluster ?? CLUSTER;
  const message = launchAuthMessage({ domain, cluster, creator: c, symbol, nonce: opts.nonce ?? newNonce(), issuedAt });
  vetLaunchAuthMessage(message, c, { symbol, now: issuedAt, domain, cluster });
  const bytes = new TextEncoder().encode(message);
  const sig = await sign(bytes);
  if (!verifySignature(sig, bytes, creator)) throw new Error("Your wallet's signature doesn't match the launch message. Try again, or use another wallet.");
  const auth = { message, signature: toBase64(sig) };
  cache.set(key(c, symbol), { auth, issuedAt });
  return { auth, fresh: true };
}
