/**
 * The silent-signing allow-list against REAL v0.7 transactions: captured from the local stack
 * (solana-test-validator + the fumpad v0.7 program + mainnet Meteora DBC / DAMM v2 binaries) by
 * `scripts/local-app-e2e.ts --capture`, each exactly as the app's embedded wallet was asked to
 * sign it, and each landed on chain:
 *
 *   launch (the API's POST /v1/launch/prepare, mint-signed) · router buy / sell on DBC · a PartialFill
 *   buy that completed the curve · router buy / sell on DAMM v2 · set_auto_claim · claim ·
 *   withdraw_escrow · withdraw_creator_fees
 *
 * Every one is accepted with the policy the app signs it under, the app's builders rebuild every
 * one byte for byte from the captured chain accounts, and every way of tampering with them
 * (accounts, extra instructions, another mint, a referral, SOL to someone else, a bigger buy) is
 * refused.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type AccountInfo,
  type Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { withSlippage, DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, FUMPAD_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, coinAta, coinPda, createAtaIdempotentIx, wsolAta } from "@fumpad/sdk";
import { SilentSignRefused, type SilentPolicy, vetFumpadTx } from "./allowlist";
import { FumpadClient, MAX_SLIPPAGE_BPS, prepareBuy, prepareSell, QuoteRefused, readCoin, readDbcConfig } from "./build";
import { FUMPAD_PROGRAM_ADDRESS } from "./cluster";
import { checkLaunchBinding } from "./launch";
import { checkPreparedLaunch } from "./program";

interface Fixture {
  mint: string;
  dbcConfig: string;
  launch: { name: string; symbol: string; uri: string; initialBuyLamports: string; suffix: string };
  wallets: Record<string, string>;
  ticket: string;
  escrowTicket: string;
  txs: { name: string; note: string; wallet: string; policy: Record<string, string>; tx: string; signature?: string }[];
  accounts: Record<string, { address: string; owner: string; data: string }>;
  quoteSlots: Record<string, string>;
}
const F = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/local-v07.json"), "utf8")) as Fixture;
const MINT = new PublicKey(F.mint);
const other = Keypair.generate().publicKey;
const otherMint = Keypair.generate().publicKey;

const policyOf = (p: Record<string, string>): SilentPolicy => ({
  action: p.action as SilentPolicy["action"],
  mint: p.mint,
  ...(p.maxSolInLamports !== undefined ? { maxSolInLamports: BigInt(p.maxSolInLamports) } : {}),
  ...(p.coSigner !== undefined ? { coSigner: p.coSigner } : {}),
  ...(p.amountIn !== undefined ? { amountIn: BigInt(p.amountIn) } : {}),
  ...(p.minOut !== undefined ? { minOut: BigInt(p.minOut) } : {}),
  ...(p.ticket !== undefined ? { ticket: p.ticket } : {}),
  ...(p.launchSigner !== undefined ? { launchSigner: p.launchSigner } : {}),
});
const txOf = (name: string) => {
  const t = F.txs.find((x) => x.name === name);
  if (!t) throw new Error(`fixture has no ${name}`);
  return { ...t, vtx: VersionedTransaction.deserialize(Buffer.from(t.tx, "base64")), wallet: new PublicKey(t.wallet), policy: policyOf(t.policy) };
};
const refused = (fn: () => unknown, re?: RegExp) => assert.throws(fn, (e: unknown) => e instanceof SilentSignRefused && (!re || re.test(e.message)));

/** The transaction's instructions (no lookup tables in any of them), for tampering + recompiling. */
const ixsOf = (t: VersionedTransaction) => TransactionMessage.decompile(t.message).instructions;
function recompile(t: VersionedTransaction, ixs: TransactionInstruction[]): VersionedTransaction {
  return new VersionedTransaction(new TransactionMessage({ payerKey: t.message.staticAccountKeys[0], recentBlockhash: t.message.recentBlockhash, instructions: ixs }).compileToV0Message());
}
const replaceKey = (ix: TransactionInstruction, i: number, k: PublicKey) =>
  new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((m, j) => (j === i ? { ...m, pubkey: k, isSigner: false } : m)) });
