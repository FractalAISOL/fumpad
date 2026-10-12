import { PARAMS, cpOut, curvePriceAt } from "../chain";
import type { CoinSort, FumpadData, Unsubscribe } from "../interface";
import type {
  Achievement,
  Address,
  Board,
  ChartRange,
  CloseCall,
  CoinDetail,
  CoinSummary,
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
  Ticket,
  TicketChainStatus,
  TradeQuote,
  TradeRow,
} from "../types";
import { mintAddress, signature } from "./rng";
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
const VENUE_FEE = 0.0025;

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
};
const watch = (c: CoinSpec | undefined) => {
  // Client only: the server must not read the clock (prerender) and never ticks anyway.
  if (c && typeof window !== "undefined") sim.watched.set(c.symbol, Date.now());
};
function curveRaised(c: CoinSpec): number {
  if (c.status !== "curve") return PARAMS.graduationSol;
  return Math.min(PARAMS.graduationSol * 0.995, Math.max(0, (c.raised ?? 0) + (sim.raised.get(c.symbol) ?? 0)));
}
function liveSpot(c: CoinSpec): number {
  return c.status === "curve" ? curvePriceAt(curveRaised(c)) : spotOf(c) * (sim.drift.get(c.symbol) ?? 1);
}
function liveMedian(c: CoinSpec): number {
  return medianOf(c) * (sim.drift.get(c.symbol) ?? 1);
}

function ticketsOpenOn(c: CoinSpec): number {
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
    volume24hSol: c.volume24hUsd / SOL_USD,
    marketCapSol: price * SUPPLY,
    holders: c.holders,
    curveSol: curveRaised(c),
    graduationSol: PARAMS.graduationSol,
    poolTokens: c.poolTokens,
    ticketsOpen: ticketsOpenOn(c),
    spark: [...spark(c.symbol).slice(0, -1), price],
  };
}

function poolBought24h(c: CoinSpec): number {
  const solToPool = (c.volume24hUsd / SOL_USD) * FEE * (PARAMS.feePoolShareBps / 10_000);
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
    poolSeeded: PARAMS.rewardPoolSupply,
    poolBought24h: poolBought24h(c),
    poolPaidOut: grad ? Math.round(between(r, 2, 30) * 1e6) : 0,
    queueOwed: queue.reduce((a, q) => a + q.amount, 0),
    ticketsCreated: s.ticketsOpen + Math.round(s.ticketsOpen * between(r, 0.4, 1.6)),
    ticketsPast10x: grad ? Math.round(between(r, 3, 40)) : Math.round(between(r, 0, 12)),
    referencePrice: price * c.refRatio,
    ammPool: grad ? address("amm:" + c.symbol) : undefined,
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

/* ── Tickets ──────────────────────────────────────────────────────────────── */

const ticketOverrides = new Map<string, Partial<Ticket>>();
/** D17 auto-claim opt-outs, `${owner}:${mint}` (on by default). */
const autoClaimOff = new Set<string>();
/** Mock side of `set_auto_claim` (the simulated tx updates this so refetches agree). */
export function mockSetAutoClaim(owner: Address, mint: Address, enabled: boolean) {
  if (enabled) autoClaimOff.delete(`${owner}:${mint}`);
  else autoClaimOff.add(`${owner}:${mint}`);
}

function buildTicket(owner: Address, t: TicketSpec): Ticket {
  const c = SPEC_BY_SYMBOL.get(t.symbol)!;
  const id = address(`ticket:${owner}:${t.symbol}:${t.seq}`);
  const sellPrice = owner === DEMO_WALLET ? ticketSellPrice(t) : medianOf(c) / t.multiple;
  const execPrice = t.floorApplied ? sellPrice * 0.94 : sellPrice;
  const claimAmount = Math.round(t.tokens * (PARAMS.claimBps / 10_000));
  const median = c.status === "graduated" ? liveMedian(c) : liveSpot(c);
  const chainStatus: TicketChainStatus =
    t.state === "queued" ? "queued" : t.state === "claimed" ? "claimed" : t.state === "expired" ? "expired" : t.state === "voided" ? "voided" : "open";
  const queued = t.state === "queued";
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
    execPrice,
    sellSol: t.originalTokens * execPrice,
    sellUsd: t.originalTokens * execPrice * SOL_USD,
    sellTs: t.sellTs,
    expiresAt: queued || t.state === "claimed" ? undefined : t.sellTs + PARAMS.claimWindowSecs * 1000,
    chainStatus,
    state: t.state,
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
    rebuyDebited: t.originalTokens - t.tokens,
    autoClaim: !autoClaimOff.has(`${owner}:${mintAddress(c.symbol)}`),
    autoClaimed: t.state === "claimed" && t.seq % 2 === 0 ? true : undefined,
  };
  return { ...base, ...ticketOverrides.get(id) };
}

