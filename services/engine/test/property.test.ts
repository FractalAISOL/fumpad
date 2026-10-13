// Property tests over random tapes (seeded xorshift, no extra dependency).
import { describe, expect, it } from "vitest";

import { canonicalJson, DEFAULT_ENGINE_PARAMS, mulDivCeil, priceQ64 } from "../src/index.js";
import { A, B, C, CREATOR, SOL, SQRT0, Tape } from "./helpers.js";

function rng(seed: number) {
  let x = BigInt(seed) | 1n;
  const M = (1n << 64n) - 1n;
  return (n: number) => {
    x ^= (x << 13n) & M;
    x ^= x >> 7n;
    x ^= (x << 17n) & M;
    return Number(x % BigInt(n));
  };
}

function randomTape(seed: number): Tape {
  const r = rng(seed);
  const t = new Tape();
  const wallets = [A, B, C, CREATOR];
  const bal = new Map<string, bigint>(wallets.map((w) => [w, 0n]));
  let sqrt = SQRT0;
  for (let i = 0; i < 120; i++) {
    t.wait([0, 1, 30, 200, 650, 4_000, 90_000][r(7)]);
    const w = wallets[r(4)];
    const k = r(10);
    const move = (up: boolean) => {
      sqrt = up ? (sqrt * BigInt(100 + r(8))) / 100n : (sqrt * BigInt(100 - r(8))) / 100n;
      return sqrt;
    };
    const spot = (sqrt * sqrt) >> 64n;
    if (k < 4) {
      const base = BigInt(1 + r(5_000)) * 1_000_000_000n;
      const quote = (base * spot) >> 64n;
      t.swap("buy", w, base, quote, { nextSqrtPrice: move(true), traderSource: r(10) === 0 ? "base_owner_unsigned" : "base_owner_signer" });
      bal.set(w, bal.get(w)! + base);
    } else if (k < 8) {
      const have = bal.get(w)!;
      if (have === 0n) continue;
      const base = (have * BigInt(1 + r(100))) / 100n;
      if (base === 0n) continue;
      const quote = (((base * spot) >> 64n) * BigInt(90 + r(10))) / 100n;
      t.swap("sell", w, base, quote, { nextSqrtPrice: move(false), traderSource: (["base_owner_signer", "base_owner_signer", "base_owner_signer", "signer_net_base", "base_owner_unsigned"] as const)[r(5)] });
      bal.set(w, have - base);
    } else {
      const to = wallets[r(4)];
      const have = bal.get(w)!;
      if (to === w || have === 0n) continue;
      const amt = (have * BigInt(1 + r(100))) / 100n;
      const s = `xfer-${seed}-${i}`;
      t.transfer(w, -amt, { signature: s });
      t.transfer(to, amt, { signature: s, payout: r(20) === 0 });
      bal.set(w, have - amt);
      bal.set(to, bal.get(to)! + amt);
    }
  }
  return t;
}

const shuffle = <T>(xs: T[], seed: number) => {
  const r = rng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = r(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

describe("engine properties (200 random tapes)", () => {
  it("is deterministic, order-insensitive and respects every bound", () => {
    let tickets = 0;
    let rebuys = 0;
    const reasons = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const t = randomTape(seed);
      const o1 = t.run();
      const o2 = t.run();
      expect(canonicalJson(o2)).toBe(canonicalJson(o1));
      t.events = shuffle(t.events, seed * 7);
      expect(canonicalJson(t.run())).toBe(canonicalJson(o1));
      expect(o1.issues).toEqual([]);

      const open = new Map<string, number>();
      const remaining = new Map<string, bigint>();
      for (const s of o1.sells) {
        if (s.reason) reasons.add(s.reason);
        if (!s.ticket) {
          expect(s.reason).not.toBe(null);
          continue;
        }
        tickets++;
        const k = s.ticket;
        expect(s.trader).not.toBe(CREATOR);
        expect(k.ticketTokens > 0n && k.ticketTokens <= s.baseAmount).toBe(true);
        expect(k.usdCents >= DEFAULT_ENGINE_PARAMS.minSellUsdCents).toBe(true);
        expect(k.executionQ64).toBe(priceQ64(s.quoteGross, s.baseAmount));
        expect(k.ticketPriceQ64 >= k.executionQ64).toBe(true);
        expect(k.ticketPriceQ64 >= mulDivCeil(k.referenceQ64, 9_000n, 10_000n)!).toBe(true);
        expect(s.blockTime - k.pythPublishTime).toBeLessThanOrEqual(60);
        remaining.set(`${s.signature}:${s.ixKey}`, k.ticketTokens);
      }
      for (const d of o1.rebuys) {
        rebuys++;
        const key = `${d.ticket.signature}:${d.ticket.ixKey}`;
        const before = remaining.get(key)!;
        expect(before).toBeDefined();
        expect(d.debit > 0n && d.debit <= before).toBe(true);
        expect(d.remaining).toBe(before - d.debit);
        remaining.set(key, d.remaining);
        void open;
      }
    }
    // the tapes exercise both outcomes and several refusal reasons
    expect(tickets).toBeGreaterThan(50);
    expect(rebuys).toBeGreaterThan(10);
    expect([...reasons].sort()).toEqual(expect.arrayContaining(["below_minimum_usd", "creator", "not_matured", "trader_unverified"]));
  });

  it("never more than max_open_tickets open per wallet", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const t = randomTape(seed);
      const o = t.run({ maxOpenTickets: 2 });
      const open = new Map<string, Set<string>>();
      const events = [...o.sells.map((s) => ({ at: [s.slot, s.txIndex, 2, s.ixKey], s })), ...o.rebuys.map((d) => ({ at: [d.slot, -1, 1, 0], d }))];
      events.sort((x, y) => x.at[0] - y.at[0] || x.at[1] - y.at[1] || x.at[2] - y.at[2] || x.at[3] - y.at[3]);
      for (const e of events) {
        if ("s" in e && e.s.ticket) {
          const set = open.get(e.s.trader!) ?? new Set();
          set.add(`${e.s.signature}:${e.s.ixKey}`);
          open.set(e.s.trader!, set);
          expect(set.size).toBeLessThanOrEqual(2);
        }
        if ("d" in e && e.d.voided) open.get(e.d.wallet)!.delete(`${e.d.ticket.signature}:${e.d.ticket.ixKey}`);
      }
    }
  });
});
