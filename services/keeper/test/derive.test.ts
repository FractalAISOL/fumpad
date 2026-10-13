// deriveCoin against a fake RPC: L3 (a guardian void that lists only the ticket PDA is found on the FIRST
// derivation after a restart), L8 (history floor / launch slot checks), V7-M6 (bounded caches, budget).
import { readFileSync } from "node:fs";

import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { type ConfirmedTx, normalizeTx, parsePoolFacts, type SignatureInfo } from "@fumpad/meteora";
import { type CoinAccount, coinPda, DEFAULT_PARAMS, EVENT_IX_TAG, eventAuthorityPda, FUMPAD_IDL, FUMPAD_PROGRAM_ID, fumpadCoder, type GlobalAccount, toIdl } from "@fumpad/sdk";

import { deriveCoin, newCaches } from "../src/attest/derive.js";
import { guardHistory, RpcHistoryIncomplete } from "../src/attest/history-check.js";

const launchTx = JSON.parse(readFileSync(new URL("../../meteora/test/fixtures/dbc_pool_init.json", import.meta.url), "utf8")) as ConfirmedTx;
const facts = parsePoolFacts(launchTx).dbcPools[0];
const MINT = new PublicKey(facts.baseMint);
const ticket = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;

function eventIx(name: string, data: Record<string, unknown>): string {
  const disc = (FUMPAD_IDL as unknown as { events: { name: string; discriminator: number[] }[] }).events.find((e) => e.name === name)!.discriminator;
  return bs58.encode(Uint8Array.from([...EVENT_IX_TAG, ...disc, ...fumpadCoder().types.encode(name, toIdl(data) as never)]));
}
/** A fumpad tx emitting `events`, listing `extra` accounts (e.g. only the ticket PDA for a void). */
function fumpadTx(slot: number, extra: string[], events: string[]): ConfirmedTx {
  return {
    slot,
    blockTime: (launchTx.blockTime ?? 0) + (slot - launchTx.slot),
    transaction: {
      signatures: [bs58.encode(Keypair.generate().secretKey)],
      message: { accountKeys: [Keypair.generate().publicKey.toBase58(), FUMPAD_PROGRAM_ID.toBase58(), eventAuthorityPda().toBase58(), ...extra], header: { numRequiredSignatures: 1 }, instructions: [] },
    },
    meta: { err: null, innerInstructions: [{ index: 0, instructions: events.map((data) => ({ programIdIndex: 1, accounts: [2], data, stackHeight: 2 })) }], preTokenBalances: [], postTokenBalances: [] },
  } as unknown as ConfirmedTx;
}

class FakeRpc {
  txs: ConfirmedTx[] = [];
  first = 0;
  calls = 0;
  async getSlot() {
    this.calls++;
    return launchTx.slot + 10_000;
  }
  async getSignaturesForAddress(addr: string, o: { until?: string }): Promise<SignatureInfo[]> {
    this.calls++;
    const out: SignatureInfo[] = [];
    for (const t of [...this.txs].sort((a, b) => b.slot - a.slot)) {
      if (!normalizeTx(t).accountKeys.includes(addr)) continue;
      if (t.transaction.signatures[0] === o.until) break;
      out.push({ signature: t.transaction.signatures[0], slot: t.slot, err: null, blockTime: t.blockTime ?? null } as SignatureInfo);
    }
    return out;
  }
  async getTransaction(s: string) {
    this.calls++;
    return this.txs.find((t) => t.transaction.signatures[0] === s) ?? null;
  }
  async call<T>(method: string, params: unknown[]): Promise<T> {
    this.calls++;
    if (method === "getAccountInfo") return { value: { data: [Buffer.alloc(1048).toString("base64"), "base64"], owner: "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN" } } as T;
    if (method === "getFirstAvailableBlock") return this.first as T;
    if (method === "getBlock") return { signatures: this.txs.filter((t) => t.slot === params[0]).map((t) => t.transaction.signatures[0]) } as T;
    throw new Error(method);
  }
}

