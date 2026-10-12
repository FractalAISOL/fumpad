/**
 * v0.5 compatibility with the still-live v0.4 devnet program (and pre-upgrade history):
 * events and the Global account in their older, shorter layouts must still decode.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { decodeGlobal, GLOBAL_ACCOUNT_LEN, globalNeedsMigration, upgradeLegacyGlobal } from "../src/accounts.js";
import { bn } from "../src/borsh.js";
import { FUMPAD_IDL, fumpadCoder } from "../src/coder.js";
import { EVENT_IX_TAG, FUMPAD_PROGRAM_ID } from "../src/constants.js";
import { decodeEventRaw, decodeTransactionEvents, type TxLike } from "../src/events.js";
import { paramsToIdl } from "../src/instructions/fumpad.js";
import { DEFAULT_PARAMS } from "../src/params.js";
import { eventAuthorityPda } from "../src/pda.js";

const mint = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;

const disc = (name: string) =>
  Uint8Array.from((FUMPAD_IDL.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)!.discriminator);
const payload = (name: string, data: Record<string, unknown>) => Uint8Array.from([...disc(name), ...fumpadCoder().types.encode(name, data)]);
/** Drop `n` bytes at body offset `at` (end if undefined) — the pre-v0.5 layout. */
function legacy(p: Uint8Array, n: number, at?: number): Uint8Array {
  const body = p.subarray(8);
  const cut = at ?? body.length - n;
  return Uint8Array.from([...p.subarray(0, 8), ...body.subarray(0, cut), ...body.subarray(cut + n)]);
}

function txOf(payloads: Uint8Array[]): TxLike {
  return {
    slot: 1,
    blockTime: 1,
    transaction: { signatures: ["s"], message: { accountKeys: [user.toBase58(), FUMPAD_PROGRAM_ID.toBase58(), eventAuthorityPda().toBase58()], instructions: [] } },
    meta: {
      err: null,
      logMessages: [],
      innerInstructions: [{ index: 0, instructions: payloads.map((p) => ({ programIdIndex: 1, accounts: [2], data: bs58.encode(Uint8Array.from([...EVENT_IX_TAG, ...p])) })) }],
    },
  };
}

const trade = {
  mint, user, is_buy: true, on_amm: false, token_amount: bn(1_000n), sol_amount: bn(2_000n), fee_pool: bn(10n), fee_platform: bn(6n),
  fee_creator: bn(4n), pool_tokens_bought: bn(99n), price_q64: bn(1n << 64n), virtual_sol_reserves: bn(3n), virtual_token_reserves: bn(4n),
  ts: bn(1_800_000_000n), snipe_tax: bn(6_000n), snipe_tax_bps: 7_500,
};
const graduated = {
  mint, pool: user, sol_deposited: bn(84_350_000_000n), tokens_deposited: bn(5n), lp_locked: bn(6n), ts: bn(7n),
  caller_refund: bn(13_000_000n), setup_prefunded: bn(630_000_000n), platform_fee: bn(7_000_000n),
};

