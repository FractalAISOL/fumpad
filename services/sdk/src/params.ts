/** `Params` (INTERFACE §5.1) with the contract defaults and bounds (constants.rs). */
import { PublicKey } from "@solana/web3.js";

import { bytesToHex, hexToBytes, toIdl } from "./borsh.js";
import { PYTH_SOL_USD_FEED_ID } from "./constants.js";

export interface Params {
  feeBuybackShareBps: number;
  feePlatformShareBps: number;
  feeCreatorShareBps: number;
  triggerMultipleBps: number;
  claimBps: number;
  maxClaimPoolBps: number;
  minSellUsdCents: bigint;
  minHoldSecs: bigint;
  rebuyWindowSecs: bigint;
  claimWindowSecs: bigint;
  maxOpenTickets: number;
  oracleWindowSecs: bigint;
  oracleMinSpacingSecs: bigint;
  oracleMinSamples: number;
  keeperStaleSecs: bigint;
  buybackMaxDeviationBps: number;
  buybackMaxPoolBps: number;
  /** hex, 32 bytes */
  solUsdFeedId: string;
  /** Engine's max |block_time − publish_time| (SPEC §5.4). */
  maxPriceAgeSecs: bigint;
  maxAttestAgeSecs: bigint;
  maxAttestTokensPerHourBps: number;
  ticketChallengeSecs: bigint;
  attestThreshold: number;
  /** Launch binding (off-chain review L1): when set, `register_coin` must be co-signed by this key. Default = unset. */
  launchSigner: PublicKey;
}

export const DEFAULT_PARAMS: Params = {
  feeBuybackShareBps: 5_000,
  feePlatformShareBps: 3_000,
  feeCreatorShareBps: 2_000,
  triggerMultipleBps: 100_000,
  claimBps: 1_000,
  maxClaimPoolBps: 1_000,
  minSellUsdCents: 5_000n,
  minHoldSecs: 600n,
  rebuyWindowSecs: 604_800n,
  claimWindowSecs: 7_776_000n,
  maxOpenTickets: 5,
  oracleWindowSecs: 1_800n,
  oracleMinSpacingSecs: 10n,
  oracleMinSamples: 84,
  keeperStaleSecs: 600n,
  buybackMaxDeviationBps: 300,
  buybackMaxPoolBps: 50,
  solUsdFeedId: PYTH_SOL_USD_FEED_ID,
  maxPriceAgeSecs: 120n,
  maxAttestAgeSecs: 86_400n,
  maxAttestTokensPerHourBps: 2_000,
  ticketChallengeSecs: 21_600n,
  attestThreshold: 2,
  launchSigner: PublicKey.default,
};

/** Inclusive bounds from constants.rs (`Params::is_valid`). */
export const PARAM_BOUNDS = {
  triggerMultipleBps: [50_000, 500_000],
  claimBps: [100, 2_500],
  maxClaimPoolBps: [100, 2_500],
  minSellUsdCents: [500n, 100_000n],
  minHoldSecs: [60n, 86_400n],
  rebuyWindowSecs: [86_400n, 2_592_000n],
  claimWindowSecs: [604_800n, 31_536_000n],
  maxOpenTickets: [1, 5],
  oracleWindowSecs: [600n, 7_200n],
  oracleMinSpacingSecs: [5n, 60n],
  keeperStaleSecs: [60n, 3_600n],
  buybackMaxDeviationBps: [10, 1_000],
  buybackMaxPoolBps: [1, 200],
  maxPriceAgeSecs: [30n, 300n],
  maxAttestAgeSecs: [3_600n, 604_800n],
  maxAttestTokensPerHourBps: [1, 10_000],
  ticketChallengeSecs: [3_600n, 172_800n],
} as const;

const ORACLE_MIN_SAMPLE_EVERY_SECS = 60n;
const OBSERVATION_CAPACITY = 256;
const BUYBACK_VENUE_FEE_ALLOWANCE_BPS = 200;

/** Why `Params::is_valid` (state/global.rs) would reject `p`; empty = valid. Mirrors the contract check by check. */
export function paramsProblems(p: Params): string[] {
  const out: string[] = [];
  const within = (k: keyof typeof PARAM_BOUNDS) => {
    const [lo, hi] = PARAM_BOUNDS[k] as readonly [number | bigint, number | bigint];
    const v = p[k] as number | bigint;
    if (v < lo || v > hi) out.push(`${k}=${v} outside [${lo}, ${hi}]`);
  };
  if (p.feeBuybackShareBps + p.feePlatformShareBps + p.feeCreatorShareBps !== 10_000) out.push("fee shares must sum to 10,000 bps");
  for (const k of Object.keys(PARAM_BOUNDS) as (keyof typeof PARAM_BOUNDS)[]) within(k);
  const n = BigInt(p.oracleMinSamples);
  if (n * ORACLE_MIN_SAMPLE_EVERY_SECS < p.oracleWindowSecs) out.push("oracleMinSamples × 60 s must cover oracleWindowSecs");
  if (p.oracleMinSpacingSecs > 0n && n > p.oracleWindowSecs / p.oracleMinSpacingSecs) out.push("oracleMinSamples > oracleWindowSecs / oracleMinSpacingSecs");
  if (p.oracleMinSamples > OBSERVATION_CAPACITY) out.push(`oracleMinSamples > ${OBSERVATION_CAPACITY}`);
  if (p.keeperStaleSecs <= p.oracleMinSpacingSecs) out.push("keeperStaleSecs must exceed oracleMinSpacingSecs");
  if (p.buybackMaxDeviationBps + BUYBACK_VENUE_FEE_ALLOWANCE_BPS + 2 * p.buybackMaxPoolBps >= 10_000) out.push("buyback haircut ≥ 100%");
  if (p.solUsdFeedId.replace(/^0x/, "").toLowerCase() !== PYTH_SOL_USD_FEED_ID) out.push("solUsdFeedId must be the pinned Pyth SOL/USD feed");
  if (p.attestThreshold !== 2) out.push("attestThreshold must be 2");
  return out;
}

export function paramsToIdl(p: Params): Record<string, unknown> {
  const { solUsdFeedId, ...rest } = p;
  return { ...(toIdl(rest) as Record<string, unknown>), sol_usd_feed_id: hexToBytes(solUsdFeedId) };
}
/** From a normalized (camelCase, bigint) decoded Params. */
export function paramsFromIdl(raw: Record<string, unknown>): Params {
  const feed = raw.solUsdFeedId as number[];
  const n = (k: string) => Number(raw[k]);
  return {
    ...(raw as unknown as Params),
    feeBuybackShareBps: n("feeBuybackShareBps"),
    feePlatformShareBps: n("feePlatformShareBps"),
    feeCreatorShareBps: n("feeCreatorShareBps"),
    triggerMultipleBps: n("triggerMultipleBps"),
    claimBps: n("claimBps"),
    maxClaimPoolBps: n("maxClaimPoolBps"),
    maxOpenTickets: n("maxOpenTickets"),
    oracleMinSamples: n("oracleMinSamples"),
    buybackMaxDeviationBps: n("buybackMaxDeviationBps"),
    buybackMaxPoolBps: n("buybackMaxPoolBps"),
    maxAttestTokensPerHourBps: n("maxAttestTokensPerHourBps"),
    attestThreshold: n("attestThreshold"),
    solUsdFeedId: bytesToHex(feed),
    launchSigner: raw.launchSigner instanceof PublicKey ? raw.launchSigner : new PublicKey(raw.launchSigner as string),
  };
}
