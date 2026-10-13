/**
 * V7-L6 (security-review/REPORT-v0.7.md): the page never loads a creator's image host directly. Every coin
 * image goes through our API's image proxy, `GET <API>/v1/img/<mint>` (fetched server-side with the SSRF-safe
 * fetcher, PNG / JPEG / GIF / WebP only, re-served with strict headers), so the CSP's `img-src` lists only
 * our own origin and the API (`src/security/headers.ts`) instead of every https host. `coinImageSrc` builds
 * that URL; with no API configured (mock mode) coins show their monogram.
 *
 * L-1 (security-review/REPORT.md): coin images are creator-supplied (`imageUrl` from the coin's
 * metadata JSON). Only https, IPFS and Arweave are rendered; IPFS/Arweave go through a public
 * HTTPS gateway. Anything else (http:, javascript:, data:, file:, relative paths, credentials in
 * the URL) renders the monogram instead. `blob:` is allowed only for the launch form's local
 * preview (created by this page). Images load with `referrerpolicy="no-referrer"`, so the host
 * never learns which page or coin the viewer had open. Pure: tested by `image.test.ts`.
 */

const IPFS_GATEWAY = (process.env.NEXT_PUBLIC_IPFS_GATEWAY || "https://ipfs.io").replace(/\/+$/, "");
const ARWEAVE_GATEWAY = "https://arweave.net";
const MAX_LEN = 2048;

export function safeImageSrc(url: string | null | undefined, opts: { allowBlob?: boolean } = {}): string | undefined {
  if (!url || typeof url !== "string" || url.length > MAX_LEN) return undefined;
  const u = url.trim();
  if (/[\s<>"'`\\]/.test(u)) return undefined;
  if (opts.allowBlob && u.startsWith("blob:")) return u;
  const ipfs = /^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]+)(\/[A-Za-z0-9._~\-/%]*)?$/.exec(u);
  if (ipfs) return `${IPFS_GATEWAY}/ipfs/${ipfs[1]}${ipfs[2] ?? ""}`;
  const ar = /^ar:\/\/([A-Za-z0-9_-]{43})(\/[A-Za-z0-9._~\-/%]*)?$/.exec(u);
  if (ar) return `${ARWEAVE_GATEWAY}/${ar[1]}${ar[2] ?? ""}`;
  try {
    const p = new URL(u);
    if (p.protocol !== "https:" || p.username || p.password || !p.hostname.includes(".")) return undefined;
    return p.href;
  } catch {
    return undefined;
  }
}

const API = (process.env.NEXT_PUBLIC_FUMPAD_API || "").replace(/\/+$/, "");
const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** FNV-1a (32-bit) of the source URL, base36: the proxy URL changes when the coin's image does. */
function urlVersion(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The proxied URL of a coin's image: `<API>/v1/img/<mint>?v=<hash>`, or undefined (monogram) when the coin has
 * no usable image (same rules as `safeImageSrc`), the mint isn't base58, or no API is configured.
 */
export function coinImageSrc(mint: string | null | undefined, imageUrl: string | null | undefined, api: string = API): string | undefined {
  if (!api || !mint || !MINT.test(mint) || !safeImageSrc(imageUrl)) return undefined;
  return `${api.replace(/\/+$/, "")}/v1/img/${mint}?v=${urlVersion(String(imageUrl).trim())}`;
}
