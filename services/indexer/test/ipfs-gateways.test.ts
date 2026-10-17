/**
 * IPFS content through an ordered gateway list (dedicated Pinata gateway → public gateway → the original URL), the
 * PINATA_GATEWAY / IPFS_GATEWAY config, metadata field picking (pump.fun / extensions / Metaplex) and the retry of
 * metadata that failed to load. Gateways are local http servers (allowHttp + a test address policy): no network.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChainSync, METADATA_MAX_ATTEMPTS, metadataRetryDue, pickMetadata } from "../src/chainSync.js";
import { ipfsGatewaysFromEnv, pinataGatewayFromEnv } from "../src/config.js";
import { fetchCandidates, ipfsPathOf, safeFetch } from "../src/safeFetch.js";

const V0 = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const V1 = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const env = (e: Record<string, string>) => e as NodeJS.ProcessEnv;

let dead: Server;
let good: Server;
const hits = { dead: 0, good: 0 };
beforeAll(async () => {
  dead = createServer((_req, res) => {
    hits.dead++;
    res.writeHead(404).end();
  });
  good = createServer((req, res) => {
    hits.good++;
    if (req.url === `/ipfs/${V0}`) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ name: "Sad Pigeon", image: `ipfs://${V1}`, twitter: "https://x.com/sadpigeon" }));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => good.listen(0, "127.0.0.1", r));
});
afterAll(() => {
  dead.close();
  good.close();
});
const gw = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}/ipfs/`;
const local = { allowHttp: true, isAllowedAddress: (ip: string) => ip === "127.0.0.1" };

describe("IPFS paths and candidates", () => {
  it("ipfsPathOf: ipfs:// and path-style gateway URLs; nothing else", () => {
    expect(ipfsPathOf(`ipfs://${V0}`)).toBe(V0);
    expect(ipfsPathOf(`ipfs://ipfs/${V0}/a.json`)).toBe(`${V0}/a.json`);
    expect(ipfsPathOf(`https://ipfs.io/ipfs/${V1}`)).toBe(V1);
    expect(ipfsPathOf(`https://gateway.pinata.cloud/ipfs/${V0}?x=1#y`)).toBe(V0);
    expect(ipfsPathOf("https://example.com/ipfs/not-a-cid")).toBeNull();
    expect(ipfsPathOf(`https://example.com/x/ipfs/${V0}`)).toBeNull();
    expect(ipfsPathOf(`http://ipfs.io/ipfs/${V0}`)).toBeNull();
    expect(ipfsPathOf(`ipfs://${V0}/../../etc`)).toBeNull();
    expect(ipfsPathOf("https://arweave.net/abc")).toBeNull();
  });

  it("fetchCandidates: dedicated gateway, public gateway, then the original; unchanged without a list", () => {
    const gws = ["https://fumpad.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/"];
    expect(fetchCandidates(`https://ipfs.io/ipfs/${V0}`, { ipfsGateways: gws }).map(String)).toEqual([`https://fumpad.mypinata.cloud/ipfs/${V0}`, `https://ipfs.io/ipfs/${V0}`]);
    expect(fetchCandidates(`https://cf-ipfs.example/ipfs/${V0}`, { ipfsGateways: gws }).map(String)).toEqual([
      `https://fumpad.mypinata.cloud/ipfs/${V0}`,
      `https://ipfs.io/ipfs/${V0}`,
      `https://cf-ipfs.example/ipfs/${V0}`,
    ]);
    expect(fetchCandidates(`ipfs://${V0}`, { ipfsGateways: gws }).map(String)).toEqual([`https://fumpad.mypinata.cloud/ipfs/${V0}`, `https://ipfs.io/ipfs/${V0}`]);
    expect(fetchCandidates("https://frog.fun/meta.json", { ipfsGateways: gws }).map(String)).toEqual(["https://frog.fun/meta.json"]);
    expect(fetchCandidates(`ipfs://${V0}`).map(String)).toEqual([`https://ipfs.io/ipfs/${V0}`]);
    // still refuses what it always refused
    expect(() => fetchCandidates("http://10.0.0.1/ipfs/x", { ipfsGateways: gws })).toThrow();
  });

  it("safeFetch falls through a gateway that doesn't have the CID", async () => {
    hits.dead = hits.good = 0;
    const r = await safeFetch(`https://ipfs.io/ipfs/${V0}`, { ...local, ipfsGateways: [gw(dead), gw(good)] });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body.toString()).name).toBe("Sad Pigeon");
    expect(hits).toEqual({ dead: 1, good: 1 });
    // every candidate failing: the last answer comes back
    const miss = await safeFetch(`ipfs://${V1}`, { ...local, ipfsGateways: [gw(dead), gw(good)] });
    expect(miss.status).toBe(404);
  });

  it("ChainSync stores the metadata fetched through the gateways", async () => {
    let stored: Record<string, unknown> | undefined;
    const db = {
      async query(sql: string, params: unknown[]) {
        if (sql.startsWith("SELECT uri")) return { rows: [{ uri: `ipfs://${V0}`, metadata: null }] };
        if (sql.startsWith("UPDATE coins SET metadata")) stored = JSON.parse(params[1] as string);
        return { rows: [] };
      },
    };
    const sync = new ChainSync({} as never, db as never, { warn() {} } as never, { debounceMs: 0, fetchMetadata: true, metadataFetch: { ...local, ipfsGateways: [gw(dead), gw(good)] } });
    await (sync as unknown as { fetchMetadata(m: string): Promise<void> }).fetchMetadata("AnyMint");
    expect(stored).toMatchObject({ image: `ipfs://${V1}`, twitter: "https://x.com/sadpigeon" });
    expect(stored?.error).toBeUndefined();
  });
});

describe("config", () => {
  it("PINATA_GATEWAY: a domain (or https URL) → https://<domain>/ipfs/; junk is a startup error", () => {
    expect(pinataGatewayFromEnv(env({}))).toBeUndefined();
    expect(pinataGatewayFromEnv(env({ PINATA_GATEWAY: "fumpad.mypinata.cloud" }))).toBe("https://fumpad.mypinata.cloud/ipfs/");
    expect(pinataGatewayFromEnv(env({ PINATA_GATEWAY: "https://Fumpad.mypinata.cloud/ipfs/" }))).toBe("https://fumpad.mypinata.cloud/ipfs/");
    for (const bad of ["http://x.mypinata.cloud", "localhost", "10.0.0.1", "x.mypinata.cloud:8080", "a b.cloud"]) expect(() => pinataGatewayFromEnv(env({ PINATA_GATEWAY: bad })), bad).toThrow(/PINATA_GATEWAY/);
  });
  it("ipfsGatewaysFromEnv: dedicated first, then IPFS_GATEWAY (default ipfs.io)", () => {
    expect(ipfsGatewaysFromEnv(env({}))).toEqual(["https://ipfs.io/ipfs/"]);
    expect(ipfsGatewaysFromEnv(env({ PINATA_GATEWAY: "g.mypinata.cloud" }))).toEqual(["https://g.mypinata.cloud/ipfs/", "https://ipfs.io/ipfs/"]);
    expect(ipfsGatewaysFromEnv(env({ PINATA_GATEWAY: "g.mypinata.cloud", IPFS_GATEWAY: "https://dweb.link/ipfs/" }))).toEqual(["https://g.mypinata.cloud/ipfs/", "https://dweb.link/ipfs/"]);
  });
});

describe("metadata fields + retry", () => {
  it("pickMetadata: top-level socials win, then extensions, then external_url", () => {
    expect(pickMetadata({ description: "d", image: "https://ipfs.io/ipfs/x", website: "https://a.fun", twitter: "https://x.com/a", telegram: "https://t.me/a", extensions: { website: "https://b.fun" } })).toEqual({
      description: "d",
      image: "https://ipfs.io/ipfs/x",
      website: "https://a.fun",
      twitter: "https://x.com/a",
      telegram: "https://t.me/a",
    });
    expect(pickMetadata({ extensions: { twitter: "https://x.com/b", telegram: "https://t.me/b" }, external_url: "https://c.fun" })).toMatchObject({ website: "https://c.fun", twitter: "https://x.com/b", telegram: "https://t.me/b" });
    expect(pickMetadata({ image: 5, description: "" })).toEqual({ description: undefined, image: undefined, website: undefined, twitter: undefined, telegram: undefined });
  });

  it("metadataRetryDue: failed fetches back off 1, 2, 4, 8, 16 min, then stop", () => {
    const now = 10_000_000_000;
    expect(metadataRetryDue({ fetchedAt: now - 30_000, error: "timeout" }, now)).toBe(false);
    expect(metadataRetryDue({ fetchedAt: now - 61_000, error: "timeout" }, now)).toBe(true);
    expect(metadataRetryDue({ fetchedAt: now - 3 * 60_000, error: "timeout", attempts: 3 }, now)).toBe(false);
    expect(metadataRetryDue({ fetchedAt: now - 4 * 60_000, error: "timeout", attempts: 3 }, now)).toBe(true);
    expect(metadataRetryDue({ fetchedAt: 0, error: "timeout", attempts: METADATA_MAX_ATTEMPTS }, now)).toBe(false);
    expect(metadataRetryDue({ fetchedAt: 0, description: "ok" }, now)).toBe(false);
  });

  it("a due failure is fetched again and replaced; a fresh failure counts its attempt", async () => {
    const writes: Record<string, unknown>[] = [];
    let current: Record<string, unknown> = { fetchedAt: 0, error: "timeout", attempts: 2 };
    const db = {
      async query(sql: string, params: unknown[]) {
        if (sql.includes("WHERE metadata ? 'error'")) return { rows: [{ mint: "M", metadata: current }] };
        if (sql.startsWith("SELECT uri")) return { rows: [{ uri: `ipfs://${V0}`, metadata: current }] };
        if (sql.startsWith("UPDATE coins SET metadata")) {
          current = JSON.parse(params[1] as string);
          writes.push(current);
        }
        return { rows: [] };
      },
    };
    const failing = new ChainSync({} as never, db as never, { warn() {} } as never, { debounceMs: 0, fetchMetadata: true, metadataFetch: { ...local, ipfsGateways: [gw(dead)] } });
    expect(await failing.retryMetadata()).toBe(1);
    expect(writes.at(-1)).toMatchObject({ error: "http", attempts: 3 });
    // not due again right away
    expect(await failing.retryMetadata()).toBe(0);
    current = { ...current, fetchedAt: 0 };
    const ok = new ChainSync({} as never, db as never, { warn() {} } as never, { debounceMs: 0, fetchMetadata: true, metadataFetch: { ...local, ipfsGateways: [gw(good)] } });
    expect(await ok.retryMetadata()).toBe(1);
    expect(writes.at(-1)).toMatchObject({ image: `ipfs://${V1}` });
    expect(writes.at(-1)?.error).toBeUndefined();
  });
});
