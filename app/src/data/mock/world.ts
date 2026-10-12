/**
 * The mock world: hand-authored coins, people and the demo wallet's tickets, plus
 * deterministic generators for everything else. Numbers obey the program's rules
 * (curve math, 10% claim, 10%-of-pool cap, 90-day window, rebuy debits).
 */

import { PARAMS, curvePriceAt } from "../chain";
import type { CoinStatus, TicketState } from "../types";
import { address, between, gauss, hash, mintAddress, pick, rng } from "./rng";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The mock's frozen "now": Oct 11 2026, 14:00 UTC. */
export const EPOCH = Date.UTC(2026, 9, 11, 14, 0, 0);
export const SOL_USD = 152.4;

const d = (month: number, day: number, h = 12, m = 0) => Date.UTC(2026, month - 1, day, h, m);

export const P0 = curvePriceAt(0);
export const P_GRAD = curvePriceAt(PARAMS.graduationSol);

/* ── People ────────────────────────────────────────────────────────────────── */

export const DEMO_WALLET = "7xKp" + address("demo-wallet").slice(4, 40) + "3fQe";
export const DEMO_NAME = "ramen_maxi";

export const HANDLES = [
  "degen_matt",
  "sol_sister",
  "quietcapital",
  "paperhandpete",
  "frogcpa",
  "nobody_sells",
  "mfer_on_sol",
  "bagworker",
  "whale_of_regret",
  "anon_7731",
  "exit_ramp_ella",
  "gm_accountant",
  "tuesday_trader",
  "liquidated_luke",
] as const;

const NAME_BY_ADDR = new Map<string, string>();
NAME_BY_ADDR.set(DEMO_WALLET, DEMO_NAME);
export const USERS = HANDLES.map((h) => {
  const a = address("user:" + h);
  NAME_BY_ADDR.set(a, h);
  return { name: h as string, address: a };
});
export function nameOf(addr: string): string | undefined {
  return NAME_BY_ADDR.get(addr);
}
export function addrOf(nameOrAddr: string): string {
  if (nameOrAddr === DEMO_NAME) return DEMO_WALLET;
  const u = USERS.find((x) => x.name === nameOrAddr);
  return u ? u.address : nameOrAddr;
}
/** Anonymous wallets that trade but never set a name. */
export function anon(seed: string): string {
  return address("anon:" + seed);
}

/* ── Coins ─────────────────────────────────────────────────────────────────── */

export interface CoinSpec {
  symbol: string;
  name: string;
  tile: 0 | 1 | 2;
  description: string;
  status: CoinStatus;
  createdAt: number;
  graduatedAt?: number;
  /** Graduated: market cap in USD. */
  mcapUsd?: number;
  /** Curve: real SOL raised. */
  raised?: number;
  raised1h?: number;
  change24h: number;
  holders: number;
  poolTokens: number;
  volume24hUsd: number;
  /** D10 reference vs spot. > 1 on a coin that's sliding (the floor kicks in). */
  refRatio: number;
}

