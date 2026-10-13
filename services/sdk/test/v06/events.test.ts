import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { bn } from "../../src/v06/borsh.js";
import { fumpadCoder, lockerCoder, FUMPAD_IDL, LP_LOCKER_IDL } from "../../src/v06/coder.js";
import { EVENT_IX_TAG, FUMPAD_PROGRAM_ID, LP_LOCKER_PROGRAM_ID } from "../../src/v06/constants.js";
import { decodeTransactionEvents, type TxLike } from "../../src/v06/events.js";
import { eventAuthorityPda } from "../../src/v06/pda.js";

function discriminator(idl: typeof FUMPAD_IDL, name: string): Uint8Array {
  const ev = (idl.events as { name: string; discriminator: number[] }[]).find((e) => e.name === name)!;
  return Uint8Array.from(ev.discriminator);
}
function eventBytes(name: string, data: Record<string, unknown>, idl = FUMPAD_IDL, coder = fumpadCoder()): Uint8Array {
  const body = coder.types.encode(name, data);
  return Uint8Array.from([...discriminator(idl, name), ...body]);
}

const mint = Keypair.generate().publicKey;
const user = Keypair.generate().publicKey;
const pool = Keypair.generate().publicKey;

function tx(inner: { programIdIndex: number; accounts: number[]; data: string }[], logs: string[], err: unknown = null): TxLike {
  return {
    slot: 10,
    blockTime: 1_800_000_000,
    transaction: {
      signatures: ["sig"],
      message: { accountKeys: [user.toBase58(), FUMPAD_PROGRAM_ID.toBase58(), eventAuthorityPda().toBase58(), LP_LOCKER_PROGRAM_ID.toBase58(), Keypair.generate().publicKey.toBase58()], instructions: [] },
    },
    meta: { err, logMessages: logs, innerInstructions: [{ index: 0, instructions: inner }] },
  };
}

const tradeData = {
  mint,
  user,
  is_buy: true,
  on_amm: false,
  token_amount: bn(32_000_000_000_000n),
  sol_amount: bn(1_000_000_000n),
  fee_pool: bn(5_000_000n),
  fee_platform: bn(3_000_000n),
  fee_creator: bn(2_000_000n),
  pool_tokens_bought: bn(150_000_000_000n),
  price_q64: bn((1n << 64n) * 3n / 100n),
  virtual_sol_reserves: bn(31_000_000_000n),
  virtual_token_reserves: bn(987_000_000_000_000n),
  ts: bn(1_800_000_000n),
  snipe_tax: bn(495_000_000n),
  snipe_tax_bps: 5_000,
};

