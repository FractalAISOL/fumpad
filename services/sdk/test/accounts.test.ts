// Account decoders: IDL discriminators; Global round-trips through the borsh layout (1,491 bytes).
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  accountDiscriminator,
  activeKeepers,
  bn,
  configSlot,
  FEE_POLICY,
  feePolicyProblems,
  STANDARD_FEE_POLICY,
  walletSplit,
  decodeCoin,
  decodeGlobal,
  DEFAULT_PARAMS,
  fumpadCoder,
  paramsProblems,
  paramsToIdl,
  PREGRAD_RING_LEN,
  pregradMedianQ64,
} from "../src/index.js";

const k = () => Keypair.generate().publicKey;

describe("account decoders", () => {
  it("discriminators come from the IDL; Global round-trips", () => {
    expect(accountDiscriminator("Coin")).toHaveLength(8);
    const layout = (fumpadCoder().types as unknown as { typeLayouts: Map<string, { encode(v: unknown, b: Buffer): number }> }).typeLayouts.get("Global")!;
    const buf = Buffer.alloc(4096);
    const cfg = k();
    const wallet = k();
    const std = { kind: 0, buyback_share: 0, wallet_share: 0, max_coins: 0, wallet: PublicKey.default };
    const pol = { kind: 1, buyback_share: 100, wallet_share: 140, max_coins: 1, wallet };
    const len = layout.encode(
      {
        bump: 1, admin: k(), platform_treasury: k(), guardian: k(), keepers: [k(), k(), k()], keeper_added_at: [bn(0n), bn(0n), bn(5n)], cluster_tag: 2, paused: 0,
        pause_expires_at: bn(0n), params: paramsToIdl(DEFAULT_PARAMS), pending_params: paramsToIdl(DEFAULT_PARAMS), pending_eta: bn(0n), pending_admin: PublicKey.default,
        pending_treasury: PublicKey.default, pending_guardian: PublicKey.default, pending_admin_eta: bn(0n), configs: [cfg, ...Array(7).fill(PublicKey.default)],
        pending_config: PublicKey.default, pending_config_add: 0, pending_config_eta: bn(0n), operators: [PublicKey.default, PublicKey.default],
        config_policies: [pol, ...Array(7).fill(std)], config_coins: [1, 0, 0, 0, 0, 0, 0, 0], pending_config_policy: std, reserved: Array(64).fill(0),
      },
      buf,
    );
    expect(len + 8).toBe(1491);
    const g = decodeGlobal(Buffer.concat([Buffer.from(accountDiscriminator("Global")), buf.subarray(0, len)]));
    expect(g.configs[0].equals(cfg)).toBe(true);
    expect(g.clusterTag).toBe(2);
    expect(g.keeperAddedAt[2]).toBe(5n);
    expect(g.params.minSellUsdCents).toBe(5_000n);
    expect(g.params.maxOpenTickets).toBe(5);
    const slot = configSlot(g, cfg)!;
    expect(slot.index).toBe(0);
    expect(slot.coins).toBe(1);
    expect(slot.policy.kind).toBe(FEE_POLICY.walletSplit);
    expect([slot.policy.buybackShare, slot.policy.walletShare, slot.policy.maxCoins]).toEqual([100, 140, 1]);
    expect(slot.policy.wallet.equals(wallet)).toBe(true);
    expect(feePolicyProblems(slot.policy)).toEqual([]);
    expect(g.pendingConfigPolicy.kind).toBe(0);
    expect(configSlot(g, k())).toBeNull();
    // A pre-fee-policy Global (1,044 bytes, before migrate_global) decodes with a standard tail.
    const old = decodeGlobal(Buffer.concat([Buffer.from(accountDiscriminator("Global")), buf.subarray(0, 1036)]));
    expect(old.configs[0].equals(cfg)).toBe(true);
    expect(old.configPolicies.every((p) => p.kind === 0) && old.configCoins.every((n) => n === 0)).toBe(true);
  });

  it("wallet split: exact floors to the wallet, remainder to buyback (1.0 / 1.4 of 2.4)", () => {
    const p = { buybackShare: 100, walletShare: 140 };
    expect(walletSplit(2_400_000n, p)).toEqual({ buyback: 1_000_000n, wallet: 1_400_000n });
    expect(walletSplit(1_000_001n, p)).toEqual({ buyback: 416_668n, wallet: 583_333n });
    expect(feePolicyProblems({ ...STANDARD_FEE_POLICY, wallet: k() })).not.toEqual([]);
    expect(feePolicyProblems({ kind: 1, buybackShare: 100, walletShare: 0, maxCoins: 1, wallet: k() })).not.toEqual([]);
  });
});

