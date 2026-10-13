// Items 9 (fee claim), 10, 11 (DAMM v2), 12: after graduation
//  a) FUMPAD-routed buy + sell on the DAMM v2 pool via CPI, exact amounts measured
//  b) third-party swaps via @meteora-ag/cp-amm-sdk, parsed (EvtSwap2)
//  c) read_price from DAMM v2 Pool bytes + formula
//  d) claim_position_fee via CPI signed by the fee_claimer PDA (owner of the locked position NFT) + 50/30/20
//  e) buyback on DAMM v2 with the buyback PDA as payer -> reward pool
//  f) pay a fumble-ticket style payout in tokens from the reward pool (PDA-signed Token-2022 transfer)
import BN from "bn.js";
import { PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount } from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import {
  createDammV2Program, deriveDammV2PoolAuthority, deriveDammV2TokenVaultAddress, derivePositionAddress, derivePositionNftAccount,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, payer, send, saveState, loadState, spikeKey, getTx } from "./common.js";
import { ata, baseAta, prepUser } from "./dbc.js";
import { parseSwaps, fmt } from "./events.js";
import { pdas, routedSwapIx, buybackSwapIx, claimAndSplitIx, readPriceIx, payRewardIx, returnData } from "./spike.js";

const damm = createDammV2Program(connection) as any;
const DAMM_POOL_AUTHORITY = deriveDammV2PoolAuthority();
const bal = async (a: PublicKey, prog = TOKEN_PROGRAM_ID) => (await getAccount(connection, a, "confirmed", prog)).amount;
const logLines = (logs: string[]) => logs.filter((l) => l.includes("FUMPAD_"));

/** DAMM v2 swap2. Accounts: 0 pool_authority, 1 pool, 2 input, 3 output, 4 token_a_vault, 5 token_b_vault, 6 token_a_mint,
 * 7 token_b_mint, 8 payer, 9 token_a_program, 10 token_b_program, 11 referral (None = program id), 12 event_authority, 13 program */
async function dammSwapIx(a: { pool: PublicKey; mint: PublicKey; owner: PublicKey; buy: boolean; amountIn: bigint; input?: PublicKey; output?: PublicKey }) {
  const wsol = ata(a.owner, NATIVE_MINT), base = baseAta(a.owner, a.mint);
  return damm.methods
    .swap2({ amount0: new BN(a.amountIn.toString()), amount1: new BN(1), swapMode: 0 })
    .accountsPartial({
      poolAuthority: DAMM_POOL_AUTHORITY, pool: a.pool,
      inputTokenAccount: a.input ?? (a.buy ? wsol : base), outputTokenAccount: a.output ?? (a.buy ? base : wsol),
      tokenAVault: deriveDammV2TokenVaultAddress(a.pool, a.mint), tokenBVault: deriveDammV2TokenVaultAddress(a.pool, NATIVE_MINT),
      tokenAMint: a.mint, tokenBMint: NATIVE_MINT, payer: a.owner,
      tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    })
    .instruction();
}

