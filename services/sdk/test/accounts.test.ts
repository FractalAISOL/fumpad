// Account decoders: IDL discriminators; Global round-trips through the borsh layout (1,044 bytes).
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { accountDiscriminator, bn, decodeGlobal, DEFAULT_PARAMS, fumpadCoder, paramsToIdl } from "../src/index.js";

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
        pending_config: PublicKey.default, pending_config_add: 0, pending_config_eta: bn(0n), reserved: Array(128).fill(0),
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
