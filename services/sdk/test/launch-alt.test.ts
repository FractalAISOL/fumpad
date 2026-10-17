// The FUMPAD launch address lookup table: its fixed contents, the verification every reader runs, the create + extend +
// freeze instructions, and launch transactions built / inspected through it.
import { AddressLookupTableAccount, AddressLookupTableProgram, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  buildLaunchTx,
  coinPda,
  dbcPoolPda,
  DBC_PROGRAM_ID,
  FUMPAD_PROGRAM_ID,
  globalPda,
  inspectLaunchTx,
  LAUNCH_TX_MAX_BYTES,
  launchAltAddresses,
  launchAltCreateIxs,
  launchAltProblems,
  launchTxLookupTables,
  loadLaunchAlt,
  rewardPoolPda,
  SYSVAR_INSTRUCTIONS_ID,
} from "../src/index.js";

const U64_MAX = (1n << 64n) - 1n;
const k = () => Keypair.generate().publicKey;
const table = (key: PublicKey, addresses: PublicKey[], o: { authority?: PublicKey; deactivationSlot?: bigint } = {}) =>
  new AddressLookupTableAccount({ key, state: { deactivationSlot: o.deactivationSlot ?? U64_MAX, lastExtendedSlot: 1, lastExtendedSlotStartIndex: 0, authority: o.authority, addresses } });
function rawAlt(addresses: PublicKey[], authority?: PublicKey): Buffer {
  const meta = Buffer.alloc(56);
  meta.writeUInt32LE(1, 0);
  meta.writeBigUInt64LE(U64_MAX, 4);
  if (authority) {
    meta.writeUInt8(1, 21);
    authority.toBuffer().copy(meta, 22);
  }
  return Buffer.concat([meta, ...addresses.map((a) => a.toBuffer())]);
}

describe("launch ALT contents", () => {
  it("11 static accounts of this deployment, fixed order, no duplicates; never a per-coin account, signer or invoked program", () => {
    const want = launchAltAddresses();
    expect(want).toHaveLength(11);
    expect(new Set(want.map((x) => x.toBase58())).size).toBe(11);
    expect(want[0].equals(globalPda()) && want[1].equals(rewardPoolPda())).toBe(true);
    expect(want.some((x) => x.equals(SYSVAR_INSTRUCTIONS_ID))).toBe(true);
    for (const p of [FUMPAD_PROGRAM_ID, DBC_PROGRAM_ID]) expect(want.some((x) => x.equals(p))).toBe(false);
    // derived from the program id it is given
    const other = k();
    expect(launchAltAddresses(other)[0].equals(PublicKey.findProgramAddressSync([Buffer.from("global")], other)[0])).toBe(true);
  });

  it("launchAltProblems: exact contents, frozen, active, the configured address", () => {
    const addr = k();
    expect(launchAltProblems(table(addr, launchAltAddresses()), addr)).toEqual([]);
    expect(launchAltProblems(null, addr)[0]).toMatch(/not found/);
    expect(launchAltProblems(table(k(), launchAltAddresses()), addr).join()).toMatch(/not the configured/);
    const w = launchAltAddresses();
    expect(launchAltProblems(table(addr, [w[1], w[0], ...w.slice(2)]), addr).join()).toMatch(/contents/);
    expect(launchAltProblems(table(addr, [...w, k()]), addr).join()).toMatch(/contents/);
    expect(launchAltProblems(table(addr, w.slice(1)), addr).join()).toMatch(/contents/);
    expect(launchAltProblems(table(addr, w, { authority: k() }), addr).join()).toMatch(/not frozen/);
    expect(launchAltProblems(table(addr, w, { deactivationSlot: 9n }), addr).join()).toMatch(/deactivated/);
  });

  it("loadLaunchAlt / launchTxLookupTables: owner + decode + verification; another table than the configured one is refused", async () => {
    const addr = k();
    const accounts = new Map<string, { data: Uint8Array; owner: PublicKey }>([[addr.toBase58(), { data: rawAlt(launchAltAddresses()), owner: AddressLookupTableProgram.programId }]]);
    const conn = { getAccountInfo: async (a: PublicKey) => accounts.get(a.toBase58()) ?? null };
    expect((await loadLaunchAlt(conn, addr)).state.addresses).toHaveLength(11);
    const bad = k();
    accounts.set(bad.toBase58(), { data: rawAlt(launchAltAddresses(), k()), owner: AddressLookupTableProgram.programId });
    await expect(loadLaunchAlt(conn, bad)).rejects.toThrow(/not frozen/);
    const fake = k();
    accounts.set(fake.toBase58(), { data: rawAlt(launchAltAddresses()), owner: k() });
    await expect(loadLaunchAlt(conn, fake)).rejects.toThrow(/not owned/);
    await expect(loadLaunchAlt(conn, k())).rejects.toThrow(/not found/);

    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const p = { creator: creator.publicKey, mint: mint.publicKey, dbcConfig: k(), name: "N".repeat(32), symbol: "S".repeat(10), uri: "https://ipfs.io/ipfs/Qm" + "1".repeat(44), buyLamports: 1_000_000n, minTokensOut: 5n, launchSigner: k(), priorityMicroLamports: 5_000_000 };
    const tx = buildLaunchTx(p, "11111111111111111111111111111111", await loadLaunchAlt(conn, addr));
    expect(await launchTxLookupTables(conn, tx, addr)).toHaveLength(1);
    await expect(launchTxLookupTables(conn, tx, k())).rejects.toThrow(/not the configured/);
    expect(await launchTxLookupTables(conn, buildLaunchTx(p, "11111111111111111111111111111111"))).toEqual([]);
  });
});

