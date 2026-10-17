/**
 * SSRF-safe fetch for user-controlled URLs (coin metadata `uri`, M-3).
 *
 * - Schemes: https, plus ipfs:// (→ IPFS gateway) and ar:// (→ arweave.net). Plain http only
 *   when a test opts in. Default port only (443), no credentials in the URL.
 * - Every hostname is resolved and EVERY resolved address must be public (no loopback,
 *   private, CGNAT, link-local / cloud metadata, multicast, reserved, documentation, NAT64 or
 *   IPv4-mapped forms of those). The connection is pinned to the validated address (custom
 *   `lookup`), so DNS rebinding between check and connect is impossible.
 * - Redirects are followed manually (max 3), each hop re-checked the same way.
 * - Whole-request deadline and a response size cap (aborts the socket past the cap).
 * - IPFS content (`ipfs://<cid>` or an https gateway URL `https://<host>/ipfs/<cid>`) can be tried through an
 *   ordered list of gateways (`ipfsGateways`: our dedicated Pinata gateway first, then a public one, then the
 *   original URL), so a coin whose URI names a slow or rate-limited public gateway still resolves. The CID pins
 *   the content, so which gateway serves it doesn't matter; every candidate goes through the same checks.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

export class SafeFetchError extends Error {
  constructor(readonly code: "blocked" | "scheme" | "too_large" | "timeout" | "redirects" | "http" | "network", message: string) {
    super(message);
  }
}

const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT (Railway private network uses this range)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. 169.254.169.254 metadata
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["2001::", 23], // IETF protocol assignments (Teredo etc.)
  ["fc00::", 7], // unique local (Railway private network is fd12::/16)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const)
  blocked.addSubnet(net, bits, "ipv6");

/** Embedded IPv4 of ::ffff:a.b.c.d / ::a.b.c.d / 64:ff9b::a.b.c.d (NAT64), if any. */
function embeddedV4(ip: string): string | null {
  const m = /^(?:::ffff:(?:0:)?|::|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  // hex form ::ffff:7f00:1
  const h = /^(?:::ffff:(?:0:)?|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (h) {
    const a = parseInt(h[1], 16);
    const b = parseInt(h[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return null;
}

/** True if `ip` is a globally routable unicast address we may connect to. */
export function isPublicAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return !blocked.check(ip, "ipv4");
  if (fam === 6) {
    const v4 = embeddedV4(ip.toLowerCase());
    if (v4) return isIP(v4) === 4 && !blocked.check(v4, "ipv4");
    if (/^64:ff9b:/i.test(ip)) return false;
    return !blocked.check(ip, "ipv6");
  }
  return false;
}

export interface SafeFetchOptions {
  /** Total deadline across redirects (ms). */
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  ipfsGateway?: string;
  /**
   * Ordered https gateways (e.g. `https://<name>.mypinata.cloud/ipfs/`, then `https://ipfs.io/ipfs/`). When set,
   * IPFS content is fetched through each in turn (then the original https URL) until one answers 200; each try
   * gets the full `timeoutMs`. Unset = only `ipfsGateway` for ipfs:// and the URL as given otherwise.
   */
  ipfsGateways?: string[];
  /** `Accept` header (default application/json: metadata). */
  accept?: string;
  /** Tests only: permit http:// and any port. */
  allowHttp?: boolean;
  /** Tests only: override the address policy. */
  isAllowedAddress?: (ip: string) => boolean;
}

/** Map a metadata URI to the https URL we fetch, or throw for anything not allowed. */
export function resolveMetadataUrl(uri: string, opts: Pick<SafeFetchOptions, "ipfsGateway" | "allowHttp"> = {}): URL {
  const raw = uri.trim();
  let mapped = raw;
  if (/^ipfs:\/\//i.test(raw)) {
    const path = raw.replace(/^ipfs:\/\/(ipfs\/)?/i, "");
    if (!path || path.includes("..")) throw new SafeFetchError("scheme", "invalid ipfs uri");
    mapped = (opts.ipfsGateway ?? "https://ipfs.io/ipfs/").replace(/\/?$/, "/") + path;
  } else if (/^ar:\/\//i.test(raw)) {
    const path = raw.replace(/^ar:\/\//i, "");
    if (!path || path.includes("..")) throw new SafeFetchError("scheme", "invalid ar uri");
    mapped = `https://arweave.net/${path}`;
  }
  let u: URL;
  try {
    u = new URL(mapped);
  } catch {
    throw new SafeFetchError("scheme", "invalid url");
  }
  checkUrlShape(u, opts.allowHttp);
  return u;
}

function checkUrlShape(u: URL, allowHttp?: boolean) {
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new SafeFetchError("scheme", `scheme ${u.protocol} not allowed`);
  if (u.username || u.password) throw new SafeFetchError("scheme", "credentials in url");
  if (u.port && !allowHttp) throw new SafeFetchError("blocked", "non-default port");
}

function pinnedLookup(allowed: (ip: string) => boolean, host: string): Promise<{ address: string; family: 4 | 6 }> {
  const literal = host.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    if (!allowed(literal)) return Promise.reject(new SafeFetchError("blocked", "address not allowed"));
    return Promise.resolve({ address: literal, family: isIP(literal) as 4 | 6 });
  }
  return dnsLookup(literal, { all: true, verbatim: true }).then((addrs) => {
    if (!addrs.length) throw new SafeFetchError("network", "no address");
    // Every record must be public: a mixed answer is a rebinding/split-horizon attempt.
    if (!addrs.every((a) => allowed(a.address))) throw new SafeFetchError("blocked", "address not allowed");
    return { address: addrs[0].address, family: addrs[0].family as 4 | 6 };
  });
}

/** One request to `u` connecting only to the pre-validated address. */
function once(u: URL, address: { address: string; family: 4 | 6 }, deadline: number, maxBytes: number, accept: string): Promise<{ status: number; location?: string; contentType?: string; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lookup: LookupFunction = (_h, o, cb) => {
      if ((o as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [address]);
      else cb(null, address.address, address.family);
    };
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      { method: "GET", lookup, headers: { accept, "user-agent": "fumpad-indexer/1" }, timeout: Math.max(1, deadline - Date.now()) },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, body: Buffer.alloc(0) });
        }
        const len = Number(res.headers["content-length"] ?? 0);
        if (len > maxBytes) {
          req.destroy();
          return reject(new SafeFetchError("too_large", "response too large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            req.destroy();
            reject(new SafeFetchError("too_large", "response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status, contentType: res.headers["content-type"], body: Buffer.concat(chunks) }));
        res.on("error", (e) => reject(new SafeFetchError("network", e.message)));
      },
    );
    req.on("timeout", () => req.destroy(new SafeFetchError("timeout", "timeout")));
    req.on("error", (e) => reject(e instanceof SafeFetchError ? e : new SafeFetchError("network", "request failed")));
    const t = setTimeout(() => req.destroy(new SafeFetchError("timeout", "timeout")), Math.max(1, deadline - Date.now()));
    req.on("close", () => clearTimeout(t));
    req.end();
  });
}

/** A CIDv0 (Qm…, base58) or CIDv1 (base32, b…) as gateways put it in a path. */
const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;

/**
 * `<cid>[/path]` of IPFS content: `ipfs://<cid>[/path]` (also `ipfs://ipfs/<cid>`) or a path-style gateway URL
 * `https://<any host>/ipfs/<cid>[/path]`; null for anything else (query/fragment dropped).
 */
export function ipfsPathOf(uri: string): string | null {
  const raw = uri.trim();
  let path: string;
  if (/^ipfs:\/\//i.test(raw)) path = raw.replace(/^ipfs:\/\/(ipfs\/)?/i, "");
  else {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.protocol !== "https:") return null;
    const m = /^\/ipfs\/(.+)$/.exec(u.pathname);
    if (!m) return null;
    path = m[1];
  }
  path = path.split(/[?#]/)[0];
  const [cid, ...rest] = path.split("/");
  if (!CID.test(cid) || rest.some((p) => p === ".." || p === ".")) return null;
  return [cid, ...rest].join("/");
}

/** The https URLs `safeFetch` tries for `uri`, in order (≤ 3, deduplicated). Throws for a URI it refuses. */
export function fetchCandidates(uri: string, opts: Pick<SafeFetchOptions, "ipfsGateway" | "ipfsGateways" | "allowHttp"> = {}): URL[] {
  const gws = (opts.ipfsGateways ?? []).filter(Boolean);
  const path = gws.length ? ipfsPathOf(uri) : null;
  if (!path) return [resolveMetadataUrl(uri, opts)];
  const out: URL[] = [];
  const add = (s: string) => {
    try {
      const u = resolveMetadataUrl(s, opts);
      if (!out.some((x) => x.href === u.href)) out.push(u);
    } catch {
      /* a malformed gateway entry or a refused original: skip it */
    }
  };
  for (const g of gws) add(g.replace(/\/?$/, "/") + path);
  if (!/^ipfs:/i.test(uri.trim())) add(uri);
  if (!out.length) return [resolveMetadataUrl(uri, opts)];
  return out.slice(0, 3);
}

/**
 * GET a user-supplied URL under the SSRF policy; returns the body (≤ maxBytes). With `ipfsGateways`, IPFS content
 * is tried through each candidate (`fetchCandidates`) until one answers 200; else the last answer / error.
 */
export async function safeFetch(uri: string, opts: SafeFetchOptions = {}): Promise<{ status: number; body: Buffer; url: string; contentType?: string }> {
  let res: { status: number; body: Buffer; url: string; contentType?: string } | undefined;
  let err: unknown;
  for (const u of fetchCandidates(uri, opts)) {
    try {
      const r = await fetchOne(u, opts);
      if (r.status === 200) return r;
      res = r;
    } catch (e) {
      err = e; // the next gateway may still serve it
    }
  }
  if (res) return res;
  throw err;
}

async function fetchOne(start: URL, opts: SafeFetchOptions): Promise<{ status: number; body: Buffer; url: string; contentType?: string }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 5_000);
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const maxRedirects = opts.maxRedirects ?? 3;
  const allowed = opts.isAllowedAddress ?? isPublicAddress;
  let u = start;
  for (let hop = 0; ; hop++) {
    if (Date.now() >= deadline) throw new SafeFetchError("timeout", "timeout");
    const address = await pinnedLookup(allowed, u.hostname);
    const r = await once(u, address, deadline, maxBytes, opts.accept ?? "application/json");
    if (r.status >= 300 && r.status < 400) {
      if (!r.location) throw new SafeFetchError("http", `redirect without location`);
      if (hop >= maxRedirects) throw new SafeFetchError("redirects", "too many redirects");
      let next: URL;
      try {
        next = new URL(r.location, u);
      } catch {
        throw new SafeFetchError("scheme", "invalid redirect");
      }
      checkUrlShape(next, opts.allowHttp);
      u = next;
      continue;
    }
    return { status: r.status, body: r.body, url: u.toString(), contentType: r.contentType };
  }
}
