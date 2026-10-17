/**
 * What the Trading wallet (Privy embedded) may sign without showing anything.
 *
 * Silent signing is only safe if the transaction is exactly what our builders make. This
 * module checks the compiled message, not our intentions: an unexpected program, an
 * unexpected signer, a lookup table (but THE launch table on a launch, below), an instruction acting for someone else or on another
 * coin, an account list that isn't the canonical one, a buy larger than the amount the user
 * typed or an outsized priority fee all refuse. The patterns are the app's builders (`./build.ts`)
 * and the API's launch prepare, both @fumpad/sdk v0.7 (`contracts/INTERFACE-v0.7.md`); real
 * transactions captured from the local stack pin them (`fixtures/local-v07.json`, the tests):
 *
 *   buy     [CB] ATA(coin) · wrap SOL (ATA(WSOL) · transfer → own WSOL · sync) · fumpad.buy · close WSOL
 *   sell    [CB] ATA(WSOL) · fumpad.sell · close WSOL
 *   claim   [CB] ATA(coin) · fumpad.claim
 *   auto-claim / withdraw (creator fees) / escrow: [CB] [ATA(coin)] + the one FUMPAD instruction
 *   launch  [CB] [wrap SOL] · DBC initialize_virtual_pool_with_token2022 · [ATA(coin) · DBC swap2
 *           (the creator's top-level first buy, with the instructions sysvar)] · fumpad.register_coin
 *           · [close WSOL]
 *
 * Every FUMPAD and Meteora instruction is rebuilt with the SDK from the wallet, the coin's mint,
 * the amounts it carries and the one free account the program checks on chain (the DBC config,
 * the DAMM v2 pool, the ticket) and must match it exactly, accounts and data: the router's swap
 * accounts must be the wallet's own canonical token accounts in the right direction, with the
 * wallet as payer and no referral.
 * The wallet never signs a DAMM v2 instruction directly, nor any Token-2022 instruction, nor a
 * Token instruction other than SyncNative / CloseAccount on its own WSOL account.
 *
 * Lookup tables: only a launch may use one, and only THE launch table — the address this build is configured with
 * (NEXT_PUBLIC_LAUNCH_ALT, never the API's word), loaded from chain by the caller and passed in `policy.lookupTable`,
 * whose contents must be exactly @fumpad/sdk `launchAltAddresses()` and which must be frozen and active
 * (`launchAltProblems`: nobody can change what an index points at). The message's keys are resolved through it, then
 * every check below runs on the resolved accounts exactly as for an inline launch. Signers are always static keys.
 *
 * The withdraw flow (Trading wallet → an address) is the one plain System transfer we sign, and
 * it has its own exact pattern (`vetWithdrawTx`), only after the user confirmed it on screen.
 *
 * No React, no `@/` imports: unit-tested by `allowlist.test.ts` with `npm test`.
 */
import { ed25519 } from "@noble/curves/ed25519";
import { type AddressLookupTableAccount, ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID as ATA_PROGRAM_ID,
  claimIx,
  coinPda,
  DAMM_V2_PROGRAM_ID,
  DBC_IX,
  DBC_PROGRAM_ID,
  dbcBuyIx,
  dbcInitializePoolToken2022Ix,
  eventAuthorityPda,
  FUMPAD_IDL,
  FUMPAD_PROGRAM_ID,
  globalPda,
  launchAltProblems,
  registerCoinIx,
  routerBuyIx,
  routerSellIx,
  setAutoClaimIx,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  withdrawCreatorFeesIx,
  withdrawEscrowIx,
  WSOL_MINT,
  wsolAta,
} from "@fumpad/sdk";
import { FUMPAD_PROGRAM_ADDRESS, LAUNCH_ALT_ADDRESS } from "./cluster";

export { ATA_PROGRAM_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID };

/**
 * The one FUMPAD program this build signs for: NEXT_PUBLIC_FUMPAD_PROGRAM_ID (`./cluster.ts`). The SDK's id (its own
 * FUMPAD_PROGRAM_ID, fed from the same variable by next.config.ts) builds every expected instruction and PDA, so the
 * two must agree: if they don't, this module refuses to load (and `vetFumpadTx` re-checks on every call), so a
 * mis-built app can never sign for a program other than the configured one.
 */