const coin = {
  mint: MINT,
  dbcPool: new PublicKey(facts.pool),
  dbcConfig: new PublicKey(facts.config),
  creator: new PublicKey(facts.creator),
  dammPool: PublicKey.default,
  launchSlot: BigInt(launchTx.slot),
  rewards: { minSellUsdCents: 5_000n, minHoldSecs: 600n, rebuyWindowSecs: 604_800n, maxOpenTickets: 5, claimBps: 1_000 },
} as unknown as CoinAccount;
const g = { params: DEFAULT_PARAMS } as unknown as GlobalAccount;
const deps = (rpc: FakeRpc) => ({ rpc: rpc as never, fetchPrice: async () => null, caches: newCaches({ txs: 1_000, blocks: 100 }) });

function world() {
  const rpc = new FakeRpc();
  rpc.txs.push(launchTx);
  const attest = fumpadTx(launchTx.slot + 100, [coinPda(MINT).toBase58(), ticket.toBase58()], [
    eventIx("TicketAttested", {
      mint: MINT, owner, ticket, seq: 0n, pool: new PublicKey(facts.pool), venue: 0, source: 0,
      signature: Array.from(new Uint8Array(64).fill(3)), ixKey: 0, baseAmount: 1n, quoteGross: 1n, tokens: 1n, sellPriceQ64: 1n,
      sellUsdCents: 6_000n, pythPublishTime: 1n, slot: 1n, sellTs: 1n, keepers: [owner, owner], submitter: owner, ts: 1n, effectiveAt: 1n,
    }),
  ]);
  // guardian void: since the contracts fix it lists the Coin PDA + mint (INTERFACE §8.2)
  const voided = fumpadTx(launchTx.slot + 200, [coinPda(MINT).toBase58(), MINT.toBase58(), ticket.toBase58()], [
    eventIx("TicketVoided", { ticket, mint: MINT, owner, reason: 1, authority: owner, ts: 2n, coin: coinPda(MINT), reopened: false }),
  ]);
  rpc.txs.push(attest, voided);
  return { rpc, voided };
}

describe("deriveCoin", () => {
  it("L3: a guardian void is in the very first derivation after a restart (fresh caches)", async () => {
    const { rpc, voided } = world();
    const d = await deriveCoin(deps(rpc), coin, g);
    expect(d.history.map((h) => h.tx.transaction.signatures[0])).toContain(voided.transaction.signatures[0]);
  });

  it("L8: a coin launched before the RPC's first available block is refused", async () => {
    const { rpc } = world();
    rpc.first = launchTx.slot + 1;
    const guarded = guardHistory(rpc as never, (c, gg) => deriveCoin(deps(rpc), c, gg));
    await expect(guarded(coin, g)).rejects.toBeInstanceOf(RpcHistoryIncomplete);
    rpc.first = 0;
    await expect(guarded(coin, g)).rejects.toBeInstanceOf(RpcHistoryIncomplete); // cached floor until refresh
    const fresh = guardHistory(rpc as never, (c, gg) => deriveCoin(deps(rpc), c, gg));
    await expect(fresh(coin, g)).resolves.toBeTruthy();
  });

  it("L8: a pool creation found after Coin.launch_slot means the history is incomplete", async () => {
    const { rpc } = world();
    await expect(deriveCoin(deps(rpc), { ...coin, launchSlot: BigInt(launchTx.slot - 1) } as CoinAccount, g)).rejects.toThrow(/history incomplete/);
  });

  it("V7-M6: a per-coin RPC budget stops the derivation; the next one resumes from the saved crawl state", async () => {
    const { rpc } = world();
    const d = deps(rpc);
    await expect(deriveCoin({ ...d, maxRpcCalls: 3 }, coin, g)).rejects.toThrow(/budget/);
    const full = await deriveCoin({ ...d, maxRpcCalls: 1_000 }, coin, g);
    const before = rpc.calls;
    const again = await deriveCoin({ ...d, maxRpcCalls: 1_000 }, coin, g);
    expect(again.history.length).toBe(full.history.length);
    expect(rpc.calls - before).toBeLessThan(10); // incremental: cursors only
  });
});
