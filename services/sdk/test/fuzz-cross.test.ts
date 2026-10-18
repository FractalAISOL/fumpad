// Property / differential fuzz tests for the SDK's ports of the on-chain encoders and math.
//
// 1. Cross-language: `FUZZ_VECTORS=<file>` = JSON written by the Rust test `fuzz_props::cross_language_vectors`
//    (contracts/programs/fumpad/src/fuzz_props.rs): random inputs + the PROGRAM's outputs. Every case must match
//    the SDK (and the engine's price.ts port) bit for bit. Skipped when the file isn't given.
// 2. fast-check properties of the SDK encoders / Ed25519 data / claim math (FUZZ_RUNS, default 2000).
import { existsSync, readFileSync } from "node:fs";

import { PublicKey } from "@solana/web3.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import * as eng from "../../engine/src/rules/price.js";
import {
  attestEffectiveAt,
  bytesToHex,
  claimAmount,
  claimCap,
  decodeRebuyMessage,
  decodeSellMessage,
  ed25519InstructionData,
  encodeRebuyMessage,
  encodeSellMessage,
  fits,
  lamportsFor,
  medianPriceQ64,
  meetsMultiple,
  mulDivCeil,
  pregradMedianQ64,
  parseEd25519InstructionData,
  priceQ64,
  type RebuyRecord,
  type SellRecord,
  splitFees,
} from "../src/index.js";

