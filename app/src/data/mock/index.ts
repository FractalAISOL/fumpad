import { PARAMS, curvePriceAt } from "../chain";
import { curveReservesAt, feeBpsAtSlot, quoteBuy, quoteSell, splitFee } from "../meteora";
import { bucketOf, candlesFromPoints, INTERVAL_MS, windowStart } from "../candles";
import type { CoinSort, FumpadData, Unsubscribe } from "../interface";
import type {
  Achievement,
  Address,
  Board,
  CandleInterval,
  CandleSeries,
  ChartRange,
  CloseCall,
  ClosedPosition,
  CoinDetail,
  CoinSummary,
  CreatedCoin,
  FeedEvent,
  FeedKind,
  FumbleRow,
  Holder,
  LeaderRow,
  LiveMessage,
  PlatformStats,
  PricePoint,
  Profile,
  ProtocolParams,
  QueueEntry,
  Side,
  SystemStatus,
  Ticket,
  TicketChainStatus,
  TradeQuote,
  TradeRow,
  FumbleSell,
  WalletCoinFumbles,
  WalletFumbles,
  WalletPosition,
} from "../types";
import { type MockEntry, baseLedger, foldBooks, isClosedBook, mockCreatorFees } from "./portfolio";
import { hash, mintAddress, signature } from "./rng";
import {
  COIN_SPECS,
  type CoinSpec,
  DAY,
  DEMO_NAME,
  DEMO_TICKETS,
  DEMO_WALLET,
  EPOCH,
  HOUR,
  MINUTE,
  P0,
  PENDING_LAUNCHES,
  P_GRAD,
  SOL_USD,
  SPEC_BY_MINT,
  SPEC_BY_SYMBOL,
  type TicketSpec,
  USERS,
  addrOf,
  address,
  anon,
  between,
  creatorOf,
  gauss,
  generatedTickets,
  lastHour,
  medianOf,
  nameOf,
  pick,
  priceAt,
  pricePath,
  randomName,
  rng,
  spotOf,
  ticketSellPrice,
} from "./world";

export { DEMO_WALLET, DEMO_NAME, EPOCH };

const SUPPLY = PARAMS.totalSupply;
const FEE = PARAMS.feeBps / 10_000;
/** Share of every trade's SOL that buys the coin back into its reward pool (half of FUMPAD's 80%). */
const POOL_SHARE = FEE * (1 - PARAMS.venueFeeShareBps / 10_000) * (PARAMS.feePoolShareBps / 10_000);

/**
 * App labels the mock spreads trades and sells across (`@fumpad/meteora` `appLabel` ids). FUMPAD
 * coins trade on every app from launch; "fumpad" marks router trades.
 */
const APPS = ["fumpad", "axiom", "jupiter", "fumpad", "direct", "okx", "axiom", "dflow", "padre", "unknown_program"] as const;
const appFor = (r: () => number): string => APPS[Math.floor(r() * APPS.length)];

/* ── Coins ─────────────────────────────────────────────────────────────────── */

function specOf(symbolOrMint: string): CoinSpec | undefined {
  return SPEC_BY_SYMBOL.get(symbolOrMint.toUpperCase().replace(/^\$/, "")) ?? SPEC_BY_MINT.get(symbolOrMint);
}

function spark(symbol: string): number[] {
  const out: number[] = [];
  for (let i = 23; i >= 0; i--) out.push(priceAt(symbol, EPOCH - i * HOUR));
  return out;
}

/* ── Live simulation (client only) ────────────────────────────────────────── */

/**
 * The mock's live layer: while something subscribes, coins the UI is looking at (and one
 * random coin) trade every few seconds. Prices drift, curve coins raise SOL, ticket
 * multiples follow, and each tick goes out as the same `coins` + `coin` messages the API
 * sends, so mock mode exercises the exact live code paths. Nothing changes until a
 * subscriber starts the ticker, so server renders stay deterministic.
 */
const sim = {
  drift: new Map<string, number>(),
  raised: new Map<string, number>(),
  points: new Map<string, PricePoint[]>(),
  trades: new Map<string, TradeRow[]>(),
  /** symbol → last time the UI read it (getCoin / series / tickets). */
  watched: new Map<string, number>(),
  /** Simulated activity on top of the spec's 24 h numbers. */
  count: new Map<string, number>(),
  volume: new Map<string, number>(),
  holders: new Map<string, number>(),
};
const bump = (m: Map<string, number>, k: string, by: number) => m.set(k, (m.get(k) ?? 0) + by);
const watch = (c: CoinSpec | undefined) => {
  // Client only: the server must not read the clock (prerender) and never ticks anyway.
  if (c && typeof window !== "undefined") sim.watched.set(c.symbol, Date.now());
};
function curveRaised(c: CoinSpec): number {
  if (c.status !== "curve") return PARAMS.graduationSol;
  return Math.min(PARAMS.graduationSol, Math.max(0, (c.raised ?? 0) + (sim.raised.get(c.symbol) ?? 0)));
}
function liveSpot(c: CoinSpec): number {
  return c.status === "curve" ? curvePriceAt(curveRaised(c)) : spotOf(c) * (sim.drift.get(c.symbol) ?? 1);
}
function liveMedian(c: CoinSpec): number {
  return medianOf(c) * (sim.drift.get(c.symbol) ?? 1);
}

/* ── D33 snipe protection (mock) ─────────────────────────────────────────── */

/**
 * The mock's launch window. On chain a slot is ~0.4 s and the DBC fee scheduler runs 99% → 1.25%
 * over 8 slots (~3 s); here a "slot" is stretched to 5 s so simulated launches visibly pass
 * through it. LMBO is frozen at slot 1 for quotes, so mock mode always shows the window.
 */
const MOCK_SLOT_MS = 5_000;
const SNIPE_DEMO = "LMBO";
/** Session launch-window fees on top of the authored stats (simulated trades). */
const sessionSnipe = new Map<string, { sol: number; trades: number }>();

/** The fee a trade pays at slot offset `d` (bps): the scheduler in the window, the normal fee after. */
function feeAtSlot(d: number): number {
  return feeBpsAtSlot(PARAMS, d);
}
/** Fee rate for a trade on `c` at `ts` (bps). Graduated coins always pay the normal fee. */
function mockFeeBps(c: CoinSpec, ts: number, opts: { quote?: boolean } = {}): number {
  if (c.status !== "curve") return PARAMS.feeBps;
  if (opts.quote && c.symbol === SNIPE_DEMO) return feeAtSlot(1);
  return feeAtSlot(Math.floor((ts - c.createdAt) / MOCK_SLOT_MS));
}

/** LMBO's launch: the creator's first buy at the normal fee, then three snipers at slot offsets 0, 1, 2. */
const DEMO_SNIPES = [
  { slot: 0, budget: 1.0 },
  { slot: 1, budget: 0.4 },
  { slot: 2, budget: 0.18 },
].map((x) => ({ ...x, bps: feeAtSlot(x.slot) }));

/** Launch-window fees above the normal fee: authored (deterministic) + simulated this session. */
function snipeStats(c: CoinSpec): Pick<CoinSummary, "snipeTaxSol" | "snipeTaxedTrades"> {
  let sol = 0;
  let trades = 0;
  if (c.symbol === SNIPE_DEMO) {
    for (const x of DEMO_SNIPES) sol += (x.budget * (x.bps - PARAMS.feeBps)) / 10_000;
    trades = DEMO_SNIPES.length;
  } else if (c.createdAt <= EPOCH) {
    const r = rng("snipe:" + c.symbol);
    if (r() < 0.35) {
      sol = Math.round(between(r, 0.05, 2.4) * 1000) / 1000;
      trades = 1 + Math.floor(r() * 5);
    }
  }
  const live = sessionSnipe.get(c.symbol);
  if (live) {
    sol += live.sol;
    trades += live.trades;
  }
  return trades > 0 ? { snipeTaxSol: sol, snipeTaxedTrades: trades } : {};
}

/**
 * Reward pool balance. D35: the 8% DBC leftover only lands at graduation, so a curve coin's pool
 * holds just its buybacks (half of FUMPAD's fee share, plus its launch-window fees).
 */
function poolTokensOf(c: CoinSpec): number {
  if (c.status === "graduated") return c.poolTokens;
  const r = rng("pool:" + c.symbol);
  return Math.round(curveRaised(c) * between(r, 18_000, 30_000) + (snipeStats(c).snipeTaxSol ?? 0) * 0.8 * 2.6e6);
}

function ticketsOpenOn(c: CoinSpec): number {
  // Young curve coins (the board's New column) have only a handful of sellers yet.
  if (c.status === "curve" && c.createdAt > EPOCH - DAY) return Math.round(curveRaised(c) * 0.35);
  return 40 + (Math.round(c.volume24hUsd / 900) % 2600) + Math.round(c.holders / 9);
}

function summary(c: CoinSpec): CoinSummary {
  const price = liveSpot(c);
  return {
    mint: mintAddress(c.symbol),
    symbol: c.symbol,
    name: c.name,
    creator: creatorOf(c),
    tile: c.tile,
    status: c.status,
    createdAt: c.createdAt,
    graduatedAt: c.graduatedAt,
    price,
    median: c.status === "graduated" ? liveMedian(c) : undefined,
    change24h: c.change24h,
    marketCapSol: price * SUPPLY,
    curveSol: curveRaised(c),
    graduationSol: PARAMS.graduationSol,
    poolTokens: poolTokensOf(c),
    ticketsOpen: ticketsOpenOn(c),
    spark: [...spark(c.symbol).slice(0, -1), price],
    ...boardExtras(c),
    ...snipeStats(c),
  };
}

