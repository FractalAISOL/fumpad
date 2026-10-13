/**
 * Silent-signing allow-list (v0.7). Transactions are assembled from the same encoders the
 * builders use (`./v07/ix.ts`; the client itself against a fake RPC), then tampered with one way
 * at a time: every allowed shape is accepted, every deviation refused.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { SilentSignRefused, type SilentPolicy, vetFumpadTx, vetWithdrawTx } from "./allowlist";
import { FumpadClientV07 } from "./v07/client";
import {
  ACCOUNT_DISC,
  coinAta,
  DAMM_V2_PROGRAM_ID,
  DBC_IX,
  DBC_PROGRAM_ID,
  dbcPoolPda,
  FUMPAD_PROGRAM_ID,
  SYSVAR_INSTRUCTIONS_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  wsolAta,
} from "./v07/ids";
import {
  claimIx,
  computeBudgetIxs,
  createAtaIdempotentIx,
  dammSwapAccounts,
  dbcFirstBuyIx,
  dbcInitPoolIx,
  dbcSwapAccounts,
  registerCoinIx,
  routerBuyIx,
  routerSellIx,
  setAutoClaimIx,
  unwrapSolIx,
  withdrawCreatorFeesIx,
  withdrawEscrowIx,
  wrapSolIxs,
} from "./v07/ix";

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

function tx(ixs: TransactionInstruction[], payer = wallet, alts: AddressLookupTableAccount[] = []): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH, instructions: ixs }).compileToV0Message(alts));
}
const refused = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof SilentSignRefused && (!re || re.test(e.message)));
const cb = (units = 200_000, price?: number) => computeBudgetIxs(units, price);

type Venue = "dbc" | "damm";
const swapAccounts = (venue: Venue, side: "buy" | "sell", trader = wallet, m = mint) =>
  venue === "dbc" ? dbcSwapAccounts({ trader, mint: m, config, side }) : dammSwapAccounts({ trader, mint: m, pool: dammPool, side });
const routerBuy = (venue: Venue = "dbc", amountIn = TENTH, accounts = swapAccounts(venue, "buy")) =>
  routerBuyIx({ trader: wallet, mint, venue, swapAccounts: accounts, amountIn, minOut: BigInt(1) });
const routerSell = (venue: Venue = "dbc", accounts = swapAccounts(venue, "sell")) =>
  routerSellIx({ trader: wallet, mint, venue, swapAccounts: accounts, amountIn: BigInt(5_000_000), minOut: BigInt(1) });
const coinAtaIx = (owner = wallet, m = mint) => createAtaIdempotentIx(wallet, owner, m, TOKEN_2022_PROGRAM_ID, coinAta(owner, m));
const wsolAtaIx = () => createAtaIdempotentIx(wallet, wallet, WSOL_MINT, TOKEN_PROGRAM_ID, wsolAta(wallet));
/** Exactly what `FumpadClientV07.buildBuy` / `buildSell` emit. */
const buyTx = (venue: Venue = "dbc", lamports = TENTH, buy = routerBuy(venue, lamports)) =>
  tx([...cb(), coinAtaIx(), ...wrapSolIxs(wallet, lamports), buy, unwrapSolIx(wallet)]);
const sellTx = (venue: Venue = "dbc", sell = routerSell(venue)) => tx([...cb(), wsolAtaIx(), sell, unwrapSolIx(wallet)]);
const buyPolicy = (max = TENTH): SilentPolicy => ({ action: "buy", mint: M, maxSolInLamports: max });
/** Replace the key at `i` of an instruction (a tampered account list). */
function withKey(ix: TransactionInstruction, i: number, k: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((m, j) => (j === i ? { ...m, pubkey: k } : m)) });
}

