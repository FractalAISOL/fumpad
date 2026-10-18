// Attestation messages / Ed25519 instruction / consumed PDAs must be byte-identical to the contracts'
// encoders (vectors generated from programs/fumpad/src/attestation.rs, see the JSON's _source).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  bytesToHex,
  consumedRebuyPda,
  consumedSellPda,
  decodeRebuyMessage,
  decodeSellMessage,
  ed25519InstructionData,
  encodeRebuyMessage,
  encodeSellMessage,
  FUMPAD_PROGRAM_ID,
  hexToBytes,
  messageId,
  parseEd25519InstructionData,
  type RebuyRecord,
  type SellRecord,
  signAttestation,
  verifyAttestation,
} from "../src/index.js";

const V = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "vectors/attestation-contracts.json"), "utf8"));
const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const sig = Uint8Array.from({ length: 64 }, (_, i) => (i * 7 + 3) & 0xff);

const SELL: SellRecord = {
  programId: FUMPAD_PROGRAM_ID,
  clusterTag: 2,
  mint: pk(11),
  pool: pk(12),
  venue: 0x81,
  signature: sig,
  ixKey: (3 << 16) | 2,
  trader: pk(13),
  baseAmount: 123_456_789_012n,
  quoteGross: 987_654_321n,
  ticketTokens: 100_000_000_000n,
  ticketPriceQ64: (1n << 100n) + 12345n,
  usdCents: 5_001n,
  pythPublishTime: 1_760_000_000n,
  slot: 456_789_012n,
  blockTime: 1_760_000_030n,
};
const REBUY: RebuyRecord = {
  programId: FUMPAD_PROGRAM_ID,
  clusterTag: 1,
  mint: pk(11),
  ticket: pk(14),
  owner: pk(13),
  signature: sig,
  ixKey: 0xffff_ffff,
  debitTokens: 42_000_000n,
  slot: 456_789_999n,
  blockTime: -5n,
};

describe("attestation encoding = contracts", () => {
  it("program id", () => expect(FUMPAD_PROGRAM_ID.toBase58()).toBe(V.programId));
  it("sell message (284 B)", () => {
    const m = encodeSellMessage(SELL);
    expect(m.length).toBe(284);
    expect(bytesToHex(m)).toBe(V.sell);
    expect(decodeSellMessage(m)).toEqual(SELL);
  });
  it("rebuy message (236 B)", () => {
    const m = encodeRebuyMessage(REBUY);
    expect(m.length).toBe(236);
    expect(bytesToHex(m)).toBe(V.rebuy);
    expect(decodeRebuyMessage(m)).toEqual(REBUY);
  });
  it("consumed PDAs", () => {
    expect(consumedSellPda(sig, SELL.ixKey).toBase58()).toBe(V.consumedSell);
    expect(consumedRebuyPda(sig, REBUY.ixKey, REBUY.ticket).toBase58()).toBe(V.consumedRebuy);
  });
  it("Ed25519 instruction data (2 signers, one message)", () => {
    const m = encodeSellMessage(SELL);
    const d = ed25519InstructionData(m, [
      { keeper: pk(21), signature: new Uint8Array(64).fill(31) },
      { keeper: pk(22), signature: new Uint8Array(64).fill(32) },
    ]);
    expect(bytesToHex(d)).toBe(V.ed25519);
    expect(d.length).toBe(2 + 28 + 2 * 96 + 284);
    const p = parseEd25519InstructionData(Uint8Array.from(hexToBytes(V.ed25519)))!;
    expect(bytesToHex(p.message)).toBe(V.sell);
    expect(p.signatures.map((s) => s.keeper.toBase58())).toEqual([pk(21).toBase58(), pk(22).toBase58()]);
  });
  it("range-checks every numeric field: out-of-range values throw instead of wrapping (audit robustness gap)", () => {
    const U64 = (1n << 64n) - 1n;
    for (const [k, v] of [
      ["baseAmount", U64 + 1n],
      ["quoteGross", -1n],
      ["ticketTokens", 1n << 70n],
      ["usdCents", U64 + 1n],
      ["slot", -1n],
      ["ticketPriceQ64", 1n << 128n],
      ["ticketPriceQ64", -1n],
      ["pythPublishTime", 1n << 63n],
      ["blockTime", -(1n << 63n) - 1n],
      ["ixKey", 2 ** 32],
      ["ixKey", -1],
      ["ixKey", 1.5],
      ["clusterTag", 256],
    ] as const)
      expect(() => encodeSellMessage({ ...SELL, [k]: v } as SellRecord), `${k}=${v}`).toThrow(RangeError);
    for (const [k, v] of [
      ["debitTokens", U64 + 1n],
      ["blockTime", 1n << 63n],
      ["ixKey", 2 ** 32],
    ] as const)
      expect(() => encodeRebuyMessage({ ...REBUY, [k]: v } as RebuyRecord), `${k}=${v}`).toThrow(RangeError);
    // boundaries still encode exactly
    const edge = { ...SELL, baseAmount: U64, ticketPriceQ64: (1n << 128n) - 1n, blockTime: -(1n << 63n), ixKey: 0xffff_ffff, clusterTag: 255 };
    expect(decodeSellMessage(encodeSellMessage(edge))).toMatchObject({ baseAmount: U64, ticketPriceQ64: (1n << 128n) - 1n, blockTime: -(1n << 63n), ixKey: 0xffff_ffff, clusterTag: 255 });
  });
  it("rejects bad venue bits and wrong lengths", () => {
    expect(() => encodeSellMessage({ ...SELL, venue: 0x02 })).toThrow();
    expect(decodeSellMessage(new Uint8Array(283))).toBe(null);
    expect(decodeRebuyMessage(encodeSellMessage(SELL))).toBe(null);
  });
});

describe("keeper signatures", () => {
  it("sign / verify over the exact bytes; any change breaks it", () => {
    const k = Keypair.generate();
    const m = encodeSellMessage(SELL);
    const s = signAttestation(m, k.secretKey);
    expect(verifyAttestation(m, { keeper: k.publicKey, signature: s })).toBe(true);
    const m2 = encodeSellMessage({ ...SELL, ticketTokens: SELL.ticketTokens + 1n });
    expect(verifyAttestation(m2, { keeper: k.publicKey, signature: s })).toBe(false);
    expect(verifyAttestation(m, { keeper: Keypair.generate().publicKey, signature: s })).toBe(false);
    expect(messageId(m)).toMatch(/^[0-9a-f]{64}$/);
    expect(messageId(m)).not.toBe(messageId(m2));
  });
});