/** Deterministic board fields: tx count, socials, the ticket nearest 10×, creator flag. */
function boardExtras(c: CoinSpec): Pick<CoinSummary, "trades24h" | "socials" | "closestMultiple" | "creatorFlagged" | "volume24hSol" | "holders"> {
  const r = rng("extra:" + c.symbol);
  const vol = c.volume24hUsd / SOL_USD;
  const avgTrade = between(r, 0.25, c.status === "graduated" ? 3 : 0.9);
  const sym = c.symbol.toLowerCase();
  const socials = {
    x: r() < 0.8 ? `https://x.com/${sym}onsol` : undefined,
    telegram: r() < 0.55 ? `https://t.me/${sym}portal` : undefined,
    website: r() < 0.35 ? `https://${sym}.fun` : undefined,
  };
  const tickets = ticketsOpenOn(c);
  const base = between(r, 1.3, 9.7);
  const drift = sim.drift.get(c.symbol) ?? 1;
  return {
    trades24h: Math.round(vol / avgTrade) + (sim.count.get(c.symbol) ?? 0),
    volume24hSol: vol + (sim.volume.get(c.symbol) ?? 0),
    holders: c.holders + (sim.holders.get(c.symbol) ?? 0),
    socials: socials.x || socials.telegram || socials.website ? socials : undefined,
    closestMultiple: tickets > 0 ? Math.min(9.97, base * (c.status === "graduated" ? drift : liveSpot(c) / Math.max(P0, spotOf(c)))) : undefined,
    creatorFlagged: c.symbol === "RUGZ" || hash("flag:" + c.symbol) % 11 === 0,
  };
}

function poolBought24h(c: CoinSpec): number {
  const solToPool = (c.volume24hUsd / SOL_USD) * POOL_SHARE;
  return solToPool / spotOf(c);
}

function detail(c: CoinSpec): CoinDetail {
  const s = summary(c);
  const r = rng("detail:" + c.symbol);
  const price = s.price;
  const k = PARAMS.initialVirtualSol * PARAMS.initialVirtualTokens;
  const vSol = PARAMS.initialVirtualSol + curveRaised(c);
  const vTok = k / vSol;
  const grad = c.status === "graduated";
  const ratio = price / P_GRAD;
  const queue = grad ? queueFor(c) : [];
  return {
    ...s,
    description: c.description,
    links: [
      { label: "X", href: `https://x.com/${c.symbol.toLowerCase()}onsol` },
      { label: "Telegram", href: `https://t.me/${c.symbol.toLowerCase()}portal` },
    ],
    poolSeeded: grad ? PARAMS.rewardPoolSupply : 0,
    poolBought24h: poolBought24h(c),
    poolPaidOut: grad ? Math.round(between(r, 2, 30) * 1e6) : 0,
    queueOwed: queue.reduce((a, q) => a + q.amount, 0),
    ticketsCreated: s.ticketsOpen + Math.round(s.ticketsOpen * between(r, 0.4, 1.6)),
    ticketsPast10x: grad ? Math.round(between(r, 3, 40)) : Math.round(between(r, 0, 12)),
    referencePrice: price * c.refRatio,
    dbcPool: address("dbc:" + c.symbol),
    dammPool: grad ? address("damm:" + c.symbol) : undefined,
    virtualSol: vSol,
    virtualTokens: vTok,
    curveTokensLeft: grad ? 0 : Math.max(0, PARAMS.curveSupply - (PARAMS.initialVirtualTokens - vTok)),
    ammSol: grad ? PARAMS.graduationSol * Math.sqrt(ratio) : undefined,
    ammTokens: grad ? PARAMS.lpSupply / Math.sqrt(ratio) : undefined,
    curveSol1h: c.raised1h ?? 0,
  };
}

/* ── Price series ─────────────────────────────────────────────────────────── */

function series(c: CoinSpec, range: ChartRange): PricePoint[] {
  if (range === "1h") return [...lastHour(c.symbol).map(({ t, p }) => ({ t, p })), ...(sim.points.get(c.symbol) ?? [])];
  const path = pricePath(c.symbol);
  const from = range === "1d" ? EPOCH - DAY : range === "7d" ? EPOCH - 7 * DAY : c.createdAt;
  const step = range === "1d" ? 15 * MINUTE : range === "7d" ? HOUR : Math.max(HOUR, (EPOCH - c.createdAt) / 240);
  const out: PricePoint[] = [];
  let next = Math.max(from, c.createdAt);
  for (const pt of path) {
    if (pt.t < next) continue;
    out.push({ t: pt.t, p: pt.p });
    next = pt.t + step;
  }
  const last = path[path.length - 1];
  if (out[out.length - 1]?.t !== last.t) out.push({ t: last.t, p: last.p });
  return [...out, ...(sim.points.get(c.symbol) ?? [])];
}

/**
 * Candles: four synthetic ticks per bucket around the coin's price path (seeded, so a refetch draws the same
 * candles), plus this session's simulated trades, bucketed by the app's own `candlesFromPoints`.
 */
function candlesFor(c: CoinSpec, interval: CandleInterval): CandleSeries {
  const now = mockNow();
  const ms = INTERVAL_MS[interval];
  const from = windowStart(interval, now, c.createdAt);
  const r = rng(`candles:${c.symbol}:${interval}`);
  const vol = interval === "1m" ? 0.008 : interval === "5m" ? 0.015 : 0.03;
  const pts: PricePoint[] = [];
  for (let b = from; b <= bucketOf(now, ms); b += ms) {
    for (let k = 0; k < 4; k++) {
      const t = b + ((k + 0.5) * ms) / 4;
      const p = priceAt(c.symbol, t) * Math.exp(vol * gauss(r));
      if (t >= c.createdAt && t <= now) pts.push({ t, p });
    }
  }
  for (const p of sim.points.get(c.symbol) ?? []) if (p.t >= from) pts.push(p);
  pts.sort((a, b) => a.t - b.t);
  const open = from > c.createdAt ? priceAt(c.symbol, from - 1) : undefined;
  return { interval, from, ...(open !== undefined ? { open } : {}), candles: candlesFromPoints(pts, interval, open) };
}

/* ── Tickets ──────────────────────────────────────────────────────────────── */

const ticketOverrides = new Map<string, Partial<Ticket>>();
/** D17 auto-claim opt-outs, `${owner}:${mint}` (on by default). */
const autoClaimOff = new Set<string>();
/** Mock side of `set_auto_claim` (the simulated tx updates this so refetches agree). */
export function mockSetAutoClaim(owner: Address, mint: Address, enabled: boolean) {
  if (enabled) autoClaimOff.delete(`${owner}:${mint}`);
  else autoClaimOff.add(`${owner}:${mint}`);
}

/**
 * v0.7 attestation phases (SPEC v0.7 §5): a qualifying sell is "verifying" until the keepers'
 * 2-of-3 attestation lands (~1 min after finality), then sits in the challenge window until
 * `claimableFrom`, then takes its usual state. The mock attests exactly `attestDelaySecs` after
 * the sell, so a ticket filed in this session walks through every phase as the clock runs.
 */
function attestPhase(sellTs: number, settled: Ticket["state"], now = mockNow()): Pick<Ticket, "state" | "attestedAt" | "effectiveAt" | "claimableFrom"> {
  const attestedAt = sellTs + PARAMS.attestDelaySecs * 1000;
  if (now < attestedAt) return { state: "verifying", attestedAt: undefined, claimableFrom: undefined };
  const claimableFrom = attestedAt + PARAMS.ticketChallengeSecs * 1000;
  const open = settled === "claimable" || settled === "tracking" || settled === "awaiting-graduation";
  return { state: open && now < claimableFrom ? "challenge" : settled, attestedAt, effectiveAt: attestedAt, claimableFrom };
}

