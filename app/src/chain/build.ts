/**
 * Live transaction builders: UI arguments (display units) → v0.7 instruction lists, assembled from
 * @fumpad/sdk (instruction encoders, PDAs, account decoders: `npm run sdk` vendors it). No React
 * and no `@/` imports, so the scripts (`scripts/*.ts`) build exactly what the app builds.
 *
 * The SDK has no chain-reading client, so `FumpadClient` here is the thin piece that reads the
 * coin's status and pools and picks the router venue: DBC `swap2` on the curve (PartialFill, so a
 * buy that completes it doesn't revert), DAMM v2 `swap2` after graduation. The shapes are exactly
 * the ones the silent-signing allow-list (`./allowlist.ts`) accepts:
 *
 *   buy   [CB] ATA(coin, Token-2022) · wrap SOL (ATA(WSOL) · transfer · sync) · fumpad.buy · close WSOL
 *   sell  [CB] ATA(WSOL) · fumpad.sell · close WSOL
 *   claim [CB] ATA(coin) · fumpad.claim            (auto-claim, creator fees: one ix; escrow: ATA + ix)
 *
 * The slippage bound is never a fresh re-quote (M-9): it is the quote the user saw, minus
 * SLIPPAGE_BPS, so a price that moved against them before signing fails on chain instead of
 * filling at the new price. That quote comes from the API, so it isn't trusted either (V7-M3):
 * `prepareBuy` / `prepareSell` quote the trade again from the pool accounts over the app's own RPC
 * (@fumpad/sdk's DBC / DAMM v2 math), refuse a minimum below that quote × (1 − MAX_SLIPPAGE_BPS),
 * and hand the allow-list a policy with the exact amount in and that floor, which it enforces on
 * the router instruction.
 */
