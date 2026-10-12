/**
 * Builders vs the IDL: every instruction has a builder, account counts/flags match, and
 * args round-trip through the Anchor coder. If the contracts change (escape hatch,
 * timelock, queue escrow…) `npm run sync-idl` + this test show what to update.
 */
import { Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { FUMPAD_IDL, LP_LOCKER_IDL, fumpadCoder, idlInstruction } from "../src/coder.js";
import { FUMPAD_PROGRAM_ID, PUMPSWAP_PROGRAM_ID } from "../src/constants.js";
import * as I from "../src/instructions/index.js";
import { DEFAULT_PARAMS } from "../src/params.js";
import { coinAddresses, coinAta, escrowPda, eventAuthorityPda, graduationWsolPda, positionPda, ticketPda } from "../src/pda.js";

const k = () => Keypair.generate().publicKey;
const user = k();
const mint = k();
const bfr = k();
const t1 = k();
const t2 = k();

const built: Record<string, [TransactionInstruction, number]> = {
  initialize_global: [I.initializeGlobalIx({ payer: user, admin: user, platformTreasury: user, params: DEFAULT_PARAMS }), 0],
  queue_params: [I.queueParamsIx(user, DEFAULT_PARAMS), 0],
  execute_params: [I.executeParamsIx(user), 0],
  cancel_params: [I.cancelParamsIx(user), 0],
  withdraw_escrow: [I.withdrawEscrowIx({ owner: user, mint, ticket: t1, escrowPayer: k() }), 0],
  set_pause: [I.setPauseIx(user, 3), 0],
  set_keepers: [I.setKeepersIx(user, [user]), 0],
  set_admin: [I.setAdminIx(user, user, user), 0],
  create_coin: [I.createCoinIx({ creator: user, mint, name: "Fumble", symbol: "FUMB", uri: "https://x" }), 0],
  buy: [I.buyIx({ user, mint, solIn: 5n, minTokensOut: 1n, openTickets: [t1, t2], anyQueued: true }), 3],
  sell: [I.sellIx({ user, mint, tokensIn: 5n, minSolOut: 0n, nextTicketSeq: 3n }), 0],
  graduate: [I.graduateIx({ payer: user, mint }), 0],
  register_holdings: [I.registerHoldingsIx({ user, mint, openTickets: [t1] }), 1],
  claim: [I.claimIx({ owner: user, mint, ticket: t1 }), 0],
  claim_for: [I.claimForIx({ keeper: user, mint, ticket: t1, owner: k() }), 0],
  set_auto_claim: [I.setAutoClaimIx({ wallet: user, mint, enabled: false }), 0],
  process_queue: [I.processQueueIx({ cranker: user, mint, maxEntries: 2, entries: [{ ticket: t1, owner: user }, { ticket: t2, owner: k() }] }), 8],
  close_ticket: [I.closeTicketIx({ caller: user, ticket: t1, owner: user, mint, queued: true }), 0],
  withdraw_creator_fees: [I.withdrawCreatorFeesIx({ creator: user, mint }), 0],
  withdraw_platform_fees: [I.withdrawPlatformFeesIx({ caller: user, mint, platformTreasury: user }), 0],
  init_claim_queue: [I.initClaimQueueIx({ payer: user, mint }), 0],
  swap_buy: [I.swapBuyIx({ user, mint, solIn: 5n, minTokensOut: 1n, openTickets: [t1], buybackFeeRecipient: bfr }), 1 + 17],
  swap_sell: [I.swapSellIx({ user, mint, tokensIn: 5n, minSolOut: 1n, nextTicketSeq: 0n, buybackFeeRecipient: bfr }), 17],
  execute_buyback: [I.executeBuybackIx({ cranker: user, mint, maxLamports: 9n, buybackFeeRecipient: bfr }), 17],
  init_observations: [I.initObservationsIx({ payer: user, mint }), 0],
  record_samples: [I.recordSamplesIx({ sampler: user, mints: [mint, k()] }), 10],
  settle_lp_fees: [I.settleLpFeesIx({ cranker: user, mint }), 0],
};

describe("instruction builders vs IDL", () => {
  it("cover every fumpad instruction", () => {
    const names = (FUMPAD_IDL.instructions as { name: string }[]).map((i) => i.name).sort();
    expect(Object.keys(built).sort()).toEqual(names);
  });

  for (const [name, [ix, remaining]] of Object.entries(built)) {
    it(`${name}: account count, flags, discriminator`, () => {
      const idl = idlInstruction(FUMPAD_IDL, name);
      expect(ix.programId.equals(FUMPAD_PROGRAM_ID)).toBe(true);
      expect(ix.keys.length).toBe(idl.accounts.length + remaining);
      idl.accounts.forEach((a, i) => {
        expect(ix.keys[i].isWritable, `${name}.${a.name} writable`).toBe(!!a.writable);
        expect(ix.keys[i].isSigner, `${name}.${a.name} signer`).toBe(!!a.signer);
        if (a.address) expect(ix.keys[i].pubkey.toBase58()).toBe(a.address);
      });
      expect(Array.from(ix.data.subarray(0, 8))).toEqual(idl.discriminator);
      const dec = fumpadCoder().instruction.decode(ix.data);
      expect(dec?.name).toBe(name);
    });
  }

  it("rebuy accounts: ClaimQueue follows the open tickets only when one is Queued", () => {
    const n = idlInstruction(FUMPAD_IDL, "buy").accounts.length;
    const q = built.buy[0];
    expect(q.keys[n + 2].pubkey.equals(coinAddresses(mint).claimQueue)).toBe(true);
    const nq = I.buyIx({ user, mint, solIn: 5n, minTokensOut: 1n, openTickets: [t1, t2] });
    expect(nq.keys.length).toBe(n + 2);
    const sb = I.swapBuyIx({ user, mint, solIn: 5n, minTokensOut: 1n, openTickets: [t1], anyQueued: true, buybackFeeRecipient: bfr });
    const sn = idlInstruction(FUMPAD_IDL, "swap_buy").accounts.length;
    expect(sb.keys[sn + 1].pubkey.equals(coinAddresses(mint).claimQueue)).toBe(true);
    expect(sb.keys[sn + 2].pubkey.equals(coinAddresses(mint).pool)).toBe(true);
  });

  it("process_queue passes quadruples [ticket, position, owner ATA, escrow PDA]", () => {
    const ix = built.process_queue[0];
    const n = idlInstruction(FUMPAD_IDL, "process_queue").accounts.length;
    expect(ix.keys[n].pubkey.equals(t1)).toBe(true);
    expect(ix.keys[n + 1].pubkey.equals(positionPda(mint, user)).valueOf()).toBe(true);
    expect(ix.keys[n + 3].pubkey.equals(escrowPda(t1))).toBe(true);
    expect(ix.keys[n + 4].pubkey.equals(t2)).toBe(true);
  });

  it("claim_for (v0.4): position/ATA/escrow belong to the ticket owner, keeper signs (16 accounts)", () => {
    const owner = k();
    const ix = I.claimForIx({ keeper: user, mint, ticket: t1, owner });
    const names = idlInstruction(FUMPAD_IDL, "claim_for").accounts.map((a) => a.name);
    expect(names.length).toBe(16);
    const at = (n: string) => ix.keys[names.indexOf(n)];
    expect(at("keeper").pubkey.equals(user) && at("keeper").isSigner).toBe(true);
    expect(at("position").pubkey.equals(positionPda(mint, owner))).toBe(true);
    expect(at("owner_ata").pubkey.equals(coinAta(owner, mint))).toBe(true);
    expect(at("escrow").pubkey.equals(escrowPda(t1))).toBe(true);
    const sa = I.setAutoClaimIx({ wallet: owner, mint, enabled: true });
    expect(sa.keys[1].pubkey.equals(positionPda(mint, owner))).toBe(true);
    expect((fumpadCoder().instruction.decode(sa.data)!.data as { enabled: boolean }).enabled).toBe(true);
  });

  it("graduate uses its own WSOL PDA", () => {
    const ix = built.graduate[0];
    const idx = idlInstruction(FUMPAD_IDL, "graduate").accounts.findIndex((a) => a.name === "graduation_wsol");
    expect(ix.keys[idx].pubkey.equals(graduationWsolPda(mint))).toBe(true);
  });

  it("event_cpi accounts are filled", () => {
    const ix = built.buy[0];
    const idl = idlInstruction(FUMPAD_IDL, "buy");
    const ea = idl.accounts.findIndex((a) => a.name === "event_authority");
    expect(ix.keys[ea].pubkey.equals(eventAuthorityPda())).toBe(true);
    expect(ix.keys[ea + 1].pubkey.equals(FUMPAD_PROGRAM_ID)).toBe(true);
  });

  it("args round-trip", () => {
    const d = fumpadCoder().instruction.decode(built.buy[0].data)!.data as Record<string, { toString(): string }>;
    expect(d.sol_in.toString()).toBe("5");
    const g = fumpadCoder().instruction.decode(built.initialize_global[0].data)!.data as { params: Record<string, { toString(): string }> };
    expect(g.params.initial_virtual_token.toString()).toBe(DEFAULT_PARAMS.initialVirtualToken.toString());
    expect(Array.from(g.params.sol_usd_feed_id as unknown as number[]).length).toBe(32);
  });

  it("sell uses the next ticket PDA and the position PDA", () => {
    const ix = built.sell[0];
    const keys = ix.keys.map((m) => m.pubkey.toBase58());
    expect(keys).toContain(ticketPda(mint, user, 3n).toBase58());
    expect(keys).toContain(positionPda(mint, user).toBase58());
  });

  it("swap_buy venue slice mirrors flow.rs (tickets first, then 17 PumpSwap accounts)", () => {
    const ix = built.swap_buy[0];
    const n = idlInstruction(FUMPAD_IDL, "swap_buy").accounts.length;
    const c = coinAddresses(mint);
    expect(ix.keys[n].pubkey.equals(t1)).toBe(true);
    const venue = ix.keys.slice(n + 1);
    expect(venue[0].pubkey.equals(c.pool)).toBe(true);
    expect(venue[1].pubkey.equals(user)).toBe(true);
    expect(venue[7].pubkey.equals(c.poolBase)).toBe(true);
    expect(venue[8].pubkey.equals(c.poolQuote)).toBe(true);
    expect(venue[14].pubkey.equals(bfr)).toBe(true);
    expect(venue[16].pubkey.equals(PUMPSWAP_PROGRAM_ID)).toBe(true);
  });

  it("close_ticket encodes a None optional account as the program id", () => {
    const ix = I.closeTicketIx({ caller: user, ticket: t1, owner: user, mint, queued: false });
    const idx = idlInstruction(FUMPAD_IDL, "close_ticket").accounts.findIndex((a) => a.name === "claim_queue");
    expect(ix.keys[idx].pubkey.equals(FUMPAD_PROGRAM_ID)).toBe(true);
  });

  it("locker builders cover lock + skim", () => {
    const names = (LP_LOCKER_IDL.instructions as { name: string }[]).map((i) => i.name).sort();
    expect(names).toEqual(["lock", "skim"]);
    expect(I.lockIx({ payer: user, mint }).keys.length).toBe(idlInstruction(LP_LOCKER_IDL, "lock").accounts.length);
    expect(I.skimIx({ mint }).keys.length).toBe(idlInstruction(LP_LOCKER_IDL, "skim").accounts.length + 15);
  });

  it("rejects unknown/missing accounts", () => {
    expect(() => I.idlMetas(FUMPAD_IDL, FUMPAD_PROGRAM_ID, "set_pause", { admin: user })).toThrow(/missing account `global`/);
    expect(() => I.idlMetas(FUMPAD_IDL, FUMPAD_PROGRAM_ID, "set_pause", { admin: user, global: user, bogus: user })).toThrow(/unknown account/);
    expect(PublicKey.default.toBase58()).toBe("11111111111111111111111111111111");
  });
});