describe("launch transaction through the ALT", () => {
  it("max name + symbol + https uri + first buy + co-signer + priority fee fits (inline it doesn't); inspect resolves every key", () => {
    const addr = k();
    const alt = table(addr, launchAltAddresses());
    const creator = Keypair.generate();
    const mint = Keypair.generate();
    const cfg = k();
    const ls = Keypair.generate();
    const p = { creator: creator.publicKey, mint: mint.publicKey, dbcConfig: cfg, name: "N".repeat(32), symbol: "S".repeat(10), uri: "https://ipfs.io/ipfs/Qm" + "1".repeat(44), buyLamports: 1_000_000n, minTokensOut: 5n, launchSigner: ls.publicKey, priorityMicroLamports: 5_000_000 };
    const tx = buildLaunchTx(p, "11111111111111111111111111111111", alt);
    tx.sign([mint, ls]);
    expect(tx.serialize().length).toBeLessThanOrEqual(LAUNCH_TX_MAX_BYTES);
    expect(LAUNCH_TX_MAX_BYTES - tx.serialize().length).toBeGreaterThanOrEqual(100);
    expect(buildLaunchTx(p, "11111111111111111111111111111111").serialize().length).toBeGreaterThan(LAUNCH_TX_MAX_BYTES);
    // per-coin accounts and signers stay static; the static launch accounts come from the table
    const stat = tx.message.staticAccountKeys;
    for (const x of [creator.publicKey, mint.publicKey, ls.publicKey, cfg, dbcPoolPda(cfg, mint.publicKey), coinPda(mint.publicKey)]) expect(stat.some((s) => s.equals(x))).toBe(true);
    expect(stat.some((s) => s.equals(globalPda()))).toBe(false);
    const info = inspectLaunchTx(tx, [alt]);
    expect(info).toMatchObject({ creator: creator.publicKey.toBase58(), mint: mint.publicKey.toBase58(), dbcConfig: cfg.toBase58(), name: p.name, symbol: p.symbol, uri: p.uri, buyLamports: 1_000_000n, minTokensOut: 5n });
    expect([...info.signed].sort()).toEqual([mint.publicKey.toBase58(), ls.publicKey.toBase58()].sort());
    expect(() => inspectLaunchTx(tx)).toThrow(/wasn't supplied/);
    expect(() => inspectLaunchTx(tx, [table(addr, launchAltAddresses().slice(0, 3))])).toThrow(/don't exist/);
  });

  it("create + extend + freeze: one table address, the 11 accounts, the authority's freeze last", () => {
    const auth = k();
    const { address, ixs } = launchAltCreateIxs({ authority: auth, payer: auth, recentSlot: 123 });
    expect(ixs).toHaveLength(3);
    expect(ixs.every((i) => i.programId.equals(AddressLookupTableProgram.programId))).toBe(true);
    expect(ixs[0].keys[0].pubkey.equals(address) && ixs[1].keys[0].pubkey.equals(address) && ixs[2].keys[0].pubkey.equals(address)).toBe(true);
    expect(ixs[2].data.readUInt32LE(0)).toBe(1); // FreezeLookupTable
    expect(ixs[1].data.readUInt32LE(0)).toBe(2); // ExtendLookupTable
    const n = Number(ixs[1].data.readBigUInt64LE(4));
    expect(n).toBe(11);
    const keys = Array.from({ length: n }, (_, i) => new PublicKey(ixs[1].data.subarray(12 + 32 * i, 44 + 32 * i)));
    expect(keys.map((x) => x.toBase58())).toEqual(launchAltAddresses().map((x) => x.toBase58()));
  });
});