function buildTicket(owner: Address, t: TicketSpec): Ticket {
  const c = SPEC_BY_SYMBOL.get(t.symbol)!;
  const id = address(`ticket:${owner}:${t.symbol}:${t.seq}`);
  const sellPrice = owner === DEMO_WALLET ? ticketSellPrice(t) : medianOf(c) / t.multiple;
  const execPrice = t.floorApplied ? sellPrice * 0.94 : sellPrice;
  const claimAmount = Math.round(t.tokens * (PARAMS.claimBps / 10_000));
  const median = c.status === "graduated" ? liveMedian(c) : liveSpot(c);
  // Spec states "verifying"/"challenge" only mark the demo's young tickets: their settled state follows the coin.
  const settled: Ticket["state"] =
    t.state === "verifying" || t.state === "challenge" ? (c.status !== "graduated" ? "awaiting-graduation" : t.multiple >= 10 ? "claimable" : "tracking") : t.state;
  const phase = attestPhase(t.sellTs, settled);
  const chainStatus: TicketChainStatus =
    phase.state === "verifying"
      ? "pending"
      : t.state === "queued"
        ? "queued"
        : t.state === "claimed"
          ? t.escrowed
            ? "escrowed"
            : "claimed"
          : t.state === "expired"
            ? "expired"
            : t.state === "voided"
              ? "voided"
              : "open";
  const queued = t.state === "queued";
  const r = rng(`src:${owner}:${t.symbol}:${t.seq}`);
  const app = t.app ?? (t.source === "router" ? "fumpad" : owner === DEMO_WALLET ? undefined : appFor(r));
  const source = t.source ?? (app === "fumpad" ? "router" : "outside");
  const queueNeedsPool = queued ? claimAmount / (PARAMS.maxClaimPoolBps / 10_000) : undefined;
  const bought = poolBought24h(c);
  const base: Ticket = {
    id,
    seq: t.seq,
    owner,
    mint: mintAddress(c.symbol),
    symbol: c.symbol,
    coinName: c.name,
    tile: c.tile,
    coinStatus: c.status,
    tokens: t.tokens,
    originalTokens: t.originalTokens,
    sellPrice,
    source,
    app: source === "router" ? "fumpad" : app,
    sellSignature: signature(`sell:${id}`),
    attestedAt: phase.attestedAt,
    effectiveAt: phase.effectiveAt,
    claimableFrom: phase.claimableFrom,
    execPrice,
    sellSol: t.originalTokens * execPrice,
    sellUsd: t.originalTokens * execPrice * SOL_USD,
    sellTs: t.sellTs,
    expiresAt: queued || t.state === "claimed" ? undefined : t.sellTs + PARAMS.claimWindowSecs * 1000,
    chainStatus,
    state: phase.state,
    multiple: t.state === "claimed" ? (t.claimedMultiple ?? t.multiple) : median / sellPrice,
    peakMultiple: t.peak,
    claimAmount,
    claimValueSol: claimAmount * median,
    queuedAt: t.queuedAt,
    queuePosition: t.queuePosition,
    queueNeedsPool,
    queueEta: queued && queueNeedsPool ? Math.max(HOUR, ((queueNeedsPool - c.poolTokens) / Math.max(1, bought)) * DAY) : undefined,
    claimedAt: t.claimedAt,
    claimTx: t.claimedAt ? signature(id) : undefined,
    // The first sample at or past 10× (mock: a little over the line, never above the peak).
    crossedAt: t.peak >= 10 && t.state !== "expired" && t.state !== "voided" ? (t.queuedAt ?? t.claimedAt ?? EPOCH) - 6 * HOUR : undefined,
    crossedMultiple: t.peak >= 10 && t.state !== "expired" && t.state !== "voided" ? Math.min(t.peak, 10 + (t.seq + t.symbol.length) / 10) : undefined,
    claimMultiple: t.state === "claimed" ? (t.claimedMultiple ?? t.multiple) : undefined,
    rebuyDebited: t.originalTokens - t.tokens,
    voidReason: t.state === "voided" ? "rebuy" : undefined,
    escrowed: t.escrowed,
    autoClaim: !autoClaimOff.has(`${owner}:${mintAddress(c.symbol)}`),
    autoClaimed: t.state === "claimed" && t.seq % 2 === 0 ? true : undefined,
  };
  return { ...base, ...ticketOverrides.get(id) };
}

/** Ticket id → owner for every ticket list built so far (mock getTicket can't invert the id hash). */
const ticketOwners = new Map<Address, Address>();

function ticketsFor(owner: Address): Ticket[] {
  const specs = owner === DEMO_WALLET ? DEMO_TICKETS : generatedTickets(owner);
  const filed = (filedTickets.get(owner) ?? []).map((t) => {
    const c = SPEC_BY_SYMBOL.get(t.symbol)!;
    const now = c.status === "graduated" ? liveMedian(c) : liveSpot(c);
    const multiple = now / t.sellPrice;
    const settled: Ticket["state"] = c.status !== "graduated" ? "awaiting-graduation" : multiple >= PARAMS.triggerMultiple ? "claimable" : "tracking";
    const phase = attestPhase(t.sellTs, settled);
    return {
      ...t,
      ...phase,
      chainStatus: phase.state === "verifying" ? ("pending" as const) : ("open" as const),
      multiple,
      peakMultiple: Math.max(t.peakMultiple, multiple),
      claimValueSol: t.claimAmount * now,
      autoClaim: !autoClaimOff.has(`${owner}:${t.mint}`),
    };
  });
  const all = [...filed, ...specs.map((s) => buildTicket(owner, s))];
  for (const t of all) ticketOwners.set(t.id, owner);
  return all;
}

/* ── Queue, holders, fumbles ──────────────────────────────────────────────── */

function queueFor(c: CoinSpec, viewer?: Address): QueueEntry[] {
  const r = rng("queue:" + c.symbol);
  const cap = c.poolTokens * (PARAMS.maxClaimPoolBps / 10_000);
  const bought = poolBought24h(c);
  const raw: Omit<QueueEntry, "position" | "fits" | "needsPool" | "eta">[] = [];
  const n = c.symbol === "MIDC" ? 3 : c.symbol === "GOBT" ? 3 : Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const big = cap * between(r, 1.02, 2.1);
    const who = r() < 0.5 ? pick(r, USERS) : { name: undefined, address: anon(c.symbol + i) };
    raw.push({
      ticket: address(`q:${c.symbol}:${i}`),
      owner: who.address,
      ownerName: who.name,
      amount: Math.round(big / 1e4) * 1e4,
      sellTs: c.createdAt + (i + 1) * between(r, 0.6, 1.2) * DAY,
    });
  }
  for (const tk of ticketsFor(DEMO_WALLET)) {
    if (tk.symbol === c.symbol && tk.state === "queued") {
      raw.push({ ticket: tk.id, owner: DEMO_WALLET, ownerName: DEMO_NAME, amount: tk.claimAmount, sellTs: tk.sellTs });
    }
  }
  if (c.symbol === "GOBT" || c.symbol === "MIDC") {
    // A small claim behind the big ones: skip-ahead in action.
    raw.push({
      ticket: address(`q:${c.symbol}:small`),
      owner: anon(c.symbol + "small"),
      amount: Math.round((cap * 0.4) / 1e3) * 1e3,
      sellTs: EPOCH - 2 * DAY,
    });
  }
  raw.sort((a, b) => a.sellTs - b.sellTs);
  return raw.map((e, i) => {
    const fits = e.amount <= cap;
    const needsPool = e.amount / (PARAMS.maxClaimPoolBps / 10_000);
    return {
      ...e,
      position: i + 1,
      fits,
      needsPool,
      eta: fits ? undefined : Math.max(HOUR, ((needsPool - c.poolTokens) / Math.max(1, bought)) * DAY),
      isYou: viewer ? e.owner === viewer : undefined,
    };
  });
}

function holdersFor(c: CoinSpec, viewer?: Address): { total: number; top: Holder[] } {
  const r = rng("holders:" + c.symbol);
  const top: Holder[] = [];
  if (c.status === "graduated") {
    const d = detail(c);
    top.push({ address: d.dammPool!, label: "Meteora pool, LP locked", kind: "amm", share: ((d.ammTokens ?? 0) / SUPPLY) * 100 });
  } else {
    top.push({
      address: address("dbc:" + c.symbol),
      label: "Bonding curve (Meteora)",
      kind: "amm",
      share: ((PARAMS.curveSupply - (c.raised ?? 0) * 6e6) / SUPPLY) * 100,
    });
  }
  top.push({ address: address("pool:" + c.symbol), label: "Reward pool", kind: "pool", share: (poolTokensOf(c) / SUPPLY) * 100 });
  top.push({ address: creatorOf(c), label: "Creator", kind: "creator", share: between(r, 1.2, 4.6) });
  let s = between(r, 2.6, 3.8);
  for (let i = 0; i < 5; i++) {
    const named = r() < 0.4 ? pick(r, USERS).address : undefined;
    // One row per wallet: a repeated pick (or the creator) becomes an anonymous holder.
    const who = named && !top.some((h) => h.address === named) ? named : anon(`${c.symbol}h${i}`);
    top.push({ address: who, label: nameOf(who), kind: who === viewer ? "you" : "holder", share: s });
    s *= between(r, 0.7, 0.92);
  }
  if (viewer === DEMO_WALLET && c.status === "graduated" && !top.some((h) => h.address === DEMO_WALLET)) {
    top.push({ address: DEMO_WALLET, label: DEMO_NAME, kind: "you", share: 0.61 });
  }
  top.sort((a, b) => b.share - a.share);
  return { total: c.holders, top };
}

function fumblesFor(c: CoinSpec, viewer?: Address): FumbleRow[] {
  const r = rng("fumbles:" + c.symbol);
  const rows: FumbleRow[] = [];
  const median = c.status === "graduated" ? liveMedian(c) : liveSpot(c);
  let ts = EPOCH - between(r, 2, 6) * MINUTE;
  for (let i = 0; i < 6; i++) {
    const p = priceAt(c.symbol, ts);
    const sol = Math.exp(between(r, Math.log(0.6), Math.log(60)));
    const tokens = sol / p;
    const name = randomName(r);
    const owner = name ? addrOf(name) : anon(`${c.symbol}f${i}`);
    const app = appFor(r);
    rows.push({
      ticket: address(`f:${c.symbol}:${i}`),
      owner,
      ownerName: name,
      tokens,
      sol,
      ts,
      multiple: median / Math.max(p, ticketPriceFloor(c, p)),
      source: app === "fumpad" ? "router" : "outside",
      app,
      verifying: EPOCH - ts < PARAMS.attestDelaySecs * 1000 || undefined,
    });
    ts -= Math.exp(between(r, Math.log(4), Math.log(30 * 60))) * MINUTE;
    if (ts < c.createdAt) break;
  }
  for (const tk of ticketsFor(DEMO_WALLET)) {
    if (tk.symbol === c.symbol && tk.state !== "expired") {
      rows.push({
        ticket: tk.id,
        owner: DEMO_WALLET,
        ownerName: DEMO_NAME,
        tokens: tk.originalTokens,
        sol: tk.sellSol,
        ts: tk.sellTs,
        multiple: tk.multiple,
        isYou: viewer === DEMO_WALLET,
        source: tk.source,
        app: tk.app,
        verifying: tk.state === "verifying" || undefined,
      });
    }
  }
  return rows.sort((a, b) => b.ts - a.ts);
}
function ticketPriceFloor(c: CoinSpec, p: number): number {
  return p * Math.max(1, c.refRatio * 0.995);
}