describe("legacy (v0.4) events", () => {
  it("decodes v0.5 Trade + Graduated with the new fields", () => {
    const evs = decodeTransactionEvents(txOf([payload("Trade", trade), payload("Graduated", graduated)]));
    expect(evs.map((e) => [e.name, e.legacy])).toEqual([["Trade", undefined], ["Graduated", undefined]]);
    if (evs[0].name !== "Trade" || evs[1].name !== "Graduated") throw new Error();
    expect(evs[0].data.snipeTax).toBe(6_000n);
    expect(evs[0].data.snipeTaxBps).toBe(7_500);
    expect(evs[1].data.setupPrefunded).toBe(630_000_000n);
    expect(evs[1].data.callerRefund + evs[1].data.setupPrefunded + evs[1].data.platformFee).toBe(650_000_000n);
  });

  it("decodes v0.4 Trade / Graduated (no appended fields) as zero, flagged legacy", () => {
    const t = legacy(payload("Trade", trade), 10);
    const g = legacy(payload("Graduated", graduated), 24);
    const evs = decodeTransactionEvents(txOf([t, g]));
    expect(evs.map((e) => [e.name, e.legacy])).toEqual([["Trade", true], ["Graduated", true]]);
    if (evs[0].name !== "Trade" || evs[1].name !== "Graduated") throw new Error();
    expect(evs[0].data.solAmount).toBe(2_000n);
    expect(evs[0].data.ts).toBe(1_800_000_000n);
    expect(evs[0].data.snipeTax).toBe(0n);
    expect(evs[0].data.snipeTaxBps).toBe(0);
    expect(evs[1].data.solDeposited).toBe(84_350_000_000n);
    expect(evs[1].data.platformFee).toBe(0n);
    // Replay path: the stored raw (original legacy bytes) re-decodes the same way.
    const re = decodeEventRaw("fumpad", evs[0].raw);
    expect(re?.name).toBe("Trade");
    expect(re?.legacy).toBe(true);
    expect((re?.data as { tokenAmount: bigint }).tokenAmount).toBe(1_000n);
  });

  it("decodes v0.4 ParamsUpdated / ParamsQueued (Params 4 bytes shorter, mid-struct)", () => {
    const params = paramsToIdl({ ...DEFAULT_PARAMS, snipeWindowSlots: 0, snipeStartBps: 0, feeBps: 150 });
    const up = legacy(payload("ParamsUpdated", { params, ts: bn(42n) }), 4, 183);
    const q = legacy(payload("ParamsQueued", { params, eta: bn(99n), ts: bn(42n) }), 4, 183);
    const evs = decodeTransactionEvents(txOf([up, q]));
    expect(evs.map((e) => e.name)).toEqual(["ParamsUpdated", "ParamsQueued"]);
    if (evs[0].name !== "ParamsUpdated" || evs[1].name !== "ParamsQueued") throw new Error();
    expect(evs[0].data.ts).toBe(42n);
    expect((evs[0].data.params as { feeBps: number }).feeBps).toBe(150);
    expect((evs[0].data.params as { snipeWindowSlots: number }).snipeWindowSlots).toBe(0);
    expect(evs[1].data.eta).toBe(99n);
  });

  it("still throws on payloads no known layout explains", () => {
    expect(() => decodeTransactionEvents(txOf([legacy(payload("Trade", trade), 30)]))).toThrow();
  });
});

describe("legacy (672-byte) Global", () => {
  const current = () => {
    const g = {
      bump: 255, admin: user, platform_treasury: mint, keepers: [user, mint, user], paused: 2,
      params: paramsToIdl({ ...DEFAULT_PARAMS, feeBps: 120 }), reserved: new Array(128).fill(0),
      pending_params: paramsToIdl(DEFAULT_PARAMS), pending_eta: bn(5n),
    };
    return fumpadCoder().accounts.encode("Global", g);
  };

  it("current layout: 680 bytes, no migration needed", async () => {
    const d = new Uint8Array(await current());
    expect(d.length).toBe(GLOBAL_ACCOUNT_LEN);
    expect(GLOBAL_ACCOUNT_LEN).toBe(680);
    expect(globalNeedsMigration(d)).toBe(false);
    const g = decodeGlobal(d);
    expect(g.legacyLayout).toBeUndefined();
    expect(g.params.snipeWindowSlots).toBe(4);
  });

  it("decodes the 672-byte layout with the snipe params zeroed", async () => {
    const d = new Uint8Array(await current());
    const o = 170;
    const old = Uint8Array.from([...d.subarray(0, o + 183), ...d.subarray(o + 187, o + 187 + 128 + 183), ...d.subarray(o + 187 + 128 + 187)]);
    expect(old.length).toBe(672);
    expect(globalNeedsMigration(old)).toBe(true);
    const g = decodeGlobal(old);
    expect(g.legacyLayout).toBe(true);
    expect(g.params.feeBps).toBe(120);
    expect(g.params.snipeWindowSlots).toBe(0);
    expect(g.pendingEta).toBe(5n);
    expect(g.paused).toBe(2);
    expect(g.admin.equals(user)).toBe(true);
    expect(upgradeLegacyGlobal(old).length).toBe(680);
    expect(() => upgradeLegacyGlobal(old.subarray(0, 600))).toThrow(/unknown Global layout/);
  });
});