/** The launch the API prepares: DBC init → [ATA · wrap · creator's swap2 · unwrap] → register_coin, signed by the mint. */
function launchTx(
  mintKp: Keypair,
  o: {
    buy?: bigint;
    sysvar?: boolean;
    name?: string;
    cfg?: PublicKey;
    order?: "ata-first" | "register-before-buy";
    registerCfg?: PublicKey;
    buyIx?: TransactionInstruction;
    extra?: TransactionInstruction[];
  } = {},
) {
  const m = mintKp.publicKey;
  const cfg = o.cfg ?? config;
  const init = dbcInitPoolIx({ config: cfg, creator: wallet, mint: m, name: o.name ?? "Pigeon", symbol: "PIGN", uri: "ipfs://x" });
  const reg = registerCoinIx({ creator: wallet, mint: m, config: o.registerCfg ?? cfg });
  const buy = o.buy
    ? [
        createAtaIdempotentIx(wallet, wallet, m, TOKEN_2022_PROGRAM_ID, coinAta(wallet, m)),
        ...wrapSolIxs(wallet, o.buy),
        o.buyIx ?? dbcFirstBuyIx({ creator: wallet, mint: m, config: cfg, amountIn: o.buy, minOut: BigInt(1) }),
        unwrapSolIx(wallet),
      ]
    : [];
  if (o.buy && o.sysvar === false && !o.buyIx) {
    const swap = buy[buy.length - 2];
    buy[buy.length - 2] = new TransactionInstruction({ programId: swap.programId, data: swap.data, keys: swap.keys.slice(0, 15) });
  }
  let ixs: TransactionInstruction[];
  if (o.order === "ata-first") ixs = [...cb(), coinAtaIx(wallet, m), init, ...buy, reg];
  else if (o.order === "register-before-buy") ixs = [...cb(), init, reg, ...buy];
  else ixs = [...cb(), init, ...buy, reg, ...(o.extra ?? [])];
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
    assert.equal(vetFumpadTx(sellTx("dbc"), wallet, { action: "sell", mint: M }).solInLamports, BigInt(0));
    vetFumpadTx(sellTx("damm"), wallet, { action: "sell", mint: M });
  });

  it("claim, auto-claim, creator fees, escrow", () => {
    vetFumpadTx(tx([...cb(), coinAtaIx(), claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim", mint: M });
    vetFumpadTx(tx([...cb(), setAutoClaimIx({ wallet, mint, enabled: false })]), wallet, { action: "auto-claim", mint: M });
    vetFumpadTx(tx([withdrawCreatorFeesIx({ creator: wallet, mint })]), wallet, { action: "withdraw", mint: M });
    vetFumpadTx(tx([...cb(), coinAtaIx(), withdrawEscrowIx({ owner: wallet, mint, ticket, escrowPayer: other })]), wallet, { action: "escrow", mint: M });
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
    vetFumpadTx(launchTx(k, { buy: TENTH, sysvar: false }), wallet, launchPolicy(k, TENTH));
  });

  it("accepts exactly what the v0.7 client builds (fake RPC with a Coin account)", async () => {
    const coinData = (status: number) => {
      const d = new Uint8Array(227);
      d.set(ACCOUNT_DISC.Coin, 0);
      d[9] = status;
      d.set(mint.toBytes(), 11);
      d.set(other.toBytes(), 43);
      d.set(dbcPoolPda(config, mint).toBytes(), 75);
      d.set(config.toBytes(), 107);
      d.set((status === 2 ? dammPool : PublicKey.default).toBytes(), 139);
      return d;
    };
    for (const [status, venue] of [
      [0, DBC_PROGRAM_ID],
      [2, DAMM_V2_PROGRAM_ID],
    ] as const) {
      const fake = { getAccountInfo: async () => ({ owner: FUMPAD_PROGRAM_ID, data: Buffer.from(coinData(status)) }) } as unknown as Connection;
      const client = new FumpadClientV07(fake);
      const buy = await client.buildBuy({ user: wallet, mint, lamportsIn: TENTH, minTokensOut: BigInt(10) });
      const sell = await client.buildSell({ user: wallet, mint, tokensIn: BigInt(10), minLamportsOut: BigInt(1) });
      vetFumpadTx(tx(buy.instructions), wallet, buyPolicy());
      vetFumpadTx(tx(sell.instructions), wallet, { action: "sell", mint: M });
      assert.ok(buy.instructions.some((ix) => ix.programId.equals(FUMPAD_PROGRAM_ID) && ix.keys[3].pubkey.equals(venue)));
      vetFumpadTx(tx(client.buildClaim({ owner: wallet, mint, ticket }).instructions), wallet, { action: "claim", mint: M });
      vetFumpadTx(tx(client.buildSetAutoClaim({ wallet, mint, enabled: true }).instructions), wallet, { action: "auto-claim", mint: M });
      vetFumpadTx(tx(client.buildWithdrawCreatorFees({ creator: wallet, mint }).instructions), wallet, { action: "withdraw", mint: M });
    }
    // A coin between the curve and its pool can't be routed.
    const complete = new FumpadClientV07({
      getAccountInfo: async () => ({ owner: FUMPAD_PROGRAM_ID, data: Buffer.from(coinData(1)) }),
    } as unknown as Connection);
    await assert.rejects(complete.buildBuy({ user: wallet, mint, lamportsIn: TENTH, minTokensOut: BigInt(1) }), /graduates/);
    // An account that isn't FUMPAD's, or a Coin for another mint, is refused before anything is built.
    const foreign = new FumpadClientV07({ getAccountInfo: async () => ({ owner: other, data: Buffer.from(coinData(0)) }) } as unknown as Connection);
    await assert.rejects(foreign.buildBuy({ user: wallet, mint, lamportsIn: TENTH, minTokensOut: BigInt(1) }), /isn't registered/);
    await assert.rejects(complete.coin(otherMint), /Unexpected coin/);
  });
});

describe("vetFumpadTx: router trades", () => {
  it("refuses a buy above the amount entered, counting the router amount and the SOL wrapped", () => {
    refused(() => vetFumpadTx(buyTx("dbc", SOL), wallet, buyPolicy()), /more SOL/);
    // A small router amount but a big wrap.
    refused(() => vetFumpadTx(tx([...cb(), ...wrapSolIxs(wallet, SOL), routerBuy("dbc", TENTH), unwrapSolIx(wallet)]), wallet, buyPolicy()), /more SOL/);
    // Two wraps summed.
    refused(() => vetFumpadTx(tx([...wrapSolIxs(wallet, TENTH), ...wrapSolIxs(wallet, TENTH), routerBuy()]), wallet, buyPolicy()), /more SOL/);
    // Two buys in one transaction.
    refused(() => vetFumpadTx(tx([routerBuy(), routerBuy()]), wallet, buyPolicy(SOL)), /repeats/);
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
    refused(() => vetFumpadTx(tx([routerSell("dbc", swapAccounts("dbc", "buy"))]), wallet, { action: "sell", mint: M }), /own token accounts/);
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
        vetFumpadTx(tx([routerSell(), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolAta(wallet), lamports: 1 })]), wallet, {
          action: "sell",
          mint: M,
        }),
      /moves SOL/,
    );
    refused(
      () =>
        vetFumpadTx(
          tx([claimIx({ owner: wallet, mint, ticket }), SystemProgram.transfer({ fromPubkey: wallet, toPubkey: wsolAta(wallet), lamports: 1 })]),
          wallet,
          { action: "claim", mint: M },
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
    refused(() => vetFumpadTx(tx([routerSell(), tokenIx([9], [wsolAta(wallet), other, wallet])]), wallet, { action: "sell", mint: M }), /token instruction/);
    refused(() => vetFumpadTx(tx([routerBuy(), tokenIx([17], [other])]), wallet, buyPolicy()), /token instruction/);
    // SyncNative has no place in a sell; nothing touches tokens on a claim; Token-2022 is never called.
    refused(() => vetFumpadTx(tx([routerSell(), tokenIx([17], [wsolAta(wallet)])]), wallet, { action: "sell", mint: M }), /token instruction/);
    refused(() => vetFumpadTx(tx([claimIx({ owner: wallet, mint, ticket }), unwrapSolIx(wallet)]), wallet, { action: "claim", mint: M }), /token instruction/);
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
    refused(() => vetFumpadTx(tx([...wrapSolIxs(wallet, TENTH), routerSell()]), wallet, { action: "sell", mint: M }), /moves SOL/);
  });

  it("creates token accounts only for the wallet, for this coin (and WSOL when trading)", () => {
    refused(() => vetFumpadTx(tx([coinAtaIx(other), claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim", mint: M }), /isn't yours/);
    refused(() => vetFumpadTx(tx([coinAtaIx(wallet, otherMint), routerBuy()]), wallet, buyPolicy()), /another token/);
    refused(() => vetFumpadTx(tx([wsolAtaIx(), claimIx({ owner: wallet, mint, ticket })]), wallet, { action: "claim", mint: M }), /another token/);
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
    refused(() => vetFumpadTx(tx([routerBuy()]), wallet, { action: "sell", mint: M }), /doesn't use/);
    refused(() => vetFumpadTx(tx([setAutoClaimIx({ wallet, mint, enabled: true })]), wallet, { action: "claim", mint: M }), /doesn't use/);
    refused(() => vetFumpadTx(tx([registerCoinIx({ creator: wallet, mint, config })]), wallet, { action: "claim", mint: M }), /doesn't use/);
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
      () => vetFumpadTx(tx([withKey(claimIx({ owner: wallet, mint, ticket }), 10, coinAta(other, mint))]), wallet, { action: "claim", mint: M }),
      /claim accounts/,
    );
    refused(() => vetFumpadTx(tx([claimIx({ owner: wallet, mint: otherMint, ticket })]), wallet, { action: "claim", mint: M }), /claim accounts/);
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
        vetFumpadTx(tx([withdrawEscrowIx({ owner: wallet, mint, ticket, escrowPayer: other, destination: coinAta(other, mint) })]), wallet, {
          action: "escrow",
          mint: M,
        }),
      /escrow/,
    );
  });

  it("refuses a transaction acting for or paid by someone else", () => {
    refused(() => vetFumpadTx(buyTx("dbc", TENTH), other, buyPolicy()), /fee payer/);
    refused(() => vetFumpadTx(tx([routerBuy()], other), wallet, buyPolicy()), /fee payer/);
    refused(() => vetFumpadTx(tx([claimIx({ owner: other, mint, ticket })]), wallet, { action: "claim", mint: M }), /signers/);
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

  it("refuses a first buy above the amount entered, or one the user didn't ask for", () => {
    const k = Keypair.generate();
    refused(() => vetFumpadTx(launchTx(k, { buy: SOL }), wallet, launchPolicy(k, TENTH)), /more SOL/);
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH }), wallet, launchPolicy(k)), /more SOL/);
  });

  it("refuses launches out of order or tied to another config, coin or account", () => {
    const k = Keypair.generate();
    const p = launchPolicy(k, TENTH);
    refused(() => vetFumpadTx(launchTx(k, { buy: TENTH, order: "ata-first" }), wallet, p), /out of order/);
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
