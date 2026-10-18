/**
 * Coin image proxy (V7-L6, security-review/REPORT-v0.7.md): `GET /v1/img/:mint`.
 *
 * Coin images are creator-supplied URLs (`metadata.image`). Rendering them directly forced the app's CSP to
 * allow `img-src https:`, i.e. any host, which an injected script could use to exfiltrate data through image
 * URLs. The app now loads every coin image from here, so its CSP allows only its own origin and this API.
 *
 * - The only URL ever fetched is the image of a coin we indexed (looked up by mint); callers can't name a URL.
 * - Fetched with the indexer's SSRF-safe fetcher (https / ipfs:// / ar:// only, every resolved address public,
 *   connection pinned to the checked address, redirects re-checked per hop, deadline + size cap).
 * - The bytes must BE an image: magic bytes for PNG / JPEG / GIF / WebP. SVG (scriptable), HTML, anything
 *   else is refused. The upstream Content-Type is ignored; ours comes from the sniffed format.
 * - Served with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`,
 *   CORP cross-origin (the app is another origin) and long cache headers.
 * - Bounded in-memory LRU (entries + bytes) for hits, short negative cache for misses/failures, request
 *   coalescing per URL, a cap on concurrent upstream fetches, and (audit L-7) a per-host cap inside it: a creator's
 *   slow host (grouped by its last two DNS labels, so subdomains don't multiply it) holds at most `maxPerHost`
 *   slots, so it can't make every other coin's image `busy`. Our IPFS gateways (`trustedHosts`, ipfs://) share half
 *   of the global cap instead.
 */
import { createHash } from "node:crypto";

import { safeFetch, SafeFetchError, type SafeFetchOptions } from "@fumpad/indexer";

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The raster format of `b` by its magic bytes, or null (SVG, HTML, text, truncated, unknown). */
export function sniffImage(b: Uint8Array): ImageType | null {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) && b.length > 24) return "image/png";
  if (startsWith(b, [0xff, 0xd8, 0xff]) && b.length > 4) return "image/jpeg";
  if ((startsWith(b, ascii("GIF87a")) || startsWith(b, ascii("GIF89a"))) && b.length > 13) return "image/gif";
  if (startsWith(b, ascii("RIFF")) && startsWith(b, ascii("WEBP"), 8) && b.length > 16) return "image/webp";
  return null;
}

export type ImageFailure = "no_image" | "blocked" | "upstream" | "not_image" | "too_large" | "timeout" | "busy";

export type ImageResult = { ok: true; body: Buffer; type: ImageType; etag: string } | { ok: false; reason: ImageFailure };

export interface ImageProxyOpts {
  maxBytes?: number;
  timeoutMs?: number;
  /** LRU bounds for successful images. */
  cacheEntries?: number;
  cacheBytes?: number;
  /** How long a fetched image is kept (ms). */
  ttlMs?: number;
  /** How long a failure is remembered (ms), so a broken URL isn't refetched on every request. */
  negativeTtlMs?: number;
  /** Concurrent upstream fetches; beyond it requests fail fast with `busy`. */
  maxConcurrent?: number;
  /** Concurrent upstream fetches per creator host group (L-7, default 2). */
  maxPerHost?: number;
  /** Hostnames we run or chose (our Pinata gateway, IPFS gateways): capped at half of `maxConcurrent`, not `maxPerHost`. */
  trustedHosts?: string[];
  ipfsGateway?: string;
  /** IPFS gateways tried in order (dedicated Pinata gateway first), see safeFetch. */
  ipfsGateways?: string[];
  /** Tests only (forwarded to safeFetch). */
  fetchOpts?: Pick<SafeFetchOptions, "allowHttp" | "isAllowedAddress">;
}

type Entry = { at: number; result: ImageResult; size: number };

/**
 * The concurrency group of an image URL (L-7): "ipfs:" / "ar:" for those schemes, the exact hostname for a trusted
 * host, else the last two DNS labels (an IP literal as is).
 */
export function imageHostGroup(url: string, trusted: ReadonlySet<string> = new Set()): { key: string; trusted: boolean } {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme === "ipfs") return { key: "ipfs:", trusted: true };
  if (scheme === "ar") return { key: "ar:", trusted: false };
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return { key: "invalid:", trusted: false };
  }
  if (trusted.has(host)) return { key: host, trusted: true };
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return { key: host, trusted: false };
  return { key: host.split(".").slice(-2).join("."), trusted: false };
}

export class ImageProxy {
  private cache = new Map<string, Entry>();
  private bytes = 0;
  private inflight = new Map<string, Promise<ImageResult>>();
  private active = 0;
  private activeByHost = new Map<string, number>();
  private trusted: Set<string>;
  stats = { hits: 0, misses: 0, fetched: 0, failed: 0, busy: 0, hostBusy: 0 };
  readonly o: Required<Omit<ImageProxyOpts, "fetchOpts" | "ipfsGateway" | "ipfsGateways" | "trustedHosts">> & Pick<ImageProxyOpts, "fetchOpts" | "ipfsGateway" | "ipfsGateways">;

