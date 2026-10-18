/**
 * Admin signing page, the proposal builder (CLI: admin-sign.ts; runbook: services/LAUNCH-DAY.md "single-wallet
 * admin"). Imported only after `FUMPAD_PROGRAM_ID` is set (the SDK reads it at import).
 *
 * Reads Global, checks the action makes sense for the wallet (right role, eta reached, …), builds the instruction with
 * the SDK's builders, simulates it with the wallet as signer + fee payer (sigVerify off) and returns the proposal —
 * or throws with the reason. Never touches a private key.
 */
import { type Connection, PublicKey, type Transaction, VersionedTransaction } from "@solana/web3.js";

import {
  acceptAdminIx,
  cancelAdminIx,
  CONFIG_TIMELOCK_SECS,
  configSlot,
  decodeGlobal,
  eventAuthorityPda,
  FEE_POLICY,
  FUMPAD_PROGRAM_ID,
  type GlobalAccount,
  globalPda,
  MAX_PAUSE_SECS,
  PAUSE,
  PAUSE_ALL,
  queueConfigIx,
  setPauseIx,
} from "@fumpad/sdk";

import {
  buildProposalTx,
  instructionProblems,
  ixToJson,
  maxFeeLamports,
  type Proposal,
  type ProposalAccount,
  PROPOSAL_ACTIONS,
  PROPOSAL_VERSION,
  type ProposalAction,
  type ProposalCluster,
  type ProposalIx,
  proposalProblems,
} from "./admin-sign-tx.js";

/** What the builder needs from the chain (a Connection in the CLI; a fake in the unit tests). */
export interface AdminChain {
  genesisHash(): Promise<string>;
  global(): Promise<GlobalAccount | null>;
  balance(k: PublicKey): Promise<bigint>;
  /** chain unix time (Clock sysvar) */
  now(): Promise<number>;
  latestBlockhash(): Promise<string>;
  simulate(tx: Transaction): Promise<{ err: unknown; logs: string[]; unitsConsumed: number | null }>;
}