export function configuredProgram(sdkProgramId: PublicKey = FUMPAD_PROGRAM_ID, configured: string = FUMPAD_PROGRAM_ADDRESS): PublicKey {
  const p = new PublicKey(configured);
  if (p.toBase58() !== configured || !sdkProgramId.equals(p))
    throw new Error(`FUMPAD program mismatch: the app is configured for ${configured} but @fumpad/sdk uses ${sdkProgramId.toBase58()} (NEXT_PUBLIC_FUMPAD_PROGRAM_ID / next.config.ts env)`);
  return p;
}
const PROGRAM = configuredProgram();

/** FUMPAD v0.7 instructions a user wallet signs. */
type FumpadIxName = "buy" | "sell" | "register_coin" | "claim" | "set_auto_claim" | "withdraw_creator_fees" | "withdraw_escrow";
/** Anchor discriminators, from the SDK's IDL. */
const FUMPAD_IX = Object.fromEntries(
  (["buy", "sell", "register_coin", "claim", "set_auto_claim", "withdraw_creator_fees", "withdraw_escrow"] as const).map((n) => {
    const ix = (FUMPAD_IDL.instructions as unknown as { name: string; discriminator: number[] }[]).find((i) => i.name === n);
    if (!ix) throw new Error(`IDL has no ${n}`);
    return [n, ix.discriminator];
  }),
) as unknown as Record<FumpadIxName, readonly number[]>;
const startsWith = (d: Uint8Array, p: readonly number[]) => d.length >= p.length && p.every((b, i) => d[i] === b);

/** Total priority fee a silently signed transaction may carry (0.01 SOL). */
export const MAX_PRIORITY_FEE_LAMPORTS = BigInt(10_000_000);
/** Solana's per-transaction compute ceiling. */
const MAX_CU = 1_400_000;
/** Default CU budget per instruction when no limit is set (runtime rule). */
const DEFAULT_CU_PER_IX = 200_000;

/** The one FUMPAD instruction each app action is built around. */
export const ACTION_IX = {
  buy: "buy",
  sell: "sell",
  claim: "claim",
  "auto-claim": "set_auto_claim",
  withdraw: "withdraw_creator_fees",
  escrow: "withdraw_escrow",
  launch: "register_coin",
} as const satisfies Record<string, FumpadIxName>;
export type FumpadAction = keyof typeof ACTION_IX;

/** Actions that move SOL into the wallet's WSOL account (and may close it again). */
const WRAPS: readonly FumpadAction[] = ["buy", "launch"];
const UNWRAPS: readonly FumpadAction[] = ["buy", "sell", "launch"];

export interface SilentPolicy {
  /** The app action; limits which instructions may appear. */
  action: FumpadAction;
  /** The coin the action is for (base58). Every instruction must be about this mint. */
  mint: string;
  /**
   * Upper bound on SOL the transaction commits to buys (lamports): router `buy` / first-buy
   * `swap2` amounts and the SOL wrapped into WSOL, each summed. Required for buys and launches
   * (0 = a launch without a first buy).
   */
  maxSolInLamports?: bigint;
  /** Launch only: the reserved mint, which the API already signed as (D18). */
  coSigner?: string;
  /**
   * Launch only (INTERFACE-v0.7 §8.1): `Params.launch_signer` as read from the chain's Global by the
   * app (never from the API), when one is configured. The API co-signs `register_coin` with it; the
   * transaction must then carry exactly that extra signer, with a valid signature, in register_coin's
   * `launch_signer` slot. Unset: no extra signer, and the slot holds the program id.
   */
  launchSigner?: string;
  /**
   * Buys and sells (required, V7-M3): the router's exact `amount_in` (lamports / base units) and the
   * lowest `min_out` the app accepts, i.e. its own quote of the trade from the pool accounts minus
   * the max slippage (`./build.ts` `prepareBuy` / `prepareSell`), never the API's number.
   */
  amountIn?: bigint;
  minOut?: bigint;
  /** Claims and escrow withdrawals (required): the ticket the user picked (base58). */
  ticket?: string;
  /**
   * Launch only, when the transaction uses a lookup table: the configured launch table as loaded from chain by the
   * app (`connection.getAddressLookupTable(NEXT_PUBLIC_LAUNCH_ALT)`), never from the API. Re-verified here.
   */
  lookupTable?: AddressLookupTableAccount;
}