export const COIN_SPECS: CoinSpec[] = [
  {
    symbol: "MIDC",
    name: "Mid Curve Mike",
    tile: 0,
    description: "Bell curve meme. Mike buys the middle and sells the middle. Mike is fine.",
    status: "graduated",
    createdAt: d(8, 14, 9),
    graduatedAt: d(8, 16, 13),
    mcapUsd: 1.63e6,
    change24h: 38.2,
    holders: 2914,
    poolTokens: 9_620_400,
    volume24hUsd: 412_000,
    refRatio: 0.97,
  },
  {
    symbol: "COPE",
    name: "Cope Harbor",
    tile: 1,
    description: "A safe harbor for people who sold the bottom. Lighthouse not included.",
    status: "graduated",
    createdAt: d(8, 21, 15),
    graduatedAt: d(8, 24, 2),
    mcapUsd: 0.94e6,
    change24h: 12.7,
    holders: 1840,
    poolTokens: 21_400_000,
    volume24hUsd: 188_000,
    refRatio: 0.99,
  },
  {
    symbol: "GOBT",
    name: "Goblin Treasury",
    tile: 2,
    description: "The goblins manage the treasury. The treasury is mostly shiny rocks.",
    status: "graduated",
    createdAt: d(7, 30, 18),
    graduatedAt: d(8, 2, 11),
    mcapUsd: 2.71e6,
    change24h: -6.3,
    holders: 4120,
    poolTokens: 1_900_000,
    volume24hUsd: 640_000,
    refRatio: 1.04,
  },
  {
    symbol: "FRGA",
    name: "Frog Accountant",
    tile: 0,
    description: "Files your taxes in lily pads. Audited by another frog.",
    status: "graduated",
    createdAt: d(7, 18, 10),
    graduatedAt: d(7, 20, 21),
    mcapUsd: 0.41e6,
    change24h: 4.4,
    holders: 960,
    poolTokens: 33_000_000,
    volume24hUsd: 51_000,
    refRatio: 1.0,
  },
  {
    symbol: "WBSC",
    name: "Wet Biscuit",
    tile: 1,
    description: "Dunked too long. Still delicious to some.",
    status: "graduated",
    createdAt: d(9, 2, 12),
    graduatedAt: d(9, 3, 8),
    mcapUsd: 5.12e6,
    change24h: 61.0,
    holders: 7310,
    poolTokens: 12_800_000,
    volume24hUsd: 1_920_000,
    refRatio: 0.92,
  },
  {
    symbol: "PIGN",
    name: "Sad Pigeon",
    tile: 2,
    description: "He's not sad, he's just like that.",
    status: "curve",
    createdAt: d(10, 8, 16),
    raised: 61.37,
    raised1h: 4.1,
    change24h: 22.9,
    holders: 412,
    poolTokens: 50_184_300,
    volume24hUsd: 38_000,
    refRatio: 0.98,
  },
  {
    symbol: "LGRN",
    name: "Uncle Lagrange",
    tile: 0,
    description: "Optimises everything under constraints. The constraint was liquidity.",
    status: "graduated",
    createdAt: d(7, 10, 14),
    graduatedAt: d(7, 11, 19),
    mcapUsd: 0.02e6,
    change24h: -41.5,
    holders: 210,
    poolTokens: 48_100_000,
    volume24hUsd: 2_100,
    refRatio: 1.18,
  },
  {
    symbol: "TOAD",
    name: "Tax Loss Toad",
    tile: 1,
    description: "Harvests losses in December. Croaks in January.",
    status: "graduated",
    createdAt: d(7, 28, 13),
    graduatedAt: d(7, 29, 22),
    mcapUsd: 0.77e6,
    change24h: 9.1,
    holders: 1290,
    poolTokens: 14_200_000,
    volume24hUsd: 74_000,
    refRatio: 1.0,
  },
  {
    symbol: "SLIP",
    name: "Slippage Sam",
    tile: 2,
    description: "Sets slippage to 49%. Every time.",
    status: "curve",
    createdAt: d(10, 11, 9, 40),
    raised: 23.4,
    raised1h: 2.2,
    change24h: 8.0,
    holders: 133,
    poolTokens: 50_061_200,
    volume24hUsd: 9_400,
    refRatio: 1.0,
  },
  {
    symbol: "CRNE",
    name: "Paper Crane",
    tile: 0,
    description: "Folded a thousand times. Paper hands, literally.",
    status: "curve",
    createdAt: d(10, 3, 20),
    raised: 78.9,
    raised1h: 1.4,
    change24h: 3.1,
    holders: 640,
    poolTokens: 50_402_900,
    volume24hUsd: 21_000,
    refRatio: 1.0,
  },
  {
    symbol: "LMBO",
    name: "Wen Lambo Labrador",
    tile: 1,
    description: "Good boy. Bad entry.",
    status: "curve",
    createdAt: d(10, 11, 13, 51),
    raised: 4.2,
    raised1h: 4.2,
    change24h: 0,
    holders: 18,
    poolTokens: 50_003_100,
    volume24hUsd: 700,
    refRatio: 1.0,
  },
  {
    symbol: "CWCT",
    name: "Cold Wallet Cat",
    tile: 2,
    description: "Keeps the seed phrase in a sock. Which sock is classified.",
    status: "graduated",
    createdAt: d(9, 12, 16),
    graduatedAt: d(9, 13, 4),
    mcapUsd: 3.4e6,
    change24h: 22.0,
    holders: 5200,
    poolTokens: 18_900_000,
    volume24hUsd: 870_000,
    refRatio: 0.96,
  },
  {
    symbol: "RENT",
    name: "Rent Is Due",
    tile: 0,
    description: "First of the month energy.",
    status: "curve",
    createdAt: d(10, 10, 20),
    raised: 41.0,
    raised1h: 0.6,
    change24h: -4.2,
    holders: 301,
    poolTokens: 50_118_000,
    volume24hUsd: 6_100,
    refRatio: 1.02,
  },
  {
    symbol: "BAGS",
    name: "Bag Inspector",
    tile: 2,
    description: "Checks every bag at the door. Yours too.",
    status: "graduated",
    createdAt: d(10, 10, 6),
    graduatedAt: d(10, 11, 13, 51),
    mcapUsd: 0.072e6,
    change24h: 148.0,
    holders: 880,
    poolTokens: 50_960_000,
    volume24hUsd: 96_000,
    refRatio: 0.95,
  },
  {
    symbol: "DIPS",
    name: "Buy The Dip Dave",
    tile: 1,
    description: "Dave bought every dip. Dave is the dip now.",
    status: "graduated",
    createdAt: d(8, 30, 9),
    graduatedAt: d(9, 1, 3),
    mcapUsd: 0.19e6,
    change24h: -12.3,
    holders: 720,
    poolTokens: 41_700_000,
    volume24hUsd: 12_800,
    refRatio: 1.06,
  },
];

