/**
 * ADAPTER (until @fumpad/sdk v0.7): the thin client the app's builders (`../build.ts`) call. It
 * reads only what routing needs from chain (the coin's status and pools, a DBC config for the
 * launch check, a ticket's escrow payer) and assembles exactly the transaction shapes the
 * silent-signing allow-list (`../allowlist.ts`) accepts:
 *
 *   buy   [CB] ATA(coin, Token-2022) · wrap SOL (ATA(WSOL) · transfer · sync) · fumpad.buy · close WSOL
 *   sell  [CB] ATA(WSOL) · fumpad.sell · close WSOL
 *   claim [CB] ATA(coin) · fumpad.claim            (auto-claim, creator fees, escrow: one ix each)
 *
 * The slippage bound is always the caller's (the shown quote minus slippage, M-9); the client
 * never re-quotes. Swap for `FumpadClient` from @fumpad/sdk v0.7 when it ships.
 *
 * No React, no `@/` imports.
 */
import {
  type Commitment,
  type Connection,
  type Keypair,
  type PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { type CoinAccount, decodeCoin, decodeDbcCurveStart, decodeTicket, type DbcCurveStart } from "./accounts";
import { coinAta, DBC_PROGRAM_ID, FUMPAD_PROGRAM_ID, coinPda, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, WSOL_MINT, wsolAta } from "./ids";
import {
  claimIx,
  computeBudgetIxs,
  createAtaIdempotentIx,
  dammSwapAccounts,
  dbcSwapAccounts,
  routerBuyIx,
  routerSellIx,
  setAutoClaimIx,
  unwrapSolIx,
  withdrawCreatorFeesIx,
  withdrawEscrowIx,
  wrapSolIxs,
} from "./ix";

export interface BuiltTx {
  instructions: TransactionInstruction[];
  signers?: Keypair[];
}

/** Compute units per transaction kind (routed DBC swap ≈ 67k CU, DAMM ≈ 47k, plus ATA/wrap). */
const CU = { trade: 200_000, claim: 120_000, small: 40_000 } as const;

export class CoinNotTradable extends Error {
  constructor(why: string) {
    super(why);
    this.name = "CoinNotTradable";
  }
}

export class FumpadClientV07 {
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
    return decodeCoin(new Uint8Array(info.data), mint);
  }

  /** Router venue + the venue's swap2 accounts for this trader and side. */
  private async route(trader: PublicKey, mint: PublicKey, side: "buy" | "sell") {
    const c = await this.coin(mint);
    if (c.status === "curve") return { venue: "dbc" as const, swapAccounts: dbcSwapAccounts({ trader, mint, config: c.dbcConfig, side }) };
    if (c.status === "graduated") return { venue: "damm" as const, swapAccounts: dammSwapAccounts({ trader, mint, pool: c.dammPool, side }) };
    throw new CoinNotTradable("The curve just completed. Trading reopens on Meteora once the coin graduates, usually within a minute.");
  }

  /** Router buy for `lamportsIn` (fee included); `minTokensOut` in base units. Unused SOL comes back when the WSOL account closes. */
  async buildBuy(a: { user: PublicKey; mint: PublicKey; lamportsIn: bigint; minTokensOut: bigint }): Promise<BuiltTx> {
    if (a.lamportsIn <= BigInt(0) || a.minTokensOut <= BigInt(0)) throw new Error("The quote is too small to trade.");
    const r = await this.route(a.user, a.mint, "buy");
    return {
      instructions: [
        ...this.cb(CU.trade),
        createAtaIdempotentIx(a.user, a.user, a.mint, TOKEN_2022_PROGRAM_ID, coinAta(a.user, a.mint)),
        ...wrapSolIxs(a.user, a.lamportsIn),
        routerBuyIx({ trader: a.user, mint: a.mint, ...r, amountIn: a.lamportsIn, minOut: a.minTokensOut }),
        unwrapSolIx(a.user),
      ],
    };
  }

  /** Router sell of `tokensIn` base units; `minLamportsOut` from the shown quote. */
  async buildSell(a: { user: PublicKey; mint: PublicKey; tokensIn: bigint; minLamportsOut: bigint }): Promise<BuiltTx> {
    if (a.tokensIn <= BigInt(0) || a.minLamportsOut <= BigInt(0)) throw new Error("The quote is too small to trade.");
    const r = await this.route(a.user, a.mint, "sell");
    return {
      instructions: [
        ...this.cb(CU.trade),
        createAtaIdempotentIx(a.user, a.user, WSOL_MINT, TOKEN_PROGRAM_ID, wsolAta(a.user)),
        routerSellIx({ trader: a.user, mint: a.mint, ...r, amountIn: a.tokensIn, minOut: a.minLamportsOut }),
        unwrapSolIx(a.user),
      ],
    };
  }

  /** `claim`: pays into the owner's canonical Token-2022 account (created first if needed) or joins the queue. */
  buildClaim(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey }): BuiltTx {
    return {
      instructions: [...this.cb(CU.claim), createAtaIdempotentIx(a.owner, a.owner, a.mint, TOKEN_2022_PROGRAM_ID, coinAta(a.owner, a.mint)), claimIx(a)],
    };
  }

  buildSetAutoClaim(a: { wallet: PublicKey; mint: PublicKey; enabled: boolean }): BuiltTx {
    return { instructions: [...this.cb(CU.small), setAutoClaimIx(a)] };
  }

  buildWithdrawCreatorFees(a: { creator: PublicKey; mint: PublicKey }): BuiltTx {
    return { instructions: [...this.cb(CU.small), withdrawCreatorFeesIx(a)] };
  }

  /** D16: an escrowed payout to the owner's canonical account; the escrow's rent goes back to whoever paid it. */
  async buildWithdrawEscrow(a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey }): Promise<BuiltTx> {
    const info = await this.connection.getAccountInfo(a.ticket, this.commitment);
    if (!info || !info.owner.equals(FUMPAD_PROGRAM_ID)) throw new Error("That ticket isn't on chain.");
    const t = decodeTicket(new Uint8Array(info.data), { owner: a.owner, mint: a.mint });
    if (t.status !== 5) throw new Error("That ticket has nothing in escrow.");
    return {
      instructions: [
        ...this.cb(CU.claim),
        createAtaIdempotentIx(a.owner, a.owner, a.mint, TOKEN_2022_PROGRAM_ID, coinAta(a.owner, a.mint)),
        withdrawEscrowIx({ ...a, escrowPayer: t.escrowPayer }),
      ],
    };
  }

  /** A FUMPAD DBC config's curve start and fee (for the launch's first-buy check). */
  async dbcCurveStart(config: PublicKey): Promise<DbcCurveStart> {
    const info = await this.connection.getAccountInfo(config, this.commitment);
    if (!info || !info.owner.equals(DBC_PROGRAM_ID)) throw new Error("Couldn't read the launch's curve config.");
    return decodeDbcCurveStart(new Uint8Array(info.data));
  }

  /** A v0 transaction (no lookup tables: the allow-list refuses them). */
  async toTransaction(payer: PublicKey, b: BuiltTx): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash(this.commitment);
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: b.instructions }).compileToV0Message();
    return { tx: new VersionedTransaction(msg), blockhash, lastValidBlockHeight };
  }
}