describe("keepers + params helpers", () => {
  it("activeKeepers: bootstrap keepers (added_at 0) are active at once; set_keepers keys after 6 h", () => {
    const [a, b, c] = [k(), k(), k()];
    const g = { keepers: [a, b, c], keeperAddedAt: [0n, 1_000n, 0n] };
    expect(activeKeepers(g, 1_001n).map((x) => x.toBase58())).toEqual([a, c].map((x) => x.toBase58()));
    expect(activeKeepers(g, 1_000n + 21_600n)).toHaveLength(3);
    expect(activeKeepers({ keepers: [PublicKey.default, a, b], keeperAddedAt: [0n, 0n, 0n] }, 1n)).toHaveLength(2);
  });
  it("paramsProblems mirrors Params::is_valid", () => {
    expect(paramsProblems(DEFAULT_PARAMS)).toEqual([]);
    // devnet bootstrap params (services/scripts/devnet/bootstrap-v07.ts)
    expect(paramsProblems({ ...DEFAULT_PARAMS, minSellUsdCents: 500n, minHoldSecs: 60n, ticketChallengeSecs: 3_600n, oracleWindowSecs: 600n, oracleMinSamples: 28 })).toEqual([]);
    expect(paramsProblems({ ...DEFAULT_PARAMS, ticketChallengeSecs: 10n })).toHaveLength(1);
    expect(paramsProblems({ ...DEFAULT_PARAMS, oracleWindowSecs: 600n })).toHaveLength(1); // 84 samples > 600 / 10
    expect(paramsProblems({ ...DEFAULT_PARAMS, oracleMinSamples: 20 })).toHaveLength(1); // 20 × 60 < 1,800
    expect(paramsProblems({ ...DEFAULT_PARAMS, feeCreatorShareBps: 1 })).toHaveLength(1);
    expect(paramsProblems({ ...DEFAULT_PARAMS, attestThreshold: 3 })).toHaveLength(1);
  });
});

describe("Coin.pregrad_ring (L5)", () => {
  const COIN_LEN = 546; // unchanged by L5: the ring (62 B) is carved out of the former 64 reserved bytes
  const RING_OFF = COIN_LEN - 64;
  const coinWithRing = (prices: bigint[], ts: number[], head: number, len: number): Uint8Array => {
    const b = new Uint8Array(COIN_LEN);
    b.set(accountDiscriminator("Coin"), 0);
    const v = new DataView(b.buffer);
    prices.forEach((p, i) => v.setBigUint64(RING_OFF + 8 * i, p, true));
    ts.forEach((t, i) => v.setUint32(RING_OFF + 40 + 4 * i, t, true));
    b[RING_OFF + 60] = head;
    b[RING_OFF + 61] = len;
    return b;
  };
  const Q = 1n << 50n;
  const T = 1_000_000;

  it("decodes at the end of the 546-byte Coin", () => {
    const c = decodeCoin(coinWithRing([Q, Q + 1n, Q + 2n, Q * 10n, Q], [T, T + 20, T + 40, T + 60, T + 80], 0, 5));
    expect(c.status).toBe("curve");
    expect(c.pregradRing.pricesQ64).toEqual([Q, Q + 1n, Q + 2n, Q * 10n, Q]);
    expect(c.pregradRing.ts).toEqual([T, T + 20, T + 40, T + 60, T + 80]);
    expect([c.pregradRing.head, c.pregradRing.len]).toEqual([0, 5]);
    // one ×10 outlier can't move the median outside the honest values
    expect(pregradMedianQ64(c.pregradRing, BigInt(T + 80))).toBe(Q + 1n);
    expect(decodeCoin(coinWithRing([], [], 0, 0)).pregradRing.len).toBe(0);
  });

  it("pregradMedianQ64 mirrors PregradRing::median_q64: ≥ 4 samples in 300 s spanning ≥ 60 s", () => {
    const ring = (p: bigint[], t: number[]) => ({ pricesQ64: p, ts: t, head: p.length % PREGRAD_RING_LEN, len: p.length });
    expect(pregradMedianQ64(ring([Q, Q, Q], [T, T + 30, T + 60]), BigInt(T + 60))).toBeNull(); // 3 < 4
    expect(pregradMedianQ64(ring([Q, Q, Q, Q], [T, T + 15, T + 30, T + 45]), BigInt(T + 45))).toBeNull(); // span 45 s
    expect(pregradMedianQ64(ring([4n * Q, Q, 3n * Q, 2n * Q], [T, T + 20, T + 40, T + 60]), BigInt(T + 60))).toBe((5n * Q) / 2n); // even: mean
    expect(pregradMedianQ64(ring([Q, Q, Q, Q], [T, T + 20, T + 40, T + 60]), BigInt(T + 301))).toBeNull(); // T aged out
    expect(pregradMedianQ64(ring([Q, Q, Q, Q], [T, T + 20, T + 40, T + 60]), BigInt(T + 59))).toBeNull(); // future sample ignored
  });
});
