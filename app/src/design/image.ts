/**
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
