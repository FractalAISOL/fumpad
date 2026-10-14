/** PDA derivation for fumpad v0.7 and the Meteora accounts it uses (INTERFACE-v0.7 §1). */
import { PublicKey } from "@solana/web3.js";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BPF_LOADER_UPGRADEABLE_ID,
  DAMM_V2_MIGRATION_CONFIG,
  DAMM_V2_PROGRAM_ID,
  DBC_PROGRAM_ID,
  FUMPAD_PROGRAM_ID,
  SEEDS,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
} from "./constants.js";
import { sha256 } from "./hash.js";

// PDA derivation costs a sha256 per bump attempt; cache by seed bytes.
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
export function u32Le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
}

const f = (seeds: Uint8Array[]) => find(seeds, FUMPAD_PROGRAM_ID);
const enc = (s: string) => new TextEncoder().encode(s);

// ── fumpad ──────────────────────────────────────────────────────────────────
export const globalPda = () => f([SEEDS.global]);
export const feeClaimerPda = () => f([SEEDS.feeClaimer]);
/** Transient WSOL account created + closed inside claim_fees / claim_lp_fees / graduate. */
export const feeWsolPda = () => f([SEEDS.feeWsol]);
export const rewardPoolPda = () => f([SEEDS.rewardPool]);
export const buybackPda = () => f([SEEDS.buyback]);
export const eventAuthorityPda = () => f([SEEDS.eventAuthority]);
export const coinPda = (mint: PublicKey) => f([SEEDS.coin, mint.toBytes()]);
export const positionPda = (mint: PublicKey, wallet: PublicKey) => f([SEEDS.position, mint.toBytes(), wallet.toBytes()]);
export const ticketPda = (mint: PublicKey, wallet: PublicKey, seq: bigint | number) => f([SEEDS.ticket, mint.toBytes(), wallet.toBytes(), u64Le(seq)]);
export const claimQueuePda = (mint: PublicKey) => f([SEEDS.claimQueue, mint.toBytes()]);
export const observationsPda = (mint: PublicKey) => f([SEEDS.observations, mint.toBytes()]);
export const escrowPda = (ticket: PublicKey) => f([SEEDS.escrow, ticket.toBytes()]);

/** Replay marker of an attested sell: ["consumed", sha256(signature 64 B), ix_key u32 LE]. */
export const consumedSellPda = (signature: Uint8Array, ixKey: number) => f([SEEDS.consumed, sha256(signature), u32Le(ixKey)]);
/** Replay marker of one rebuy debit: ["consumed", sha256(signature), ix_key LE, ticket]. */
export const consumedRebuyPda = (signature: Uint8Array, ixKey: number, ticket: PublicKey) => f([SEEDS.consumed, sha256(signature), u32Le(ixKey), ticket.toBytes()]);
export const programDataPda = () => find([FUMPAD_PROGRAM_ID.toBytes()], BPF_LOADER_UPGRADEABLE_ID);

// ── token accounts ──────────────────────────────────────────────────────────
export const ata = (owner: PublicKey, mint: PublicKey, tokenProgram: PublicKey = TOKEN_2022_PROGRAM_ID) =>
  find([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID);
/** A coin's canonical Token-2022 ATA for `owner`. */
export const coinAta = (owner: PublicKey, mint: PublicKey) => ata(owner, mint, TOKEN_2022_PROGRAM_ID);
export const wsolAta = (owner: PublicKey) => ata(owner, WSOL_MINT, TOKEN_PROGRAM_ID);
/** The coin's reward pool vault = ATA(reward_pool, mint, Token-2022) (D35). */
export const rewardVault = (mint: PublicKey) => coinAta(rewardPoolPda(), mint);
export const buybackWsol = () => wsolAta(buybackPda());

// ── Meteora ─────────────────────────────────────────────────────────────────
const cmp = (a: PublicKey, b: PublicKey) => {
  const x = a.toBytes();
  const y = b.toBytes();
  for (let i = 0; i < 32; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const maxKey = (a: PublicKey, b: PublicKey) => (cmp(a, b) >= 0 ? a : b);
const minKey = (a: PublicKey, b: PublicKey) => (cmp(a, b) >= 0 ? b : a);

/** DBC virtual pool: ["pool", config, max(base, quote), min(base, quote)]. */
export const dbcPoolPda = (config: PublicKey, mint: PublicKey, quote: PublicKey = WSOL_MINT) =>
  find([enc("pool"), config.toBytes(), maxKey(mint, quote).toBytes(), minKey(mint, quote).toBytes()], DBC_PROGRAM_ID);
export const dbcVaultPda = (tokenMint: PublicKey, pool: PublicKey) => find([enc("token_vault"), tokenMint.toBytes(), pool.toBytes()], DBC_PROGRAM_ID);

/** DAMM v2 pool: ["pool", config, max(a, b), min(a, b)] (DBC migration uses the Customizable config). */
export const dammPoolPda = (mint: PublicKey, config: PublicKey = DAMM_V2_MIGRATION_CONFIG, quote: PublicKey = WSOL_MINT) =>
  find([enc("pool"), config.toBytes(), maxKey(mint, quote).toBytes(), minKey(mint, quote).toBytes()], DAMM_V2_PROGRAM_ID);
export const dammVaultPda = (tokenMint: PublicKey, pool: PublicKey) => find([enc("token_vault"), tokenMint.toBytes(), pool.toBytes()], DAMM_V2_PROGRAM_ID);
export const dammPositionPda = (nftMint: PublicKey) => find([enc("position"), nftMint.toBytes()], DAMM_V2_PROGRAM_ID);
export const dammPositionNftAccountPda = (nftMint: PublicKey) => find([enc("position_nft_account"), nftMint.toBytes()], DAMM_V2_PROGRAM_ID);

/** Every per-coin fumpad address. */
export function coinAddresses(mint: PublicKey) {
  return {
    coin: coinPda(mint),
    rewardVault: rewardVault(mint),
    claimQueue: claimQueuePda(mint),
    observations: observationsPda(mint),
  };
}

export { TOKEN_PROGRAM_ID };
