/** Program ids, seeds and protocol constants of FUMPAD v0.7 (contracts/INTERFACE-v0.7.md). */
import { PublicKey } from "@solana/web3.js";

// ── programs / deployment ───────────────────────────────────────────────────
/** `Global.cluster_tag` (immutable; part of every attestation message). */
export const CLUSTER_TAG = { mainnet: 0, devnet: 1, localnet: 2 } as const;
export type ClusterName = keyof typeof CLUSTER_TAG;
export const CLUSTER_NAMES = Object.keys(CLUSTER_TAG) as ClusterName[];

/** The program id compiled into `contracts/programs/fumpad/src/lib.rs` (`declare_id!`, default build), deployed on devnet. */
export const DEFAULT_FUMPAD_PROGRAM_ID = "5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb";
/** The cluster of the default program id's deployment (its Global has `cluster_tag` 1). */
export const DEFAULT_FUMPAD_CLUSTER: ClusterName = "devnet";

/**
 * Which FUMPAD deployment this process talks to. `programId` drives every PDA, instruction builder, event filter and
 * attestation message of the SDK; `cluster` is what `Global.cluster_tag` must be (`verifyFumpadDeployment`).
 */
export interface FumpadConfig {
  programId: PublicKey;
  cluster: ClusterName;
  clusterTag: number;
  /** "env" when FUMPAD_PROGRAM_ID set it (the app: NEXT_PUBLIC_FUMPAD_PROGRAM_ID), else the compiled-in devnet id. */
  programIdSource: "env" | "default";
  clusterSource: "env" | "default";
}
export interface FumpadEnv {
  FUMPAD_PROGRAM_ID?: string;
  FUMPAD_CLUSTER?: string;
}

/**
 * Config factory: `FUMPAD_PROGRAM_ID` (base58) and `FUMPAD_CLUSTER` (mainnet | devnet | localnet). Both unset = the
 * devnet deployment (backward compatible: the devnet stack and app need no env). Throws on an unparsable id or an
 * unknown cluster name. A non-default id without an explicit cluster resolves to `devnet` here, but
 * `verifyFumpadDeployment` refuses it (a mainnet id must say `FUMPAD_CLUSTER=mainnet`).
 */
export function resolveFumpadConfig(env: FumpadEnv = {}): FumpadConfig {
  const id = env.FUMPAD_PROGRAM_ID?.trim();
  const cl = env.FUMPAD_CLUSTER?.trim().toLowerCase();
  let programId: PublicKey;
  try {
    programId = new PublicKey(id || DEFAULT_FUMPAD_PROGRAM_ID);
  } catch {
    throw new Error(`FUMPAD_PROGRAM_ID=${JSON.stringify(id)} is not a base58 public key`);
  }
  if (programId.toBase58() !== (id || DEFAULT_FUMPAD_PROGRAM_ID)) throw new Error(`FUMPAD_PROGRAM_ID=${JSON.stringify(id)} is not a canonical base58 public key`);
  if (cl && !(CLUSTER_NAMES as string[]).includes(cl)) throw new Error(`FUMPAD_CLUSTER=${JSON.stringify(cl)}: expected one of ${CLUSTER_NAMES.join(", ")}`);
  const cluster = (cl || DEFAULT_FUMPAD_CLUSTER) as ClusterName;
  return { programId, cluster, clusterTag: CLUSTER_TAG[cluster], programIdSource: id ? "env" : "default", clusterSource: cl ? "env" : "default" };
}

declare const process: { env: Record<string, string | undefined> } | undefined;
/**
 * The process's environment, as literal `process.env.FUMPAD_*` reads so bundlers can inline them (the app maps
 * NEXT_PUBLIC_FUMPAD_PROGRAM_ID / NEXT_PUBLIC_FUMPAD_CLUSTER onto these names in next.config.ts). A browser without
 * `process` and nothing inlined gets the defaults (the app refuses to load if that disagrees with its own config).
 */
function processEnv(): FumpadEnv {
  try {
    return { FUMPAD_PROGRAM_ID: process!.env.FUMPAD_PROGRAM_ID, FUMPAD_CLUSTER: process!.env.FUMPAD_CLUSTER };
  } catch {
    return {};
  }
}