export class SilentSignRefused extends Error {
  constructor(why: string) {
    super(`Refusing to sign: ${why}.`);
    this.name = "SilentSignRefused";
  }
}

const refuse = (why: string): never => {
  throw new SilentSignRefused(why);
};

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);
const u32 = (d: Uint8Array, o: number) => view(d).getUint32(o, true);
const u64 = (d: Uint8Array, o: number) => view(d).getBigUint64(o, true);

/** ed25519 verify; a malformed signature or key is simply invalid. */
export function verifySignature(sig: Uint8Array, msg: Uint8Array, signer: PublicKey): boolean {
  try {
    return sig.length === 64 && ed25519.verify(sig, msg, signer.toBytes());
  } catch {
    return false;
  }
}

interface Ix {
  program: PublicKey;
  keys: PublicKey[];
  data: Uint8Array;
}

/**
 * The launch table's addresses, in message order (writable lookups, then read-only), after checking it is the one
 * configured launch table, verified (`launchAltProblems`: exact contents, frozen, active) and that every index exists.
 */
function launchTableKeys(lookups: VersionedTransaction["message"]["addressTableLookups"], table: AddressLookupTableAccount | undefined, configured: string | undefined): PublicKey[] {
  if (lookups.length !== 1) refuse("it uses more than one address lookup table");
  if (!configured) refuse("it uses an address lookup table and this app has no launch table configured");
  const want = new PublicKey(configured!);
  if (!lookups[0].accountKey.equals(want)) refuse("it uses an address lookup table that isn't FUMPAD's launch table");
  if (!table) refuse("the launch lookup table couldn't be loaded to check it");
  const problems = launchAltProblems(table, want, PROGRAM);
  if (problems.length) refuse(`the launch lookup table isn't the expected one (${problems[0]})`);
  const addrs = table!.state.addresses;
  const pick = (i: number) => addrs[i] ?? refuse("it references lookup table entries that don't exist");
  return [...lookups[0].writableIndexes.map(pick), ...lookups[0].readonlyIndexes.map(pick)];
}

/** Message → plain instructions, after the checks every silent transaction must pass. */
function open(
  tx: VersionedTransaction,
  wallet: PublicKey,
  coSigners: string[],
  alt: { allowed: boolean; table?: AddressLookupTableAccount; configured?: string } = { allowed: false },
): { ixs: Ix[]; isSigner: (k: PublicKey) => boolean } {
  const m = tx.message;
  const lookups = "addressTableLookups" in m ? m.addressTableLookups : [];
  if (lookups.length && !alt.allowed) refuse("it uses address lookup tables");
  const statics = m.staticAccountKeys;
  // Signers are static keys only (the runtime never takes a signer from a table); `n` below indexes `statics`.
  const keys = lookups.length ? [...statics, ...launchTableKeys(lookups, alt.table, alt.configured)] : statics;
  if (!statics.length || !statics[0].equals(wallet)) refuse("your wallet isn't the fee payer");
  const n = m.header.numRequiredSignatures;
  if (n > statics.length) refuse("it asks for unexpected signers");
  const signers = statics.slice(0, n);
  const others = signers.slice(1).map((k) => k.toBase58());
  if (others.length !== coSigners.length || others.some((k) => !coSigners.includes(k))) refuse("it asks for unexpected signers");
  // Co-signers sign before us; a blank slot means someone wants our signature first. L-7: the
  // signature must verify (ed25519 over these exact message bytes), not just be non-zero.
  if (n > 1) {
    const msg = m.serialize();
    for (let i = 1; i < n; i++) {
      const sig = tx.signatures[i];
      if (!sig || sig.every((b) => b === 0)) refuse("a co-signer hasn't signed");
      if (!verifySignature(sig, msg, statics[i])) refuse("a co-signer's signature doesn't match the transaction");
    }
  }
  const ixs = m.compiledInstructions.map((c) => {
    if (c.programIdIndex >= keys.length || c.accountKeyIndexes.some((i) => i >= keys.length)) refuse("it references accounts it doesn't list");
    return { program: keys[c.programIdIndex], keys: c.accountKeyIndexes.map((i) => keys[i]), data: c.data };
  });
  return { ixs, isSigner: (k) => signers.some((s) => s.equals(k)) };
}