/*
 * The Launches board needs a fuller world than the hand-authored coins: a stream of young
 * curve coins, a final stretch and a few fresh graduates. Ages are relative to EPOCH; the
 * rest is seeded from the symbol so server and client agree.
 */
const SEC = 1000;
function boardSpec(symbol: string, name: string, description: string, ageMs: number, o: { raised?: number; gradAgoMs?: number; mcapUsd?: number }): CoinSpec {
  const r = rng("board:" + symbol);
  const grad = o.gradAgoMs !== undefined;
  const raised = o.raised ?? 0;
  const young = 1 - Math.exp(-ageMs / (2 * HOUR));
  return {
    symbol,
    name,
    tile: (hash(symbol) % 3) as 0 | 1 | 2,
    description,
    status: grad ? "graduated" : "curve",
    createdAt: EPOCH - ageMs,
    graduatedAt: grad ? EPOCH - o.gradAgoMs! : undefined,
    mcapUsd: grad ? o.mcapUsd : undefined,
    raised: grad ? undefined : raised,
    raised1h: grad ? undefined : Math.min(raised, raised * between(r, 0.2, 1) + 0.2),
    change24h: grad ? between(r, -18, 140) : ((curvePriceAt(raised) / P0 - 1) * 100),
    holders: grad ? Math.round(between(r, 260, 900)) : Math.max(1, Math.round(raised * between(r, 2.2, 4.5) + young * 8)),
    poolTokens: Math.round(80_000_000 + raised * between(r, 9_000, 14_000) + (grad ? between(r, 1, 4) * 1e6 : 0)),
    volume24hUsd: Math.round((grad ? (o.mcapUsd ?? 0) * between(r, 0.3, 0.9) : raised * SOL_USD * between(r, 1.3, 2.4)) + 40),
    refRatio: 1,
  };
}