function ticketsFor(owner: Address): Ticket[] {
  const specs = owner === DEMO_WALLET ? DEMO_TICKETS : generatedTickets(owner);
  const filed = (filedTickets.get(owner) ?? []).map((t) => {
    const c = SPEC_BY_SYMBOL.get(t.symbol)!;
    const now = c.status === "graduated" ? liveMedian(c) : liveSpot(c);
    const multiple = now / t.sellPrice;
    return { ...t, multiple, peakMultiple: Math.max(t.peakMultiple, multiple), claimValueSol: t.claimAmount * now, autoClaim: !autoClaimOff.has(`${owner}:${t.mint}`) };
  });
  return [...filed, ...specs.map((s) => buildTicket(owner, s))];
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
    top.push({ address: d.ammPool!, label: "PumpSwap pool", kind: "amm", share: ((d.ammTokens ?? 0) / SUPPLY) * 100 });
  } else {
    top.push({
      address: address("curve:" + c.symbol),
      label: "Bonding curve",
      kind: "amm",
      share: ((PARAMS.curveSupply - (c.raised ?? 0) * 6e6) / SUPPLY) * 100,
    });
  }
  top.push({ address: address("pool:" + c.symbol), label: "Reward pool", kind: "pool", share: (c.poolTokens / SUPPLY) * 100 });
  top.push({ address: creatorOf(c), label: "Creator", kind: "creator", share: between(r, 1.2, 4.6) });
  let s = between(r, 2.6, 3.8);
  for (let i = 0; i < 5; i++) {
    const who = r() < 0.4 ? pick(r, USERS).address : anon(`${c.symbol}h${i}`);
    top.push({ address: who, label: nameOf(who), kind: who === viewer ? "you" : "holder", share: s });
    s *= between(r, 0.7, 0.92);
  }
  if (viewer === DEMO_WALLET && c.status === "graduated") {
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
    rows.push({ ticket: address(`f:${c.symbol}:${i}`), owner, ownerName: name, tokens, sol, ts, multiple: median / Math.max(p, ticketPriceFloor(c, p)) });
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
      return { ...base, actor: creatorOf(c), actorName: nameOf(creatorOf(c)), ...coinBits(c), kind, poolTokens: PARAMS.rewardPoolSupply };
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
      return { ...base, ...coinBits(c), kind, sol, tokens: sol / p, ticketPrice: p };
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
    out.push({ signature: signature(`tr:${c.symbol}:${i}`), mint: mintAddress(c.symbol), wallet: name ? name.address : anon(`tr:${c.symbol}:${i}`), side, tokens: sol / p, sol, price: p, ts: t - Math.floor(r() * 50_000) });
  }
  return out;
}

type Listener = (m: LiveMessage) => void;
const listeners = new Set<Listener>();
let tickTimer: ReturnType<typeof setTimeout> | undefined;
let feedTimer: ReturnType<typeof setTimeout> | undefined;
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
  if (c.status === "curve") {
    if (!buy) sol = Math.min(sol, Math.max(0, curveRaised(c) - 0.01));
    sim.raised.set(c.symbol, (sim.raised.get(c.symbol) ?? 0) + (buy ? sol : -sol));
  } else {
    const d = sim.drift.get(c.symbol) ?? 1;
    const move = opts.sol !== undefined ? Math.min(0.2, opts.sol / 400) : Math.abs(0.012 * gauss(r));
    sim.drift.set(c.symbol, Math.max(0.2, Math.min(5, d * Math.exp((buy ? 1 : -1) * move))));
  }
  const price = liveSpot(c);
  const who = opts.wallet ?? (r() < 0.5 ? pick(r, USERS).address : anon(`live:${c.symbol}:${tickN}`));
  const trade: TradeRow = { signature: signature(`live:${c.symbol}:${tickN}`), mint, wallet: who, side: buy ? "buy" : "sell", tokens: sol / ((before + price) / 2), sol, price, ts };
  const point = { t: ts, p: price };
  sim.points.set(c.symbol, [...(sim.points.get(c.symbol) ?? []), point].slice(-500));
  sim.trades.set(c.symbol, [trade, ...(sim.trades.get(c.symbol) ?? [])].slice(0, 100));
  emit({ type: "coins", mints: [mint], wallets: [who] });
  emit({ type: "coin", coin: detail(c), trades: [trade], points: [point] });
  return trade;
}

