/**
 * Silent-signing allow-list (v0.7), synthetic shapes. Transactions are assembled from the same
 * @fumpad/sdk encoders the app's builders and the API use (thin adapters below give them the
 * account lists the tamper tests need), then tampered with one way at a time: every allowed shape
 * is accepted, every deviation refused. The real transactions captured from the local stack are
 * tested in `fixtures.test.ts`.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AccountMeta,
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  claimIx as sdkClaimIx,
  coinAta,
  computeBudgetIxs,
  DAMM_V2_PROGRAM_ID,
  DBC_IX,
  DBC_PROGRAM_ID,
  dbcBuyIx,
  dbcInitializePoolToken2022Ix,
  FUMPAD_PROGRAM_ID,
  launchInstructions,
  registerCoinIx as sdkRegisterCoinIx,
  routerBuyIx as sdkRouterBuyIx,
  routerSellIx as sdkRouterSellIx,
  routerVenueAccounts,
  setAutoClaimIx as sdkSetAutoClaimIx,
  SYSVAR_INSTRUCTIONS_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unwrapSolIx,
  withdrawCreatorFeesIx as sdkWithdrawCreatorFeesIx,
  withdrawEscrowIx as sdkWithdrawEscrowIx,
  wrapSolIxs,
  WSOL_MINT,
  wsolAta,
} from "@fumpad/sdk";
import { SilentSignRefused, type SilentPolicy, vetFumpadTx, vetWithdrawTx } from "./allowlist";

/* ── adapters: SDK encoders with the account lists the tamper tests swap ── */
type Venue = "dbc" | "damm";
type Side = "buy" | "sell";
const sdkVenue = (v: Venue): "dbc" | "damm_v2" => (v === "dbc" ? "dbc" : "damm_v2");
/** Raw ATA create_idempotent with an explicit account (so a test can pass the wrong one). */
function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, m: PublicKey, tokenProgram: PublicKey, account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: m, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}
const dbcSwapAccounts = (a: { trader: PublicKey; mint: PublicKey; config: PublicKey; side: Side }): AccountMeta[] =>
  routerVenueAccounts({ mint: a.mint, dbcConfig: a.config }, "dbc", a.trader, a.side);
const dammSwapAccounts = (a: { trader: PublicKey; mint: PublicKey; pool: PublicKey; side: Side }): AccountMeta[] =>
  routerVenueAccounts({ mint: a.mint, dbcConfig: PublicKey.default, dammPool: a.pool }, "damm_v2", a.trader, a.side);
/** SDK router instruction with its swap accounts replaced by `swapAccounts`. */
function withSwap(ix: TransactionInstruction, swapAccounts: AccountMeta[]): TransactionInstruction {
  return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: [...ix.keys.slice(0, 6), ...swapAccounts] });
}
type RouterArgs = { trader: PublicKey; mint: PublicKey; venue: Venue; swapAccounts: AccountMeta[]; amountIn: bigint; minOut: bigint; mode?: number };
const routerBuyIx = (t: RouterArgs) =>
  withSwap(
    sdkRouterBuyIx({ trader: t.trader, coin: { mint: t.mint, dbcConfig: PublicKey.default }, venue: sdkVenue(t.venue), amountIn: t.amountIn, minOut: t.minOut, mode: t.mode ?? (t.venue === "dbc" ? 1 : 0) }),
    t.swapAccounts,
  );
const routerSellIx = (t: RouterArgs) =>
  withSwap(sdkRouterSellIx({ trader: t.trader, coin: { mint: t.mint, dbcConfig: PublicKey.default }, venue: sdkVenue(t.venue), amountIn: t.amountIn, minOut: t.minOut }), t.swapAccounts);
const claimIx = (a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey }) => sdkClaimIx(a);
const setAutoClaimIx = (a: { wallet: PublicKey; mint: PublicKey; enabled: boolean }) => sdkSetAutoClaimIx(a.wallet, a.mint, a.enabled);
const withdrawCreatorFeesIx = (a: { creator: PublicKey; mint: PublicKey }) => sdkWithdrawCreatorFeesIx(a.creator, a.mint);
const withdrawEscrowIx = (a: { owner: PublicKey; mint: PublicKey; ticket: PublicKey; escrowPayer: PublicKey; destination?: PublicKey }) =>
  sdkWithdrawEscrowIx({ ...a, destination: a.destination ?? coinAta(a.owner, a.mint) });
const registerCoinIx = (a: { creator: PublicKey; mint: PublicKey; config: PublicKey }) => sdkRegisterCoinIx({ creator: a.creator, mint: a.mint, dbcConfig: a.config });
const dbcInitPoolIx = (a: { config: PublicKey; creator: PublicKey; mint: PublicKey; name: string; symbol: string; uri: string }) =>
  dbcInitializePoolToken2022Ix({ ...a, payer: a.creator });
/** The creator's top-level first buy (with the instructions sysvar, as the API builds it). */
const dbcFirstBuyIx = (a: { creator: PublicKey; mint: PublicKey; config: PublicKey; amountIn: bigint; minOut: bigint; mode?: number }) =>
  dbcBuyIx({ config: a.config, mint: a.mint, owner: a.creator, lamportsIn: a.amountIn, minOut: a.minOut, mode: a.mode, ixSysvar: true });

