// Items 5 + 7: launch a coin on our DBC config with a caller-chosen mint keypair, creator's first buy bundled in
// the pool-creation tx (min fee), a second wallet's buy in the SAME tx/slot (anti-snipe fee), then buys in the
// following slots to measure the decay schedule.
import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { connection, payer, send, saveState, loadState, spikeKey, getTx, KEYS_DIR, loadKeypair, sleep } from "./common.js";
import { initPoolIx, dbcSwapIx, poolKeys, ata, baseAta, fetchPool } from "./dbc.js";
import { parseSwaps, fmt } from "./events.js";

function feeRate(s: any) {
  const fee = BigInt(s.tradingFee) + BigInt(s.protocolFee) + BigInt(s.referralFee);
  return Number((fee * 1_000_000n) / BigInt(s.amountIn)) / 10_000; // percent, 4dp
}

async function fund(to: PublicKey, sol: number) {
  const bal = await connection.getBalance(to);
  const need = Math.round(sol * LAMPORTS_PER_SOL) - bal;
  if (need > 0) await send(`fund ${to.toBase58().slice(0, 6)}`, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports: need })], []);
}

async function main() {
  const st = loadState();
  const config = new PublicKey(st.config.config);
  const creator = spikeKey("creator");
  const sniper = spikeKey("sniper");
  // vanity mint: freshly ground "...fmbL" keypair if present in .keys (the one in ~/fumpad-keys/devnet is already used)
  const vanity = fs.readdirSync(KEYS_DIR).find((f) => f.endsWith("fmbL.json"));
  const mint: Keypair = vanity ? loadKeypair(path.join(KEYS_DIR, vanity)) : spikeKey("mint");
  console.log("mint", mint.publicKey.toBase58(), vanity ? "(vanity)" : "(random)");
  const { pool } = poolKeys(config, mint.publicKey);
  if (await connection.getAccountInfo(pool)) throw new Error("pool already exists: " + pool.toBase58());

  await fund(creator.publicKey, 0.06);
  await fund(sniper.publicKey, 0.06);
  // pre-wrap WSOL (separate tx so the launch tx fits)
  const wrap = (kp: Keypair, lamports: number) => [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(kp.publicKey, NATIVE_MINT), kp.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: ata(kp.publicKey, NATIVE_MINT), lamports }),
    createSyncNativeInstruction(ata(kp.publicKey, NATIVE_MINT)),
  ];
  await send("wrap WSOL creator+sniper", [...wrap(creator, 0.03 * LAMPORTS_PER_SOL), ...wrap(sniper, 0.04 * LAMPORTS_PER_SOL)], [creator, sniper]);

  const creatorBuy = new BN(0.02 * LAMPORTS_PER_SOL);
  const sniperBuy = new BN(0.01 * LAMPORTS_PER_SOL);
  const ixs = [
    await initPoolIx({ config, baseMint: mint.publicKey, creator: creator.publicKey, payer: payer.publicKey, name: "Fumble Spike", symbol: "FSPK", uri: "https://fumpad.fun/s.json" }),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, baseAta(creator.publicKey, mint.publicKey), creator.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, baseAta(sniper.publicKey, mint.publicKey), sniper.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    await dbcSwapIx({ config, baseMint: mint.publicKey, owner: creator.publicKey, buy: true, amount0: creatorBuy, amount1: new BN(1), withIxSysvar: true }),
    await dbcSwapIx({ config, baseMint: mint.publicKey, owner: sniper.publicKey, buy: true, amount0: sniperBuy, amount1: new BN(1), withIxSysvar: true }),
  ];
  const launch = await send("launch: init pool (caller-chosen mint) + creator first buy + sniper buy, same tx", ixs, [creator, sniper, mint]);
  const ptx = await getTx(launch.sig);
  const swaps = parseSwaps(ptx!);
  const poolState: any = await fetchPool(pool);
  const activationPoint = Number(poolState.poolState.activationPoint);
  const out: any = {
    mint: mint.publicKey.toBase58(), vanity: !!vanity, pool: pool.toBase58(), creator: creator.publicKey.toBase58(), sniper: sniper.publicKey.toBase58(),
    launchSig: launch.sig, launchSlot: launch.slot, launchCu: launch.cu, activationPoint,
    launchSwaps: swaps.map((s) => ({ ...JSON.parse(fmt(s)), feePct: feeRate(s) })),
  };
  console.log(JSON.stringify(out, null, 2));

  // decay probe: fire 1 small sniper buy per ~slot for the next ~10 slots without waiting for confirmation
  const later: any[] = [];
  const sigs: string[] = [];
  for (let i = 0; i < 10; i++) {
    const ix = await dbcSwapIx({ config, baseMint: mint.publicKey, owner: sniper.publicKey, buy: true, amount0: new BN(0.002 * LAMPORTS_PER_SOL), amount1: new BN(1), withIxSysvar: true });
    const p = send(`decay probe buy #${i + 1}`, [ix], [sniper]).then((r) => sigs.push(r.sig)).catch((e) => console.error("probe fail", String(e).slice(0, 200)));
    later.push(p);
    await sleep(350);
  }
  await Promise.all(later);
  const probes: any[] = [];
  for (const sig of sigs) {
    const t = await getTx(sig);
    for (const s of parseSwaps(t!)) probes.push({ sig, slot: t!.slot, slotOffset: t!.slot - activationPoint, feePct: feeRate(s), amountIn: s.amountIn.toString(), amountOut: s.amountOut.toString() });
  }
  probes.sort((a, b) => a.slot - b.slot);
  out.decayProbes = probes;
  console.log(JSON.stringify(probes, null, 2));
  saveState({ launch: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