/* ── Feed ─────────────────────────────────────────────────────────────────── */

const GRADUATED = COIN_SPECS.filter((c) => c.status === "graduated" && c.mcapUsd! > 50_000);

function makeEvent(kind: FeedKind, seed: string, ts: number, coin?: CoinSpec): FeedEvent {
  const r = rng("ev:" + seed);
  const name = randomName(r);
  const actor = name ? addrOf(name) : anon(seed);
  const base = { id: "ev_" + seed, ts, actor, actorName: name, replies: Math.floor(between(r, 0, 42)), reposts: Math.floor(between(r, 2, 96)) };
  const pickGrad = () => coin ?? pick(r, GRADUATED);
  const coinBits = (c: CoinSpec) => ({ mint: mintAddress(c.symbol), symbol: c.symbol, coinName: c.name, tile: c.tile });
  switch (kind) {
    case "launch": {
      const c = coin ?? SPEC_BY_SYMBOL.get("LMBO")!;
      return { ...base, actor: creatorOf(c), actorName: nameOf(creatorOf(c)), ...coinBits(c), kind, poolTokens: PARAMS.rewardPoolSupply, snipeTaxSol: snipeStats(c).snipeTaxSol };
    }
    case "graduation": {
      const c = coin ?? SPEC_BY_SYMBOL.get("BAGS")!;
      return { ...base, ...coinBits(c), kind, raisedSol: PARAMS.graduationSol, ticketsUnlocked: Math.floor(between(r, 80, 420)) };
    }
    case "fumble": {
      const c =
        coin ??
        pick(
          r,
          COIN_SPECS.filter((x) => x.status === "curve" || x.mcapUsd! > 50_000),
        );
      const p = priceAt(c.symbol, Math.min(ts, EPOCH));
      const sol = Math.exp(between(r, Math.log(0.5), Math.log(120)));
      const app = appFor(r);
      return { ...base, ...coinBits(c), kind, sol, tokens: sol / p, ticketPrice: p, source: app === "fumpad" ? ("router" as const) : ("outside" as const), app };
    }
    case "cross": {
      const c = pickGrad();
      const multiple = r() < 0.15 ? between(r, 18, 42) : between(r, 10, 13.5);
      const p = medianOf(c);
      const claimTokens = Math.min(c.poolTokens * 0.1, Math.round((between(r, 0.4, 9) * 1e5) / 1e3) * 1e3);
      return { ...base, ...coinBits(c), kind, multiple, claimTokens, claimSol: claimTokens * p };
    }
    case "claim": {
      const c = pickGrad();
      const multiple = r() < 0.15 ? between(r, 18, 42) : between(r, 10, 14);
      const p = medianOf(c);
      const tokens = Math.min(c.poolTokens * 0.1, Math.round((between(r, 0.3, 8) * 1e5) / 1e3) * 1e3);
      const fromQueue = r() < 0.25;
      return { ...base, ...coinBits(c), kind, multiple, tokens, sol: tokens * p, fromQueue, skippedAhead: fromQueue && r() < 0.5, auto: !fromQueue && r() < 0.4 };
    }
  }
}

const KIND_WEIGHTS: [FeedKind, number][] = [
  ["fumble", 0.42],
  ["cross", 0.24],
  ["claim", 0.26],
  ["launch", 0.04],
  ["graduation", 0.04],
];
function weightedKind(r: () => number): FeedKind {
  let x = r();
  for (const [k, w] of KIND_WEIGHTS) {
    if ((x -= w) <= 0) return k;
  }
  return "fumble";
}

let historyCache: FeedEvent[] | null = null;
function history(): FeedEvent[] {
  if (historyCache) return historyCache;
  const r = rng("feed-history");
  const out: FeedEvent[] = [];
  // Fixed beats so every kind is represented near the top.
  out.push(makeEvent("cross", "h-wbsc", EPOCH - 1 * MINUTE, SPEC_BY_SYMBOL.get("WBSC")));
  out.push(makeEvent("claim", "h-midc", EPOCH - 3 * MINUTE, SPEC_BY_SYMBOL.get("MIDC")));
  out.push(makeEvent("fumble", "h-cope", EPOCH - 4 * MINUTE, SPEC_BY_SYMBOL.get("COPE")));
  out.push(makeEvent("graduation", "h-bags", EPOCH - 9 * MINUTE, SPEC_BY_SYMBOL.get("BAGS")));
  out.push(makeEvent("launch", "h-lmbo", EPOCH - 9 * MINUTE - 20_000, SPEC_BY_SYMBOL.get("LMBO")));
  let ts = EPOCH - 12 * MINUTE;
  for (let i = 0; i < 44; i++) {
    let kind = weightedKind(r);
    if (kind === "launch" || kind === "graduation") kind = "fumble";
    out.push(makeEvent(kind, "h" + i, ts));
    ts -= between(r, 1.5, 9) * MINUTE;
  }
  out.push(makeEvent("launch", "h-slip", SPEC_BY_SYMBOL.get("SLIP")!.createdAt, SPEC_BY_SYMBOL.get("SLIP")));
  historyCache = out.sort((a, b) => b.ts - a.ts);
  return historyCache;
}

/* ── Leaderboards & profiles ──────────────────────────────────────────────── */

const u = (n: string) => addrOf(n);
function boardRows(board: Board): Omit<LeaderRow, "rank">[] {
  if (board === "fumbles")
    return [
      { address: u("whale_of_regret"), name: "whale_of_regret", symbol: "WBSC", soldForSol: 14.2, worthNowSol: 582.2, multiple: 41.0 },
      { address: u("nobody_sells"), name: "nobody_sells", symbol: "GOBT", soldForSol: 31.0, worthNowSol: 406.1, multiple: 13.1 },
      { address: anon("lb1"), symbol: "WBSC", soldForSol: 8.75, worthNowSol: 358.8, multiple: 41.0 },
      { address: u("quietcapital"), name: "quietcapital", symbol: "MIDC", soldForSol: 22.1, worthNowSol: 251.9, multiple: 11.4 },
      { address: u("degen_matt"), name: "degen_matt", symbol: "WBSC", soldForSol: 5.6, worthNowSol: 229.6, multiple: 41.0 },
      { address: u("sol_sister"), name: "sol_sister", symbol: "MIDC", soldForSol: 12.3, worthNowSol: 148.8, multiple: 12.1 },
      { address: u("frogcpa"), name: "frogcpa", symbol: "COPE", soldForSol: 15.0, worthNowSol: 123.0, multiple: 8.2 },
      { address: u("paperhandpete"), name: "paperhandpete", symbol: "FRGA", soldForSol: 30.4, worthNowSol: 103.4, multiple: 3.4 },
      { address: u("tuesday_trader"), name: "tuesday_trader", symbol: "CWCT", soldForSol: 9.9, worthNowSol: 88.1, multiple: 8.9 },
      { address: DEMO_WALLET, name: DEMO_NAME, symbol: "MIDC", soldForSol: 3.95, worthNowSol: 45.0, multiple: 11.4 },
    ];
  if (board === "claimers")
    return [
      { address: u("degen_matt"), name: "degen_matt", claims: 9, symbol: "WBSC", claimedSol: 121.4, multiple: 41.0 },
      { address: u("sol_sister"), name: "sol_sister", claims: 6, symbol: "MIDC", claimedSol: 88.9, multiple: 12.1 },
      { address: u("mfer_on_sol"), name: "mfer_on_sol", claims: 14, symbol: "GOBT", claimedSol: 61.0, multiple: 13.1 },
      { address: u("whale_of_regret"), name: "whale_of_regret", claims: 2, symbol: "WBSC", claimedSol: 58.2, multiple: 41.0 },
      { address: u("bagworker"), name: "bagworker", claims: 11, symbol: "COPE", claimedSol: 40.7, multiple: 10.0 },
      { address: u("gm_accountant"), name: "gm_accountant", claims: 5, symbol: "CWCT", claimedSol: 33.3, multiple: 15.6 },
      { address: DEMO_WALLET, name: DEMO_NAME, claims: 6, symbol: "WBSC", claimedSol: 17.9, multiple: 41.0 },
    ];
  return [
    { address: DEMO_WALLET, name: DEMO_NAME, symbol: "WBSC", unlockedAt: 12.0, claimedAtMultiple: 41.0, waitedDays: 34 },
    { address: anon("lb2"), symbol: "WBSC", unlockedAt: 10.2, claimedAtMultiple: 38.5, waitedDays: 29 },
    { address: u("sol_sister"), name: "sol_sister", symbol: "MIDC", unlockedAt: 10.0, claimedAtMultiple: 12.1, waitedDays: 22 },
    { address: u("bagworker"), name: "bagworker", symbol: "GOBT", unlockedAt: 10.4, claimedAtMultiple: 13.1, waitedDays: 19 },
    { address: anon("lb3"), symbol: "COPE", unlockedAt: 10.1, claimedAtMultiple: 10.9, waitedDays: 17 },
    { address: u("exit_ramp_ella"), name: "exit_ramp_ella", symbol: "CWCT", unlockedAt: 10.6, claimedAtMultiple: 14.2, waitedDays: 11 },
  ];
}

