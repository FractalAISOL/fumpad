// Every IDL instruction has a builder that produces the IDL's account count (+ documented remaining
// accounts); decoders round-trip; launch tx inspection.
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  acceptAdminIx,
  attestRebuyIx,
  attestSellIx,
  buildLaunchTx,
  cancelAdminIx,
  cancelConfigIx,
  cancelParamsIx,
  claimFeesIx,
  claimForIx,
  claimIx,
  claimLpFeesIx,
  claimPositionRewardsIx,
  claimUnregisteredFeesIx,
  closeConsumedIx,
  closePositionIx,
  closeTicketIx,
  type CoinRefs,
  DEFAULT_PARAMS,
  dbcPoolPda,
  decodeFumpadEvents,
  encodeDbcConfigParameters,
  executeBuybackIx,
  executeConfigIx,
  executeParamsIx,
  FUMPAD_IDL,
  fumpadCoder,
  fumpadConfigParams,
  graduateIx,
  initClaimQueueIx,
  initializeGlobalIx,
  initObservationsIx,
  inspectLaunchTx,
  migrateGlobalIx,
  migratePoolIx,
  processQueueIx,
  proposeAdminIx,
  queueConfigIx,
  queueParamsIx,
  recordSamplesIx,
  registerCoinIx,
  routerBuyIx,
  routerSellIx,
  setAutoClaimIx,
  setKeepersIx,
  setOperatorsIx,
  setPauseIx,
  voidTicketIx,
  withdrawCreatorFeesIx,
  withdrawEscrowIx,
  withdrawPlatformFeesIx,
  ata,
  isAttestor,
  isOperator,
  keyRole,
  rewardVault,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../src/index.js";

const k = () => Keypair.generate().publicKey;
const mint = k();
const coin: CoinRefs = { mint, dbcConfig: k() };
const sig = new Uint8Array(64).fill(9);

const built: Record<string, { keys: unknown[] }> = {
  accept_admin: acceptAdminIx(k()),
  attest_rebuy: attestRebuyIx({ keeper: k(), mint, owner: k(), ticket: k(), signature: sig, ixKey: 1, queued: false }),
  attest_sell: attestSellIx({ keeper: k(), mint, trader: k(), seq: 0n, signature: sig, ixKey: 1 }),
  buy: routerBuyIx({ trader: k(), coin, venue: "dbc", amountIn: 1n, minOut: 0n, mode: 1 }),
  cancel_admin: cancelAdminIx(k()),
  cancel_config: cancelConfigIx(k()),
  cancel_params: cancelParamsIx(k()),
  claim: claimIx({ owner: k(), mint, ticket: k() }),
  claim_fees: claimFeesIx(k(), coin),
  claim_for: claimForIx({ keeper: k(), mint, ticket: k(), owner: k() }),
  claim_lp_fees: claimLpFeesIx(k(), { ...coin, dammPosition: k(), positionNftMint: k() }),
  claim_position_rewards: claimPositionRewardsIx(k(), { ...coin, positionNftMint: k(), rewardIndex: 0, rewardMint: mint, rewardVault: k(), tokenFlag: 1, platformTreasury: k() }),
  claim_unregistered_fees: claimUnregisteredFeesIx(k(), { mint, dbcConfig: coin.dbcConfig, platformTreasury: k() }),
  close_consumed: closeConsumedIx(k(), k(), k(), k()),
  close_position: closePositionIx({ signer: k(), mint, wallet: k(), rentPayer: k(), nextTicketSeq: 0n }),
  close_ticket: closeTicketIx({ caller: k(), ticket: k(), rentPayer: k(), mint, owner: k() }),
  execute_buyback: executeBuybackIx({ cranker: k(), coin, venue: "damm_v2", maxIn: 1n }),
  execute_config: executeConfigIx(k(), k()),
  execute_params: executeParamsIx(k()),
  graduate: graduateIx({ caller: k(), coin, dammPosition: k(), positionNftMint: k() }),
  init_claim_queue: initClaimQueueIx(k(), mint),
  init_observations: initObservationsIx(k(), mint),
  initialize_global: initializeGlobalIx({ payer: k(), admin: k(), platformTreasury: k(), clusterTag: 2, params: DEFAULT_PARAMS, keepers: [k(), k(), k()], operators: [k()], configs: [k()] }),
  migrate_global: migrateGlobalIx(k()),
  migrate_pool: migratePoolIx({ caller: k(), coin, nftMint: k() }),
  process_queue: processQueueIx({ cranker: k(), mint, entries: [{ ticket: k(), owner: k() }] }),
  propose_admin: proposeAdminIx(k(), k(), k(), k()),
  queue_config: queueConfigIx(k(), k(), true),
  queue_params: queueParamsIx(k(), DEFAULT_PARAMS),
  record_samples: recordSamplesIx(k(), [{ mint, pool: k() }]),
  register_coin: registerCoinIx({ creator: k(), mint, dbcConfig: coin.dbcConfig }),
  sell: routerSellIx({ trader: k(), coin, venue: "damm_v2", amountIn: 1n, minOut: 0n }),
  set_auto_claim: setAutoClaimIx(k(), mint, false),
  set_keepers: setKeepersIx(k(), [k(), k()]),
  set_operators: setOperatorsIx(k(), [k()]),
  set_pause: setPauseIx(k(), 16),
  void_ticket: voidTicketIx({ authority: k(), ticket: k(), mint, owner: k(), consumed: k(), reason: 1, reopen: false }),
  withdraw_creator_fees: withdrawCreatorFeesIx(k(), mint),
  withdraw_escrow: withdrawEscrowIx({ owner: k(), mint, ticket: k(), destination: k(), escrowPayer: k() }),
  withdraw_platform_fees: withdrawPlatformFeesIx(k(), mint, k()),
};
/** Remaining accounts the builders append (INTERFACE §3). */
const REMAINING: Record<string, number> = { initialize_global: 1, buy: 15, sell: 14, execute_buyback: 14, migrate_pool: 26, process_queue: 4, record_samples: 3 };

