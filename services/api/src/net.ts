/**
 * Client identity at the edge (H-2).
 *
 * Client IP: Fastify's `trustProxy` as a function of (address, hop index). Hop 0 is the TCP
 * peer, hop 1 the rightmost X-Forwarded-For entry, and so on; `req.ip` is the first
 * untrusted address walking right-to-left. We trust exactly `hops` hops (Railway = 2: its
 * edge replaces any client-sent X-Forwarded-For and forwards "<client>, <edge>", verified
 * live) plus optional CIDRs for extra private hops. Anything a client prepends to
 * X-Forwarded-For sits LEFT of the trusted hops and is never used. Contrast `trustProxy: true`,
 * which took the leftmost (client-controlled) entry.
 *
 * SSR: the app's server-side renderer authenticates with a shared secret header instead of an
 * egress-IP allow-list (RATE_LIMIT_ALLOW is gone).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";

export const SSR_HEADER = "x-fumpad-ssr";

export function clientIpTrust(hops: number, cidrs: string[] = []): (address: string, hop: number) => boolean {
  const list = new BlockList();
  for (const c of cidrs) {
    const [net, bits] = c.split("/");
    const fam = isIP(net);
    if (!fam || bits === undefined) throw new Error(`invalid TRUST_PROXY_CIDRS entry ${c}`);
    list.addSubnet(net, Number(bits), fam === 6 ? "ipv6" : "ipv4");
  }
  return (address, hop) => {
    if (hop < hops) return true;
    if (!cidrs.length) return false;
    const a = address.replace(/^::ffff:/, "");
    const fam = isIP(a);
    return fam ? list.check(a, fam === 6 ? "ipv6" : "ipv4") : false;
  };
}

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** Constant-time check of the SSR secret header. False when no secret is configured. */
export function ssrAuthorized(header: string | string[] | undefined, secret: string | undefined): boolean {
  if (!secret || typeof header !== "string" || !header) return false;
  return timingSafeEqual(digest(header), digest(secret));
}
