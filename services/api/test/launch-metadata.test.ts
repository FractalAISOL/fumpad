/**
 * `POST /v1/launch/metadata` (coin metadata pinned to IPFS through Pinata, server-side). Pinata is always mocked
 * here: a fake `IpfsPinner` for the route, a fake `fetch` for `PinataPinner`. Covers the JSON shape and URI form,
 * image checks (type sniffing, size, dimensions, EXIF / text stripping), auth, rate limits, gates, the devnet
 * placeholder fallback and the mainnet 503, and that a launch tx still fits with the real-length URI.
 */
import { AddressLookupTableAccount, ComputeBudgetProgram, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { launchAltAddresses, launchInstructions } from "@fumpad/sdk";

import { loadApiConfig, metadataConfig } from "../src/config.js";
import { signLaunchAuth } from "../src/launch/auth.js";
import { checkLaunchImage, ImageCheckError, imageDimensions } from "../src/launch/image.js";
import { buildTokenMetadata, type IpfsPinner, LAUNCH_TX_MAX_BYTES, launchTxSize, METADATA_URI_GATEWAY, metadataUriFor, normalizeTelegram, normalizeTwitter, parseMetadataBody, PinataPinner, PinError, type PinFile, PLACEHOLDER_URI } from "../src/launch/metadata.js";
import { parsePrepareBody } from "../src/launch/routes.js";
import { buildServer } from "../src/server.js";

const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

// ── tiny valid image headers ────────────────────────────────────────────────────
const u32be = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const chunk = (type: string, data: Buffer) => Buffer.concat([u32be(data.length), Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
function png(w: number, h: number, extra: Buffer[] = []): Buffer {
  const ihdr = Buffer.concat([u32be(w), u32be(h), Buffer.from([8, 6, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra, chunk("IDAT", Buffer.alloc(20, 7)), chunk("IEND", Buffer.alloc(0))]);
}
const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
/** EXIF (little-endian TIFF) with Orientation + a fake GPS IFD pointer and a "secret" string. */
function exif(orientation: number): Buffer {
  const ifd = Buffer.alloc(2 + 2 * 12 + 4);
  ifd.writeUInt16LE(2, 0);
  ifd.writeUInt16LE(0x0112, 2);
  ifd.writeUInt16LE(3, 4);
  ifd.writeUInt32LE(1, 6);
  ifd.writeUInt16LE(orientation, 10);
  ifd.writeUInt16LE(0x8825, 14); // GPSInfo
  ifd.writeUInt16LE(4, 16);
  ifd.writeUInt32LE(1, 18);
  ifd.writeUInt32LE(99, 22);
  return Buffer.concat([Buffer.from("Exif\0\0", "binary"), Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0]), ifd, Buffer.from("GPS-SECRET-48.85N")]);
}
function jpeg(w: number, h: number, orientation?: number): Buffer {
  const app0 = seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "binary"));
  const sof = seg(0xc0, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]));
  const sos = Buffer.concat([seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.alloc(30, 0x55), Buffer.from([0xff, 0xd9])]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, ...(orientation ? [seg(0xe1, exif(orientation))] : []), seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>creator-name</x:xmpmeta>", "binary")), sof, sos]);
}
function gif(w: number, h: number): Buffer {
  const b = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(30)]);
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return b;
}
function webpVp8x(w: number, h: number): Buffer {
  const b = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(30)]);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}