const ACHIEVEMENTS: Omit<Achievement, "earned">[] = [
  { id: "first", title: "First fumble", detail: "Filed a ticket", glyph: "ring" },
  { id: "tenbagger", title: "Ten-bagger regret", detail: "Ticket crossed 10×", glyph: "ring-dot" },
  { id: "thirty", title: "Waited for 30×", detail: "Claimed past 30×", glyph: "bar" },
  { id: "jumper", title: "Queue jumper", detail: "Small claim, paid first", glyph: "queue" },
  { id: "clean", title: "Clean wallet", detail: "90 days, zero flags", glyph: "check" },
  { id: "top", title: "Sold the top", detail: "Ticket expired below 1×", glyph: "down" },
];

function profileOf(addr: Address): Profile {
  if (addr === DEMO_WALLET) {
    return {
      address: addr,
      name: DEMO_NAME,
      level: 14,
      levelTitle: "certified early exit",
      xp: 7420,
      xpNext: 9000,
      fumbleRank: 212,
      ticketsFiled: 31,
      crossed10x: 6,
      claimedSol: 17.92,
      worst: { symbol: "WBSC", multiple: 41.0 },
      flagged: false,
      achievements: ACHIEVEMENTS.map((a) => ({ ...a, earned: a.id !== "top" })),
    };
  }
  const r = rng("profile:" + addr);
  const level = 1 + Math.floor(r() * 20);
  const titles = ["fresh exit", "early leaver", "certified early exit", "paper-handed professional", "regret connoisseur"];
  const filed = Math.floor(between(r, 1, 60));
  const crossed = Math.floor(filed * between(r, 0, 0.3));
  return {
    address: addr,
    name: nameOf(addr),
    level,
    levelTitle: titles[Math.min(titles.length - 1, Math.floor(level / 4.5))],
    xp: Math.floor(level * 520 * between(r, 0.2, 0.95)),
    xpNext: level * 520 + 1500,
    fumbleRank: Math.floor(between(r, 20, 4000)),
    ticketsFiled: filed,
    crossed10x: crossed,
    claimedSol: crossed * between(r, 0.3, 9),
    worst: crossed ? { symbol: pick(r, GRADUATED).symbol, multiple: between(r, 10, 40) } : undefined,
    flagged: r() < 0.05,
    achievements: ACHIEVEMENTS.map((a, i) => ({ ...a, earned: i === 0 || (i === 1 && crossed > 0) || r() < 0.3 })),
  };
}

/* ── The implementation ───────────────────────────────────────────────────── */

const bootedAt = typeof performance !== "undefined" ? performance.timeOrigin : 0;
/** The mock's clock: a frozen epoch on the server (deterministic prerenders), epoch + elapsed in the browser. */
function mockNow(): number {
  if (typeof window === "undefined") return EPOCH;
  return EPOCH + Math.max(0, Date.now() - bootedAt);
}

/** Deterministic recent trades for a coin (from its last-hour path), newest first. */
function tradesFor(c: CoinSpec): TradeRow[] {
  const r = rng("trades:" + c.symbol);
  const hour = lastHour(c.symbol);
  const out: TradeRow[] = [];
  for (let i = hour.length - 1, n = 0; i > 0 && n < 24; i -= 1 + Math.floor(r() * 4), n++) {
    const { t, p } = hour[i];
    const side = hour[i].p >= hour[i - 1].p ? "buy" : "sell";
    const sol = Math.exp(between(r, Math.log(0.05), Math.log(c.status === "curve" ? 3 : 25)));
    const name = r() < 0.5 ? pick(r, USERS) : null;
    out.push({
      signature: signature(`tr:${c.symbol}:${i}`),
      mint: mintAddress(c.symbol),
      wallet: name ? name.address : anon(`tr:${c.symbol}:${i}`),
      side,
      tokens: sol / p,
      sol,
      price: p,
      ts: t - Math.floor(r() * 50_000),
      venue: c.status === "graduated" ? "damm" : "dbc",
      app: appFor(r),
    });
  }
  if (c.symbol !== SNIPE_DEMO) return out;
  // LMBO's launch block: snipers paying the launch-window fee (shown as "snipe fee"), the creator's
  // first buy in the launch transaction at the normal fee. Kept within the 12 rows the coin page shows.
  const p0 = curvePriceAt(0);
  const launch: TradeRow[] = DEMO_SNIPES.map((x, i) => {
    const fee = (x.budget * x.bps) / 10_000;
    const sol = x.budget - fee;
    return {
      signature: signature(`snipe:${c.symbol}:${i}`),
      mint: mintAddress(c.symbol),
      wallet: anon(`sniper:${i}`),
      side: "buy" as const,
      tokens: sol / p0,
      sol,
      price: p0,
      ts: c.createdAt + (x.slot + 1) * 400,
      snipeTaxSol: (x.budget * (x.bps - PARAMS.feeBps)) / 10_000,
      snipeTaxBps: x.bps,
      venue: "dbc" as const,
      app: i === 1 ? "unknown_program" : "direct",
    };
  }).reverse();
  launch.push({ signature: signature(`launch:${c.symbol}`), mint: mintAddress(c.symbol), wallet: creatorOf(c), side: "buy", tokens: 0.5 / p0, sol: 0.5, price: p0, ts: c.createdAt, venue: "dbc", app: "fumpad" });
  return [...out.slice(0, 8), ...launch];
}

type Listener = (m: LiveMessage) => void;
const listeners = new Set<Listener>();
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let feedTimer: ReturnType<typeof setTimeout> | undefined;
let launchTimer: ReturnType<typeof setTimeout> | undefined;
let tickN = 0;

const emit = (m: LiveMessage) => {
  for (const l of [...listeners]) l(m);
};

/** One simulated trade on `c` at `ts`: moves price/curve, records the point + trade, emits coins + coin. */
function simTrade(c: CoinSpec, ts: number, opts: { buy?: boolean; sol?: number; wallet?: Address } = {}): TradeRow {
  const r = rng(`tick:${c.symbol}:${tickN++}`);
  const mint = mintAddress(c.symbol);
  const before = liveSpot(c);
  const buy = opts.buy ?? r() < 0.55;
  let sol = opts.sol ?? Math.exp(between(r, Math.log(0.05), Math.log(c.status === "curve" ? 1.5 : 12)));
  let graduates = false;
  if (c.status === "curve") {
    if (!buy) sol = Math.min(sol, Math.max(0, curveRaised(c) - 0.01));
    // A buy that fills the curve is partially filled and graduates the coin (as on chain).
    else if (curveRaised(c) + sol >= PARAMS.graduationSol) {
      sol = Math.max(0, PARAMS.graduationSol - curveRaised(c));
      graduates = true;
    }
    sim.raised.set(c.symbol, (sim.raised.get(c.symbol) ?? 0) + (buy ? sol : -sol));
  } else {
    const d = sim.drift.get(c.symbol) ?? 1;
    const move = opts.sol !== undefined ? Math.min(0.2, opts.sol / 400) : Math.abs(0.012 * gauss(r));
    sim.drift.set(c.symbol, Math.max(0.2, Math.min(5, d * Math.exp((buy ? 1 : -1) * move))));
  }
  bump(sim.count, c.symbol, 1);
  bump(sim.volume, c.symbol, sol);
  if (buy && r() < 0.6) bump(sim.holders, c.symbol, 1);
  if (graduates) {
    c.status = "graduated";
    c.graduatedAt = ts;
    c.mcapUsd = P_GRAD * SUPPLY * SOL_USD;
    sim.drift.set(c.symbol, 1);
  }
  const price = liveSpot(c);
  const who = opts.wallet ?? (r() < 0.5 ? pick(r, USERS).address : anon(`live:${c.symbol}:${tickN}`));
  // D33: trades inside the (stretched) launch window pay the scheduler's higher fee, buys and sells alike.
  const bps = mockFeeBps(c, ts);
  const tax = bps > PARAMS.feeBps ? (sol * (bps - PARAMS.feeBps)) / 10_000 : 0;
  if (tax > 0) {
    const cur = sessionSnipe.get(c.symbol) ?? { sol: 0, trades: 0 };
    sessionSnipe.set(c.symbol, { sol: cur.sol + tax, trades: cur.trades + 1 });
  }
  const trade: TradeRow = {
    signature: signature(`live:${c.symbol}:${tickN}`),
    mint,
    wallet: who,
    side: buy ? "buy" : "sell",
    tokens: (sol - tax) / ((before + price) / 2),
    sol: sol - tax,
    price,
    ts,
    venue: c.status === "graduated" && !graduates ? "damm" : "dbc",
    app: opts.wallet ? "fumpad" : appFor(r),
    ...(tax > 0 ? { snipeTaxSol: tax, snipeTaxBps: bps } : {}),
  };
  const point = { t: ts, p: price };
  sim.points.set(c.symbol, [...(sim.points.get(c.symbol) ?? []), point].slice(-500));
  sim.trades.set(c.symbol, [trade, ...(sim.trades.get(c.symbol) ?? [])].slice(0, 100));
  emit({ type: "coins", mints: [mint], wallets: [who] });
  emit({ type: "coin", coin: detail(c), trades: [trade], points: [point] });
  if (graduates) emit({ type: "feed", event: makeEvent("graduation", `live-grad:${c.symbol}`, ts, c) });
  return trade;
}

