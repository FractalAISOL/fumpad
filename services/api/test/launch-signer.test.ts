// Launch binding (off-chain review L1, INTERFACE §8.1): the API co-signs register_coin with its launch key
// when Global.params.launch_signer is set, and never builds a launch the program would refuse.
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import { FUMPAD_PROGRAM_ID, inspectLaunchTx, launchInstructions } from "@fumpad/sdk";

import { launchSignerFor, parseLaunchSignerKey } from "../src/launch/signer.js";

describe("launch signer", () => {
  const key = Keypair.generate();
  it("parses base58 and JSON-array secrets", () => {
    expect(parseLaunchSignerKey(bs58.encode(key.secretKey))!.publicKey.equals(key.publicKey)).toBe(true);
    expect(parseLaunchSignerKey(JSON.stringify(Array.from(key.secretKey)))!.publicKey.equals(key.publicKey)).toBe(true);
    expect(parseLaunchSignerKey(undefined)).toBeNull();
    expect(() => parseLaunchSignerKey("abc")).toThrow();
  });
  it("not needed while the param is unset; required and matching when set", () => {
    expect(launchSignerFor(PublicKey.default, key)).toBeNull();
    expect(launchSignerFor(PublicKey.default, null)).toBeNull();
    expect(launchSignerFor(key.publicKey, key)).toBe(key);
    expect(() => launchSignerFor(key.publicKey, null)).toThrow(/launch key/);
    expect(() => launchSignerFor(Keypair.generate().publicKey, key)).toThrow(/doesn't match/);
  });
  it("register_coin carries the launch signer as a signer (else the program id); the tx stays a valid launch", () => {
    const creator = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const dbcConfig = Keypair.generate().publicKey;
    const base = { creator, mint, dbcConfig, name: "A", symbol: "A", uri: "https://x.y/a.json" };
    const reg = (ixs: ReturnType<typeof launchInstructions>) => ixs.find((i) => i.programId.equals(FUMPAD_PROGRAM_ID))!;
    const signed = reg(launchInstructions({ ...base, launchSigner: key.publicKey })).keys.find((k) => k.pubkey.equals(key.publicKey))!;
    expect(signed.isSigner).toBe(true);
    expect(reg(launchInstructions(base)).keys.some((k) => k.pubkey.equals(FUMPAD_PROGRAM_ID) && !k.isSigner)).toBe(true);
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: creator, recentBlockhash: bs58.encode(new Uint8Array(32)), instructions: launchInstructions({ ...base, launchSigner: key.publicKey }) }).compileToV0Message());
    tx.sign([key]);
    const info = inspectLaunchTx(tx);
    expect(info.signed).toEqual([key.publicKey.toBase58()]);
  });
});