/** ComputeBudget: one limit and one price at most, and a capped total priority fee. */
function vetComputeBudget(ixs: Ix[]): Ix[] {
  let limit: number | null = null;
  let price: bigint | null = null;
  const rest: Ix[] = [];
  for (const ix of ixs) {
    if (!ix.program.equals(ComputeBudgetProgram.programId)) {
      rest.push(ix);
      continue;
    }
    if (ix.keys.length) refuse("unexpected compute budget accounts");
    if (ix.data[0] === 2 && ix.data.length === 5 && limit === null) limit = u32(ix.data, 1);
    else if (ix.data[0] === 3 && ix.data.length === 9 && price === null) price = u64(ix.data, 1);
    else refuse("unexpected compute budget instruction");
  }
  const units = BigInt(Math.min(MAX_CU, limit ?? DEFAULT_CU_PER_IX * rest.length));
  if (limit !== null && limit > MAX_CU) refuse("compute limit too high");
  if (price !== null && (units * price) / BigInt(1_000_000) > MAX_PRIORITY_FEE_LAMPORTS) refuse("priority fee too high");
  return rest;
}

/** Same account keys, in order. */
function sameKeys(got: PublicKey[], want: PublicKey[]): boolean {
  return got.length === want.length && got.every((k, i) => k.equals(want[i]));
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
/**
 * The instruction is exactly `want` (rebuilt with @fumpad/sdk from the wallet, the coin and the one
 * free account the program checks on chain): same program, same accounts in order, same data.
 */
function isExactly(ix: Ix, want: TransactionInstruction): boolean {
  return ix.program.equals(want.programId) && sameKeys(ix.keys, want.keys.map((m) => m.pubkey)) && sameBytes(ix.data, want.data);
}
/** Rebuild with the SDK; arguments decoded from a tampered instruction may make the builder throw. */
function rebuilt(build: () => TransactionInstruction): TransactionInstruction | null {
  try {
    return build();
  } catch {
    return null;
  }
}
const coinAtaOf = (owner: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_2022_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];

/**
 * ATA create / create_idempotent for the wallet's own account, paid by the wallet, and only
 * for the coin (Token-2022) or, when the action wraps/unwraps SOL, WSOL (SPL Token).
 * Returns true for the WSOL account.
 */
function vetAtaCreate(ix: Ix, wallet: PublicKey, mint: PublicKey, allowWsol: boolean): boolean {
  if (!(ix.data.length === 0 || (ix.data.length === 1 && (ix.data[0] === 0 || ix.data[0] === 1)))) refuse("unexpected token account instruction");
  if (ix.keys.length !== 6) refuse("unexpected token account layout");
  const [payer, account, owner, ataMint, system, tokenProgram] = ix.keys;
  if (!payer.equals(wallet) || !owner.equals(wallet)) refuse("token account isn't yours");
  if (!system.equals(SystemProgram.programId)) refuse("unexpected token account layout");
  const coin = ataMint.equals(mint) && tokenProgram.equals(TOKEN_2022_PROGRAM_ID);
  const wsol = allowWsol && ataMint.equals(WSOL_MINT) && tokenProgram.equals(TOKEN_PROGRAM_ID);
  if (!coin && !wsol) refuse("it creates a token account for another token");
  const [expected] = PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), ataMint.toBuffer()], ATA_PROGRAM_ID);
  if (!account.equals(expected)) refuse("token account address doesn't match");
  return wsol;
}

/** System transfer from the wallet into its own WSOL account (wrapping SOL for a buy). Returns lamports. */
function vetWrapTransfer(ix: Ix, wallet: PublicKey): bigint {
  if (ix.data.length !== 12 || u32(ix.data, 0) !== 2) refuse("unexpected System instruction");
  if (ix.keys.length !== 2 || !ix.keys[0].equals(wallet) || !ix.keys[1].equals(wsolAta(wallet)))
    refuse("it moves SOL somewhere other than your own WSOL account");
  return u64(ix.data, 4);
}

