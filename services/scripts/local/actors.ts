/** User/admin actions for the v0.7 local scenario, all built with @fumpad/sdk. */
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, type Signer, SystemProgram, type TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

import {
  closeTokenAccountIx,
  type CoinRefs,
  coinAta,
  confirmSignature,
  createAtaIdempotentIx,
  dammBuyIx,
  dammSellIx,
  dbcBuyIx,
  dbcCreateConfigIx,
  dbcSellIx,
  DEFAULT_PARAMS,
  decodeTokenAccount,
  fumpadConfigParams,
  type Params,
  routerBuyIx,
  routerSellIx,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  wrapSolIxs,
  wsolAta,
} from "@fumpad/sdk";

/**
 * Short windows for the local stack (outside `Params::is_valid`; seeded into the genesis): 5 s hold,
 * $5 minimum, 10 s challenge window, 60 s oracle window with ≥ 3 keeper samples 2 s apart.
 */
export const LOCAL_PARAMS: Params = {
  ...DEFAULT_PARAMS,
  minHoldSecs: 5n,
  minSellUsdCents: 500n,
  ticketChallengeSecs: 10n,
  oracleWindowSecs: 60n,
  oracleMinSpacingSecs: 2n,
  oracleMinSamples: 3,
  keeperStaleSecs: 60n,
};

export async function airdrop(conn: Connection, to: PublicKey, sol: number) {
  const bh = await conn.getLatestBlockhash();
  const sig = await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await confirmSignature(conn, sig, bh.lastValidBlockHeight, "confirmed");
}

export async function send(conn: Connection, payer: Keypair, ixs: TransactionInstruction[], signers: Signer[] = [], cu = 400_000): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...ixs] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([payer, ...signers]);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { maxRetries: 0, skipPreflight: false });
  await confirmSignature(conn, sig, lastValidBlockHeight, "confirmed", raw);
  return sig;
}

/** DBC create_config with the FUMPAD devnet curve (0.85 SOL raise) at `config` (fresh keypair). */
export async function createFumpadConfig(conn: Connection, admin: Keypair, config: Keypair) {
  return send(conn, admin, [dbcCreateConfigIx({ config: config.publicKey, payer: admin.publicKey, params: fumpadConfigParams("devnet") })], [config]);
}

export const tokenBalance = async (conn: Connection, owner: PublicKey, mint: PublicKey) => {
  const a = await conn.getAccountInfo(coinAta(owner, mint));
  return a ? decodeTokenAccount(new Uint8Array(a.data)).amount : 0n;
};

const prep = (who: Keypair, mint: PublicKey, wrap: bigint) => [
  ...(wrap > 0n ? wrapSolIxs(who.publicKey, wrap) : [createAtaIdempotentIx(who.publicKey, who.publicKey, WSOL_MINT, TOKEN_PROGRAM_ID)]),
  createAtaIdempotentIx(who.publicKey, who.publicKey, mint, TOKEN_2022_PROGRAM_ID),
];
const unwrap = (who: Keypair) => closeTokenAccountIx(wsolAta(who.publicKey), who.publicKey, who.publicKey);

/** Third-party trades straight on Meteora (as Axiom / bots would). */
export const directDbcBuy = (conn: Connection, who: Keypair, coin: CoinRefs, lamports: bigint) =>
  send(conn, who, [...prep(who, coin.mint, lamports), dbcBuyIx({ config: coin.dbcConfig, mint: coin.mint, owner: who.publicKey, lamportsIn: lamports, minOut: 0n }), unwrap(who)]);
export const directDbcSell = (conn: Connection, who: Keypair, coin: CoinRefs, tokens: bigint) =>
  send(conn, who, [...prep(who, coin.mint, 0n), dbcSellIx({ config: coin.dbcConfig, mint: coin.mint, owner: who.publicKey, tokensIn: tokens, minOut: 0n }), unwrap(who)]);
export const directDammBuy = (conn: Connection, who: Keypair, coin: CoinRefs, pool: PublicKey, lamports: bigint) =>
  send(conn, who, [...prep(who, coin.mint, lamports), dammBuyIx({ pool, mint: coin.mint, owner: who.publicKey, lamportsIn: lamports, minOut: 0n }), unwrap(who)]);
export const directDammSell = (conn: Connection, who: Keypair, coin: CoinRefs, pool: PublicKey, tokens: bigint) =>
  send(conn, who, [...prep(who, coin.mint, 0n), dammSellIx({ pool, mint: coin.mint, owner: who.publicKey, tokensIn: tokens, minOut: 0n }), unwrap(who)]);

/** FUMPAD router trades (the app's trade panel). */
export const routedBuy = (conn: Connection, who: Keypair, coin: CoinRefs, venue: "dbc" | "damm_v2", lamports: bigint, mode = 0) =>
  send(conn, who, [...prep(who, coin.mint, lamports), routerBuyIx({ trader: who.publicKey, coin, venue, amountIn: lamports, minOut: 0n, mode }), unwrap(who)]);
export const routedSell = (conn: Connection, who: Keypair, coin: CoinRefs, venue: "dbc" | "damm_v2", tokens: bigint) =>
  send(conn, who, [...prep(who, coin.mint, 0n), routerSellIx({ trader: who.publicKey, coin, venue, amountIn: tokens, minOut: 0n }), unwrap(who)]);

export const transferSol = (conn: Connection, from: Keypair, to: PublicKey, lamports: bigint) => send(conn, from, [SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports })]);

export { Keypair };
