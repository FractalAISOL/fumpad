import { PublicKey } from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPF_LOADER_UPGRADEABLE_ID,
  FUMPAD_POOL_INDEX,
  FUMPAD_PROGRAM_ID,
  LP_LOCKER_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  SEEDS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./constants.js";

// PDA derivation is pure but not free (sha256 per bump attempt); cache by seed bytes.
const cache = new Map<string, PublicKey>();

function find(seeds: Uint8Array[], program: PublicKey): PublicKey {
  const key = program.toBase58() + ":" + seeds.map((s) => Array.from(s).join(",")).join("|");
  const hit = cache.get(key);
  if (hit) return hit;
  const [pk] = PublicKey.findProgramAddressSync(seeds, program);
  if (cache.size > 50_000) cache.clear();
  cache.set(key, pk);
  return pk;
}

export function u64Le(n: bigint | number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
}
function u16Le(n: number): Uint8Array {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

const f = (seeds: Uint8Array[]) => find(seeds, FUMPAD_PROGRAM_ID);

// ── fumpad ──────────────────────────────────────────────────────────────────
export const globalPda = () => f([SEEDS.global]);
export const mintAuthorityPda = () => f([SEEDS.mintAuthority]);
export const poolAuthorityPda = () => f([SEEDS.poolAuthority]);
export const eventAuthorityPda = () => f([SEEDS.eventAuthority]);
export const coinPda = (mint: PublicKey) => f([SEEDS.coin, mint.toBytes()]);
export const rewardVaultPda = (mint: PublicKey) => f([SEEDS.rewardVault, mint.toBytes()]);
export const curveVaultPda = (mint: PublicKey) => f([SEEDS.curveVault, mint.toBytes()]);
export const observationsPda = (mint: PublicKey) => f([SEEDS.observations, mint.toBytes()]);
export const claimQueuePda = (mint: PublicKey) => f([SEEDS.claimQueue, mint.toBytes()]);
export const positionPda = (mint: PublicKey, wallet: PublicKey) => f([SEEDS.position, mint.toBytes(), wallet.toBytes()]);
export const ticketPda = (mint: PublicKey, wallet: PublicKey, seq: bigint | number) =>
  f([SEEDS.ticket, mint.toBytes(), wallet.toBytes(), u64Le(seq)]);
/** D16 per-ticket escrow token account ["escrow", ticket]. */
export const escrowPda = (ticket: PublicKey) => f([SEEDS.escrow, ticket.toBytes()]);
/** graduate's own WSOL account ["graduation_wsol", mint] (created + closed in-instruction). */
export const graduationWsolPda = (mint: PublicKey) => f([SEEDS.graduationWsol, mint.toBytes()]);
/** ProgramData of the (upgradeable) fumpad program — `initialize_global` checks its authority. */
export const programDataPda = (program: PublicKey = FUMPAD_PROGRAM_ID) =>
  find([program.toBytes()], BPF_LOADER_UPGRADEABLE_ID);

// ── SPL ─────────────────────────────────────────────────────────────────────
export function ata(owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID): PublicKey {
  return find([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID);
}
/** FUMPAD coins are Token-2022 mints. */
export const coinAta = (owner: PublicKey, mint: PublicKey) => ata(owner, mint, TOKEN_2022_PROGRAM_ID);
export const wsolAta = (owner: PublicKey) => ata(owner, WSOL_MINT, TOKEN_PROGRAM_ID);

// ── PumpSwap ────────────────────────────────────────────────────────────────
export function pumpPoolPda(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey): PublicKey {
  return find([SEEDS.pool, u16Le(index), creator.toBytes(), baseMint.toBytes(), quoteMint.toBytes()], PUMPSWAP_PROGRAM_ID);
}
/** The PumpSwap pool `graduate` creates for a coin (index 0, creator = pool authority, WSOL quote). */
export const coinPoolPda = (mint: PublicKey) => pumpPoolPda(FUMPAD_POOL_INDEX, poolAuthorityPda(), mint, WSOL_MINT);
export const lpMintPda = (pool: PublicKey) => find([SEEDS.poolLpMint, pool.toBytes()], PUMPSWAP_PROGRAM_ID);
export const pumpEventAuthorityPda = () => find([SEEDS.eventAuthority], PUMPSWAP_PROGRAM_ID);
export const userVolumeAccumulatorPda = (user: PublicKey) =>
  find([SEEDS.userVolumeAccumulator, user.toBytes()], PUMPSWAP_PROGRAM_ID);
/** Pool vaults are ATAs of the pool: base = Token-2022, quote = WSOL (SPL Token). */
export const poolBaseVault = (pool: PublicKey, mint: PublicKey) => ata(pool, mint, TOKEN_2022_PROGRAM_ID);
export const poolQuoteVault = (pool: PublicKey) => ata(pool, WSOL_MINT, TOKEN_PROGRAM_ID);

// ── LP locker ───────────────────────────────────────────────────────────────
export const lockPda = (pool: PublicKey) => find([SEEDS.lock, pool.toBytes()], LP_LOCKER_PROGRAM_ID);
export const lockerAuthorityPda = () => find([SEEDS.lockerAuthority], LP_LOCKER_PROGRAM_ID);
/** LP vault = ATA(locker authority, LP mint) under Token-2022. */
export const lockerLpVault = (pool: PublicKey) => ata(lockerAuthorityPda(), lpMintPda(pool), TOKEN_2022_PROGRAM_ID);
/** The locker's fixed WSOL destination for skimmed quote: ATA(coin PDA, WSOL). */
export const coinLpFeeWsol = (mint: PublicKey) => ata(coinPda(mint), WSOL_MINT, TOKEN_PROGRAM_ID);

/** Every address derived for one coin, for building transactions and filters. */
export function coinAddresses(mint: PublicKey) {
  const pool = coinPoolPda(mint);
  return {
    mint,
    coin: coinPda(mint),
    rewardVault: rewardVaultPda(mint),
    curveVault: curveVaultPda(mint),
    observations: observationsPda(mint),
    claimQueue: claimQueuePda(mint),
    pool,
    lpMint: lpMintPda(pool),
    poolBase: poolBaseVault(pool, mint),
    poolQuote: poolQuoteVault(pool),
    lock: lockPda(pool),
    lockerAuthority: lockerAuthorityPda(),
    lpVault: lockerLpVault(pool),
    lpFeeWsol: coinLpFeeWsol(mint),
  };
}
export type CoinAddresses = ReturnType<typeof coinAddresses>;

