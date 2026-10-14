/**
 * Wallet-split fee policy (first-coin config, INTERFACE §5.9): the jobs keeper's fee claims pass the coin's policy
 * wallet, read once from its `CoinFeePolicy` snapshot; standard coins pass none.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { bn, claimFeesIx, type CoinAccount, FEE_POLICY, feePolicyPda, FUMPAD_PROGRAM_ID, fumpadCoder } from "@fumpad/sdk";

import { Keeper } from "../src/keeper.js";

const k = () => Keypair.generate().publicKey;

async function snapshotData(mint: PublicKey, wallet: PublicKey): Promise<Buffer> {
  return fumpadCoder().accounts.encode("CoinFeePolicy", {
    bump: 255,
    mint,
    dbc_config: k(),
    policy: { kind: FEE_POLICY.walletSplit, buyback_share: 100, wallet_share: 140, max_coins: 1, wallet },
    wallet_paid_lamports: bn(0n),
    reserved: Array(32).fill(0),
  });
}

describe("keeper fee claims: policy wallet", () => {
  it("standard coin → no wallet; wallet-split coin → the snapshot's wallet (read once, cached)", async () => {
    const mint = k();
    const wallet = k();
    const data = await snapshotData(mint, wallet);
    let reads = 0;
    const self = {
      conn: {
        getAccountInfo: async (key: PublicKey) => {
          reads++;
          expect(key.equals(feePolicyPda(mint))).toBe(true);
          return { owner: FUMPAD_PROGRAM_ID, data };
        },
      },
    };
    const feeWalletOf = Keeper.prototype.feeWalletOf;
    const std = { coin: { mint, feePolicyKind: FEE_POLICY.standard } as CoinAccount } as Parameters<typeof feeWalletOf>[0];
    expect(await feeWalletOf.call(self as unknown as Keeper, std)).toBeNull();
    expect(reads).toBe(0);
    const special = { coin: { mint, feePolicyKind: FEE_POLICY.walletSplit } as CoinAccount } as Parameters<typeof feeWalletOf>[0];
    expect((await feeWalletOf.call(self as unknown as Keeper, special))!.equals(wallet)).toBe(true);
    expect((await feeWalletOf.call(self as unknown as Keeper, special))!.equals(wallet)).toBe(true);
    expect(reads).toBe(1);
    // The claim carries the policy PDA + the wallet (writable) right before the event-CPI pair.
    const ix = claimFeesIx(k(), { mint, dbcConfig: k(), feeWallet: wallet });
    const n = ix.keys.length;
    expect(ix.keys[n - 4].pubkey.equals(feePolicyPda(mint))).toBe(true);
    expect(ix.keys[n - 3].pubkey.equals(wallet) && ix.keys[n - 3].isWritable).toBe(true);
    // Standard: both optional accounts are the program id (None).
    const std2 = claimFeesIx(k(), { mint, dbcConfig: k() });
    expect(std2.keys[n - 4].pubkey.equals(FUMPAD_PROGRAM_ID) && std2.keys[n - 3].pubkey.equals(FUMPAD_PROGRAM_ID)).toBe(true);
  });
  it("a missing snapshot is an error (never claims without the wallet)", async () => {
    const self = { conn: { getAccountInfo: async () => null } };
    const c = { coin: { mint: k(), feePolicyKind: FEE_POLICY.walletSplit } as CoinAccount } as Parameters<typeof Keeper.prototype.feeWalletOf>[0];
    await expect(Keeper.prototype.feeWalletOf.call(self as unknown as Keeper, c)).rejects.toThrow(/fee policy snapshot/);
  });
});
