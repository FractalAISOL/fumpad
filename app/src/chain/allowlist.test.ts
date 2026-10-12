/**
 * Silent-signing allow-list. Transactions are assembled from the same `@fumpad/sdk`
 * encoders the builders use (no RPC), then tampered with one way at a time.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buyIx,
  claimIx,
  computeBudgetIxs,
  createAtaIdempotentIx,
  createCoinIx,
  sellIx,
  setAutoClaimIx,
  swapBuyIx,
  swapSellIx,
  withdrawCreatorFeesIx,
  TOKEN_2022_PROGRAM_ID as SDK_TOKEN_2022,
  FUMPAD_PROGRAM_ID as SDK_FUMPAD,
} from "@fumpad/sdk";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { SilentSignRefused, vetFumpadTx, vetWithdrawTx } from "./allowlist";
import { FUMPAD_PROGRAM_ID } from "./program";

const wallet = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const ticket = Keypair.generate().publicKey;
const bfr = Keypair.generate().publicKey;
const BLOCKHASH = "11111111111111111111111111111111";
const SOL = BigInt(1_000_000_000);

function tx(ixs: TransactionInstruction[], payer = wallet): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());
}
const refused = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof SilentSignRefused && (!re || re.test(e.message)));

const cb = (units = 200_000, price?: number) => computeBudgetIxs(units, price);
const buy = (solIn = SOL / BigInt(10), user = wallet) => buyIx({ user, mint, solIn, minTokensOut: BigInt(1), openTickets: [] });

describe("vetFumpadTx", () => {
  it("uses the same program id as the SDK", () => {
    assert.ok(FUMPAD_PROGRAM_ID.equals(SDK_FUMPAD));
  });

  it("accepts every builder pattern", () => {
    assert.equal(vetFumpadTx(tx([...cb(), buy()]), wallet, { action: "buy", maxSolInLamports: SOL / BigInt(10) }).solInLamports, SOL / BigInt(10));
    vetFumpadTx(tx([...cb(), swapBuyIx({ user: wallet, mint, solIn: SOL, minTokensOut: BigInt(1), openTickets: [ticket], buybackFeeRecipient: bfr })]), wallet, {
      action: "buy",
      maxSolInLamports: SOL,
    });
    vetFumpadTx(tx([...cb(), sellIx({ user: wallet, mint, tokensIn: BigInt(5), minSolOut: BigInt(1), nextTicketSeq: BigInt(0) })]), wallet, { action: "sell" });
    vetFumpadTx(tx([...cb(), swapSellIx({ user: wallet, mint, tokensIn: BigInt(5), minSolOut: BigInt(1), nextTicketSeq: BigInt(2), buybackFeeRecipient: bfr })]), wallet, { action: "sell" });
    vetFumpadTx(tx([...cb(), createAtaIdempotentIx(wallet, wallet, mint, SDK_TOKEN_2022), claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim" });
    vetFumpadTx(tx([...cb(), setAutoClaimIx({ wallet, mint, enabled: true })]), wallet, { action: "auto-claim" });
    vetFumpadTx(tx([withdrawCreatorFeesIx({ creator: wallet, mint })]), wallet, { action: "withdraw" });
  });

  it("accepts a prepared launch co-signed by the mint", () => {
    const mintKp = Keypair.generate();
    const t = tx([...cb(), createCoinIx({ creator: wallet, mint: mintKp.publicKey, name: "Pigeon", symbol: "PIGN", uri: "ipfs://x" }), buyIx({ user: wallet, mint: mintKp.publicKey, solIn: SOL / BigInt(2), minTokensOut: BigInt(1), openTickets: [] })]);
    t.sign([mintKp]);
    vetFumpadTx(t, wallet, { action: "launch", coSigner: mintKp.publicKey.toBase58(), maxSolInLamports: SOL / BigInt(2) });
    // …but not if the mint hasn't signed yet, or when no co-signer is expected.
    const unsigned = tx([createCoinIx({ creator: wallet, mint: mintKp.publicKey, name: "P", symbol: "P", uri: "u" })]);
    refused(() => vetFumpadTx(unsigned, wallet, { action: "launch", coSigner: mintKp.publicKey.toBase58() }), /co-signer/);
    refused(() => vetFumpadTx(t, wallet, { action: "launch" }), /signers/);
  });

  it("refuses a buy above the amount the user entered", () => {
    refused(() => vetFumpadTx(tx([...cb(), buy(SOL)]), wallet, { action: "buy", maxSolInLamports: SOL / BigInt(10) }), /more SOL/);
    // Two buys summed.
    refused(() => vetFumpadTx(tx([buy(SOL / BigInt(10)), buy(SOL / BigInt(10))]), wallet, { action: "buy", maxSolInLamports: SOL / BigInt(10) }), /more SOL/);
  });

  it("refuses instructions the action doesn't use", () => {
    refused(() => vetFumpadTx(tx([buy()]), wallet, { action: "sell" }), /doesn't use/);
    refused(() => vetFumpadTx(tx([setAutoClaimIx({ wallet, mint, enabled: true })]), wallet, { action: "claim" }), /doesn't use/);
    // A FUMPAD instruction outside the user set (e.g. an admin call) never matches.
    refused(() => vetFumpadTx(tx([new TransactionInstruction({ programId: FUMPAD_PROGRAM_ID, keys: [{ pubkey: wallet, isSigner: true, isWritable: true }], data: Buffer.alloc(8, 7) })]), wallet, { action: "buy" }));
  });

  it("refuses System transfers, token transfers and unknown programs", () => {
    refused(() => vetFumpadTx(tx([buy(), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: other, lamports: 1 })]), wallet, { action: "buy" }), /program/);
    const tokenTransfer = new TransactionInstruction({
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGqPFXCWuBvf9Ss623VQ5DA"),
      keys: [
        { pubkey: other, isSigner: false, isWritable: true },
        { pubkey: other, isSigner: false, isWritable: true },
        { pubkey: wallet, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([3, 1, 0, 0, 0, 0, 0, 0, 0]),
    });
    refused(() => vetFumpadTx(tx([buy(), tokenTransfer]), wallet, { action: "buy" }), /program/);
    refused(() => vetFumpadTx(tx([buy(), new TransactionInstruction({ programId: other, keys: [], data: Buffer.alloc(0) })]), wallet, { action: "buy" }), /program/);
  });

  it("refuses a transaction acting for or paid by someone else", () => {
    refused(() => vetFumpadTx(tx([buy()], other), wallet, { action: "buy" }), /fee payer/);
    refused(() => vetFumpadTx(tx([buy(SOL / BigInt(10), other)]), wallet, { action: "buy" }), /signers/);
  });

  it("refuses ATA creates for other owners or payers", () => {
    refused(() => vetFumpadTx(tx([createAtaIdempotentIx(wallet, other, mint, SDK_TOKEN_2022), claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim" }), /isn't yours/);
  });

  it("refuses outsized priority fees and odd compute budget instructions", () => {
    // 1.4M CU × 1 SOL/CU-ish price → far above the cap.
    refused(() => vetFumpadTx(tx([...cb(1_400_000, 10_000_000_000), buy()]), wallet, { action: "buy" }), /priority fee/);
    vetFumpadTx(tx([...cb(200_000, 1_000_000), buy()]), wallet, { action: "buy" }); // 0.0002 SOL: fine
    refused(() => vetFumpadTx(tx([ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }), buy()]), wallet, { action: "buy" }), /compute budget/);
  });

  it("refuses a transaction with no FUMPAD instruction", () => {
    refused(() => vetFumpadTx(tx([...cb()]), wallet, { action: "buy" }), /isn't a FUMPAD/);
  });
});

describe("vetWithdrawTx", () => {
  const send = (to: PublicKey, lamports: number, from = wallet) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

  it("accepts exactly the confirmed transfer", () => {
    vetWithdrawTx(tx([send(other, 5_000)]), wallet, other, BigInt(5_000));
    vetWithdrawTx(tx([...cb(1_000, 1), send(other, 5_000)]), wallet, other, BigInt(5_000));
  });

  it("refuses a different amount, destination, or extra instructions", () => {
    refused(() => vetWithdrawTx(tx([send(other, 5_001)]), wallet, other, BigInt(5_000)), /amount/);
    refused(() => vetWithdrawTx(tx([send(mint, 5_000)]), wallet, other, BigInt(5_000)), /destination/);
    refused(() => vetWithdrawTx(tx([send(other, 5_000), send(other, 5_000)]), wallet, other, BigInt(5_000)), /single transfer/);
    refused(() => vetWithdrawTx(tx([buy()]), wallet, other, BigInt(5_000)), /System transfer/);
  });
});