const M = 60 * SEC;
const H = 60 * M;
COIN_SPECS.push(
  boardSpec("WAGE", "Minimum Wage Wizard", "Casts one spell per shift. The spell is overtime.", 40 * SEC, { raised: 0.6 }),
  boardSpec("NAPS", "Nap Syndicate", "Organised sleeping. Dues are paid in yawns.", 2 * M, { raised: 2.1 }),
  boardSpec("BRKE", "Broke Bureau", "A government agency for people who checked their balance.", 5 * M, { raised: 6.8 }),
  boardSpec("OOPS", "Oops All Exits", "Every door in this building is an exit. None of them are good.", 9 * M, { raised: 12.4 }),
  boardSpec("FOMO", "Fomo Ferret", "Arrives late to everything, at full speed.", 14 * M, { raised: 3.3 }),
  boardSpec("CHAD", "Chad Receipts", "Keeps every receipt. Shows nobody.", 22 * M, { raised: 19.0 }),
  boardSpec("DUCK", "Duck Dynasty Fund", "Calm on the surface. Paddling like mad underneath.", 26 * M, { raised: 46.1 }),
  boardSpec("LATE", "Fashionably Late", "Showed up after the top. Looks great, though.", 31 * M, { raised: 27.5 }),
  boardSpec("HODL", "Hodl Hostage", "Can't sell. Won't sell. Has forgotten the password.", 48 * M, { raised: 9.9 }),
  boardSpec("PLNK", "Plankton Partners", "Small fish, big plans, smaller balance sheet.", 55 * M, { raised: 52.8 }),
  boardSpec("MOAI", "Moai Bag", "Stares at the chart. Does not blink.", 70 * M, { raised: 33.0 }),
  boardSpec("SNAX", "Snack Reserve", "A treasury of crisps. Audited by a hungry intern.", 85 * M, { raised: 58.4 }),
  boardSpec("RUGZ", "Definitely Not A Rug", "The name is doing a lot of work.", 100 * M, { raised: 1.2 }),
  boardSpec("SOUP", "Soup Kitchen Capital", "Ladles out liquidity, one bowl at a time.", 2 * H, { raised: 15.7 }),
  boardSpec("GRIT", "True Grit Coin", "Holds through everything. Mostly out of stubbornness.", 3 * H, { raised: 66.2 }),
  boardSpec("MOON", "Moonwalk Accountant", "Books balanced while walking backwards.", 4 * H, { raised: 71.5 }),
  boardSpec("BELL", "Closing Bell", "Rings at 4pm. Nobody on Solana knows what that means.", 5 * H, { raised: 80.3 }),
  boardSpec("EXIT", "Exit Interview", "Asks why you sold. Writes it down. Nods.", 7 * H, { raised: 83.6 }),
  boardSpec("GRAD", "Graduation Cap", "Threw the cap in the air. Still waiting for it to come down.", 10 * H, { gradAgoMs: 25 * M, mcapUsd: 92_000 }),
  boardSpec("HATS", "Hat Stack", "One hat per all-time high.", 14 * H, { gradAgoMs: 110 * M, mcapUsd: 140_000 }),
  boardSpec("ZOOM", "Zoom Call Zealots", "You're on mute. You've been on mute the whole cycle.", 20 * H, { gradAgoMs: 4 * H, mcapUsd: 61_000 }),
);

/**
 * Launches the live mock releases one by one while a page is subscribed (client only), so
 * the New column fills in. They are resolvable by symbol everywhere (a coin page renders on
 * the server too) but listed only once launched.
 */