/** Simulated wallet changes from mock-mode transactions, `${owner}:${mint}`. */
const balDelta = new Map<string, { sol: number; tokens: number }>();
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
      execPrice: sellPrice,
      sellSol: amountOut,
      sellUsd: amountOut * SOL_USD,
      sellTs: ts,
      expiresAt: ts + PARAMS.claimWindowSecs * 1000,
      chainStatus: "open",
      state: c.status === "graduated" ? "tracking" : "awaiting-graduation",
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
      tickTimer = setTimeout(tick, between(r, 2200, 3800));
    };
    tickTimer = setTimeout(tick, 1500);
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
      tickTimer = feedTimer = undefined;
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
    if (typeof window === "undefined") return EPOCH;
    return EPOCH + Math.max(0, Date.now() - bootedAt);
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
    if (!c || c.status !== "graduated") return { pool: c?.poolTokens ?? 0, owed: 0, entries: [] };
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
    for (const owner of [DEMO_WALLET]) {
      const t = ticketsFor(owner).find((x) => x.id === id);
      if (t) return t;
    }
    return null;
  }

  /** Mock-only: reflect a claim made in this session. */
  markClaimed(id: Address, at: number) {
    ticketOverrides.set(id, { state: "claimed", chainStatus: "claimed", claimedAt: at, claimTx: signature(id), expiresAt: undefined });
  }

  async getLeaderboard(board: Board, viewer?: Address) {
    return boardRows(board).map((row, i) => ({ ...row, rank: i + 1, isYou: viewer ? row.address === viewer : false }));
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
    const tokens = wallet === DEMO_WALLET && c.symbol === "MIDC" ? 6_120_000 : Math.round(between(r, 0, 8) * 1e5) * 10;
    const matured = c.symbol === "PIGN" ? Math.round(tokens * 0.6) : tokens;
    const sol = wallet === DEMO_WALLET ? 24.8 : Math.round(between(r, 0.2, 40) * 100) / 100;
    // Session trades: bought tokens haven't been held long enough to count yet.
    const d = balDelta.get(`${wallet}:${mintAddress(c.symbol)}`) ?? { sol: 0, tokens: 0 };
    return { sol: Math.max(0, sol + d.sol), tokens: Math.max(0, tokens + d.tokens), maturedTokens: Math.max(0, matured + Math.min(0, d.tokens)) };
  }

  async quoteTrade({ mint, side, amount, wallet }: { mint: Address; side: Side; amount: number; wallet?: Address }): Promise<TradeQuote> {
    const c = specOf(mint)!;
    const d = detail(c);
    const onCurve = c.status !== "graduated";
    const x = onCurve ? d.virtualSol : d.ammSol!;
    const y = onCurve ? d.virtualTokens : d.ammTokens!;
    const spotBefore = x / y;
    const amt = Math.max(0, amount || 0);
    const split = (fee: number) => ({
      feeSol: fee,
      feePoolSol: fee * (PARAMS.feePoolShareBps / 10_000),
      feePlatformSol: fee * (PARAMS.feePlatformShareBps / 10_000),
      feeCreatorSol: fee * (PARAMS.feeCreatorShareBps / 10_000),
    });
    const tickets = wallet ? ticketsFor(wallet).filter((t) => t.symbol === c.symbol) : [];
    const open = tickets.filter((t) => t.chainStatus === "open" || t.chainStatus === "queued");

    if (side === "buy") {
      const fee = amt * FEE;
      const venueFee = onCurve ? 0 : (amt - fee) * VENUE_FEE;
      const solNet = amt - fee - venueFee;
      let out = solNet > 0 ? cpOut(x, y, solNet) : 0;
      let partialFill = false;
      if (onCurve && out > d.curveTokensLeft) {
        out = d.curveTokensLeft;
        partialFill = true;
      }
      const exec = out > 0 ? (amt - fee) / out : spotBefore;
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
        amountIn: amt,
        amountOut: out,
        ...split(fee),
        venueFeeSol: venueFee,
        spotBefore,
        execPrice: exec,
        priceImpact: out > 0 ? (exec / spotBefore - 1) * 100 : 0,
        venue: onCurve ? "curve" : "pumpswap",
        partialFill,
        rebuyWarning: hit.length ? { tickets: hit.filter((h) => h.debit > 0), totalDebit: out - left } : undefined,
      };
    }

    // sell
    const gross = amt > 0 ? cpOut(y, x, amt) : 0;
    const venueFee = onCurve ? 0 : gross * VENUE_FEE;
    const fee = (gross - venueFee) * FEE;
    const exec = amt > 0 ? (gross - venueFee) / amt : spotBefore;
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
      amountOut: gross - venueFee - fee,
      ...split(fee),
      venueFeeSol: venueFee,
      spotBefore,
      execPrice: exec,
      priceImpact: amt > 0 ? (1 - exec / spotBefore) * -100 : 0,
      venue: onCurve ? "curve" : "pumpswap",
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
