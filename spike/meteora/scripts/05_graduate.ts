// Items 3 + 9: complete the curve (PartialFill buy), migrate to DAMM v2 ourselves (permissionless), withdraw the
// leftover into the reward pool (PDA ATA) and verify: 8% reward pool, LP position NFT owned by our fee_claimer PDA,
// 100% permanently locked.
import BN from "bn.js";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount, getMint } from "@solana/spl-token";
import { DynamicBondingCurveClient, DAMM_V2_MIGRATION_FEE_ADDRESS, createDammV2Program, derivePositionNftAccount } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, payer, send, saveState, loadState, getTx } from "./common.js";
import { dbcSwapIx, poolKeys, ata, baseAta, prepUser, fetchPool } from "./dbc.js";
import { parseSwaps, fmt } from "./events.js";
import { pdas } from "./spike.js";

async function main() {
  const st = loadState();
  const config = new PublicKey(st.config.config);
  const mint = new PublicKey(st.launch.mint);
  const { pool, baseVault, quoteVault } = poolKeys(config, mint);
  const { feeClaimer, rewardPool } = pdas();
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const out: any = {};

  let ps: any = (await fetchPool(pool)).poolState ?? (await fetchPool(pool));
  const thr = BigInt(st.config.migrationQuoteThreshold);
  const need = thr - BigInt(ps.quoteReserve.toString());
  out.beforeComplete = { quoteReserve: ps.quoteReserve.toString(), threshold: thr.toString(), need: need.toString(), migrationProgress: ps.migrationProgress };
  console.log(out.beforeComplete);

  if (ps.migrationProgress === 0) {
    // 1) exact-in that would overshoot must FAIL (swaps stop at the migration price) — show via simulation
    const overIx = await dbcSwapIx({ config, baseMint: mint, owner: payer.publicKey, buy: true, amount0: new BN((need * 2n).toString()), amount1: new BN(1), mode: 0 });
    const wrapAmt = (need * 103n) / 100n + 2_000_000n; // + 1.25% fee + slack
    try {
      await send("ExactIn overshooting buy (expected to FAIL)", [...prepUser(payer.publicKey, payer.publicKey, mint, need * 2n + 1_000_000n), overIx], []);
      out.overshootExactIn = "UNEXPECTED SUCCESS";
    } catch (e: any) {
      out.overshootExactIn = "failed as expected: " + String(e?.message ?? e).slice(0, 300);
    }
    // 2) PartialFill completes exactly at the migration price; excess input is not taken
    const fillIx = await dbcSwapIx({ config, baseMint: mint, owner: payer.publicKey, buy: true, amount0: new BN((need * 2n).toString()), amount1: new BN(1), mode: 1 });
    const c = await send("PartialFill buy completes the curve", [...prepUser(payer.publicKey, payer.publicKey, mint, need * 2n + 1_000_000n), fillIx], []);
    out.complete = { sig: c.sig, cu: c.cu, parsed: parseSwaps((await getTx(c.sig))!).map((s) => JSON.parse(fmt(s))) };
    console.log(JSON.stringify(out.complete, null, 2));
    void wrapAmt;
  }
  ps = (await fetchPool(pool)).poolState;
  out.afterComplete = { quoteReserve: ps.quoteReserve.toString(), baseReserve: ps.baseReserve.toString(), migrationProgress: ps.migrationProgress, finishCurveTimestamp: ps.finishCurveTimestamp.toString() };
  console.log(out.afterComplete);

  // supply snapshot before migration
  const supply = (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  const baseVaultBal = (await getAccount(connection, baseVault, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  out.preMigration = { mintSupply: supply.toString(), baseVault: baseVaultBal.toString() };

  // 3) migrate (permissionless; we are the "keeper")
  const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[6];
  const balBefore = await connection.getBalance(payer.publicKey);
  const mig = await client.migration.migrateToDammV2({ payer: payer.publicKey, pool, dammConfig } as any);
  const m = await send("migration_damm_v2 (permissionless, called by us)", mig.transaction.instructions, [mig.firstPositionNftKeypair, mig.secondPositionNftKeypair], { cuLimit: 600_000 });
  const balAfter = await connection.getBalance(payer.publicKey);
  out.migrate = { sig: m.sig, cu: m.cu, payerLamportsDelta: balAfter - balBefore, firstPositionNftMint: mig.firstPositionNftKeypair.publicKey.toBase58(), secondPositionNftMint: mig.secondPositionNftKeypair.publicKey.toBase58() };
  console.log(out.migrate);

  // 4) withdraw leftover -> reward pool ATA (permissionless when no transfer fee)
  const rpAta = baseAta(rewardPool, mint);
  const rpBefore = (await getAccount(connection, rpAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const wl = await client.migration.withdrawLeftover({ payer: payer.publicKey, pool } as any);
  const w = await send("withdraw_leftover -> reward_pool PDA ATA (permissionless)", wl.instructions, []);
  const rpAfter = (await getAccount(connection, rpAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  const supplyAfter = (await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID)).supply;
  out.leftover = {
    sig: w.sig, cu: w.cu, leftoverReceived: (rpAfter - rpBefore).toString(), rewardPoolTotal: rpAfter.toString(),
    pctOfSupply: Number(((rpAfter - rpBefore) * 1_000_000n) / supplyAfter) / 10_000, mintSupplyAfter: supplyAfter.toString(),
    expectedFromConfig: st.config.expectedLeftoverRaw,
  };
  console.log(out.leftover);

  // 5) verify DAMM v2 pool + positions
  const damm = createDammV2Program(connection) as any;
  ps = (await fetchPool(pool)).poolState;
  const dammPool = (await import("@meteora-ag/dynamic-bonding-curve-sdk")).deriveDammV2PoolAddress(dammConfig, mint, NATIVE_MINT);
  const dp: any = await damm.account.pool.fetch(dammPool);
  const positions = [];
  for (const nft of [mig.firstPositionNftKeypair.publicKey, mig.secondPositionNftKeypair.publicKey]) {
    const nftAcc = derivePositionNftAccount(nft);
    const info = await connection.getAccountInfo(nftAcc);
    if (!info) { positions.push({ nft: nft.toBase58(), exists: false }); continue; }
    const tokAcc = await getAccount(connection, nftAcc, "confirmed", TOKEN_2022_PROGRAM_ID);
    const posAddr = (await import("@meteora-ag/dynamic-bonding-curve-sdk")).derivePositionAddress(nft);
    const pos: any = await damm.account.position.fetch(posAddr);
    positions.push({
      nft: nft.toBase58(), nftAccount: nftAcc.toBase58(), nftOwner: tokAcc.owner.toBase58(), nftOwnerIsFeeClaimerPda: tokAcc.owner.equals(feeClaimer), nftAmount: tokAcc.amount.toString(),
      position: posAddr.toBase58(), unlockedLiquidity: pos.unlockedLiquidity.toString(), vestedLiquidity: pos.vestedLiquidity.toString(), permanentLockedLiquidity: pos.permanentLockedLiquidity.toString(),
    });
  }
  out.damm = {
    pool: dammPool.toBase58(), liquidity: dp.liquidity.toString(), permanentLockLiquidity: dp.permanentLockLiquidity.toString(), sqrtPrice: dp.sqrtPrice.toString(),
    collectFeeMode: dp.collectFeeMode, protocolFeePercent: dp.poolFees.protocolFeePercent, referralFeePercent: dp.poolFees.referralFeePercent,
    cliffFeeNumerator: JSON.parse(JSON.stringify(dp.poolFees.baseFee)), creator: dp.creator.toBase58(), tokenAAmount: dp.tokenAAmount.toString(), tokenBAmount: dp.tokenBAmount.toString(),
    positions, dbcMigrationProgress: ps.migrationProgress, isMigrated: ps.isMigrated, protocolMigrationBaseFee: ps.protocolMigrationBaseFeeAmount?.toString(), protocolMigrationQuoteFee: ps.protocolMigrationQuoteFeeAmount?.toString(),
  };
  console.log(JSON.stringify(out.damm, null, 2));
  saveState({ graduate: out, dammPool: dammPool.toBase58(), positionNft: mig.firstPositionNftKeypair.publicKey.toBase58(), positionNft2: mig.secondPositionNftKeypair.publicKey.toBase58() });
}
main().catch((e) => { console.error(e); process.exit(1); });
