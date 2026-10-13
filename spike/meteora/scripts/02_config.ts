// Items 2/3/4/5(config part): create a DBC config via create_config2 whose fee_claimer and leftover_receiver are
// PDAs of fumpad_dbc_spike; WSOL quote; Token-2022 base; fixed 1B supply; 80M leftover (reward pool);
// D17-shaped curve with 0.85 SOL devnet threshold; 1.25% fee + 8-slot anti-snipe scheduler; DAMM v2 migration
// with 100% partner permanent lock.
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { DynamicBondingCurveClient, createDbcProgram } from "@meteora-ag/dynamic-bonding-curve-sdk";
import Decimal from "decimal.js";
import { connection, payer, send, saveState, spikeKey, WSOL, DBC_PROGRAM } from "./common.js";
import { buildFumpadConfig, DEVNET_D17, MAINNET_D17, describe } from "./curve.js";
import { pdas } from "./spike.js";

Decimal.set({ precision: 50 });
const CREATE_CONFIG = Buffer.from([201, 207, 243, 114, 75, 111, 47, 189]);
const CREATE_CONFIG2 = Buffer.from([9, 202, 24, 203, 143, 212, 252, 81]);

async function main() {
  const { feeClaimer, rewardPool } = pdas();
  const configKp = spikeKey("config");
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const params = buildFumpadConfig(DEVNET_D17);
  const tx = await client.partner.createConfig({
    ...params,
    config: configKp.publicKey,
    feeClaimer,
    leftoverReceiver: rewardPool,
    quoteMint: WSOL,
    payer: payer.publicKey,
  });
  // SDK 1.5.13 only knows create_config (deprecated in DBC 0.2.2 on devnet). Same accounts; create_config2 adds
  // a trailing Option<TransferFeeParameters> arg -> append 0 (None).
  const ixs: TransactionInstruction[] = tx.instructions.map((ix) => {
    if (!ix.programId.equals(DBC_PROGRAM) || !ix.data.subarray(0, 8).equals(CREATE_CONFIG)) return ix;
    const data = Buffer.concat([CREATE_CONFIG2, ix.data.subarray(8), Buffer.from([0])]);
    return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data });
  });
  const exists = await connection.getAccountInfo(configKp.publicKey);
  let sig: string | undefined, cu: number | null = null;
  if (!exists) {
    const r = await send("create_config2 (DBC config, PDAs as fee_claimer + leftover_receiver)", ixs, [configKp]);
    sig = r.sig; cu = r.cu;
  }
  const { program } = createDbcProgram(connection);
  const cfg: any = await (program.account as any).poolConfig.fetch(configKp.publicKey);
  const raw = await connection.getAccountInfo(configKp.publicKey);
  const out = {
    config: configKp.publicKey.toBase58(),
    configAccountBytes: raw?.data.length,
    configRentLamports: raw?.lamports,
    feeClaimer: cfg.feeClaimer.toBase58(),
    leftoverReceiver: cfg.leftoverReceiver.toBase58(),
    quoteMint: cfg.quoteMint.toBase58(),
    tokenType: cfg.tokenType,
    activationType: cfg.activationType,
    collectFeeMode: cfg.collectFeeMode,
    migrationOption: cfg.migrationOption,
    migrationFeeOption: cfg.migrationFeeOption,
    partnerPermanentLockedLiquidityPercentage: cfg.partnerPermanentLockedLiquidityPercentage,
    creatorTradingFeePercentage: cfg.creatorTradingFeePercentage,
    swapBaseAmount: cfg.swapBaseAmount.toString(),
    migrationBaseThreshold: cfg.migrationBaseThreshold.toString(),
    migrationQuoteThreshold: cfg.migrationQuoteThreshold.toString(),
    migrationSqrtPrice: cfg.migrationSqrtPrice.toString(),
    sqrtStartPrice: cfg.sqrtStartPrice.toString(),
    preMigrationTokenSupply: cfg.preMigrationTokenSupply.toString(),
    postMigrationTokenSupply: cfg.postMigrationTokenSupply.toString(),
    fixedTokenSupplyFlag: cfg.fixedTokenSupplyFlag,
    migratedPoolFeeBps: cfg.migratedPoolFeeBps,
    migratedCollectFeeMode: cfg.migratedCollectFeeMode,
    // expected leftover = pre supply - curve tokens - migration base (before the 0.2% protocol migration fee nuance)
    expectedLeftoverRaw: cfg.preMigrationTokenSupply.sub(cfg.swapBaseAmount).sub(cfg.migrationBaseThreshold).toString(),
    poolFees: JSON.parse(JSON.stringify(cfg.poolFees)),
    enableFirstSwapWithMinFee: cfg.enableFirstSwapWithMinFee ?? null,
    createSig: sig,
    createCu: cu,
    sdkDescribeDevnet: describe(params),
    sdkDescribeMainnet: describe(buildFumpadConfig(MAINNET_D17)),
  };
  console.log(JSON.stringify({ ...out, sdkDescribeDevnet: undefined, sdkDescribeMainnet: undefined }, null, 2));
  saveState({ config: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
