/**
 * v0.5 compatibility with the still-live v0.4 devnet program (and pre-upgrade history):
 * events and the Global account in their older, shorter layouts must still decode.
 */
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { decodeGlobal, GLOBAL_ACCOUNT_LEN, globalNeedsMigration, isPaused, upgradeLegacyGlobal } from "../src/accounts.js";
import { bn } from "../src/borsh.js";
import { FUMPAD_IDL, fumpadCoder } from "../src/coder.js";
import { EVENT_IX_TAG, FUMPAD_PROGRAM_ID, PAUSE_CLAIMS, PAUSE_TRADE } from "../src/constants.js";
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

describe("legacy (672 / 680-byte) Global", () => {
  const guardian = Keypair.generate().publicKey;
  const current = () => {
    const g = {
      bump: 255, admin: user, platform_treasury: mint, keepers: [user, mint, user], paused: 2,
      params: paramsToIdl({ ...DEFAULT_PARAMS, feeBps: 120 }),
      guardian, pause_expires_at: bn(77n), pending_admin_eta: bn(0n), reserved: new Array(80).fill(0),
      pending_params: paramsToIdl(DEFAULT_PARAMS), pending_eta: bn(5n),
      pending_admin: mint, pending_treasury: mint, pending_guardian: mint,
    };
    return fumpadCoder().accounts.encode("Global", g);
  };
  /** Pre-v0.6 bytes: governance tail dropped, carved region zeroed, `cut` bytes off both Params. */
  const legacy = (d: Uint8Array, cut: number) => {
    const o = 170;
    const region = new Uint8Array(128);
    region.set(d.subarray(o + 187 + 48, o + 187 + 128), 48);
    return Uint8Array.from([
      ...d.subarray(0, o + 187 - cut), ...region, ...d.subarray(o + 187 + 128, o + 187 + 128 + 187 - cut), ...d.subarray(o + 2 * 187 + 128, d.length - 96),
    ]);
  };

  it("current layout: 776 bytes (v0.6), no migration needed", async () => {
    const d = new Uint8Array(await current());
    expect(d.length).toBe(GLOBAL_ACCOUNT_LEN);
    expect(GLOBAL_ACCOUNT_LEN).toBe(776);
    expect(globalNeedsMigration(d)).toBe(false);
    const g = decodeGlobal(d);
    expect(g.legacyLayout).toBeUndefined();
    expect(g.params.snipeWindowSlots).toBe(4);
    expect(g.guardian.equals(guardian)).toBe(true);
    expect(g.pauseExpiresAt).toBe(77n);
    expect(g.pendingAdmin.equals(mint)).toBe(true);
    expect(isPaused(g, PAUSE_TRADE, 76n)).toBe(true);
    expect(isPaused(g, PAUSE_TRADE, 77n)).toBe(false);
    expect(isPaused(g, PAUSE_CLAIMS, 0n)).toBe(false);
  });

  it("decodes the 672-byte (v0.4) and 680-byte (v0.5) layouts as an old program behaves", async () => {
    const d = new Uint8Array(await current());
    for (const [cut, len, snipe] of [[4, 672, 0], [0, 680, 4]] as const) {
      const old = legacy(d, cut);
      expect(old.length).toBe(len);
      expect(globalNeedsMigration(old)).toBe(true);
      const g = decodeGlobal(old);
      expect(g.legacyLayout).toBe(true);
      expect(g.params.feeBps).toBe(120);
      expect(g.params.snipeWindowSlots).toBe(snipe);
      expect(g.pendingEta).toBe(5n);
      expect(g.paused).toBe(2);
      expect(g.admin.equals(user)).toBe(true);
      expect(g.guardian.equals(user)).toBe(true); // guardian = admin (what migrate_global sets)
      expect(isPaused(g, PAUSE_TRADE, 1n << 40n)).toBe(true); // pre-v0.6 pauses never lapse
      expect(g.pendingAdminEta).toBe(0n);
      expect(upgradeLegacyGlobal(old).length).toBe(776);
    }
    expect(() => upgradeLegacyGlobal(d.subarray(0, 600))).toThrow(/unknown Global layout/);
  });
});

describe("legacy (v0.5) admin events", () => {
  it("decodes v0.5 ParamsCancelled / GlobalMigrated (v0.6 appended fields) as zero, flagged legacy", () => {
    const pc = payload("ParamsCancelled", { ts: bn(9n), authority: user });
    const gm = payload("GlobalMigrated", {
      old_len: 672, new_len: 680, snipe_window_slots: 4, snipe_start_bps: 9_900, rent_paid: bn(5n), ts: bn(6n), guardian: user, pause_expires_at: bn(7n),
    });
    const evs = decodeTransactionEvents(txOf([legacy(pc, 32), legacy(gm, 40), pc]));
    expect(evs.map((e) => [e.name, e.legacy])).toEqual([["ParamsCancelled", true], ["GlobalMigrated", true], ["ParamsCancelled", undefined]]);
    if (evs[0].name !== "ParamsCancelled" || evs[1].name !== "GlobalMigrated" || evs[2].name !== "ParamsCancelled") throw new Error();
    expect(evs[0].data.ts).toBe(9n);
    expect(evs[0].data.authority.toBase58()).toBe("11111111111111111111111111111111");
    expect(evs[1].data.rentPaid).toBe(5n);
    expect(evs[1].data.pauseExpiresAt).toBe(0n);
    expect(evs[2].data.authority.equals(user)).toBe(true);
  });
});
