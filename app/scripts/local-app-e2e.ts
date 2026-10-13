/**
 * The app's live mode, headless, against the local v0.7 stack (`cd services && npm run local:app`):
 * every step goes through the app's own modules — the data layer (`ApiFumpadData`, the same REST
 * client the pages use), the builders (`src/chain/build.ts`, @fumpad/sdk), and the pipeline
 * (`src/chain/flow.ts`: allow-list vetting → silent signing → send → confirm) with an "embedded
 * wallet, Instant trading on" signer, i.e. the Privy silent-signing path.
 *
 *   launch (API prepare + first buy) → buy / sell on the curve (DBC) → ticket states → auto-claim
 *   off → a buy that completes the curve (PartialFill) → graduation → buy / sell on DAMM v2 →
 *   claim → an escrowed auto-claim withdrawn → creator fees withdrawn
 *
 * With `--capture`, every transaction the wallet was asked to sign (exactly as presented to the
 * signer) and the chain accounts the tests need are written to src/chain/fixtures/local-v07.json
 * (public data only: addresses, transactions, account bytes; no keys, no RPC URLs).
 *
 *   npx tsx scripts/local-app-e2e.ts [--capture]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { coinAta, coinPda, decodeCoin, decodeTicket, decodeTokenAccount, TOKEN_2022_PROGRAM_ID } from "@fumpad/sdk";
import type { SilentPolicy } from "../src/chain/allowlist";
import { buildClaimTx, buildSetAutoClaimTx, prepareBuy, prepareSell, buildWithdrawCreatorFeesTx, buildWithdrawEscrowTx, fumpadClient, minOutFromQuote } from "../src/chain/build";
import { prepareLaunchSigned, sendBuilt, signAndSendLaunch } from "../src/chain/flow";
import type { FumpadSigner } from "../src/chain/signer";
import { ApiFumpadData } from "../src/data/api";
import { baseToTokens, solToLamports } from "../src/data/chain";

const CAPTURE = process.argv.includes("--capture");
const STACK = join(import.meta.dirname, "../../services/.local/app-stack.json");
const OUT = join(import.meta.dirname, "../src/chain/fixtures/local-v07.json");
const info = JSON.parse(readFileSync(STACK, "utf8")) as { rpcUrl: string; api: string; dbcConfig: string; wallets: Record<string, { address: string; keypair: string }> };
const load = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(info.wallets[name].keypair, "utf8")) as number[]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

const connection = new Connection(info.rpcUrl, "confirmed");
const client = fumpadClient(connection);
const data = new ApiFumpadData(info.api);

const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? ` — ${detail}` : ""}`);
}
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 120_000, everyMs = 2_000): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await sleep(everyMs);
  }
}

/* ── capture ─────────────────────────────────────────────────────────────── */

interface CapturedTx {
  name: string;
  note: string;
  wallet: string;
  policy: Record<string, string>;
  /** base64 v0 transaction exactly as handed to the wallet for signing. */
  tx: string;
  signature?: string;
}
const captured: CapturedTx[] = [];
const accounts: Record<string, { address: string; owner: string; data: string }> = {};
const quoteSlots: Record<string, string> = {};
let pending: { name: string; note: string; policy: SilentPolicy } | null = null;

const policyJson = (p: SilentPolicy): Record<string, string> =>
  Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));

async function snapshot(key: string, address: PublicKey) {
  const a = await connection.getAccountInfo(address, "confirmed");
  if (!a) throw new Error(`no account ${key}`);
  accounts[key] = { address: address.toBase58(), owner: a.owner.toBase58(), data: b64(a.data) };
  return a;
}

/** An embedded (Trading) wallet with Instant trading on: signs silently whatever the allow-list passed. Records what it signs. */
function embeddedSigner(kp: Keypair): FumpadSigner {
  return {
    publicKey: kp.publicKey,
    kind: "embedded",
    name: "Trading wallet (local)",
    async sign(tx, opts) {
      if (!opts.silent) throw new Error("expected a silent signature");
      if (pending) {
        captured.push({ name: pending.name, note: pending.note, wallet: kp.publicKey.toBase58(), policy: policyJson(pending.policy), tx: b64(tx.serialize()) });
        pending = null;
      }
      tx.sign([kp]);
      return tx;
    },
    async signMessage(message, opts) {
      if (!opts.silent) throw new Error("expected a silent signature");
      return ed25519.sign(message, kp.secretKey.subarray(0, 32));
    },
  };
}