export function connectionChain(conn: Connection): AdminChain {
  return {
    genesisHash: () => conn.getGenesisHash(),
    async global() {
      const a = await conn.getAccountInfo(globalPda(), "confirmed");
      return a ? decodeGlobal(new Uint8Array(a.data)) : null;
    },
    balance: async (k) => BigInt(await conn.getBalance(k, "confirmed")),
    now: async () => Number((await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"), "confirmed"))!.data.readBigInt64LE(32)),
    latestBlockhash: async () => (await conn.getLatestBlockhash("confirmed")).blockhash,
    async simulate(tx) {
      // the wallet hasn't signed: sigVerify off, any recent blockhash
      const r = await conn.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" });
      return { err: r.value.err, logs: r.value.logs ?? [], unitsConsumed: r.value.unitsConsumed ?? null };
    },
  };
}

export interface BuildOpts {
  action: ProposalAction;
  cluster: ProposalCluster;
  /** the wallet (admin / guardian) that signs and pays */
  signer: PublicKey;
  /** set-pause: the new Global.paused bits (0 = unpause; harmless drill when nothing is paused) */
  pauseBits?: number;
  /** queue-config-remove: the DBC config to remove from the allow-list */
  config?: PublicKey;
  /** ix-json */
  ixs?: ProposalIx[];
  title?: string;
  summary?: string[];
  computeUnitPriceMicroLamports?: number;
  /** override (default: simulated units × 1.3 + 5,000, at least 30,000) */
  computeUnitLimit?: number;
}

export class ProposalRefused extends Error {}
const refuse = (m: string): never => {
  throw new ProposalRefused(m);
};

const SOL = 1_000_000_000;
const sol = (l: bigint | number) => (Number(l) / SOL).toFixed(6);
const iso = (t: bigint | number) => new Date(Number(t) * 1000).toISOString();
const dur = (s: number) => `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
export const MIN_SIGNER_LAMPORTS = 5_000_000n; // 0.005 SOL: below this a fee spike or two would strand the wallet

export function pauseBitsText(bits: number): string {
  if (bits === 0) return "0 (nothing paused = unpause)";
  const names = Object.entries(PAUSE).filter(([, v]) => (bits & v) !== 0).map(([k]) => k);
  return `${bits} (${names.join(" + ")})`;
}

/** Parse `--bits`: a number (0 … 31) or names `launch,trade,claims,graduate,attest` / `all` / `none`. */
export function parsePauseBits(s: string): number {
  const t = s.trim().toLowerCase();
  if (t === "none") return 0;
  if (t === "all") return PAUSE_ALL;
  if (/^\d+$/.test(t)) {
    const n = Number(t);
    if (n > PAUSE_ALL) throw new ProposalRefused(`pause bits ${n} > ${PAUSE_ALL} (launch 1, trade 2, claims 4, graduate 8, attest 16)`);
    return n;
  }
  let bits = 0;
  for (const name of t.split(",").map((x) => x.trim())) {
    const v = (PAUSE as Record<string, number>)[name];
    if (v === undefined) throw new ProposalRefused(`unknown pause flag ${name} (${Object.keys(PAUSE).join(", ")}, all, none, or a number)`);
    bits |= v;
  }
  return bits;
}

function labelFor(k: string, signer: string, g: GlobalAccount | null, extra: Record<string, string>): string {
  if (k === signer) return "YOUR WALLET (signer + fee payer)";
  if (k === globalPda().toBase58()) return "FUMPAD Global (state)";
  if (k === eventAuthorityPda().toBase58()) return "FUMPAD event authority (PDA)";
  if (k === FUMPAD_PROGRAM_ID.toBase58()) return "FUMPAD program";
  if (extra[k]) return extra[k];
  if (g && k === g.admin.toBase58()) return "current admin";
  return "account";
}

/** Build + validate + simulate one admin action. Throws ProposalRefused with the reason. */
export async function buildProposal(o: BuildOpts, chain: AdminChain, log: (s: string) => void = () => {}): Promise<Proposal> {
  if (!PROPOSAL_ACTIONS.includes(o.action)) refuse(`unsupported action ${JSON.stringify(o.action)} (${PROPOSAL_ACTIONS.join(" | ")})`);
  if (!PublicKey.isOnCurve(o.signer.toBytes())) refuse(`signer ${o.signer.toBase58()} is off-curve: a PDA / multisig vault can't sign in a wallet app`);
  const signer = o.signer.toBase58();
  const g = await chain.global();
  const now = await chain.now();
  const values: { label: string; value: string }[] = [];
  const extra: Record<string, string> = {};
  let title = "";
  let summary: string[] = [];
  let signerRole = "";
  let ixs: ProposalIx[] = [];
  const needGlobal = () => g ?? refuse(`no FUMPAD Global at ${globalPda().toBase58()} on this cluster (wrong program id or not initialized)`);
  const isAdmin = !!g && g.admin.equals(o.signer);
  const isGuardian = !!g && g.guardian.equals(o.signer);
  const adminOrGuardian = () => {
    const gg = needGlobal();
    if (!isAdmin && !isGuardian) refuse(`wrong signer: ${signer} is neither the admin (${gg.admin.toBase58()}) nor the guardian (${gg.guardian.toBase58()})`);
    return isAdmin && isGuardian ? "admin + guardian" : isAdmin ? "admin" : "guardian";
  };

  switch (o.action) {
    case "accept-admin": {
      const gg = needGlobal();
      if (gg.admin.equals(o.signer)) refuse(`${signer} is already the admin (nothing to accept)`);
      if (gg.pendingAdminEta === 0n) refuse("no pending propose_admin (bootstrap --step propose-admin first)");
      if (!gg.pendingAdmin.equals(o.signer)) refuse(`wrong signer: the pending admin is ${gg.pendingAdmin.toBase58()}, not ${signer}`);
      if (BigInt(now) < gg.pendingAdminEta) refuse(`eta not reached: accept_admin is possible from ${iso(gg.pendingAdminEta)} (chain time now ${iso(now)}, ${dur(Number(gg.pendingAdminEta) - now)} to go)`);
      signerRole = "pending admin";
      title = "Accept the FUMPAD admin role";
      summary = [
        `Your wallet ${signer} becomes the FUMPAD admin (replacing ${gg.admin.toBase58()}).`,
        `The guardian becomes ${gg.pendingGuardian.toBase58()}${gg.pendingGuardian.equals(o.signer) ? " (also your wallet)" : ""}.`,
        `The platform treasury becomes ${gg.pendingTreasury.toBase58()}.`,
        "After this, every admin action (params, keepers, configs, upgrades of Global) needs this wallet.",
      ];
      values.push(
        { label: "current admin", value: gg.admin.toBase58() },
        { label: "new admin", value: gg.pendingAdmin.toBase58() },
        { label: "new guardian", value: gg.pendingGuardian.toBase58() },
        { label: "new platform treasury", value: gg.pendingTreasury.toBase58() },
        { label: "eta (passed)", value: iso(gg.pendingAdminEta) },
      );
      ixs = [ixToJson(acceptAdminIx(o.signer))];
      break;
    }
    case "set-pause": {
      const gg = needGlobal();
      const bits = o.pauseBits ?? refuse("set-pause needs --bits (0 = unpause / harmless drill; launch,trade,claims,graduate,attest; all)");
      if (!Number.isInteger(bits) || bits < 0 || (bits & ~PAUSE_ALL) !== 0) refuse(`pause bits ${bits} invalid (0 … ${PAUSE_ALL})`);
      signerRole = adminOrGuardian();
      const live = gg.paused !== 0 && BigInt(now) < gg.pauseExpiresAt;
      title = bits === 0 ? (live ? "UNPAUSE FUMPAD" : "Guardian drill: set_pause(0) (no effect)") : `PAUSE FUMPAD: ${pauseBitsText(bits)}`;
      summary =
        bits === 0
          ? live
            ? [`Clears the pause (currently ${pauseBitsText(gg.paused)} until ${iso(gg.pauseExpiresAt)}). Everything runs again immediately.`]
            : ["Nothing is paused now, so this changes nothing: a harmless drill proving the guardian wallet can sign.", "Emits a PauseSet event on chain."]
          : [
              `Immediately stops: ${pauseBitsText(bits)}.`,
              `The pause lapses by itself after ${MAX_PAUSE_SECS / 86_400} days (≈ ${iso(now + MAX_PAUSE_SECS)}) unless renewed; set_pause(0) lifts it.`,
              live ? `Replaces the current pause ${pauseBitsText(gg.paused)} (until ${iso(gg.pauseExpiresAt)}).` : "Nothing is paused now.",
            ];
      values.push({ label: "new pause bits", value: pauseBitsText(bits) }, { label: "current pause bits", value: live ? `${pauseBitsText(gg.paused)} until ${iso(gg.pauseExpiresAt)}` : "none" }, { label: "signing as", value: signerRole });
      ixs = [ixToJson(setPauseIx(o.signer, bits))];
      break;
    }
    case "cancel-admin": {
      const gg = needGlobal();
      signerRole = adminOrGuardian();
      if (gg.pendingAdminEta === 0n) refuse("no pending propose_admin to cancel");
      title = "Cancel the pending admin handover";
      summary = [
        `Cancels propose_admin(new admin ${gg.pendingAdmin.toBase58()}, guardian ${gg.pendingGuardian.toBase58()}, treasury ${gg.pendingTreasury.toBase58()}).`,
        `The admin stays ${gg.admin.toBase58()}; a new propose_admin restarts the 6 h timelock.`,
      ];
      values.push({ label: "pending admin (cancelled)", value: gg.pendingAdmin.toBase58() }, { label: "pending eta", value: iso(gg.pendingAdminEta) }, { label: "signing as", value: signerRole });
      ixs = [ixToJson(cancelAdminIx(o.signer))];
      break;
    }
    case "queue-config-remove": {
      const gg = needGlobal();
      const config = o.config ?? refuse("queue-config-remove needs the config (--config-account, or --config with dbc-config-first-coin.json next to it)");
      if (!isAdmin) refuse(`wrong signer: queue_config needs the admin (${gg.admin.toBase58()}), not ${signer}`);
      const slot = configSlot(gg, config) ?? refuse(`${config.toBase58()} is not on the allow-list (already removed?)`);
      if (gg.pendingConfigEta !== 0n) refuse(`another config change is pending (${gg.pendingConfig.toBase58()} ${gg.pendingConfigAdd ? "add" : "remove"}, eta ${iso(gg.pendingConfigEta)}): execute or cancel it first`);
      signerRole = "admin";
      extra[config.toBase58()] = "DBC config being removed";
      const policy = slot.policy.kind === FEE_POLICY.walletSplit ? `wallet-split → ${slot.policy.wallet.toBase58()} (max ${slot.policy.maxCoins} coin(s))` : "standard";
      title = "Queue removal of a launch config from the allow-list";
      summary = [
        `Queues removing DBC config ${config.toBase58()} (allow-list slot ${slot.index}, ${policy}, ${slot.coins} coin(s) launched on it).`,
        `After the ${CONFIG_TIMELOCK_SECS / 3600} h config timelock (≈ ${iso(now + CONFIG_TIMELOCK_SECS)}) anyone executes it: bootstrap --step remove-first-coin-config (execute_config, permissionless).`,
        "Coins already launched on it keep their fee policy; no new coin can launch on it once executed.",
      ];
      if (slot.coins === 0) summary.push("WARNING: no coin has launched on this config yet.");
      values.push({ label: "config", value: config.toBase58() }, { label: "slot / policy / coins", value: `${slot.index} / ${policy} / ${slot.coins}` }, { label: "executable after ≈", value: iso(now + CONFIG_TIMELOCK_SECS) });
      ixs = [ixToJson(queueConfigIx(o.signer, config, false))];
      break;
    }
    case "ix-json": {
      if (!o.ixs?.length) refuse("ix-json needs --ix-json <file> with {programId, keys, data(base64)} or a list of them");
      if (!o.title?.trim()) refuse("ix-json needs --title (what this does, in words)");
      const p = instructionProblems(o.ixs, signer);
      if (p.length) refuse(`ix-json: ${p.join("; ")}`);
      signerRole = isAdmin && isGuardian ? "admin + guardian" : isAdmin ? "admin" : isGuardian ? "guardian" : "signer";
      title = o.title!;
      summary = o.summary?.length ? o.summary : ["Custom instruction(s) from --ix-json: check every account and the data below."];
      ixs = o.ixs!;
      ixs.forEach((ix, i) => values.push({ label: `instruction ${i} data (hex)`, value: Buffer.from(ix.data, "base64").toString("hex") }));
      break;
    }
  }
  if (o.title && o.action !== "ix-json") title = o.title;
  if (o.summary?.length && o.action !== "ix-json") summary = [...summary, ...o.summary];

  const bal = await chain.balance(o.signer);
  if (bal === 0n) refuse(`the wallet ${signer} has 0 SOL: it pays the fee, send it ~0.02 SOL first`);
  if (bal < MIN_SIGNER_LAMPORTS) refuse(`the wallet ${signer} has ${sol(bal)} SOL < ${sol(MIN_SIGNER_LAMPORTS)}: send it ~0.02 SOL first`);

  const cuPrice = o.computeUnitPriceMicroLamports ?? 20_000;
  const draft: Proposal = {
    version: PROPOSAL_VERSION,
    action: o.action,
    cluster: o.cluster,
    genesisHash: await chain.genesisHash(),
    programId: FUMPAD_PROGRAM_ID.toBase58(),
    signer,
    signerRole,
    title,
    summary,
    accounts: [],
    values,
    instructions: ixs,
    computeUnitLimit: 200_000,
    computeUnitPriceMicroLamports: cuPrice,
    maxFeeLamports: 0,
    createdAt: new Date().toISOString(),
    simulation: { unitsConsumed: null, logs: [] },
  };
  const seen = new Map<string, ProposalAccount>();
  for (const ix of ixs) {
    if (!seen.has(ix.programId)) seen.set(ix.programId, { label: labelFor(ix.programId, signer, g, extra) + " (program)", address: ix.programId, signer: false, writable: false });
    for (const k of ix.keys) {
      const cur = seen.get(k.pubkey) ?? { label: labelFor(k.pubkey, signer, g, extra), address: k.pubkey, signer: false, writable: false };
      cur.signer ||= k.isSigner;
      cur.writable ||= k.isWritable;
      seen.set(k.pubkey, cur);
    }
  }
  if (!seen.has(signer)) seen.set(signer, { label: labelFor(signer, signer, g, extra), address: signer, signer: true, writable: true });
  const fee = seen.get(signer)!;
  fee.signer = true;
  fee.writable = true;
  draft.accounts = [fee, ...[...seen.values()].filter((a) => a !== fee)];

  // simulate (wallet = signer + fee payer, sigVerify off) and refuse a failing action
  const sim = await chain.simulate(buildProposalTx(draft, await chain.latestBlockhash()));
  if (sim.err) {
    for (const l of sim.logs.slice(-15)) log(`  log: ${l}`);
    const anchor = sim.logs.map((l) => /Error Code: (\w+)\. Error Number: \d+\. Error Message: (.*)$/.exec(l)).find(Boolean);
    refuse(`simulation failed: ${JSON.stringify(sim.err)}${anchor ? ` — ${anchor[1]}: ${anchor[2]}` : ""} (nothing written)`);
  }
  draft.computeUnitLimit = o.computeUnitLimit ?? Math.max(30_000, Math.ceil((sim.unitsConsumed ?? 100_000) * 1.3) + 5_000);
  draft.maxFeeLamports = maxFeeLamports(draft.computeUnitLimit, cuPrice);
  draft.simulation = { unitsConsumed: sim.unitsConsumed, logs: sim.logs.slice(-20) };
  values.push({ label: "max network fee", value: `${sol(draft.maxFeeLamports)} SOL (CU limit ${draft.computeUnitLimit}, price ${cuPrice} µlamports/CU); wallet balance ${sol(bal)} SOL` });
  const problems = proposalProblems(draft);
  if (problems.length) refuse(`proposal invalid: ${problems.join("; ")}`);
  return draft;
}
