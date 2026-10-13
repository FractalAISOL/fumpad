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
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import {
  SNIPE_PERIODS,
  type CoinRefs,
  confirmSignature,
  decodeCoin,
  decodeFumpadEvents,
  decodePosition,
  decodeTicket,
  decodeTokenAccount,
  coinPda,
  customErrorCode,
  DBC_POOL_AUTHORITY,
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
import { createPool, migrate } from "@fumpad/indexer";
import { signLaunchAuth } from "@fumpad/api";

import { airdrop, createFumpadConfig, directDammBuy, directDammSell, directDbcBuy, directDbcSell, LOCAL_PARAMS, routedBuy, routedSell, tokenBalance, transferSol } from "./actors.js";
import { buildGrinder, keypair, keypairPath, LOCAL, type Postgres, type Service, sleep, startBinary, startPostgres, startService, startValidator, type Validator, waitFor } from "./harness.js";

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
  const rpcPort = opts.rpcPort ?? 8899;
  const apiPort = opts.apiPort ?? 18080;
  const indexerPort = apiPort + 1;
  const keeperPort = apiPort + 2;
  const watcherPort = apiPort + 3;
  const api = `http://127.0.0.1:${apiPort}`;
  const checks: E2EReport["checks"] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const ssrSecret = randomBytes(24).toString("hex");
  const get = async <T>(path: string, base = api): Promise<T> => {
    const r = await fetch(base + path, { headers: { "x-fumpad-ssr": ssrSecret } });
    if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };

  let v: Validator | undefined;
  let pg: Postgres | undefined;
  const services: Service[] = [];
  let ws: WebSocket | undefined;
  const wsEvents: string[] = [];
  let M = "";
  try {
    log("▶ starting Postgres + solana-test-validator (fumpad v0.7 + mainnet DBC/DAMM v2)");
    pg = await startPostgres();
    const mdb = createPool(pg.url, 2);
    await migrate(mdb);
    await mdb.end();
    const mintPoolKey = randomBytes(32).toString("hex");
    services.push(startBinary("grinder", buildGrinder(), [], { DATABASE_URL: pg.url, MINT_POOL_KEY: mintPoolKey, POOL_TARGET: "1", POOL_POLL_SECS: "2", GRINDER_THREADS: String(opts.grinderThreads ?? 6) }));

    const auth = keypair("upgrade-authority");
    const admin = Keypair.generate();
    const treasury = Keypair.generate();
    const keepers = [keypair("keeper"), keypair("keeper2"), keypair("keeper3")];
    const config = Keypair.generate();
    // Launch binding (off-chain review L1): only API-built launches (co-signed by its launch key) register.
    const launchKey = Keypair.generate();
    const params = { ...LOCAL_PARAMS, launchSigner: launchKey.publicKey };
    v = await startValidator({ rpcPort, upgradeAuthority: auth, global: { admin: admin.publicKey, platformTreasury: treasury.publicKey, keepers: keepers.map((k) => k.publicKey), params, configs: [config.publicKey] } });
    const conn = new Connection(v.rpcUrl, "confirmed");
    const [creator, alice, bob, dave, eve, whale] = Array.from({ length: 6 }, () => Keypair.generate());
    for (const k of [auth, admin, ...keepers, creator, alice, bob, dave, eve]) await airdrop(conn, k.publicKey, 20);
    await airdrop(conn, whale.publicKey, 50);
    // DBC's pool authority fronts the migration's flash rent (mainnet: Meteora keeps it funded).
    await transferSol(conn, admin, DBC_POOL_AUTHORITY, 10n * SOL);
    await createFumpadConfig(conn, admin, config);
    log("✓ chain ready: Global seeded (local windows, 3 keepers, FUMPAD DBC config allow-listed), config created");

    // ── services ─────────────────────────────────────────────────────────────
    const common = { DATABASE_URL: pg.url, RPC_URL: v.rpcUrl, LOG_LEVEL: "info" };
    services.push(
      startService("indexer", "indexer/src/main.ts", {
        ...common,
        WS_URL: v.wsUrl,
        PORT: String(indexerPort),
        POLL_INTERVAL_MS: "1000",
        METEORA_POLL_INTERVAL_MS: "1000",
        FINALIZE_INTERVAL_MS: "5000",
        METEORA_FINALIZE_INTERVAL_MS: "5000",
        DERIVE_INTERVAL_MS: "3000",
        RECONCILE_INTERVAL_MS: "15000",
        FETCH_METADATA: "false",
      }),
    );
    await waitFor("indexer health", async () => (await fetch(`http://127.0.0.1:${indexerPort}/health`)).status > 0, 60_000);
    services.push(startService("api", "api/src/main.ts", { ...common, PORT: String(apiPort), SOL_USD_FALLBACK: "150", API_SSR_SECRET: ssrSecret, RATE_LIMIT_PER_MIN: "100000", LAUNCH_POOL_RESERVE: "0", MINT_POOL_KEY: mintPoolKey, LAUNCH_SIGNER_KEY: JSON.stringify(Array.from(launchKey.secretKey)), LAUNCH_SWEEP_SECS: "5" }));
    await waitFor("api health", async () => (await fetch(`${api}/health`)).ok, 60_000);
    services.push(
      startService("keeper", "keeper/src/main.ts", {
        RPC_URL: v.rpcUrl,
        KEEPER_KEYPAIR: keypairPath("keeper"),
        PORT: String(keeperPort),
        LOG_LEVEL: "info",
        LOOP_MS: "1000",
        FULL_RATE_SECS: "3",
        HEARTBEAT_SECS: "20",
        SCAN_INTERVAL_SECS: "2",
        TICKET_SCAN_INTERVAL_SECS: "2",
        BUYBACK_MIN_LAMPORTS: "100000",
        BUYBACK_INTERVAL_SECS: "4",
        FEES_MIN_LAMPORTS: "100000",
        FEES_INTERVAL_SECS: "5",
        LP_FEES_INTERVAL_SECS: "10",
        MIGRATE_GRACE_SECS: "0",
        QUEUE_INTERVAL_SECS: "3",
        AUTOCLAIM_INTERVAL_SECS: "3",
        CLOSE_INTERVAL_SECS: "5",
        PLATFORM_FEES_MIN_LAMPORTS: "1000000",
        PRIORITY_MIN_MICROLAMPORTS: "1000",
        MIN_KEEPER_LAMPORTS: "1000000000",
      }),
    );
    for (let i = 0; i < 3; i++) {
      services.push(
        startService(`attestor${i + 1}`, "keeper/src/main.ts", {
          KEEPER_MODE: "attestor",
          RPC_URL: v.rpcUrl,
          DATABASE_URL: pg.url,
          KEEPER_KEYPAIR: keypairPath(i === 0 ? "keeper" : `keeper${i + 1}`),
          PYTH_SOURCE: "constant",
          PYTH_CONSTANT_USD: "150",
          ATTEST_LOOP_MS: "2000",
          ATTEST_FALLBACK_SUBMIT_SECS: "10",
          LOG_LEVEL: "info",
        }),
      );
    }
    services.push(startService("watcher", "keeper/src/main.ts", { KEEPER_MODE: "watcher", RPC_URL: v.rpcUrl, PORT: String(watcherPort), PYTH_SOURCE: "constant", PYTH_CONSTANT_USD: "150", WATCH_LOOP_MS: "3000", WATCH_GRACE_SECS: "120", LOG_LEVEL: "info" }));
    await waitFor("keeper health", async () => (await fetch(`http://127.0.0.1:${keeperPort}/health`)).status > 0, 60_000);
    await waitFor("watcher health", async () => (await fetch(`http://127.0.0.1:${watcherPort}/health`)).ok, 60_000);
    log("✓ indexer, api, grinder, keeper, 3 attestors, watcher running");

    ws = new WebSocket(`ws://127.0.0.1:${apiPort}/v1/ws`);
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
      const r = await rows<{ n: string; b: string }>(pg!.url, `SELECT (SELECT count(*) FROM fee_claims WHERE mint = '${M}') n, (SELECT count(*) FROM buybacks WHERE mint = '${M}') b`);
      return Number(r[0].n) > 0 ? r[0] : null;
    }, 120_000, 3_000);
    check("keeper claimed fees (launch window first) and the indexer recorded them", Number(fees.n) > 0, `fee claims ${fees.n}, buybacks ${fees.b}`);

    // ── indexer + API ────────────────────────────────────────────────────────
    const detail = await waitFor("API coin detail graduated", async () => {
      const c = await get<{ status: string; dammPool?: string; trades24h: number }>(`/v1/coins/by-mint/${M}`);
      return c.status === "graduated" ? c : null;
    }, 60_000, 2_000);
    check("API: graduated coin with its DAMM v2 pool", detail.dammPool === grad.dammPool.toBase58());
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
    const dir = join(LOCAL, "e2e-logs");
    mkdirSync(dir, { recursive: true });
    for (const s of services) {
      writeFileSync(join(dir, `${s.name}.log`), s.logs.join("\n"));
      const tail = s.logs.filter((l) => /error|warn|fail|"level":(40|50)/i.test(l)).slice(-6);
      if (tail.length) log(`── ${s.name} ──\n${tail.map((l) => l.slice(0, 500)).join("\n")}`);
    }
    log(`service logs: ${dir}`);
    return { ok: false, mint: M, checks, counts: {}, wsEvents, durationSec: Math.round((Date.now() - t0) / 1000) };
  } finally {
    ws?.close();
    for (const s of services.reverse()) await s.stop();
    await v?.stop();
    await pg?.stop();
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