const RUNS = Number(process.env.FUZZ_RUNS ?? 2000);
const VEC = process.env.FUZZ_VECTORS;
const U64 = (1n << 64n) - 1n;
const U128 = (1n << 128n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const nb = (s: string | null) => (s === null ? null : BigInt(s));

describe.skipIf(!VEC || !existsSync(VEC))("cross-language: program outputs (Rust) == SDK / engine ports (TS)", () => {
  const V = VEC && existsSync(VEC) ? JSON.parse(readFileSync(VEC, "utf8")) : { sells: [], rebuys: [], math: [], schedule: [] };

  it(`SellRecord: encodeSellMessage == SellRecord::encode, decode inverts (${V.sells.length} cases)`, () => {
    for (const s of V.sells) {
      const r: SellRecord = {
        programId: new PublicKey(s.programId),
        clusterTag: s.clusterTag,
        mint: new PublicKey(s.mint),
        pool: new PublicKey(s.pool),
        venue: s.venue,
        signature: Uint8Array.from(Buffer.from(s.signature, "hex")),
        ixKey: s.ixKey,
        trader: new PublicKey(s.trader),
        baseAmount: BigInt(s.baseAmount),
        quoteGross: BigInt(s.quoteGross),
        ticketTokens: BigInt(s.ticketTokens),
        ticketPriceQ64: BigInt(s.ticketPriceQ64),
        usdCents: BigInt(s.usdCents),
        pythPublishTime: BigInt(s.pythPublishTime),
        slot: BigInt(s.slot),
        blockTime: BigInt(s.blockTime),
      };
      expect(bytesToHex(encodeSellMessage(r))).toBe(s.hex);
      const d = decodeSellMessage(Uint8Array.from(Buffer.from(s.hex, "hex")))!;
      expect(d.programId.equals(r.programId) && d.mint.equals(r.mint) && d.pool.equals(r.pool) && d.trader.equals(r.trader)).toBe(true);
      expect([d.clusterTag, d.venue, d.ixKey, bytesToHex(d.signature)]).toEqual([r.clusterTag, r.venue, r.ixKey, s.signature]);
      expect([d.baseAmount, d.quoteGross, d.ticketTokens, d.ticketPriceQ64, d.usdCents, d.pythPublishTime, d.slot, d.blockTime]).toEqual([
        r.baseAmount, r.quoteGross, r.ticketTokens, r.ticketPriceQ64, r.usdCents, r.pythPublishTime, r.slot, r.blockTime,
      ]);
    }
  });

  it(`RebuyRecord: encodeRebuyMessage == RebuyRecord::encode (${V.rebuys.length} cases)`, () => {
    for (const s of V.rebuys) {
      const r: RebuyRecord = {
        programId: new PublicKey(s.programId),
        clusterTag: s.clusterTag,
        mint: new PublicKey(s.mint),
        ticket: new PublicKey(s.ticket),
        owner: new PublicKey(s.owner),
        signature: Uint8Array.from(Buffer.from(s.signature, "hex")),
        ixKey: s.ixKey,
        debitTokens: BigInt(s.debitTokens),
        slot: BigInt(s.slot),
        blockTime: BigInt(s.blockTime),
      };
      expect(bytesToHex(encodeRebuyMessage(r))).toBe(s.hex);
      const d = decodeRebuyMessage(Uint8Array.from(Buffer.from(s.hex, "hex")))!;
      expect([d.debitTokens, d.slot, d.blockTime, d.ixKey]).toEqual([r.debitTokens, r.slot, r.blockTime, r.ixKey]);
    }
  });

  it(`price / claim / fee math == program (${V.math.length} cases)`, () => {
    for (const m of V.math) {
      const [l, t] = [BigInt(m.l), BigInt(m.t)];
      expect(priceQ64(l, t)).toBe(nb(m.priceQ64));
      expect(eng.priceQ64(l, t)).toBe(nb(m.priceQ64));
      const [a, b, d] = [BigInt(m.a), BigInt(m.b), BigInt(m.d)];
      expect(mulDivCeil(a, b, d)).toBe(nb(m.mulDivCeil));
      expect(eng.mulDivCeil(a, b, d)).toBe(nb(m.mulDivCeil));
      expect(meetsMultiple(BigInt(m.cur), BigInt(m.ref), m.mult)).toBe(m.meets);
      expect(eng.meetsMultiple(BigInt(m.cur), BigInt(m.ref), BigInt(m.mult))).toBe(m.meets);
      expect(eng.spotFromSqrtQ64(BigInt(m.sqrt))).toBe(nb(m.fromSqrt));
      expect(lamportsFor(BigInt(m.tk), BigInt(m.pr))).toBe(nb(m.lamportsFor));
      expect(eng.lamportsFor(BigInt(m.tk), BigInt(m.pr))).toBe(nb(m.lamportsFor));
      expect(claimAmount(BigInt(m.tk), m.cbps)).toBe(BigInt(m.claimAmount));
      expect(claimCap(BigInt(m.pool), m.pbps)).toBe(BigInt(m.claimCap));
      expect(fits(BigInt(m.amt), BigInt(m.pool), m.pbps)).toBe(m.fits);
      const f = splitFees(BigInt(m.total), { buybackBps: 10_000 - m.platformBps - m.creatorBps, platformBps: m.platformBps, creatorBps: m.creatorBps }, false);
      expect([f.buyback, f.platform, f.creator]).toEqual(m.split.map(BigInt));
    }
  });

  it(`oracle medians: medianPriceQ64 / pregradMedianQ64 == Observations / PregradRing (${(V.medians ?? []).length} cases)`, () => {
    for (const m of V.medians ?? []) {
      const all = m.samples.map(([ts, p, fb]: [string, string, boolean]) => ({ ts: BigInt(ts), priceQ64: BigInt(p), fallback: fb }));
      const kept = all.slice(Math.max(0, all.length - 256)); // the on-chain ring keeps the newest 256
      expect(medianPriceQ64({ samples: kept }, BigInt(m.now), BigInt(m.w), m.min)).toBe(nb(m.median));
      const ring = { pricesQ64: m.ringState.prices.map(BigInt), ts: m.ringState.ts, head: 0, len: m.ringState.len };
      expect(pregradMedianQ64(ring, BigInt(m.now))).toBe(nb(m.ringMedian));
    }
  });

  it(`rate cap: attestEffectiveAt == Coin::schedule_attest (${V.schedule.length} cases)`, () => {
    for (const s of V.schedule) {
      const r = attestEffectiveAt({ now: BigInt(s.now), attestCursor: BigInt(s.cursor), totalSupply: BigInt(s.supply), bps: s.bps, ticketTokens: BigInt(s.tokens) });
      expect([r.effectiveAt, r.cursor]).toEqual([BigInt(s.effectiveAt), BigInt(s.newCursor)]);
    }
  });
});

// ── fast-check properties ────────────────────────────────────────────────────

const u = (bits: number) => fc.bigUint({ max: (1n << BigInt(bits)) - 1n });
const i64 = fc.bigInt({ min: I64_MIN, max: I64_MAX });
const key = fc.uint8Array({ minLength: 32, maxLength: 32 }).map((b) => new PublicKey(b));
const sig = fc.uint8Array({ minLength: 64, maxLength: 64 });

const sellArb: fc.Arbitrary<SellRecord> = fc.record({
  programId: key,
  clusterTag: fc.integer({ min: 0, max: 255 }),
  mint: key,
  pool: key,
  venue: fc.constantFrom(0, 1, 0x80, 0x81),
  signature: sig,
  ixKey: fc.integer({ min: 0, max: 0xffff_ffff }),
  trader: key,
  baseAmount: u(64),
  quoteGross: u(64),
  ticketTokens: u(64),
  ticketPriceQ64: u(128),
  usdCents: u(64),
  pythPublishTime: i64,
  slot: u(64),
  blockTime: i64,
});

describe("SDK attestation encoders (fast-check)", () => {
  it("sell: decode(encode(r)) == r for every in-range record; length 284", () => {
    fc.assert(
      fc.property(sellArb, (r) => {
        const m = encodeSellMessage(r);
        expect(m.length).toBe(284);
        const d = decodeSellMessage(m)!;
        expect(bytesToHex(encodeSellMessage(d))).toBe(bytesToHex(m));
        expect([d.baseAmount, d.ticketPriceQ64, d.blockTime, d.ixKey, d.venue]).toEqual([r.baseAmount, r.ticketPriceQ64, r.blockTime, r.ixKey, r.venue]);
      }),
      { numRuns: RUNS },
    );
  });

  it("sell: any 284-byte domain-prefixed message decodes and re-encodes to itself (venue byte permitting)", () => {
    const dom = new TextEncoder().encode("FUMPAD-SELL-v1");
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 270, maxLength: 270 }), fc.constantFrom(0, 1, 0x80, 0x81), (body, venue) => {
        const m = new Uint8Array(284);
        m.set(dom, 0);
        m.set(body, 14);
        m[111] = venue;
        const d = decodeSellMessage(m)!;
        expect(bytesToHex(encodeSellMessage(d))).toBe(bytesToHex(m));
      }),
      { numRuns: RUNS },
    );
  });

  it("decoders never throw on arbitrary bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), (b) => {
        decodeSellMessage(b);
        decodeRebuyMessage(b);
        parseEd25519InstructionData(b);
      }),
      { numRuns: RUNS },
    );
  });

  it("ed25519 data: build → parse round-trips message and signer order", () => {
    fc.assert(
      fc.property(sellArb, fc.array(fc.tuple(key, sig), { minLength: 1, maxLength: 5 }), (r, ks) => {
        const msg = encodeSellMessage(r);
        const d = ed25519InstructionData(msg, ks.map(([keeper, signature]) => ({ keeper, signature })));
        const p = parseEd25519InstructionData(d)!;
        expect(bytesToHex(p.message)).toBe(bytesToHex(msg));
        expect(p.signatures.map((s) => s.keeper.toBase58())).toEqual(ks.map(([k]) => k.toBase58()));
      }),
      { numRuns: RUNS },
    );
  });

  /**
   * Out-of-range numeric fields: the Rust record types make these unrepresentable; the TS encoder must not silently
   * produce a DIFFERENT valid message for them (it should throw). Recorded as a finding when it fails.
   */
  it("FIXED: encodeSellMessage throws on out-of-range u64 fields (it used to wrap them into a different valid message)", () => {
    const over = fc.oneof(fc.bigInt({ min: U64 + 1n, max: U64 * 4n }), fc.bigInt({ min: -(1n << 70n), max: -1n }));
    const res = fc.check(
      fc.property(sellArb, over, fc.constantFrom("baseAmount", "ticketTokens", "usdCents", "quoteGross", "slot"), (r, v, field) => {
        const bad = { ...r, [field]: v } as SellRecord;
        let threw = false;
        let m: Uint8Array | null = null;
        try {
          m = encodeSellMessage(bad);
        } catch {
          threw = true;
        }
        return threw || (decodeSellMessage(m!) as unknown as Record<string, bigint>)[field] === v;
      }),
      { numRuns: 200, seed: 42 },
    );
    if (res.failed) {
      // eslint-disable-next-line no-console
      console.log("FINDING encodeSellMessage wraps out-of-range value:", fc.stringify(res.counterexample));
    }
    // Fixed (sdk/src/attestation.ts range-checks every field): no out-of-range value encodes any more.
    expect(res.failed).toBe(false);
  });
});