/** Release the next pending launch (client only): it joins the world and goes out like the indexer's launch. */
let launchN = 0;
function simLaunch(ts: number): boolean {
  const c = PENDING_LAUNCHES[launchN++];
  if (!c) return false;
  c.createdAt = ts;
  COIN_SPECS.push(c);
  const mint = mintAddress(c.symbol);
  emit({ type: "feed", event: makeEvent("launch", `live-launch:${c.symbol}`, ts, c) });
  emit({ type: "coins", mints: [mint], wallets: [creatorOf(c)] });
  emit({ type: "coin", coin: detail(c), trades: [], points: [{ t: ts, p: liveSpot(c) }] });
  return true;
}

/** Simulated wallet changes from mock-mode transactions, `${owner}:${mint}`. */
const balDelta = new Map<string, { sol: number; tokens: number }>();
/** Trades made in mock mode this session, per wallet (on top of the authored ledger). */
const sessionLedger = new Map<Address, MockEntry[]>();
/** Creator fees withdrawn in mock mode this session, by mint. */
const withdrawnNow = new Map<Address, number>();

/** Mock side of `withdraw_creator_fees`: the coin's withdrawable creator fees go to zero. */
export function mockWithdrawCreatorFees(mint: Address) {
  const c = specOf(mint);
  if (!c) return;
  const f = mockCreatorFees(c);
  withdrawnNow.set(mintAddress(c.symbol), f.earned - f.withdrawn);
}

function ledgerOf(owner: Address) {
  const base = baseLedger(owner);
  return { entries: [...base.entries, ...(sessionLedger.get(owner) ?? [])], external: base.external };
}

/** The mock's "chain" balance: what the ledger leaves plus tokens that arrived outside FUMPAD. */
function chainBalances(owner: Address): Map<string, number> {
  const { entries, external } = ledgerOf(owner);
  const out = new Map<string, number>();
  for (const [sym, b] of foldBooks(entries)) out.set(sym, b.held);
  for (const [sym, n] of Object.entries(external)) out.set(sym, (out.get(sym) ?? 0) + n);
  return out;
}

/** Open fumble tickets per coin and the best multiple among them (getTickets' view). */
function ticketStats(owner: Address): Map<string, { earned: number; open: number; best?: number }> {
  const out = new Map<string, { earned: number; open: number; best?: number }>();
  for (const t of ticketsFor(owner)) {
    const s = out.get(t.symbol) ?? { earned: 0, open: 0 };
    s.earned++;
    if (t.state === "claimable" || t.state === "tracking" || t.state === "awaiting-graduation" || t.state === "queued") {
      s.open++;
      s.best = Math.max(s.best ?? 0, t.multiple);
    }
    out.set(t.symbol, s);
  }
  return out;
}

function portfolioOf(owner: Address): { positions: WalletPosition[]; closed: ClosedPosition[] } {
  const books = foldBooks(ledgerOf(owner).entries);
  const balances = chainBalances(owner);
  const tickets = ticketStats(owner);
  const positions: WalletPosition[] = [];
  const closed: ClosedPosition[] = [];
  for (const sym of new Set([...books.keys(), ...balances.keys()])) {
    const c = SPEC_BY_SYMBOL.get(sym);
    if (!c) continue;
    const b = books.get(sym);
    const bal = balances.get(sym) ?? 0;
    const t = tickets.get(sym);
    watch(c);
    const ref = { mint: mintAddress(c.symbol), symbol: c.symbol, name: c.name, tile: c.tile, status: c.status, curveSol: curveRaised(c), graduationSol: PARAMS.graduationSol };
    if (b && isClosedBook(b, bal)) {
      closed.push({
        ...ref,
        boughtTokens: b.bought,
        boughtSol: b.boughtSol,
        soldTokens: b.sold,
        soldSol: b.soldSol,
        payoutTokens: b.payout,
        realizedSol: b.realized,
        realizedPct: b.costOfSold > 0 ? (b.realized / b.costOfSold) * 100 : undefined,
        partialBasis: b.oversold,
        firstTs: b.firstTs,
        lastTs: b.lastTs,
        ticketsEarned: t?.earned ?? 0,
      });
      continue;
    }
    if (bal <= 0) continue;
    const price = liveSpot(c);
    const held = b?.held ?? 0;
    const covered = Math.min(bal, held);
    const cost = held > 0 ? (b!.cost * covered) / held : 0;
    const unrealized = covered > 0 ? covered * price - cost : undefined;
    positions.push({
      ...ref,
      balance: bal,
      price,
      valueSol: bal * price,
      trackedTokens: held,
      avgCost: held > 0 ? b!.cost / held : 0,
      coveredTokens: covered,
      costSol: cost,
      unrealizedSol: unrealized,
      unrealizedPct: unrealized !== undefined && cost > 0 ? (unrealized / cost) * 100 : undefined,
      realizedSol: b?.realized ?? 0,
      partialBasis: bal > held + 1e-6 || !!b?.oversold,
      boughtTokens: b?.bought ?? 0,
      payoutTokens: b?.payout ?? 0,
      firstTs: b?.firstTs,
      lastTs: b?.lastTs,
      openTickets: t?.open ?? 0,
      bestMultiple: t?.open ? t.best : undefined,
    });
  }
  positions.sort((a, b) => b.valueSol - a.valueSol || a.symbol.localeCompare(b.symbol));
  closed.sort((a, b) => b.lastTs - a.lastTs);
  return { positions, closed };
}

/** Tickets filed by mock-mode sells this session. */
const filedTickets = new Map<Address, Ticket[]>();

/**
 * Mock side of a buy/sell (the simulated tx calls this, like the indexer would): the coin
 * trades, the wallet's balances move, and a sell worth the minimum files a ticket.
 */
export function mockRecordTrade(owner: Address, mintOrSymbol: string, side: Side, amountIn: number, amountOut: number) {
  const c = specOf(mintOrSymbol);
  if (!c || amountIn <= 0) return;
  const mint = mintAddress(c.symbol);
  const key = `${owner}:${mint}`;
  const d = balDelta.get(key) ?? { sol: 0, tokens: 0 };
  if (side === "buy") {
    d.sol -= amountIn;
    d.tokens += amountOut;
  } else {
    d.tokens -= amountIn;
    d.sol += amountOut;
  }
  balDelta.set(key, d);
  const sellPrice = liveSpot(c);
  const ts = mockData.now();
  const mine = sessionLedger.get(owner) ?? [];
  mine.push({ kind: side, symbol: c.symbol, tokens: side === "buy" ? amountOut : amountIn, sol: side === "buy" ? amountIn : amountOut, ts });
  sessionLedger.set(owner, mine);
  if (side === "sell" && amountOut * SOL_USD >= PARAMS.minSellUsd && owner !== creatorOf(c)) {
    const mine = filedTickets.get(owner) ?? [];
    const seq = mine.length + 100;
    const tokens = amountIn;
    const claimAmount = Math.round(tokens * (PARAMS.claimBps / 10_000));
    mine.unshift({
      id: address(`filed:${owner}:${c.symbol}:${seq}`),
      seq,
      owner,
      mint,
      symbol: c.symbol,
      coinName: c.name,
      tile: c.tile,
      coinStatus: c.status,
      tokens,
      originalTokens: tokens,
      sellPrice,
      source: "router",
      app: "fumpad",
      sellSignature: signature(`filed:${owner}:${c.symbol}:${seq}`),
      execPrice: sellPrice,
      sellSol: amountOut,
      sellUsd: amountOut * SOL_USD,
      sellTs: ts,
      expiresAt: ts + PARAMS.claimWindowSecs * 1000,
      chainStatus: "pending",
      state: "verifying",
      multiple: 1,
      peakMultiple: 1,
      claimAmount,
      claimValueSol: claimAmount * sellPrice,
      rebuyDebited: 0,
      autoClaim: !autoClaimOff.has(`${owner}:${mint}`),
    });
    filedTickets.set(owner, mine);
  }
  simTrade(c, ts, { buy: side === "buy", sol: side === "buy" ? amountIn : amountOut, wallet: owner });
}

export class MockFumpadData implements FumpadData {
  private live = 0;

  private startTicker() {
    if (tickTimer || typeof window === "undefined") return;
    const tick = () => {
      // Coins the UI read in the last 5 minutes trade every tick; one random coin keeps lists moving.
      const cutoff = Date.now() - 5 * 60_000;
      const hot = COIN_SPECS.filter((c) => (sim.watched.get(c.symbol) ?? 0) > cutoff);
      const r = rng("tickpick:" + tickN);
      const extra = pick(r, COIN_SPECS);
      for (const c of new Set([...hot, extra])) simTrade(c, this.now());
      // Keep the curve moving so the Launches board shows coins crossing 50% and graduating.
      const curve = COIN_SPECS.filter((c) => c.status === "curve" && c.createdAt <= this.now());
      // Half the picks go to coins past half the curve, so graduations happen within minutes.
      const late = curve.filter((c) => curveRaised(c) >= PARAMS.graduationSol / 2);
      for (let i = 0; i < 3 && curve.length; i++) {
        const c = pick(r, late.length && r() < 0.5 ? late : curve);
        const g = PARAMS.graduationSol;
        simTrade(c, this.now(), { buy: r() < 0.72, sol: Math.exp(between(r, Math.log(0.003 * g), Math.log(0.04 * g))) });
      }
      tickTimer = setTimeout(tick, between(r, 2200, 3800));
    };
    tickTimer = setTimeout(tick, 1500);
    const launch = () => {
      if (!simLaunch(this.now())) return;
      launchTimer = setTimeout(launch, between(rng("launchgap:" + launchN), 9_000, 18_000));
    };
    launchTimer = setTimeout(launch, 5_000);
    const feed = () => {
      const i = this.live++;
      const r = rng("live:" + i);
      let kind = weightedKind(r);
      if (kind === "launch" || kind === "graduation") kind = "fumble";
      emit({ type: "feed", event: makeEvent(kind, "live" + i, this.now()) });
      feedTimer = setTimeout(feed, between(r, 4500, 9000));
    };
    feedTimer = setTimeout(feed, 4000);
  }

