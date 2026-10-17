/**
 * The coin's metadata upload (services `POST /v1/launch/metadata`): before the launch is prepared, the API pins the
 * image and a metadata JSON (name, ticker, description, links) to IPFS and returns the `uri` the launch carries.
 * Pinning happens server-side: the Pinata key never reaches the browser, and the browser never loads an IPFS
 * gateway (our own pages show coin images through the API's `/v1/img/:mint` proxy).
 *
 * The request carries the same signed ownership message as prepare (M-2, `./launchAuth`), so one wallet signature
 * covers both calls. Uploads are cached per form content: reopening the review (or re-preparing after the
 * blockhash expired) never pins the same coin twice; changing anything uploads again.
 *
 * No React, no `@/` imports: unit-tested by `metadata.test.ts` with `npm test`.
 */
import type { PublicKey } from "@solana/web3.js";
import { dropLaunchAuth, getLaunchAuth, type LaunchAuth } from "./launchAuth";
import { type FumpadSigner, signLaunchMessage } from "./signer";

/** What the form collected besides name / ticker (all optional). */
export interface LaunchMetadataInput {
  description?: string;
  /** X handle or URL. */
  x?: string;
  telegram?: string;
  website?: string;
  /** The chosen image file (PNG / JPEG / GIF / WebP ≤ 4 MB; the API re-checks it). */
  image?: Blob | null;
}

export interface MetadataResult {
  uri: string;
  image?: string;
  /** The API pinned nothing (devnet without Pinata): the launch carries the placeholder uri. */
  placeholder?: boolean;
}

/** A failed upload (the app offers "Try again"); `status` is the API's HTTP status (0 = network). */
export class MetadataUploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Chunked base64 (a 4 MB image would be slow as one giant string concatenation). */
export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(parts.join(""));
}

export interface MetadataRequest {
  creator: string;
  name: string;
  symbol: string;
  input: LaunchMetadataInput;
  /** The launch includes a first buy (the API picks the uri form that still fits the launch transaction). */
  firstBuy: boolean;
  launchConfig?: "first_coin";
}

/** The JSON body (image as base64). Empty optional fields are left out. */
export async function metadataBody(r: MetadataRequest, auth: LaunchAuth): Promise<Record<string, unknown>> {
  const t = (s: string | undefined) => (s && s.trim() ? s.trim() : undefined);
  const img = r.input.image ? bytesToBase64(new Uint8Array(await r.input.image.arrayBuffer())) : undefined;
  const body: Record<string, unknown> = {
    creator: r.creator,
    name: r.name,
    symbol: r.symbol,
    description: t(r.input.description),
    twitter: t(r.input.x),
    telegram: t(r.input.telegram),
    website: t(r.input.website),
    image: img,
    firstBuy: r.firstBuy,
    ...(r.launchConfig ? { launchConfig: r.launchConfig } : {}),
    auth,
  };
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

export async function postMetadata(api: string, body: Record<string, unknown>, f: typeof fetch = fetch): Promise<MetadataResult> {
  let res: Response;
  try {
    res = await f(`${api}/v1/launch/metadata`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  } catch {
    throw new MetadataUploadError(0, "Couldn't reach FUMPAD to store the coin's image and details. Check your connection and try again.");
  }
  if (!res.ok) {
    let msg =
      res.status === 413
        ? "That image is too large. The limit is 4 MB."
        : res.status >= 500
          ? "Couldn't store the coin's image and details right now. Nothing was charged. Try again."
          : "Couldn't store the coin's image and details.";
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string; code?: string };
      if (j.error && res.status < 500 && res.status !== 413) msg = j.error.charAt(0).toUpperCase() + j.error.slice(1) + (/[.!?]$/.test(j.error) ? "" : ".");
      if (typeof j.code === "string") code = j.code;
    } catch {
      /* not json */
    }
    throw new MetadataUploadError(res.status, msg, code);
  }
  const j = (await res.json()) as MetadataResult;
  if (typeof j?.uri !== "string" || !/^(https:\/\/|ipfs:\/\/)/.test(j.uri) || j.uri.length > 200) throw new MetadataUploadError(502, "FUMPAD returned an unexpected metadata address. Try again.");
  return j;
}

/* ── Cache: one upload per exact form content (creator, fields, image bytes identity, first buy, config) ── */

const uploads = new Map<string, MetadataResult>();
const blobIds = new WeakMap<Blob, number>();
let nextBlobId = 1;
const blobId = (b: Blob) => {
  let id = blobIds.get(b);
  if (!id) blobIds.set(b, (id = nextBlobId++));
  return id;
};

export function metadataCacheKey(r: MetadataRequest): string {
  const i = r.input;
  return JSON.stringify([r.creator, r.name, r.symbol, i.description?.trim() ?? "", i.x?.trim() ?? "", i.telegram?.trim() ?? "", i.website?.trim() ?? "", i.image ? blobId(i.image) : 0, r.firstBuy, r.launchConfig ?? ""]);
}

/** Tests only. */
export function clearMetadataCache() {
  uploads.clear();
}

/**
 * Sign (or reuse) the launch ownership message, then upload; a cached auth the API refuses (401) is dropped and
 * signed again, once. Cached per form content. `onStep("auth")` before signing, `onStep("upload")` before the POST.
 */
export async function uploadLaunchMetadata(
  api: string,
  s: FumpadSigner,
  r: Omit<MetadataRequest, "creator">,
  instant: boolean,
  onStep: (step: "auth" | "upload") => void = () => {},
  f: typeof fetch = fetch,
): Promise<MetadataResult> {
  const req: MetadataRequest = { ...r, creator: s.publicKey.toBase58() };
  const key = metadataCacheKey(req);
  const hit = uploads.get(key);
  if (hit) return hit;
  for (let attempt = 0; ; attempt++) {
    onStep("auth");
    let auth: LaunchAuth;
    let fresh: boolean;
    try {
      ({ auth, fresh } = await getLaunchAuth(s.publicKey as PublicKey, r.symbol, (m) => signLaunchMessage(s, m, instant)));
    } catch (e) {
      if (/reject|denied|declin|cancel|closed/i.test(e instanceof Error ? e.message : String(e ?? ""))) throw new Error("You didn't confirm in your wallet, so nothing was reserved.");
      throw e;
    }
    onStep("upload");
    try {
      const out = await postMetadata(api, await metadataBody(req, auth), f);
      uploads.set(key, out);
      return out;
    } catch (e) {
      if (e instanceof MetadataUploadError && e.status === 401) {
        dropLaunchAuth(req.creator, r.symbol);
        if (!fresh && attempt === 0) continue;
      }
      throw e;
    }
  }
}
