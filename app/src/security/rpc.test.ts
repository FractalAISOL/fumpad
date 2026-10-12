/** M-8 build-time RPC warnings. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rpcWarnings } from "./rpc";

describe("rpcWarnings", () => {
  it("warns when the frontend RPC reuses the backend key", () => {
    const w = rpcWarnings({ NEXT_PUBLIC_SOLANA_RPC: "https://mainnet.helius-rpc.com/?api-key=SECRET", HELIUS_API_KEY: "SECRET" });
    assert.ok(w.some((x) => /reuses the backend/.test(x)));
    const w2 = rpcWarnings({ NEXT_PUBLIC_SOLANA_RPC: "https://mainnet.helius-rpc.com/?api-key=A", RPC_URL: "https://mainnet.helius-rpc.com/?api-key=A" });
    assert.ok(w2.some((x) => /reuses the backend/.test(x)));
  });
  it("reminds that a keyed RPC is public, and flags a missing RPC in production", () => {
    assert.ok(rpcWarnings({ NEXT_PUBLIC_SOLANA_RPC: "https://mainnet.helius-rpc.com/?api-key=FRONT" }).some((x) => /domain|restricted/.test(x)));
    assert.deepEqual(rpcWarnings({ NEXT_PUBLIC_SOLANA_RPC: "https://api.devnet.solana.com" }), []);
    assert.equal(rpcWarnings({ NODE_ENV: "production" }).length, 1);
    assert.deepEqual(rpcWarnings({}), []);
  });
});
