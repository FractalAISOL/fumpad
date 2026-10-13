/** User-side actions for the local scenario, all built with @fumpad/sdk. */
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";

import {
  type BuiltTx,
  coinAta,
  DEFAULT_PARAMS,
  directBuyIx,
  FumpadClient,
  globalPda,
  initializeGlobalIx,
  type Params,
  setKeepersIx,
  wrapSolIxs,
  coinAddresses,
  computeBudgetIxs,
  parseBuybackFeeRecipients,
  PUMPSWAP_GLOBAL_CONFIG,
  buybackFeeRecipientAta,
  confirmSignature,
  createAtaIdempotentIx,
  TOKEN_2022_PROGRAM_ID,
} from "@fumpad/sdk/v06";

/** Fast local params: 2s maturity; 60 s oracle window (6 × 10 s coverage buckets), ≥3 keeper samples, 2 s spacing. */
/**
 * Short test windows for the local stack. Outside `Params::is_valid` bounds since v0.6 (hold ≥ 60 s,
 * oracle window ≥ 10 min, …): seed them into the genesis with `startValidator({ global })`.
 */
export const LOCAL_PARAMS: Params = {
  ...DEFAULT_PARAMS,
  minHoldSecs: 2n,
  oracleWindowSecs: 60n,
  oracleMinSpacingSecs: 2n,
  oracleMinSamples: 3,
};

export async function airdrop(conn: Connection, to: PublicKey, sol: number) {
  const bh = await conn.getLatestBlockhash();
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await confirmSignature(conn, sig, bh.lastValidBlockHeight, "confirmed");
}

/**
 * initialize_global + set_keepers — unless the Global was pre-seeded into the genesis
 * (`startValidator({ global })`, needed for LOCAL_PARAMS since v0.6 bounds refuse them).
 */
export async function initGlobal(c: FumpadClient, upgradeAuthority: Keypair, admin: Keypair, treasury: PublicKey, keeper: PublicKey, params = LOCAL_PARAMS) {
  if (!(await c.connection.getAccountInfo(globalPda()))) {
    await c.send(upgradeAuthority, { instructions: [initializeGlobalIx({ payer: upgradeAuthority.publicKey, admin: admin.publicKey, platformTreasury: treasury, params })] });
    await c.send(admin, { instructions: [setKeepersIx(admin.publicKey, [keeper])] });
  }
  // The PumpSwap buyback-fee recipient's WSOL ATA exists on mainnet/devnet; create it here.
  const ix = await c.ensureBuybackFeeRecipientIx(admin.publicKey);
  if (ix) await c.send(admin, { instructions: [ix] });
}

export async function send(c: FumpadClient, payer: Keypair, b: BuiltTx) {
  return c.send(payer, b);
}

/** Direct PumpSwap buy outside FUMPAD (wrap + buy) — "rebuy elsewhere" / outside volume. */
export async function directPumpBuy(c: FumpadClient, trader: Keypair, mint: PublicKey, lamports: bigint) {
  const gc = await c.connection.getAccountInfo(PUMPSWAP_GLOBAL_CONFIG);
  const bfr = buybackFeeRecipientAta(parseBuybackFeeRecipients(new Uint8Array(gc!.data))[0]);
  const a = coinAddresses(mint);
  return c.send(trader, {
    instructions: [
      ...computeBudgetIxs(300_000),
      ...wrapSolIxs(trader.publicKey, lamports),
      // base ATA must exist for PumpSwap
      createAtaIdempotentIx(trader.publicKey, trader.publicKey, mint, TOKEN_2022_PROGRAM_ID),
      directBuyIx({ pool: a.pool, mint, poolBase: a.poolBase, poolQuote: a.poolQuote }, trader.publicKey, lamports, 1n, bfr),
    ],
  });
}

export async function tokenBalance(c: FumpadClient, owner: PublicKey, mint: PublicKey) {
  return c.tokenBalance(coinAta(owner, mint));
}