describe("event decoding", () => {
  it("decodes emit_cpi events from inner instructions (Trade, TicketCreated)", () => {
    const ticket = Keypair.generate().publicKey;
    const t1 = Uint8Array.from([...EVENT_IX_TAG, ...eventBytes("Trade", tradeData)]);
    const t2 = Uint8Array.from([
      ...EVENT_IX_TAG,
      ...eventBytes("TicketCreated", { mint, owner: user, ticket, tokens: bn(5n), sell_price_q64: bn(7n), sell_usd_cents: bn(5_000n), ts: bn(1n) }),
    ]);
    const evs = decodeTransactionEvents(
      tx(
        [
          { programIdIndex: 1, accounts: [2], data: bs58.encode(t1) },
          { programIdIndex: 4, accounts: [2], data: bs58.encode(t1) }, // other program: ignored
          { programIdIndex: 1, accounts: [0], data: bs58.encode(t2) }, // wrong authority: ignored
          { programIdIndex: 1, accounts: [2], data: bs58.encode(t2) },
        ],
        [],
      ),
    );
    expect(evs.map((e) => e.name)).toEqual(["Trade", "TicketCreated"]);
    const tr = evs[0];
    if (tr.name !== "Trade") throw new Error();
    expect(tr.data.tokenAmount).toBe(32_000_000_000_000n);
    expect(tr.data.isBuy).toBe(true);
    expect(tr.data.priceQ64).toBe(((1n << 64n) * 3n) / 100n);
    expect(tr.data.mint.equals(mint)).toBe(true);
    expect(tr.data.snipeTax).toBe(495_000_000n); // v0.5 D19
    expect(tr.data.snipeTaxBps).toBe(5_000);
    expect(evs[1].index).toBe(1);
  });

  it("decodes locker emit! events from logs only inside the locker's frame", () => {
    const sk = eventBytes(
      "Skimmed",
      { pool, mint, lp_withdrawn: bn(10n), base_out: bn(20n), quote_out: bn(30n), lp_held: bn(40n) },
      LP_LOCKER_IDL,
      lockerCoder(),
    );
    const b64 = Buffer.from(sk).toString("base64");
    const logs = [
      `Program ${LP_LOCKER_PROGRAM_ID.toBase58()} invoke [1]`,
      `Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [2]`,
      `Program data: ${b64}`, // emitted by PumpSwap frame: must be ignored
      `Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA success`,
      `Program data: ${b64}`,
      `Program ${LP_LOCKER_PROGRAM_ID.toBase58()} success`,
    ];
    const evs = decodeTransactionEvents(tx([], logs));
    expect(evs).toHaveLength(1);
    const e = evs[0];
    if (e.name !== "Skimmed") throw new Error();
    expect(e.program).toBe("locker");
    expect(e.data.quoteOut).toBe(30n);
  });

  it("ignores failed transactions", () => {
    const t1 = Uint8Array.from([...EVENT_IX_TAG, ...eventBytes("Trade", tradeData)]);
    expect(decodeTransactionEvents(tx([{ programIdIndex: 1, accounts: [2], data: bs58.encode(t1) }], [], { InstructionError: [0, "x"] }))).toEqual([]);
  });

  it("v0.4: ClaimPaid carries triggered_by (keeper auto-claim) and AutoClaimSet decodes", () => {
    const keeper = Keypair.generate().publicKey;
    const ticket = Keypair.generate().publicKey;
    const paid = Uint8Array.from([
      ...EVENT_IX_TAG,
      ...eventBytes("ClaimPaid", { mint, ticket, owner: user, amount: bn(9n), from_queue: false, median_price_q64: bn(3n), ts: bn(5n), triggered_by: keeper }),
    ]);
    const set = Uint8Array.from([...EVENT_IX_TAG, ...eventBytes("AutoClaimSet", { mint, wallet: user, enabled: false, ts: bn(6n) })]);
    const evs = decodeTransactionEvents(tx([{ programIdIndex: 1, accounts: [2], data: bs58.encode(paid) }, { programIdIndex: 1, accounts: [2], data: bs58.encode(set) }], []));
    expect(evs.map((e) => e.name)).toEqual(["ClaimPaid", "AutoClaimSet"]);
    const p = evs[0].data as { triggeredBy: PublicKey; owner: PublicKey; amount: bigint };
    expect(p.triggeredBy.equals(keeper) && p.owner.equals(user) && p.amount === 9n).toBe(true);
    expect((evs[1].data as { enabled: boolean }).enabled).toBe(false);
  });

  it("every IDL event has a decoder entry", () => {
    const names = (FUMPAD_IDL.events as { name: string }[]).map((e) => e.name).sort();
    expect(names).toEqual(
      [
        "AutoClaimSet", "BuybackExecuted", "ClaimEscrowed", "ClaimPaid", "ClaimQueued", "CoinCreated", "CurveCompleted", "CurveReopened", "EscrowWithdrawn",
        "FeesWithdrawn", "GlobalMigrated", "Graduated", "HoldingsRegistered", "LpFeesSettled", "ParamsCancelled", "ParamsQueued", "ParamsUpdated",
        "SampleRecorded", "TicketClosed", "TicketCreated", "TicketDebited", "Trade",
        // v0.6
        "AdminAccepted", "AdminProposalCancelled", "AdminProposed", "GlobalInitialized", "KeepersSet", "PauseSet", "PositionClosed",
      ].sort(),
    );
    expect((LP_LOCKER_IDL.events as { name: string }[]).map((e) => e.name).sort()).toEqual(["Locked", "Skimmed"]);
    expect(PublicKey.isOnCurve(eventAuthorityPda().toBytes())).toBe(false);
  });
});
