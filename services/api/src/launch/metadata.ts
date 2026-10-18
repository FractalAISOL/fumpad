/**
 * `POST /v1/launch/metadata`: the coin's off-chain metadata, pinned to IPFS (Pinata) server-side, so the Pinata
 * key never reaches a browser. The app calls it right before `POST /v1/launch/prepare` and launches with the
 * returned `uri`.
 *
 * Body (JSON, ≤ 6 MiB): `{ creator, name, symbol, description?, website?, twitter?, telegram?, image?, auth,
 * launchConfig?, firstBuy? }`. `image` is base64 (or a `data:image/…;base64,` URL) of a PNG / JPEG / GIF / WebP ≤ 4 MB: sniffed,
 * dimension-checked, EXIF/text metadata stripped (`./image.ts`). `auth` is the same signed creator message as
 * prepare (M-2: one wallet signature covers both calls). Limits: per IP (route), per wallet (minute + hour),
 * funded wallets only, same LAUNCHES_OPEN / first-coin gate as prepare: nobody gets free IPFS hosting from us.
 *
 * Response: `{ uri, image?, placeholder? }`. `uri` is `https://<our Pinata gateway>/ipfs/<CIDv0 of the JSON>` when the launch
 * transaction has room for it, else the shorter `ipfs://<CIDv0>` (`metadataUriFor`: the launch tx must fit 1,232
 * bytes). Through the launch lookup table (LAUNCH_ALT, every cluster but localnet) the https form always fits: a
 * max-length name (32) + ticker (10) + https uri + first buy + launch co-signature + priority fee leave ~129 bytes.
 * Inline (localnet without LAUNCH_ALT) name + ticker + uri get ~77 bytes with a first buy, so https rarely fits there.
 * Name + ticker too long for even `ipfs://` → 400 before anything is pinned. Without PINATA_JWT: devnet/localnet answer the old placeholder
 * (`ipfs://pending`, `placeholder: true`, logged); mainnet answers 503 (and the API logs it at boot).
 *
 * The JSON is pump.fun's shape (what Axiom, Jupiter, Phantom, Dexscreener, Birdeye already parse for Meteora DBC /
 * pump coins) plus the Metaplex fields: see `buildTokenMetadata`.
 */
import { AddressLookupTableAccount, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

import { LAUNCH_TX_MAX_BYTES, launchAltAddresses, launchInstructions, launchMetadataError } from "@fumpad/sdk";

import type { ApiConfig } from "../config.js";
import { launchAltInUse } from "./alt.js";
import { launchAuthError } from "./auth.js";
import { checkLaunchImage, type CheckedImage, ImageCheckError, LAUNCH_IMAGE_MAX_BYTES } from "./image.js";
import { LaunchError, withTimeout } from "./pool.js";
import { assertLaunchAllowed, type LaunchConfigKind, PLACEHOLDER_URI, WindowLimiter } from "./routes.js";

/**
 * The gateway the on-chain `uri` (and the JSON's `image`) point at: our dedicated Pinata gateway (user decision
 * 2026-10-18, option B). https, not `ipfs://`: Phantom, Solflare, Jupiter, Dexscreener and most indexers fetch https
 * URIs directly while `ipfs://` support is uneven. Not ipfs.io: that public gateway was retired on 2026-09-21 (429s,
 * `sunset` header), so direct fetches of ipfs.io URIs fail. Meteora DBC coins listed on Axiom use this same
 * `https://<name>.mypinata.cloud/ipfs/<cid>` form. Trade-off accepted: the URI is permanent and tied to this Pinata
 * account (keep it active and paid as needed); consumers that rewrite `/ipfs/<cid>` paths to their own gateway keep
 * working regardless. Hard-coded, not env, so a deployment can't launch coins with a mistyped or missing gateway.
 */
export const METADATA_URI_GATEWAY = "https://scarlet-generous-armadillo-291.mypinata.cloud/ipfs/";
/** Solana's packet limit for the launch transaction. */
export { LAUNCH_TX_MAX_BYTES };
export const METADATA_CREATED_ON = "https://fumpad.app";
export { PLACEHOLDER_URI };
/** JSON body cap for this route only (4 MB image as base64 ≈ 5.4 MB, plus the fields). */
export const METADATA_BODY_LIMIT = 6 * 1024 * 1024;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
const DESCRIPTION_MAX = 500;
const URL_MAX = 200;

export interface LaunchMetadataInput {
  creator: PublicKey;
  name: string;
  symbol: string;
  description?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  /** Raw image bytes (checked by `checkLaunchImage` in the route). */
  image?: Buffer;
  auth: unknown;
  launchConfig: LaunchConfigKind;
  /** The launch includes the creator's first buy (default true: the larger transaction). */
  firstBuy: boolean;
}

const bad = (msg: string) => new LaunchError(400, msg);

function optString(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw bad(`${field} must be a string`);
  const s = v.trim();
  if (!s) return undefined;
  if (s.length > max) throw bad(`${field} is longer than ${max} characters`);
  return s;
}

function httpsUrl(v: string, field: string, hosts?: RegExp): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw bad(`invalid ${field}`);
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || !u.hostname.includes(".") || CONTROL.test(v)) throw bad(`invalid ${field}`);
  if (hosts && !hosts.test(u.hostname.toLowerCase())) throw bad(`invalid ${field}`);
  const s = u.toString();
  if (s.length > URL_MAX) throw bad(`${field} is too long`);
  return s;
}