/** SPL Token: only SyncNative / CloseAccount on the wallet's own WSOL account (SOL back to the wallet). */
function vetTokenIx(ix: Ix, wallet: PublicKey, allowSync: boolean): "sync" | "close" {
  const acct = wsolAta(wallet);
  if (allowSync && ix.data.length === 1 && ix.data[0] === 17 && ix.keys.length === 1 && ix.keys[0].equals(acct)) return "sync";
  if (ix.data.length === 1 && ix.data[0] === 9 && ix.keys.length === 3 && ix.keys[0].equals(acct) && ix.keys[1].equals(wallet) && ix.keys[2].equals(wallet))
    return "close";
  return refuse("unexpected token instruction");
}

/**
 * Router `buy` / `sell`: rebuilt with the SDK for this wallet, this coin and the venue's pool
 * (the DBC config / the DAMM v2 pool, which the router checks belong to the coin), with the
 * amounts, minimum and mode decoded from the instruction, then compared byte for byte: our
 * accounts, the wallet's own canonical token accounts in the right direction, no referral.
 * Returns the buy's SOL.
 */
function vetRouterTrade(ix: Ix, side: "buy" | "sell", wallet: PublicKey, mint: PublicKey, policy: SilentPolicy): bigint {
  if (ix.data.length !== (side === "buy" ? 25 : 24)) refuse(`malformed ${side}`);
  const mode = side === "buy" ? ix.data[24] : 0;
  if (mode !== 0 && mode !== 1) refuse("unexpected swap mode");
  const amountIn = u64(ix.data, 8);
  const minOut = u64(ix.data, 16);
  if (amountIn === BigInt(0)) refuse(`empty ${side}`);
  // V7-M3: the amount the user entered, and a real slippage bound from the app's own quote.
  if (amountIn !== policy.amountIn) refuse(`the ${side} amount differs from what you entered`);
  if (minOut < policy.minOut!) refuse("its minimum output is below the price the pool quotes right now");
  if (ix.keys.length < 6 || !ix.keys[0].equals(wallet)) refuse("it acts for another wallet");
  const venueProgram = ix.keys[3];
  const remaining = ix.keys.slice(6);
  let venue: "dbc" | "damm_v2";
  if (venueProgram.equals(DBC_PROGRAM_ID)) {
    venue = "dbc";
    if (remaining.length !== 15) refuse("unexpected curve swap accounts");
  } else if (venueProgram.equals(DAMM_V2_PROGRAM_ID)) {
    venue = "damm_v2";
    if (remaining.length !== 14) refuse("unexpected pool swap accounts");
  } else {
    return refuse("it routes to an unknown venue");
  }
  // The router's own accounts: trader, global, this coin, the venue program, event authority, program.
  if (!sameKeys(ix.keys.slice(0, 6), [wallet, globalPda(), coinPda(mint), venueProgram, eventAuthorityPda(), PROGRAM]))
    refuse(`unexpected ${side} accounts`);
  const coin = venue === "dbc" ? { mint, dbcConfig: remaining[1] } : { mint, dbcConfig: PublicKey.default, dammPool: remaining[1] };
  const want = rebuilt(() =>
    side === "buy" ? routerBuyIx({ trader: wallet, coin, venue, amountIn, minOut, mode }) : routerSellIx({ trader: wallet, coin, venue, amountIn, minOut }),
  );
  if (!want || !isExactly(ix, want)) refuse("the swap doesn't use your own token accounts on this coin's pool");
  return side === "buy" ? amountIn : BigInt(0);
}

/** Borsh string at `o` → [value, next offset]. */
function borshStr(d: Uint8Array, o: number): [string, number] {
  if (o + 4 > d.length) refuse("malformed launch metadata");
  const n = u32(d, o);
  if (n > 200 || o + 4 + n > d.length) refuse("malformed launch metadata");
  return [new TextDecoder("utf-8", { fatal: true }).decode(d.subarray(o + 4, o + 4 + n)), o + 4 + n];
}

