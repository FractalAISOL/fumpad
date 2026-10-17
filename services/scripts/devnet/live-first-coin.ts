/**
 * FUMPAD v0.7 LIVE devnet dress rehearsal of the FIRST-COIN launch (SPEC v0.7 clarification 30, LAUNCH-DAY §5,
 * DEPLOY-v07 §11) against the deployed program, the live Railway API (LAUNCH_FIRST_COIN=true) and the live keeper /
 * attestors. Resumable; each step skips what the state file says is done.
 *
 *   npx tsx scripts/devnet/live-first-coin.ts --step status
 *   --step launch      1. first-coin launch via the API (+ whale buys inside the 25-slot window) → policy snapshot,
 *                         config usage 1/1, a 2nd first-coin launch refused (API 409 + on-chain ConfigCoinLimit sim)
 *   --step normal      4. a standard coin in parallel (+ alice buy after its 8-slot window: 1.25%)
 *   --step window      3a. wait for the keeper's launch-window claims of both coins (first coin → 100% fee wallet)
 *   --step trades      2. after the window: alice direct DBC / bob routed buys, then ≥ $5 sells after the hold (fee ≈ 3%)
 *   --step claim       3b. later claims: wallet = ⌊claimed×140/240⌋, buyback = rest (+ the standard coin's 50/30/20)
 *   --step attest      6. both sells → TicketAttested 2-of-3 (on-chain Pyth)
 *   --step graduate    5. whale completes the curve → keeper graduates → DAMM v2 fee 3% → claim_lp_fees same split
 *   --step all
 *
 * State: ~/fumpad-keys/devnet/v07/live-first-coin-state.json. RPC from ~/fumpad-keys/devnet/rpc.env (never printed).
 * claim_fees / claim_lp_fees are permissionless: when the live keeper does not claim (its FEES_MIN_LAMPORTS default is
 * 0.05 SOL of pending partner fees), `claim` / `graduate` send the same instruction from alice (`--self-claim`).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import {
  type CoinRefs,
  claimFeesIx,
  claimLpFeesIx,
  coinPda,
  confirmSignature,
  configSlot,
  customErrorCode,
  decodeCoin,
  decodeDbcConfig,
  decodeDbcPool,
  decodeFumpadEvents,
  decodeGlobal,
  decodeTicket,
  errorName,
  FUMPAD_PROGRAM_ID,
  type FeesClaimedEvent,
  globalPda,
  inspectLaunchTx,
  launchTxLookupTables,
  isFumpadVanityMint,
  launchInstructions,
  quoteDbcBuy,
  quoteDbcSell,
  dbcQuoteToComplete,
  ticketPda,
  type TxLike,
  walletSplit,
} from "@fumpad/sdk";
import { parseMeteoraTrades, type MeteoraTrade } from "@fumpad/meteora";
import { signLaunchAuth } from "@fumpad/api";

import { directDammBuy, directDammSell, directDbcBuy, directDbcSell, routedBuy, routedSell, send, tokenBalance, transferSol } from "../local/actors.js";
import { readRpcUrl } from "./bootstrap-v07.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const FIRST_COIN_CONFIG = "E41sR8pdoybdMRjquxgUeuqtGikrc8YUZPYNeFp3J67Y";
const KEYS = join(homedir(), "fumpad-keys/devnet/v07");
const STATE_FILE = join(KEYS, "live-first-coin-state.json");
const API = process.env.FUMPAD_API ?? "https://api-production-66441.up.railway.app";
const SOL = BigInt(LAMPORTS_PER_SOL);
const sol = (l: bigint | number) => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);
const tx = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
const acct = (a: string | PublicKey) => `https://solscan.io/account/${a.toString()}?cluster=devnet`;
const nowSecs = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (num: bigint, den: bigint) => (den === 0n ? NaN : Number((num * 1_000_000n) / den) / 10_000);

type Step = "status" | "launch" | "normal" | "window" | "trades" | "claim" | "attest" | "graduate";
const ORDER: Step[] = ["launch", "normal", "window", "trades", "claim", "attest", "graduate"];

interface Fee { sig: string; who: string; side: string; venue: string; feePct: number; slot: number; offset?: number }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type State = Record<string, any> & { checks: { step: string; name: string; ok: boolean; detail?: string; at: number }[] };

const loadState = (): State => (existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, "utf8")) as State) : { checks: [] });
const saveState = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), { mode: 0o600 });
const kp = (name: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(KEYS, `${name}.json`), "utf8")) as number[]));

class Run {
  conn: Connection;
  st: State;
  creator = kp("creator");
  alice = kp("alice");
  bob = kp("bob");
  whale = kp("whale");
  step: Step = "status";
  failed = 0;
  selfClaim = false;

  constructor(rpcUrl: string) {
    this.conn = new Connection(rpcUrl, "confirmed");
    this.st = loadState();
  }

  check(name: string, ok: boolean, detail?: string) {
    console.log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) this.failed++;
    this.st.checks.push({ step: this.step, name, ok, detail, at: nowSecs() });
    saveState(this.st);
  }
  async get<T>(path: string): Promise<T> {
    const r = await fetch(API + path);
    if (!r.ok) throw new Error(`GET ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }
  async waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 5_000): Promise<T | null> {
    const t0 = Date.now();
    let last = Date.now();
    for (;;) {
      const v = await fn().catch((e) => {
        console.log(`    (${what}: ${String(e).slice(0, 160)})`);
        return null;
      });
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) return null;
      if (Date.now() - last > 60_000) {
        console.log(`    … waiting for ${what} (${Math.round((Date.now() - t0) / 1000)} s)`);
        last = Date.now();
      }
      await sleep(everyMs);
    }
  }
  async global() {
    return decodeGlobal(new Uint8Array((await this.conn.getAccountInfo(globalPda()))!.data));
  }
  async coinOf(mint: string) {
    const a = await this.conn.getAccountInfo(coinPda(new PublicKey(mint)));
    if (!a) throw new Error(`coin ${mint} missing`);
    return { coin: decodeCoin(new Uint8Array(a.data)), size: a.data.length };
  }
  async refsOf(mint: string): Promise<CoinRefs> {
    const { coin: c } = await this.coinOf(mint);
    return { mint: c.mint, dbcConfig: c.dbcConfig, dbcPool: c.dbcPool, dammPool: c.status === "graduated" ? c.dammPool : undefined, dammPosition: c.status === "graduated" ? c.dammPosition : undefined, creator: c.creator, feeWallet: c.feePolicy?.wallet ?? null };
  }
  async dbc(mint: string) {
    const { coin } = await this.coinOf(mint);
    const [cfgA, poolA] = await this.conn.getMultipleAccountsInfo([coin.dbcConfig, coin.dbcPool]);
    return { cfg: decodeDbcConfig(new Uint8Array(cfgA!.data)), pool: decodeDbcPool(new Uint8Array(poolA!.data)) };
  }
  async txInfo(sig: string) {
    for (let i = 0; i < 10; i++) {
      const t = await this.conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      if (t) return t;
      await sleep(1_000);
    }
    throw new Error(`tx ${sig} not found`);
  }
  /** The Meteora swap of `sig` (parsed from its own events) and its total fee as % of the trade's quote size. */
  async feeOf(sig: string, who: string): Promise<Fee & { trade: MeteoraTrade }> {
    const t = await this.txInfo(sig);
    const r = parseMeteoraTrades(t as never);
    const trade = r.trades[0];
    if (!trade) throw new Error(`no Meteora trade in ${sig}: ${JSON.stringify(r.issues)}`);
    const den = trade.side === "buy" ? trade.amountIn : trade.amountOut + trade.fee.total;
    return { sig, who, side: trade.side, venue: trade.venue, feePct: pct(trade.fee.total, den), slot: t.slot, trade };
  }
  async fcWalletBal() {
    return BigInt(await this.conn.getBalance(new PublicKey(this.st.fcWallet), "confirmed"));
  }
  /** FeesClaimed events of `mint` (newest first), with their tx. */
  async feeClaims(mint: string, limit = 40): Promise<{ sig: string; ev: FeesClaimedEvent }[]> {
    const sigs = await this.conn.getSignaturesForAddress(coinPda(new PublicKey(mint)), { limit });
    const out: { sig: string; ev: FeesClaimedEvent }[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      const t = await this.txInfo(s.signature);
      for (const e of decodeFumpadEvents(t as unknown as TxLike)) if (e.name === "FeesClaimed") out.push({ sig: s.signature, ev: e.data as unknown as FeesClaimedEvent });
    }
    return out;
  }

  // ── status ──────────────────────────────────────────────────────────────
  async status() {
    for (const [n, k] of Object.entries({ creator: this.creator, alice: this.alice, bob: this.bob, whale: this.whale })) console.log(`  ${n.padEnd(8)} ${k.publicKey.toBase58()}  ${sol(await this.conn.getBalance(k.publicKey))} SOL`);
    const g = await this.global();
    const s = configSlot(g, new PublicKey(FIRST_COIN_CONFIG));
    console.log(`  first-coin config ${FIRST_COIN_CONFIG}: ${s ? `slot ${s.index} kind ${s.policy.kind} buyback ${s.policy.buybackShare} wallet ${s.policy.walletShare} max ${s.policy.maxCoins} coins ${s.coins} wallet ${s.policy.wallet.toBase58()}` : "not allow-listed"}`);
    for (const [label, m] of [["first coin", this.st.fcMint], ["standard coin", this.st.ncMint]] as const) {
      if (!m) continue;
      const { coin: c, size } = await this.coinOf(m);
      console.log(`  ${label} ${m}: ${c.status} size ${size} B settled=${c.launchFeesSettled} feesClaimed ${sol(c.feesClaimedLamports)} buyback ${sol(c.buybackLamports)} platform ${sol(c.platformFeesUnclaimed)} creator ${sol(c.creatorFeesUnclaimed)}${c.walletPaidLamports !== undefined ? ` walletPaid ${sol(c.walletPaidLamports)}` : ""}`);
    }
    if (this.st.fcWallet) console.log(`  fee wallet ${this.st.fcWallet}: ${sol(await this.fcWalletBal())} SOL`);
  }

  // ── 1. first-coin launch + a buy inside the 25-slot window ─────────────────
  async prepare(who: Keypair, symbol: string, launchConfig: "first_coin" | "standard", initialBuy: bigint) {
    return fetch(`${API}/v1/launch/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ creator: who.publicKey.toBase58(), name: launchConfig === "first_coin" ? "Fumpad First Rehearsal" : "Fumpad Std Rehearsal", symbol, uri: `https://fumpad.fun/m/${symbol.toLowerCase()}.json`, initialBuyLamports: String(initialBuy), launchConfig, auth: signLaunchAuth(who.secretKey, { creator: who.publicKey.toBase58(), symbol }) }),
    });
  }

  async launchVia(who: Keypair, symbol: string, kind: "first_coin" | "standard", initialBuy: bigint) {
    const r = await this.prepare(who, symbol, kind, initialBuy);
    if (!r.ok) throw new Error(`prepare(${kind}) → ${r.status} ${await r.text()}`);
    const p = (await r.json()) as { mint: string; transaction: string; lastValidBlockHeight: number; config: { kind: string; dbcConfig: string; feeBps: number; snipeStartBps: number; snipeWindowSlots: number; migratedPoolFeeBps: number; feePolicy: { kind: number; buybackShareBps: number; walletShareBps: number; wallet: string | null; maxCoins: number; coinsRegistered: number } } };
    const ltx = VersionedTransaction.deserialize(Buffer.from(p.transaction, "base64"));
    const info = inspectLaunchTx(ltx, await launchTxLookupTables(this.conn, ltx));
    ltx.sign([who]);
    const raw = ltx.serialize();
    const sig = await this.conn.sendRawTransaction(raw, { maxRetries: 0 });
    await confirmSignature(this.conn, sig, p.lastValidBlockHeight, "confirmed", raw);
    return { p, info, sig };
  }

  async launch() {
    if (this.st.fcMint) return console.log(`  (done) ${this.st.fcMint} ${tx(this.st.fcLaunch.sig)}`);
    const g0 = await this.global();
    const slot0 = configSlot(g0, new PublicKey(FIRST_COIN_CONFIG));
    const opts = await this.get<{ firstCoin: { dbcConfig: string; wallet: string; buybackShareBps: number; walletShareBps: number; launchesLeft: number | null } | null }>("/v1/launch/options");
    this.check("before: config allow-listed with the wallet-split policy, 0/1 used; API offers it", !!slot0 && slot0.policy.kind === 1 && slot0.policy.buybackShare === 100 && slot0.policy.walletShare === 140 && slot0.policy.maxCoins === 1 && slot0.coins === 0 && opts.firstCoin?.dbcConfig === FIRST_COIN_CONFIG && opts.firstCoin.launchesLeft === 1, JSON.stringify(opts.firstCoin));
    const wallet = slot0!.policy.wallet;
    this.st.fcWallet = wallet.toBase58();
    this.st.fcWalletBefore = String(await this.fcWalletBal());
    saveState(this.st);
    const initialBuy = SOL / 50n; // 0.02 SOL
    const snipeLamports = SOL / 100n; // 0.01 SOL
    const { p, info, sig } = await this.launchVia(this.creator, "FIRST", "first_coin", initialBuy);
    // the in-window buy right away (25 slots ≈ 10 s)
    const fcRefs: CoinRefs = { mint: new PublicKey(p.mint), dbcConfig: new PublicKey(FIRST_COIN_CONFIG) }; // pool = PDA(config, mint)
    let snipeSig: string | null = null;
    let snipeErr: string | null = null;
    try {
      snipeSig = await directDbcBuy(this.conn, this.whale, fcRefs, snipeLamports);
    } catch (e) {
      snipeErr = String(e).slice(0, 200);
    }
    console.log(`  → first-coin launch ${tx(sig)}${snipeSig ? `\n  → whale in-window DIRECT DBC buy 0.01 SOL ${tx(snipeSig)}` : ` (snipe failed: ${snipeErr})`}`);
    this.st.fcMint = p.mint;
    const lt = await this.txInfo(sig);
    this.st.fcLaunch = { sig, slot: lt.slot, ts: lt.blockTime };
    saveState(this.st);
    const launchSigner = g0.params.launchSigner.toBase58();
    this.check(
      "prepare (first_coin): first-coin config, 3% / 99%→3% over 25 slots / DAMM 3%, wallet-split {100,140,max 1}, pre-signed by …fmbL mint + launch_signer",
      p.config.kind === "first_coin" && p.config.dbcConfig === FIRST_COIN_CONFIG && info.dbcConfig === FIRST_COIN_CONFIG && p.config.feeBps === 300 && p.config.snipeStartBps === 9900 && p.config.snipeWindowSlots === 25 && p.config.migratedPoolFeeBps === 300 && p.config.feePolicy.kind === 1 && p.config.feePolicy.buybackShareBps === 100 && p.config.feePolicy.walletShareBps === 140 && p.config.feePolicy.wallet === wallet.toBase58() && p.config.feePolicy.maxCoins === 1 && isFumpadVanityMint(p.mint) && [...info.signed].sort().join() === [p.mint, launchSigner].sort().join(),
      `mint ${p.mint}; config ${JSON.stringify(p.config)}`,
    );
    const { coin: c, size } = await this.coinOf(p.mint);
    const ev = decodeFumpadEvents(lt as unknown as TxLike).find((e) => e.name === "CoinRegistered");
    this.check(
      "coin registered with the wallet-split policy snapshot (Coin 593 B, kind 1, 100/140, wallet = config's, max 1; CoinRegistered.feePolicy)",
      c.status === "curve" && c.dbcConfig.toBase58() === FIRST_COIN_CONFIG && size === 593 && c.feePolicyKind === 1 && c.feePolicy?.buybackShare === 100 && c.feePolicy.walletShare === 140 && c.feePolicy.maxCoins === 1 && c.feePolicy.wallet.equals(wallet) && !!ev && Number(c.launchWindowSlots) === 25,
      `${acct(coinPda(new PublicKey(p.mint)))}; launch slot ${c.launchSlot}, window ${c.launchWindowSlots} slots`,
    );
    const g1 = await this.global();
    const s1 = configSlot(g1, new PublicKey(FIRST_COIN_CONFIG))!;
    this.check("config usage now 1/1 (Global.config_coins)", s1.coins === 1 && s1.policy.maxCoins === 1, `coins ${s1.coins}/${s1.policy.maxCoins}`);
    // creator's first buy: the config's min fee (3%)
    const cf = await this.feeOf(sig, "creator");
    this.check("creator's launch-tx first buy paid the config min fee 3% (no wallet exemption)", Math.abs(cf.feePct - 3) < 0.01, `${cf.feePct}%`);
    if (snipeSig) {
      const f = await this.feeOf(snipeSig, "whale");
      f.offset = f.slot - Number(c.launchSlot);
      const expected = 99 - (96 / 25) * Math.min(f.offset, 25);
      this.st.fees = [{ ...f, trade: undefined }, { ...cf, trade: undefined }];
      saveState(this.st);
      this.check("in-window buy paid the decaying launch fee (99% − 3.84%/slot)", f.offset < 25 && Math.abs(f.feePct - expected) < 0.05, `landed ${f.offset} slots after launch (≈${(f.offset * 0.4).toFixed(1)} s): fee ${f.feePct}% (schedule ${expected.toFixed(2)}%)`);
    } else this.check("in-window buy landed", false, snipeErr ?? "");
    // a second first-coin launch: API (after its 10 s Global cache) and the program itself
    await sleep(12_000);
    const opts2 = await this.get<{ firstCoin: unknown }>("/v1/launch/options");
    const again = await this.prepare(this.bob, "AGAIN", "first_coin", 0n);
    const againBody = await again.text();
    this.check("2nd first-coin launch refused by the API (409) and /v1/launch/options no longer offers it", again.status === 409 && opts2.firstCoin === null, `${again.status} ${againBody.slice(0, 140)}; options ${JSON.stringify(opts2)}`);
    // On chain, with the real launch co-signer: simulate a launch on the first-coin config (fresh mint) → ConfigCoinLimit
    const mint = Keypair.generate();
    const ls = kp("launch-signer");
    const ixs = launchInstructions({ creator: this.bob.publicKey, mint: mint.publicKey, dbcConfig: new PublicKey(FIRST_COIN_CONFIG), name: "Again", symbol: "AGAIN", uri: "https://fumpad.fun/m/again.json", buyLamports: 0n, minTokensOut: 0n, launchSigner: ls.publicKey });
    const { blockhash } = await this.conn.getLatestBlockhash("confirmed");
    const vtx = new VersionedTransaction(new TransactionMessage({ payerKey: this.bob.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    vtx.sign([this.bob, mint, ls]);
    const sim = await this.conn.simulateTransaction(vtx, { sigVerify: true, commitment: "confirmed" });
    const code = customErrorCode(sim.value.err);
    this.check("on chain: a launch-signer co-signed 2nd launch on the config fails ConfigCoinLimit (simulated, not sent)", code !== null && errorName(code) === "ConfigCoinLimit", `err ${JSON.stringify(sim.value.err)} = ${code !== null ? errorName(code) : "?"}`);
    const api = await this.waitFor("API shows the first coin", async () => {
      const x = await this.get<{ mint: string; fees?: Record<string, unknown> }>(`/v1/coins/by-mint/${p.mint}`).catch(() => null);
      return x?.mint === p.mint ? x : null;
    }, 180_000);
    const fees = api?.fees as { feeBps?: number; migratedFeeBps?: number; policy?: string; wallet?: string; poolShareBps?: number; walletShareBps?: number } | undefined;
    this.check("API coin shows 3% curve / 3% DAMM v2 and the wallet split", fees?.feeBps === 300 && fees.migratedFeeBps === 300 && fees.policy === "wallet_split" && fees.wallet === wallet.toBase58() && fees.poolShareBps === 100 && fees.walletShareBps === 140, JSON.stringify(fees));
  }

  // ── 4. standard coin in parallel ─────────────────────────────────────────
  async normal() {
    if (!this.st.ncMint) {
      const { p, sig } = await this.launchVia(this.creator, "STDP", "standard", SOL / 50n);
      console.log(`  → standard launch ${tx(sig)}`);
      const lt = await this.txInfo(sig);
      this.st.ncMint = p.mint;
      this.st.ncLaunch = { sig, slot: lt.slot };
      saveState(this.st);
      const { coin: c, size } = await this.coinOf(p.mint);
      const cf = await this.feeOf(sig, "creator");
      this.check("standard coin: standard config + policy (Coin 546 B), creator first buy 1.25%", p.config.kind === "standard" && c.feePolicyKind === 0 && size === 546 && p.config.feeBps === 125 && Math.abs(cf.feePct - 1.25) < 0.01, `${p.mint} ${acct(coinPda(new PublicKey(p.mint)))}; fee ${cf.feePct}%`);
    }
    if (!this.st.ncBuy) {
      const launchSlot = this.st.ncLaunch.slot as number;
      await this.waitFor("standard launch window (8 slots) over", async () => ((await this.conn.getSlot("confirmed")) > launchSlot + 10 ? true : null), 60_000, 1_000);
      const refs = await this.refsOf(this.st.ncMint);
      const sig = await directDbcBuy(this.conn, this.alice, refs, SOL / 20n);
      const f = await this.feeOf(sig, "alice");
      console.log(`  → alice DIRECT DBC buy 0.05 SOL on the standard coin ${tx(sig)}`);
      this.check("standard coin: trade after its window pays 1.25%", Math.abs(f.feePct - 1.25) < 0.01, `${f.feePct}%`);
      this.st.ncBuy = { sig, feePct: f.feePct };
      saveState(this.st);
    }
  }

  // ── 3a. keeper's launch-window claims ─────────────────────────────────────
  async window() {
    for (const [label, m] of [["first coin", this.st.fcMint], ["standard coin", this.st.ncMint]] as const) {
      if (!m) continue;
      const settled = await this.waitFor(`keeper's launch-window claim_fees on the ${label}`, async () => ((await this.coinOf(m)).coin.launchFeesSettled ? true : null), 10 * 60_000, 5_000);
      if (!settled) {
        this.check(`${label}: keeper settled the launch window within 10 min`, false);
        continue;
      }
      const lw = (await this.feeClaims(m)).find((x) => x.ev.launchWindow);
      if (!lw) {
        this.check(`${label}: FeesClaimed(launch_window) found`, false);
        continue;
      }
      const t = await this.txInfo(lw.sig);
      const caller = t.transaction.message.staticAccountKeys[0].toBase58();
      const e = lw.ev;
      if (label === "first coin") {
        const before = BigInt(this.st.fcWalletBefore);
        const after = await this.fcWalletBal();
        const { coin } = await this.coinOf(m);
        this.st.fcWindowClaim = { sig: lw.sig, claimed: e.claimed, toWallet: e.toWallet, walletAfter: after.toString(), caller };
        this.check(
          "first coin launch-window claim → 100% of FUMPAD's share to the fee wallet (to_wallet = claimed; buyback/platform/creator 0)",
          e.claimed > 0n && e.toWallet === e.claimed && e.toBuyback === 0n && e.toPlatform === 0n && e.toCreator === 0n && e.feeWallet.toBase58() === this.st.fcWallet && after - before === e.claimed && coin.buybackLamports === 0n,
          `claimed ${sol(e.claimed)} SOL by ${caller} ${tx(lw.sig)}; fee wallet ${sol(before)} → ${sol(after)} SOL (+${sol(after - before)}); coin buyback ${sol(coin.buybackLamports)}`,
        );
      } else {
        this.st.ncWindowClaim = { sig: lw.sig, claimed: e.claimed };
        this.check("standard coin launch-window claim → 100% buyback (D33)", e.claimed > 0n && e.toBuyback === e.claimed && e.toWallet === 0n && e.toPlatform === 0n, `claimed ${sol(e.claimed)} SOL ${tx(lw.sig)}`);
      }
      saveState(this.st);
    }
  }

  // ── 2. trades after the window ────────────────────────────────────────────
  async trades() {
    const m = this.st.fcMint as string;
    const refs = await this.refsOf(m);
    const tr = (this.st.fcTrades ??= {});
    for (const [name, who, routed] of [["aliceBuy", this.alice, false], ["bobBuy", this.bob, true]] as const) {
      if (tr[name]) continue;
      const amt = SOL / 10n;
      const sig = routed ? await routedBuy(this.conn, who, refs, "dbc", amt) : await directDbcBuy(this.conn, who, refs, amt);
      const f = await this.feeOf(sig, name);
      const t = await this.txInfo(sig);
      console.log(`  → ${name} ${routed ? "ROUTER" : "DIRECT DBC"} buy 0.1 SOL ${tx(sig)}`);
      this.check(`first coin ${name} (${routed ? "router" : "direct DBC"}) fee ≈ 3%`, Math.abs(f.feePct - 3) < 0.01 && t.transaction.message.staticAccountKeys.some((k) => k.equals(FUMPAD_PROGRAM_ID)) === routed, `${f.feePct}%`);
      tr[name] = { sig, ts: t.blockTime, feePct: f.feePct, tokens: f.trade.baseAmount.toString() };
      saveState(this.st);
    }
    const holdUntil = Math.max(tr.aliceBuy.ts, tr.bobBuy.ts) + 75;
    if (nowSecs() < holdUntil && (!tr.aliceSell || !tr.bobSell)) {
      console.log(`  waiting ${holdUntil - nowSecs()} s for the 60 s hold (+15 s)`);
      await sleep((holdUntil - nowSecs()) * 1000);
    }
    const TARGET_CENTS = 700;
    for (const [name, who, routed] of [["aliceSell", this.alice, false], ["bobSell", this.bob, true]] as const) {
      if (tr[name]) continue;
      const usd = (await this.get<{ solUsd: number }>("/v1/sol-usd")).solUsd;
      const bal = await tokenBalance(this.conn, who.publicKey, refs.mint);
      const { cfg, pool } = await this.dbc(m);
      const slot = BigInt(await this.conn.getSlot("confirmed"));
      const cents = (tokens: bigint) => {
        const q = quoteDbcSell(cfg, pool, tokens, slot);
        return (Number(q.amountOut + q.fee) / 1e9) * usd * 100;
      };
      let lo = 0n, hi = (bal * 95n) / 100n;
      if (cents(hi) < TARGET_CENTS) throw new Error(`${name}: 95% of the position is worth < $7`);
      while (hi - lo > bal / 1000n) {
        const mid = (lo + hi) / 2n;
        if (cents(mid) >= TARGET_CENTS) hi = mid;
        else lo = mid;
      }
      const sig = routed ? await routedSell(this.conn, who, refs, "dbc", hi) : await directDbcSell(this.conn, who, refs, hi);
      const f = await this.feeOf(sig, name);
      const t = await this.txInfo(sig);
      console.log(`  → ${name} ${routed ? "ROUTER" : "DIRECT DBC"} sell ${Number(hi) / 1e6} tokens (~$${(cents(hi) / 100).toFixed(2)} at SOL $${usd.toFixed(2)}) ${tx(sig)}`);
      this.check(`first coin ${name} (${routed ? "router" : "direct DBC"}) fee ≈ 3%`, Math.abs(f.feePct - 3) < 0.01, `${f.feePct}%`);
      tr[name] = { sig, ts: t.blockTime, feePct: f.feePct, usd: cents(hi) / 100 };
      saveState(this.st);
    }
    // the standard coin: a sell too, so its next claim has fees from both sides
    if (!this.st.ncSell) {
      const nrefs = await this.refsOf(this.st.ncMint);
      const bal = await tokenBalance(this.conn, this.alice.publicKey, nrefs.mint);
      const sig = await directDbcSell(this.conn, this.alice, nrefs, bal / 2n);
      const f = await this.feeOf(sig, "alice");
      this.check("standard coin: sell pays 1.25%", Math.abs(f.feePct - 1.25) < 0.01, `${f.feePct}% ${tx(sig)}`);
      this.st.ncSell = { sig, feePct: f.feePct };
      saveState(this.st);
    }
  }

  // ── 3b. later claims ──────────────────────────────────────────────────────
  async claimOnce(mint: string, label: string, keeperWaitSecs: number): Promise<{ sig: string; ev: FeesClaimedEvent; by: string } | null> {
    const known = new Set((await this.feeClaims(mint)).map((x) => x.sig));
    const { pool } = await this.dbc(mint);
    console.log(`  ${label}: pending partner fee on DBC ${sol(pool.partnerQuoteFee)} SOL (keeper claims at ≥ 0.05 SOL / 10 min)`);
    const byKeeper = await this.waitFor(`keeper claim_fees on the ${label}`, async () => {
      const n = (await this.feeClaims(mint, 10)).find((x) => !known.has(x.sig) && !x.ev.launchWindow);
      return n ?? null;
    }, keeperWaitSecs * 1000, 15_000);
    if (byKeeper) return { ...byKeeper, by: "keeper" };
    if (!this.selfClaim) return null;
    const refs = await this.refsOf(mint);
    const sig = await send(this.conn, this.alice, [claimFeesIx(this.alice.publicKey, refs)], [], 200_000);
    const ev = decodeFumpadEvents((await this.txInfo(sig)) as unknown as TxLike).find((e) => e.name === "FeesClaimed")!.data as unknown as FeesClaimedEvent;
    return { sig, ev, by: "alice (permissionless)" };
  }

  async claim() {
    const keeperWait = Number(process.env.KEEPER_WAIT_SECS ?? 60);
    if (!this.st.fcClaim) {
      const m = this.st.fcMint as string;
      const w0 = await this.fcWalletBal();
      const c0 = (await this.coinOf(m)).coin;
      const r = await this.claimOnce(m, "first coin", keeperWait);
      if (!r) return this.check("first coin: a post-window claim_fees", false, "keeper did not claim; rerun with --self-claim");
      const w1 = await this.fcWalletBal();
      const c1 = (await this.coinOf(m)).coin;
      const want = walletSplit(r.ev.claimed, { buybackShare: 100, walletShare: 140 });
      this.st.fcClaim = { sig: r.sig, by: r.by, claimed: r.ev.claimed, toWallet: r.ev.toWallet, toBuyback: r.ev.toBuyback, walletBefore: w0, walletAfter: w1, buybackBefore: c0.buybackLamports, buybackAfter: c1.buybackLamports };
      saveState(this.st);
      this.check(
        "first coin later claim: wallet = ⌊claimed×140/240⌋, buyback = rest, platform/creator 0; balances moved by exactly that",
        r.ev.toWallet === want.wallet && r.ev.toBuyback === want.buyback && r.ev.toPlatform === 0n && r.ev.toCreator === 0n && w1 - w0 === want.wallet && c1.buybackLamports - c0.buybackLamports === want.buyback && c1.platformFeesUnclaimed === c0.platformFeesUnclaimed && c1.creatorFeesUnclaimed === c0.creatorFeesUnclaimed,
        `by ${r.by} ${tx(r.sig)}: claimed ${r.ev.claimed} → wallet ${r.ev.toWallet} (want ${want.wallet}), buyback ${r.ev.toBuyback}; fee wallet ${sol(w0)} → ${sol(w1)}; coin buyback ${sol(c0.buybackLamports)} → ${sol(c1.buybackLamports)}; walletPaid total ${sol(c1.walletPaidLamports ?? 0n)}`,
      );
    }
    if (!this.st.ncClaim) {
      const m = this.st.ncMint as string;
      const g = await this.global();
      const r = await this.claimOnce(m, "standard coin", keeperWait);
      if (!r) return this.check("standard coin: a post-window claim_fees", false, "keeper did not claim; rerun with --self-claim");
      const c = r.ev.claimed;
      const plat = (c * BigInt(g.params.feePlatformShareBps)) / 10_000n, cre = (c * BigInt(g.params.feeCreatorShareBps)) / 10_000n;
      this.st.ncClaim = { sig: r.sig, by: r.by, claimed: c, toBuyback: r.ev.toBuyback, toPlatform: r.ev.toPlatform, toCreator: r.ev.toCreator };
      saveState(this.st);
      this.check("standard coin later claim splits 50/30/20 (buyback/platform/creator), nothing to a wallet", r.ev.toPlatform === plat && r.ev.toCreator === cre && r.ev.toBuyback === c - plat - cre && r.ev.toWallet === 0n, `by ${r.by} ${tx(r.sig)}: claimed ${c} → ${r.ev.toBuyback}/${r.ev.toPlatform}/${r.ev.toCreator}`);
    }
  }

  // ── 6. attestation ────────────────────────────────────────────────────────
  async attest() {
    const m = new PublicKey(this.st.fcMint);
    for (const [name, who, src] of [["alice", this.alice, "outside"], ["bob", this.bob, "router"]] as const) {
      if (this.st.fcTickets?.[name]) continue;
      const addr = ticketPda(m, who.publicKey, 0n);
      const t = await this.waitFor(`${name}'s ticket attested`, async () => {
        const a = await this.conn.getAccountInfo(addr);
        return a ? decodeTicket(new Uint8Array(a.data)) : null;
      }, 15 * 60_000, 5_000);
      if (!t) {
        this.check(`${name}: first-coin sell → TicketAttested`, false, `no ticket at ${addr.toBase58()}`);
        continue;
      }
      const sigs = await this.conn.getSignaturesForAddress(addr, { limit: 20 });
      const attestSig = sigs.at(-1)!.signature;
      const at = await this.txInfo(attestSig);
      const ed = at.transaction.message.staticAccountKeys.some((k) => k.toBase58() === "Ed25519SigVerify111111111111111111111111111");
      const ev = decodeFumpadEvents(at as unknown as TxLike).find((e) => e.name === "TicketAttested");
      (this.st.fcTickets ??= {})[name] = { ticket: addr.toBase58(), sig: attestSig, usd: Number(t.sellUsdCents) / 100, delay: Number(t.attestedAt - t.sellTs) };
      saveState(this.st);
      this.check(`${name}: ≥ $5 first-coin sell attested 2-of-3 (source ${src}, Ed25519 sigs, on-chain Pyth price)`, t.source === src && t.sellUsdCents >= 500n && ed && !!ev, `$${Number(t.sellUsdCents) / 100}, ${Number(t.attestedAt - t.sellTs)} s after the sell, ${tx(attestSig)}`);
    }
  }

  // ── 5. graduation + DAMM v2 3% + claim_lp_fees ─────────────────────────────
  async graduate() {
    const m = this.st.fcMint as string;
    let { coin } = await this.coinOf(m);
    if (!this.st.fcWhale && coin.status === "curve") {
      const { cfg, pool } = await this.dbc(m);
      const need = dbcQuoteToComplete(cfg, pool);
      const bal = BigInt(await this.conn.getBalance(this.whale.publicKey));
      const avail = bal - SOL / 20n;
      const slot = BigInt(await this.conn.getSlot("confirmed"));
      const q = quoteDbcBuy(cfg, pool, avail, slot, { partialFill: true });
      console.log(`  curve ${sol(pool.quoteReserve)} / ${sol(cfg.migrationQuoteThreshold)} SOL; ${sol(need)} to complete; whale ${sol(bal)}; PartialFill uses ${sol(q.amountIn)} (completes=${q.completesCurve})`);
      if (!q.completesCurve) throw new Error("whale cannot complete the curve");
      const amount = q.amountIn + q.amountIn / 50n < avail ? q.amountIn + q.amountIn / 50n : avail;
      const sig = await routedBuy(this.conn, this.whale, await this.refsOf(m), "dbc", amount, 1);
      const f = await this.feeOf(sig, "whale");
      console.log(`  → whale routed PartialFill buy ${tx(sig)} (fee ${f.feePct}%)`);
      this.st.fcWhale = { sig, feePct: f.feePct, spent: String(bal - BigInt(await this.conn.getBalance(this.whale.publicKey))) };
      saveState(this.st);
    }
    const g = await this.waitFor("keeper migrate + graduate", async () => {
      const c = (await this.coinOf(m)).coin;
      return c.status === "graduated" ? c : null;
    }, 15 * 60_000, 5_000);
    if (!g) {
      const { pool } = await this.dbc(m);
      return this.check("first coin graduated within 15 min", false, `status ${(await this.coinOf(m)).coin.status}, DBC progress ${pool.migrationProgress}`);
    }
    coin = g;
    const sigs = await this.conn.getSignaturesForAddress(coinPda(new PublicKey(m)), { limit: 30 });
    const gradSig = sigs.find((s) => !s.err && Math.abs((s.blockTime ?? 0) - Number(g.graduatedAt)) <= 1)?.signature;
    this.check("first coin graduated (DAMM v2 pool + locked position)", true, `pool ${acct(g.dammPool)}${gradSig ? ` graduate ${tx(gradSig)}` : ""}`);
    this.st.fcGraduated = { pool: g.dammPool.toBase58(), sig: gradSig };
    saveState(this.st);
    const refs = await this.refsOf(m);
    if (!this.st.fcDamm) {
      const sig = await directDammBuy(this.conn, this.alice, refs, g.dammPool, SOL / 50n);
      const f = await this.feeOf(sig, "alice");
      const got = f.trade.baseAmount;
      const sig2 = await directDammSell(this.conn, this.alice, refs, g.dammPool, got / 2n);
      const f2 = await this.feeOf(sig2, "alice");
      this.st.fcDamm = { buy: sig, buyFee: f.feePct, sell: sig2, sellFee: f2.feePct };
      saveState(this.st);
      this.check("DAMM v2 pool fee 3% (direct buy + sell)", Math.abs(f.feePct - 3) < 0.01 && Math.abs(f2.feePct - 3) < 0.01, `buy ${f.feePct}% ${tx(sig)}; sell ${f2.feePct}% ${tx(sig2)}`);
    }
    if (!this.st.fcLp) {
      const known = new Set((await this.feeClaims(m)).map((x) => x.sig));
      const keeperWait = Number(process.env.KEEPER_WAIT_SECS ?? 60);
      let r = await this.waitFor("keeper claim_lp_fees", async () => (await this.feeClaims(m, 10)).find((x) => !known.has(x.sig) && x.ev.venue !== 0) ?? null, keeperWait * 1000, 15_000);
      let by = "keeper";
      const w0 = await this.fcWalletBal();
      const c0 = (await this.coinOf(m)).coin;
      if (!r && this.selfClaim) {
        const posA = await this.conn.getAccountInfo(coin.dammPosition);
        const nft = new PublicKey(posA!.data.subarray(40, 72));
        const sig = await send(this.conn, this.alice, [claimLpFeesIx(this.alice.publicKey, { ...refs, dammPosition: coin.dammPosition, positionNftMint: nft })], [], 300_000);
        const ev = decodeFumpadEvents((await this.txInfo(sig)) as unknown as TxLike).find((e) => e.name === "FeesClaimed")!.data as unknown as FeesClaimedEvent;
        r = { sig, ev };
        by = "alice (permissionless)";
      }
      if (!r) return this.check("claim_lp_fees", false, "keeper did not claim; rerun with --self-claim");
      const w1 = await this.fcWalletBal();
      const c1 = (await this.coinOf(m)).coin;
      const want = walletSplit(r.ev.claimed, { buybackShare: 100, walletShare: 140 });
      this.st.fcLp = { sig: r.sig, by, claimed: r.ev.claimed, toWallet: r.ev.toWallet, toBuyback: r.ev.toBuyback };
      saveState(this.st);
      const exact = by === "keeper" || (w1 - w0 === want.wallet && c1.buybackLamports - c0.buybackLamports === want.buyback);
      this.check("claim_lp_fees uses the same split (wallet ⌊×140/240⌋, buyback rest, no platform/creator)", r.ev.claimed > 0n && r.ev.toWallet === want.wallet && r.ev.toBuyback === want.buyback && r.ev.toPlatform === 0n && r.ev.toCreator === 0n && exact, `by ${by} ${tx(r.sig)}: venue ${r.ev.venue} claimed ${r.ev.claimed} → wallet ${r.ev.toWallet}, buyback ${r.ev.toBuyback}; fee wallet ${sol(w0)} → ${sol(w1)}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const stepArg = (arg("--step") ?? "status") as Step | "all";
  const steps: Step[] = stepArg === "all" ? ORDER : [stepArg];
  for (const s of steps) if (s !== "status" && !ORDER.includes(s)) throw new Error(`unknown step ${s}`);
  const rpc = readRpcUrl();
  const run = new Run(rpc);
  run.selfClaim = argv.includes("--self-claim");
  void transferSol;
  void ComputeBudgetProgram;
  try {
    if ((await run.conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("refusing: the RPC is not devnet");
    console.log(`FUMPAD first-coin live rehearsal · program ${acct(FUMPAD_PROGRAM_ID)} · API ${API} · state ${STATE_FILE}`);
    for (const s of steps) {
      run.step = s;
      console.log(`\n▶ ${s}  (${new Date().toISOString()})`);
      if (s === "status") await run.status();
      else await (run[s] as () => Promise<void>).call(run);
    }
  } catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error(`✘ aborted: ${msg.split(rpc).join("<RPC_URL>")}`);
    process.exit(2);
  }
  console.log(run.failed ? `\n${run.failed} check(s) failed` : "\nall checks passed");
  process.exit(run.failed ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
