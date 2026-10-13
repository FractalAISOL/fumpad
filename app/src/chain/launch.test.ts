/**
 * M-1 launch binding, v0.7: the API's prepared launch (DBC init → creator's first buy →
 * register_coin, co-signed by the mint) must be exactly the coin and first buy the user asked
 * for. The first-buy quote is pinned to Meteora's official SDK on the devnet config.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { type DbcPoolConfig, launchInstructions, wrapSolIxs, withSlippage } from "@fumpad/sdk";
import { readDbcConfig } from "./build";
import { DEVNET_DBC_CONFIG, SDK_FRESH_BUYS } from "./fixtures/devnetDbcConfig";
import { checkLaunchBinding, expectedFirstBuy, LAUNCH_SLIPPAGE_BPS, type LaunchIntent, quoteFirstBuy } from "./launch";

const curve = readDbcConfig(new Uint8Array(DEVNET_DBC_CONFIG));
const readCurve = async () => curve;
const wallet = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const BUDGET = BigInt(100_000_000);

/**
 * A reserved mint. Grinding a real `…fmbL` key takes minutes, so the tests pass each key's own
 * last 4 characters as the vanity suffix (the check is the same).
 */
const vanityKeypair = () => Keypair.generate();

/** The API's launch (@fumpad/sdk `launchInstructions`, as `POST /v1/launch/prepare` builds it), signed by the mint. */
function launch(mintKp: Keypair, o: { buyIn?: bigint; minOut?: bigint; name?: string; symbol?: string; uri?: string; wrap?: bigint } = {}) {
  const m = mintKp.publicKey;
  const ixs = launchInstructions({
    creator: wallet,
    mint: m,
    dbcConfig: config,
    name: o.name ?? "Pigeon",
    symbol: o.symbol ?? "PIGN",
    uri: o.uri ?? "ipfs://pign",
    buyLamports: o.buyIn,
    minTokensOut: o.buyIn ? (o.minOut ?? expectedFirstBuy(curve, o.buyIn)!.minTokensOut) : undefined,
  });
  // An extra wrap on top of the buy (more SOL moved than typed).
  if (o.wrap) ixs.splice(1, 0, ...wrapSolIxs(wallet, o.wrap - (o.buyIn ?? BigInt(0))));
  const t = new VersionedTransaction(
    new TransactionMessage({ payerKey: wallet, recentBlockhash: "11111111111111111111111111111111", instructions: ixs }).compileToV0Message(),
  );
  t.sign([mintKp]);
  return t;
}

const intentFor = (mintKp: Keypair, initialBuyLamports = BigInt(0)): LaunchIntent => {
  const mint = mintKp.publicKey.toBase58();
  return { wallet, mint, suffix: mint.slice(-4), name: "Pigeon", symbol: "PIGN", uri: "ipfs://pign", initialBuyLamports };
};
const refused = (p: Promise<unknown>, re: RegExp) => assert.rejects(p, (e: unknown) => e instanceof Error && re.test(e.message));

describe("DBC config + first-buy math (@fumpad/sdk, pinned to Meteora's official SDK)", () => {
  it("decodes the devnet config: 99% → 1.25% scheduler, first swap at the min fee, 0.85 SOL threshold", () => {
    const b = curve.baseFee;
    assert.equal(b.cliffFeeNumerator - b.reductionFactor * BigInt(b.numberOfPeriod), BigInt(12_500_000));
    assert.equal(curve.enableFirstSwapWithMinFee, 1);
    assert.equal(curve.migrationQuoteThreshold, BigInt(850_000_000));
    assert.equal(curve.swapBaseAmount, BigInt("729655071047103"));
    assert.equal(curve.sqrtStartPrice, BigInt("10169090682030081"));
  });

  it("quotes a fresh pool's first buy exactly as Meteora's SDK does", () => {
    for (const [lamports, out] of SDK_FRESH_BUYS) assert.equal(quoteFirstBuy(curve, lamports), out);
  });

  it("refuses config bytes that aren't a DBC PoolConfig", () => {
    const bad = new Uint8Array(DEVNET_DBC_CONFIG);
    bad[0] ^= 1;
    assert.throws(() => readDbcConfig(bad), /Unexpected DBC config/);
    assert.throws(() => readDbcConfig(new Uint8Array(DEVNET_DBC_CONFIG).subarray(0, 1000)), /Unexpected DBC config/);
  });

  it("the first buy is the budget (fee included) with 1% slippage on the SDK quote", () => {
    const want = expectedFirstBuy(curve, BUDGET)!;
    assert.equal(LAUNCH_SLIPPAGE_BPS, 100);
    assert.equal(want.amountIn, BUDGET);
    assert.equal(want.tokensOut, SDK_FRESH_BUYS[1][1]);
    assert.equal(want.minTokensOut, withSlippage(SDK_FRESH_BUYS[1][1], 100));
    assert.equal(expectedFirstBuy(curve, BigInt(0)), null);
  });
});

