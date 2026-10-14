/**
 * Wallet-split fee policy (first-coin config, INTERFACE §5.9): the jobs keeper's fee claims pass the coin's policy
 * wallet, read from the Coin account's policy tail; standard coins pass none.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { accountDiscriminator, claimFeesIx, COIN_ACCOUNT_LEN, COIN_POLICY_TAIL_LEN, decodeCoin, FEE_POLICY, FUMPAD_PROGRAM_ID } from "@fumpad/sdk";

import { feeWalletOf } from "../src/keeper.js";

const k = () => Keypair.generate().publicKey;

/** A Coin account with the given fee-policy kind byte (offset 544) and, for a wallet split, its 47-byte tail. */
function coinData(mint: PublicKey, wallet: PublicKey | null): Uint8Array {
  const d = new Uint8Array(COIN_ACCOUNT_LEN + (wallet ? COIN_POLICY_TAIL_LEN : 0));
  d.set(accountDiscriminator("Coin"), 0);
  d.set(mint.toBytes(), 8 + 1 + 1 + 1); // bump, status, launch_fees_settled, then mint
  if (wallet) {
    d[COIN_ACCOUNT_LEN - 2] = FEE_POLICY.walletSplit; // fee_policy_kind (before reserved [u8; 1])
    const o = COIN_ACCOUNT_LEN;
    const v = new DataView(d.buffer, o);
    d[o] = FEE_POLICY.walletSplit;
    v.setUint16(1, 100, true);
    v.setUint16(3, 140, true);
    v.setUint16(5, 1, true);
    d.set(wallet.toBytes(), o + 7);
    v.setBigUint64(39, 123n, true);
  }
  return d;
}

describe("keeper fee claims: policy wallet", () => {
  it("standard coin → no wallet; wallet-split coin → the snapshot's wallet from the Coin's tail", () => {
    const mint = k();
    const wallet = k();
    const std = decodeCoin(coinData(mint, null));
    expect(std.feePolicyKind).toBe(0);
    expect(feeWalletOf(std)).toBeNull();
    const special = decodeCoin(coinData(mint, wallet));
    expect(special.feePolicyKind).toBe(FEE_POLICY.walletSplit);
    expect(special.feePolicy).toMatchObject({ kind: 1, buybackShare: 100, walletShare: 140, maxCoins: 1 });
    expect(special.walletPaidLamports).toBe(123n);
    expect(feeWalletOf(special)!.equals(wallet)).toBe(true);
    // The claim carries the wallet (writable) right before the event-CPI pair; standard: the program id (None).
    const ix = claimFeesIx(k(), { mint, dbcConfig: k(), feeWallet: wallet });
    const n = ix.keys.length;
    expect(ix.keys[n - 3].pubkey.equals(wallet) && ix.keys[n - 3].isWritable).toBe(true);
    expect(claimFeesIx(k(), { mint, dbcConfig: k() }).keys[n - 3].pubkey.equals(FUMPAD_PROGRAM_ID)).toBe(true);
  });
  it("a wallet-split coin without its tail is an error (never claims without the wallet)", () => {
    expect(() => feeWalletOf({ mint: k(), feePolicyKind: FEE_POLICY.walletSplit, feePolicy: undefined })).toThrow(/fee policy snapshot/);
  });
});
