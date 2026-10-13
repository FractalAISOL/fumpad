// Items 6, 8, 10(price on DBC), 11 (DBC), 12 (buyback on curve):
//  a) FUMPAD-routed buy + sell on the DBC curve via CPI (user signs), exact amounts measured on-chain
//  b) third-party style swap via the Meteora SDK (no FUMPAD), parsed from the tx (EvtSwap3)
//  c) claim partner trading fees via CPI with PDA signer + 50/30/20 split in the same instruction
//  d) fee-funded buyback on the curve with the buyback PDA as payer, tokens land in the reward pool ATA
//  e) read_price from VirtualPool bytes vs SDK decode
import BN from "bn.js";
import { PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, getAccount,
} from "@solana/spl-token";
import { DynamicBondingCurveClient } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, payer, send, saveState, loadState, spikeKey, getTx } from "./common.js";
import { dbcSwapIx, dbcClaimTradingFeeIx, poolKeys, ata, baseAta, prepUser, fetchPool } from "./dbc.js";
import { parseSwaps, fmt } from "./events.js";
import { pdas, routedSwapIx, buybackSwapIx, claimAndSplitIx, readPriceIx, returnData } from "./spike.js";

const bal = async (a: PublicKey, prog = TOKEN_PROGRAM_ID) => (await getAccount(connection, a, "confirmed", prog)).amount;
const logLines = (logs: string[]) => logs.filter((l) => l.includes("FUMPAD_"));