export interface LaunchShape {
  config: PublicKey;
  name: string;
  symbol: string;
  uri: string;
  /** The creator's first buy (`swap2` amount_0 / amount_1 / mode), when present. */
  firstBuy?: { amountIn: bigint; minOut: bigint; mode: number };
}

/** DBC `initialize_virtual_pool_with_token2022` for this wallet + mint: rebuilt from its config and metadata, the creator paying. */
function vetDbcInit(ix: Ix, wallet: PublicKey, mint: PublicKey): Omit<LaunchShape, "firstBuy"> {
  if (!startsWith(ix.data, DBC_IX.initializeVirtualPoolWithToken2022)) refuse("unexpected curve instruction");
  if (ix.keys.length !== 14) refuse("unexpected launch accounts");
  const config = ix.keys[0];
  const [name, a] = borshStr(ix.data, 8);
  const [symbol, b] = borshStr(ix.data, a);
  const [uri, c] = borshStr(ix.data, b);
  if (c !== ix.data.length) refuse("malformed launch metadata");
  const want = rebuilt(() => dbcInitializePoolToken2022Ix({ config, creator: wallet, mint, payer: wallet, name, symbol, uri }));
  if (!want || !isExactly(ix, want)) refuse("the launch creates a different coin or pool");
  return { config, name, symbol, uri };
}

/**
 * The creator's top-level DBC `swap2` buy: this coin's pool on `config`, the wallet's own
 * accounts, no referral, and the instructions sysvar (without it DBC can't see the pool init in
 * the same transaction and charges the first buy the launch window's 99% fee).
 */
function vetDbcFirstBuy(ix: Ix, wallet: PublicKey, mint: PublicKey, config: PublicKey): NonNullable<LaunchShape["firstBuy"]> {
  if (!startsWith(ix.data, DBC_IX.swap2) || ix.data.length !== 25) refuse("unexpected curve instruction");
  const mode = ix.data[24];
  if (mode !== 0 && mode !== 1) refuse("unexpected swap mode");
  const amountIn = u64(ix.data, 8);
  const minOut = u64(ix.data, 16);
  const want = rebuilt(() => dbcBuyIx({ config, mint, owner: wallet, lamportsIn: amountIn, minOut, mode, ixSysvar: true }));
  if (!want || !isExactly(ix, want)) refuse("your first buy isn't on this coin's pool with your own accounts");
  return { amountIn, minOut, mode };
}

/**
 * `register_coin` as the program now takes it (INTERFACE-v0.7 §8.1: an optional `launch_signer` signer
 * before the event-CPI pair, the program id when unset). ASSUMPTION until @fumpad/sdk is repacked
 * with that IDL: its `registerCoinIx` takes `launchSigner?: PublicKey | null`. With the SDK's
 * current (pre-§8) IDL there is no slot: a launch with a configured launch signer is refused.
 */
const REGISTER_HAS_LAUNCH_SIGNER = (FUMPAD_IDL.instructions as unknown as { name: string; accounts: { name: string }[] }[])
  .find((i) => i.name === "register_coin")!
  .accounts.some((a) => a.name === "launch_signer");
function expectedRegisterCoin(creator: PublicKey, mint: PublicKey, dbcConfig: PublicKey, launchSigner: PublicKey | null): TransactionInstruction {
  if (REGISTER_HAS_LAUNCH_SIGNER) {
    const build = registerCoinIx as unknown as (a: { creator: PublicKey; mint: PublicKey; dbcConfig: PublicKey; launchSigner: PublicKey | null }) => TransactionInstruction;
    return build({ creator, mint, dbcConfig, launchSigner });
  }
  if (launchSigner) refuse("this app version can't check the launch co-signer yet");
  return registerCoinIx({ creator, mint, dbcConfig });
}

