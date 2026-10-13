/**
 * Devnet smoke test: init Global with a scaled-down curve (graduates at 0.85 SOL instead of 85;
 * same curve shape and token numbers, prices 100x lower), launch a coin with an fmbL vanity mint,
 * trade on the curve (one sell creates a ticket), fill the curve, graduate to PumpSwap, run the
 * post-graduation setup and a few keeper samples. Prints Solscan links for every step.
 *
 *   tsx scripts/devnet/smoke.ts --mint ~/fumpad-keys/devnet/<...>fmbL.json
 *
 * Keys live in ~/fumpad-keys/devnet (created on first run). The upgrade authority / admin is
 * ~/.config/solana/id.json.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  decodeTransactionEvents,
  DEFAULT_PARAMS,
  FumpadClient,
  globalPda,
  type Params,
  q64ToSolPerToken,
  type TxLike,
} from "@fumpad/sdk/v06";

import { initGlobal, tokenBalance } from "../local/actors.js";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const KEYS = path.join(os.homedir(), "fumpad-keys", "devnet");

/** D17 curve (8% pool) scaled 100x down in SOL: graduation at 0.85 SOL raised. */
const DEVNET_PARAMS: Params = {
  ...DEFAULT_PARAMS,
  rewardPoolSupply: 80_000_000_000_000n,
  curveSupply: 729_655_172_413_793n,
  lpSupply: 190_344_827_586_207n,
  initialVirtualToken: 987_180_527_383_367n,
  initialVirtualSol: 300_000_000n,
  graduationLamports: 850_000_000n,
  minSellUsdCents: 500n, // $5 (the whole devnet curve is only 0.85 SOL)
  minHoldSecs: 30n,
  oracleWindowSecs: 300n, // 6 buckets of 50 s
  oracleMinSpacingSecs: 10n,
  oracleMinSamples: 15,
};

function loadOrCreate(name: string): Keypair {
  const f = path.join(KEYS, `${name}.json`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify(Array.from(Keypair.generate().secretKey)), { mode: 0o600 });
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
}
const loadFile = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f.replace(/^~/, os.homedir()), "utf8"))));
const tx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
const acct = (k: PublicKey) => `https://solscan.io/account/${k.toBase58()}?cluster=devnet`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const mintArg = process.argv.indexOf("--mint");
  if (mintArg < 0) throw new Error("--mint <keypair.json> required (an fmbL vanity keypair)");
  const mintKp = loadFile(process.argv[mintArg + 1]);
  const conn = new Connection(RPC, "confirmed");
  const c = new FumpadClient(conn);
  const auth = loadFile("~/.config/solana/id.json");
  const keeper = loadOrCreate("keeper");
  const treasury = loadOrCreate("treasury");
  const creator = loadOrCreate("creator");
  const alice = loadOrCreate("alice");
  const whale = loadOrCreate("whale");

  const show = async (label: string, sig: string) => {
    const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const evs = decodeTransactionEvents(t as unknown as TxLike);
    console.log(`✓ ${label}  CU=${t?.meta?.computeUnitsConsumed}  [${evs.map((e) => e.name).join(", ")}]\n    ${tx(sig)}`);
    return evs;
  };

  // Fund role wallets from the deployer (devnet SOL only).
  const fund = async (k: Keypair, sol: number) => {
    const have = await conn.getBalance(k.publicKey);
    const want = Math.round(sol * LAMPORTS_PER_SOL);
    if (have >= want) return;
    const sig = await c.send(auth, { instructions: [SystemProgram.transfer({ fromPubkey: auth.publicKey, toPubkey: k.publicKey, lamports: want - have })] });
    console.log(`  funded ${k.publicKey.toBase58().slice(0, 8)}… +${(want - have) / LAMPORTS_PER_SOL} SOL`);
    void sig;
  };
  await fund(keeper, 0.35);
  await fund(creator, 0.1);
  await fund(alice, 0.25);
  await fund(whale, 1.1);

  if (!(await conn.getAccountInfo(globalPda()))) {
    await initGlobal(c, auth, auth, treasury.publicKey, keeper.publicKey, DEVNET_PARAMS);
    console.log(`✓ global initialized (admin = deployer, keeper ${keeper.publicKey.toBase58()})\n    ${acct(globalPda())}`);
  } else console.log("• global already initialized");

  const mint = mintKp.publicKey;
  console.log(`\nCoin mint: ${mint.toBase58()}  (ends with fmbL: ${mint.toBase58().endsWith("fmbL")})\n    ${acct(mint)}`);
  if (!(await c.coin(mint))) {
    const launch = await c.buildLaunch({ creator: creator.publicKey, mint: mintKp, name: "First Fumble", symbol: "FUMB", uri: "https://fumpad.vercel.app/og/demo.json", initialBuyLamports: 10_000_000n });
    await show("create_coin + creator buy 0.01 SOL", await c.send(creator, launch));
  }

  await show("alice buys 0.1 SOL", await c.send(alice, await c.buildBuy({ user: alice.publicKey, mint, budgetLamports: 100_000_000n })));
  console.log(`  waiting ${DEVNET_PARAMS.minHoldSecs}s hold…`);
  await sleep(Number(DEVNET_PARAMS.minHoldSecs) * 1000 + 3000);
  const bal = await tokenBalance(c, alice.publicKey, mint);
  const sevs = await show("alice sells half (should print a fumble ticket)", await c.send(alice, await c.buildSell({ user: alice.publicKey, mint, tokensIn: bal / 2n })));
  const tc = sevs.find((e) => e.name === "TicketCreated");
  if (tc?.name === "TicketCreated") console.log(`  ticket ${tc.data.ticket.toBase58()} tokens=${tc.data.tokens} price=${q64ToSolPerToken(tc.data.sellPriceQ64)} SOL/token usd_cents=${tc.data.sellUsdCents}`);
  else console.log("  (no ticket — check Pyth/USD minimum)");

  for (let i = 0; i < 8; i++) {
    const coin = await c.coin(mint);
    if (coin?.status !== "curve") break;
    const b = await c.buildBuy({ user: whale.publicKey, mint, budgetLamports: 300_000_000n });
    await show(`whale buys 0.3 SOL${b.quote.partialFill ? " (completes the curve)" : ""}`, await c.send(whale, b));
  }
  console.log("  coin status:", (await c.coin(mint))?.status);

  if ((await c.coin(mint))?.status === "complete") {
    await show("graduate → PumpSwap (LP locked in fumpad_lp_locker)", await c.send(keeper, c.buildGraduate({ payer: keeper.publicKey, mint })));
  }
  const coin = await c.coin(mint);
  console.log(`  status=${coin?.status} pool=${coin?.ammPool.toBase58()}\n    ${coin ? acct(coin.ammPool) : ""}`);
  if (coin?.status === "graduated" && !(await c.observations(mint))) {
    for (const b of await c.buildPostGraduation({ payer: keeper.publicKey, mint })) await show("post-graduation setup", await c.send(keeper, b));
  }
  for (let i = 0; i < 3; i++) {
    await show(`keeper record_samples #${i + 1}`, await c.send(keeper, c.buildRecordSamples({ sampler: keeper.publicKey, mints: [mint] })));
    await sleep(11_000);
  }
  console.log("\nDEVNET SMOKE OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