describe("checkLaunchBinding", () => {
  it("accepts the launch the user reviewed, with and without a first buy", async () => {
    const k = vanityKeypair();
    const plain = await checkLaunchBinding(launch(k), intentFor(k), readCurve);
    assert.equal(plain.symbol, "PIGN");
    const withBuy = await checkLaunchBinding(launch(k, { buyIn: BUDGET }), intentFor(k, BUDGET), readCurve);
    assert.equal(withBuy.firstBuy?.amountIn, BUDGET);
  });

  it("refuses other metadata than what the user entered", async () => {
    const k = vanityKeypair();
    await refused(checkLaunchBinding(launch(k, { name: "Pigeon2" }), intentFor(k), readCurve), /metadata/);
    await refused(checkLaunchBinding(launch(k, { symbol: "PIGM" }), intentFor(k), readCurve), /metadata/);
    await refused(checkLaunchBinding(launch(k, { uri: "ipfs://other" }), intentFor(k), readCurve), /metadata/);
  });

  it("refuses a mint that isn't the reserved vanity mint", async () => {
    const k = vanityKeypair();
    await refused(checkLaunchBinding(launch(k), { ...intentFor(k), suffix: "fmbL" }, readCurve), /isn't a FUMPAD address/);
    const other = vanityKeypair();
    await refused(checkLaunchBinding(launch(k), { ...intentFor(other) }, readCurve), /reserved mint|signers/);
  });

  it("refuses a first buy the user didn't ask for, a missing one, or a different amount", async () => {
    const k = vanityKeypair();
    await refused(checkLaunchBinding(launch(k, { buyIn: BUDGET }), intentFor(k), readCurve), /more SOL|didn't ask/);
    await refused(checkLaunchBinding(launch(k), intentFor(k, BUDGET), readCurve), /missing/);
    await refused(checkLaunchBinding(launch(k, { buyIn: BUDGET / BigInt(2) }), intentFor(k, BUDGET), readCurve), /different amount/);
    await refused(checkLaunchBinding(launch(k, { buyIn: BUDGET * BigInt(2) }), intentFor(k, BUDGET), readCurve), /more SOL/);
    // The buy amount matches but more SOL is wrapped than typed.
    await refused(checkLaunchBinding(launch(k, { buyIn: BUDGET, wrap: BUDGET * BigInt(3) }), intentFor(k, BUDGET), readCurve), /more SOL/);
  });

  it("refuses a first buy without a real slippage bound, or one above the quote", async () => {
    const k = vanityKeypair();
    const want = expectedFirstBuy(curve, BUDGET)!;
    await refused(checkLaunchBinding(launch(k, { buyIn: BUDGET, minOut: BigInt(1) }), intentFor(k, BUDGET), readCurve), /minimum tokens/);
    await refused(
      checkLaunchBinding(launch(k, { buyIn: BUDGET, minOut: want.minTokensOut - BigInt(1_000) }), intentFor(k, BUDGET), readCurve),
      /minimum tokens/,
    );
    await refused(checkLaunchBinding(launch(k, { buyIn: BUDGET, minOut: want.tokensOut + BigInt(1_000) }), intentFor(k, BUDGET), readCurve), /minimum tokens/);
    // Within rounding slack of the API's own math: fine.
    await checkLaunchBinding(launch(k, { buyIn: BUDGET, minOut: want.minTokensOut - BigInt(5) }), intentFor(k, BUDGET), readCurve);
  });

  it("refuses when the curve can't be read, or its first swap would pay the launch-window fee", async () => {
    const k = vanityKeypair();
    const tx = launch(k, { buyIn: BUDGET });
    await refused(
      checkLaunchBinding(tx, intentFor(k, BUDGET), async () => {
        throw new Error("rpc down");
      }),
      /couldn't read/,
    );
    const noMin: DbcPoolConfig = { ...curve, enableFirstSwapWithMinFee: 0 };
    await refused(
      checkLaunchBinding(tx, intentFor(k, BUDGET), async () => noMin),
      /snipe fee/,
    );
  });
});