describe("SDK claim / price math (fast-check)", () => {
  it("priceQ64 floor is tight and never favours the seller", () => {
    fc.assert(
      fc.property(u(64), fc.bigUint({ max: U64 }).filter((t) => t > 0n), (l, t) => {
        const p = priceQ64(l, t)!;
        expect(p * t <= l << 64n).toBe(true);
        expect((p + 1n) * t > l << 64n).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("mulDivCeil: result × d ≥ a × b and (result − 1) × d < a × b", () => {
    fc.assert(
      fc.property(u(128), u(128), fc.bigUint({ max: U128 }).filter((d) => d > 0n), (a, b, d) => {
        const q = mulDivCeil(a, b, d);
        if (q === null) expect((a * b + d - 1n) / d > U128).toBe(true);
        else {
          expect(q * d >= a * b).toBe(true);
          expect(q === 0n || (q - 1n) * d < a * b).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("fits ⇒ 0 < amount ≤ pool × bps / 10_000 ≤ pool; claimAmount ≤ tokens", () => {
    fc.assert(
      fc.property(u(64), u(64), u(64), fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 10_000 }), (amt, pool, tokens, pbps, cbps) => {
        if (fits(amt, pool, pbps)) expect(amt > 0n && amt * 10_000n <= pool * BigInt(pbps) && amt <= pool).toBe(true);
        expect(claimAmount(tokens, cbps) <= tokens).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("splitFees: parts sum to the claim, platform/creator exact floors, every valid split", () => {
    fc.assert(
      fc.property(u(64), fc.integer({ min: 0, max: 10_000 }), fc.integer({ min: 0, max: 10_000 }), (total, p, c0) => {
        const c = c0 % (10_001 - p);
        const f = splitFees(total, { buybackBps: 10_000 - p - c, platformBps: p, creatorBps: c }, false);
        expect(f.buyback + f.platform + f.creator).toBe(total);
        expect(f.platform).toBe((total * BigInt(p)) / 10_000n);
        expect(f.buyback >= 0n).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});