describe("instruction builders vs IDL", () => {
  const idlIxs = (FUMPAD_IDL.instructions as unknown as { name: string; accounts: unknown[] }[]).map((i) => [i.name, i.accounts.length] as const);
  it("cover every IDL instruction", () => expect(Object.keys(built).sort()).toEqual(idlIxs.map(([n]) => n).sort()));
  for (const [name, n] of idlIxs) {
    it(`${name}: ${n} IDL accounts (+ remaining)`, () => expect(built[name].keys.length).toBe(n + (REMAINING[name] ?? 0)));
  }
});

describe("initialize_global bootstrap", () => {
  it("encodes 3 keeper slots (padded) and passes configs as read-only remaining accounts", () => {
    const [a, b, c1, c2] = [k(), k(), k(), k()];
    const i = initializeGlobalIx({ payer: k(), admin: k(), platformTreasury: k(), clusterTag: 1, params: DEFAULT_PARAMS, keepers: [a, b], configs: [c1, c2] });
    const d = fumpadCoder().instruction.decode(Buffer.from(i.data)) as { name: string; data: { keepers: PublicKey[]; cluster_tag: number } };
    expect(d.name).toBe("initialize_global");
    expect(d.data.keepers.map((x) => x.toBase58())).toEqual([a, b, PublicKey.default].map((x) => x.toBase58()));
    expect(d.data.cluster_tag).toBe(1);
    expect(i.keys.slice(-2).map((m) => [m.pubkey.toBase58(), m.isSigner, m.isWritable])).toEqual([[c1.toBase58(), false, false], [c2.toBase58(), false, false]]);
    expect(() => initializeGlobalIx({ payer: k(), admin: k(), platformTreasury: k(), clusterTag: 1, params: DEFAULT_PARAMS, keepers: [k(), k(), k(), k()] })).toThrow();
    expect(() => initializeGlobalIx({ payer: k(), admin: k(), platformTreasury: k(), clusterTag: 1, params: DEFAULT_PARAMS, configs: Array.from({ length: 9 }, k) })).toThrow();
  });
});