  subscribeLive(cb: (m: LiveMessage) => void): Unsubscribe {
    if (typeof window === "undefined") return () => {};
    listeners.add(cb);
    this.startTicker();
    return () => {
      listeners.delete(cb);
      if (listeners.size) return;
      clearTimeout(tickTimer);
      clearTimeout(feedTimer);
      clearTimeout(launchTimer);
      tickTimer = feedTimer = launchTimer = undefined;
    };
  }

  async getParams(): Promise<ProtocolParams> {
    return { ...PARAMS };
  }

  async getRecentTrades(mint: Address, limit = 30): Promise<TradeRow[]> {
    const c = specOf(mint);
    if (!c) return [];
    watch(c);
    return [...(sim.trades.get(c.symbol) ?? []), ...tradesFor(c)].slice(0, limit);
  }

  now(): number {
    return mockNow();
  }

  async getSolUsd() {
    return SOL_USD;
  }

  async getStats(): Promise<PlatformStats> {
    return { paidBack24hSol: 412.86, crossings24h: 138, graduated24h: 17, openTickets: 48_207, solUsd: SOL_USD };
  }

  async listCoins(opts: { sort?: CoinSort; status?: "curve" | "graduated" | "all"; limit?: number } = {}) {
    const { sort = "trending", status = "all", limit } = opts;
    let list = COIN_SPECS.filter((c) => status === "all" || (status === "curve" ? c.status !== "graduated" : c.status === "graduated")).map(summary);
    const by = {
      trending: (a: CoinSummary, b: CoinSummary) => b.volume24hSol - a.volume24hSol,
      new: (a: CoinSummary, b: CoinSummary) => b.createdAt - a.createdAt,
      mcap: (a: CoinSummary, b: CoinSummary) => b.marketCapSol - a.marketCapSol,
      closest: (a: CoinSummary, b: CoinSummary) => b.ticketsOpen - a.ticketsOpen,
      graduating: (a: CoinSummary, b: CoinSummary) => (b.status === "curve" ? b.curveSol : -1) - (a.status === "curve" ? a.curveSol : -1),
    }[sort];
    list = list.sort(by);
    return limit ? list.slice(0, limit) : list;
  }

  async findCoinsBySymbol(symbol: string) {
    const c = SPEC_BY_SYMBOL.get(symbol.toUpperCase().replace(/^\$/, ""));
    if (c) watch(c);
    return c ? [summary(c)] : [];
  }

  async getCoin(symbolOrMint: string) {
    const c = specOf(symbolOrMint);
    watch(c);
    return c ? detail(c) : null;
  }

  async getPriceSeries(mint: Address, range: ChartRange) {
    const c = specOf(mint);
    watch(c);
    return c ? series(c, range) : [];
  }

  async getCandles(mint: Address, interval: CandleInterval): Promise<CandleSeries> {
    const c = specOf(mint);
    watch(c);
    return c ? candlesFor(c, interval) : { interval, from: windowStart(interval, mockNow()), candles: [] };
  }

  async getHolders(mint: Address, viewer?: Address) {
    const c = specOf(mint);
    return c ? holdersFor(c, viewer) : { total: 0, top: [] };
  }

  async getRecentFumbles(mint: Address, viewer?: Address) {
    const c = specOf(mint);
    return c ? fumblesFor(c, viewer) : [];
  }

  async getClaimQueue(mint: Address, viewer?: Address) {
    const c = specOf(mint);
    if (!c || c.status !== "graduated") return { pool: c ? poolTokensOf(c) : 0, owed: 0, entries: [] };
    const entries = queueFor(c, viewer);
    return { pool: c.poolTokens, owed: entries.reduce((a, e) => a + e.amount, 0), entries };
  }

  async getFeed(opts: { kind?: FeedKind | "all"; before?: number; limit?: number } = {}) {
    const { kind = "all", before = Infinity, limit = 30 } = opts;
    return history()
      .filter((e) => (kind === "all" || e.kind === kind) && e.ts < before)
      .slice(0, limit);
  }

  subscribeFeed(cb: (e: FeedEvent) => void): Unsubscribe {
    return this.subscribeLive((m) => {
      if (m.type === "feed") cb(m.event);
    });
  }

  async getClosestTo10x(limit = 5, viewer?: Address): Promise<CloseCall[]> {
    const r = rng("closest");
    const rows: CloseCall[] = [];
    for (const c of GRADUATED.slice(0, 6)) {
      const who = r() < 0.5 ? pick(r, USERS) : { address: anon("cl" + c.symbol), name: undefined };
      rows.push({
        ticket: address("cl:" + c.symbol),
        symbol: c.symbol,
        mint: mintAddress(c.symbol),
        owner: who.address,
        ownerName: who.name,
        multiple: between(r, 7.2, 9.85),
      });
    }
    if (viewer) {
      const mine = ticketsFor(viewer)
        .filter((t) => t.state === "tracking")
        .sort((a, b) => b.multiple - a.multiple)[0];
      if (mine)
        rows.push({ ticket: mine.id, symbol: mine.symbol, mint: mine.mint, owner: viewer, ownerName: nameOf(viewer), multiple: mine.multiple, isYou: true });
    }
    return rows.sort((a, b) => b.multiple - a.multiple).slice(0, limit);
  }

  async getTickets(owner: Address) {
    const ts = ticketsFor(owner);
    for (const t of ts) if (t.state !== "claimed" && t.state !== "expired" && t.state !== "voided") watch(SPEC_BY_SYMBOL.get(t.symbol));
    return ts;
  }

  async getTicket(id: Address) {
    // Any wallet whose tickets this process has built (a profile, a connected wallet), then
    // the demo wallet and the named users, so share links work for every ticket the UI shows.
    const known = ticketOwners.get(id);
    for (const owner of [...(known ? [known] : []), DEMO_WALLET, ...USERS.map((u) => u.address)]) {
      const t = ticketsFor(owner).find((x) => x.id === id);
      if (t) return t;
    }
    return null;
  }

  /** Mock-only: reflect an escrow withdrawal made in this session. */
  markEscrowWithdrawn(id: Address) {
    ticketOverrides.set(id, { ...ticketOverrides.get(id), escrowed: false, chainStatus: "claimed" });
  }

  /** Mock-only: reflect a claim made in this session. */
  markClaimed(id: Address, at: number) {
    ticketOverrides.set(id, { state: "claimed", chainStatus: "claimed", claimedAt: at, claimTx: signature(id), expiresAt: undefined });
  }

  async getLeaderboard(board: Board, viewer?: Address) {
    return boardRows(board).map((row, i) => ({ ...row, mint: row.symbol ? mintAddress(row.symbol) : undefined, rank: i + 1, isYou: viewer ? row.address === viewer : false }));
  }

  async getProfile(addressOrName: string) {
    const a = addrOf(addressOrName);
    if (a.length < 32) return null;
    return profileOf(a);
  }

  async getBalances(wallet: Address, mint: Address) {
    const c = specOf(mint);
    const r = rng(`bal:${wallet}:${mint}`);
    if (!c) return { sol: 0, tokens: 0, maturedTokens: 0 };
    // Tokens follow the wallet's ledger (portfolio tabs agree), session trades included.
    const tokens = Math.max(0, chainBalances(wallet).get(c.symbol) ?? 0);
    const sol = wallet === DEMO_WALLET ? 24.8 : Math.round(between(r, 0.2, 40) * 100) / 100;
    // Session buys haven't been held long enough to count yet.
    const d = balDelta.get(`${wallet}:${mintAddress(c.symbol)}`) ?? { sol: 0, tokens: 0 };
    const settled = tokens - Math.max(0, d.tokens);
    const matured = c.symbol === "PIGN" ? Math.round(settled * 0.6) : settled;
    return { sol: Math.max(0, sol + d.sol), tokens, maturedTokens: Math.max(0, Math.min(tokens, matured)) };
  }

  async getPositions(wallet: Address): Promise<WalletPosition[]> {
    return portfolioOf(wallet).positions;
  }

  async getClosedPositions(wallet: Address): Promise<ClosedPosition[]> {
    return portfolioOf(wallet).closed;
  }