describe("image checks", () => {
  it("dimensions from PNG / JPEG / GIF / WebP headers", () => {
    expect(imageDimensions(png(512, 256), "image/png")).toEqual({ width: 512, height: 256 });
    expect(imageDimensions(jpeg(640, 480, 6), "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageDimensions(gif(100, 50), "image/gif")).toEqual({ width: 100, height: 50 });
    expect(imageDimensions(webpVp8x(1000, 1000), "image/webp")).toEqual({ width: 1000, height: 1000 });
  });

  it("refuses non-images, oversized files and silly dimensions", () => {
    const err = (b: Buffer) => () => checkLaunchImage(b);
    expect(err(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toThrow(/PNG, JPG, GIF or WebP/);
    expect(err(Buffer.from("<!doctype html><p>hi"))).toThrow(ImageCheckError);
    expect(err(Buffer.alloc(0))).toThrow(/empty/);
    expect(err(Buffer.concat([png(512, 512), Buffer.alloc(4 * 1024 * 1024)]))).toThrow(/larger than 4 MB/);
    expect(err(png(8, 8))).toThrow(/too small/);
    expect(err(png(9000, 100))).toThrow(/too large/);
    expect(err(png(8000, 8000))).toThrow(/too large/); // 64 MP
    expect(err(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30)]))).toThrow(/header/);
  });

  it("PNG: text / eXIf / tIME chunks are dropped, pixels untouched", () => {
    const src = png(64, 64, [chunk("tEXt", Buffer.from("Author\0Jane Doe")), chunk("eXIf", exif(1)), chunk("tIME", Buffer.alloc(7))]);
    const out = checkLaunchImage(src);
    expect(out.type).toBe("image/png");
    expect(out.bytes.includes(Buffer.from("Jane Doe"))).toBe(false);
    expect(out.bytes.includes(Buffer.from("GPS-SECRET"))).toBe(false);
    expect(out.bytes.equals(png(64, 64))).toBe(true);
  });

  it("JPEG: EXIF (GPS) and XMP are dropped; a non-default orientation survives as a one-tag EXIF after APP0", () => {
    const out = checkLaunchImage(jpeg(300, 200, 6));
    expect(out.bytes.includes(Buffer.from("GPS-SECRET"))).toBe(false);
    expect(out.bytes.includes(Buffer.from("creator-name"))).toBe(false);
    expect(out.bytes.subarray(0, 4).equals(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    const app1 = out.bytes.indexOf(Buffer.from([0xff, 0xe1]));
    expect(app1).toBeGreaterThan(2);
    expect(out.bytes.subarray(app1 + 4, app1 + 10).toString("binary")).toBe("Exif\0\0");
    expect(out.bytes.includes(Buffer.from([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6]))).toBe(true);
    expect(imageDimensions(out.bytes, "image/jpeg")).toEqual({ width: 300, height: 200 });
    // orientation 1 (or none): no APP1 at all
    expect(checkLaunchImage(jpeg(300, 200, 1)).bytes.includes(Buffer.from([0xff, 0xe1]))).toBe(false);
    // the scan data is copied verbatim
    expect(out.bytes.subarray(-32).equals(jpeg(300, 200).subarray(-32))).toBe(true);
  });

  it("GIF / WebP pass through unchanged", () => {
    expect(checkLaunchImage(gif(64, 64)).bytes.equals(gif(64, 64))).toBe(true);
    expect(checkLaunchImage(webpVp8x(64, 64)).type).toBe("image/webp");
  });
});

describe("metadata body + JSON shape", () => {
  const creator = Keypair.generate().publicKey.toBase58();
  it("normalizes socials to full https URLs and refuses junk", () => {
    expect(normalizeTwitter("@frog")).toBe("https://x.com/frog");
    expect(normalizeTwitter("frog_1")).toBe("https://x.com/frog_1");
    expect(normalizeTwitter("https://twitter.com/frog/")).toBe("https://x.com/frog");
    expect(normalizeTwitter("x.com/i/communities/123")).toBe("https://x.com/i/communities/123");
    expect(() => normalizeTwitter("https://evil.com/frog")).toThrow(/twitter/);
    expect(() => normalizeTwitter("javascript:alert(1)")).toThrow(/twitter/);
    expect(normalizeTelegram("sadpigeon")).toBe("https://t.me/sadpigeon");
    expect(normalizeTelegram("t.me/sadpigeon")).toBe("https://t.me/sadpigeon");
    expect(normalizeTelegram("https://telegram.me/sadpigeon")).toBe("https://t.me/sadpigeon");
    expect(() => normalizeTelegram("https://t.me.evil.com/x")).toThrow(/telegram/);
    const p = parseMetadataBody({ creator, name: "Sad Pigeon", symbol: "PIGN", website: "https://pigeon.fun", twitter: "@sadpigeon", telegram: "t.me/sadpigeon" });
    expect(p).toMatchObject({ website: "https://pigeon.fun/", twitter: "https://x.com/sadpigeon", telegram: "https://t.me/sadpigeon", launchConfig: "standard" });
    expect(() => parseMetadataBody({ creator, name: "A", symbol: "B", website: "http://pigeon.fun" })).toThrow(/website/);
    expect(() => parseMetadataBody({ creator, name: "A", symbol: "B", website: "https://user:pw@pigeon.fun" })).toThrow(/website/);
    expect(() => parseMetadataBody({ creator, name: "A", symbol: "B", description: "x".repeat(501) })).toThrow(/description/);
    expect(() => parseMetadataBody({ creator, name: "", symbol: "B" })).toThrow(/name/);
    expect(() => parseMetadataBody({ creator, name: "A", symbol: "B".repeat(11) })).toThrow(/symbol/);
    expect(() => parseMetadataBody({ creator, name: "A", symbol: "B", image: "not base64!" })).toThrow(/base64/);
    expect(() => parseMetadataBody({ creator: "nope", name: "A", symbol: "B" })).toThrow(/creator/);
    // a data: URL is accepted too
    expect(parseMetadataBody({ creator, name: "A", symbol: "B", image: `data:image/png;base64,${png(32, 32).toString("base64")}` }).image?.equals(png(32, 32))).toBe(true);
  });

  it("JSON: pump.fun fields + Metaplex fields + extensions; empty fields left out", () => {
    const img = { uri: `${METADATA_URI_GATEWAY}bafkreiimage`, type: "image/png" };
    expect(buildTokenMetadata({ name: "Sad Pigeon", symbol: "PIGN", description: "He's just like that.", website: "https://pigeon.fun/", twitter: "https://x.com/sadpigeon", telegram: "https://t.me/sadpigeon" }, img)).toEqual({
      name: "Sad Pigeon",
      symbol: "PIGN",
      description: "He's just like that.",
      image: img.uri,
      showName: true,
      createdOn: "https://fumpad.app",
      website: "https://pigeon.fun/",
      twitter: "https://x.com/sadpigeon",
      telegram: "https://t.me/sadpigeon",
      external_url: "https://pigeon.fun/",
      extensions: { website: "https://pigeon.fun/", twitter: "https://x.com/sadpigeon", telegram: "https://t.me/sadpigeon" },
      properties: { files: [{ uri: img.uri, type: "image/png" }], category: "image" },
    });
    expect(buildTokenMetadata({ name: "Sad Pigeon", symbol: "PIGN" })).toEqual({ name: "Sad Pigeon", symbol: "PIGN", description: "", showName: true, createdOn: "https://fumpad.app" });
  });

  it("through the launch ALT: always the https gateway, even max name + ticker + first buy + co-signer + priority fee", () => {
    const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    const https = `${METADATA_URI_GATEWAY}${cid}`;
    for (const firstBuy of [true, false])
      for (const [name, symbol] of [["W".repeat(32), "W".repeat(10)], ["Sad Pigeon", "PIGN"], ["A", "A"], ["é".repeat(16), "Ω".repeat(5)]])
        expect(metadataUriFor(cid, { name, symbol, firstBuy, alt: true }), `${name}/${symbol}/${firstBuy}`).toBe(https);
    // the size model matches an independent build through a table with the launch ALT's contents, and the worst case
    // the API can build (max metadata, https uri, first buy, launch co-signer, CU limit + priority price) still fits
    const me = Keypair.generate().publicKey;
    const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: (1n << 64n) - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: launchAltAddresses() } });
    const build = (priorityMicroLamports?: number) =>
      new VersionedTransaction(
        new TransactionMessage({
          payerKey: me,
          recentBlockhash: PublicKey.default.toBase58(),
          instructions: launchInstructions({ creator: me, mint: Keypair.generate().publicKey, dbcConfig: Keypair.generate().publicKey, name: "W".repeat(32), symbol: "W".repeat(10), uri: https, buyLamports: 5n, minTokensOut: 1n, launchSigner: Keypair.generate().publicKey, priorityMicroLamports }),
        }).compileToV0Message([alt]),
      );
    const size = build().serialize().length;
    expect(launchTxSize({ name: "W".repeat(32), symbol: "W".repeat(10), uri: https, firstBuy: true, alt: true })).toBe(size);
    expect(build(5_000_000).serialize().length).toBeLessThanOrEqual(LAUNCH_TX_MAX_BYTES);
    expect(build(5_000_000).message.compiledInstructions.some((i) => build(5_000_000).message.staticAccountKeys[i.programIdIndex].equals(ComputeBudgetProgram.programId))).toBe(true);
    // the same worst case inline doesn't fit: the reason for the table
    expect(launchTxSize({ name: "W".repeat(32), symbol: "W".repeat(10), uri: https, firstBuy: true })).toBeGreaterThan(LAUNCH_TX_MAX_BYTES);
  });

  it("inline (localnet without LAUNCH_ALT): https when the launch tx has room, else ipfs://, else refused (1,232-byte launch tx)", () => {
    const cid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
    // no first buy: always room for the https form, even at max name + ticker
    expect(metadataUriFor(cid, { name: "W".repeat(32), symbol: "W".repeat(10), firstBuy: false })).toBe(`${METADATA_URI_GATEWAY}${cid}`);
    // with a first buy (and the mainnet launch co-signer): only ipfs:// fits a typical name
    expect(metadataUriFor(cid, { name: "Sad Pigeon", symbol: "PIGN", firstBuy: true })).toBe(`ipfs://${cid}`);
    // ... and nothing fits a max-length name + ticker
    expect(metadataUriFor(cid, { name: "W".repeat(32), symbol: "W".repeat(10), firstBuy: true })).toBeNull();
    // the size model is the real prepare transaction (launch signer + first buy), checked against an independent build
    const uri = `ipfs://${cid}`;
    const me = Keypair.generate().publicKey;
    const ixs = launchInstructions({ creator: me, mint: Keypair.generate().publicKey, dbcConfig: Keypair.generate().publicKey, name: "Sad Pigeon", symbol: "PIGN", uri, buyLamports: 5n, minTokensOut: 1n, launchSigner: Keypair.generate().publicKey });
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: me, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message());
    expect(launchTxSize({ name: "Sad Pigeon", symbol: "PIGN", uri, firstBuy: true })).toBe(tx.serialize().length);
    expect(tx.serialize().length).toBeLessThanOrEqual(LAUNCH_TX_MAX_BYTES);
    expect(parsePrepareBody({ creator, name: "Sad Pigeon", symbol: "PIGN", uri }, { launchMaxInitialBuyLamports: 1n, launchMaxPriorityMicroLamports: 1 }).uri).toBe(uri);
  });
});

