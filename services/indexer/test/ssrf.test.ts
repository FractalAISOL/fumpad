/**
 * M-3 regression (was security-review/services-poc/metadata-ssrf.test.ts): a coin `uri`
 * pointing at (or redirecting to) loopback / private / link-local hosts made the indexer
 * fetch it and publish the response. Now every hop is resolved and checked, redirects are
 * followed manually (max 3), schemes are https/ipfs/ar only, and errors are coarse codes.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ChainSync } from "../src/chainSync.js";
import { isPublicAddress, resolveMetadataUrl, safeFetch, SafeFetchError } from "../src/safeFetch.js";

let internal: Server;
let attacker: Server;
let internalHits = 0;
let v6 = true;

beforeAll(async () => {
  internal = createServer((req, res) => {
    internalHits++;
    if (req.url === "/secret") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ description: "INTERNAL-ONLY DATA" }));
    res.writeHead(404).end();
  });
  // Internal service on IPv6 loopback; the "attacker" on 127.0.0.1 redirects to it.
  await new Promise<void>((r, j) => internal.once("error", j).listen(0, "::1", r)).catch(async () => {
    v6 = false;
    await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
  });
  attacker = createServer((req, res) => {
    const { port } = internal.address() as AddressInfo;
    const host = v6 ? "[::1]" : "localhost";
    if (req.url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
    res.writeHead(302, { location: `http://${host}:${port}/secret` }).end();
  });
  await new Promise<void>((r) => attacker.listen(0, "127.0.0.1", r));
});
afterAll(() => {
  internal.close();
  attacker.close();
});

const attackerUrl = (path = "/m.json") => `http://127.0.0.1:${(attacker.address() as AddressInfo).port}${path}`;

describe("M-3 metadata SSRF is blocked", () => {
  it("the PoC: ChainSync no longer fetches a loopback uri, stores only a coarse error", async () => {
    let stored: Record<string, unknown> | undefined;
    const db = {
      async query(sql: string, params: unknown[]) {
        if (sql.startsWith("SELECT uri")) return { rows: [{ uri: attackerUrl(), metadata: null }] };
        if (sql.startsWith("UPDATE coins SET metadata")) stored = JSON.parse(params[1] as string);
        return { rows: [] };
      },
    };
    const sync = new ChainSync({} as never, db as never, { warn() {} } as never, { debounceMs: 0, fetchMetadata: true });
    await (sync as unknown as { fetchMetadata(m: string): Promise<void> }).fetchMetadata("AnyMint");
    expect(stored?.description).toBeUndefined();
    expect(stored?.error).toBe("scheme"); // http:// refused outright
    expect(internalHits).toBe(0);
  });

  it("a redirect into the private network is re-checked and refused (even if the first hop were allowed)", async () => {
    // Pretend 127.0.0.1 is a public host to exercise the per-hop check.
    const err = await safeFetch(attackerUrl(), { allowHttp: true, isAllowedAddress: (ip) => ip === "127.0.0.1" }).catch((e) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).code).toBe("blocked");
    expect(internalHits).toBe(0);
  });

  it("redirect loops stop after 3 hops", async () => {
    const err = await safeFetch(attackerUrl("/loop"), { allowHttp: true, isAllowedAddress: (ip) => ip === "127.0.0.1" }).catch((e) => e);
    expect((err as SafeFetchError).code).toBe("redirects");
  });

  it("direct private / loopback / metadata targets are refused before connecting", async () => {
    for (const u of ["https://127.0.0.1/x", "https://169.254.169.254/latest/meta-data", "https://[::1]/x", "https://10.0.0.5/x", "https://[::ffff:127.0.0.1]/x", "https://localhost/x"]) {
      const e = await safeFetch(u).catch((x) => x);
      expect((e as SafeFetchError).code, u).toBe("blocked");
    }
    for (const u of ["http://example.com/x", "file:///etc/passwd", "gopher://x", "https://user:pw@example.com/", "ftp://x"]) {
      const e = await safeFetch(u).catch((x) => x);
      expect((e as SafeFetchError).code, u).toBe("scheme");
    }
    expect(((await safeFetch("https://example.com:8443/x").catch((x) => x)) as SafeFetchError).code).toBe("blocked");
  });

  it("address policy", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd12::1", "fe80::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "2001:db8::1"])
      expect(isPublicAddress(ip), ip).toBe(false);
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it("ipfs:// and ar:// map to https gateways; nothing else is rewritten", () => {
    expect(resolveMetadataUrl("ipfs://bafyabc/meta.json").toString()).toBe("https://ipfs.io/ipfs/bafyabc/meta.json");
    expect(resolveMetadataUrl("ipfs://bafyabc", { ipfsGateway: "https://gw.example/ipfs" }).toString()).toBe("https://gw.example/ipfs/bafyabc");
    expect(resolveMetadataUrl("ar://txid").toString()).toBe("https://arweave.net/txid");
    expect(() => resolveMetadataUrl("ipfs://")).toThrow();
  });
});
