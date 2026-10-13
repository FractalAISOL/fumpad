/**
 * Send real devnet trades exactly as the app builds them (src/chain/build.ts), to watch the
 * live UI move: the coin page's chart/price/trades, the trade panel's balances and My
 * Fumbles (a sell worth the minimum is attested into a ticket by the keepers). Devnet only (checks the genesis hash).
 *
 *   RPC_URL=… npx tsx scripts/trade-devnet.ts <mint> [plan] [gapSecs]
 *
 * plan: comma-separated steps `<wallet>:<buy|sell>:<amount>`; buy amounts are SOL, sell
 * amounts are tokens or `all` / `half`. `<wallet>:launch:<SYMBOL>[:<firstBuySol>]` launches a
 * new coin through the API's D18 prepare (needs NEXT_PUBLIC_FUMPAD_API); later steps then
 * trade that coin. Pass `-` as the mint to start with a launch. Wallets are ~/fumpad-keys/devnet/<name>.json; each is
 * topped up from ~/.config/solana/id.json when under 0.15 SOL. Default plan: alice and whale
 * alternate small buys and a sell.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, sendAndConfirmTransaction, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import { buildBuyTx, buildSellTx, fumpadClient, minOutFromQuote } from "../src/chain/build";
import { coinAta } from "@fumpad/sdk";

const API = (process.env.NEXT_PUBLIC_FUMPAD_API ?? "").replace(/\/+$/, "");
const RPC = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_SOLANA_RPC ?? "https://api.devnet.solana.com";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const KEYS = join(homedir(), "fumpad-keys", "devnet");
const load = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(f, "utf8")) as number[]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [mintArg, planArg, gapArg] = process.argv.slice(2);
  if (!mintArg) throw new Error("usage: trade-devnet.ts <mint> [plan] [gapSecs]");
  let mint = mintArg === "-" ? null : new PublicKey(mintArg);
  const plan = (planArg ?? "alice:buy:0.01,whale:buy:0.02,alice:buy:0.01,whale:sell:half,alice:buy:0.015,alice:sell:half").split(",");
  const gap = Number(gapArg ?? 8) * 1000;
  const connection = new Connection(RPC, "confirmed");
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("refusing: RPC is not devnet");
  const client = fumpadClient(connection);
  const funder = load(join(homedir(), ".config/solana/id.json"));

  for (const [i, step] of plan.entries()) {
    const [name, side, amt] = step.split(":");
    const kp = load(join(KEYS, `${name}.json`));
    const lamports = await connection.getBalance(kp.publicKey);
    if (lamports < 0.15 * LAMPORTS_PER_SOL) {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: kp.publicKey, lamports: 0.3 * LAMPORTS_PER_SOL }));
      await sendAndConfirmTransaction(connection, tx, [funder]);
      console.log(`  topped up ${name} with 0.3 SOL`);
    }
    if (side === "launch") {
      if (!API) throw new Error("launch needs NEXT_PUBLIC_FUMPAD_API");
      const [, , symbol, first] = step.split(":");
      const meta = JSON.stringify({ name: `Board test ${symbol}`, symbol, twitter: "@fumpad", website: "https://fumpad.app" });
      const uri = `https://httpbin.org/base64/${Buffer.from(meta).toString("base64url")}`;
      const res = await fetch(`${API}/v1/launch/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creator: kp.publicKey.toBase58(), name: `Board test ${symbol}`, symbol, uri, initialBuyLamports: first ? String(Math.round(Number(first) * 1e9)) : undefined }),
      });
      if (!res.ok) throw new Error(`prepare failed: ${res.status} ${await res.text()}`);
      const p = (await res.json()) as { mint: string; transaction: string; lastValidBlockHeight: number };
      const vtx = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
      vtx.sign([kp]);
      const sig = await connection.sendRawTransaction(vtx.serialize());
      await connection.confirmTransaction({ signature: sig, blockhash: vtx.message.recentBlockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
      mint = new PublicKey(p.mint);
      console.log(`${i + 1}. ${new Date().toISOString().slice(11, 19)} ${name} launched $${symbol} ${p.mint}  ${sig.slice(0, 16)}…`);
      if (i < plan.length - 1) await sleep(gap);
      continue;
    }
    if (!mint) throw new Error("no mint yet: start the plan with a launch step or pass a mint");
    // Slippage bounds from the API's quote, as in the app (M-9).
    if (!API) throw new Error("trades need NEXT_PUBLIC_FUMPAD_API (for the quote)");
    const quoteMin = async (s: "buy" | "sell", amount: number) =>
      minOutFromQuote(((await (await fetch(`${API}/v1/quote?mint=${mint!.toBase58()}&side=${s}&amount=${amount}`)).json()) as { amountOut: number }).amountOut);
    let built;
    if (side === "buy") built = await buildBuyTx(client, kp.publicKey, { mint: mint.toBase58(), solIn: Number(amt), minTokensOut: await quoteMin("buy", Number(amt)) });
    else {
      const bal = (await connection.getTokenAccountBalance(coinAta(kp.publicKey, mint)).catch(() => null))?.value.uiAmount ?? 0;
      const tokens = amt === "all" ? bal : amt === "half" ? Math.floor(bal / 2) : Number(amt);
      if (tokens <= 0) {
        console.log(`${i + 1}. ${name} sell skipped (no tokens)`);
        continue;
      }
      built = await buildSellTx(client, kp.publicKey, { mint: mint.toBase58(), tokensIn: tokens, minSolOut: await quoteMin("sell", tokens) });
    }
    const { tx } = await client.toTransaction(kp.publicKey, built);
    tx.sign([kp, ...(built.signers ?? [])]);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`${i + 1}. ${new Date().toISOString().slice(11, 19)} ${name} ${side} ${amt}  ${sig.slice(0, 16)}…`);
    if (i < plan.length - 1) await sleep(gap);
  }
}

main().then(
  () => process.exit(0), // web3.js keeps a socket open
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