const wallet = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const otherMint = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const dammPool = Keypair.generate().publicKey;
const ticket = Keypair.generate().publicKey;
const BLOCKHASH = "11111111111111111111111111111111";
const SOL = BigInt(1_000_000_000);
const TENTH = SOL / BigInt(10);
const M = mint.toBase58();
const T = ticket.toBase58();

function tx(ixs: TransactionInstruction[], payer = wallet, alts: AddressLookupTableAccount[] = []): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(alts));
}
const refused = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof SilentSignRefused && (!re || re.test(e.message)));
const cb = (units = 200_000, price?: number) => computeBudgetIxs(units, price);

const swapAccounts = (venue: Venue, side: Side, trader = wallet, m = mint) =>
  venue === "dbc" ? dbcSwapAccounts({ trader, mint: m, config, side }) : dammSwapAccounts({ trader, mint: m, pool: dammPool, side });
const routerBuy = (venue: Venue = "dbc", amountIn = TENTH, accounts = swapAccounts(venue, "buy")) =>
  routerBuyIx({ trader: wallet, mint, venue, swapAccounts: accounts, amountIn, minOut: BigInt(1) });
const routerSell = (venue: Venue = "dbc", accounts = swapAccounts(venue, "sell")) =>
  routerSellIx({ trader: wallet, mint, venue, swapAccounts: accounts, amountIn: SELL_IN, minOut: BigInt(1) });
const coinAtaIx = (owner = wallet, m = mint) => createAtaIdempotentIx(wallet, owner, m, TOKEN_2022_PROGRAM_ID, coinAta(owner, m));
const wsolAtaIx = () => createAtaIdempotentIx(wallet, wallet, WSOL_MINT, TOKEN_PROGRAM_ID, wsolAta(wallet));
/** Exactly what `FumpadClient.buildBuy` / `buildSell` (`./build.ts`) emit. */
const buyTx = (venue: Venue = "dbc", lamports = TENTH, buy = routerBuy(venue, lamports)) =>
  tx([...cb(), coinAtaIx(), ...wrapSolIxs(wallet, lamports), buy, unwrapSolIx(wallet)]);
const sellTx = (venue: Venue = "dbc", sell = routerSell(venue)) => tx([...cb(), wsolAtaIx(), sell, unwrapSolIx(wallet)]);
const buyPolicy = (max = TENTH, amountIn = max): SilentPolicy => ({ action: "buy", mint: M, maxSolInLamports: max, amountIn, minOut: BigInt(1) });
const SELL_IN = BigInt(5_000_000);
const sellPolicy: SilentPolicy = { action: "sell", mint: M, amountIn: SELL_IN, minOut: BigInt(1) };
/** Replace the key at `i` of an instruction (a tampered account list). */
function withKey(ix: TransactionInstruction, i: number, k: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((m, j) => (j === i ? { ...m, pubkey: k } : m)) });
}

/**
 * The launch the API prepares (@fumpad/sdk `launchInstructions`: [CB] wrap → DBC init → ATA →
 * creator's swap2 (+ sysvar) → register_coin → close WSOL), signed by the mint. Variants for the
 * refusal tests.
 */
function launchTx(
  mintKp: Keypair,
  o: {
    buy?: bigint;
    sysvar?: boolean;
    name?: string;
    cfg?: PublicKey;
    order?: "sdk" | "init-first" | "ata-first" | "register-before-buy" | "swap-before-init";
    registerCfg?: PublicKey;
    buyIx?: TransactionInstruction;
    extra?: TransactionInstruction[];
  } = {},
) {
  const m = mintKp.publicKey;
  const cfg = o.cfg ?? config;
  const init = dbcInitPoolIx({ config: cfg, creator: wallet, mint: m, name: o.name ?? "Pigeon", symbol: "PIGN", uri: "ipfs://x" });
  const reg = registerCoinIx({ creator: wallet, mint: m, config: o.registerCfg ?? cfg });
  let swap = o.buy ? (o.buyIx ?? dbcFirstBuyIx({ creator: wallet, mint: m, config: cfg, amountIn: o.buy, minOut: BigInt(1) })) : null;
  if (swap && o.sysvar === false && !o.buyIx) swap = new TransactionInstruction({ programId: swap.programId, data: swap.data, keys: swap.keys.slice(0, 15) });
  const ata = createAtaIdempotentIx(wallet, wallet, m, TOKEN_2022_PROGRAM_ID, coinAta(wallet, m));
  const wrap = o.buy ? wrapSolIxs(wallet, o.buy) : [];
  const close = o.buy ? [unwrapSolIx(wallet)] : [];
  let ixs: TransactionInstruction[];
  const order = o.order ?? "sdk";
  if (order === "sdk" && !o.buyIx && o.sysvar !== false && !o.registerCfg && !o.extra && !o.name && !o.cfg) {
    ixs = launchInstructions({ creator: wallet, mint: m, dbcConfig: cfg, name: "Pigeon", symbol: "PIGN", uri: "ipfs://x", buyLamports: o.buy, minTokensOut: BigInt(1) });
  } else if (order === "sdk") ixs = [...cb(400_000), ...wrap, init, ...(swap ? [ata, swap] : []), reg, ...close, ...(o.extra ?? [])];
  else if (order === "init-first") ixs = [...cb(400_000), init, ...(swap ? [ata, ...wrap, swap, ...close] : []), reg];
  else if (order === "ata-first") ixs = [...cb(), ata, init, ...wrap, ...(swap ? [swap] : []), reg, ...close];
  else if (order === "swap-before-init") ixs = [...cb(), ...wrap, ata, swap!, init, reg, ...close];
  else ixs = [...cb(), ...wrap, init, reg, ...(swap ? [ata, swap] : []), ...close];
  const t = tx(ixs);
  t.sign([mintKp]);
  return t;
}
const launchPolicy = (mintKp: Keypair, max = BigInt(0)): SilentPolicy => ({
  action: "launch",
  mint: mintKp.publicKey.toBase58(),
  coSigner: mintKp.publicKey.toBase58(),
  maxSolInLamports: max,
});