describe("PinataPinner (mocked fetch, never the real API)", () => {
  it("POSTs multipart to the v3 Files API, public network, Bearer JWT; returns the cid", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: { id: "x", cid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku", is_duplicate: false } }), { status: 200 });
    }) as unknown as typeof fetch;
    const cid = await new PinataPinner("jwt-123", { fetch: fake }).pin({ bytes: Buffer.from("{}"), name: "PIGN.json", type: "application/json", keyvalues: { app: "fumpad" }, cidVersion: "v0" });
    expect(cid).toBe("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
    expect(seen?.url).toBe("https://uploads.pinata.cloud/v3/files");
    expect(seen?.init.method).toBe("POST");
    expect((seen?.init.headers as Record<string, string>).authorization).toBe("Bearer jwt-123");
    const form = seen?.init.body as FormData;
    expect(form.get("network")).toBe("public");
    expect(form.get("name")).toBe("PIGN.json");
    expect(form.get("cid_version")).toBe("v0");
    expect(JSON.parse(form.get("keyvalues") as string)).toEqual({ app: "fumpad" });
    expect(await (form.get("file") as Blob).text()).toBe("{}");
  });
  it("errors carry the status only, and a missing / malformed cid is an error", async () => {
    const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const pin = (f: typeof fetch) => new PinataPinner("jwt", { fetch: f }).pin({ bytes: Buffer.from("x"), name: "a", type: "text/plain" });
    const e = await pin(answer(401, { error: "Invalid jwt-SECRET" })).catch((x) => x);
    expect(e).toBeInstanceOf(PinError);
    expect(e.status).toBe(401);
    expect(String(e.message)).not.toMatch(/SECRET/);
    await expect(pin(answer(200, { data: {} }))).rejects.toThrow(/no cid/);
    await expect(pin(answer(200, { data: { cid: "../../etc" } }))).rejects.toThrow(/no cid/);
  });
});