/** "@frog" / "frog" / "x.com/frog" / "https://twitter.com/frog/…" → "https://x.com/frog[/…]". */
export function normalizeTwitter(v: string): string {
  const h = /^@?([A-Za-z0-9_]{1,15})$/.exec(v);
  if (h) return `https://x.com/${h[1]}`;
  const u = httpsUrl(/^https?:\/\//i.test(v) ? v.replace(/^http:/i, "https:") : `https://${v}`, "twitter", /^(www\.|mobile\.)?(x|twitter)\.com$/);
  const p = new URL(u);
  if (p.pathname === "/" || p.pathname === "") throw bad("invalid twitter");
  return `https://x.com${p.pathname.replace(/\/$/, "")}${p.search}`;
}

/** "frogs" / "t.me/frogs" / "https://telegram.me/frogs" → "https://t.me/frogs". */
export function normalizeTelegram(v: string): string {
  const h = /^@?([A-Za-z0-9_]{4,32})$/.exec(v);
  if (h) return `https://t.me/${h[1]}`;
  const u = httpsUrl(/^https?:\/\//i.test(v) ? v.replace(/^http:/i, "https:") : `https://${v}`, "telegram", /^(t\.me|telegram\.me)$/);
  const p = new URL(u);
  if (p.pathname === "/" || p.pathname === "") throw bad("invalid telegram");
  return `https://t.me${p.pathname.replace(/\/$/, "")}`;
}

/** base64 / data URL → bytes, or a 400. */
function decodeImage(v: unknown): Buffer | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw bad("image must be a base64 string");
  const b64 = v.replace(/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw bad("image must be base64");
  if (Math.floor((b64.length * 3) / 4) > LAUNCH_IMAGE_MAX_BYTES + 3) throw bad(`image is larger than ${LAUNCH_IMAGE_MAX_BYTES / 1024 / 1024} MB`);
  return Buffer.from(b64, "base64");
}

export function parseMetadataBody(body: unknown): LaunchMetadataInput {
  if (!body || typeof body !== "object") throw bad("JSON body required");
  const b = body as Record<string, unknown>;
  if (typeof b.creator !== "string" || !BASE58.test(b.creator)) throw bad("invalid creator");
  let creator: PublicKey;
  try {
    creator = new PublicKey(b.creator);
  } catch {
    throw bad("invalid creator");
  }
  if (!PublicKey.isOnCurve(creator.toBytes())) throw bad("creator must be a wallet address");
  // Same name/symbol rules as the launch itself (the uri is ours, checked below with the real one).
  const metaErr = launchMetadataError({ name: b.name, symbol: b.symbol, uri: "https://a" });
  if (metaErr) throw bad(metaErr);
  const description = optString(b.description, "description", DESCRIPTION_MAX);
  if (description && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(description)) throw bad("description contains control characters");
  const website = optString(b.website, "website", URL_MAX);
  const twitter = optString(b.twitter ?? b.x, "twitter", URL_MAX);
  const telegram = optString(b.telegram, "telegram", URL_MAX);
  const launchConfig = b.launchConfig === undefined || b.launchConfig === null ? "standard" : b.launchConfig;
  if (launchConfig !== "standard" && launchConfig !== "first_coin") throw bad("invalid launchConfig");
  if (b.firstBuy !== undefined && typeof b.firstBuy !== "boolean") throw bad("firstBuy must be a boolean");
  return {
    creator,
    name: b.name as string,
    symbol: b.symbol as string,
    description,
    website: website ? httpsUrl(website, "website") : undefined,
    twitter: twitter ? normalizeTwitter(twitter) : undefined,
    telegram: telegram ? normalizeTelegram(telegram) : undefined,
    image: decodeImage(b.image),
    auth: b.auth,
    launchConfig,
    firstBuy: b.firstBuy !== false,
  };
}

export interface TokenMetadataJson {
  name: string;
  symbol: string;
  description: string;
  image?: string;
  showName: true;
  createdOn: string;
  twitter?: string;
  telegram?: string;
  website?: string;
  external_url?: string;
  extensions?: { website?: string; twitter?: string; telegram?: string };
  properties?: { files: { uri: string; type: string }[]; category: "image" };
}

/**
 * The metadata JSON: pump.fun's fields (`name, symbol, description, image, showName, createdOn, twitter, telegram,
 * website`, socials as full https URLs at the top level, which is where Axiom / Dexscreener / Birdeye / GMGN look),
 * the Metaplex token-standard fields (`external_url`, `properties.files` + `category`, which Phantom / Solflare /
 * Metaplex readers use), and `extensions` (the old Solana token-list socials some indexers still read). Empty
 * fields are left out, except `description` (pump.fun always sends it).
 */
export function buildTokenMetadata(m: { name: string; symbol: string; description?: string; website?: string; twitter?: string; telegram?: string }, image?: { uri: string; type: string }): TokenMetadataJson {
  const socials = { ...(m.website ? { website: m.website } : {}), ...(m.twitter ? { twitter: m.twitter } : {}), ...(m.telegram ? { telegram: m.telegram } : {}) };
  return {
    name: m.name,
    symbol: m.symbol,
    description: m.description ?? "",
    ...(image ? { image: image.uri } : {}),
    showName: true,
    createdOn: METADATA_CREATED_ON,
    ...socials,
    ...(m.website ? { external_url: m.website } : {}),
    ...(Object.keys(socials).length ? { extensions: socials } : {}),
    ...(image ? { properties: { files: [{ uri: image.uri, type: image.type }], category: "image" as const } } : {}),
  };
}

const DUMMY = { creator: PublicKey.unique(), mint: PublicKey.unique(), dbcConfig: PublicKey.unique(), launchSigner: PublicKey.unique() };
/** The launch ALT's contents are fixed (`launchAltAddresses`), so its size effect needs no RPC: any table address will do. */
const DUMMY_ALT = new AddressLookupTableAccount({
  key: PublicKey.unique(),
  state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: launchAltAddresses() },
});

/**
 * Serialized size of the launch transaction prepare would build for this name / symbol / uri: worst case the API
 * produces (launch co-signer present, as on mainnet; first buy if asked; no priority fee, which the app never sends),
 * through the launch ALT when `alt` (what prepare does wherever LAUNCH_ALT is configured or required).
 */
export function launchTxSize(m: { name: string; symbol: string; uri: string; firstBuy: boolean; alt?: boolean }): number {
  const ixs = launchInstructions({ ...DUMMY, name: m.name, symbol: m.symbol, uri: m.uri, buyLamports: m.firstBuy ? 1n : 0n, minTokensOut: 1n });
  const msg = new TransactionMessage({ payerKey: DUMMY.creator, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message(m.alt ? [DUMMY_ALT] : []);
  return new VersionedTransaction(msg).serialize().length;
}

/** Same length as every CIDv0 (the JSON is pinned as v0: 46 chars, the shortest IPFS address). */
const SAMPLE_CID_V0 = "Qm" + "1".repeat(44);

/**
 * The most compatible metadata URI that still fits the launch transaction: `${METADATA_URI_GATEWAY}<cid>` (fetched
 * directly by every wallet / aggregator), else `ipfs://<cid>` (consumers must map it to a gateway themselves; our
 * indexer and image proxy do), else null (name + ticker too long to launch with any IPFS uri). Through the launch
 * ALT (`alt`, every cluster but localnet) the https form always fits, whatever the name / ticker / first buy; inline,
 * with the launch co-signer, it only fits launches without a first buy.
 */
export function metadataUriFor(cid: string, m: { name: string; symbol: string; firstBuy: boolean; alt?: boolean }): string | null {
  for (const uri of [`${METADATA_URI_GATEWAY}${cid}`, `ipfs://${cid}`]) if (launchTxSize({ ...m, uri }) <= LAUNCH_TX_MAX_BYTES) return uri;
  return null;
}

/** Where pinned files go (Pinata in production, a fake in tests). Returns the CID. */
export interface IpfsPinner {
  pin(file: PinFile): Promise<string>;
}

export interface PinFile {
  bytes: Uint8Array;
  name: string;
  type: string;
  keyvalues?: Record<string, string>;
  /** "v0" for the metadata JSON (shortest uri), default v1. */
  cidVersion?: "v0" | "v1";
}

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,100})$/;

/** Pinata Files API v3 (`POST https://uploads.pinata.cloud/v3/files`, `network=public`, Bearer JWT). */
export class PinataPinner implements IpfsPinner {
  constructor(
    private jwt: string,
    private opts: { fetch?: typeof fetch; timeoutMs?: number; endpoint?: string } = {},
  ) {}

  async pin(file: PinFile): Promise<string> {
    const form = new FormData();
    form.append("network", "public");
    if (file.cidVersion) form.append("cid_version", file.cidVersion);
    form.append("name", file.name);
    if (file.keyvalues) form.append("keyvalues", JSON.stringify(file.keyvalues));
    form.append("file", new Blob([Uint8Array.from(file.bytes)], { type: file.type }), file.name);
    const res = await (this.opts.fetch ?? fetch)(this.opts.endpoint ?? "https://uploads.pinata.cloud/v3/files", {
      method: "POST",
      headers: { authorization: `Bearer ${this.jwt}` },
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
    });
    // Never echo Pinata's body: only the status is useful and safe to log.
    if (!res.ok) throw new PinError(`pinata answered ${res.status}`, res.status);
    const j = (await res.json().catch(() => null)) as { data?: { cid?: unknown } } | null;
    const cid = j?.data?.cid;
    if (typeof cid !== "string" || !CID.test(cid)) throw new PinError("pinata returned no cid");
    return cid;
  }
}

export class PinError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface MetadataResponse {
  /** The launch's metadata URI (https gateway URL of the pinned JSON), or the placeholder on devnet without Pinata. */
  uri: string;
  /** The image's URI inside the JSON, when an image was sent. */
  image?: string;
  /** True when nothing was pinned (devnet/localnet without PINATA_JWT). */
  placeholder?: boolean;
}

export const ipfsUri = (cid: string) => `${METADATA_URI_GATEWAY}${cid}`;

/** The 400 for a name + ticker that can't launch with any IPFS uri (checked before anything is pinned). */
export function assertMetadataFits(m: { name: string; symbol: string; firstBuy: boolean; alt?: boolean }) {
  if (!metadataUriFor(SAMPLE_CID_V0, m))
    throw bad(m.firstBuy ? "the name and ticker are too long to fit in one launch transaction with a first buy: shorten them, or launch without a first buy" : "the name and ticker are too long to fit in one launch transaction");
}

/** Pin the image (if any), then the JSON (as CIDv0); returns the launch uri (sized for the ALT launch when `alt`). */
export async function pinLaunchMetadata(pinner: IpfsPinner, m: LaunchMetadataInput, image?: CheckedImage, alt = false): Promise<MetadataResponse> {
  const kv = { app: "fumpad", creator: m.creator.toBase58(), symbol: m.symbol };
  let img: { uri: string; type: string } | undefined;
  if (image) {
    const ext = image.type.split("/")[1].replace("jpeg", "jpg");
    const cid = await pinner.pin({ bytes: image.bytes, name: `${m.symbol}.${ext}`, type: image.type, keyvalues: { ...kv, kind: "image" } });
    img = { uri: ipfsUri(cid), type: image.type };
  }
  const json = buildTokenMetadata(m, img);
  const cid = await pinner.pin({ bytes: Buffer.from(JSON.stringify(json), "utf8"), name: `${m.symbol}.json`, type: "application/json", keyvalues: { ...kv, kind: "metadata" }, cidVersion: "v0" });
  const uri = metadataUriFor(cid, { ...m, alt });
  const err = uri ? launchMetadataError({ name: m.name, symbol: m.symbol, uri }) : "does not fit the launch transaction";
  if (!uri || err) throw new PinError(`pinned uri rejected: ${err}`);
  return { uri, ...(img ? { image: img.uri } : {}) };
}

export interface MetadataDeps {
  conn: { getBalance(pk: PublicKey, commitment?: "confirmed"): Promise<number> };
  /** null: PINATA_JWT unset (placeholder on devnet, 503 on mainnet). */
  pinner: IpfsPinner | null;
  /** Launches disabled on this server (no mint pool): uploads are refused too. */
  launchesEnabled: boolean;
}

/** Log the metadata-upload mode once at boot (mainnet without Pinata is an error: launches can't work). */
export function logMetadataMode(cfg: ApiConfig, pinner: IpfsPinner | null, log: FastifyBaseLogger) {
  if (pinner) log.info({ gateways: cfg.ipfsGateways }, "launch metadata: pinning to IPFS (Pinata)");
  else if (cfg.metadataDisabledReason) log.error({ reason: cfg.metadataDisabledReason }, "launch metadata uploads DISABLED: POST /v1/launch/metadata answers 503, so the app can't launch");
  else log.warn("launch metadata: PINATA_JWT unset, POST /v1/launch/metadata returns the placeholder uri ipfs://pending (devnet only; coins launch without logo or socials)");
}

export function registerMetadataRoute(app: FastifyInstance, cfg: ApiConfig, deps: MetadataDeps) {
  const perWalletMin = new WindowLimiter(cfg.launchMetadataWalletLimitPerMin);
  const perWalletHour = new WindowLimiter(cfg.launchMetadataWalletLimitPerHour, 3_600_000);
  app.post(
    "/v1/launch/metadata",
    { bodyLimit: METADATA_BODY_LIMIT, config: { rateLimit: { max: cfg.launchMetadataRateLimitPerMin, timeWindow: "1 minute" } } },
    async (req, reply): Promise<MetadataResponse> => {
      reply.header("cache-control", "no-store");
      const m = parseMetadataBody(req.body);
      // Same gates as prepare, in the same order: nothing is stored for a launch that couldn't happen.
      assertLaunchAllowed(m.launchConfig, cfg.launchesOpen);
      if (m.launchConfig === "first_coin" && !cfg.launchFirstCoin) throw new LaunchError(403, "the first-coin launch config is not enabled on this server");
      if (!deps.launchesEnabled) throw new LaunchError(503, "launches are not enabled on this server");
      if (cfg.metadataDisabledReason) throw new LaunchError(503, "coin metadata uploads are not configured on this server");
      // Prepare refuses every launch without the required lookup table: don't pin for a launch that can't happen.
      if (cfg.launchAltRequired && !cfg.launchAlt) throw new LaunchError(503, "launches are not configured on this server (lookup table)");
      if (cfg.launchRequireSignature) {
        const err = launchAuthError(m.auth, { creator: m.creator, symbol: m.symbol }, { maxAgeSecs: cfg.launchSignatureMaxAgeSecs });
        if (err) throw new LaunchError(401, err);
      }
      const alt = launchAltInUse(cfg);
      assertMetadataFits({ ...m, alt });
      const creator = m.creator.toBase58();
      if (!perWalletMin.take(creator) || !perWalletHour.take(creator)) throw new LaunchError(429, "too many metadata uploads for this wallet, wait a bit", 60);
      // Check the image before spending an RPC call or a pin on it.
      let image: CheckedImage | undefined;
      if (m.image) {
        try {
          image = checkLaunchImage(m.image);
        } catch (e) {
          if (e instanceof ImageCheckError) throw bad(e.message);
          throw e;
        }
      }
      if (cfg.launchMinBalanceLamports > 0n) {
        const bal = BigInt(await withTimeout(deps.conn.getBalance(m.creator, "confirmed"), cfg.launchRpcTimeoutMs, "balance lookup"));
        if (bal < cfg.launchMinBalanceLamports) throw bad(`wallet needs at least ${Number(cfg.launchMinBalanceLamports) / 1e9} SOL to launch`);
      }
      if (!deps.pinner) {
        req.log.warn({ creator, symbol: m.symbol }, "launch metadata NOT pinned (PINATA_JWT unset): placeholder uri");
        return { uri: PLACEHOLDER_URI, placeholder: true };
      }
      try {
        const out = await pinLaunchMetadata(deps.pinner, m, image, alt);
        req.log.info({ creator, symbol: m.symbol, uri: out.uri, image: !!image }, "launch metadata pinned");
        return out;
      } catch (e) {
        req.log.warn({ creator, err: e instanceof PinError ? e.message : e instanceof Error ? e.name : "error" }, "launch metadata pin failed");
        throw new LaunchError(502, "couldn't store the coin's image and details right now, try again", 5);
      }
    },
  );
}
