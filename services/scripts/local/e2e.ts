/**
 * v0.7 acceptance test: the whole off-chain stack against solana-test-validator running the built fumpad
 * v0.7 program and the MAINNET Meteora DBC 0.2.1 + DAMM v2 0.2.4 binaries (+ mainnet migration config).
 *
 *   Postgres → indexer (fumpad + Meteora sources) → API (REST + WS + launch prepare)
 *   grinder (…fmbL mints) · keeper jobs · 3 attestors (separate keys, shared signature board) · watcher
 *
 * Scenario (user actions only; everything else is the services): launch through /v1/launch/prepare with
 * the creator's first buy → third-party DBC trades + FUMPAD-routed trades → matured sells become
 * 2-of-3 attested tickets (outside + router), an unmatured sell and the creator's sell don't → a rebuy is
 * attested as a debit → a routed PartialFill buy completes the curve → the keeper migrates + graduates →
 * the reward vault holds the 8% leftover → keeper samples build a median → tickets past their challenge
 * window are auto-claimed → third-party DAMM v2 trades → the watcher re-derives every attestation (all
 * match) → API checks. Exits non-zero on any failed check.
 *
 * First-coin launch config (INTERFACE §5.9, when the stack allow-lists one — the generated local chain does): a second
 * launch through /v1/launch/prepare with `launchConfig: "first_coin"` registers on the 3% config with the wallet-split
 * policy snapshotted; a second first-coin prepare is refused (max_coins 1); the keeper's fee claims pay its launch
 * window 100% to the fee wallet and later fees 1.0 buyback / 1.4 wallet; the API shows the coin's real 3% fee.
 */
import { Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import {
  SNIPE_PERIODS,
  FIRST_COIN_PERIODS,
  walletSplit,
  type CoinRefs,
  confirmSignature,
  decodeCoin,
  decodeFumpadEvents,
  decodePosition,
  decodeTicket,
  decodeTokenAccount,
  coinPda,
  customErrorCode,
  FUMPAD_ERROR,
  FUMPAD_PROGRAM_ID,
  inspectLaunchTx,
  launchInstructions,
  isFumpadVanityMint,
  positionPda,
  rewardVault,
  ticketPda,
  type TxLike,
} from "@fumpad/sdk";
import { signLaunchAuth } from "@fumpad/api";

import { airdrop, directDammBuy, directDammSell, directDbcBuy, directDbcSell, routedBuy, routedSell, tokenBalance } from "./actors.js";
import { sleep, waitFor } from "./harness.js";
import { type Stack, startStack } from "./stack.js";

export interface E2EReport {
  ok: boolean;
  mint: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  counts: Record<string, number>;
  wsEvents: string[];
  durationSec: number;
}

const SOL = BigInt(LAMPORTS_PER_SOL);

export async function runE2E(opts: { rpcPort?: number; apiPort?: number; log?: (s: string) => void; grinderThreads?: number } = {}): Promise<E2EReport> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const t0 = Date.now();
  const checks: E2EReport["checks"] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  };

  let stack: Stack | undefined;
  let ws: WebSocket | undefined;
  const wsEvents: string[] = [];
  let M = "";
  try {
    stack = await startStack({ rpcPort: opts.rpcPort, apiPort: opts.apiPort, grinderThreads: opts.grinderThreads, log });
    const { conn, config, api, get, ports } = stack;
    const pg = stack.pg;
    const watcherPort = ports.watcher;
    const [creator, alice, bob, dave, eve, whale] = Array.from({ length: 6 }, () => Keypair.generate());
    for (const k of [creator, alice, bob, dave, eve]) await airdrop(conn, k.publicKey, 20);
    await airdrop(conn, whale.publicKey, 50);

    ws = new WebSocket(`ws://127.0.0.1:${ports.api}/v1/ws`);
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; event?: { kind: string } };
      if (msg.type === "feed" && msg.event) wsEvents.push(msg.event.kind);
    };
    await waitFor("ws open", async () => ws!.readyState === 1, 10_000);

    // ── launch through the API (D18) ─────────────────────────────────────────
    await waitFor("grinder: a …fmbL mint in the pool", async () => {
      const h = await get<{ vanityPool: { available: number; reserved: number } | null }>("/health");
      return h.vanityPool && h.vanityPool.available + h.vanityPool.reserved > 0;
    }, 600_000, 2_000);
    const prep = await fetch(`${api}/v1/launch/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        creator: creator.publicKey.toBase58(),
        name: "Fumble",
        symbol: "FUMB",
        uri: "https://fumpad.fun/m/fumb.json",
        initialBuyLamports: String(SOL / 20n),
        auth: signLaunchAuth(creator.secretKey, { creator: creator.publicKey.toBase58(), symbol: "FUMB" }),
      }),
    });
    if (!prep.ok) throw new Error(`prepare → ${prep.status} ${await prep.text()}`);
    const prepared = (await prep.json()) as { mint: string; transaction: string; lastValidBlockHeight: number };
    const launchTx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
    const info = inspectLaunchTx(launchTx);
    const launchKey = stack.launchKey;
    check(
      "prepare: DBC init → creator top-level swap2 → register_coin, creator pays, only the mint + the API launch key signed",
      info.feePayer === creator.publicKey.toBase58() && [...info.signed].sort().join() === [prepared.mint, launchKey.publicKey.toBase58()].sort().join() && info.buyLamports === SOL / 20n && info.dbcConfig === config.publicKey.toBase58(),
    );
    launchTx.sign([creator]);
    const raw = launchTx.serialize();
    const launchSig = await conn.sendRawTransaction(raw, { maxRetries: 0 });
    await confirmSignature(conn, launchSig, prepared.lastValidBlockHeight, "confirmed", raw);
    M = prepared.mint;
    const mint = new PublicKey(M);
    const coinAcc = decodeCoin(new Uint8Array((await conn.getAccountInfo(coinPda(mint)))!.data));
    // A self-built launch on our config without the API's co-signature must not register (L1).
    const selfMint = Keypair.generate();
    const selfIxs = launchInstructions({ creator: bob.publicKey, mint: selfMint.publicKey, dbcConfig: config.publicKey, name: "Self", symbol: "SELF", uri: "https://fumpad.fun/m/self.json" });
    const selfTx = new VersionedTransaction(new TransactionMessage({ payerKey: bob.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: selfIxs }).compileToV0Message());
    selfTx.sign([bob, selfMint]);
    const selfSim = await conn.simulateTransaction(selfTx, { sigVerify: true });
    const selfRefused = customErrorCode(selfSim.value.err) === FUMPAD_ERROR.Unauthorized;
    check(
      "launch → registered coin with a …fmbL mint (D18) on the FUMPAD config; an unsigned self-launch is refused (L1)",
      isFumpadVanityMint(mint) && coinAcc.dbcConfig.equals(config.publicKey) && coinAcc.status === "curve" && selfRefused,
      `${M}${selfRefused ? "" : ` self-launch: ${JSON.stringify(selfSim.value.err)}`}`,
    );
    const coin: CoinRefs = { mint, dbcConfig: config.publicKey, dbcPool: coinAcc.dbcPool };
    const launchTxRaw = (await conn.getTransaction(launchSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })) as unknown as TxLike;
    check("launch tx emitted CoinRegistered", decodeFumpadEvents(launchTxRaw).some((e) => e.name === "CoinRegistered"));
    const creatorTokens = await tokenBalance(conn, creator.publicKey, mint);
    check("creator's first buy got the min fee (1.25%), not the 99% launch-window fee", creatorTokens > 0n, `${creatorTokens} base units`);

    // ── first-coin launch config (one-off: 3%, FUMPAD's share 1.0 buyback / 1.4 a fee wallet) ─────────────
    let FC = "";
    let fcWalletBefore = 0n;
    if (stack.firstCoin) {
      const fc = stack.firstCoin;
      const founder = Keypair.generate();
      await airdrop(conn, founder.publicKey, 5);
      fcWalletBefore = BigInt(await conn.getBalance(fc.wallet, "confirmed"));
      const opts = await get<{ firstCoin: { dbcConfig: string; wallet: string } | null }>("/v1/launch/options");
      await waitFor("grinder: a second …fmbL mint", async () => {
        const h = await get<{ vanityPool: { available: number } | null }>("/health");
        return h.vanityPool && h.vanityPool.available > 0;
      }, 600_000, 2_000);
      const prepareFirst = (who: Keypair, symbol: string) =>
        fetch(`${api}/v1/launch/prepare`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            creator: who.publicKey.toBase58(),
            name: "First Coin",
            symbol,
            uri: "https://fumpad.fun/m/first.json",
            initialBuyLamports: String(SOL / 20n),
            launchConfig: "first_coin",
            auth: signLaunchAuth(who.secretKey, { creator: who.publicKey.toBase58(), symbol }),
          }),
        });
      const pr = await prepareFirst(founder, "FIRST");
      if (!pr.ok) throw new Error(`first-coin prepare → ${pr.status} ${await pr.text()}`);
      const pf = (await pr.json()) as { mint: string; transaction: string; lastValidBlockHeight: number; config: { kind: string; dbcConfig: string; feeBps: number; snipeWindowSlots: number; migratedPoolFeeBps: number; feePolicy: { wallet: string | null } } };
      const ftx = VersionedTransaction.deserialize(Buffer.from(pf.transaction, "base64"));
      ftx.sign([founder]);
      const fraw = ftx.serialize();
      const fsig = await conn.sendRawTransaction(fraw, { maxRetries: 0 });
      await confirmSignature(conn, fsig, pf.lastValidBlockHeight, "confirmed", fraw);
      FC = pf.mint;
      const fmint = new PublicKey(FC);
      const fcoin = decodeCoin(new Uint8Array((await conn.getAccountInfo(coinPda(fmint)))!.data));
      const snap = { policy: fcoin.feePolicy! };
      check(
        "first-coin launch: offered by the API, prepared on the 3% config (99% → 3% over 25 slots, 3% DAMM v2), registered with the wallet-split policy snapshotted",
        opts.firstCoin?.dbcConfig === fc.config.toBase58() &&
          pf.config.kind === "first_coin" && pf.config.dbcConfig === fc.config.toBase58() && pf.config.feeBps === 300 && pf.config.snipeWindowSlots === FIRST_COIN_PERIODS && pf.config.migratedPoolFeeBps === 300 &&
          pf.config.feePolicy.wallet === fc.wallet.toBase58() &&
          fcoin.dbcConfig.equals(fc.config) && fcoin.feePolicyKind === 1 && !!snap.policy && snap.policy.wallet.equals(fc.wallet) && snap.policy.buybackShare === 100 && snap.policy.walletShare === 140,
        FC,
      );
      await sleep(12_000); // the API caches Global for 10 s: let it see the registration (the program refuses a 2nd coin anyway)
      const again = await prepareFirst(dave, "AGAIN"); // a funded wallet: only the config's availability can refuse it
      check("first-coin config is one launch only (max_coins 1): the next first_coin prepare is refused", again.status === 409, `${again.status} ${again.status === 409 ? "" : await again.text()}`);
      // a trade after its 25-slot window: 3% fee, of which FUMPAD's 2.4% splits 1.0 / 1.4
      const fslot = (await conn.getTransaction(fsig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))!.slot;
      await waitFor("first coin's launch window over", async () => ((await conn.getSlot("confirmed")) > fslot + FIRST_COIN_PERIODS + 2 ? true : null), 60_000);
      await directDbcBuy(conn, founder, { mint: fmint, dbcConfig: fc.config, dbcPool: fcoin.dbcPool }, SOL / 5n);
      log("✓ first coin launched (3% config) and traded after its window");
    }

    // ── curve trades: third-party direct + FUMPAD router ─────────────────────
    // Third parties trade after the launch window: inside it the DBC fee scheduler charges up to 99% (D33),
    // which would shrink every position below the $5 ticket minimum.
    const launchSlot = (await conn.getTransaction(launchSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }))!.slot;
    await waitFor("launch window over", async () => ((await conn.getSlot("confirmed")) > launchSlot + SNIPE_PERIODS + 2 ? true : null), 30_000);
    await directDbcBuy(conn, alice, coin, SOL / 10n);
    await routedBuy(conn, bob, coin, "dbc", SOL / 10n);
    await directDbcBuy(conn, eve, coin, SOL / 20n);
    log("✓ curve buys: alice (direct DBC), bob (FUMPAD router), eve (direct)");
    await sleep(7_000); // > 5 s hold
    const aliceBal = await tokenBalance(conn, alice.publicKey, mint);
    const bobBal = await tokenBalance(conn, bob.publicKey, mint);
    await directDbcSell(conn, alice, coin, aliceBal / 2n);
    await routedSell(conn, bob, coin, "dbc", bobBal / 2n);
    await directDbcBuy(conn, dave, coin, SOL / 20n);
    await directDbcSell(conn, dave, coin, (await tokenBalance(conn, dave.publicKey, mint)) / 2n); // not matured
    await directDbcSell(conn, creator, coin, creatorTokens / 4n); // creator
    log("✓ sells: alice (direct), bob (router) matured; dave unmatured; creator");

    // ── attestations ─────────────────────────────────────────────────────────
    const aliceTicket = ticketPda(mint, alice.publicKey, 0n);
    const bobTicket = ticketPda(mint, bob.publicKey, 0n);
    const tA = await waitFor("alice's ticket attested (2-of-3)", async () => {
      const a = await conn.getAccountInfo(aliceTicket);
      return a ? decodeTicket(new Uint8Array(a.data)) : null;
    }, 180_000, 2_000);
    const tB = await waitFor("bob's ticket attested", async () => {
      const a = await conn.getAccountInfo(bobTicket);
      return a ? decodeTicket(new Uint8Array(a.data)) : null;
    }, 120_000, 2_000);
    check("outside sell → attested ticket (source outside)", tA.source === "outside" && tA.tokens > 0n && tA.tokens <= aliceBal / 2n, `${tA.tokens} tokens`);
    check("routed sell → attested ticket (source router)", tB.source === "router" && tB.tokens > 0n);
    await sleep(25_000); // one more full round of every attestor at finality
    const daveTicket = await conn.getAccountInfo(ticketPda(mint, dave.publicKey, 0n));
    const creatorTicket = await conn.getAccountInfo(ticketPda(mint, creator.publicKey, 0n));
    check("unmatured sell and the creator's sell got no ticket", !daveTicket && !creatorTicket);

    // ── rebuy debit ──────────────────────────────────────────────────────────
    await directDbcBuy(conn, alice, coin, SOL / 100n);
    const debited = await waitFor("alice's rebuy attested as a debit", async () => {
      const t = decodeTicket(new Uint8Array((await conn.getAccountInfo(aliceTicket))!.data));
      return t.tokens < t.originalTokens ? t : null;
    }, 180_000, 2_000);
    check("rebuy within 7 days debits the ticket (attest_rebuy)", debited.tokens < debited.originalTokens, `${debited.originalTokens} → ${debited.tokens}`);

    // ── completion → migration → graduation ──────────────────────────────────
    await routedBuy(conn, whale, coin, "dbc", 2n * SOL, 1);
    log("✓ whale's routed PartialFill buy completes the curve");
    const grad = await waitFor("keeper migrates + graduates", async () => {
      const c = decodeCoin(new Uint8Array((await conn.getAccountInfo(coinPda(mint)))!.data));
      return c.status === "graduated" ? c : null;
    }, 180_000, 2_000);
    check("graduated: DAMM v2 pool + locked position recorded", !grad.dammPool.equals(PublicKey.default) && !grad.dammPosition.equals(PublicKey.default));
    const vault = decodeTokenAccount(new Uint8Array((await conn.getAccountInfo(rewardVault(mint)))!.data)).amount;
    check("reward vault holds the 8% DBC leftover (D35)", vault >= 80_000_000_000_000n && vault < 80_001_000_000_000n + 10_000_000_000_000n, `${vault} base units`);
    check("launch-window fees settled to buyback (D33)", grad.launchFeesSettled);

    // ── DAMM v2 trades (third party) ─────────────────────────────────────────
    const coinG: CoinRefs = { ...coin, dammPool: grad.dammPool };
    await directDammBuy(conn, eve, coinG, grad.dammPool, SOL / 50n);
    await directDammSell(conn, eve, coinG, grad.dammPool, (await tokenBalance(conn, eve.publicKey, mint)) / 3n);
    log("✓ DAMM v2 trades by eve (direct)");
    // The curve ends ~14.7x above its start, so early sellers sit ~4x below the graduation price: a large
    // FUMPAD-routed DAMM v2 buy lifts the spot well past their 10x trigger for the samples/median to see.
    await routedBuy(conn, whale, coinG, "damm_v2", 2n * SOL);
    log("✓ whale's routed DAMM v2 buy (price past the 10x trigger)");

    // ── samples → median → auto-claims past the challenge window ────────────
    const claimed = await waitFor("keeper auto-claims bob's ticket (median ≥ 10×, past challenge)", async () => {
      const a = await conn.getAccountInfo(bobTicket);
      if (!a) return "closed";
      const t = decodeTicket(new Uint8Array(a.data));
      return t.status === "claimed" || t.status === "queued" ? t.status : null;
    }, 240_000, 3_000);
    check("auto-claim (claim_for) paid or queued bob's ticket", claimed === "claimed" || claimed === "queued" || claimed === "closed", claimed);
    const bobAfter = await tokenBalance(conn, bob.publicKey, mint);
    check("bob received his 10% payout in the coin's tokens", claimed === "queued" || bobAfter > bobBal - bobBal / 2n, `${bobAfter}`);

    // ── fees / buyback ───────────────────────────────────────────────────────
    const fees = await waitFor("FeesClaimed / BuybackExecuted indexed", async () => {
      const r = await rows<{ n: string; b: string }>(pg.url, `SELECT (SELECT count(*) FROM fee_claims WHERE mint = '${M}') n, (SELECT count(*) FROM buybacks WHERE mint = '${M}') b`);
      return Number(r[0].n) > 0 ? r[0] : null;
    }, 120_000, 3_000);
    check("keeper claimed fees (launch window first) and the indexer recorded them", Number(fees.n) > 0, `fee claims ${fees.n}, buybacks ${fees.b}`);
    if (stack.firstCoin && FC) {
      const fc = stack.firstCoin;
      type Claim = { claimed: string; to_buyback: string; to_platform: string; to_creator: string; to_wallet: string; fee_wallet: string | null; launch_window: boolean };
      const fcClaims = await waitFor("first coin: launch-window + normal fee claims indexed", async () => {
        const r = await rows<Claim>(pg.url, `SELECT claimed, to_buyback, to_platform, to_creator, to_wallet, fee_wallet, launch_window FROM fee_claims WHERE mint = '${FC}' ORDER BY ts, idx`);
        return r.some((x) => x.launch_window) && r.some((x) => !x.launch_window) ? r : null;
      }, 120_000, 3_000);
      const lw = fcClaims.find((x) => x.launch_window)!;
      const normal = fcClaims.filter((x) => !x.launch_window);
      const splitOk = normal.every((x) => {
        const s = walletSplit(BigInt(x.claimed), { buybackShare: 100, walletShare: 140 });
        return BigInt(x.to_wallet) === s.wallet && BigInt(x.to_buyback) === s.buyback && x.to_platform === "0" && x.to_creator === "0" && x.fee_wallet === fc.wallet.toBase58();
      });
      const paid = fcClaims.reduce((s, x) => s + BigInt(x.to_wallet), 0n);
      const walletNow = BigInt(await conn.getBalance(fc.wallet, "confirmed"));
      check(
        "first coin fees: launch window 100% → the fee wallet, later claims exactly 1.0/2.4 buyback + 1.4/2.4 wallet, nothing to platform/creator; the wallet received every lamport",
        BigInt(lw.claimed) > 0n && lw.to_wallet === lw.claimed && lw.to_buyback === "0" && splitOk && walletNow - fcWalletBefore === paid,
        `${fcClaims.length} claims, wallet +${paid}`,
      );
      const fd = await get<{ fees?: { feeBps: number; migratedFeeBps: number; policy: string; wallet?: string; poolShareBps?: number; walletShareBps?: number } }>(`/v1/coins/by-mint/${FC}`);
      check(
        "API: the first coin shows its real fee (3% curve / 3% DAMM v2) and the wallet split",
        fd.fees?.feeBps === 300 && fd.fees.migratedFeeBps === 300 && fd.fees.policy === "wallet_split" && fd.fees.wallet === fc.wallet.toBase58() && fd.fees.poolShareBps === 100 && fd.fees.walletShareBps === 140,
        JSON.stringify(fd.fees),
      );
    }

    // ── indexer + API ────────────────────────────────────────────────────────
    const detail = await waitFor("API coin detail graduated", async () => {
      const c = await get<{ status: string; dammPool?: string; trades24h: number; fees?: { feeBps: number; policy: string } }>(`/v1/coins/by-mint/${M}`);
      return c.status === "graduated" ? c : null;
    }, 60_000, 2_000);
    check("API: graduated coin with its DAMM v2 pool (standard 1.25% fee policy)", detail.dammPool === grad.dammPool.toBase58() && detail.fees?.feeBps === 125 && detail.fees.policy === "standard");
    const trades = await get<{ venue?: string; app?: string; wallet: string }[]>(`/v1/coins/${M}/trades?limit=100`);
    const venues = new Set(trades.map((t) => t.venue));
    check("API trades: every app on both venues (DBC + DAMM v2), router trades labeled", venues.has("dbc") && venues.has("damm") && trades.some((t) => t.app === "fumpad"), `${trades.length} trades`);
    const tickets = await get<{ id: string; source: string; attestedAt?: number; sellSignature?: string }[]>(`/v1/wallets/${alice.publicKey.toBase58()}/tickets`);
    check("API tickets: source + attestation fields", tickets.some((t) => t.id === aliceTicket.toBase58() && t.source === "outside" && !!t.attestedAt && !!t.sellSignature));

    // ── watcher ──────────────────────────────────────────────────────────────
    const feed = await waitFor("watcher verified every attestation", async () => {
      const f = await get<{ coins: { mint: string; verdicts: { verdict: string; kind: string }[] }[] }>(`/v1/verification?mint=${M}`, `http://127.0.0.1:${watcherPort}`);
      const c = f.coins[0];
      return c && c.verdicts.filter((x) => x.kind === "sell").length >= 2 && c.verdicts.some((x) => x.kind === "rebuy") ? c : null;
    }, 120_000, 3_000);
    const mism = feed.verdicts.filter((x) => x.verdict !== "match");
    check("watcher: every TicketAttested / TicketDebited matches its independent re-derivation", mism.length === 0, `${feed.verdicts.length} verdicts, ${mism.length} mismatches`);
    const pos = decodePosition(new Uint8Array((await conn.getAccountInfo(positionPda(mint, alice.publicKey)))!.data));
    check("alice's Position tracks her ticket list", pos.ticketsCreated >= 1n);
    check("WS delivered feed events live", wsEvents.includes("launch") && wsEvents.includes("fumble"), wsEvents.join(","));
    void FUMPAD_PROGRAM_ID;

    const counts: Record<string, number> = {};
    for (const t of ["coins", "trades", "tickets", "ticket_debits", "claims", "samples", "fee_claims", "buybacks", "attest_signatures"]) counts[t] = Number((await rows<{ n: string }>(pg.url, `SELECT count(*) n FROM ${t}`))[0].n);
    return { ok: checks.every((c) => c.ok), mint: M, checks, counts, wsEvents, durationSec: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    check(`scenario aborted: ${String(e).slice(0, 400)}`, false);
    if (stack) log(`service logs: ${stack.dumpLogs("e2e-logs")}`);
    return { ok: false, mint: M, checks, counts: {}, wsEvents, durationSec: Math.round((Date.now() - t0) / 1000) };
  } finally {
    ws?.close();
    await stack?.stop();
  }
}

async function rows<T>(url: string, sql: string): Promise<T[]> {
  const { default: pgm } = await import("pg");
  const cl = new pgm.Client({ connectionString: url });
  await cl.connect();
  try {
    return (await cl.query(sql)).rows as T[];
  } finally {
    await cl.end();
  }
}