async function run(name: string, note: string, signer: FumpadSigner, build: Parameters<typeof sendBuilt>[0], policy: SilentPolicy) {
  pending = { name, note, policy };
  const { signature } = await sendBuilt(build, policy, { connection, client, signer, instant: true, failed: `${name} failed on chain` });
  const c = captured.find((x) => x.name === name);
  if (c) c.signature = signature;
  return signature;
}

/** The API caches pool accounts for 2 s (api/src/chain.ts quote): a quote right after a trade would still price the old pool. */
const settle = () => sleep(2_500);

const tokens = async (owner: PublicKey, mint: PublicKey) => {
  const a = await connection.getAccountInfo(coinAta(owner, mint), "confirmed");
  return a ? decodeTokenAccount(new Uint8Array(a.data)).amount : BigInt(0);
};
const coinOnChain = async (mint: PublicKey) => decodeCoin(new Uint8Array((await connection.getAccountInfo(coinPda(mint), "confirmed"))!.data));

/** Token-2022 on the owner's coin account: Reallocate(+MemoTransfer) then Enable/DisableRequiredMemoTransfers. Not an app flow. */
async function memoRequired(owner: Keypair, mint: PublicKey, on: boolean) {
  const acct = coinAta(owner.publicKey, mint);
  const ixs: TransactionInstruction[] = [];
  if (on)
    ixs.push(
      new TransactionInstruction({
        programId: TOKEN_2022_PROGRAM_ID,
        keys: [
          { pubkey: acct, isSigner: false, isWritable: true },
          { pubkey: owner.publicKey, isSigner: true, isWritable: true },
          { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
          { pubkey: owner.publicKey, isSigner: true, isWritable: false },
        ],
        data: Buffer.from([29, 8, 0]), // Reallocate [MemoTransfer]
      }),
    );
  ixs.push(
    new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: acct, isSigner: false, isWritable: true },
        { pubkey: owner.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([30, on ? 0 : 1]), // MemoTransferExtension: Enable / Disable
    }),
  );
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const t = new VersionedTransaction(new TransactionMessage({ payerKey: owner.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  t.sign([owner]);
  const res = await connection.confirmTransaction(await connection.sendRawTransaction(t.serialize()), "confirmed");
  if (res.value.err) throw new Error(`memo-required ${on} failed: ${JSON.stringify(res.value.err)}`);
}

/* ── scenario ───────────────────────────────────────────────────────────── */

async function main() {
  const t0 = Date.now();
  const creator = embeddedSigner(load("app-creator"));
  const trader = embeddedSigner(load("app-trader"));
  const trader2Kp = load("app-trader2");
  const trader2 = embeddedSigner(trader2Kp);
  const whale = embeddedSigner(load("app-whale"));
  const symbol = `T${Date.now().toString(36).slice(-5).toUpperCase()}`;
  const launchArgs = { name: `Local ${symbol}`, symbol, uri: `https://fumpad.fun/m/${symbol.toLowerCase()}.json`, initialBuyLamports: solToLamports(0.05) };

  // ── launch: M-2 signed prepare → M-1 binding → allow-list → silent sign → send ──
  await waitFor("a …fmbL mint in the pool", async () => ((await data.getStatus()).vanityPool?.available ?? 0) > 0, 600_000, 3_000);
  const prepared = await prepareLaunchSigned(info.api, creator, launchArgs, true);
  const launchTx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
  const launchPolicy: SilentPolicy = { action: "launch", mint: prepared.mint, coSigner: prepared.mint, maxSolInLamports: launchArgs.initialBuyLamports };
  pending = { name: "launch", note: "POST /v1/launch/prepare (first buy 0.05 SOL), mint-signed, as the creator's wallet gets it", policy: launchPolicy };
  const { signature: launchSig } = await signAndSendLaunch({ ...prepared }, launchArgs, { connection, client, signer: creator, instant: true });
  captured.find((c) => c.name === "launch")!.signature = launchSig;
  const mint = new PublicKey(prepared.mint);
  const M = prepared.mint;
  check("launch: prepared by the API, vetted + bound by the app, signed silently, landed", (await coinOnChain(mint)).status === "curve", M);
  check("launch tx: API order is [CB] wrap → DBC init → ATA → swap2(+sysvar) → register_coin → close", launchTx.message.compiledInstructions.length === 9);
  await snapshot("dbcConfig", new PublicKey(info.dbcConfig));
  await snapshot("coinCurve", coinPda(mint));
  const creatorFirst = await tokens(creator.publicKey, mint);
  check("creator's first buy filled at the min fee", creatorFirst > BigInt(0), `${baseToTokens(creatorFirst)} tokens`);

  const coin = await waitFor("coin in the API", () => data.getCoin(M), 60_000, 1_000);
  check("data layer: getCoin(mint) finds the launch", coin.mint === M && coin.status === "curve", coin.symbol);
  const created = await data.getCreatedCoins(creator.publicKey.toBase58());
  check("data layer: getCreatedCoins(creator) lists it", created.some((c) => c.mint === M));

  // Third-party-free scenario: wait out the launch window (DBC's 99% scheduler, D33).
  const launchSlot = (await connection.getTransaction(launchSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))!.slot;
  await waitFor("launch window over", async () => (await connection.getSlot("confirmed")) > launchSlot + 12, 30_000, 500);

  // ── curve trades through the router (quote from the data layer → minOut → build → vet → sign) ──
  /** The pool the app quotes from, as it stood right before a captured trade (for the V7-M3 tests). */
  const snapPool = async (key: string) => {
    const c = await coinOnChain(mint);
    await snapshot(key, c.status === "graduated" ? c.dammPool : c.dbcPool);
    quoteSlots[key] = String(await connection.getSlot("confirmed"));
  };
  const buy = async (who: FumpadSigner, name: string, note: string, sol: number) => {
    await settle();
    if (name === "buy-dbc" || name === "buy-damm") await snapPool(name === "buy-dbc" ? "dbcPool" : "dammPool");
    const q = await data.quoteTrade({ mint: M, side: "buy", amount: sol, wallet: who.publicKey.toBase58() });
    const args = { mint: M, solIn: sol, minTokensOut: minOutFromQuote(q.amountOut) };
    // The trade panel's path: the shown (API) quote's minimum, checked against the app's own quote (V7-M3).
    const p = await prepareBuy(client, who.publicKey, args);
    await run(name, note, who, () => p, p.policy);
    return q;
  };
  const sell = async (who: FumpadSigner, name: string, note: string, base: bigint) => {
    const amt = baseToTokens(base);
    await settle();
    const q = await data.quoteTrade({ mint: M, side: "sell", amount: amt, wallet: who.publicKey.toBase58() });
    const args = { mint: M, tokensIn: amt, minSolOut: minOutFromQuote(q.amountOut) };
    const p = await prepareSell(client, who.publicKey, args);
    await run(name, note, who, () => p, p.policy);
    return q;
  };
  const qb = await buy(trader, "buy-dbc", "router buy on the curve (DBC swap2, PartialFill mode), 0.12 SOL", 0.12);
  check("buy (DBC): quote venue dbc, tokens landed", qb.venue === "dbc" && (await tokens(trader.publicKey, mint)) > BigInt(0));
  // Small enough that both tickets fit the coin's attestation cap (20% of supply per hour).
  await buy(trader2, "buy-dbc-2", "router buy on the curve, second wallet", 0.05);
  await sleep(7_000); // > the local 5 s hold
  const traderBal = await tokens(trader.publicKey, mint);
  await sell(trader, "sell-dbc", "router sell on the curve (DBC swap2 ExactIn), 30% of the bag (its 10% claim fits the reward pool's per-claim cap, so it pays at once)", (traderBal * BigInt(3)) / BigInt(10));
  check("sell (DBC): 30% of the bag sold", (await tokens(trader.publicKey, mint)) < traderBal);
  await sell(trader2, "sell-dbc-all", "router sell of the whole bag (second wallet)", await tokens(trader2.publicKey, mint));
  // trader2's coin account starts requiring memos on incoming transfers (Token-2022 MemoTransfer), so the
  // keeper's auto-claim (a plain transfer) is refused and the payout goes to the ticket's escrow (D16).
  // (A missing account isn't enough: the keeper creates it before claim_for.)
  await memoRequired(trader2Kp, mint, true);
  // ── ticket states through the data layer ──
  const states = new Set<string>();
  const watchTicket = async (owner: PublicKey) => {
    const ts = await data.getTickets(owner.toBase58());
    const t = ts.find((x) => x.mint === M);
    if (t) states.add(t.state);
    return t ?? null;
  };
  const tk = await waitFor("trader's ticket attested (2-of-3) and indexed", async () => {
    const t = await watchTicket(trader.publicKey);
    return t && t.attestedAt ? t : null;
  }, 240_000);
  check("ticket: router sell → attested ticket in getTickets()", tk.source === "router" && tk.tokens > 0, `${tk.state}, ${tk.tokens} tokens`);
  const tk2 = await waitFor("trader2's ticket attested", async () => {
    const t = (await data.getTickets(trader2.publicKey.toBase58())).find((x) => x.mint === M);
    return t && t.attestedAt ? t : null;
  }, 240_000);
  const fumbles = await data.getRecentFumbles(M);
  check("data layer: getRecentFumbles(mint) shows the sells", fumbles.length >= 2, `${fumbles.length} rows`);

  await run("set-auto-claim", "set_auto_claim(false): the trader claims this coin's tickets itself", trader, () => buildSetAutoClaimTx(client, trader.publicKey, { mint: M, enabled: false }), { action: "auto-claim", mint: M });
  check("auto-claim off: data layer reflects it", (await waitFor("autoClaim false", async () => {
    const t = await watchTicket(trader.publicKey);
    return t && !t.autoClaim ? t : null;
  }, 60_000)).autoClaim === false);

  // ── a buy that completes the curve: PartialFill through the router ──
  const whaleSolBefore = await connection.getBalance(whale.publicKey, "confirmed");
  const qp = await buy(whale, "buy-dbc-partialfill", "router buy of 2 SOL near completion: PartialFill completes the curve, the unused SOL comes back", 2);
  const whaleSpent = whaleSolBefore - (await connection.getBalance(whale.publicKey, "confirmed"));
  check("PartialFill buy: quote said partial, curve completed, < 2 SOL spent", !!qp.partialFill && (await coinOnChain(mint)).status !== "curve" && whaleSpent < 2e9, `${whaleSpent / 1e9} SOL`);

  const grad = await waitFor("keeper migrates + graduates", async () => {
    const c = await coinOnChain(mint);
    return c.status === "graduated" ? c : null;
  }, 240_000);
  await waitFor("data layer: coin graduated", async () => (await data.getCoin(M))?.status === "graduated", 120_000);
  check("graduated: data layer + chain agree", grad.status === "graduated", grad.dammPool.toBase58());
  await snapshot("coinGraduated", coinPda(mint));

  // ── DAMM v2 trades through the router ──
  const qd = await buy(whale, "buy-damm", "router buy on DAMM v2 after graduation (ExactIn), 2 SOL: lifts the price past the 10x trigger", 2);
  check("buy (DAMM v2): quote venue damm", qd.venue === "damm");
  await sell(whale, "sell-damm", "router sell on DAMM v2 (5% of the whale's bag)", (await tokens(whale.publicKey, mint)) / BigInt(20));

  // ── claim: the trader's ticket turns claimable (median ≥ 10×, past the challenge window) ──
  const claimable = await waitFor("trader's ticket claimable", async () => {
    const t = await watchTicket(trader.publicKey);
    return t && t.state === "claimable" ? t : null;
  }, 300_000, 3_000);
  const before = await tokens(trader.publicKey, mint);
  await run("claim", "claim: pays 10% of the ticket from the reward vault into the owner's account", trader, () => buildClaimTx(client, trader.publicKey, { mint: M, ticket: claimable.id }), { action: "claim", mint: M, ticket: claimable.id });
  const after = await tokens(trader.publicKey, mint);
  const claimedT = decodeTicket(new Uint8Array((await connection.getAccountInfo(new PublicKey(claimable.id), "confirmed"))!.data));
  check("claim: paid (or queued) on chain", claimedT.status === "claimed" ? after > before : claimedT.status === "queued", `${claimedT.status}, +${baseToTokens(after - before)} tokens`);
  const finalT = await waitFor("data layer: ticket claimed/queued", async () => {
    const t = await watchTicket(trader.publicKey);
    return t && (t.state === "claimed" || t.state === "queued") ? t : null;
  }, 60_000);
  check("data layer: claimed ticket", finalT.state === "claimed" || finalT.state === "queued", finalT.state);

  // ── escrow: the keeper's auto-claim couldn't pay trader2 (no token account) ──
  const t2 = new PublicKey(tk2.id);
  const esc = await waitFor("trader2's auto-claim escrowed", async () => {
    const a = await connection.getAccountInfo(t2, "confirmed");
    const t = a ? decodeTicket(new Uint8Array(a.data)) : null;
    return t && t.status === "escrowed" ? t : null;
  }, 240_000, 3_000);
  await snapshot("ticketEscrowed", t2);
  await memoRequired(trader2Kp, mint, false); // the owner's account takes plain transfers again
  const t2Before = await tokens(trader2.publicKey, mint);
  await run("withdraw-escrow", "withdraw_escrow: the escrowed payout into the owner's (re-created) account", trader2, () => buildWithdrawEscrowTx(client, trader2.publicKey, { mint: M, ticket: t2.toBase58() }), { action: "escrow", mint: M, ticket: t2.toBase58() });
  check("withdraw_escrow: tokens back in trader2's account", (await tokens(trader2.publicKey, mint)) === t2Before + esc.claimAmount, `${baseToTokens(esc.claimAmount)} tokens`);

  // ── creator fees ──
  await waitFor("creator fees accrued", async () => (await coinOnChain(mint)).creatorFeesUnclaimed > BigInt(0), 120_000);
  const fees = (await coinOnChain(mint)).creatorFeesUnclaimed;
  const solBefore = await connection.getBalance(creator.publicKey, "confirmed");
  await run("withdraw-creator-fees", "withdraw_creator_fees: the coin's unclaimed creator fees to the creator", creator, () => buildWithdrawCreatorFeesTx(client, creator.publicKey, { mint: M }), { action: "withdraw", mint: M });
  const solAfter = await connection.getBalance(creator.publicKey, "confirmed");
  check("withdraw_creator_fees: creator paid", (await coinOnChain(mint)).creatorFeesUnclaimed === BigInt(0) && solAfter > solBefore, `${Number(fees) / 1e9} SOL`);

  const ticketStates = [...states].join(" → ");
  check("ticket states seen through the data layer", states.has("claimable") && (states.has("claimed") || states.has("queued")), ticketStates);
  const positions = await data.getPositions(whale.publicKey.toBase58());
  check("data layer: getPositions(whale) holds the coin", positions.some((p) => p.mint === M));

  if (CAPTURE) {
    const out = {
      about:
        "Real FUMPAD v0.7 transactions captured from the local stack (solana-test-validator + fumpad v0.7 .so + mainnet Meteora DBC/DAMM v2 binaries; services `npm run local:app`) by app/scripts/local-app-e2e.ts --capture: each tx is exactly what the app's embedded wallet was asked to sign (built by the API's launch prepare or the app's SDK builders), and each landed. Public data only.",
      capturedAt: new Date().toISOString(),
      mint: M,
      dbcConfig: info.dbcConfig,
      launch: { name: launchArgs.name, symbol: launchArgs.symbol, uri: launchArgs.uri, initialBuyLamports: launchArgs.initialBuyLamports.toString(), suffix: prepared.suffix },
      wallets: Object.fromEntries(Object.entries(info.wallets).map(([k, v]) => [k, v.address])),
      ticket: tk.id,
      escrowTicket: tk2.id,
      txs: captured,
      accounts,
      quoteSlots,
    };
    writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
    console.log(`captured ${captured.length} transactions + ${Object.keys(accounts).length} accounts → ${OUT}`);
  }
  const ok = checks.every((c) => c.ok);
  console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} app checks passed in ${Math.round((Date.now() - t0) / 1000)}s — ${ok ? "APP LIVE OK" : "APP LIVE FAILED"}`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("aborted:", e instanceof Error ? e.message : e, (e as { logs?: string[] })?.logs ?? "");
  process.exit(1);
});