export const PENDING_LAUNCHES: CoinSpec[] = (
  [
    ["KNEE", "Knee Deep", "In it up to here. Here is rising."],
    ["FLIP", "Flip Flop Fund", "Changes its mind every block."],
    ["BAGL", "Bagel Index", "Tracks the price of a bagel. The bagel is winning."],
    ["CRAB", "Crab Market", "Sideways since launch. Proudly."],
    ["WOKE", "Woke Up Late", "Missed the launch of its own coin."],
    ["SNIP", "Sniper Nap", "Bought block zero, then fell asleep."],
    ["MALL", "Mall Walker", "Laps the food court at dawn. Steady gains."],
    ["TAXX", "Tax Season", "Every sell is a form. Every form is a fumble."],
    ["PAWN", "Pawn Shop Pete", "Will give you 40% of what it's worth. Every time."],
    ["LOAF", "Bread Loaf DAO", "Governance by slice."],
    ["GLUE", "Glue Factory", "Holds anything together, except a bag."],
    ["YAWN", "Yawn Capital", "Low volatility. Lower energy."],
    ["DRIP", "Faucet Drip", "One drop at a time, forever."],
    ["PEEL", "Banana Peel", "Slipped on the way up. And down."],
    ["FIZZ", "Flat Soda", "Opened at the top. Left on the counter."],
    ["KELP", "Kelp Forest", "Grows a foot a day. Mostly sideways."],
    ["NEON", "Neon Pigeon", "Glows at night. Steals your chips."],
    ["OATS", "Overnight Oats", "Prepared in advance. Still soggy."],
    ["RAKE", "Rake Fees", "Takes a little from everyone. Gives it to the pool."],
    ["SOCK", "Lost Sock", "Went into the dryer. Came out at a lower price."],
    ["TUBA", "Tuba Section", "Loud, low and in the back."],
    ["VEST", "Unvested", "Cliff in 12 months. Nerves in 12 minutes."],
    ["WICK", "Long Wick", "Touched the top for one candle. Has the screenshot."],
    ["YOLK", "Double Yolk", "Twice the upside. Twice the cholesterol."],
    ["ZEST", "Lemon Zest", "Adds flavour to a sour portfolio."],
    ["BUNK", "Bunk Bed Bank", "Top bunk for whales, bottom bunk for you."],
    ["CORK", "Cork Board", "Pins every chart. Connects them with string."],
    ["DENT", "Fender Dent", "Minor damage. Major feelings."],
  ] as const
).map(([sym, name, desc], i) => ({ ...boardSpec(sym, name, desc, 0, { raised: Math.round(between(rng("dev:" + sym), 0, 1.6) * 100) / 100 }), createdAt: EPOCH + (i + 1) * 20 * SEC }));

export const SPEC_BY_SYMBOL = new Map(COIN_SPECS.map((c) => [c.symbol, c]));
export const SPEC_BY_MINT = new Map(COIN_SPECS.map((c) => [mintAddress(c.symbol), c]));
for (const c of PENDING_LAUNCHES) {
  SPEC_BY_SYMBOL.set(c.symbol, c);
  SPEC_BY_MINT.set(mintAddress(c.symbol), c);
}

export function spotOf(c: CoinSpec): number {
  if (c.status === "curve") return curvePriceAt(c.raised ?? 0);
  return (c.mcapUsd ?? 0) / SOL_USD / PARAMS.totalSupply;
}
/** 30-min median: within ~1.5% of spot, lagging the direction of travel. */
export function medianOf(c: CoinSpec): number {
  const lag = Math.max(-0.02, Math.min(0.02, -c.change24h / 2400));
  return spotOf(c) * (1 + lag);
}
export function creatorOf(c: CoinSpec): string {
  return address("creator:" + c.symbol);
}

/* ── Demo wallet tickets (one per state the UI must show) ─────────────────── */

export interface TicketSpec {
  symbol: string;
  seq: number;
  sellTs: number;
  originalTokens: number;
  /** Tokens after rebuy debits. */
  tokens: number;
  /** Multiple the median sits at now (sets the sell price). */
  multiple: number;
  peak: number;
  state: TicketState;
  floorApplied?: boolean;
  queuePosition?: number;
  queuedAt?: number;
  claimedAt?: number;
  claimedMultiple?: number;
}

