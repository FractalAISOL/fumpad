// Account decoders: IDL discriminators; Global round-trips through the borsh layout (1,044 bytes).
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { accountDiscriminator, activeKeepers, bn, decodeGlobal, DEFAULT_PARAMS, fumpadCoder, paramsProblems, paramsToIdl } from "../src/index.js";

const k = () => Keypair.generate().publicKey;

describe("account decoders", () => {
  it("discriminators come from the IDL; Global round-trips", () => {
    expect(accountDiscriminator("Coin")).toHaveLength(8);
    const layout = (fumpadCoder().types as unknown as { typeLayouts: Map<string, { encode(v: unknown, b: Buffer): number }> }).typeLayouts.get("Global")!;
    const buf = Buffer.alloc(4096);
    const cfg = k();
    const len = layout.encode(
      {
        bump: 1, admin: k(), platform_treasury: k(), guardian: k(), keepers: [k(), k(), k()], keeper_added_at: [bn(0n), bn(0n), bn(5n)], cluster_tag: 2, paused: 0,
        pause_expires_at: bn(0n), params: paramsToIdl(DEFAULT_PARAMS), pending_params: paramsToIdl(DEFAULT_PARAMS), pending_eta: bn(0n), pending_admin: PublicKey.default,
        pending_treasury: PublicKey.default, pending_guardian: PublicKey.default, pending_admin_eta: bn(0n), configs: [cfg, ...Array(7).fill(PublicKey.default)],
        pending_config: PublicKey.default, pending_config_add: 0, pending_config_eta: bn(0n), reserved: Array(64).fill(0),
      },
      buf,
    );
    expect(len + 8).toBe(1044);
    const g = decodeGlobal(Buffer.concat([Buffer.from(accountDiscriminator("Global")), buf.subarray(0, len)]));
    expect(g.configs[0].equals(cfg)).toBe(true);
    expect(g.clusterTag).toBe(2);
    expect(g.keeperAddedAt[2]).toBe(5n);
    expect(g.params.minSellUsdCents).toBe(5_000n);
    expect(g.params.maxOpenTickets).toBe(5);
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