import { type Commitment, type Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import {
  type BuiltTx,
  claimIx,
  type CoinAccount,
  type CoinRefs,
  coinAta,
  coinPda,
  computeBudgetIxs,
  createAtaIdempotentIx,
  DAMM_V2_PROGRAM_ID,
  DBC_CONFIG_SIZE,
  DBC_PROGRAM_ID,
  dbcPoolPda,
  type DbcPoolConfig,
  decodeCoin,
  decodeDammPool,
  decodeDbcConfig,
  decodeDbcPool,
  decodeTicket,
  FUMPAD_PROGRAM_ID,
  quoteDammBuy,
  quoteDammSell,
  quoteDbcBuy,
  quoteDbcSell,
  routerBuyIx,
  routerSellIx,
  setAutoClaimIx,
  SWAP_MODE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unwrapSolIx,
  type Venue,
  withdrawCreatorFeesIx,
  withdrawEscrowIx,
  withSlippage,
  wrapSolIxs,
  WSOL_MINT,
} from "@fumpad/sdk";
import { baseToTokens, solToLamports, tokensToBase } from "../data/chain";
import type { SilentPolicy } from "./allowlist";

export type { BuiltTx };

/** Slippage applied to the quote the user saw (bps). The UI and the builders share it. */
export const SLIPPAGE_BPS = 200;

/**
 * V7-M3: the most a shown minimum may sit below the app's own quote of the same trade (bps). Above
 * SLIPPAGE_BPS so an honest quote a moment old still passes; a lowballed one (a compromised API
 * inviting a sandwich) is refused before anything is signed.
 */
export const MAX_SLIPPAGE_BPS = 500;

/** `amountOut` of the shown quote → the minimum the user accepts, in display units. */
export function minOutFromQuote(amountOut: number, slippageBps = SLIPPAGE_BPS): number {
  return (amountOut * (10_000 - slippageBps)) / 10_000;
}

/** Display tokens → base units, rounded down (a minimum must never round up past the quote). */
export const minTokensBase = (t: number) => {
  const b = tokensToBase(t);
  return baseToTokens(b) > t ? b - BigInt(1) : b;
};
/** Display SOL → lamports, rounded down. */
export const minLamports = (s: number) => {
  const l = solToLamports(s);
  return Number(l) / 1e9 > s ? l - BigInt(1) : l;
};

/** Compute units per transaction kind (routed DBC swap ≈ 67k CU, DAMM ≈ 47k, plus ATA/wrap). */
const CU = { trade: 200_000, claim: 120_000, small: 40_000 } as const;

/** Meteora DBC `PoolConfig` account discriminator (`sha256("account:PoolConfig")[..8]`; not in the SDK). */
const DBC_POOL_CONFIG_DISC = [26, 108, 14, 123, 116, 230, 129, 43];

export class CoinNotTradable extends Error {
  constructor(why: string) {
    super(why);
    this.name = "CoinNotTradable";
  }
}

export class QuoteRefused extends Error {
  constructor() {
    super("The quote is out of date or doesn't match the pool's price right now, so nothing was signed. Check the new quote and try again.");
    this.name = "QuoteRefused";
  }
}

export class LayoutError extends Error {
  constructor(what: string) {
    super(`Unexpected ${what} account data. The app may be out of date; reload and try again.`);
    this.name = "LayoutError";
  }
}

/** SDK `decodeCoin` (discriminator checked by the IDL coder) + the mint and DBC pool it must describe. */
export function readCoin(data: Uint8Array, mint: PublicKey): CoinAccount {
  let c: CoinAccount;
  try {
    c = decodeCoin(data);
  } catch {
    throw new LayoutError("coin");
  }
  if (!c.mint.equals(mint) || !dbcPoolPda(c.dbcConfig, c.mint).equals(c.dbcPool)) throw new LayoutError("coin");
  return c;
}

/** SDK `decodeDbcConfig`, after checking the bytes are a DBC `PoolConfig` quoted in WSOL. */
export function readDbcConfig(data: Uint8Array): DbcPoolConfig {
  if (data.length !== DBC_CONFIG_SIZE || !DBC_POOL_CONFIG_DISC.every((b, i) => data[i] === b)) throw new LayoutError("DBC config");
  const c = decodeDbcConfig(data);
  if (!c.quoteMint.equals(WSOL_MINT) || c.sqrtStartPrice === BigInt(0) || !c.curve.length) throw new LayoutError("DBC config");
  return c;
}

export class FumpadClient {
  constructor(
    readonly connection: Connection,
    readonly opts: { commitment?: Commitment; priorityMicroLamports?: number } = {},
  ) {}

  private get commitment(): Commitment {
    return this.opts.commitment ?? "confirmed";
  }
  private cb(units: number) {
    return computeBudgetIxs(units, this.opts.priorityMicroLamports);
  }

  /** The coin's on-chain record (owner and layout checked). */
  async coin(mint: PublicKey): Promise<CoinAccount> {
    const info = await this.connection.getAccountInfo(coinPda(mint), this.commitment);
    if (!info || !info.owner.equals(FUMPAD_PROGRAM_ID)) throw new CoinNotTradable("This coin isn't registered on FUMPAD.");
    return readCoin(new Uint8Array(info.data), mint);
  }

  /** Router venue + the coin's pool refs for this coin's current status. */
  private async route(mint: PublicKey): Promise<{ venue: Venue; coin: CoinRefs }> {
    const c = await this.coin(mint);
    if (c.status === "curve") return { venue: "dbc", coin: { mint, dbcConfig: c.dbcConfig, dbcPool: c.dbcPool } };
    if (c.status === "graduated") return { venue: "damm_v2", coin: { mint, dbcConfig: c.dbcConfig, dammPool: c.dammPool } };
    throw new CoinNotTradable("The curve just completed. Trading reopens on Meteora once the coin graduates, usually within a minute.");
  }

  /** Router buy for `lamportsIn` (fee included); `minTokensOut` in base units. Unused SOL comes back when the WSOL account closes. */
  async buildBuy(a: { user: PublicKey; mint: PublicKey; lamportsIn: bigint; minTokensOut: bigint }): Promise<BuiltTx> {
    if (a.lamportsIn <= BigInt(0) || a.minTokensOut <= BigInt(0)) throw new Error("The quote is too small to trade.");
    const r = await this.route(a.mint);
    const mode = r.venue === "dbc" ? SWAP_MODE.partialFill : SWAP_MODE.exactIn;
    return {
      instructions: [
        ...this.cb(CU.trade),
        createAtaIdempotentIx(a.user, a.user, a.mint, TOKEN_2022_PROGRAM_ID),
        ...wrapSolIxs(a.user, a.lamportsIn),
        routerBuyIx({ trader: a.user, coin: r.coin, venue: r.venue, amountIn: a.lamportsIn, minOut: a.minTokensOut, mode }),
        unwrapSolIx(a.user),
      ],
    };
  }

  /** Router sell of `tokensIn` base units; `minLamportsOut` from the shown quote. */
  async buildSell(a: { user: PublicKey; mint: PublicKey; tokensIn: bigint; minLamportsOut: bigint }): Promise<BuiltTx> {
    if (a.tokensIn <= BigInt(0) || a.minLamportsOut <= BigInt(0)) throw new Error("The quote is too small to trade.");
    const r = await this.route(a.mint);
    return {
      instructions: [
        ...this.cb(CU.trade),
        createAtaIdempotentIx(a.user, a.user, WSOL_MINT, TOKEN_PROGRAM_ID),
        routerSellIx({ trader: a.user, coin: r.coin, venue: r.venue, amountIn: a.tokensIn, minOut: a.minLamportsOut }),
        unwrapSolIx(a.user),
      ],
    };
  }

  /** `claim`: pays into the owner's canonical Token-2022 account (created first if needed) or joins the queue. */
  buildClaim(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey }): BuiltTx {
    return {
      instructions: [...this.cb(CU.claim), createAtaIdempotentIx(a.owner, a.owner, a.mint, TOKEN_2022_PROGRAM_ID), claimIx(a)],
    };
  }

  buildSetAutoClaim(a: { wallet: PublicKey; mint: PublicKey; enabled: boolean }): BuiltTx {
    return { instructions: [...this.cb(CU.small), setAutoClaimIx(a.wallet, a.mint, a.enabled)] };
  }

  buildWithdrawCreatorFees(a: { creator: PublicKey; mint: PublicKey }): BuiltTx {
    return { instructions: [...this.cb(CU.small), withdrawCreatorFeesIx(a.creator, a.mint)] };
  }

  /** D16: an escrowed payout to the owner's canonical account; the escrow's rent goes back to whoever paid it. */
  async buildWithdrawEscrow(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey }): Promise<BuiltTx> {
    const info = await this.connection.getAccountInfo(a.ticket, this.commitment);
    if (!info || !info.owner.equals(FUMPAD_PROGRAM_ID)) throw new Error("That ticket isn't on chain.");
    let t: ReturnType<typeof decodeTicket>;
    try {
      t = decodeTicket(new Uint8Array(info.data));
    } catch {
      throw new LayoutError("ticket");
    }
    if (!t.owner.equals(a.owner) || !t.mint.equals(a.mint)) throw new LayoutError("ticket");
    if (t.status !== "escrowed") throw new Error("That ticket has nothing in escrow.");
    return {
      instructions: [
        ...this.cb(CU.claim),
        createAtaIdempotentIx(a.owner, a.owner, a.mint, TOKEN_2022_PROGRAM_ID),
        withdrawEscrowIx({ owner: a.owner, mint: a.mint, ticket: a.ticket, destination: coinAta(a.owner, a.mint), escrowPayer: t.escrowPayer }),
      ],
    };
  }

  /**
   * V7-M3: the trade quoted from the pool accounts over this connection (not the API): DBC on the
   * curve (a buy as PartialFill, like the router sends it), DAMM v2 after graduation. Base units /
   * lamports in, the output after fees out.
   */
  async quote(a: { mint: PublicKey; side: "buy" | "sell"; amountIn: bigint }): Promise<{ venue: Venue; amountOut: bigint; partialFill: boolean }> {
    const r = await this.route(a.mint);
    if (r.venue === "dbc") {
      const [cfgInfo, poolInfo, slot] = await Promise.all([
        this.connection.getAccountInfo(r.coin.dbcConfig, this.commitment),
        this.connection.getAccountInfo(r.coin.dbcPool!, this.commitment),
        this.connection.getSlot(this.commitment),
      ]);
      if (!cfgInfo || !cfgInfo.owner.equals(DBC_PROGRAM_ID) || !poolInfo || !poolInfo.owner.equals(DBC_PROGRAM_ID)) throw new LayoutError("curve");
      const cfg = readDbcConfig(new Uint8Array(cfgInfo.data));
      const pool = decodeDbcPool(new Uint8Array(poolInfo.data));
      if (!pool.baseMint.equals(a.mint) || !pool.config.equals(r.coin.dbcConfig)) throw new LayoutError("curve");
      const q = a.side === "buy" ? quoteDbcBuy(cfg, pool, a.amountIn, BigInt(slot), { partialFill: true }) : quoteDbcSell(cfg, pool, a.amountIn, BigInt(slot));
      return { venue: r.venue, amountOut: q.amountOut, partialFill: q.partialFill };
    }
    const info = await this.connection.getAccountInfo(r.coin.dammPool!, this.commitment);
    if (!info || !info.owner.equals(DAMM_V2_PROGRAM_ID)) throw new LayoutError("pool");
    const pool = decodeDammPool(new Uint8Array(info.data));
    if (!pool.tokenAMint.equals(a.mint) || !pool.tokenBMint.equals(WSOL_MINT)) throw new LayoutError("pool");
    const q = a.side === "buy" ? quoteDammBuy(pool, a.amountIn) : quoteDammSell(pool, a.amountIn);
    return { venue: r.venue, amountOut: q.amountOut, partialFill: false };
  }

  /** A FUMPAD DBC config (for the launch's first-buy check). */
  async dbcConfig(config: PublicKey): Promise<DbcPoolConfig> {
    const info = await this.connection.getAccountInfo(config, this.commitment);
    if (!info || !info.owner.equals(DBC_PROGRAM_ID)) throw new Error("Couldn't read the launch's curve config.");
    return readDbcConfig(new Uint8Array(info.data));
  }

  /** A v0 transaction (no lookup tables: the allow-list refuses them). */
  async toTransaction(payer: PublicKey, b: BuiltTx): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.commitment);
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: b.instructions }).compileToV0Message();
    return { tx: new VersionedTransaction(msg), blockhash, lastValidBlockHeight };
  }
}