/** The exact SDK instruction a claim-side action must be (accounts re-derived, data re-encoded). */
function vetUserIx(ix: Ix, main: "claim" | "set_auto_claim" | "withdraw_creator_fees" | "withdraw_escrow", wallet: PublicKey, mint: PublicKey, ticket: PublicKey | null): void {
  switch (main) {
    case "claim": {
      // The ticket the user picked (the program also checks its owner and mint); the payout goes to the wallet's own account.
      const want = ticket ? claimIx({ owner: wallet, mint, ticket }) : null;
      if (!want || !isExactly(ix, want)) refuse("unexpected claim accounts");
      return;
    }
    case "set_auto_claim":
      if (!isExactly(ix, setAutoClaimIx(wallet, mint, true)) && !isExactly(ix, setAutoClaimIx(wallet, mint, false))) refuse("unexpected auto-claim instruction");
      return;
    case "withdraw_creator_fees":
      if (!isExactly(ix, withdrawCreatorFeesIx(wallet, mint))) refuse("unexpected withdrawal accounts");
      return;
    case "withdraw_escrow": {
      // The ticket the user picked; the one free account is the escrow payer (the program requires it
      // to be Ticket.escrow_payer, and it only gets the escrow's rent back). The payout goes to the wallet's own account.
      const want =
        ticket && ix.keys.length === 11
          ? rebuilt(() => withdrawEscrowIx({ owner: wallet, mint, ticket, destination: coinAtaOf(wallet, mint), escrowPayer: ix.keys[7] }))
          : null;
      if (!want || !isExactly(ix, want)) refuse("unexpected escrow accounts");
      return;
    }
  }
}

/**
 * Throws `SilentSignRefused` unless `tx` is one of our FUMPAD transactions for `wallet`,
 * `policy.action` and `policy.mint`. Returns the SOL the transaction commits to buys (lamports)
 * and, for a launch, what it launches. `launchAlt`: the launch lookup table this build accepts
 * (NEXT_PUBLIC_LAUNCH_ALT; a parameter for the tests only).
 */