export const DEMO_TICKETS: TicketSpec[] = [
  { symbol: "MIDC", seq: 2, sellTs: d(8, 19, 22, 51), originalTokens: 4_200_000, tokens: 4_200_000, multiple: 11.4, peak: 11.9, state: "claimable" },
  {
    symbol: "GOBT",
    seq: 0,
    sellTs: d(8, 8, 17, 4),
    originalTokens: 2_600_000,
    tokens: 2_600_000,
    multiple: 13.1,
    peak: 14.8,
    state: "queued",
    queuePosition: 4,
    queuedAt: d(10, 9, 6, 12),
  },
  {
    symbol: "COPE",
    seq: 1,
    sellTs: d(8, 28, 3, 30),
    originalTokens: 1_850_000,
    tokens: 1_850_000,
    multiple: 8.2,
    peak: 8.6,
    state: "tracking",
    floorApplied: true,
  },
  { symbol: "CRNE", seq: 0, sellTs: d(10, 4, 1, 15), originalTokens: 5_100_000, tokens: 5_100_000, multiple: 11.6, peak: 11.6, state: "awaiting-graduation" },
  { symbol: "FRGA", seq: 0, sellTs: d(7, 23, 15, 2), originalTokens: 900_000, tokens: 900_000, multiple: 3.4, peak: 4.1, state: "tracking" },
  { symbol: "PIGN", seq: 0, sellTs: d(10, 9, 11, 40), originalTokens: 3_300_000, tokens: 3_300_000, multiple: 2.1, peak: 2.1, state: "awaiting-graduation" },
  { symbol: "WBSC", seq: 3, sellTs: d(9, 30, 19, 25), originalTokens: 3_000_000, tokens: 1_800_000, multiple: 1.6, peak: 1.9, state: "tracking" },
  {
    symbol: "TOAD",
    seq: 0,
    sellTs: d(8, 2, 10, 10),
    originalTokens: 1_500_000,
    tokens: 1_500_000,
    multiple: 13.8,
    peak: 15.2,
    state: "claimed",
    claimedAt: d(9, 20, 14, 2),
    claimedMultiple: 12.6,
  },
  { symbol: "LGRN", seq: 0, sellTs: d(7, 12, 9, 30), originalTokens: 7_400_000, tokens: 7_400_000, multiple: 0.4, peak: 2.3, state: "expired" },
];

/** Deterministic tickets for any other wallet (connected wallets in the mock). */
export function generatedTickets(owner: string): TicketSpec[] {
  const r = rng("tickets:" + owner);
  const n = 3 + Math.floor(r() * 4);
  const pool = [...COIN_SPECS];
  const out: TicketSpec[] = [];
  for (let i = 0; i < n && pool.length; i++) {
    const c = pool.splice(Math.floor(r() * pool.length), 1)[0];
    const lo = Math.max(c.createdAt + HOUR, EPOCH - 89 * DAY);
    const sellTs = Math.floor(between(r, lo, EPOCH - 2 * HOUR));
    const tokens = Math.round((between(r, 0.2, 6) * 1e6) / 1e4) * 1e4;
    const multiple = Math.round(Math.exp(between(r, Math.log(0.5), Math.log(16))) * 10) / 10;
    let state: TicketState;
    if (c.status === "curve") state = "awaiting-graduation";
    else if (multiple >= 10) state = r() < 0.3 ? "queued" : "claimable";
    else state = "tracking";
    out.push({
      symbol: c.symbol,
      seq: 0,
      sellTs,
      originalTokens: tokens,
      tokens,
      multiple,
      peak: Math.max(multiple, multiple * between(r, 1, 1.4)),
      state,
      queuePosition: state === "queued" ? 1 + Math.floor(r() * 5) : undefined,
      queuedAt: state === "queued" ? EPOCH - Math.floor(between(r, 1, 6) * DAY) : undefined,
    });
  }
  return out;
}