export function fumpadClient(connection: Connection): FumpadClient {
  return new FumpadClient(connection, { commitment: "confirmed" });
}

/**
 * V7-M3: the floor for a trade's minimum, from the app's own quote; refuses a shown minimum below it.
 * Returns the policy the allow-list enforces on the router instruction (exact amount in, min out ≥ floor).
 */
async function boundTrade(client: FumpadClient, a: { mint: PublicKey; side: "buy" | "sell"; amountIn: bigint; minOut: bigint }): Promise<SilentPolicy> {
  const q = await client.quote(a);
  const floor = withSlippage(q.amountOut, MAX_SLIPPAGE_BPS);
  if (floor <= BigInt(0) || a.minOut < floor) throw new QuoteRefused();
  const mint = a.mint.toBase58();
  return a.side === "buy"
    ? { action: "buy", mint, maxSolInLamports: a.amountIn, amountIn: a.amountIn, minOut: floor }
    : { action: "sell", mint, amountIn: a.amountIn, minOut: floor };
}

export interface PreparedTrade {
  built: BuiltTx;
  policy: SilentPolicy;
}

/** Router buy, checked against the app's own quote (V7-M3): the transaction and the allow-list policy it must pass. */
export async function prepareBuy(client: FumpadClient, wallet: PublicKey, a: { mint: string; solIn: number; minTokensOut: number }): Promise<PreparedTrade> {
  const mint = new PublicKey(a.mint);
  const amountIn = solToLamports(a.solIn);
  const minOut = minTokensBase(a.minTokensOut);
  const policy = await boundTrade(client, { mint, side: "buy", amountIn, minOut });
  return { built: await client.buildBuy({ user: wallet, mint, lamportsIn: amountIn, minTokensOut: minOut }), policy };
}