async function main() {
  const st = loadState();
  const mint = new PublicKey(st.launch.mint);
  const pool = new PublicKey(st.dammPool);
  const nft = new PublicKey(st.positionNft);
  const { feeClaimer, rewardPool, buyback } = pdas();
  const platform = spikeKey("platform");
  const sniper = spikeKey("sniper");
  const creator = new PublicKey(st.launch.creator);
  const out: any = {};

  await send("wrap WSOL for DAMM swaps", prepUser(payer.publicKey, payer.publicKey, mint, BigInt(0.05 * LAMPORTS_PER_SOL)), []);

  // a) routed buy + sell
  const rbIx = await dammSwapIx({ pool, mint, owner: payer.publicKey, buy: true, amountIn: BigInt(0.03 * LAMPORTS_PER_SOL) });
  const rb = await send("FUMPAD routed_swap BUY on DAMM v2 (CPI)", [routedSwapIx(payer.publicKey, rbIx, 2, 3)], [], { cuLimit: 300_000 });
  const rbd = returnData(rb.logs)!;
  out.routedBuy = { sig: rb.sig, cu: rb.cu, measured: { spent: rbd.readBigUInt64LE(0).toString(), received: rbd.readBigUInt64LE(8).toString() }, programLog: logLines(rb.logs), venueEvent: parseSwaps((await getTx(rb.sig))!).map((s) => JSON.parse(fmt(s))) };
  console.log(JSON.stringify(out.routedBuy, null, 2));
  const rsIx = await dammSwapIx({ pool, mint, owner: payer.publicKey, buy: false, amountIn: rbd.readBigUInt64LE(8) / 2n });
  const rs = await send("FUMPAD routed_swap SELL on DAMM v2 (CPI)", [routedSwapIx(payer.publicKey, rsIx, 2, 3)], [], { cuLimit: 300_000 });
  const rsd = returnData(rs.logs)!;
  out.routedSell = { sig: rs.sig, cu: rs.cu, measured: { spent: rsd.readBigUInt64LE(0).toString(), received: rsd.readBigUInt64LE(8).toString() }, programLog: logLines(rs.logs), venueEvent: parseSwaps((await getTx(rs.sig))!).map((s) => JSON.parse(fmt(s))) };
  console.log(JSON.stringify(out.routedSell, null, 2));

  // b) third-party swaps via cp-amm-sdk (sniper wallet)
  const cp = new CpAmm(connection);
  const common = {
    payer: sniper.publicKey, pool, tokenAMint: mint, tokenBMint: NATIVE_MINT,
    tokenAVault: deriveDammV2TokenVaultAddress(pool, mint), tokenBVault: deriveDammV2TokenVaultAddress(pool, NATIVE_MINT),
    tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null, minimumAmountOut: new BN(1),
  };
  const tbTx = await cp.swap({ ...common, inputTokenMint: NATIVE_MINT, outputTokenMint: mint, amountIn: new BN(0.004 * LAMPORTS_PER_SOL) });
  const tb = await send("third-party (cp-amm-sdk) BUY on DAMM v2", tbTx.instructions, [sniper]);
  const sb = await bal(baseAta(sniper.publicKey, mint), TOKEN_2022_PROGRAM_ID);
  const tsTx = await cp.swap({ ...common, inputTokenMint: mint, outputTokenMint: NATIVE_MINT, amountIn: new BN((sb / 3n).toString()) });
  const ts = await send("third-party (cp-amm-sdk) SELL on DAMM v2", tsTx.instructions, [sniper]);
  out.thirdPartyDamm = {
    buy: { sig: tb.sig, cu: tb.cu, parsed: parseSwaps((await getTx(tb.sig))!).map((s) => JSON.parse(fmt(s))) },
    sell: { sig: ts.sig, cu: ts.cu, parsed: parseSwaps((await getTx(ts.sig))!).map((s) => JSON.parse(fmt(s))) },
  };
  console.log(JSON.stringify(out.thirdPartyDamm, null, 2));

  // c) price
  const rp = await send("read_price (DAMM v2 Pool sqrt_price from bytes)", [readPriceIx(pool)], [], { cuLimit: 50_000 });
  const d = returnData(rp.logs)!;
  const sqrtOnchain = d.readBigUInt64LE(0) + (d.readBigUInt64LE(8) << 64n);
  const dp: any = await damm.account.pool.fetch(pool);
  const sq = Number(sqrtOnchain) / 2 ** 64;
  out.priceDamm = {
    sig: rp.sig, cu: rp.cu, sqrtPriceOnchain: sqrtOnchain.toString(), sqrtPriceSdk: dp.sqrtPrice.toString(), match: sqrtOnchain.toString() === dp.sqrtPrice.toString(),
    priceLamportsPerRawToken: sq * sq, priceSolPerToken: sq * sq * 1e6 / 1e9, mcSol: sq * sq * 1e6 / 1e9 * 1e9,
  };
  console.log(out.priceDamm);

  // d) claim position fees via CPI with PDA signer + split
  const position = derivePositionAddress(nft);
  const posBefore: any = await damm.account.position.fetch(position);
  const claimIx = await damm.methods.claimPositionFee().accountsPartial({
    poolAuthority: DAMM_POOL_AUTHORITY, pool, position, tokenAAccount: baseAta(feeClaimer, mint), tokenBAccount: ata(feeClaimer, NATIVE_MINT),
    tokenAVault: deriveDammV2TokenVaultAddress(pool, mint), tokenBVault: deriveDammV2TokenVaultAddress(pool, NATIVE_MINT),
    tokenAMint: mint, tokenBMint: NATIVE_MINT, positionNftAccount: derivePositionNftAccount(nft), owner: feeClaimer, signer: feeClaimer,
    tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
  }).instruction();
  const before = { buyback: await bal(ata(buyback, NATIVE_MINT)), platform: await bal(ata(platform.publicKey, NATIVE_MINT)), creator: await bal(ata(creator, NATIVE_MINT)) };
  const cs = await send("claim_and_split: DAMM v2 claim_position_fee via CPI (fee_claimer PDA owns locked NFT) + 50/30/20", [claimAndSplitIx({
    venueIx: claimIx, baseIdx: 3, quoteIdx: 4, feeQuote: ata(feeClaimer, NATIVE_MINT), buybackQuote: ata(buyback, NATIVE_MINT),
    platformQuote: ata(platform.publicKey, NATIVE_MINT), creatorQuote: ata(creator, NATIVE_MINT), quoteMint: NATIVE_MINT,
  })], [], { cuLimit: 300_000 });
  const after = { buyback: await bal(ata(buyback, NATIVE_MINT)), platform: await bal(ata(platform.publicKey, NATIVE_MINT)), creator: await bal(ata(creator, NATIVE_MINT)) };
  out.claimDamm = {
    sig: cs.sig, cu: cs.cu, programLog: logLines(cs.logs),
    positionFeeBPendingBefore: posBefore.feeBPending?.toString(), positionFeeAPendingBefore: posBefore.feeAPending?.toString(),
    deltas: { buyback: (after.buyback - before.buyback).toString(), platform: (after.platform - before.platform).toString(), creator: (after.creator - before.creator).toString() },
  };
  console.log(JSON.stringify(out.claimDamm, null, 2));

  // e) buyback on DAMM v2
  const bbAmt = await bal(ata(buyback, NATIVE_MINT));
  const rpAta = baseAta(rewardPool, mint);
  const rp0 = await bal(rpAta, TOKEN_2022_PROGRAM_ID);
  const bbIx = await dammSwapIx({ pool, mint, owner: buyback, buy: true, amountIn: bbAmt, input: ata(buyback, NATIVE_MINT), output: rpAta });
  const bb = await send("buyback_swap on DAMM v2 (buyback PDA payer) -> reward pool", [buybackSwapIx(bbIx, 2, 3)], [], { cuLimit: 300_000 });
  const rp1 = await bal(rpAta, TOKEN_2022_PROGRAM_ID);
  out.buybackDamm = { sig: bb.sig, cu: bb.cu, spentWsol: bbAmt.toString(), rewardPoolDelta: (rp1 - rp0).toString(), programLog: logLines(bb.logs) };
  console.log(out.buybackDamm);

  // f) payout from the reward pool
  const payAmt = 1_000_000_000n; // 1,000 tokens
  const dest = baseAta(sniper.publicKey, mint);
  const d0 = await bal(dest, TOKEN_2022_PROGRAM_ID);
  const pr = await send("pay_reward: reward pool PDA -> ticket owner (Token-2022 transfer_checked)", [payRewardIx({ rewardVault: rpAta, mint, destination: dest, tokenProgram: TOKEN_2022_PROGRAM_ID, amount: payAmt })], [], { cuLimit: 100_000 });
  const d1 = await bal(dest, TOKEN_2022_PROGRAM_ID);
  out.payReward = { sig: pr.sig, cu: pr.cu, received: (d1 - d0).toString() };
  console.log(out.payReward);
  saveState({ damm: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