const withData = (ix: TransactionInstruction, f: (d: Buffer) => void) => {
  const d = Buffer.from(ix.data);
  f(d);
  return new TransactionInstruction({ programId: ix.programId, keys: ix.keys, data: d });
};
const isFumpad = (ix: TransactionInstruction) => ix.programId.equals(FUMPAD_PROGRAM_ID);

const USER_TXS = ["buy-dbc", "buy-dbc-2", "sell-dbc", "sell-dbc-all", "set-auto-claim", "buy-dbc-partialfill", "buy-damm", "sell-damm", "claim", "withdraw-escrow", "withdraw-creator-fees"];

describe("captured v0.7 transactions (local stack)", () => {
  it("cluster.ts's program id (server components read it without web3) is the SDK's", () => {
    assert.equal(FUMPAD_PROGRAM_ADDRESS, FUMPAD_PROGRAM_ID.toBase58());
  });

  it("covers every flow the app signs, each landed", () => {
    for (const n of ["launch", ...USER_TXS]) assert.ok(txOf(n).signature, `${n} landed`);
    // The venues the router went to: DBC on the curve (PartialFill), DAMM v2 after graduation (ExactIn).
    const venue = (n: string) => ixsOf(txOf(n).vtx).find(isFumpad)!.keys[3].pubkey;
    for (const n of ["buy-dbc", "sell-dbc", "buy-dbc-partialfill"]) assert.ok(venue(n).equals(DBC_PROGRAM_ID), n);
    for (const n of ["buy-damm", "sell-damm"]) assert.ok(venue(n).equals(DAMM_V2_PROGRAM_ID), n);
    assert.equal(ixsOf(txOf("buy-dbc-partialfill").vtx).find(isFumpad)!.data[24], 1);
    assert.equal(ixsOf(txOf("buy-damm").vtx).find(isFumpad)!.data[24], 0);
  });

  it("the allow-list accepts every one under the policy the app signs it with", () => {
    for (const n of ["launch", ...USER_TXS]) {
      const t = txOf(n);
      const r = vetFumpadTx(t.vtx, t.wallet, t.policy);
      if (t.policy.maxSolInLamports !== undefined) assert.ok(r.solInLamports <= t.policy.maxSolInLamports, n);
    }
  });

  it("the API's launch: [CB] wrap → DBC init → ATA → swap2 (+sysvar) → register_coin → close, bound to what the user typed", async () => {
    const t = txOf("launch");
    const programs = ixsOf(t.vtx).map((ix) => ix.programId.toBase58().slice(0, 4));
    // no CU limit without a priority price (services: the launch tx with the launch co-signer is near 1,232 bytes)
    assert.deepEqual(programs, ["ATok", "1111", "Toke", "dbci", "ATok", "dbci", "5YMF", "Toke"]);
    // Params.launch_signer is set on the capture stack: the API co-signed register_coin (positive L1 path)
    assert.ok(t.policy.launchSigner);
    const shape = checkPreparedLaunch(t.vtx, t.wallet, F.mint, F.launch.suffix, BigInt(F.launch.initialBuyLamports), t.policy.launchSigner);
    assert.throws(() => checkPreparedLaunch(t.vtx, t.wallet, F.mint, F.launch.suffix, BigInt(F.launch.initialBuyLamports)), /unexpected signers/);
    assert.equal(shape.symbol, F.launch.symbol);
    assert.ok(shape.config.equals(new PublicKey(F.dbcConfig)));
    const cfg = readDbcConfig(Buffer.from(F.accounts.dbcConfig.data, "base64"));
    const intent = { wallet: t.wallet, mint: F.mint, suffix: F.launch.suffix, name: F.launch.name, symbol: F.launch.symbol, uri: F.launch.uri, initialBuyLamports: BigInt(F.launch.initialBuyLamports), launchSigner: t.policy.launchSigner };
    await checkLaunchBinding(t.vtx, intent, async () => cfg);
    // Another amount, other metadata: refused.
    await assert.rejects(checkLaunchBinding(t.vtx, { ...intent, initialBuyLamports: intent.initialBuyLamports * BigInt(2) }, async () => cfg), /different amount/);
    await assert.rejects(checkLaunchBinding(t.vtx, { ...intent, symbol: "OTHER" }, async () => cfg), /metadata/);
  });
});

/* ── the app's builders, against a fake RPC serving the captured chain accounts ── */

