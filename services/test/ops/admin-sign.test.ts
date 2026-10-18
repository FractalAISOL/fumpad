/** Single-wallet admin signing (scripts/mainnet/admin-sign*.ts): proposal building + validation, the signed-tx rules, CLI. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_PARAMS, FEE_POLICY, FUMPAD_PROGRAM_ID, type GlobalAccount, globalPda, MAX_CONFIGS, STANDARD_FEE_POLICY, setPauseIx } from "@fumpad/sdk";

import { type AdminChain, buildProposal, type BuildOpts, parsePauseBits } from "../../scripts/mainnet/admin-sign-core.js";
import { parseAdminSignCli, resolveTargets } from "../../scripts/mainnet/admin-sign.js";
import { b64, buildProposalTx, ixToJson, type Proposal, proposalProblems, signedTxProblems, unsignedWire } from "../../scripts/mainnet/admin-sign-tx.js";

const NOW = 1_800_000_000;
const pk = () => Keypair.generate().publicKey;

function fakeGlobal(over: Partial<GlobalAccount> = {}): GlobalAccount {
  const d = PublicKey.default;
  return {
    bump: 255,
    admin: pk(),
    platformTreasury: pk(),
    guardian: pk(),
    keepers: [d, d, d],
    keeperAddedAt: [0n, 0n, 0n],
    clusterTag: 0,
    paused: 0,
    pauseExpiresAt: 0n,
    params: DEFAULT_PARAMS,
    pendingParams: DEFAULT_PARAMS,
    pendingEta: 0n,
    pendingAdmin: d,
    pendingTreasury: d,
    pendingGuardian: d,
    pendingAdminEta: 0n,
    configs: Array(MAX_CONFIGS).fill(d),
    pendingConfig: d,
    pendingConfigAdd: 0,
    pendingConfigEta: 0n,
    operators: [d, d],
    configPolicies: Array(MAX_CONFIGS).fill(STANDARD_FEE_POLICY),
    configCoins: Array(MAX_CONFIGS).fill(0),
    pendingConfigPolicy: STANDARD_FEE_POLICY,
    ...over,
  };
}

function fakeChain(g: GlobalAccount | null, o: { balance?: bigint; simErr?: unknown; simLogs?: string[] } = {}) {
  const simulated: Transaction[] = [];
  const chain: AdminChain = {
    genesisHash: async () => "LocalGenesis1111111111111111111111111111111",
    global: async () => g,
    balance: async () => o.balance ?? 50_000_000n,
    now: async () => NOW,
    latestBlockhash: async () => Keypair.generate().publicKey.toBase58(),
    simulate: async (tx) => {
      simulated.push(tx);
      return { err: o.simErr ?? null, logs: o.simLogs ?? ["Program log: Instruction: X"], unitsConsumed: 12_345 };
    },
  };
  return { chain, simulated };
}

const opts = (o: Partial<BuildOpts> & Pick<BuildOpts, "action" | "signer">): BuildOpts => ({ cluster: "local", ...o });

describe("admin-sign: proposal building", () => {
  it("accept-admin: the pending admin after the eta → a valid proposal (simulated with the wallet as signer + fee payer)", async () => {
    const w = Keypair.generate();
    const g = fakeGlobal({ pendingAdmin: w.publicKey, pendingGuardian: w.publicKey, pendingTreasury: pk(), pendingAdminEta: BigInt(NOW - 10) });
    const { chain, simulated } = fakeChain(g);
    const p = await buildProposal(opts({ action: "accept-admin", signer: w.publicKey }), chain);
    expect(proposalProblems(p)).toEqual([]);
    expect(p.signer).toBe(w.publicKey.toBase58());
    expect(p.programId).toBe(FUMPAD_PROGRAM_ID.toBase58());
    expect(p.instructions).toHaveLength(1);
    expect(p.instructions[0].programId).toBe(FUMPAD_PROGRAM_ID.toBase58());
    expect(p.instructions[0].keys.filter((k) => k.isSigner).map((k) => k.pubkey)).toEqual([w.publicKey.toBase58()]);
    expect(p.accounts[0]).toMatchObject({ address: w.publicKey.toBase58(), signer: true, writable: true });
    expect(p.accounts.some((a) => a.address === globalPda().toBase58() && a.writable)).toBe(true);
    expect(p.summary.join(" ")).toContain("becomes the FUMPAD admin");
    expect(p.computeUnitLimit).toBe(Math.ceil(12_345 * 1.3) + 5_000 < 30_000 ? 30_000 : Math.ceil(12_345 * 1.3) + 5_000);
    expect(p.maxFeeLamports).toBe(5_000 + Math.ceil((p.computeUnitLimit * 20_000) / 1e6));
    expect(simulated).toHaveLength(1);
    expect(simulated[0].feePayer?.equals(w.publicKey)).toBe(true);
    expect(JSON.stringify(p)).not.toMatch(/secret|private/i);
  });
  it("refuses the wrong signer", async () => {
    const g = fakeGlobal({ pendingAdmin: pk(), pendingAdminEta: BigInt(NOW - 10) });
    await expect(buildProposal(opts({ action: "accept-admin", signer: pk() }), fakeChain(g).chain)).rejects.toThrow(/wrong signer: the pending admin is/);
    await expect(buildProposal(opts({ action: "set-pause", signer: pk(), pauseBits: 0 }), fakeChain(g).chain)).rejects.toThrow(/wrong signer: .* neither the admin .* nor the guardian/);
    await expect(buildProposal(opts({ action: "queue-config-remove", signer: g.guardian, config: pk() }), fakeChain(g).chain)).rejects.toThrow(/wrong signer: queue_config needs the admin/);
  });
  it("refuses accept-admin before the eta, and without a pending proposal", async () => {
    const w = pk();
    const g = fakeGlobal({ pendingAdmin: w, pendingAdminEta: BigInt(NOW + 3_600) });
    await expect(buildProposal(opts({ action: "accept-admin", signer: w }), fakeChain(g).chain)).rejects.toThrow(/eta not reached.*1 h 0 min to go/);
    await expect(buildProposal(opts({ action: "accept-admin", signer: w }), fakeChain(fakeGlobal()).chain)).rejects.toThrow(/no pending propose_admin/);
  });
  it("refuses a failing simulation (prints the Anchor error) and writes nothing", async () => {
    const g = fakeGlobal();
    const logs: string[] = [];
    const { chain } = fakeChain(g, { simErr: { InstructionError: [1, { Custom: 6000 }] }, simLogs: ["Program log: AnchorError occurred. Error Code: Unauthorized. Error Number: 6000. Error Message: Unauthorized."] });
    await expect(buildProposal(opts({ action: "set-pause", signer: g.guardian, pauseBits: 0 }), chain, (s) => logs.push(s))).rejects.toThrow(/simulation failed: .*Custom.*Unauthorized: Unauthorized/);
    expect(logs.join("\n")).toContain("AnchorError");
  });
  it("refuses unsupported actions, a wallet without SOL, and no Global", async () => {
    const g = fakeGlobal();
    await expect(buildProposal(opts({ action: "upgrade-program" as never, signer: g.admin }), fakeChain(g).chain)).rejects.toThrow(/unsupported action/);
    await expect(buildProposal(opts({ action: "set-pause", signer: g.guardian, pauseBits: 1 }), fakeChain(g, { balance: 0n }).chain)).rejects.toThrow(/0 SOL/);
    await expect(buildProposal(opts({ action: "set-pause", signer: g.guardian, pauseBits: 1 }), fakeChain(g, { balance: 1_000_000n }).chain)).rejects.toThrow(/~0.02 SOL/);
    await expect(buildProposal(opts({ action: "set-pause", signer: g.guardian, pauseBits: 1 }), fakeChain(null).chain)).rejects.toThrow(/no FUMPAD Global/);
    const pda = PublicKey.findProgramAddressSync([Buffer.from("x")], FUMPAD_PROGRAM_ID)[0];
    await expect(buildProposal(opts({ action: "set-pause", signer: pda, pauseBits: 1 }), fakeChain(g).chain)).rejects.toThrow(/off-curve/);
  });
  it("set-pause: drill (0, nothing paused) and a real pause; bits parsing", async () => {
    const w = pk();
    const g = fakeGlobal({ admin: w, guardian: w });
    const drill = await buildProposal(opts({ action: "set-pause", signer: w, pauseBits: 0 }), fakeChain(g).chain);
    expect(drill.title).toMatch(/drill/);
    expect(drill.signerRole).toBe("admin + guardian");
    expect(drill.instructions[0]).toEqual(ixToJson(setPauseIx(w, 0)));
    const pause = await buildProposal(opts({ action: "set-pause", signer: w, pauseBits: parsePauseBits("launch,trade") }), fakeChain(g).chain);
    expect(pause.title).toBe("PAUSE FUMPAD: 3 (launch + trade)");
    expect(parsePauseBits("all")).toBe(31);
    expect(parsePauseBits("none")).toBe(0);
    expect(parsePauseBits("16")).toBe(16);
    expect(() => parsePauseBits("32")).toThrow(/> 31/);
    expect(() => parsePauseBits("launch,nope")).toThrow(/unknown pause flag nope/);
  });
  it("queue-config-remove: on the allow-list, nothing else pending", async () => {
    const admin = pk();
    const first = pk();
    const wallet = pk();
    const configs = [pk(), first, ...Array(MAX_CONFIGS - 2).fill(PublicKey.default)];
    const policies = [STANDARD_FEE_POLICY, { kind: FEE_POLICY.walletSplit, buybackShare: 100, walletShare: 140, maxCoins: 1, wallet }, ...Array(MAX_CONFIGS - 2).fill(STANDARD_FEE_POLICY)];
    const g = fakeGlobal({ admin, configs, configPolicies: policies, configCoins: [5, 1, ...Array(MAX_CONFIGS - 2).fill(0)] });
    const p = await buildProposal(opts({ action: "queue-config-remove", signer: admin, config: first }), fakeChain(g).chain);
    expect(p.instructions[0].keys.map((k) => k.pubkey)).toContain(first.toBase58());
    expect(p.summary[0]).toContain(`wallet-split → ${wallet.toBase58()}`);
    expect(p.accounts.find((a) => a.address === first.toBase58())?.label).toBe("DBC config being removed");
    await expect(buildProposal(opts({ action: "queue-config-remove", signer: admin, config: pk() }), fakeChain(g).chain)).rejects.toThrow(/not on the allow-list/);
    const busy = fakeGlobal({ ...g, pendingConfig: pk(), pendingConfigEta: BigInt(NOW + 100), pendingConfigAdd: 1 });
    await expect(buildProposal(opts({ action: "queue-config-remove", signer: admin, config: first }), fakeChain(busy).chain)).rejects.toThrow(/another config change is pending/);
  });
  it("cancel-admin needs a pending proposal; ix-json refuses a second signer and needs a title", async () => {
    const w = pk();
    const g = fakeGlobal({ guardian: w });
    await expect(buildProposal(opts({ action: "cancel-admin", signer: w }), fakeChain(g).chain)).rejects.toThrow(/no pending propose_admin to cancel/);
    const ok = await buildProposal(opts({ action: "cancel-admin", signer: w }), fakeChain({ ...g, pendingAdmin: pk(), pendingAdminEta: BigInt(NOW + 5) }).chain);
    expect(ok.signerRole).toBe("guardian");
    const other = pk();
    const ix = { programId: FUMPAD_PROGRAM_ID.toBase58(), keys: [{ pubkey: other.toBase58(), isSigner: true, isWritable: false }], data: b64.encode(new Uint8Array([1, 2])) };
    await expect(buildProposal(opts({ action: "ix-json", signer: w, ixs: [ix], title: "t" }), fakeChain(g).chain)).rejects.toThrow(/wallet can only sign as/);
    await expect(buildProposal(opts({ action: "ix-json", signer: w, ixs: [ix] }), fakeChain(g).chain)).rejects.toThrow(/needs --title/);
    const mine = { ...ix, keys: [{ pubkey: w.toBase58(), isSigner: true, isWritable: false }] };
    const p = await buildProposal(opts({ action: "ix-json", signer: w, ixs: [mine], title: "Custom thing", summary: ["does X"] }), fakeChain(g).chain);
    expect(p.summary).toEqual(["does X"]);
    expect(p.values[0]).toEqual({ label: "instruction 0 data (hex)", value: "0102" });
  });
});

describe("admin-sign: proposal + signed transaction validation", () => {
  async function proposal(w: Keypair): Promise<Proposal> {
    const g = fakeGlobal({ guardian: w.publicKey });
    return buildProposal(opts({ action: "set-pause", signer: w.publicKey, pauseBits: 0 }), fakeChain(g).chain);
  }
  it("proposalProblems catches tampering", async () => {
    const w = Keypair.generate();
    const p = await proposal(w);
    expect(proposalProblems({ ...p, action: "drain" })).toEqual([expect.stringMatching(/unsupported action/)]);
    expect(proposalProblems({ ...p, signer: globalPda().toBase58() }).join()).toMatch(/off-curve/);
    expect(proposalProblems({ ...p, instructions: [...p.instructions, ixToJson(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }))] }).join()).toMatch(/compute-budget/);
    expect(proposalProblems({ ...p, instructions: [] }).join()).toMatch(/at least one/);
    expect(proposalProblems({ ...p, computeUnitPriceMicroLamports: 1e9 }).join()).toMatch(/computeUnitPriceMicroLamports/);
    expect(proposalProblems(null)).toEqual(["not a JSON object"]);
  });
  it("signedTxProblems: only the signer's valid signature over exactly the proposal's instructions", async () => {
    const w = Keypair.generate();
    const p = await proposal(w);
    const bh = Keypair.generate().publicKey.toBase58();
    const tx = buildProposalTx(p, bh);
    expect(signedTxProblems(p, Transaction.from(unsignedWire(tx)))).toEqual(["not signed"]);
    tx.sign(w);
    expect(signedTxProblems(p, tx)).toEqual([]);
    // a wallet may change the compute budget (it re-signs)
    const tx2 = buildProposalTx({ ...p, computeUnitPriceMicroLamports: 99_999 }, bh);
    tx2.sign(w);
    expect(signedTxProblems(p, tx2)).toEqual([]);
    // signed by another key
    const other = buildProposalTx({ ...p, signer: Keypair.generate().publicKey.toBase58() }, bh);
    expect(signedTxProblems(p, other).join()).toMatch(/fee payer/);
    // instruction changed
    const evil = buildProposalTx({ ...p, instructions: [ixToJson(setPauseIx(w.publicKey, 31))] }, bh);
    evil.sign(w);
    expect(signedTxProblems(p, evil).join()).toMatch(/instructions differ/);
    // a read-only account escalated to writable (same keys + data otherwise)
    const esc = buildProposalTx({ ...p, instructions: p.instructions.map((ix) => ({ ...ix, keys: ix.keys.map((k) => ({ ...k, isWritable: true })) })) }, bh);
    esc.sign(w);
    expect(signedTxProblems(p, esc).join()).toMatch(/instructions differ/);
    // signature broken
    const broken = buildProposalTx(p, bh);
    broken.sign(w);
    broken.signatures[0].signature![0] ^= 1;
    expect(signedTxProblems(p, broken).join()).toMatch(/does not verify/);
  });
});

describe("admin-sign CLI", () => {
  const env = () => {
    const d = mkdtempSync(join(tmpdir(), "fumpad-as-"));
    writeFileSync(join(d, "rpc.env"), "RPC_URL=https://example.invalid/?api-key=secret\n");
    return join(d, "rpc.env");
  };
  it("flags", () => {
    const e = env();
    expect(() => parseAdminSignCli(["--cluster", "mainnet", "--rpc-env", e])).toThrow(/--action/);
    expect(() => parseAdminSignCli(["--action", "set-pause", "--cluster", "mainnet", "--rpc-env", e])).toThrow(/--bits/);
    expect(() => parseAdminSignCli(["--action", "accept-admin", "--cluster", "mainnet", "--rpc-env", e, "--send"])).toThrow(/unknown flag --send/);
    expect(() => parseAdminSignCli(["--action", "upgrade", "--cluster", "mainnet", "--rpc-env", e])).toThrow(/--action/);
    expect(() => parseAdminSignCli(["--action", "ix-json", "--cluster", "local", "--ix-json", "x.json"])).toThrow(/--title/);
    const a = parseAdminSignCli(["--action", "set-pause", "--bits", "0", "--cluster", "mainnet", "--rpc-env", e, "--note", "drill 1", "--note", "drill 2"]);
    expect(a).toMatchObject({ action: "set-pause", bits: "0", notes: ["drill 1", "drill 2"], rpcUrl: "https://example.invalid/?api-key=secret" });
  });
  it("signer + program id from the bootstrap config (single wallet), refusing a mismatch or a Squads party", () => {
    const d = mkdtempSync(join(tmpdir(), "fumpad-as-cfg-"));
    const prog = Keypair.generate();
    const first = Keypair.generate();
    writeFileSync(join(d, "fumpad-program-keypair.json"), JSON.stringify(Array.from(prog.secretKey)));
    writeFileSync(join(d, "dbc-config-first-coin.json"), JSON.stringify(Array.from(first.secretKey)));
    const w = pk().toBase58();
    writeFileSync(join(d, "c.json"), JSON.stringify({ deployerKeypair: "d.json", admin: { kind: "hardware", address: w }, guardian: { kind: "hardware", address: w }, treasury: pk().toBase58() }));
    const base = { cluster: "local" as const, rpcUrl: "http://127.0.0.1:8899", notes: [], configPath: join(d, "c.json") };
    const t = resolveTargets({ ...base, action: "queue-config-remove" });
    expect(t).toMatchObject({ programId: prog.publicKey.toBase58(), signer: w, configAccount: first.publicKey.toBase58(), outDir: join(d, "proposals") });
    expect(() => resolveTargets({ ...base, action: "accept-admin", signer: pk().toBase58() })).toThrow(/wrong signer/);
    expect(() => resolveTargets({ ...base, action: "accept-admin", programId: pk().toBase58() })).toThrow(/≠ the config's program/);
    const ms = pk().toBase58();
    writeFileSync(join(d, "c.json"), JSON.stringify({ deployerKeypair: "d.json", admin: { kind: "squads", multisig: ms, address: pk().toBase58() }, guardian: { kind: "hardware", address: w }, treasury: pk().toBase58() }));
    expect(() => resolveTargets({ ...base, action: "accept-admin" })).toThrow(/Squads multisig/);
    expect(resolveTargets({ ...base, action: "set-pause", bits: "0" }).signer).toBe(w);
    expect(() => resolveTargets({ action: "set-pause", cluster: "local", rpcUrl: "x", notes: [], signer: w })).toThrow(/--program-id/);
  });
});