describe("vetFumpadTx: allowed shapes", () => {
  it("router buy and sell on the curve (DBC) and after graduation (DAMM v2)", () => {
    assert.equal(vetFumpadTx(buyTx("dbc"), wallet, buyPolicy()).solInLamports, TENTH);
    assert.equal(vetFumpadTx(buyTx("damm"), wallet, buyPolicy()).solInLamports, TENTH);
    assert.equal(vetFumpadTx(sellTx("dbc"), wallet, sellPolicy).solInLamports, BigInt(0));
    vetFumpadTx(sellTx("damm"), wallet, sellPolicy);
  });

  it("claim, auto-claim, creator fees, escrow", () => {
    vetFumpadTx(tx([...cb(), coinAtaIx(), claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim", mint: M, ticket: T });
    vetFumpadTx(tx([...cb(), setAutoClaimIx({ wallet, mint, enabled: false })]), wallet, { action: "auto-claim", mint: M });
    vetFumpadTx(tx([withdrawCreatorFeesIx({ creator: wallet, mint })]), wallet, { action: "withdraw", mint: M });
    vetFumpadTx(tx([...cb(), coinAtaIx(), withdrawEscrowIx({ owner: wallet, mint, ticket, escrowPayer: other })]), wallet, { action: "escrow", mint: M, ticket: T });
  });

  it("a launch, with and without the creator's first buy, co-signed by the mint", () => {
    const k = Keypair.generate();
    const plain = vetFumpadTx(launchTx(k), wallet, launchPolicy(k));
    assert.equal(plain.launch?.name, "Pigeon");
    assert.ok(plain.launch?.config.equals(config));
    assert.equal(plain.launch?.firstBuy, undefined);
    const withBuy = vetFumpadTx(launchTx(k, { buy: TENTH }), wallet, launchPolicy(k, TENTH));
    assert.equal(withBuy.solInLamports, TENTH);
    assert.equal(withBuy.launch?.firstBuy?.amountIn, TENTH);
    // The pre-SDK order (wrap after the init) is fine too: every instruction is still vetted.
    vetFumpadTx(launchTx(k, { buy: TENTH, order: "init-first" }), wallet, launchPolicy(k, TENTH));
  });

  it("refuses a first buy without the instructions sysvar (DBC would charge it the 99% window fee)", () => {
    const k = Keypair.generate();
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH, sysvar: false }), wallet, launchPolicy(k, TENTH)), /first buy/);
  });
});