  /** The demo world has no backend: everything is fine, by construction. */
  async getStatus(): Promise<SystemStatus> {
    const at = this.now();
    const svc = (name: "api" | "indexer" | "keeper") => ({ name, sha: "mock", deploymentId: null, startedAt: EPOCH, seenAt: at });
    return {
      level: "ok",
      at,
      indexer: { level: "ok", lagSecs: 1, lastTxAgeSecs: 4, tipSlot: null },
      keeper: { level: "ok", lastSampleAgeSecs: 95, graduatedCoins: COIN_SPECS.filter((c) => c.status === "graduated").length },
      vanityPool: { level: "ok", available: 200, reserved: 1 },
      services: [svc("api"), svc("indexer"), svc("keeper")],
    };
  }

  /**
   * Fumble Checker over the mock world: every ticket of the wallet as an attested sell, plus, on the coin of its
   * newest ticket, three sells without one (verifying, under the minimum, held too briefly) so every state shows.
   */
  async getWalletFumbles(wallet: Address, mint?: Address): Promise<WalletFumbles> {
    const now = this.now();
    const tickets = ticketsFor(wallet).filter((t) => !mint || t.mint === mint);
    const byMint = new Map<Address, Ticket[]>();
    for (const t of tickets) byMint.set(t.mint, [...(byMint.get(t.mint) ?? []), t]);
    if (mint && !byMint.size && specOf(mint)) byMint.set(mint, []);
    const target = (sellPrice: number, claimTokens: number, estimated: boolean) => ({
      sellPrice,
      estimated,
      targetPrice: sellPrice * PARAMS.triggerMultiple,
      targetMarketCapSol: sellPrice * PARAMS.triggerMultiple * PARAMS.totalSupply,
      claimTokens,
      claimValueSolAtTarget: claimTokens * sellPrice * PARAMS.triggerMultiple,
    });
    const coins: WalletCoinFumbles[] = [];
    let first = true;
    for (const [m, ts] of byMint) {
      const c = specOf(m);
      if (!c) continue;
      const sells: FumbleSell[] = ts.map((t) => ({
        signature: t.sellSignature ?? signature("sell:" + t.id),
        ts: t.sellTs,
        venue: c.status === "graduated" ? "damm" : "dbc",
        app: t.source === "router" ? "fumpad" : t.app,
        tokens: t.originalTokens,
        sol: t.sellSol,
        usd: t.sellUsd,
        usdBasis: "attested",
        countedTokens: t.originalTokens,
        checks: { usd: "ok", hold: "ok", creator: "ok" },
        outcome: "ticket",
        ticket: t,
        target: target(t.sellPrice, t.claimAmount, false),
      }));
      if (first && wallet !== creatorOf(c)) {
        first = false;
        const spot = summary(c).price;
        const r = rng("checker:" + wallet + c.symbol);
        const tok = Math.round(between(r, 200_000, 2_000_000));
        sells.push({
          signature: signature("v:" + wallet + c.symbol), ts: now - 40_000, venue: "dbc", app: "axiom", tokens: tok, sol: tok * spot, usd: tok * spot * SOL_USD,
          usdBasis: "current", countedTokens: tok, checks: { usd: "ok", hold: "ok", creator: "ok" }, outcome: "verifying", target: target(spot, (tok * PARAMS.claimBps) / 10_000, true),
        });
        const small = Math.max(1, Math.round((20 / SOL_USD / spot) * between(r, 0.3, 0.9)));
        sells.push({
          signature: signature("s:" + wallet + c.symbol), ts: now - 3 * HOUR, venue: "dbc", app: "jupiter", tokens: small, sol: small * spot, usd: small * spot * SOL_USD,
          usdBasis: "nearby", countedTokens: small, checks: { usd: "fail", hold: "ok", creator: "ok" }, outcome: "no-ticket", reason: "below_minimum_usd",
        });
        sells.push({
          signature: signature("h:" + wallet + c.symbol), ts: now - 26 * HOUR, venue: "dbc", app: "gmgn", tokens: tok, sol: tok * spot * 0.6, usd: tok * spot * 0.6 * SOL_USD,
          usdBasis: "nearby", countedTokens: 0, checks: { usd: "ok", hold: "fail", creator: "ok" }, outcome: "no-ticket", reason: "not_matured",
        });
      }
      sells.sort((a, b) => b.ts - a.ts);
      coins.push({ coin: summary(c), fees: detail(c).fees, isCreator: wallet === creatorOf(c), sells });
    }
    coins.sort((a, b) => (b.sells[0]?.ts ?? 0) - (a.sells[0]?.ts ?? 0));
    return { wallet, found: tickets.length > 0, coins, asOf: now };
  }

  async getCreatedCoins(wallet: Address): Promise<CreatedCoin[]> {
    return COIN_SPECS.filter((c) => creatorOf(c) === wallet && c.createdAt <= this.now())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((c) => {
        const f = mockCreatorFees(c);
        const extra = withdrawnNow.get(mintAddress(c.symbol)) ?? 0;
        const withdrawn = f.withdrawn + extra;
        return { ...summary(c), feesEarnedSol: f.earned, feesWithdrawnSol: withdrawn, feesWithdrawableSol: Math.max(0, f.earned - withdrawn) };
      });
  }

  /**
   * Meteora math (`../meteora`): the DBC curve before graduation (a buy that would pass the
   * migration price is partially filled), DAMM v2 after; the fee in SOL, the scheduler's higher
   * fee in the launch window; the ticket rules the keepers apply to every sell.
   */
  async quoteTrade({ mint, side, amount, wallet }: { mint: Address; side: Side; amount: number; wallet?: Address }): Promise<TradeQuote> {
    const c = specOf(mint)!;
    const d = detail(c);
    const onCurve = c.status !== "graduated";
    const reserves = onCurve ? curveReservesAt(PARAMS.initialVirtualSol, PARAMS.initialVirtualTokens, curveRaised(c)) : { sol: d.ammSol!, tokens: d.ammTokens! };
    const feeBps = mockFeeBps(c, this.now(), { quote: true });
    const venue = onCurve ? ("dbc" as const) : ("damm" as const);
    const fees = (feeSol: number, normalFeeSol: number) => {
      const sp = splitFee(feeSol, PARAMS);
      return {
        feeSol,
        feePoolSol: sp.pool,
        feePlatformSol: sp.platform,
        feeCreatorSol: sp.creator,
        venueFeeSol: sp.venue,
        ...(feeBps > PARAMS.feeBps && feeSol > normalFeeSol ? { snipeTaxSol: feeSol - normalFeeSol, snipeTaxBps: feeBps } : {}),
      };
    };
    const tickets = wallet ? ticketsFor(wallet).filter((t) => t.symbol === c.symbol) : [];
    const open = tickets.filter((t) => t.chainStatus === "open" || t.chainStatus === "queued" || t.chainStatus === "pending");

    if (side === "buy") {
      const q = quoteBuy(reserves, amount, feeBps, onCurve ? d.curveTokensLeft : Infinity);
      const out = q.amountOut;
      const now = this.now();
      const recent = open.filter((t) => now - t.sellTs < PARAMS.rebuyWindowSecs * 1000).sort((a, b) => b.sellTs - a.sellTs);
      let left = out;
      const hit = recent.map((t) => {
        const debit = Math.min(left, t.tokens);
        left -= debit;
        return { id: t.id, symbol: t.symbol, tokens: t.tokens, debit, soldAgo: now - t.sellTs };
      });
      return {
        side,
        amountIn: Math.max(0, amount || 0),
        amountOut: out,
        ...fees(q.feeSol, (q.amountIn * PARAMS.feeBps) / 10_000),
        spotBefore: q.spotBefore,
        execPrice: q.execPrice,
        priceImpact: out > 0 ? (q.execPrice / q.spotBefore - 1) * 100 : 0,
        venue,
        partialFill: q.completesCurve || undefined,
        usedSol: q.completesCurve ? q.amountIn : undefined,
        rebuyWarning: hit.length ? { tickets: hit.filter((h) => h.debit > 0), totalDebit: out - left } : undefined,
      };
    }

    // sell
    const q = quoteSell(reserves, amount, feeBps);
    const amt = q.amountIn;
    const exec = q.execPrice;
    const spotBefore = q.spotBefore;
    const bal = wallet ? await this.getBalances(wallet, mint) : { tokens: amt, maturedTokens: amt, sol: 0 };
    const ticketTokens = Math.min(amt, bal.maturedTokens);
    const usdValue = ticketTokens * exec * SOL_USD;
    const floor = (d.referencePrice * exec) / spotBefore;
    const ticketPrice = Math.max(exec, floor);
    const isCreator = wallet === d.creator;
    const reason = isCreator
      ? "creator"
      : open.length >= PARAMS.maxOpenTickets
        ? "max-open"
        : ticketTokens <= 0
          ? "not-matured"
          : usdValue < PARAMS.minSellUsd
            ? "under-min"
            : undefined;
    return {
      side,
      amountIn: amt,
      amountOut: q.amountOut,
      ...fees(q.feeSol, (q.feeSol * PARAMS.feeBps) / feeBps),
      spotBefore,
      execPrice: exec,
      priceImpact: amt > 0 ? (1 - exec / spotBefore) * -100 : 0,
      venue,
      ticket: {
        files: !reason && amt > 0,
        reason,
        usdValue,
        tokens: ticketTokens,
        execPrice: exec,
        floorPrice: floor,
        ticketPrice,
        floorApplied: floor > exec,
        triggerPrice: ticketPrice * PARAMS.triggerMultiple,
        claimTokens: ticketTokens * (PARAMS.claimBps / 10_000),
        openTickets: open.length,
        maxOpenTickets: PARAMS.maxOpenTickets,
      },
    };
  }
}

export const mockData = new MockFumpadData();