function fakeConnection(): Connection {
  const byAddress = new Map(Object.values(F.accounts).map((a) => [a.address, a]));
  let coinKey = "coinCurve";
  const conn = {
    setCoin(k: string) {
      coinKey = k;
    },
    async getSlot() {
      return Number(F.quoteSlots.dbcPool);
    },
    async getAccountInfo(k: PublicKey): Promise<AccountInfo<Buffer> | null> {
      const a = k.equals(coinPda(MINT)) ? F.accounts[coinKey] : byAddress.get(k.toBase58());
      return a ? { owner: new PublicKey(a.owner), data: Buffer.from(a.data, "base64"), lamports: 1, executable: false, rentEpoch: 0 } : null;
    },
  };
  return conn as unknown as Connection;
}
const u64 = (d: Uint8Array, o: number) => Buffer.from(d).readBigUInt64LE(o);

describe("the app's builders rebuild the captured transactions byte for byte", () => {
  const conn = fakeConnection() as Connection & { setCoin(k: string): void };
  const client = new FumpadClient(conn);
  const same = async (name: string, build: () => Promise<{ instructions: TransactionInstruction[] }> | { instructions: TransactionInstruction[] }) => {
    const t = txOf(name);
    const built = await build();
    const mine = recompile(t.vtx, built.instructions);
    assert.deepEqual(Buffer.from(mine.message.serialize()), Buffer.from(t.vtx.message.serialize()), name);
  };
  const router = (name: string) => {
    const ix = ixsOf(txOf(name).vtx).find(isFumpad)!;
    return { amountIn: u64(ix.data, 8), minOut: u64(ix.data, 16), wallet: txOf(name).wallet };
  };

  it("buy / sell on the curve and on DAMM v2, minimum out passed through untouched (M-9)", async () => {
    conn.setCoin("coinCurve");
    for (const n of ["buy-dbc", "buy-dbc-2", "buy-dbc-partialfill"]) {
      const r = router(n);
      await same(n, () => client.buildBuy({ user: r.wallet, mint: MINT, lamportsIn: r.amountIn, minTokensOut: r.minOut }));
    }
    for (const n of ["sell-dbc", "sell-dbc-all"]) {
      const r = router(n);
      await same(n, () => client.buildSell({ user: r.wallet, mint: MINT, tokensIn: r.amountIn, minLamportsOut: r.minOut }));
    }
    conn.setCoin("coinGraduated");
    const b = router("buy-damm");
    await same("buy-damm", () => client.buildBuy({ user: b.wallet, mint: MINT, lamportsIn: b.amountIn, minTokensOut: b.minOut }));
    const s = router("sell-damm");
    await same("sell-damm", () => client.buildSell({ user: s.wallet, mint: MINT, tokensIn: s.amountIn, minLamportsOut: s.minOut }));
  });

  it("set_auto_claim, claim, withdraw_escrow, withdraw_creator_fees", async () => {
    conn.setCoin("coinGraduated");
    const w = (n: string) => txOf(n).wallet;
    await same("set-auto-claim", () => client.buildSetAutoClaim({ wallet: w("set-auto-claim"), mint: MINT, enabled: false }));
    await same("claim", () => client.buildClaim({ owner: w("claim"), mint: MINT, ticket: new PublicKey(F.ticket) }));
    await same("withdraw-escrow", () => client.buildWithdrawEscrow({ owner: w("withdraw-escrow"), mint: MINT, ticket: new PublicKey(F.escrowTicket) }));
    await same("withdraw-creator-fees", () => client.buildWithdrawCreatorFees({ creator: w("withdraw-creator-fees"), mint: MINT }));
  });

  it("V7-M3: prepareBuy / prepareSell quote the captured pools locally and refuse a lowballed shown minimum", async () => {
    for (const [n, coinKey] of [
      ["buy-dbc", "coinCurve"],
      ["buy-damm", "coinGraduated"],
    ] as const) {
      conn.setCoin(coinKey);
      const t = txOf(n);
      const r = router(n);
      const local = await client.quote({ mint: MINT, side: "buy", amountIn: r.amountIn });
      const floor = withSlippage(local.amountOut, MAX_SLIPPAGE_BPS);
      // The trade panel's real minimum (from the API quote) cleared the app's own floor.
      assert.ok(r.minOut >= floor, n);
      const ok = await prepareBuy(client, t.wallet, { mint: F.mint, solIn: Number(r.amountIn) / 1e9, minTokensOut: Number(r.minOut) / 1e6 });
      assert.equal(ok.policy.minOut, floor);
      assert.equal(ok.policy.amountIn, r.amountIn);
      vetFumpadTx(recompile(t.vtx, ok.built.instructions), t.wallet, ok.policy);
      // A compromised API quoting 10% low, or zero: nothing is built.
      for (const shown of [(Number(floor) * 0.9) / 1e6, 0]) {
        await assert.rejects(prepareBuy(client, t.wallet, { mint: F.mint, solIn: Number(r.amountIn) / 1e9, minTokensOut: shown }), QuoteRefused);
      }
    }
    conn.setCoin("coinGraduated");
    const seller = txOf("sell-damm").wallet;
    const tokensIn = BigInt(1_000_000_000_000);
    const q = await client.quote({ mint: MINT, side: "sell", amountIn: tokensIn });
    const floor = withSlippage(q.amountOut, MAX_SLIPPAGE_BPS);
    const okSell = await prepareSell(client, seller, { mint: F.mint, tokensIn: 1_000_000, minSolOut: Number(q.amountOut) / 1e9 });
    assert.equal(okSell.policy.minOut, floor);
    await assert.rejects(prepareSell(client, seller, { mint: F.mint, tokensIn: 1_000_000, minSolOut: (Number(floor) - 10) / 1e9 }), QuoteRefused);
  });

  it("decodes the captured Coin accounts and refuses them for another mint", () => {
    assert.equal(readCoin(Buffer.from(F.accounts.coinCurve.data, "base64"), MINT).status, "curve");
    assert.equal(readCoin(Buffer.from(F.accounts.coinGraduated.data, "base64"), MINT).status, "graduated");
    assert.throws(() => readCoin(Buffer.from(F.accounts.coinCurve.data, "base64"), otherMint), /Unexpected coin/);
    const bad = Buffer.from(F.accounts.coinCurve.data, "base64");
    bad[0] ^= 1;
    assert.throws(() => readCoin(bad, MINT), /Unexpected coin/);
  });

  it("a complete (not yet graduated) coin can't be routed", async () => {
    const d = Buffer.from(F.accounts.coinCurve.data, "base64");
    d[9] = 1;
    const c = new FumpadClient({
      getAccountInfo: async () => ({ owner: FUMPAD_PROGRAM_ID, data: d, lamports: 1, executable: false, rentEpoch: 0 }),
    } as unknown as Connection);
    await assert.rejects(c.buildBuy({ user: other, mint: MINT, lamportsIn: BigInt(1), minTokensOut: BigInt(1) }), /graduates/);
    const foreign = new FumpadClient({
      getAccountInfo: async () => ({ owner: other, data: d, lamports: 1, executable: false, rentEpoch: 0 }),
    } as unknown as Connection);
    await assert.rejects(foreign.buildBuy({ user: other, mint: MINT, lamportsIn: BigInt(1), minTokensOut: BigInt(1) }), /isn't registered/);
  });
});

/* ── tampering with the real transactions ── */

describe("tampered real transactions are refused", () => {
  it("unmodified recompiles still pass (the tamper harness itself is sound)", () => {
    for (const n of USER_TXS) {
      const t = txOf(n);
      vetFumpadTx(recompile(t.vtx, ixsOf(t.vtx)), t.wallet, t.policy);
    }
  });

  it("any account of the FUMPAD instruction swapped for another key", () => {
    for (const n of USER_TXS) {
      const t = txOf(n);
      const ixs = ixsOf(t.vtx);
      const i = ixs.findIndex(isFumpad);
      for (let k = 1; k < ixs[i].keys.length; k++) {
        // The one account left free: withdraw_escrow's escrow payer (the program requires Ticket.escrow_payer; it only gets the escrow rent back).
        if (n === "withdraw-escrow" && k === 7) continue;
        const ixs2 = ixs.slice();
        ixs2[i] = replaceKey(ixs[i], k, other);
        refused(() => vetFumpadTx(recompile(t.vtx, ixs2), t.wallet, t.policy), undefined);
      }
    }
  });

  it("a referral account in the swap (DBC and DAMM v2)", () => {
    for (const [n, slot] of [
      ["buy-dbc", 6 + 12],
      ["sell-dbc", 6 + 12],
      ["buy-damm", 6 + 11],
      ["sell-damm", 6 + 11],
    ] as const) {
      const t = txOf(n);
      const ixs = ixsOf(t.vtx);
      const i = ixs.findIndex(isFumpad);
      assert.ok(ixs[i].keys[slot].pubkey.equals(ixs[i].keys[3].pubkey), `${n}: referral slot is None (the venue program)`);
      ixs[i] = replaceKey(ixs[i], slot, wsolAta(other));
      refused(() => vetFumpadTx(recompile(t.vtx, ixs), t.wallet, t.policy), /own token accounts/);
    }
  });

  it("extra instructions: a second router call, a transfer, an ATA for another wallet, an unknown program", () => {
    for (const n of USER_TXS) {
      const t = txOf(n);
      const ixs = ixsOf(t.vtx);
      const fumpadIx = ixs.find(isFumpad)!;
      const extras = [
        fumpadIx,
        SystemProgram.transfer({ fromPubkey: t.wallet, toPubkey: other, lamports: 1 }),
        createAtaIdempotentIx(t.wallet, other, MINT, TOKEN_2022_PROGRAM_ID),
        new TransactionInstruction({ programId: other, keys: [], data: Buffer.alloc(0) }),
      ];
      for (const x of extras) refused(() => vetFumpadTx(recompile(t.vtx, [...ixs, x]), t.wallet, t.policy));
    }
  });

  it("another coin: a policy for another mint, or the instructions re-pointed at another mint", () => {
    for (const n of ["launch", ...USER_TXS]) {
      const t = txOf(n);
      refused(() => vetFumpadTx(t.vtx, t.wallet, { ...t.policy, mint: otherMint.toBase58() }));
    }
    const t = txOf("buy-dbc");
    const ixs = ixsOf(t.vtx).map((ix) => new TransactionInstruction({ programId: ix.programId, data: ix.data, keys: ix.keys.map((m) => (m.pubkey.equals(MINT) ? { ...m, pubkey: otherMint } : m)) }));
    refused(() => vetFumpadTx(recompile(t.vtx, ixs), t.wallet, t.policy));
  });

  it("SOL to an account that isn't the wallet's own WSOL account", () => {
    for (const n of ["buy-dbc", "buy-damm", "buy-dbc-partialfill"]) {
      const t = txOf(n);
      const ixs = ixsOf(t.vtx);
      const i = ixs.findIndex((ix) => ix.programId.equals(SystemProgram.programId));
      ixs[i] = replaceKey(ixs[i], 1, wsolAta(other));
      refused(() => vetFumpadTx(recompile(t.vtx, ixs), t.wallet, t.policy), /somewhere other/);
    }
    // The close of the WSOL account must pay the wallet itself.
    const t = txOf("sell-dbc");
    const ixs = ixsOf(t.vtx);
    const last = ixs.length - 1;
    ixs[last] = replaceKey(ixs[last], 1, other);
    refused(() => vetFumpadTx(recompile(t.vtx, ixs), t.wallet, t.policy), /token instruction/);
  });

  it("oversized buys: above the amount entered, in the router amount or the SOL wrapped", () => {
    for (const n of ["buy-dbc", "buy-damm", "buy-dbc-partialfill"]) {
      const t = txOf(n);
      const max = t.policy.maxSolInLamports!;
      refused(() => vetFumpadTx(t.vtx, t.wallet, { ...t.policy, maxSolInLamports: max - BigInt(1) }), /more SOL/);
      const ixs = ixsOf(t.vtx);
      const r = ixs.findIndex(isFumpad);
      const bigger = ixs.slice();
      bigger[r] = withData(ixs[r], (d) => d.writeBigUInt64LE(max + BigInt(1), 8));
      refused(() => vetFumpadTx(recompile(t.vtx, bigger), t.wallet, t.policy), /differs from what you entered/);
      refused(() => vetFumpadTx(recompile(t.vtx, bigger), t.wallet, { ...t.policy, amountIn: max + BigInt(1) }), /more SOL/);
      const s = ixs.findIndex((ix) => ix.programId.equals(SystemProgram.programId));
      const wrapMore = ixs.slice();
      wrapMore[s] = withData(ixs[s], (d) => d.writeBigUInt64LE(max * BigInt(10), 4));
      refused(() => vetFumpadTx(recompile(t.vtx, wrapMore), t.wallet, t.policy), /more SOL/);
    }
    refused(() => vetFumpadTx(txOf("launch").vtx, txOf("launch").wallet, { ...txOf("launch").policy, maxSolInLamports: BigInt(1) }), /more SOL/);
  });

  it("V7-M3: every captured trade carries the app's own quote floor, and a lower min_out is refused", () => {
    for (const n of ["buy-dbc", "buy-dbc-2", "sell-dbc", "sell-dbc-all", "buy-dbc-partialfill", "buy-damm", "sell-damm"]) {
      const t = txOf(n);
      const ixs = ixsOf(t.vtx);
      const r = ixs.findIndex(isFumpad);
      const minOut = u64(ixs[r].data, 16);
      assert.ok(t.policy.minOut! > BigInt(0) && minOut >= t.policy.minOut!, n);
      assert.equal(u64(ixs[r].data, 8), t.policy.amountIn, n);
      for (const low of [BigInt(0), t.policy.minOut! - BigInt(1)]) {
        const lowered = ixs.slice();
        lowered[r] = withData(ixs[r], (d) => d.writeBigUInt64LE(low, 16));
        refused(() => vetFumpadTx(recompile(t.vtx, lowered), t.wallet, t.policy), /minimum output/);
      }
      // Without the bounds (the pre-fix policy) nothing is signed.
      refused(() => vetFumpadTx(t.vtx, t.wallet, { action: t.policy.action, mint: t.policy.mint, maxSolInLamports: t.policy.maxSolInLamports }), /minimum output/);
    }
  });

  it("claims, escrow and fees paying or acting for someone else", () => {
    const claim = txOf("claim");
    const c = ixsOf(claim.vtx);
    const ci = c.findIndex(isFumpad);
    c[ci] = replaceKey(c[ci], 10, coinAta(other, MINT)); // owner_token_account
    refused(() => vetFumpadTx(recompile(claim.vtx, c), claim.wallet, claim.policy), /claim accounts/);
    const esc = txOf("withdraw-escrow");
    const e = ixsOf(esc.vtx);
    const ei = e.findIndex(isFumpad);
    e[ei] = replaceKey(e[ei], 6, coinAta(other, MINT)); // destination
    refused(() => vetFumpadTx(recompile(esc.vtx, e), esc.wallet, esc.policy), /escrow accounts/);
    // Signed by another wallet than the one that built it.
    for (const n of USER_TXS) refused(() => vetFumpadTx(txOf(n).vtx, other, txOf(n).policy), /fee payer/);
    // The action's instruction under another action's policy.
    refused(() => vetFumpadTx(claim.vtx, claim.wallet, { action: "escrow", mint: F.mint, ticket: F.ticket }), /doesn't use/);
    const sp = txOf("sell-dbc").policy;
    refused(() => vetFumpadTx(txOf("sell-dbc").vtx, txOf("sell-dbc").wallet, { ...sp, action: "buy", maxSolInLamports: BigInt(1e12) }), /doesn't use/);
  });

  it("the real launch with any byte of its message changed (the mint's signature no longer verifies)", () => {
    const t = txOf("launch");
    const msg = t.vtx.message.serialize();
    for (const at of [msg.length - 1, msg.length - 40, Math.floor(msg.length / 2), 70]) {
      const bytes = Uint8Array.from(msg);
      bytes[at] ^= 1;
      let forged: VersionedTransaction;
      try {
        forged = new VersionedTransaction(VersionedTransaction.deserialize(Uint8Array.from([...t.vtx.serialize().subarray(0, 1 + 64 * t.vtx.signatures.length), ...bytes])).message, t.vtx.signatures);
      } catch {
        continue; // not a parseable message any more: nothing to sign
      }
      refused(() => vetFumpadTx(forged, t.wallet, t.policy));
    }
    // The real launch with an extra instruction appended.
    refused(() => vetFumpadTx(recompile(t.vtx, [...ixsOf(t.vtx), SystemProgram.transfer({ fromPubkey: t.wallet, toPubkey: other, lamports: 1 })]), t.wallet, t.policy));
  });
});