describe("vetFumpadTx: router trades", () => {
  it("refuses a buy above the amount entered, counting the router amount and the SOL wrapped", () => {
    refused(() => vetFumpadTx(buyTx("dbc", SOL), wallet, buyPolicy()), /differs from what you entered/);
    refused(() => vetFumpadTx(buyTx("dbc", SOL), wallet, buyPolicy(TENTH, SOL)), /more SOL/);
    // A small router amount but a big wrap.
    refused(() => vetFumpadTx(tx([...cb(), ...wrapSolIxs(wallet, SOL), routerBuy("dbc", TENTH), unwrapSolIx(wallet)]), wallet, buyPolicy()), /more SOL/);
    // Two wraps summed.
    refused(() => vetFumpadTx(tx([...wrapSolIxs(wallet, TENTH), ...wrapSolIxs(wallet, TENTH), routerBuy()]), wallet, buyPolicy()), /more SOL/);
    // Two buys in one transaction.
    refused(() => vetFumpadTx(tx([routerBuy(), routerBuy()]), wallet, buyPolicy(SOL, TENTH)), /repeats/);
  });

  it("V7-M3: refuses a min_out below the app's own quote floor, a trade without bounds, another amount", () => {
    const lowBuy = routerBuyIx({ trader: wallet, mint, venue: "dbc", swapAccounts: swapAccounts("dbc", "buy"), amountIn: TENTH, minOut: BigInt(0) });
    refused(() => vetFumpadTx(buyTx("dbc", TENTH, lowBuy), wallet, buyPolicy()), /minimum output/);
    const floor = BigInt(1_000_000);
    const atFloor = routerBuyIx({ trader: wallet, mint, venue: "damm", swapAccounts: swapAccounts("damm", "buy"), amountIn: TENTH, minOut: floor });
    vetFumpadTx(buyTx("damm", TENTH, atFloor), wallet, { ...buyPolicy(), minOut: floor });
    refused(() => vetFumpadTx(buyTx("damm", TENTH, atFloor), wallet, { ...buyPolicy(), minOut: floor + BigInt(1) }), /minimum output/);
    refused(() => vetFumpadTx(sellTx("dbc"), wallet, { ...sellPolicy, minOut: BigInt(2) }), /minimum output/);
    refused(() => vetFumpadTx(sellTx("dbc"), wallet, { ...sellPolicy, amountIn: SELL_IN - BigInt(1) }), /differs/);
    refused(() => vetFumpadTx(sellTx("dbc"), wallet, { action: "sell", mint: M }), /minimum output/);
    refused(() => vetFumpadTx(sellTx("dbc"), wallet, { ...sellPolicy, minOut: BigInt(0) }), /minimum output/);
    refused(() => vetFumpadTx(buyTx(), wallet, { action: "buy", mint: M, maxSolInLamports: TENTH }), /minimum output/);
  });

  it("refuses a buy without a spending limit", () => {
    refused(() => vetFumpadTx(buyTx(), wallet, { action: "buy", mint: M }), /spending limit/);
  });

  it("refuses a trade on another coin than the one the user is on", () => {
    refused(() => vetFumpadTx(buyTx(), wallet, { ...buyPolicy(), mint: otherMint.toBase58() }));
    const elsewhere = routerBuyIx({
      trader: wallet,
      mint: otherMint,
      venue: "dbc",
      swapAccounts: swapAccounts("dbc", "buy", wallet, otherMint),
      amountIn: TENTH,
      minOut: BigInt(1),
    });
    refused(() => vetFumpadTx(tx([elsewhere]), wallet, buyPolicy()), /accounts/);
  });

  it("refuses swap accounts that aren't the wallet's own, in the right direction, on this coin's pool", () => {
    const dbcBuy = swapAccounts("dbc", "buy");
    const tamper = (i: number, k: PublicKey, venue: Venue = "dbc") => {
      const acc = (venue === "dbc" ? dbcBuy : swapAccounts("damm", "buy")).map((m, j) => (j === i ? { ...m, pubkey: k } : m));
      return tx([routerBuy(venue, TENTH, acc)]);
    };
    refused(() => vetFumpadTx(tamper(4, coinAta(other, mint)), wallet, buyPolicy()), /own token accounts/); // output to someone else
    refused(() => vetFumpadTx(tamper(3, other), wallet, buyPolicy()), /own token accounts/); // input from another account
    refused(() => vetFumpadTx(tamper(2, other), wallet, buyPolicy()), /own token accounts/); // another pool on the same config
    refused(() => vetFumpadTx(tamper(1, other), wallet, buyPolicy()), /own token accounts|accounts/); // pool from another config: pool PDA mismatch
    refused(() => vetFumpadTx(tamper(12, other), wallet, buyPolicy()), /own token accounts/); // a referral account
    refused(() => vetFumpadTx(tamper(5, other), wallet, buyPolicy()), /own token accounts/); // a vault
    refused(() => vetFumpadTx(tamper(3, other, "damm"), wallet, buyPolicy()), /own token accounts/);
    refused(() => vetFumpadTx(tamper(11, other, "damm"), wallet, buyPolicy()), /own token accounts/); // DAMM referral
    // Buy accounts on a sell (direction swapped), and the reverse.
    refused(() => vetFumpadTx(tx([routerSell("dbc", swapAccounts("dbc", "buy"))]), wallet, sellPolicy), /own token accounts/);
    refused(() => vetFumpadTx(tx([routerBuy("damm", TENTH, swapAccounts("damm", "sell"))]), wallet, buyPolicy()), /own token accounts/);
    // DAMM accounts under the DBC venue (or vice versa), an extra account, a missing one.
    refused(
      () =>
        vetFumpadTx(
          tx([routerBuyIx({ trader: wallet, mint, venue: "dbc", swapAccounts: swapAccounts("damm", "buy"), amountIn: TENTH, minOut: BigInt(1) })]),
          wallet,
          buyPolicy(),
        ),
      /curve swap accounts/,
    );
    refused(
      () => vetFumpadTx(tx([routerBuy("dbc", TENTH, [...dbcBuy, { pubkey: other, isSigner: false, isWritable: true }])]), wallet, buyPolicy()),
      /curve swap accounts/,
    );
    refused(() => vetFumpadTx(tx([routerBuy("dbc", TENTH, dbcBuy.slice(0, 14))]), wallet, buyPolicy()), /curve swap accounts/);
  });

  it("refuses an unknown venue, another trader, or tampered router accounts", () => {
    refused(() => vetFumpadTx(tx([withKey(routerBuy(), 3, other)]), wallet, buyPolicy()), /unknown venue/);
    refused(() => vetFumpadTx(tx([withKey(routerBuy(), 2, other)]), wallet, buyPolicy()), /buy accounts/); // another Coin
    refused(() => vetFumpadTx(tx([withKey(routerBuy(), 1, other)]), wallet, buyPolicy()), /buy accounts/); // fake Global
    refused(() => vetFumpadTx(tx([withKey(routerBuy(), 0, other)]), wallet, buyPolicy()), /signers|another wallet/);
  });

  it("refuses malformed router data", () => {
    const b = routerBuy();
    const bad = (data: Buffer) => tx([new TransactionInstruction({ programId: b.programId, keys: b.keys, data })]);
    refused(() => vetFumpadTx(bad(Buffer.concat([b.data, Buffer.from([0])])), wallet, buyPolicy()), /malformed/);
    refused(() => vetFumpadTx(bad(Buffer.concat([b.data.subarray(0, 24), Buffer.from([2])])), wallet, buyPolicy()), /swap mode/);
    const zero = Buffer.from(b.data);
    zero.fill(0, 8, 16);
    refused(() => vetFumpadTx(bad(zero), wallet, buyPolicy()), /empty/);
  });

  it("refuses calling Meteora directly outside a launch", () => {
    const direct = dbcFirstBuyIx({ creator: wallet, mint, config, amountIn: TENTH, minOut: BigInt(1) });
    refused(() => vetFumpadTx(tx([direct, routerBuy()]), wallet, buyPolicy()), /curve directly/);
    const damm = new TransactionInstruction({
      programId: DAMM_V2_PROGRAM_ID,
      keys: swapAccounts("damm", "buy"),
      data: Buffer.from([...DBC_IX.swap2, ...Buffer.alloc(17)]),
    });
    refused(() => vetFumpadTx(tx([damm, routerBuy()]), wallet, buyPolicy()), /program FUMPAD doesn't use/);
  });
});

describe("vetFumpadTx: SOL and token moves", () => {
  it("allows only a transfer into the wallet's own WSOL account, only on buys", () => {
    refused(
      () => vetFumpadTx(tx([routerBuy(), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: other, lamports: 1 })]), wallet, buyPolicy()),
      /somewhere other/,
    );
    refused(
      () =>
        vetFumpadTx(tx([routerSell(), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolAta(wallet), lamports: 1 })]), wallet, sellPolicy),
      /moves SOL/,
    );
    refused(
      () =>
        vetFumpadTx(
          tx([claimIx({ owner: wallet, mint, ticket }), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolAta(wallet), lamports: 1 })]),
          wallet,
          { action: "claim", mint: M, ticket: T },
        ),
      /moves SOL/,
    );
    refused(() => vetFumpadTx(tx([routerBuy(), SystemProgram.allocate({ accountPubkey: wallet, space: 1 })]), wallet, buyPolicy()), /System/);
  });

  it("allows only SyncNative / CloseAccount on the wallet's own WSOL account", () => {
    const tokenIx = (data: number[], keys: PublicKey[], program = TOKEN_PROGRAM_ID) =>
      new TransactionInstruction({
        programId: program,
        keys: keys.map((pubkey, i) => ({ pubkey, isSigner: i === keys.length - 1 && data[0] !== 17, isWritable: true })),
        data: Buffer.from(data),
      });
    // Transfer, Approve, CloseAccount to someone else, SyncNative on another account.
    refused(
      () => vetFumpadTx(tx([routerBuy(), tokenIx([3, 1, 0, 0, 0, 0, 0, 0, 0], [wsolAta(wallet), other, wallet])]), wallet, buyPolicy()),
      /token instruction/,
    );
    refused(
      () => vetFumpadTx(tx([routerBuy(), tokenIx([4, 1, 0, 0, 0, 0, 0, 0, 0], [wsolAta(wallet), other, wallet])]), wallet, buyPolicy()),
      /token instruction/,
    );
    refused(() => vetFumpadTx(tx([routerSell(), tokenIx([9], [wsolAta(wallet), other, wallet])]), wallet, sellPolicy), /token instruction/);
    refused(() => vetFumpadTx(tx([routerBuy(), tokenIx([17], [other])]), wallet, buyPolicy()), /token instruction/);
    // SyncNative has no place in a sell; nothing touches tokens on a claim; Token-2022 is never called.
    refused(() => vetFumpadTx(tx([routerSell(), tokenIx([17], [wsolAta(wallet)])]), wallet, sellPolicy), /token instruction/);
    refused(() => vetFumpadTx(tx([claimIx({ owner: wallet, mint, ticket }), unwrapSolIx(wallet)]), wallet, { action: "claim", mint: M, ticket: T }), /token instruction/);
    refused(
      () =>
        vetFumpadTx(
          tx([routerBuy(), tokenIx([3, 1, 0, 0, 0, 0, 0, 0, 0], [coinAta(wallet, mint), other, wallet], TOKEN_2022_PROGRAM_ID)]),
          wallet,
          buyPolicy(),
        ),
      /program FUMPAD doesn't use/,
    );
  });

  it("refuses SOL wrapped without a buy", () => {
    refused(() => vetFumpadTx(tx([...wrapSolIxs(wallet, TENTH), routerSell()]), wallet, sellPolicy), /moves SOL/);
  });

  it("creates token accounts only for the wallet, for this coin (and WSOL when trading)", () => {
    refused(() => vetFumpadTx(tx([coinAtaIx(other), claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim", mint: M, ticket: T }), /isn't yours/);
    refused(() => vetFumpadTx(tx([coinAtaIx(wallet, otherMint), routerBuy()]), wallet, buyPolicy()), /another token/);
    refused(() => vetFumpadTx(tx([wsolAtaIx(), claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim", mint: M, ticket: T }), /another token/);
    const wrongProgram = createAtaIdempotentIx(
      wallet,
      wallet,
      mint,
      TOKEN_PROGRAM_ID,
      PublicKey.findProgramAddressSync(
        [wallet.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
      )[0],
    );
    refused(() => vetFumpadTx(tx([wrongProgram, routerBuy()]), wallet, buyPolicy()), /another token/);
    refused(
      () => vetFumpadTx(tx([createAtaIdempotentIx(wallet, wallet, mint, TOKEN_2022_PROGRAM_ID, other), routerBuy()]), wallet, buyPolicy()),
      /doesn't match/,
    );
  });
});

describe("vetFumpadTx: claims and the rest", () => {
  it("refuses instructions the action doesn't use", () => {
    refused(() => vetFumpadTx(tx([routerBuy()]), wallet, sellPolicy), /doesn't use/);
    refused(() => vetFumpadTx(tx([setAutoClaimIx({ wallet, mint, enabled: true })]), wallet, { action: "claim", mint: M, ticket: T }), /doesn't use/);
    refused(() => vetFumpadTx(tx([registerCoinIx({ creator: wallet, mint, config })]), wallet, { action: "claim", mint: M, ticket: T }), /doesn't use/);
    // A FUMPAD instruction outside the user set (e.g. an admin call) never matches.
    refused(() =>
      vetFumpadTx(
        tx([
          new TransactionInstruction({ programId: FUMPAD_PROGRAM_ID, keys: [{ pubkey: wallet, isSigner: true, isWritable: true }], data: Buffer.alloc(8, 7) }),
        ]),
        wallet,
        buyPolicy(),
      ),
    );
  });

  it("refuses a claim paying another account, auto-claim for another coin, odd flags", () => {
    refused(
      () => vetFumpadTx(tx([withKey(claimIx({ owner: wallet, mint, ticket }), 10, coinAta(other, mint))]), wallet, { action: "claim", mint: M, ticket: T }),
      /claim accounts/,
    );
    refused(() => vetFumpadTx(tx([claimIx({ owner: wallet, mint: otherMint, ticket })]), wallet, { action: "claim", mint: M, ticket: T }), /claim accounts/);
    // Another ticket than the one the user picked, or no ticket in the policy.
    refused(() => vetFumpadTx(tx([claimIx({ owner: wallet, mint, ticket: other })]), wallet, { action: "claim", mint: M, ticket: T }), /claim accounts/);
    refused(() => vetFumpadTx(tx([claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim", mint: M }), /needs its ticket/);
    refused(() => vetFumpadTx(tx([withdrawEscrowIx({ owner: wallet, mint, ticket: other, escrowPayer: other })]), wallet, { action: "escrow", mint: M, ticket: T }), /escrow accounts/);
    refused(() => vetFumpadTx(tx([setAutoClaimIx({ wallet, mint: otherMint, enabled: true })]), wallet, { action: "auto-claim", mint: M }), /auto-claim/);
    const flag = setAutoClaimIx({ wallet, mint, enabled: true });
    refused(
      () =>
        vetFumpadTx(tx([new TransactionInstruction({ ...flag, data: Buffer.concat([flag.data.subarray(0, 8), Buffer.from([2])]) })]), wallet, {
          action: "auto-claim",
          mint: M,
        }),
      /auto-claim/,
    );
    refused(() => vetFumpadTx(tx([withdrawCreatorFeesIx({ creator: wallet, mint: otherMint })]), wallet, { action: "withdraw", mint: M }), /withdrawal/);
    refused(
      () =>
        vetFumpadTx(tx([withdrawEscrowIx({ owner: wallet, mint, ticket, escrowPayer: other, destination: coinAta(other, mint) })]), wallet, { action: "escrow", mint: M, ticket: T }),
      /escrow/,
    );
  });

  it("refuses a transaction acting for or paid by someone else", () => {
    refused(() => vetFumpadTx(buyTx("dbc", TENTH), other, buyPolicy()), /fee payer/);
    refused(() => vetFumpadTx(tx([routerBuy()], other), wallet, buyPolicy()), /fee payer/);
    refused(() => vetFumpadTx(tx([claimIx({ owner: other, mint, ticket })]), wallet, { action: "claim", mint: M, ticket: T }), /signers/);
  });

  it("refuses lookup tables, outsized priority fees and odd compute budget instructions", () => {
    const alt = new AddressLookupTableAccount({
      key: other,
      state: { deactivationSlot: BigInt(2) ** BigInt(64) - BigInt(1), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: [config, dammPool] },
    });
    refused(() => vetFumpadTx(tx([routerBuy()], wallet, [alt]), wallet, buyPolicy()), /lookup tables/);
    refused(() => vetFumpadTx(tx([...cb(1_400_000, 10_000_000_000), routerBuy()]), wallet, buyPolicy()), /priority fee/);
    vetFumpadTx(tx([...cb(200_000, 1_000_000), routerBuy()]), wallet, buyPolicy()); // 0.0002 SOL: fine
    refused(() => vetFumpadTx(tx([ComputeBudgetProgram.requestHeapFrame({ bytes: 64 * 1024 }), routerBuy()]), wallet, buyPolicy()), /compute budget/);
  });

  it("refuses a transaction with no FUMPAD instruction, unknown programs, co-signers outside a launch", () => {
    refused(() => vetFumpadTx(tx([...cb()]), wallet, buyPolicy()), /isn't a FUMPAD/);
    refused(
      () => vetFumpadTx(tx([routerBuy(), new TransactionInstruction({ programId: other, keys: [], data: Buffer.alloc(0) })]), wallet, buyPolicy()),
      /program/,
    );
    refused(() => vetFumpadTx(buyTx(), wallet, { ...buyPolicy(), coSigner: other.toBase58() }), /signers/);
    refused(() => vetFumpadTx(buyTx(), wallet, { ...buyPolicy(), action: "nope" as never }), /unknown action/);
  });
});

describe("vetFumpadTx: launch", () => {
  it("needs the reserved mint as the only co-signer, and its real signature (L-7)", () => {
    const k = Keypair.generate();
    refused(() => vetFumpadTx(launchTx(k), wallet, { action: "launch", mint: k.publicKey.toBase58() }), /reserved mint/);
    refused(() => vetFumpadTx(launchTx(k), wallet, { ...launchPolicy(k), coSigner: other.toBase58() }), /reserved mint/);
    // Not signed by the mint yet.
    const unsigned = tx([
      ...cb(),
      dbcInitPoolIx({ config, creator: wallet, mint: k.publicKey, name: "P", symbol: "P", uri: "u" }),
      registerCoinIx({ creator: wallet, mint: k.publicKey, config }),
    ]);
    refused(() => vetFumpadTx(unsigned, wallet, launchPolicy(k)), /co-signer/);
    // Random bytes in the mint's slot; a real signature by the wrong key; the mint's signature over another message.
    const forged = launchTx(k);
    forged.signatures[1] = Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 255);
    refused(() => vetFumpadTx(forged, wallet, launchPolicy(k)), /signature doesn't match/);
    const replay = launchTx(k);
    replay.signatures[1] = launchTx(k, { name: "Other" }).signatures[1];
    refused(() => vetFumpadTx(replay, wallet, launchPolicy(k)), /signature doesn't match/);
  });

  it("§8.1 launch co-signer: only the one read from chain, with its own valid signature", () => {
    const k = Keypair.generate();
    const signerKp = Keypair.generate();
    // An extra signer the app didn't expect (none configured on chain).
    const extra = new TransactionInstruction({ programId: FUMPAD_PROGRAM_ID, keys: [{ pubkey: signerKp.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) });
    const t = tx([...cb(400_000), dbcInitPoolIx({ config, creator: wallet, mint: k.publicKey, name: "P", symbol: "P", uri: "u" }), registerCoinIx({ creator: wallet, mint: k.publicKey, config }), extra]);
    t.sign([k, signerKp]);
    refused(() => vetFumpadTx(t, wallet, launchPolicy(k)), /unexpected signers/);
    // Configured on chain: the launch must carry it (a plain launch lacks the signer).
    refused(() => vetFumpadTx(launchTx(k), wallet, { ...launchPolicy(k), launchSigner: signerKp.publicKey.toBase58() }), /unexpected signers/);
    // A launch signer outside a launch, the default key, or the mint itself.
    refused(() => vetFumpadTx(buyTx(), wallet, { ...buyPolicy(), launchSigner: signerKp.publicKey.toBase58() }), /unexpected signers/);
    refused(() => vetFumpadTx(launchTx(k), wallet, { ...launchPolicy(k), launchSigner: PublicKey.default.toBase58() }), /launch co-signer/);
    refused(() => vetFumpadTx(launchTx(k), wallet, { ...launchPolicy(k), launchSigner: k.publicKey.toBase58() }), /launch co-signer/);
  });

  it("refuses a first buy above the amount entered, or one the user didn't ask for", () => {
    const k = Keypair.generate();
    refused(() => vetFumpadTx(launchTx(k, { buy: SOL }), wallet, launchPolicy(k, TENTH)), /more SOL/);
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH }), wallet, launchPolicy(k)), /more SOL/);
  });

  it("refuses launches out of order or tied to another config, coin or account", () => {
    const k = Keypair.generate();
    const p = launchPolicy(k, TENTH);
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH, order: "ata-first" }), wallet, p), /out of order/);
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH, order: "swap-before-init" }), wallet, p), /out of order|curve instruction/);
    // Before the pool only the SOL wrap may run: not a close, not register_coin.
    const m0 = k.publicKey;
    const early = (ixs: TransactionInstruction[]) => {
      const t = tx([...ixs, dbcInitPoolIx({ config, creator: wallet, mint: m0, name: "P", symbol: "P", uri: "u" }), registerCoinIx({ creator: wallet, mint: m0, config })]);
      t.sign([k]);
      return t;
    };
    refused(() => vetFumpadTx(early([unwrapSolIx(wallet)]), wallet, launchPolicy(k)), /out of order/);
    refused(() => vetFumpadTx(early([registerCoinIx({ creator: wallet, mint: m0, config })]), wallet, launchPolicy(k)), /out of order/);
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH, order: "register-before-buy" }), wallet, p), /extra swap/);
    refused(() => vetFumpadTx(launchTx(k, { registerCfg: other }), wallet, p), /registers a different coin/);
    // The first buy on another config's pool, into someone else's account, or a sell.
    const m = k.publicKey;
    refused(
      () =>
        vetFumpadTx(
          launchTx(k, { buy: TENTH, buyIx: dbcFirstBuyIx({ creator: wallet, mint: m, config: other, amountIn: TENTH, minOut: BigInt(1) }) }),
          wallet,
          p,
        ),
      /first buy/,
    );
    const intoOther = withKey(dbcFirstBuyIx({ creator: wallet, mint: m, config, amountIn: TENTH, minOut: BigInt(1) }), 4, coinAta(other, m));
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH, buyIx: intoOther }), wallet, p), /first buy/);
    const sell = new TransactionInstruction({
      programId: DBC_PROGRAM_ID,
      keys: [...dbcSwapAccounts({ trader: wallet, mint: m, config, side: "sell" }), { pubkey: SYSVAR_INSTRUCTIONS_ID, isSigner: false, isWritable: false }],
      data: dbcFirstBuyIx({ creator: wallet, mint: m, config, amountIn: TENTH, minOut: BigInt(1) }).data,
    });
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH, buyIx: sell }), wallet, p), /first buy/);
    // A second swap, a router trade, a launch of a different mint than the policy's.
    refused(
      () => vetFumpadTx(launchTx(k, { extra: [dbcFirstBuyIx({ creator: wallet, mint: m, config, amountIn: BigInt(1), minOut: BigInt(1) })] }), wallet, p),
      /extra swap/,
    );
    refused(() => vetFumpadTx(launchTx(k, { extra: [routerBuy()] }), wallet, p), /doesn't use|repeats/);
    const k2 = Keypair.generate();
    refused(() => vetFumpadTx(launchTx(k2), wallet, { ...launchPolicy(k2), mint: k.publicKey.toBase58() }), /reserved mint|signers/);
  });

  it("refuses a pool init with another creator, payer or malformed metadata", () => {
    const k = Keypair.generate();
    const init = dbcInitPoolIx({ config, creator: wallet, mint: k.publicKey, name: "P", symbol: "P", uri: "u" });
    const reg = registerCoinIx({ creator: wallet, mint: k.publicKey, config });
    const sign = (t: VersionedTransaction) => (t.sign([k]), t);
    refused(() => vetFumpadTx(sign(tx([withKey(init, 2, other), reg])), wallet, launchPolicy(k)), /signers|different coin/);
    refused(() => vetFumpadTx(sign(tx([withKey(init, 5, other), reg])), wallet, launchPolicy(k)), /different coin/);
    refused(
      () => vetFumpadTx(sign(tx([new TransactionInstruction({ ...init, data: Buffer.concat([init.data, Buffer.from([1])]) }), reg])), wallet, launchPolicy(k)),
      /metadata/,
    );
    refused(
      () => vetFumpadTx(sign(tx([new TransactionInstruction({ ...init, data: Buffer.from(init.data.subarray(0, 14)) }), reg])), wallet, launchPolicy(k)),
      /metadata/,
    );
    // Init without register_coin, or register_coin alone.
    refused(() => vetFumpadTx(sign(tx([init])), wallet, launchPolicy(k)), /isn't a FUMPAD/);
    refused(() => vetFumpadTx(tx([reg]), wallet, launchPolicy(k)), /signers/); // the mint never signs without its init
  });
});

describe("vetWithdrawTx", () => {
  const send = (to: PublicKey, lamports: number, from = wallet) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

  it("accepts exactly the confirmed transfer", () => {
    vetWithdrawTx(tx([send(other, 5_000)]), wallet, other, BigInt(5_000));
    vetWithdrawTx(tx([...cb(1_000, 1), send(other, 5_000)]), wallet, other, BigInt(5_000));
  });

  it("refuses a different amount, destination, or extra instructions", () => {
    refused(() => vetWithdrawTx(tx([send(other, 5_001)]), wallet, other, BigInt(5_000)), /amount/);
    refused(() => vetWithdrawTx(tx([send(mint, 5_000)]), wallet, other, BigInt(5_000)), /destination/);
    refused(() => vetWithdrawTx(tx([send(other, 5_000), send(other, 5_000)]), wallet, other, BigInt(5_000)), /single transfer/);
    refused(() => vetWithdrawTx(tx([routerBuy()]), wallet, other, BigInt(5_000)), /System transfer/);
  });
});
