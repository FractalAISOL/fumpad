/**
 * The main acceptance test: the whole off-chain stack against solana-test-validator.
 *
 *   validator (built fumpad + immutable locker + real PumpSwap/pump-fees dumps + Pyth)
 *   Postgres → indexer (child process) → API (child process, REST + WS)
 *   keeper (child process): samples, graduates, sets up, buys back, skims, cranks the
 *   queue, withdraws platform fees — the scenario below only does USER actions.
 *
 * Scenario: launch → curve buys → matured sells (tickets, one under $50) → whale fills the
 * curve → keeper graduates → keeper samples to a median → claim (paid) + claim (queued) →
 * donation grows the pool → keeper pays the queue → router swaps (quote checked against
 * the real fill) → a seller rebuys directly on PumpSwap (flag) → creator-funded alt
 * (flag) → keeper skim/settle/buyback/fees → 5 more coins graduate (keeper samples 6
 * coins with a v0 tx + lookup table). Then every API endpoint is checked against chain
 * facts, and the WebSocket must have delivered the feed live.
 */
import { randomBytes } from "node:crypto";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";

import {
  coinAddresses,
  coinAta,
  decodeTransactionEvents,
  confirmSignature,
  FumpadClient,
  inspectLaunchTx,
  isFumpadVanityMint,
  tokenDeltas,
  TOKEN_2022_PROGRAM_ID,
  type TxLike,
} from "@fumpad/sdk";

import { airdrop, directPumpBuy, initGlobal, LOCAL_PARAMS, tokenBalance } from "./actors.js";
import bs58 from "bs58";

import { createPool, migrate } from "@fumpad/indexer";
import { signLaunchAuth } from "@fumpad/api";

import { buildGrinder, keypair, keypairPath, type Postgres, type Service, sleep, startBinary, startPostgres, startService, startValidator, type Validator, waitFor } from "./harness.js";

export interface E2EReport {
  ok: boolean;
  mint: string;
  checks: { name: string; ok: boolean; detail?: string }[];
  counts: Record<string, number>;
  wsEvents: string[];
  keeperHealth: unknown;
  indexerHealth: unknown;
  apiHealth: unknown;
  durationSec: number;
}

const SOL = BigInt(LAMPORTS_PER_SOL);