/** Router sell, checked against the app's own quote (V7-M3). */
export async function prepareSell(client: FumpadClient, wallet: PublicKey, a: { mint: string; tokensIn: number; minSolOut: number }): Promise<PreparedTrade> {
  const mint = new PublicKey(a.mint);
  const amountIn = tokensToBase(a.tokensIn);
  const minOut = minLamports(a.minSolOut);
  const policy = await boundTrade(client, { mint, side: "sell", amountIn, minOut });
  return { built: await client.buildSell({ user: wallet, mint, tokensIn: amountIn, minLamportsOut: minOut }), policy };
}

/** Router buy for `solIn` (fee included); `minTokensOut` is the shown quote after slippage (display tokens). */
export function buildBuyTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; solIn: number; minTokensOut: number }): Promise<BuiltTx> {
  return client.buildBuy({ user: wallet, mint: new PublicKey(a.mint), lamportsIn: solToLamports(a.solIn), minTokensOut: minTokensBase(a.minTokensOut) });
}

/** Router sell. Any qualifying sell becomes a ticket by keeper attestation afterwards (no ticket work in the transaction). */
export function buildSellTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; tokensIn: number; minSolOut: number }): Promise<BuiltTx> {
  return client.buildSell({ user: wallet, mint: new PublicKey(a.mint), tokensIn: tokensToBase(a.tokensIn), minLamportsOut: minLamports(a.minSolOut) });
}

/** `claim` (pays now or queues), creating the owner's Token-2022 account first if needed. */
export function buildClaimTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; ticket: string }): BuiltTx {
  return client.buildClaim({ owner: wallet, mint: new PublicKey(a.mint), ticket: new PublicKey(a.ticket) });
}

/** D17 `set_auto_claim` on one coin (needs the wallet's Position, i.e. it has a ticket there). */
export function buildSetAutoClaimTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; enabled: boolean }): BuiltTx {
  return client.buildSetAutoClaim({ wallet, mint: new PublicKey(a.mint), enabled: a.enabled });
}

/** `withdraw_creator_fees`: the coin's unclaimed creator fees to the creator (signer must be Coin.creator). */
export function buildWithdrawCreatorFeesTx(client: FumpadClient, wallet: PublicKey, a: { mint: string }): BuiltTx {
  return client.buildWithdrawCreatorFees({ creator: wallet, mint: new PublicKey(a.mint) });
}

/** D16 `withdraw_escrow`: an escrowed payout to the owner's own token account. */
export function buildWithdrawEscrowTx(client: FumpadClient, wallet: PublicKey, a: { mint: string; ticket: string }): Promise<BuiltTx> {
  return client.buildWithdrawEscrow({ owner: wallet, mint: new PublicKey(a.mint), ticket: new PublicKey(a.ticket) });
}