export function vetFumpadTx(tx: VersionedTransaction, wallet: PublicKey, policy: SilentPolicy, launchAlt: string | undefined = LAUNCH_ALT_ADDRESS): { solInLamports: bigint; launch?: LaunchShape } {
  if (!FUMPAD_PROGRAM_ID.equals(PROGRAM)) refuse("the app and its SDK disagree on the FUMPAD program");
  const action = policy.action;
  if (!(action in ACTION_IX)) refuse("unknown action");
  let mint: PublicKey;
  try {
    mint = new PublicKey(policy.mint);
  } catch {
    return refuse("unknown coin");
  }
  if (action === "launch" ? policy.coSigner !== policy.mint : policy.coSigner !== undefined || policy.launchSigner !== undefined)
    refuse(action === "launch" ? "a launch needs its reserved mint" : "it asks for unexpected signers");
  let launchSigner: PublicKey | null = null;
  if (policy.launchSigner !== undefined) {
    try {
      launchSigner = new PublicKey(policy.launchSigner);
    } catch {
      return refuse("unknown launch co-signer");
    }
    if (launchSigner.equals(PublicKey.default) || policy.launchSigner === policy.mint) refuse("unknown launch co-signer");
  }
  if (WRAPS.includes(action) && policy.maxSolInLamports === undefined) refuse("a buy needs a spending limit");
  if ((action === "buy" || action === "sell") && (policy.amountIn === undefined || policy.minOut === undefined || policy.minOut <= BigInt(0)))
    refuse("a trade needs its amount and a minimum output");
  let ticket: PublicKey | null = null;
  if (action === "claim" || action === "escrow") {
    try {
      ticket = new PublicKey(policy.ticket ?? "");
    } catch {
      return refuse("a claim needs its ticket");
    }
  }
  // Co-signers: the reserved mint and, when configured, the launch signer; each signature verified (L-7).
  if (policy.lookupTable && action !== "launch") refuse("only a launch may use a lookup table");
  const { ixs, isSigner } = open(tx, wallet, [...(policy.coSigner ? [policy.coSigner] : []), ...(launchSigner ? [launchSigner.toBase58()] : [])], {
    allowed: action === "launch",
    table: policy.lookupTable,
    configured: launchAlt,
  });
  const rest = vetComputeBudget(ixs);
  if (!isSigner(wallet)) refuse("your wallet isn't a signer");

  const main = ACTION_IX[action];
  let mains = 0;
  let buys = BigInt(0);
  let wrapped = BigInt(0);
  // Launch bookkeeping: [wrap SOL] → init → [coin ATA · first buy] → register_coin → [close WSOL], all on one config.
  let init: Omit<LaunchShape, "firstBuy"> | null = null;
  let firstBuy: LaunchShape["firstBuy"];
  /** A launch's pool (and its mint) come first: before it only the creator's SOL wrap may run. */
  const beforeInit = () => action === "launch" && !init;

  for (const ix of rest) {
    const p = ix.program;
    if (p.equals(ATA_PROGRAM_ID)) {
      const wsol = vetAtaCreate(ix, wallet, mint, UNWRAPS.includes(action));
      if (beforeInit() && !wsol) refuse("the launch is out of order");
    } else if (p.equals(SystemProgram.programId)) {
      if (!WRAPS.includes(action)) refuse("it moves SOL");
      wrapped += vetWrapTransfer(ix, wallet);
    } else if (p.equals(TOKEN_PROGRAM_ID)) {
      if (!UNWRAPS.includes(action)) refuse("unexpected token instruction");
      const kind = vetTokenIx(ix, wallet, WRAPS.includes(action));
      if (beforeInit() && kind !== "sync") refuse("the launch is out of order");
    } else if (p.equals(DBC_PROGRAM_ID)) {
      if (action !== "launch") refuse("it calls the curve directly");
      if (!init) {
        init = vetDbcInit(ix, wallet, mint);
      } else {
        if (firstBuy || mains) refuse("the launch has an unexpected extra swap");
        firstBuy = vetDbcFirstBuy(ix, wallet, mint, init.config);
        buys += firstBuy.amountIn;
      }
    } else if (p.equals(PROGRAM)) {
      if (beforeInit()) refuse("the launch is out of order");
      if (!startsWith(ix.data, FUMPAD_IX[main])) refuse("it contains a FUMPAD instruction this action doesn't use");
      if (mains++) refuse("it repeats the action");
      // Every user instruction's first account is the acting wallet, as signer.
      if (!ix.keys[0]?.equals(wallet) || !isSigner(ix.keys[0])) refuse("it acts for another wallet");
      if (main === "buy" || main === "sell") buys += vetRouterTrade(ix, main, wallet, mint, policy);
      else if (main === "register_coin") {
        if (!isExactly(ix, expectedRegisterCoin(wallet, mint, init!.config, launchSigner))) refuse("it registers a different coin");
      } else vetUserIx(ix, main, wallet, mint, ticket);
    } else {
      refuse(`it calls a program FUMPAD doesn't use (${p.toBase58().slice(0, 8)}…)`);
    }
  }

  if (mains !== 1) refuse("it isn't a FUMPAD transaction");
  if (action === "launch" && !init) refuse("it isn't a launch");
  if (wrapped > BigInt(0) && buys === BigInt(0)) refuse("it wraps SOL without a buy");
  const solIn = buys > wrapped ? buys : wrapped;
  if (policy.maxSolInLamports !== undefined && solIn > policy.maxSolInLamports) refuse("it spends more SOL than you entered");
  return { solInLamports: solIn, launch: init ? { ...init, firstBuy } : undefined };
}

/**
 * The withdraw pattern: optional compute budget, then exactly one System transfer of
 * `lamports` from `wallet` to `destination`. Nothing else.
 */
export function vetWithdrawTx(tx: VersionedTransaction, wallet: PublicKey, destination: PublicKey, lamports: bigint): void {
  const { ixs } = open(tx, wallet, []);
  const rest = vetComputeBudget(ixs);
  if (rest.length !== 1) refuse("a withdrawal is a single transfer");
  const [ix] = rest;
  if (!ix.program.equals(SystemProgram.programId)) refuse("a withdrawal is a System transfer");
  if (ix.data.length !== 12 || u32(ix.data, 0) !== 2) refuse("a withdrawal is a plain transfer");
  if (ix.keys.length !== 2 || !ix.keys[0].equals(wallet) || !ix.keys[1].equals(destination)) refuse("the destination doesn't match");
  if (u64(ix.data, 4) !== lamports) refuse("the amount doesn't match");
}