  constructor(
    /** mint → the coin's creator image URL (metadata.image), or null. */
    private lookup: (mint: string) => Promise<string | null | undefined>,
    opts: ImageProxyOpts = {},
  ) {
    this.o = {
      maxBytes: opts.maxBytes ?? 2 * 1024 * 1024,
      timeoutMs: opts.timeoutMs ?? 6_000,
      cacheEntries: opts.cacheEntries ?? 2_000,
      cacheBytes: opts.cacheBytes ?? 64 * 1024 * 1024,
      ttlMs: opts.ttlMs ?? 6 * 3600_000,
      negativeTtlMs: opts.negativeTtlMs ?? 5 * 60_000,
      maxConcurrent: opts.maxConcurrent ?? 16,
      maxPerHost: opts.maxPerHost ?? 2,
      ipfsGateway: opts.ipfsGateway,
      ipfsGateways: opts.ipfsGateways,
      fetchOpts: opts.fetchOpts,
    };
    const hostOf = (u: string) => {
      try {
        return new URL(u).hostname.toLowerCase();
      } catch {
        return null;
      }
    };
    this.trusted = new Set([...(opts.trustedHosts ?? []), ...(opts.ipfsGateways ?? []), ...(opts.ipfsGateway ? [opts.ipfsGateway] : [])].map((h) => (h.includes("/") ? hostOf(h) : h.toLowerCase())).filter((h): h is string => !!h));
  }

  get size() {
    return { entries: this.cache.size, bytes: this.bytes };
  }

  async get(mint: string): Promise<ImageResult> {
    const url = (await this.lookup(mint))?.trim();
    if (!url) return { ok: false, reason: "no_image" };
    const hit = this.cache.get(url);
    if (hit && Date.now() - hit.at < (hit.result.ok ? this.o.ttlMs : this.o.negativeTtlMs)) {
      // LRU: move to the back.
      this.cache.delete(url);
      this.cache.set(url, hit);
      this.stats.hits++;
      return hit.result;
    }
    if (hit) this.drop(url);
    this.stats.misses++;
    let p = this.inflight.get(url);
    if (!p) {
      const g = imageHostGroup(url, this.trusted);
      const hostCap = g.trusted ? Math.max(1, Math.floor(this.o.maxConcurrent / 2)) : this.o.maxPerHost;
      const onHost = this.activeByHost.get(g.key) ?? 0;
      if (this.active >= this.o.maxConcurrent || onHost >= hostCap) {
        this.stats.busy++;
        if (onHost >= hostCap) this.stats.hostBusy++;
        return { ok: false, reason: "busy" }; // not cached: a retry may succeed
      }
      this.active++;
      this.activeByHost.set(g.key, onHost + 1);
      p = this.fetch(url).finally(() => {
        this.active--;
        const left = (this.activeByHost.get(g.key) ?? 1) - 1;
        if (left > 0) this.activeByHost.set(g.key, left);
        else this.activeByHost.delete(g.key);
        this.inflight.delete(url);
      });
      this.inflight.set(url, p);
    }
    return p;
  }

  private async fetch(url: string): Promise<ImageResult> {
    let result: ImageResult;
    try {
      const r = await safeFetch(url, { maxBytes: this.o.maxBytes, timeoutMs: this.o.timeoutMs, maxRedirects: 3, ipfsGateway: this.o.ipfsGateway, ipfsGateways: this.o.ipfsGateways, accept: "image/png,image/jpeg,image/gif,image/webp", ...this.o.fetchOpts });
      if (r.status !== 200) result = { ok: false, reason: "upstream" };
      else {
        const type = sniffImage(r.body);
        result = type ? { ok: true, body: r.body, type, etag: `"${createHash("sha256").update(r.body).digest("base64url").slice(0, 27)}"` } : { ok: false, reason: "not_image" };
      }
    } catch (e) {
      const code = e instanceof SafeFetchError ? e.code : "network";
      result = { ok: false, reason: code === "blocked" || code === "scheme" ? "blocked" : code === "too_large" ? "too_large" : code === "timeout" ? "timeout" : "upstream" };
    }
    if (result.ok) this.stats.fetched++;
    else this.stats.failed++;
    this.put(url, result);
    return result;
  }

  private put(url: string, result: ImageResult) {
    this.drop(url);
    const size = result.ok ? result.body.length : 64;
    if (size > this.o.cacheBytes) return;
    this.cache.set(url, { at: Date.now(), result, size });
    this.bytes += size;
    while (this.cache.size > this.o.cacheEntries || this.bytes > this.o.cacheBytes) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  private drop(url: string) {
    const e = this.cache.get(url);
    if (!e) return;
    this.cache.delete(url);
    this.bytes -= e.size;
  }
}

/** Headers on every proxied image (and on failures): nothing in the response can run or be re-typed. */
export const IMAGE_SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": "default-src 'none'; sandbox",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
};
/** The app's URL carries `?v=<hash of the source URL>`, so a changed image gets a new URL: cache long. */
export const IMAGE_CACHE = "public, max-age=86400, s-maxage=604800, stale-while-revalidate=604800";
export const IMAGE_MISS_CACHE = "public, max-age=300";
