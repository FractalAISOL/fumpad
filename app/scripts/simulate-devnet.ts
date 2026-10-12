/**
 * Build every live wallet flow exactly as the app does (src/chain/build.ts + the API's
 * D18 launch prepare) and run `simulateTransaction` on devnet. Nothing is sent.
 *
 *   NEXT_PUBLIC_FUMPAD_API=… NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com \
 *     KEYPAIR=~/fumpad-keys/devnet/alice.json npx tsx scripts/simulate-devnet.ts [mint]
 *
 * Note: the launch step calls POST /v1/launch/prepare, which reserves a pooled …fmbL mint
 * for this wallet until the reservation TTL lapses (then it returns to the pool).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import type { BuiltTx } from "@fumpad/sdk";
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { buildBuyTx, buildClaimTx, buildSellTx, buildSetAutoClaimTx, fumpadClient } from "../src/chain/build";
import { checkPreparedLaunch } from "../src/chain/program";

const API = (process.env.NEXT_PUBLIC_FUMPAD_API ?? "").replace(/\/+$/, "");
const RPC = process.env.NEXT_PUBLIC_SOLANA_RPC ?? "";
const KEYPAIR = (process.env.KEYPAIR ?? "~/fumpad-keys/devnet/alice.json").replace(/^~/, homedir());
const MINT = process.argv[2] ?? "SM5k4LWqXTrZZYtmbKCvVDiJrk44mEiaJdag9GnfmbL";
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

async function main() {
  if (!API || !RPC) throw new Error("set NEXT_PUBLIC_FUMPAD_API and NEXT_PUBLIC_SOLANA_RPC");
  const connection = new Connection(RPC, "confirmed");
  if ((await connection.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("refusing: RPC is not devnet");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, "utf8")) as number[]));
  const wallet = kp.publicKey;
  const client = fumpadClient(connection, { solUsdAccount: process.env.NEXT_PUBLIC_PYTH_SOL_USD || undefined });
  console.log(`wallet ${wallet.toBase58()}  ${(await connection.getBalance(wallet)) / 1e9} SOL  mint ${MINT}`);

  const get = async <T>(path: string): Promise<T> => (await fetch(API + path)).json() as Promise<T>;
  const bal = await get<{ tokens: number }>(`/v1/wallets/${wallet.toBase58()}/balances/${MINT}`);
  const tickets = (await get<{ id: string; mint: string; state: string }[]>(`/v1/wallets/${wallet.toBase58()}/tickets`)).filter((t) => t.mint === MINT);

  const simulate = async (name: string, tx: VersionedTransaction) => {
    const r = await connection.simulateTransaction(tx, { sigVerify: true, commitment: "confirmed" });
    const ok = !r.value.err;
    const logs = r.value.logs ?? [];
    const why = ok ? "" : ` err=${JSON.stringify(r.value.err)} | ${logs.filter((l) => /Error|failed|AnchorError/.test(l)).slice(-2).join(" | ")}`;
    console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(28)} ${r.value.unitsConsumed ?? "?"} CU${why}`);
    if (process.env.VERBOSE) console.log(logs.join("\n"));
  };
  const run = async (name: string, build: () => Promise<BuiltTx> | BuiltTx) => {
    try {
      const built = await build();
      const { tx } = await client.toTransaction(wallet, built);
      tx.sign([kp, ...(built.signers ?? [])]);
      await simulate(name, tx);
    } catch (e) {
      console.log(`FAIL ${name.padEnd(28)} build: ${e instanceof Error ? e.message : e}`);
    }
  };

  await run("buy 0.01 SOL", () => buildBuyTx(client, wallet, { mint: MINT, solIn: 0.01 }));
  await run(`sell 1,000,000 of ${Math.round(bal.tokens)}`, () => buildSellTx(client, wallet, { mint: MINT, tokensIn: Math.min(1_000_000, bal.tokens) }));
  if (bal.tokens > 0) await run("sell all (files a ticket?)", () => buildSellTx(client, wallet, { mint: MINT, tokensIn: bal.tokens }));
  for (const t of tickets) await run(`claim ${t.id.slice(0, 6)}… (${t.state})`, () => buildClaimTx(client, wallet, { mint: MINT, ticket: t.id }));
  if (!tickets.length) console.log("SKIP claim (no ticket on this mint)");
  await run("set_auto_claim false", () => buildSetAutoClaimTx(client, wallet, { mint: MINT, enabled: false }));
  await run("set_auto_claim true", () => buildSetAutoClaimTx(client, wallet, { mint: MINT, enabled: true }));

  // D18 launch: the API builds and signs as the mint; the wallet co-signs as creator/payer.
  try {
    const res = await fetch(`${API}/v1/launch/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creator: wallet.toBase58(), name: "Sim Fumble", symbol: "SIMF", uri: "ipfs://pending", initialBuyLamports: "10000000" }),
    });
    const p = (await res.json()) as { mint?: string; transaction?: string; suffix?: string; error?: string };
    if (!res.ok || !p.transaction || !p.mint) throw new Error(`prepare ${res.status}: ${p.error ?? "no transaction"}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
    checkPreparedLaunch(tx, wallet, p.mint, p.suffix);
    tx.sign([kp]);
    await simulate(`launch + 0.01 buy (${p.mint.slice(-8)})`, tx);
  } catch (e) {
    console.log(`FAIL launch                       ${e instanceof Error ? e.message : e}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