describe("config", () => {
  it("PINATA_JWT: required on mainnet (uploads disabled without it), optional elsewhere", () => {
    expect(metadataConfig(env({}))).toEqual({ pinataJwt: undefined, metadataRequired: false, metadataDisabledReason: undefined });
    expect(metadataConfig(env({ FUMPAD_CLUSTER: "devnet" })).metadataDisabledReason).toBeUndefined();
    expect(metadataConfig(env({ FUMPAD_CLUSTER: "mainnet" })).metadataDisabledReason).toMatch(/PINATA_JWT/);
    expect(metadataConfig(env({ FUMPAD_CLUSTER: "mainnet", PINATA_JWT: " j " }))).toEqual({ pinataJwt: "j", metadataRequired: true, metadataDisabledReason: undefined });
  });
  it("PINATA_GATEWAY → our image fetches try it first, then IPFS_GATEWAY", () => {
    const c = loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", PINATA_GATEWAY: "fumpad.mypinata.cloud" }));
    expect(c.ipfsGateways).toEqual(["https://fumpad.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/"]);
    expect(loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub" })).ipfsGateways).toEqual(["https://ipfs.io/ipfs/"]);
    expect(() => loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", PINATA_GATEWAY: "http://10.0.0.1:8080" }))).toThrow(/PINATA_GATEWAY/);
  });
});

describe("POST /v1/launch/metadata", () => {
  const creatorKp = Keypair.generate();
  const creator = creatorKp.publicKey.toBase58();
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  const ALT = Keypair.generate().publicKey.toBase58();
  class FakePinner implements IpfsPinner {
    files: PinFile[] = [];
    fail = false;
    async pin(f: PinFile) {
      if (this.fail) throw new PinError("pinata answered 500", 500);
      this.files.push(f);
      const n = "abcdefgh"[this.files.length];
      return f.cidVersion === "v0" ? "Qm" + "Z".repeat(43) + n : "bafkrei" + "q".repeat(50) + n;
    }
  }

  async function server(e: Record<string, string> = {}, o: { pinner?: IpfsPinner | null; balance?: number; pool?: boolean } = {}) {
    // LAUNCH_ALT is required on every cluster but localnet (the metadata route only checks it's configured)
    const cfg = loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent", LAUNCH_SWEEP_SECS: "0", LAUNCH_ALT: ALT, ...e }));
    const built = await buildServer(cfg, {
      db: { query: async () => ({ rows: [], rowCount: 0 }), end: async () => {} } as never,
      conn: { getBalance: async () => o.balance ?? 1_000_000_000 } as never,
      repo: {} as never,
      chain: { solUsd: async () => 150, client: {} } as never,
      live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
      pool: o.pool === false ? null : ({ cfg: { suffix: "fmbL" } } as never),
      pinner: o.pinner === undefined ? new FakePinner() : o.pinner,
    });
    app = built.app;
    return app;
  }
  const body = (extra: Record<string, unknown> = {}, symbol = "PIGN", kp = creatorKp) => ({
    creator: kp.publicKey.toBase58(),
    name: "Sad Pigeon",
    symbol,
    auth: signLaunchAuth(kp.secretKey, { creator: kp.publicKey.toBase58(), symbol }),
    ...extra,
  });
  const post = (a: FastifyInstance, payload: unknown, ip = "1.2.3.4") => a.inject({ method: "POST", url: "/v1/launch/metadata", payload: payload as object, remoteAddress: ip });

  it("with an image: pins the stripped image, then the JSON; returns the https gateway uri", async () => {
    const pinner = new FakePinner();
    const a = await server({}, { pinner });
    const img = png(256, 256, [chunk("tEXt", Buffer.from("Author\0Jane Doe"))]);
    const r = await post(a, body({ description: "He's just like that.", twitter: "@sadpigeon", telegram: "sadpigeon", website: "https://pigeon.fun", image: img.toString("base64") }));
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    const out = r.json();
    expect(pinner.files.map((f) => [f.name, f.type])).toEqual([
      ["PIGN.png", "image/png"],
      ["PIGN.json", "application/json"],
    ]);
    expect(Buffer.from(pinner.files[0].bytes).includes(Buffer.from("Jane Doe"))).toBe(false);
    expect(pinner.files[0].keyvalues).toEqual({ app: "fumpad", creator, symbol: "PIGN", kind: "image" });
    expect(pinner.files[1].cidVersion).toBe("v0");
    // through the launch ALT a first buy (the default) still leaves room for the https form
    expect(out.uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
    expect(out.image).toMatch(/^https:\/\/ipfs\.io\/ipfs\/b[a-z2-7]+$/);
    expect(out.placeholder).toBeUndefined();
    const json = JSON.parse(Buffer.from(pinner.files[1].bytes).toString("utf8"));
    expect(json).toMatchObject({
      name: "Sad Pigeon",
      symbol: "PIGN",
      description: "He's just like that.",
      image: out.image,
      showName: true,
      createdOn: "https://fumpad.app",
      twitter: "https://x.com/sadpigeon",
      telegram: "https://t.me/sadpigeon",
      website: "https://pigeon.fun/",
      properties: { files: [{ uri: out.image, type: "image/png" }], category: "image" },
    });
    // the uri is a valid launch uri (prepare accepts it)
    expect(() => parsePrepareBody({ creator, name: "Sad Pigeon", symbol: "PIGN", uri: out.uri }, { launchMaxInitialBuyLamports: 1n, launchMaxPriorityMicroLamports: 1 })).not.toThrow();
  });

  it("without an image: only the JSON is pinned, no image fields", async () => {
    const pinner = new FakePinner();
    const a = await server({}, { pinner });
    const r = await post(a, body({ firstBuy: false }));
    expect(r.statusCode).toBe(200);
    expect(r.json().uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/); // room for the https form
    expect(pinner.files).toHaveLength(1);
    expect(r.json().image).toBeUndefined();
    const json = JSON.parse(Buffer.from(pinner.files[0].bytes).toString("utf8"));
    expect(json).toEqual({ name: "Sad Pigeon", symbol: "PIGN", description: "", showName: true, createdOn: "https://fumpad.app" });
  });

  it("oversized / invalid / tiny images are 400 and nothing is pinned", async () => {
    const pinner = new FakePinner();
    const a = await server({ LAUNCH_METADATA_WALLET_LIMIT_PER_MIN: "100", LAUNCH_METADATA_RATE_LIMIT_PER_MIN: "100" }, { pinner });
    const big = Buffer.concat([png(512, 512), Buffer.alloc(4 * 1024 * 1024 + 10)]);
    const cases: [Buffer, RegExp][] = [
      [big, /larger than 4 MB/],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), /PNG, JPG, GIF or WebP/],
      [Buffer.from("<!doctype html><script>x</script>"), /PNG, JPG, GIF or WebP/],
      [png(4, 4), /too small/],
    ];
    for (const [img, msg] of cases) {
      const r = await post(a, body({ image: img.toString("base64") }));
      expect(r.statusCode, String(msg)).toBe(400);
      expect(r.json().error).toMatch(msg);
    }
    expect(pinner.files).toHaveLength(0);
  });

  it("a body over 6 MiB is refused by the route's body limit", async () => {
    const a = await server();
    const r = await post(a, body({ image: "A".repeat(6.5 * 1024 * 1024) }));
    expect(r.statusCode).toBe(413);
  });

  it("auth: missing, for another wallet or another symbol → 401, nothing pinned", async () => {
    const pinner = new FakePinner();
    const a = await server({ LAUNCH_METADATA_WALLET_LIMIT_PER_MIN: "100", LAUNCH_METADATA_RATE_LIMIT_PER_MIN: "100" }, { pinner });
    const other = Keypair.generate();
    const noAuth = { ...body(), auth: undefined };
    expect((await post(a, noAuth)).statusCode).toBe(401);
    const forged = { ...body(), auth: signLaunchAuth(other.secretKey, { creator, symbol: "PIGN" }) };
    const r = await post(a, forged);
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toMatch(/does not match/);
    const wrongSymbol = { ...body(), auth: signLaunchAuth(creatorKp.secretKey, { creator, symbol: "OTHER" }) };
    expect((await post(a, wrongSymbol)).statusCode).toBe(401);
    const stale = { ...body(), auth: signLaunchAuth(creatorKp.secretKey, { creator, symbol: "PIGN", issuedAt: Date.now() - 3_600_000 }) };
    expect((await post(a, stale)).json().error).toMatch(/expired/);
    expect(pinner.files).toHaveLength(0);
  });

  it("rate limits: per wallet (3/min) and per IP", async () => {
    const a = await server({ LAUNCH_METADATA_RATE_LIMIT_PER_MIN: "100" });
    for (let i = 0; i < 3; i++) expect((await post(a, body())).statusCode).toBe(200);
    const r = await post(a, body(), "5.6.7.8"); // another IP: still this wallet's 4th
    expect(r.statusCode).toBe(429);
    expect(r.json().error).toMatch(/this wallet/);
    await a.close();
    const b = await server({ LAUNCH_METADATA_RATE_LIMIT_PER_MIN: "2" });
    const kp = () => Keypair.generate();
    expect((await post(b, body({}, "PIGN", kp()), "9.9.9.9")).statusCode).toBe(200);
    expect((await post(b, body({}, "PIGN", kp()), "9.9.9.9")).statusCode).toBe(200);
    expect((await post(b, body({}, "PIGN", kp()), "9.9.9.9")).statusCode).toBe(429);
    expect((await post(b, body({}, "PIGN", kp()), "8.8.8.8")).statusCode).toBe(200);
  });

  it("max name + ticker + first buy: the https uri through the launch ALT", async () => {
    const pinner = new FakePinner();
    const a = await server({}, { pinner });
    const r = await post(a, body({ name: "W".repeat(32) }, "WWWWWWWWWW"));
    expect(r.statusCode).toBe(200);
    expect(r.json().uri).toMatch(/^https:\/\/ipfs\.io\/ipfs\/Qm/);
  });

  it("LAUNCH_ALT missing where it's required (devnet / mainnet): 503 before anything is pinned", async () => {
    const pinner = new FakePinner();
    for (const e of [{ LAUNCH_ALT: "" }, { FUMPAD_CLUSTER: "devnet", LAUNCH_ALT: "" }, { FUMPAD_CLUSTER: "mainnet", PINATA_JWT: "x", LAUNCHES_OPEN: "true", LAUNCH_ALT: "" }] as Record<string, string>[]) {
      const a = await server(e, { pinner });
      const r = await post(a, body());
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toMatch(/lookup table/);
      await a.close();
    }
    expect(pinner.files).toHaveLength(0);
    expect(() => loadApiConfig(env({ DATABASE_URL: "postgres://stub/stub", LAUNCH_ALT: "not-an-address!" }))).toThrow(/LAUNCH_ALT/);
  });

  it("inline (localnet, no LAUNCH_ALT): a name + ticker too long for any IPFS uri with a first buy is 400 before pinning; fine without the buy", async () => {
    const pinner = new FakePinner();
    const a = await server({ FUMPAD_CLUSTER: "localnet", LAUNCH_ALT: "" }, { pinner });
    const long = { name: "W".repeat(32) };
    const r = await post(a, body({ ...long }, "WWWWWWWWWW"));
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/too long to fit .* first buy/);
    expect(pinner.files).toHaveLength(0);
    expect((await post(a, body({ ...long, firstBuy: false }, "WWWWWWWWWW"))).statusCode).toBe(200);
    expect((await post(a, body({ firstBuy: "yes" }))).statusCode).toBe(400);
  });

  it("an unfunded wallet is refused before anything is pinned", async () => {
    const pinner = new FakePinner();
    const a = await server({}, { pinner, balance: 1_000 });
    const r = await post(a, body());
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/SOL to launch/);
    expect(pinner.files).toHaveLength(0);
  });

  it("gates: launches closed → 403; first_coin only when enabled; no mint pool → 503", async () => {
    const closed = await server({ FUMPAD_CLUSTER: "mainnet", PINATA_JWT: "x" });
    expect((await post(closed, body())).json()).toEqual({ error: "Launches open soon", code: "launches_closed" });
    expect((await post(closed, body({ launchConfig: "first_coin" }))).statusCode).toBe(403);
    await closed.close();
    const first = await server({ FUMPAD_CLUSTER: "mainnet", PINATA_JWT: "x", LAUNCH_FIRST_COIN: "true" });
    expect((await post(first, body({ launchConfig: "first_coin" }))).statusCode).toBe(200);
    await first.close();
    const noPool = await server({}, { pool: false });
    expect((await post(noPool, body())).statusCode).toBe(503);
  });

  it("devnet without PINATA_JWT: the placeholder uri (old behavior), flagged", async () => {
    const a = await server({ FUMPAD_CLUSTER: "devnet" }, { pinner: null });
    const r = await post(a, body({ image: png(64, 64).toString("base64") }));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ uri: PLACEHOLDER_URI, placeholder: true });
  });

  it("mainnet without PINATA_JWT: 503, and prepare refuses the placeholder uri", async () => {
    const a = await server({ FUMPAD_CLUSTER: "mainnet", LAUNCHES_OPEN: "true" }, { pinner: null });
    const r = await post(a, body());
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/not configured/);
    const p = await a.inject({ method: "POST", url: "/v1/launch/prepare", payload: { ...body(), uri: PLACEHOLDER_URI } });
    expect(p.statusCode).toBe(400);
    expect(p.json().error).toMatch(/metadata wasn't uploaded/);
  });

  it("a Pinata failure is a 502 with a retry hint and no upstream detail", async () => {
    const pinner = new FakePinner();
    pinner.fail = true;
    const a = await server({}, { pinner });
    const r = await post(a, body());
    expect(r.statusCode).toBe(502);
    expect(r.headers["retry-after"]).toBe("5");
    expect(r.json().error).toMatch(/try again/);
    expect(JSON.stringify(r.json())).not.toMatch(/pinata/i);
  });
});