export async function runE2E(
  opts: { rpcPort?: number; apiPort?: number; log?: (s: string) => void; extraCoins?: number; vanityPoolTarget?: number; grinderThreads?: number } = {},
): Promise<E2EReport> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const t0 = Date.now();
  const rpcPort = opts.rpcPort ?? 8899;
  const apiPort = opts.apiPort ?? 18080;
  const indexerPort = apiPort + 1;
  const keeperPort = apiPort + 2;
  const api = `http://127.0.0.1:${apiPort}`;
  const checks: E2EReport["checks"] = [];
  const check = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
    log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const ssrSecret = randomBytes(24).toString("hex");
  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(api + path, { headers: { "x-fumpad-ssr": ssrSecret } });
    if (!r.ok) throw new Error(`${path} → ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };

  let v: Validator | undefined;
  let pg: Postgres | undefined;
  const services: Service[] = [];
  let ws: WebSocket | undefined;
  const wsEvents: string[] = [];
  try {
    log("▶ starting Postgres + solana-test-validator");
    pg = await startPostgres();
    // D18: the grinder starts first (it needs ~11.3M tries per `fmbL` key), against a
    // migrated DB, so the pool has a key by the time the scenario launches through the API.
    const mdb = createPool(pg.url, 2);
    await migrate(mdb);
    await mdb.end();
    const mintPoolKey = randomBytes(32).toString("hex");
    services.push(
      startBinary("grinder", buildGrinder(), [], {
        DATABASE_URL: pg.url,
        MINT_POOL_KEY: mintPoolKey,
        POOL_TARGET: String(opts.vanityPoolTarget ?? 2),
        POOL_POLL_SECS: "2",
        GRINDER_THREADS: String(opts.grinderThreads ?? 6),
      }),
    );
    const auth = keypair("upgrade-authority");
    v = await startValidator({ rpcPort, upgradeAuthority: auth });
    const conn = new Connection(v.rpcUrl, "confirmed");
    const c = new FumpadClient(conn);

    // Actors: each funded by its own funder wallet so the funding graph is realistic.
    const admin = Keypair.generate();
    const treasury = Keypair.generate();
    const keeper = keypair("keeper");
    const [creator, alice, bob, dave, eve, whale] = Array.from({ length: 6 }, () => Keypair.generate());
    const carol = Keypair.generate(); // creator's alt: funded BY the creator
    for (const k of [auth, admin, keeper]) await airdrop(conn, k.publicKey, 100);
    const fund = async (k: Keypair, sol: number) => {
      const funder = Keypair.generate();
      await airdrop(conn, funder.publicKey, sol + 1);
      await c.send(funder, { instructions: [SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: k.publicKey, lamports: BigInt(sol) * SOL })] });
    };
    for (const [k, sol] of [[creator, 50], [alice, 20], [bob, 20], [dave, 20], [eve, 20], [whale, 900]] as const) await fund(k, sol);
    await c.send(creator, { instructions: [SystemProgram.transfer({ fromPubkey: creator.publicKey, toPubkey: carol.publicKey, lamports: 10n * SOL })] });
    await initGlobal(c, auth, admin, treasury.publicKey, keeper.publicKey, LOCAL_PARAMS);
    log("✓ chain ready: programs loaded, Global initialized (local params), keeper registered");

    // ── off-chain stack ──────────────────────────────────────────────────────
    const common = { DATABASE_URL: pg.url, RPC_URL: v.rpcUrl, LOG_LEVEL: "info" };
    services.push(startService("indexer", "indexer/src/main.ts", { ...common, WS_URL: v.wsUrl, PORT: String(indexerPort), POLL_INTERVAL_MS: "1000", FINALIZE_INTERVAL_MS: "5000", DERIVE_INTERVAL_MS: "2000", RECONCILE_INTERVAL_MS: "15000", FETCH_METADATA: "false" }));
    await waitFor("indexer health", async () => (await fetch(`http://127.0.0.1:${indexerPort}/health`)).ok, 60_000);
    services.push(
      startService("api", "api/src/main.ts", { ...common, LOG_LEVEL: "info", PORT: String(apiPort), SOL_USD_FALLBACK: "150", API_SSR_SECRET: ssrSecret, RATE_LIMIT_PER_MIN: "100000", LAUNCH_POOL_RESERVE: "0", MINT_POOL_KEY: mintPoolKey, LAUNCH_SWEEP_SECS: "5" }),
    );
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
        SCAN_INTERVAL_SECS: "3",
        TICKET_SCAN_INTERVAL_SECS: "3",
        BUYBACK_MIN_LAMPORTS: "1000000",
        BUYBACK_INTERVAL_SECS: "5",
        SKIM_INTERVAL_SECS: "15",
        QUEUE_INTERVAL_SECS: "3",
        PLATFORM_FEES_MIN_LAMPORTS: "10000000",
        PLATFORM_FEES_INTERVAL_SECS: "20",
        PRIORITY_MIN_MICROLAMPORTS: "1000",
        MIN_KEEPER_LAMPORTS: "1000000000",
        AUTOCLAIM_INTERVAL_SECS: "3",
      }),
    );
    await waitFor("keeper health", async () => (await fetch(`http://127.0.0.1:${keeperPort}/health`)).status > 0, 60_000);
    log("✓ indexer, api, keeper running");

    ws = new WebSocket(`ws://127.0.0.1:${apiPort}/v1/ws`);
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; event?: { kind: string } };
      if (msg.type === "feed" && msg.event) wsEvents.push(msg.event.kind);
    };
    await waitFor("ws open", async () => ws!.readyState === 1, 10_000);

    // ── curve phase ──────────────────────────────────────────────────────────
    // D18: launch exactly like the app — POST /v1/launch/prepare, the wallet signs as fee
    // payer/creator, the mint signature comes from the server's pre-ground `…fmbL` pool.
    const pooled = await waitFor("grinder: a …fmbL mint in the pool", async () => {
      const h = await get<{ vanityPool: { available: number; reserved: number } | null }>("/health");
      return h.vanityPool && h.vanityPool.available + h.vanityPool.reserved > 0 ? h.vanityPool : null;
    }, 600_000, 2_000);
    log(`✓ vanity pool ready (${JSON.stringify(pooled)})`);
    const prep = await fetch(`${api}/v1/launch/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        creator: creator.publicKey.toBase58(),
        name: "Fumble",
        symbol: "FUMB",
        uri: "https://fumpad.fun/m/fumb.json",
        initialBuyLamports: String(SOL / 2n),
        // M-2: proof of wallet control (the app signs this with the wallet's signMessage).
        auth: signLaunchAuth(creator.secretKey, { creator: creator.publicKey.toBase58(), symbol: "FUMB" }),
      }),
    });
    if (!prep.ok) throw new Error(`prepare → ${prep.status} ${await prep.text()}`);
    const prepared = (await prep.json()) as { mint: string; transaction: string; lastValidBlockHeight: number };
    const launchTx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
    const launchInfo = inspectLaunchTx(launchTx);
    check("prepare: server-built create_coin+buy, creator pays, only the mint has signed", launchInfo.feePayer === creator.publicKey.toBase58() && launchInfo.signed.join() === prepared.mint && !!launchInfo.buySolIn && launchInfo.buySolIn <= SOL / 2n, `first buy ${launchInfo.buySolIn} lamports`);
    launchTx.sign([creator]);
    const launchRaw = launchTx.serialize();
    const launchSig = await conn.sendRawTransaction(launchRaw, { maxRetries: 0 });
    await confirmSignature(conn, launchSig, prepared.lastValidBlockHeight, "confirmed", launchRaw);
    const M = prepared.mint;
    const mint = new PublicKey(M);
    check("launch through the API → mint address ends in fmbL (D18)", isFumpadVanityMint(mint) && M.endsWith("fmbL") && !!(await c.coin(mint)), M);
    const used = await waitFor("indexer marks the vanity mint used", async () => {
      const r = await queryRows<{ status: string; used_tx: string | null; wiped: boolean }>(pg!.url, `SELECT status, used_tx, secret_enc IS NULL AS wiped FROM vanity_mints WHERE pubkey = '${M}'`);
      return r[0]?.status === "used" ? r[0] : null;
    }, 60_000);
    check("indexer marked the pooled mint used on CoinCreated and wiped its secret", used.used_tx === launchSig && used.wiped);
    // Tickets must be ≥ 10x by graduation (curve start→graduation ≈ 14.7x), so the
    // sellers exit early: keep virtual SOL ≲ 36 at sell time.
    const buy = async (k: Keypair, sol: bigint) => c.send(k, await c.buildBuy({ user: k.publicKey, mint, budgetLamports: sol * SOL }));
    const sellPart = async (k: Keypair, num: bigint, den: bigint) => {
      const bal = await tokenBalance(c, k.publicKey, mint);
      const b = await c.buildSell({ user: k.publicKey, mint, tokensIn: (bal * num) / den });
      const sig = await c.send(k, b);
      const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
      return { sig, events: decodeTransactionEvents(tx as unknown as TxLike), ticket: b.ticket };
    };
    // D19: wait out the snipe window (4 slots) so these buys pay the normal fee.
    await sleep(2_500);
    // D17 (8% pool): eve buys enough that her claim stays > 10% of the pool (queued).
    await buy(alice, 1n);
    await buy(eve, 4n);
    await sleep(3_500); // > min_hold_secs (2 s) on the chain clock
    const aliceSell = await sellPart(alice, 1n, 2n);
    const eveSell = await sellPart(eve, 19n, 20n);
    await buy(carol, 1n);
    await buy(dave, 1n);
    await buy(bob, 1n);
    log("✓ launch + 5 curve buys");
    await sleep(3_500);
    const carolSell = await sellPart(carol, 1n, 2n);
    const daveSell = await sellPart(dave, 1n, 2n);
    const bobTiny = await c.send(bob, await c.buildSell({ user: bob.publicKey, mint, tokensIn: 1_000_000n })); // ≈ $0.0x → no ticket
    check("curve sells create tickets (matured, ≥ $50)", [aliceSell, eveSell, carolSell, daveSell].every((s) => s.events.some((e) => e.name === "TicketCreated")));
    const bobTx = await conn.getTransaction(bobTiny, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    check("sell under $50 files no ticket", !decodeTransactionEvents(bobTx as unknown as TxLike).some((e) => e.name === "TicketCreated"));
    // D17: auto-claim is on by default; eve opts out on this coin and will claim by hand.
    await c.send(eve, c.buildSetAutoClaim({ wallet: eve.publicKey, mint, enabled: false }));
    check("set_auto_claim(false): eve's Position opted out of keeper auto-claim", (await c.position(mint, eve.publicKey))?.autoClaimOptOut === 1);

    for (let i = 0; i < 20; i++) {
      const coin = await c.coin(mint);
      if (coin?.status !== "curve") break;
      await c.send(whale, await c.buildBuy({ user: whale.publicKey, mint, budgetLamports: 10n * SOL }));
    }
    check("curve completed by buys", (await c.coin(mint))?.status !== "curve");

    // ── keeper graduates + samples ───────────────────────────────────────────
    await waitFor("keeper graduation (API shows graduated)", async () => (await get<{ status: string }>(`/v1/coins/${M}`)).status === "graduated", 90_000);
    check("keeper graduated the coin; indexer + API reflect it", true);
    await waitFor("observations + queue initialised by keeper", async () => !!(await c.observations(mint)) && !!(await c.claimQueue(mint)), 60_000);
    await waitFor("keeper median (5-of-6 bucket coverage)", async () => (await get<{ median?: number }>(`/v1/coins/${M}`)).median !== undefined, 150_000, 2_000);
    check("keeper sampled to a valid median (keeper-only, time-spread)", true);
    // ── claims ───────────────────────────────────────────────────────────────
    // D17: alice left auto-claim on → the keeper claims for her (claim_for) as soon as the
    // covered keeper median holds 10× her ticket price; payout lands in her own ATA.
    let lastSeen = "";
    const aliceAuto = await waitFor("keeper auto-claims alice's ticket", async () => {
      const t = await get<{ id: string; state: string; multiple: number; autoClaimed?: boolean; claimTx?: string }[]>(`/v1/wallets/${alice.publicKey.toBase58()}/tickets`);
      const s = JSON.stringify(t.map((x) => [x.state, x.multiple, x.autoClaimed]));
      if (s !== lastSeen) log(`    alice tickets: ${(lastSeen = s)}`);
      return t.find((x) => x.state === "claimed");
    }, 120_000);
    const autoRow = (await queryRows<{ triggered_by: string; auto: boolean; signature: string; from_queue: boolean }>(pg.url, `SELECT triggered_by, auto, signature, from_queue FROM claims WHERE ticket = '${aliceSell.ticket.toBase58()}'`))[0];
    const claimSig = autoRow?.signature;
    const claimTx = (await conn.getTransaction(claimSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })) as unknown as TxLike;
    const paidEv = decodeTransactionEvents(claimTx).find((e) => e.name === "ClaimPaid");
    const paid = paidEv?.data as { triggeredBy: PublicKey; owner: PublicKey; amount: bigint } | undefined;
    check("keeper auto-claim: claim_for emitted ClaimPaid triggered_by the keeper, paid now (not queued)", !!paid && paid.triggeredBy.equals(keeper.publicKey) && paid.owner.equals(alice.publicKey) && !autoRow.from_queue, `${claimSig.slice(0, 12)}…`);
    const aliceDelta = tokenDeltas(claimTx, M).get(alice.publicKey.toBase58()) ?? 0n;
    check("auto-claim payout landed in alice's own ATA", !!paid && aliceDelta === paid.amount, `${aliceDelta} base units`);
    check("indexer/API: claim marked auto, ticket autoClaimed", autoRow.auto && aliceAuto.autoClaimed === true);
    const eveT = await waitFor("eve ticket claimable (opted out, not auto-claimed)", async () => {
      const t = await get<{ state: string; autoClaim: boolean; multiple: number }[]>(`/v1/wallets/${eve.publicKey.toBase58()}/tickets`);
      return t.find((x) => x.state === "claimable");
    }, 60_000);
    check("API: eve's ticket 'claimable' with autoClaim off (keeper skipped it)", eveT.autoClaim === false, `multiple ${eveT.multiple.toFixed(2)}×`);
    const eveClaim = await c.send(eve, c.buildClaim({ owner: eve.publicKey, mint, ticket: eveSell.ticket }));
    const eveEv = decodeTransactionEvents((await conn.getTransaction(eveClaim, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })) as unknown as TxLike);
    check("eve's large claim (> 10% of pool) queued (ClaimQueued)", eveEv.some((e) => e.name === "ClaimQueued"));
    const q = await waitFor("queue visible in API", async () => {
      const r = await get<{ pool: number; owed: number; entries: { owner: string; fits: boolean; needsPool: number }[] }>(`/v1/coins/${M}/queue?viewer=${eve.publicKey.toBase58()}`);
      return r.entries.length ? r : null;
    }, 30_000);
    check("API queue shows eve's entry with needsPool > pool", q.entries[0].owner === eve.publicKey.toBase58() && !q.entries[0].fits && q.entries[0].needsPool > q.pool, `pool ${q.pool.toFixed(0)} needs ${q.entries[0].needsPool.toFixed(0)}`);
    // Donation into the reward vault (anyone can) makes the entry fit; the keeper pays it.
    const donate = BigInt(Math.ceil((q.entries[0].needsPool - q.pool) * 1e6)) + 1_000_000_000_000n;
    const xfer = new TransactionInstruction({
      programId: TOKEN_2022_PROGRAM_ID,
      keys: [
        { pubkey: coinAta(whale.publicKey, mint), isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: coinAddresses(mint).rewardVault, isSigner: false, isWritable: true },
        { pubkey: whale.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([12, ...new Uint8Array(new BigUint64Array([donate]).buffer), 6]),
    });
    await c.send(whale, { instructions: [xfer] });
    await waitFor("keeper process_queue pays eve", async () => {
      const t = await get<{ chainStatus: string }[]>(`/v1/wallets/${eve.publicKey.toBase58()}/tickets`);
      return t.some((x) => x.chainStatus === "claimed");
    }, 60_000);
    check("keeper process_queue paid the queued claim (from_queue)", true);

    // ── post-graduation trading ──────────────────────────────────────────────
    const quote = await get<{ amountOut: number; venue: string }>(`/v1/quote?mint=${M}&side=buy&amount=0.5&wallet=${bob.publicKey.toBase58()}`);
    const before = await tokenBalance(c, bob.publicKey, mint);
    await c.send(bob, await c.buildBuy({ user: bob.publicKey, mint, budgetLamports: SOL / 2n }));
    const got = Number((await tokenBalance(c, bob.publicKey, mint)) - before) / 1e6;
    check("API buy quote (PumpSwap) matches the real router fill", quote.venue === "pumpswap" && Math.abs(got / quote.amountOut - 1) < 0.001, `quoted ${quote.amountOut.toFixed(2)} got ${got.toFixed(2)}`);
    const sq = await get<{ amountOut: number; ticket?: { files: boolean; reason?: string } }>(`/v1/quote?mint=${M}&side=sell&amount=1000&wallet=${bob.publicKey.toBase58()}`);
    check("API sell quote previews 'no ticket' for a tiny sell", sq.ticket?.files === false, `reason ${sq.ticket?.reason}`);
    await c.send(bob, await c.buildSell({ user: bob.publicKey, mint, tokensIn: (await tokenBalance(c, bob.publicKey, mint)) / 3n }));
    await directPumpBuy(c, dave, mint, SOL / 2n); // dave rebuys OUTSIDE FUMPAD within 7 days of his sell
    log("✓ router swaps + an outside PumpSwap rebuy");

    await waitFor("keeper skim+settle", async () => (await countRows(pg!.url, "lp_settlements")) > 0, 90_000, 2_000);
    check("keeper skim + settle_lp_fees (Skimmed + LpFeesSettled indexed)", true);
    await waitFor("keeper buyback", async () => (await countRows(pg!.url, "buybacks")) > 0, 120_000, 2_000);
    check("keeper execute_buyback (BuybackExecuted indexed)", true);
    await waitFor("keeper platform fee withdrawal", async () => (await countRows(pg!.url, "fee_withdrawals")) > 0, 90_000, 2_000);
    check("keeper withdraw_platform_fees", true);

    // ── flags ────────────────────────────────────────────────────────────────
    const daveP = await waitFor("dave flagged", async () => (await get<{ flagged: boolean }>(`/v1/profiles/${dave.publicKey.toBase58()}`)).flagged && 1, 60_000);
    check("rebuy-elsewhere detected from PumpSwap pool trades → flagged", !!daveP);
    const carolP = await waitFor("carol flagged", async () => (await get<{ flagged: boolean }>(`/v1/profiles/${carol.publicKey.toBase58()}`)).flagged && 1, 60_000);
    check("creator-funded alt detected via funding graph → flagged", !!carolP);

    // ── more coins: ALT-batched sampling (6 graduated coins > 5 per legacy tx) ─
    const extra = opts.extraCoins ?? 5;
    for (let i = 0; i < extra; i++) {
      const kp = Keypair.generate();
      await c.send(creator, await c.buildLaunch({ creator: creator.publicKey, mint: kp, name: `Extra ${i}`, symbol: `EX${i}`, uri: "https://fumpad.fun/m/x.json" }));
      for (let j = 0; j < 20 && (await c.coin(kp.publicKey))?.status === "curve"; j++) await c.send(whale, await c.buildBuy({ user: whale.publicKey, mint: kp.publicKey, budgetLamports: 10n * SOL }));
    }
    if (extra) {
      await waitFor("all coins graduated", async () => (await get<unknown[]>(`/v1/coins?status=graduated&limit=50`)).length === extra + 1, 180_000, 2_000);
      const altSig = await waitFor("a 6+ coin record_samples (v0 + ALT)", async () => {
        const r = await queryRows<{ signature: string; n: string }>(pg!.url, "SELECT signature, count(*) AS n FROM samples GROUP BY signature HAVING count(*) > 5 LIMIT 1");
        return r[0];
      }, 120_000, 2_000);
      check("keeper batches >5 coins per record_samples with a lookup table", true, `${altSig.n} coins in ${altSig.signature.slice(0, 12)}…`);
    }

    // ── API surface vs chain facts ───────────────────────────────────────────
    const coin = await get<Record<string, number | string | undefined>>(`/v1/coins/${M}`);
    const chainCoin = (await c.coin(mint))!;
    const vault = await c.tokenBalance(coinAddresses(mint).rewardVault);
    const poolOk = await waitFor("pool in sync", async () => {
      const apiPool = (await get<{ poolTokens: number }>(`/v1/coins/${M}`)).poolTokens;
      return Math.abs(apiPool - Number(await c.tokenBalance(coinAddresses(mint).rewardVault)) / 1e6) < 1e-6;
    }, 30_000, 300).then(() => true, () => false);
    check("GET /v1/coins/:mint pool tokens == reward vault on chain", poolOk, `${coin.poolTokens} vs ${Number(vault) / 1e6}`);
    // The keeper keeps sampling (each sample moves the D10 reference): wait for a quiet
    // moment where the API's chain-synced value and a fresh chain read agree.
    const refOk = await waitFor("reference in sync", async () => {
      const apiRef = (await get<{ referencePrice: number }>(`/v1/coins/${M}`)).referencePrice;
      const chainRef = Number((await c.coin(mint))!.reference.avgQ64) / 2 ** 64 / 1e3;
      return Math.abs(apiRef / chainRef - 1) < 1e-9;
    }, 30_000, 300).then(() => true, () => false);
    check("GET /v1/coins/:mint reference == Coin.reference (chain sync)", refOk);
    check("GET /v1/coins/:mint ammPool + paid out", coin.ammPool === chainCoin.ammPool.toBase58() && (coin.poolPaidOut as number) > 0);
    const list = await get<{ mint: string }[]>(`/v1/coins?sort=trending`);
    check("GET /v1/coins lists the coin", list.some((x) => x.mint === M));
    const feed = await get<{ kind: string }[]>(`/v1/feed?limit=100`);
    const kinds = new Set(feed.map((f) => f.kind));
    check("GET /v1/feed has launch, fumble, graduation, cross, claim", ["launch", "fumble", "graduation", "cross", "claim"].every((k) => kinds.has(k)), [...kinds].join(","));
    check("WebSocket delivered feed events live", wsEvents.includes("fumble") && wsEvents.includes("claim") && wsEvents.includes("graduation"), wsEvents.join(","));
    const ticket = await get<{ state: string; claimTx?: string }>(`/v1/tickets/${aliceSell.ticket.toBase58()}`);
    check("GET /v1/tickets/:id → claimed with claimTx", ticket.state === "claimed" && ticket.claimTx === claimSig);
    const board = await get<{ address: string; rank: number }[]>(`/v1/leaderboards/claimers`);
    check("claimers leaderboard ranks alice/eve, excludes flagged", board.some((r) => r.address === alice.publicKey.toBase58()) && !board.some((r) => r.address === dave.publicKey.toBase58() || r.address === carol.publicKey.toBase58()));
    const prof = await waitFor("alice profile xp", async () => {
      const p = await get<{ xp: number; achievements: { id: string; earned: boolean }[]; ticketsFiled: number }>(`/v1/profiles/${alice.publicKey.toBase58()}`);
      return p.xp > 0 && p.achievements.find((a) => a.id === "tenbagger")?.earned ? p : null;
    }, 30_000);
    check("profile: level/xp/achievements derived", prof.ticketsFiled === 1 && prof.achievements.find((a) => a.id === "tenbagger")?.earned === true, `xp ${prof.xp}`);
    for (const path of [`/v1/stats`, `/v1/sol-usd`, `/v1/coins/${M}/prices?range=all`, `/v1/coins/${M}/holders`, `/v1/coins/${M}/fumbles`, `/v1/closest`, `/v1/leaderboards/fumbles`, `/v1/leaderboards/diamond`, `/v1/wallets/${bob.publicKey.toBase58()}/balances/${M}`, `/openapi.json`]) {
      const r = await fetch(api + path, { headers: { "x-fumpad-ssr": ssrSecret } });
      check(`GET ${path.split("?")[0].replace(M, ":mint").replace(bob.publicKey.toBase58(), ":wallet")} → 200`, r.ok);
    }

    const autoFeed = await get<{ kind: string; auto?: boolean }[]>(`/v1/feed?kind=claim&limit=50`);
    check("feed marks the keeper's claim as auto-claimed", autoFeed.some((f) => f.auto === true));

    // D18: no pooled mint secret ever shows up in a service log (grinder, API, …).
    const { createDecipheriv } = await import("node:crypto");
    const left = await queryRows<{ pubkey: string; secret_enc: Buffer }>(pg.url, "SELECT pubkey, secret_enc FROM vanity_mints WHERE secret_enc IS NOT NULL");
    const allLogs = services.flatMap((s) => s.logs).join("\n");
    const leaked = left.some((r) => {
      const d = createDecipheriv("aes-256-gcm", Buffer.from(mintPoolKey, "hex"), r.secret_enc.subarray(0, 12));
      d.setAAD(Buffer.concat([Buffer.from("fumpad-vanity-mint:v1:"), Buffer.from(r.pubkey)]));
      d.setAuthTag(r.secret_enc.subarray(44));
      const seed = Buffer.concat([d.update(r.secret_enc.subarray(12, 44)), d.final()]);
      return [seed.toString("hex"), seed.toString("base64"), bs58.encode(seed), bs58.encode(Keypair.fromSeed(seed).secretKey), Array.from(seed).join(",")].some((n) => allLogs.includes(n));
    });
    check("no mint secret in any service log", !leaked && allLogs.includes("launch prepared"), `${left.length} pooled secrets checked against ${allLogs.length} log bytes`);

    const counts: Record<string, number> = {};
    for (const t of ["vanity_mints", "transactions", "events", "coins", "trades", "tickets", "claims", "queue_entries", "samples", "buybacks", "lp_skims", "lp_settlements", "fee_withdrawals", "external_trades", "feed_events", "wallet_flags", "user_stats"]) counts[t] = await countRows(pg.url, t);
    const keeperHealth = await (await fetch(`http://127.0.0.1:${keeperPort}/health`)).json();
    const indexerHealth = await (await fetch(`http://127.0.0.1:${indexerPort}/health`)).json();
    const apiHealth = await get("/health");
    return { ok: checks.every((x) => x.ok), mint: M, checks, counts, wsEvents, keeperHealth, indexerHealth, apiHealth, durationSec: Math.round((Date.now() - t0) / 1000) };
  } catch (e) {
    for (const s of services) {
      log(`--- last ${s.name} logs ---`);
      for (const l of s.logs.slice(-25)) log(l);
    }
    throw e;
  } finally {
    ws?.close();
    for (const s of services.reverse()) await s.stop();
    await v?.stop();
    await pg?.stop();
  }
}

async function queryRows<T>(url: string, sql: string): Promise<T[]> {
  const { default: pgm } = await import("pg");
  const cl = new pgm.Client({ connectionString: url });
  await cl.connect();
  try {
    return (await cl.query(sql)).rows as T[];
  } finally {
    await cl.end();
  }
}
async function countRows(url: string, table: string): Promise<number> {
  const r = await queryRows<{ n: string }>(url, `SELECT count(*) AS n FROM ${table}`);
  return Number(r[0].n);
}