/* ── Price paths ──────────────────────────────────────────────────────────── */

export interface Anchor {
  t: number;
  p: number;
}

/** Sell prices are derived from the multiple, so the chart and the gauge always agree. */
export function ticketSellPrice(spec: TicketSpec): number {
  const c = SPEC_BY_SYMBOL.get(spec.symbol)!;
  return medianOf(c) / spec.multiple;
}

const STEP = 5 * MINUTE;
const pathCache = new Map<string, Anchor[]>();

/**
 * A 5-minute log-price path from launch to EPOCH that passes exactly through every
 * anchor (launch price, graduation price, the demo wallet's sells, 24h ago, now).
 * Brownian bridges between anchors, with volatility scaled so long gaps stay plausible.
 */
export function pricePath(symbol: string): Anchor[] {
  const hit = pathCache.get(symbol);
  if (hit) return hit;
  const c = SPEC_BY_SYMBOL.get(symbol)!;
  const anchors: Anchor[] = [{ t: c.createdAt, p: P0 }];
  if (c.graduatedAt) anchors.push({ t: c.graduatedAt, p: P_GRAD });
  for (const tk of DEMO_TICKETS) if (tk.symbol === symbol) anchors.push({ t: tk.sellTs, p: ticketSellPrice(tk) });
  const spot = spotOf(c);
  if (EPOCH - DAY > c.createdAt + HOUR) anchors.push({ t: EPOCH - DAY, p: spot / (1 + c.change24h / 100) });
  anchors.push({ t: EPOCH, p: spot });
  anchors.sort((a, b) => a.t - b.t);
  const clean = anchors.filter((a, i) => i === 0 || a.t - anchors[i - 1].t >= 20 * MINUTE || i === anchors.length - 1);

  const r = rng("path:" + symbol);
  const out: Anchor[] = [];
  for (let i = 0; i < clean.length - 1; i++) {
    const a = clean[i];
    const b = clean[i + 1];
    const n = Math.max(1, Math.round((b.t - a.t) / STEP));
    const sigma = Math.min(0.03, 0.9 / Math.sqrt(n));
    // random walk W, then bridge: W_k - (k/n)·W_n
    const w: number[] = [0];
    for (let k = 1; k <= n; k++) w.push(w[k - 1] + sigma * gauss(r));
    const la = Math.log(a.p);
    const lb = Math.log(b.p);
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const lp = la + (lb - la) * f + (w[k] - f * w[n]);
      out.push({ t: a.t + ((b.t - a.t) * k) / n, p: Math.exp(lp) });
    }
  }
  out.push(clean[clean.length - 1]);
  // Curve coins can't trade below the launch price.
  if (c.status === "curve") for (const pt of out) pt.p = Math.max(P0, pt.p);
  pathCache.set(symbol, out);
  return out;
}

/** Value of the path at time t (nearest earlier point). */
export function priceAt(symbol: string, t: number): number {
  const path = pricePath(symbol);
  let lo = 0;
  let hi = path.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (path[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return path[lo].p;
}

/** One-minute detail for the last hour, bridged between the 5-minute points. */
export function lastHour(symbol: string): Anchor[] {
  const path = pricePath(symbol);
  const r = rng("hour:" + symbol);
  const out: Anchor[] = [];
  const start = EPOCH - HOUR;
  for (let t = start; t <= EPOCH; t += MINUTE) {
    const base = priceAt(symbol, t);
    out.push({ t, p: base * Math.exp(0.006 * gauss(r)) });
  }
  out[out.length - 1] = path[path.length - 1];
  return out;
}

/* ── Misc generators ──────────────────────────────────────────────────────── */

export function seededInt(seed: string, lo: number, hi: number): number {
  return lo + (hash(seed) % (hi - lo + 1));
}

export function randomName(r: () => number): string | undefined {
  return r() < 0.6 ? pick(r, HANDLES) : undefined;
}

export { gauss, between, pick, rng, address, mintAddress };