async function main() {
  const st = loadState();
  const config = new PublicKey(st.config.config);
  const mint = new PublicKey(st.launch.mint);
  const { pool } = poolKeys(config, mint);
  const { feeClaimer, rewardPool, buyback } = pdas();
  const platform = spikeKey("platform");
  const creator = new PublicKey(st.launch.creator);
  const sniper = spikeKey("sniper");
  const out: any = {};

  // --- setup token accounts: user (payer), fee_claimer (WSOL + base), buyback WSOL, platform WSOL, reward_pool base
  await send("setup ATAs (user, fee_claimer, buyback, platform, reward_pool)", [
    ...prepUser(payer.publicKey, payer.publicKey, mint, BigInt(0.05 * LAMPORTS_PER_SOL)),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(feeClaimer, NATIVE_MINT), feeClaimer, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, baseAta(feeClaimer, mint), feeClaimer, mint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(buyback, NATIVE_MINT), buyback, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(platform.publicKey, NATIVE_MINT), platform.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, baseAta(rewardPool, mint), rewardPool, mint, TOKEN_2022_PROGRAM_ID),
  ], []);

  // --- a) routed buy
  const buyIx = await dbcSwapIx({ config, baseMint: mint, owner: payer.publicKey, buy: true, amount0: new BN(0.02 * LAMPORTS_PER_SOL), amount1: new BN(1) });
  const rb = await send("FUMPAD routed_swap BUY on DBC (CPI)", [routedSwapIx(payer.publicKey, buyIx, 3, 4)], [], { cuLimit: 300_000 });
  const rbd = returnData(rb.logs)!;
  const rbEv = parseSwaps((await getTx(rb.sig))!);
  out.routedBuy = { sig: rb.sig, cu: rb.cu, measured: { spent: rbd.readBigUInt64LE(0).toString(), received: rbd.readBigUInt64LE(8).toString() }, programLog: logLines(rb.logs), venueEvent: rbEv.map((s) => JSON.parse(fmt(s))) };
  console.log(JSON.stringify(out.routedBuy, null, 2));

  // --- a) routed sell (half of what we got)
  const sellAmt = new BN(rbd.readBigUInt64LE(8).toString()).divn(2);
  const sellIx = await dbcSwapIx({ config, baseMint: mint, owner: payer.publicKey, buy: false, amount0: sellAmt, amount1: new BN(1) });
  const rs = await send("FUMPAD routed_swap SELL on DBC (CPI)", [routedSwapIx(payer.publicKey, sellIx, 3, 4)], [], { cuLimit: 300_000 });
  const rsd = returnData(rs.logs)!;
  const rsEv = parseSwaps((await getTx(rs.sig))!);
  out.routedSell = { sig: rs.sig, cu: rs.cu, measured: { spent: rsd.readBigUInt64LE(0).toString(), received: rsd.readBigUInt64LE(8).toString() }, programLog: logLines(rs.logs), venueEvent: rsEv.map((s) => JSON.parse(fmt(s))) };
  console.log(JSON.stringify(out.routedSell, null, 2));

  // --- b) third-party-style swaps with the official SDK (sniper wallet), buy then sell
  const client = new DynamicBondingCurveClient(connection, "confirmed");
  const tpBuy = await client.pool.swap({ owner: sniper.publicKey, pool, amountIn: new BN(0.005 * LAMPORTS_PER_SOL), minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: null });
  const tb = await send("third-party (Meteora SDK) BUY on DBC", tpBuy.instructions, [sniper]);
  const sniperBase = await bal(baseAta(sniper.publicKey, mint), TOKEN_2022_PROGRAM_ID);
  const tpSell = await client.pool.swap({ owner: sniper.publicKey, pool, amountIn: new BN((sniperBase / 4n).toString()), minimumAmountOut: new BN(1), swapBaseForQuote: true, referralTokenAccount: null });
  const ts = await send("third-party (Meteora SDK) SELL on DBC", tpSell.instructions, [sniper]);
  out.thirdPartyDbc = {
    buy: { sig: tb.sig, cu: tb.cu, parsed: parseSwaps((await getTx(tb.sig))!).map((s) => JSON.parse(fmt(s))) },
    sell: { sig: ts.sig, cu: ts.cu, parsed: parseSwaps((await getTx(ts.sig))!).map((s) => JSON.parse(fmt(s))) },
  };
  console.log(JSON.stringify(out.thirdPartyDbc, null, 2));

  // --- c) claim partner trading fees via CPI (PDA signer) + 50/30/20 split
  const poolBefore: any = await fetchPool(pool);
  const claimIx = await dbcClaimTradingFeeIx({ config, baseMint: mint, feeClaimer, tokenA: baseAta(feeClaimer, mint), tokenB: ata(feeClaimer, NATIVE_MINT) });
  const before = { buyback: await bal(ata(buyback, NATIVE_MINT)), platform: await bal(ata(platform.publicKey, NATIVE_MINT)), creator: await bal(ata(creator, NATIVE_MINT)) };
  const cs = await send("claim_and_split: DBC claim_trading_fee via CPI (fee_claimer PDA) + 50/30/20", [claimAndSplitIx({
    venueIx: claimIx, baseIdx: 3, quoteIdx: 4, feeQuote: ata(feeClaimer, NATIVE_MINT), buybackQuote: ata(buyback, NATIVE_MINT),
    platformQuote: ata(platform.publicKey, NATIVE_MINT), creatorQuote: ata(creator, NATIVE_MINT), quoteMint: NATIVE_MINT,
  })], [], { cuLimit: 300_000 });
  const after = { buyback: await bal(ata(buyback, NATIVE_MINT)), platform: await bal(ata(platform.publicKey, NATIVE_MINT)), creator: await bal(ata(creator, NATIVE_MINT)) };
  out.claimDbc = {
    sig: cs.sig, cu: cs.cu, partnerQuoteFeeBefore: poolBefore.poolState.partnerQuoteFee.toString(), programLog: logLines(cs.logs),
    deltas: { buyback: (after.buyback - before.buyback).toString(), platform: (after.platform - before.platform).toString(), creator: (after.creator - before.creator).toString() },
  };
  console.log(JSON.stringify(out.claimDbc, null, 2));

  // --- d) buyback on the curve: buyback PDA spends its WSOL, tokens go straight into the reward pool ATA
  const bbAmt = await bal(ata(buyback, NATIVE_MINT));
  const rpBefore = await bal(baseAta(rewardPool, mint), TOKEN_2022_PROGRAM_ID);
  const bbIx = await dbcSwapIx({ config, baseMint: mint, owner: buyback, buy: true, amount0: new BN(bbAmt.toString()), amount1: new BN(1), inputAccount: ata(buyback, NATIVE_MINT), outputAccount: baseAta(rewardPool, mint) });
  const bb = await send("buyback_swap on DBC (buyback PDA payer) -> reward pool", [buybackSwapIx(bbIx, 3, 4)], [], { cuLimit: 300_000 });
  const rpAfter = await bal(baseAta(rewardPool, mint), TOKEN_2022_PROGRAM_ID);
  out.buybackDbc = { sig: bb.sig, cu: bb.cu, spentWsol: bbAmt.toString(), rewardPoolDelta: (rpAfter - rpBefore).toString(), programLog: logLines(bb.logs) };
  console.log(JSON.stringify(out.buybackDbc, null, 2));

  // --- e) read price on-chain vs SDK decode
  const rp = await send("read_price (DBC VirtualPool sqrt_price from bytes)", [readPriceIx(pool)], [], { cuLimit: 50_000 });
  const onchain = returnData(rp.logs)!;
  const sqrtOnchain = onchain.readBigUInt64LE(0) + (onchain.readBigUInt64LE(8) << 64n);
  const pState: any = await fetchPool(pool);
  out.priceDbc = { sig: rp.sig, cu: rp.cu, sqrtPriceOnchain: sqrtOnchain.toString(), sqrtPriceSdk: pState.poolState.sqrtPrice.toString(), match: sqrtOnchain.toString() === pState.poolState.sqrtPrice.toString(), activationPoint: pState.poolState.activationPoint.toString() };
  console.log(JSON.stringify(out.priceDbc, null, 2));
  saveState({ curveCpi: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
