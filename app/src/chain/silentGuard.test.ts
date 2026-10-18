/**
 * APP-1 / M-4: the wallet bridge re-checks every silent signature itself, on the exact bytes it hands Privy.
 * `bridgeSignTransaction` is what `components/wallet/PrivyIsland.tsx` calls; here Privy is a stub that records what it
 * was asked to sign (and signs it with the wallet's key, like the embedded wallet would).
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, coinAta, computeBudgetIxs, routerBuyIx, TOKEN_2022_PROGRAM_ID, unwrapSolIx, wrapSolIxs } from "@fumpad/sdk";
import { SilentSignRefused, type SilentPolicy } from "./allowlist";
import { bridgeSignTransaction, planBridgeSign, type SignPolicy } from "./silentGuard";

const walletKp = Keypair.generate();
const wallet = walletKp.publicKey;
const W = wallet.toBase58();
const other = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const TENTH = BigInt(100_000_000);
const BLOCKHASH = "11111111111111111111111111111111";

const coinAtaIx = () =>
  new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: coinAta(wallet, mint), isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
const tx = (ixs: TransactionInstruction[]) => new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message());
const buyIx = (amountIn = TENTH) => routerBuyIx({ trader: wallet, coin: { mint, dbcConfig: config }, venue: "dbc", amountIn, minOut: BigInt(1), mode: 1 });
/** Exactly what the app's buy builder emits. */
const buyTx = (extra: TransactionInstruction[] = [], amountIn = TENTH) => tx([...computeBudgetIxs(200_000), coinAtaIx(), ...wrapSolIxs(wallet, amountIn), buyIx(amountIn), unwrapSolIx(wallet), ...extra]);
const buyPolicy: SilentPolicy = { action: "buy", mint: mint.toBase58(), maxSolInLamports: TENTH, amountIn: TENTH, minOut: BigInt(1) };
const fumpad = (policy: SilentPolicy = buyPolicy): SignPolicy => ({ kind: "fumpad", policy });
const steal = (lamports = 1) => SystemProgram.transfer({ fromPubkey: wallet, toPubkey: other, lamports });
const withdrawTx = (to = other, lamports = 5_000) => tx([SystemProgram.transfer({ fromPubkey: wallet, toPubkey: to, lamports })]);
const withdraw = (lamports = BigInt(5_000), destination = other.toBase58()): SignPolicy => ({ kind: "withdraw", destination, lamports });

/** Privy stub: records each call and signs what it got with the wallet's key. */
function privy(rewrite?: (t: VersionedTransaction) => VersionedTransaction) {
  const calls: { bytes: Uint8Array; showWalletUIs: boolean }[] = [];
  const sign = async (bytes: Uint8Array, showWalletUIs: boolean) => {
    calls.push({ bytes, showWalletUIs });
    let t = VersionedTransaction.deserialize(bytes);
    if (rewrite) t = rewrite(t);
    t.sign([walletKp]);
    return t.serialize();
  };
  return { calls, sign };
}
const refusedAsync = (p: Promise<unknown>, re?: RegExp) => assert.rejects(p, (e: unknown) => e instanceof SilentSignRefused && (!re || re.test(e.message)));

