/**
 * The launch metadata upload (`POST /v1/launch/metadata`): request body, one signature shared with prepare,
 * per-form-content caching, 401 re-sign, and the errors the form turns into "Try again". `fetch` is faked.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { Keypair, type VersionedTransaction } from "@solana/web3.js";
import { cachedLaunchAuth, dropLaunchAuth } from "./launchAuth";
import { bytesToBase64, clearMetadataCache, MetadataUploadError, metadataBody, metadataCacheKey, postMetadata, uploadLaunchMetadata } from "./metadata";
import type { FumpadSigner } from "./signer";

const seed = new Uint8Array(32).fill(9);
const kp = Keypair.fromSeed(seed);
const creator = kp.publicKey.toBase58();
let signs = 0;
const signer: FumpadSigner = {
  publicKey: kp.publicKey,
  kind: "external",
  name: "test",
  sign: async (tx: VersionedTransaction) => tx,
  signMessage: async (m) => {
    signs++;
    return ed25519.sign(m, seed);
  },
};
const URI = "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

type Call = { url: string; body: Record<string, unknown> };
function fakeFetch(answers: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    const a = answers.shift() ?? new Response(JSON.stringify({ uri: URI }), { status: 200 });
    if (a instanceof Error) throw a;
    return a;
  }) as unknown as typeof fetch;
  return { f, calls };
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  clearMetadataCache();
  dropLaunchAuth(creator, "PIGN");
  signs = 0;
});

describe("metadata body", () => {
  it("base64 is chunk-safe and exact", () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    assert.equal(bytesToBase64(big), Buffer.from(big).toString("base64"));
    assert.equal(bytesToBase64(new Uint8Array(0)), "");
  });

  it("carries the fields, the image as base64, firstBuy and the auth; empty fields left out", async () => {
    const img = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    const auth = { message: "m", signature: "s" };
    const b = await metadataBody({ creator, name: "Sad Pigeon", symbol: "PIGN", input: { description: "  hi ", x: "@sadpigeon", telegram: "", website: undefined, image: img }, firstBuy: true }, auth);
    assert.deepEqual(b, { creator, name: "Sad Pigeon", symbol: "PIGN", description: "hi", twitter: "@sadpigeon", image: "iVBORw==", firstBuy: true, auth });
    const fc = await metadataBody({ creator, name: "A", symbol: "B", input: {}, firstBuy: false, launchConfig: "first_coin" }, auth);
    assert.deepEqual(fc, { creator, name: "A", symbol: "B", firstBuy: false, launchConfig: "first_coin", auth });
  });
});

describe("postMetadata errors", () => {
  it("4xx: the API's reason; 413: the size limit; 5xx / network: a generic retry message; bad uri refused", async () => {
    const e400 = await postMetadata("https://api", {}, fakeFetch([json(400, { error: "image must be a PNG, JPG, GIF or WebP" })]).f).catch((e) => e);
    assert.ok(e400 instanceof MetadataUploadError);
    assert.equal(e400.status, 400);
    assert.equal(e400.message, "Image must be a PNG, JPG, GIF or WebP.");
    const e413 = await postMetadata("https://api", {}, fakeFetch([json(413, { error: "Request body is too large" })]).f).catch((e) => e);
    assert.match(e413.message, /4 MB/);
    const e502 = await postMetadata("https://api", {}, fakeFetch([json(502, { error: "internal detail" })]).f).catch((e) => e);
    assert.equal(e502.status, 502);
    assert.doesNotMatch(e502.message, /internal detail/);
    assert.match(e502.message, /Try again/);
    const net = await postMetadata("https://api", {}, fakeFetch([new TypeError("Failed to fetch")]).f).catch((e) => e);
    assert.equal(net.status, 0);
    const odd = await postMetadata("https://api", {}, fakeFetch([json(200, { uri: "javascript:alert(1)" })]).f).catch((e) => e);
    assert.ok(odd instanceof MetadataUploadError);
  });
});

describe("uploadLaunchMetadata", () => {
  const req = (over: Partial<Parameters<typeof uploadLaunchMetadata>[2]> = {}) => ({ name: "Sad Pigeon", symbol: "PIGN", input: { description: "d" }, firstBuy: true, ...over });

  it("signs once (shared with prepare), uploads, reports the steps, caches by form content", async () => {
    const { f, calls } = fakeFetch([]);
    const steps: string[] = [];
    const out = await uploadLaunchMetadata("https://api", signer, req(), false, (s) => steps.push(s), f);
    assert.equal(out.uri, URI);
    assert.deepEqual(steps, ["auth", "upload"]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api/v1/launch/metadata");
    assert.equal(signs, 1);
    // prepare will reuse this exact signed message
    assert.deepEqual(cachedLaunchAuth(creator, "PIGN"), calls[0].body.auth);
    // same content: no second upload, no second signature
    await uploadLaunchMetadata("https://api", signer, req(), false, () => {}, f);
    assert.equal(calls.length, 1);
    // anything changed (first buy, description, image): uploads again, still one signature
    await uploadLaunchMetadata("https://api", signer, req({ firstBuy: false }), false, () => {}, f);
    await uploadLaunchMetadata("https://api", signer, req({ input: { description: "other" } }), false, () => {}, f);
    assert.equal(calls.length, 3);
    assert.equal(signs, 1);
  });

  it("a different image file is a different upload, the same file object is not", () => {
    const a = new Blob([new Uint8Array([1])]);
    const b = new Blob([new Uint8Array([1])]);
    const k = (image: Blob) => metadataCacheKey({ creator, name: "N", symbol: "S", input: { image }, firstBuy: false });
    assert.equal(k(a), k(a));
    assert.notEqual(k(a), k(b));
  });

  it("a cached auth the API refuses (401) is dropped and signed again, once", async () => {
    const first = fakeFetch([]);
    await uploadLaunchMetadata("https://api", signer, req(), false, () => {}, first.f); // caches an auth
    const { f, calls } = fakeFetch([json(401, { error: "auth message expired, sign again" })]);
    await uploadLaunchMetadata("https://api", signer, req({ input: { description: "new" } }), false, () => {}, f);
    assert.equal(calls.length, 2);
    assert.equal(signs, 2);
    assert.notDeepEqual(calls[0].body.auth, calls[1].body.auth);
  });

  it("a failure isn't cached: the retry uploads again", async () => {
    const { f, calls } = fakeFetch([json(502, { error: "x" })]);
    await assert.rejects(uploadLaunchMetadata("https://api", signer, req(), false, () => {}, f), MetadataUploadError);
    const out = await uploadLaunchMetadata("https://api", signer, req(), false, () => {}, f);
    assert.equal(out.uri, URI);
    assert.equal(calls.length, 2);
  });

  it("a wallet rejection says nothing was reserved", async () => {
    const no: FumpadSigner = { ...signer, signMessage: async () => Promise.reject(new Error("User rejected the request")) };
    await assert.rejects(uploadLaunchMetadata("https://api", no, req(), false, () => {}, fakeFetch([]).f), /didn't confirm/);
  });
});
