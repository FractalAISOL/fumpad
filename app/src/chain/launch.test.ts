/**
 * M-1 regression (was security-review/app-poc/launch-buy-redirect.test.ts): the app must bind the
 * API's prepared launch to the reserved mint, the form's metadata and the first buy the user
 * typed. Transactions are assembled from the SDK's encoders (no RPC). `npm test`
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buyIx, computeBudgetIxs, createCoinIx, DEFAULT_PARAMS } from "@fumpad/sdk";
import { Keypair, type PublicKey, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { checkLaunchBinding, expectedFirstBuy, type LaunchIntent } from "./launch";

const SOL = BigInt(1_000_000_000);
const BLOCKHASH = "11111111111111111111111111111111";
const wallet = Keypair.generate().publicKey;
const mintKp = Keypair.generate();
const MINT = mintKp.publicKey.toBase58();
// Grinding a real `…fmbL` key takes minutes; the checks take the suffix as a parameter.
const SUFFIX = MINT.slice(-1);
const FORM = { name: "Pigeon Nation", symbol: "PIGN", uri: "ipfs://bafy-pign" };
const BUDGET = SOL / BigInt(2);
const first = expectedFirstBuy(DEFAULT_PARAMS, BUDGET)!;

const intent = (over: Partial<LaunchIntent> = {}): LaunchIntent => ({
  wallet,
  mint: MINT,
  suffix: SUFFIX,
  ...FORM,
  initialBuyLamports: BUDGET,
  params: DEFAULT_PARAMS,
  ...over,
});

function prepared(ixs: TransactionInstruction[], signer = mintKp, payer: PublicKey = wallet): VersionedTransaction {
  const t = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: [...computeBudgetIxs(400_000), ...ixs] }).compileToV0Message());
  t.sign([signer]);
  return t;
}
const create = (m: Partial<typeof FORM> = {}, mint: PublicKey = mintKp.publicKey) => createCoinIx({ creator: wallet, mint, ...FORM, ...m });
const firstBuy = (o: { mint?: PublicKey; solIn?: bigint; minTokensOut?: bigint } = {}) =>
  buyIx({ user: wallet, mint: o.mint ?? mintKp.publicKey, solIn: o.solIn ?? first.solIn, minTokensOut: o.minTokensOut ?? first.minTokensOut, openTickets: [] });
const refused = (t: VersionedTransaction, i: LaunchIntent, re: RegExp) => assert.throws(() => checkLaunchBinding(t, i), (e: unknown) => e instanceof Error && /^Refusing to sign/.test(e.message) && re.test(e.message));

describe("checkLaunchBinding (M-1)", () => {
  it("accepts the launch the API should build", () => {
    const info = checkLaunchBinding(prepared([create(), firstBuy()]), intent());
    assert.equal(info.mint, MINT);
    assert.equal(info.buySolIn, first.solIn);
    // …and a launch without a first buy.
    checkLaunchBinding(prepared([create()]), intent({ initialBuyLamports: BigInt(0) }));
  });

  it("the first buy is the budget minus the 1% fee, with 1% slippage", () => {
    assert.ok(first.solIn < BUDGET && first.solIn > (BUDGET * BigInt(98)) / BigInt(100));
    assert.ok(first.minTokensOut > BigInt(0) && first.minTokensOut < first.tokensOut);
  });

  it("refuses the PoC: first buy redirected to another coin with min_tokens_out = 0", () => {
    const attackerCoin = Keypair.generate().publicKey;
    const poc = prepared([
      createCoinIx({ creator: wallet, mint: mintKp.publicKey, name: "NOT WHAT YOU TYPED", symbol: "SCAM", uri: "https://attacker.example/m.json" }),
      buyIx({ user: wallet, mint: attackerCoin, solIn: BigInt(5) * SOL, minTokensOut: BigInt(0), openTickets: [] }),
    ]);
    assert.throws(() => checkLaunchBinding(poc, intent({ initialBuyLamports: BigInt(5) * SOL })), /Refusing to sign/);
    // Each half of the attack on its own:
    refused(prepared([create(), firstBuy({ mint: attackerCoin })]), intent(), /first buy/);
    refused(prepared([create({ name: "NOT WHAT YOU TYPED" }), firstBuy()]), intent(), /name, symbol or metadata/);
  });

  it("refuses different metadata", () => {
    refused(prepared([create({ symbol: "PІGN" }), firstBuy()]), intent(), /name, symbol or metadata/); // Cyrillic І
    refused(prepared([create({ uri: "https://attacker.example/m.json" }), firstBuy()]), intent(), /name, symbol or metadata/);
  });

  it("refuses a different mint than the reserved one", () => {
    const other = Keypair.generate();
    refused(prepared([create({}, other.publicKey), firstBuy({ mint: other.publicKey })], other), intent(), /signers|different mint/);
  });

  it("refuses a first buy that spends a different amount or has no slippage bound", () => {
    refused(prepared([create(), firstBuy({ solIn: first.solIn + BigInt(1) })]), intent(), /different amount/);
    refused(prepared([create(), firstBuy({ solIn: first.solIn - BigInt(1_000) })]), intent(), /different amount/);
    refused(prepared([create(), firstBuy({ minTokensOut: BigInt(0) })]), intent(), /minimum tokens/);
    refused(prepared([create(), firstBuy({ minTokensOut: first.minTokensOut - BigInt(1) })]), intent(), /minimum tokens/);
    refused(prepared([create(), firstBuy({ minTokensOut: first.tokensOut + BigInt(1) })]), intent(), /minimum tokens/);
  });

  it("refuses an added or missing first buy", () => {
    refused(prepared([create(), firstBuy()]), intent({ initialBuyLamports: BigInt(0) }), /didn't ask for/);
    refused(prepared([create()]), intent(), /missing/);
    refused(prepared([create(), firstBuy()]), intent({ params: undefined }), /launch parameters/);
  });

  it("refuses a mint signature that doesn't verify", () => {
    const t = prepared([create(), firstBuy()]);
    t.signatures[1] = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
    refused(t, intent(), /signature|signed/);
  });
});
