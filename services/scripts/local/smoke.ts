/**
 * SDK-only lifecycle smoke test against solana-test-validator (no DB/indexer):
 * init → create coin → buys → matured sell (ticket) → fill curve → graduate → post-grad
 * setup → samples → claim → router swaps → skim+settle → buyback → fees.
 * Prints each step's signature and the decoded events. `tsx scripts/local/smoke.ts`
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";

import {
  coinAddresses,
  decodeTransactionEvents,
  FumpadClient,
  q64ToSolPerToken,
  ticketPda,
  type TxLike,
} from "@fumpad/sdk";

import { airdrop, initGlobal, directPumpBuy, tokenBalance } from "./actors.js";
import { keypair, sleep, startValidator } from "./harness.js";

async function main() {
  const auth = keypair("upgrade-authority");
  const v = await startValidator({ upgradeAuthority: auth });
  const conn = new Connection(v.rpcUrl, "confirmed");
  const c = new FumpadClient(conn);
  const show = async (label: string, sig: string) => {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const evs = decodeTransactionEvents(tx as unknown as TxLike);
    console.log(`✓ ${label} ${sig.slice(0, 12)}… CU=${tx?.meta?.computeUnitsConsumed} events=[${evs.map((e) => e.name).join(",")}]`);
    return evs;
  };
  try {
    const admin = Keypair.generate();
    const keeper = Keypair.generate();
    const treasury = Keypair.generate();
    const creator = Keypair.generate();
    const alice = Keypair.generate();
    const whale = Keypair.generate();
    for (const k of [auth, admin, keeper, creator, alice, whale]) await airdrop(conn, k.publicKey, k === whale ? 200 : 50);
    await initGlobal(c, auth, admin, treasury.publicKey, keeper.publicKey);
    console.log("✓ global initialized");

    const mintKp = Keypair.generate();
    const mint = mintKp.publicKey;
    const launch = await c.buildLaunch({ creator: creator.publicKey, mint: mintKp, name: "Fumble", symbol: "FUMB", uri: "https://fumpad.fun/x.json", initialBuyLamports: 100_000_000n });
    await show("create_coin + buy", await c.send(creator, launch));

    const b1 = await c.buildBuy({ user: alice.publicKey, mint, budgetLamports: 2n * BigInt(LAMPORTS_PER_SOL) });
    const evs = await show("alice buy 2 SOL", await c.send(alice, b1));
    const tr = evs.find((e) => e.name === "Trade");
    if (tr?.name === "Trade") console.log(`  quote tokens=${b1.quote.tokensOut} chain=${tr.data.tokenAmount} match=${b1.quote.tokensOut === tr.data.tokenAmount} poolBought q=${b1.quote.poolTokensBought} chain=${tr.data.poolTokensBought}`);
    await sleep(3000); // > min_hold_secs
    const bal = await tokenBalance(c, alice.publicKey, mint);
    const s1 = await c.buildSell({ user: alice.publicKey, mint, tokensIn: bal / 2n });
    const sevs = await show("alice sell half (ticket)", await c.send(alice, s1));
    const tc = sevs.find((e) => e.name === "TicketCreated");
    const st = sevs.find((e) => e.name === "Trade");
    if (st?.name === "Trade") console.log(`  sell quote gross=${s1.quote.gross} chain=${st.data.solAmount} match=${s1.quote.gross === st.data.solAmount}`);
    if (tc?.name !== "TicketCreated") throw new Error("no ticket created");
    console.log(`  ticket ${tc.data.ticket.toBase58()} tokens=${tc.data.tokens} price=${q64ToSolPerToken(tc.data.sellPriceQ64)} usd=${tc.data.sellUsdCents}`);

    // Fill the curve.
    for (let i = 0; i < 12; i++) {
      const coin = await c.coin(mint);
      if (coin?.status !== "curve") break;
      const b = await c.buildBuy({ user: whale.publicKey, mint, budgetLamports: 10n * BigInt(LAMPORTS_PER_SOL) });
      await show(`whale buy 10 SOL${b.quote.partialFill ? " (completes)" : ""}`, await c.send(whale, b));
    }
    console.log("  coin status:", (await c.coin(mint))?.status);
    await show("graduate", await c.send(keeper, c.buildGraduate({ payer: keeper.publicKey, mint })));
    for (const b of await c.buildPostGraduation({ payer: keeper.publicKey, mint })) await show("post-grad setup", await c.send(keeper, b));

    const sample = async () => {
      const obs = await c.observations(mint);
      const last = obs?.samples.at(-1)?.ts ?? 0n;
      while ((await c.chainTime()) < last + 2n) await sleep(400);
      await show("record_samples", await c.send(keeper, c.buildRecordSamples({ sampler: keeper.publicKey, mints: [mint] })));
    };
    for (let i = 0; i < 4; i++) await sample();
    const ticket = ticketPda(mint, alice.publicKey, 0n);
    await show("claim", await c.send(alice, c.buildClaim({ owner: alice.publicKey, mint, ticket })));

    const sb = await c.buildBuy({ user: alice.publicKey, mint, budgetLamports: 500_000_000n });
    const sbe = await show("router swap_buy 0.5 SOL", await c.send(alice, sb));
    const sbt = sbe.find((e) => e.name === "Trade");
    if (sbt?.name === "Trade") console.log(`  swap quote tokens=${sb.quote.tokensOut} chain=${sbt.data.tokenAmount}`);
    const ss = await c.buildSell({ user: alice.publicKey, mint, tokensIn: (await tokenBalance(c, alice.publicKey, mint)) / 3n });
    await show("router swap_sell", await c.send(alice, ss));
    await show("direct PumpSwap buy (outside FUMPAD)", await directPumpBuy(c, whale, mint, 2n * BigInt(LAMPORTS_PER_SOL)));
    await show("skim + settle", await c.send(keeper, c.buildSkimSettle({ payer: keeper.publicKey, mint })));
    for (let i = 0; i < 8; i++) await sample();
    const coin = await c.coin(mint);
    console.log(`  buyback_lamports=${coin?.buybackLamports}`);
    await show("execute_buyback", await c.send(keeper, await c.buildExecuteBuyback({ cranker: keeper.publicKey, mint, maxLamports: coin!.buybackLamports })));
    await show("withdraw_platform_fees", await c.send(keeper, await c.buildWithdrawPlatformFees({ caller: keeper.publicKey, mint })));
    await show("withdraw_creator_fees", await c.send(creator, c.buildWithdrawCreatorFees({ creator: creator.publicKey, mint })));
    console.log("reward vault:", await c.tokenBalance(coinAddresses(mint).rewardVault));
    console.log("SMOKE OK");
  } finally {
    await v.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
