/**
 * APP-7: creator-supplied social links, sanitised in the browser before they become an `href` (the API sanitises
 * too; this doesn't rely on it). Only `https:` URLs, never with credentials, and for X / Telegram only those sites'
 * own hosts. Rendered with `target="_blank" rel="noopener noreferrer nofollow"`.
 * No React, no `@/` imports: unit-tested by `socialLinks.test.ts` with `npm test`.
 */

export type SocialKind = "x" | "telegram" | "website";

/** The hosts each kind may point at (exact match, lowercase). */
export const SOCIAL_HOSTS: Record<Exclude<SocialKind, "website">, readonly string[]> = {
  x: ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"],
  telegram: ["t.me", "www.t.me", "telegram.me", "www.telegram.me"],
};

/** Link attributes for every creator link: a new tab that can't reach back to us, no referrer, no SEO credit. */
export const EXTERNAL_LINK_REL = "noopener noreferrer nofollow";

/** A safe `href` for a creator-supplied link of `kind`, or null when it isn't one. */
export function safeSocialHref(kind: SocialKind, raw: string | undefined | null): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  // Bound the input, and refuse control characters and whitespace inside the URL outright.
  if (!s || s.length > 512 || /[\u0000- \u007f-\u009f]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!host || !host.includes(".") || host.endsWith(".")) return null;
  if (kind !== "website" && !SOCIAL_HOSTS[kind].includes(host)) return null;
  return u.href;
}