describe("operators (jobs keys)", () => {
  it("initialize_global passes the operators as a list (≤ 2) and refuses an operator that is also a keeper", () => {
    const [a, b, o] = [k(), k(), k()];
    const i = initializeGlobalIx({ payer: k(), admin: k(), platformTreasury: k(), clusterTag: 1, params: DEFAULT_PARAMS, keepers: [a, b], operators: [o] });
    const d = fumpadCoder().instruction.decode(Buffer.from(i.data)) as unknown as { data: { operators: PublicKey[] } };
    expect(d.data.operators.map((x) => x.toBase58())).toEqual([o.toBase58()]);
    expect(() => initializeGlobalIx({ payer: k(), admin: k(), platformTreasury: k(), clusterTag: 1, params: DEFAULT_PARAMS, keepers: [a, b], operators: [b] })).toThrow(/attestor and an operator/);
    expect(() => initializeGlobalIx({ payer: k(), admin: k(), platformTreasury: k(), clusterTag: 1, params: DEFAULT_PARAMS, operators: [k(), k(), k()] })).toThrow();
    expect(() => setOperatorsIx(k(), [k(), k(), k()])).toThrow();
  });
  it("set_operators encodes exactly 2 slots", () => {
    const o = k();
    const d = fumpadCoder().instruction.decode(Buffer.from(setOperatorsIx(k(), [o]).data)) as { name: string; data: { operators: PublicKey[] } };
    expect(d.name).toBe("set_operators");
    expect(d.data.operators.map((x) => x.toBase58())).toEqual([o.toBase58(), PublicKey.default.toBase58()]);
  });
  it("keyRole / isOperator / isAttestor", () => {
    const [a, o] = [k(), k()];
    const g = { keepers: [a, PublicKey.default, PublicKey.default], operators: [o, PublicKey.default] };
    expect([keyRole(g, a), keyRole(g, o), keyRole(g, k()), keyRole(g, PublicKey.default)]).toEqual(["attestor", "operator", null, null]);
    expect(keyRole({ keepers: [a], operators: [a] }, a)).toBe("both");
    expect(isOperator(g, o) && isAttestor(g, a) && !isOperator(g, a)).toBe(true);
  });
});

describe("stranded-value claims", () => {
  it("claim_position_rewards routes the coin's own mint to its reward vault, others to the treasury ATA", () => {
    const [nft, vault, treasury, foreign] = [k(), k(), k(), k()];
    const own = claimPositionRewardsIx(k(), { ...coin, positionNftMint: nft, rewardIndex: 0, rewardMint: mint, rewardVault: vault, tokenFlag: 1, platformTreasury: treasury });
    const other = claimPositionRewardsIx(k(), { ...coin, positionNftMint: nft, rewardIndex: 1, rewardMint: foreign, rewardVault: vault, tokenFlag: 0, platformTreasury: treasury });
    const dest = (i: { keys: { pubkey: PublicKey }[] }) => i.keys[9].pubkey.toBase58();
    const prog = (i: { keys: { pubkey: PublicKey }[] }) => i.keys[11].pubkey.toBase58();
    expect(dest(own)).toBe(rewardVault(mint).toBase58());
    expect(prog(own)).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    expect(dest(other)).toBe(ata(treasury, foreign, TOKEN_PROGRAM_ID).toBase58());
    expect(prog(other)).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});

describe("DBC config parameters", () => {
  it("encodes the FUMPAD config (curve + fee scheduler)", () => {
    const b = encodeDbcConfigParameters(fumpadConfigParams("devnet"));
    // fixed part + 2 curve points of 32 bytes
    expect(b.length).toBeGreaterThan(200);
    expect(b.slice(-64 - 4, -64)).toEqual(Uint8Array.from([2, 0, 0, 0]));
  });
});

describe("launch transaction", () => {
  it("builds and inspects [cb] [wrap] init [ata] swap2 register [close]", () => {
    const creator = Keypair.generate();
    const m = Keypair.generate();
    const cfg = k();
    const tx = buildLaunchTx({ creator: creator.publicKey, mint: m.publicKey, dbcConfig: cfg, name: "Fumble", symbol: "FUM", uri: "https://x.y/m.json", buyLamports: 1_000_000n, minTokensOut: 5n }, "11111111111111111111111111111111");
    tx.sign([m]);
    const info = inspectLaunchTx(tx);
    expect(info).toMatchObject({ creator: creator.publicKey.toBase58(), mint: m.publicKey.toBase58(), dbcConfig: cfg.toBase58(), name: "Fumble", symbol: "FUM", buyLamports: 1_000_000n, minTokensOut: 5n });
    expect(info.signed).toEqual([m.publicKey.toBase58()]);
    expect(dbcPoolPda(cfg, m.publicKey)).toBeInstanceOf(PublicKey);
  });
  it("no first buy: init + register only", () => {
    const tx = buildLaunchTx({ creator: k(), mint: k(), dbcConfig: k(), name: "A", symbol: "A", uri: "https://a" }, "11111111111111111111111111111111");
    expect(inspectLaunchTx(tx).buyLamports).toBe(undefined);
  });
});

describe("events", () => {
  it("ignores failed txs", () => expect(decodeFumpadEvents({ slot: 1, transaction: { signatures: ["x"], message: { accountKeys: [] } }, meta: { err: { x: 1 } } })).toEqual([]));
});