/** This process's deployment, resolved once at import (`resolveFumpadConfig` of the environment). */
export const FUMPAD_CONFIG: Readonly<FumpadConfig> = Object.freeze(resolveFumpadConfig(processEnv()));
export const FUMPAD_PROGRAM_ID = FUMPAD_CONFIG.programId;
/** "env" when `FUMPAD_PROGRAM_ID` overrode the default (services log it at start). */
export const FUMPAD_PROGRAM_ID_SOURCE: "env" | "default" = FUMPAD_CONFIG.programIdSource;
export const FUMPAD_CLUSTER: ClusterName = FUMPAD_CONFIG.cluster;
export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM_ID = new PublicKey("11111111111111111111111111111111");
export const ED25519_PROGRAM_ID = new PublicKey("Ed25519SigVerify111111111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey("ComputeBudget111111111111111111111111111111");
export const SYSVAR_INSTRUCTIONS_ID = new PublicKey("Sysvar1nstructions1111111111111111111111111");
export const SYSVAR_RENT_ID = new PublicKey("SysvarRent111111111111111111111111111111111");
export const BPF_LOADER_UPGRADEABLE_ID = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const METAPLEX_METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

// ── Meteora fixed accounts ──────────────────────────────────────────────────
export const DBC_POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
export const DBC_EVENT_AUTHORITY = new PublicKey("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
export const DAMM_V2_POOL_AUTHORITY = new PublicKey("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
export const DAMM_V2_EVENT_AUTHORITY = new PublicKey("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");
/** DAMM v2 config DBC uses for `migrationFeeOption` Customizable (mainnet + devnet). */
export const DAMM_V2_MIGRATION_CONFIG = new PublicKey("A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck");

// ── seeds ───────────────────────────────────────────────────────────────────
const enc = (s: string) => new TextEncoder().encode(s);
export const SEEDS = {
  global: enc("global"),
  coin: enc("coin"),
  position: enc("position"),
  ticket: enc("ticket"),
  consumed: enc("consumed"),
  observations: enc("observations"),
  claimQueue: enc("claim_queue"),
  escrow: enc("escrow"),
  feeClaimer: enc("fee_claimer"),
  feeWsol: enc("fee_wsol"),
  rewardPool: enc("reward_pool"),
  buyback: enc("buyback"),
  feePolicy: enc("fee_policy"),
  eventAuthority: enc("__event_authority"),
} as const;

/** Per-config fee policy kinds (`FeePolicy.kind`, INTERFACE §5.9). */
export const FEE_POLICY = { standard: 0, walletSplit: 1 } as const;

// ── units / math ────────────────────────────────────────────────────────────
export const Q64 = 1n << 64n;
export const U64_MAX = (1n << 64n) - 1n;
export const U128_MAX = (1n << 128n) - 1n;
export const BPS_DENOM = 10_000n;
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const TOKEN_DECIMALS = 6;
export const BASE_PER_TOKEN = 1_000_000n;
/** Fixed supply of every FUMPAD coin (DBC config pre = post migration supply). */
export const TOTAL_SUPPLY_BASE = 1_000_000_000n * BASE_PER_TOKEN;
/** D35: the DBC leftover that lands in the reward vault at graduation. */
export const REWARD_POOL_BASE = 80_000_000n * BASE_PER_TOKEN;

// ── protocol limits (constants.rs) ──────────────────────────────────────────
/** Attestor keys (`Global.keepers`): sign + submit attestations only. */
export const MAX_KEEPERS = 3;
/** Jobs keys (`Global.operators`): samples, claim_for, pre-graduation buybacks. Never attestors. */
export const MAX_OPERATORS = 2;
export const MAX_CONFIGS = 8;
export const MAX_OPEN_TICKETS = 5;
export const MAX_QUEUED_PER_WALLET = 2;
export const OBSERVATION_CAPACITY = 256;
export const CLAIM_QUEUE_CAPACITY = 1024;
export const CLAIM_QUEUE_INIT_CALLS = 9;
export const MAX_CLOSE_POSITION_TICKETS = 64;
export const ATTEST_THRESHOLD = 2;
export const KEEPER_ATTEST_FREEZE_SECS = 6 * 3_600;
export const ATTEST_CLOCK_SKEW_SECS = 60;
export const ATTEST_BUCKET_SECS = 3_600;
export const PREGRAD_SAMPLE_MAX_AGE_SECS = 60;
/** L5: `Coin.pregrad_ring` — the pre-grad buyback guard is the median of ≥ MIN_SAMPLES ring samples taken within
 * WINDOW_SECS and spanning ≥ MIN_SPAN_SECS; spot must be within the band of it AND of the latest sample. */
export const PREGRAD_RING_LEN = 5;
export const PREGRAD_WINDOW_SECS = 300;
export const PREGRAD_MIN_SAMPLES = 4;
export const PREGRAD_MIN_SPAN_SECS = 60;
export const MAX_PAUSE_SECS = 7 * 86_400;
export const TIMELOCK_SECS = 48 * 3_600;
/** `close_consumed` requires now > consumed.block_time + MAX_MAX_ATTEST_AGE_SECS. */
export const MAX_MAX_ATTEST_AGE_SECS = 7 * 86_400;

/** Pause bits (`Global.paused`). */
export const PAUSE = { launch: 1, trade: 2, claims: 4, graduate: 8, attest: 16 } as const;
export const PAUSE_ALL = 0b1_1111;

/** Router `buy` mode. */
export const SWAP_MODE = { exactIn: 0, partialFill: 1 } as const;

// ── attestation (INTERFACE §4) ──────────────────────────────────────────────
export const SELL_DOMAIN = enc("FUMPAD-SELL-v1");
export const REBUY_DOMAIN = enc("FUMPAD-REBUY-v1");
export const SELL_MESSAGE_LEN = 284;
export const REBUY_MESSAGE_LEN = 236;
export const VENUE_DAMM_BIT = 0x01;
export const VENUE_ROUTED_BIT = 0x80;

/** Pyth SOL/USD feed id (pinned in Params.sol_usd_feed_id). */
export const PYTH_SOL_USD_FEED_ID = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/** `emit_cpi!` event instruction tag (little-endian u64 of sha256("anchor:event")[..8]). */
export const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** Meteora account data offsets (incl. the 8-byte discriminator), SPEC §6 / spike §10. */
export const DBC_POOL_SQRT_PRICE_OFFSET = 280;
export const DAMM_POOL_SQRT_PRICE_OFFSET = 456;