describe("bridgeSignTransaction: silent signatures are re-checked inside the bridge", () => {
  it("signs an allow-listed transaction silently, with the exact bytes it checked", async () => {
    const t = buyTx();
    const p = privy();
    const signed = await bridgeSignTransaction({ address: W, tx: t, silent: true, policy: fumpad() }, p.sign);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].showWalletUIs, false);
    assert.deepEqual(p.calls[0].bytes, Uint8Array.from(t.serialize()));
    assert.deepEqual(signed.message.serialize(), t.message.serialize());
  });

  it("never calls Privy for a tampered transaction under a silent policy", async () => {
    const p = privy();
    const tampered = [
      buyTx([steal()]), // SOL out to someone else appended
      buyTx([], TENTH * BigInt(10)), // a bigger buy than entered
      tx([...computeBudgetIxs(200_000), steal(Number(TENTH))]), // a plain transfer under a buy policy
      tx([...computeBudgetIxs(200_000, 1e9), coinAtaIx(), ...wrapSolIxs(wallet, TENTH), buyIx(), unwrapSolIx(wallet)]), // outsized priority fee
    ];
    for (const t of tampered) await refusedAsync(bridgeSignTransaction({ address: W, tx: t, silent: true, policy: fumpad() }, p.sign));
    // the right transaction for another wallet / coin
    await refusedAsync(bridgeSignTransaction({ address: other.toBase58(), tx: buyTx(), silent: true, policy: fumpad() }, p.sign), /fee payer/);
    await refusedAsync(bridgeSignTransaction({ address: W, tx: buyTx(), silent: true, policy: fumpad({ ...buyPolicy, mint: other.toBase58() }) }, p.sign));
    // a writable flag added to a read-only account (APP-9), same keys and data
    const b = buyIx();
    const flagged = new TransactionInstruction({ programId: b.programId, data: b.data, keys: b.keys.map((m, i) => (i === 1 ? { ...m, isWritable: true } : m)) });
    await refusedAsync(bridgeSignTransaction({ address: W, tx: tx([...computeBudgetIxs(200_000), coinAtaIx(), ...wrapSolIxs(wallet, TENTH), flagged, unwrapSolIx(wallet)]), silent: true, policy: fumpad() }, p.sign), /writable/);
    assert.equal(p.calls.length, 0);
  });

  it("a silent request without a policy is not silent: Privy shows its approval window", async () => {
    const p = privy();
    await bridgeSignTransaction({ address: W, tx: buyTx([steal()]), silent: true }, p.sign);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].showWalletUIs, true);
    // and a non-silent request always shows it
    await bridgeSignTransaction({ address: W, tx: withdrawTx(), silent: false, policy: withdraw() }, p.sign);
    assert.equal(p.calls[1].showWalletUIs, true);
  });

  it("the withdrawal: only exactly the confirmed transfer signs silently", async () => {
    const p = privy();
    await bridgeSignTransaction({ address: W, tx: withdrawTx(), silent: true, policy: withdraw() }, p.sign);
    assert.equal(p.calls[0].showWalletUIs, false);
    const third = Keypair.generate().publicKey;
    await refusedAsync(bridgeSignTransaction({ address: W, tx: withdrawTx(third), silent: true, policy: withdraw() }, p.sign), /destination/);
    await refusedAsync(bridgeSignTransaction({ address: W, tx: withdrawTx(other, 5_001), silent: true, policy: withdraw() }, p.sign), /amount/);
    await refusedAsync(bridgeSignTransaction({ address: W, tx: tx([steal(5_000), steal(5_000)]), silent: true, policy: withdraw() }, p.sign), /single transfer/);
    await refusedAsync(bridgeSignTransaction({ address: W, tx: withdrawTx(), silent: true, policy: withdraw(BigInt(0)) }, p.sign), /amount/);
    await refusedAsync(bridgeSignTransaction({ address: W, tx: withdrawTx(), silent: true, policy: withdraw(BigInt(5_000), "not-an-address") }, p.sign), /destination/);
    // a buy can't ride on a withdraw policy, a withdrawal can't ride on a buy policy
    await refusedAsync(bridgeSignTransaction({ address: W, tx: buyTx(), silent: true, policy: withdraw() }, p.sign));
    await refusedAsync(bridgeSignTransaction({ address: W, tx: withdrawTx(), silent: true, policy: fumpad() }, p.sign));
    await refusedAsync(bridgeSignTransaction({ address: W, tx: withdrawTx(), silent: true, policy: { kind: "other" } as unknown as SignPolicy }, p.sign), /unknown signing policy/);
    assert.equal(p.calls.length, 1);
  });

  it("checks the bytes it hands Privy, not a mutable object the caller can change afterwards", () => {
    const t = buyTx();
    const plan = planBridgeSign({ address: W, tx: t, silent: true, policy: fumpad() });
    // changing the caller's object after the plan doesn't change what goes to Privy
    t.message.compiledInstructions.push({ programIdIndex: 0, accountKeyIndexes: [], data: new Uint8Array([1]) });
    assert.deepEqual(VersionedTransaction.deserialize(plan.bytes).message.compiledInstructions.length, buyTx().message.compiledInstructions.length);
  });

  it("throws away a signature over a different message (a wallet that rewrites the transaction)", async () => {
    const p = privy(() => new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: new PublicKey(Keypair.generate().publicKey).toBase58(), instructions: [steal()] }).compileToV0Message()));
    await assert.rejects(bridgeSignTransaction({ address: W, tx: buyTx(), silent: true, policy: fumpad() }, p.sign), /changed the transaction/);
  });
});
