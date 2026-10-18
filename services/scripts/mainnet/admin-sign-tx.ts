/**
 * Admin signing page (single-wallet admin, user decision 2026-10-18): the proposal format + the transaction rules
 * shared by the CLI (admin-sign.ts), the local server (admin-sign-server.ts) and the browser page
 * (admin-sign-page/page.ts). Browser-safe: depends on @solana/web3.js + buffer only (never @fumpad/sdk, never a key).
 *
 * A proposal is a JSON file with NO secrets: what one admin action does, in words and in bytes. The wallet that must
 * sign it is also the fee payer; the page rebuilds the transaction with a fresh blockhash at click time.
 */
import { Buffer } from "buffer";

import { ComputeBudgetProgram, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";

export const PROPOSAL_VERSION = 1;
export type ProposalCluster = "mainnet" | "devnet" | "testnet" | "local";
export const PROPOSAL_ACTIONS = ["accept-admin", "set-pause", "queue-config-remove", "cancel-admin", "ix-json"] as const;
export type ProposalAction = (typeof PROPOSAL_ACTIONS)[number];

export interface ProposalKey {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}
export interface ProposalIx {
  programId: string;
  keys: ProposalKey[];
  /** instruction data, base64 */
  data: string;
}
export interface ProposalAccount {
  label: string;
  address: string;
  signer: boolean;
  writable: boolean;
}
export interface Proposal {
  version: number;
  action: ProposalAction;
  cluster: ProposalCluster;
  /** the RPC's genesis hash when the proposal was built: the server refuses an RPC serving another chain */
  genesisHash: string;
  /** the FUMPAD program id */
  programId: string;
  /** the wallet that must sign AND pays the fee */
  signer: string;
  /** what the signer is in FUMPAD terms (e.g. "admin", "guardian", "pending admin") */
  signerRole: string;
  title: string;
  /** one sentence per line, shown big on the page */
  summary: string[];
  /** every account the instruction(s) touch, labelled */
  accounts: ProposalAccount[];
  /** labelled values (pause bits, eta, config, …) */
  values: { label: string; value: string }[];
  instructions: ProposalIx[];
  computeUnitLimit: number;
  computeUnitPriceMicroLamports: number;
  /** max network fee in lamports (5,000 per signature + CU limit × CU price) */
  maxFeeLamports: number;
  createdAt: string;
  /** the CLI's simulation (admin as signer, sigVerify off) */
  simulation: { unitsConsumed: number | null; logs: string[] };
}

export const COMPUTE_BUDGET_ID = ComputeBudgetProgram.programId.toBase58();
const MAX_CU = 1_400_000;
const MAX_CU_PRICE = 10_000_000; // 10 lamports per CU: anything above is a typo
export const SIGNATURE_FEE = 5_000;

export const b64 = {
  encode: (b: Uint8Array) => Buffer.from(b).toString("base64"),
  decode: (s: string) => new Uint8Array(Buffer.from(s, "base64")),
};

export const ixToJson = (ix: TransactionInstruction): ProposalIx => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: b64.encode(ix.data),
});
export const ixFromJson = (j: ProposalIx): TransactionInstruction =>
  new TransactionInstruction({
    programId: new PublicKey(j.programId),
    keys: j.keys.map((k) => ({ pubkey: new PublicKey(k.pubkey), isSigner: k.isSigner, isWritable: k.isWritable })),
    data: Buffer.from(b64.decode(j.data)),
  });

const isPk = (s: unknown): s is string => {
  if (typeof s !== "string") return false;
  try {
    return new PublicKey(s).toBase58() === s;
  } catch {
    return false;
  }
};

/** Problems with the instruction list alone: well-formed, and the only signer anywhere is `signer`. */
export function instructionProblems(ixs: unknown, signer: string): string[] {
  const p: string[] = [];
  if (!Array.isArray(ixs) || ixs.length === 0) return ["instructions: at least one required"];
  if (ixs.length > 4) p.push("instructions: at most 4 (one admin action per proposal)");
  ixs.forEach((raw, i) => {
    const ix = raw as Partial<ProposalIx>;
    if (!isPk(ix?.programId)) p.push(`instructions[${i}].programId: not a public key`);
    if (ix?.programId === COMPUTE_BUDGET_ID) p.push(`instructions[${i}]: compute-budget instructions come from computeUnitLimit / computeUnitPriceMicroLamports`);
    if (typeof ix?.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(ix.data)) p.push(`instructions[${i}].data: not base64`);
    if (!Array.isArray(ix?.keys)) {
      p.push(`instructions[${i}].keys: missing`);
      return;
    }
    ix.keys.forEach((k, j) => {
      if (!isPk(k?.pubkey) || typeof k.isSigner !== "boolean" || typeof k.isWritable !== "boolean") p.push(`instructions[${i}].keys[${j}]: {pubkey, isSigner, isWritable} required`);
      else if (k.isSigner && k.pubkey !== signer) p.push(`instructions[${i}].keys[${j}]: ${k.pubkey} must sign, but the wallet can only sign as ${signer}`);
    });
  });
  return p;
}

/** Structural validation of a proposal file (the server and the page refuse anything with problems). */
export function proposalProblems(raw: unknown): string[] {
  const x = raw as Partial<Proposal> | null;
  if (!x || typeof x !== "object") return ["not a JSON object"];
  const p: string[] = [];
  if (x.version !== PROPOSAL_VERSION) p.push(`version must be ${PROPOSAL_VERSION}`);
  if (!PROPOSAL_ACTIONS.includes(x.action as ProposalAction)) p.push(`unsupported action ${JSON.stringify(x.action)} (${PROPOSAL_ACTIONS.join(" | ")})`);
  if (!["mainnet", "devnet", "testnet", "local"].includes(x.cluster as string)) p.push("cluster must be mainnet | devnet | testnet | local");
  if (typeof x.genesisHash !== "string" || !x.genesisHash) p.push("genesisHash missing");
  if (!isPk(x.programId)) p.push("programId: not a public key");
  if (!isPk(x.signer)) p.push("signer: not a public key");
  else if (!PublicKey.isOnCurve(new PublicKey(x.signer).toBytes())) p.push("signer is off-curve (a PDA / multisig vault can't sign in a wallet app)");
  if (typeof x.title !== "string" || !x.title.trim()) p.push("title missing");
  if (!Array.isArray(x.summary) || !x.summary.every((s) => typeof s === "string")) p.push("summary must be a list of strings");
  if (!Array.isArray(x.accounts)) p.push("accounts missing");
  if (!Array.isArray(x.values)) p.push("values missing");
  if (!Number.isInteger(x.computeUnitLimit) || x.computeUnitLimit! < 1_000 || x.computeUnitLimit! > MAX_CU) p.push(`computeUnitLimit must be 1,000 … ${MAX_CU}`);
  if (!Number.isInteger(x.computeUnitPriceMicroLamports) || x.computeUnitPriceMicroLamports! < 0 || x.computeUnitPriceMicroLamports! > MAX_CU_PRICE) p.push(`computeUnitPriceMicroLamports must be 0 … ${MAX_CU_PRICE}`);
  if (isPk(x.signer)) p.push(...instructionProblems(x.instructions, x.signer));
  return p;
}

export const maxFeeLamports = (cuLimit: number, cuPrice: number) => SIGNATURE_FEE + Math.ceil((cuLimit * cuPrice) / 1_000_000);

/** The transaction the wallet signs: legacy (every wallet + Ledger supports it), fee payer = the signer. */
export function buildProposalTx(p: Proposal, recentBlockhash: string): Transaction {
  const tx = new Transaction({ feePayer: new PublicKey(p.signer), recentBlockhash });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: p.computeUnitLimit }));
  if (p.computeUnitPriceMicroLamports > 0) tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: p.computeUnitPriceMicroLamports }));
  for (const ix of p.instructions) tx.add(ixFromJson(ix));
  return tx;
}

/** Unsigned wire bytes (signature slots zeroed): what simulateTransaction / Wallet Standard take. */
export const unsignedWire = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false });

/**
 * A message merges each key's flags across instructions (and the fee payer is a writable signer), so a decoded
 * instruction carries the MESSAGE-level flags: compare against those, exactly (no extra writable / signer key).
 */
function sameIxs(got: TransactionInstruction[], p: Proposal): boolean {
  const writable = new Set([p.signer, ...p.instructions.flatMap((ix) => ix.keys.filter((k) => k.isWritable).map((k) => k.pubkey))]);
  const signer = new Set([p.signer, ...p.instructions.flatMap((ix) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey))]);
  return (
    got.length === p.instructions.length &&
    got.every((a, i) => {
      const b = p.instructions[i];
      return (
        a.programId.toBase58() === b.programId &&
        a.keys.length === b.keys.length &&
        a.keys.every((k, j) => {
          const pk = k.pubkey.toBase58();
          return pk === b.keys[j].pubkey && k.isWritable === writable.has(pk) && k.isSigner === signer.has(pk);
        }) &&
        b64.encode(a.data) === b.data
      );
    })
  );
}

/**
 * Problems with a SIGNED transaction about to be sent: fee payer = the signer, exactly one signature (the signer's,
 * valid), and its non-compute-budget instructions are exactly the proposal's (a wallet may add or change compute-budget
 * instructions; nothing else). Used by the page after the wallet signs and again by the server before forwarding.
 */
export function signedTxProblems(p: Proposal, signed: Transaction): string[] {
  const out: string[] = [];
  // judge the bytes that go on the wire (decoding gives message-level flags, whatever object we were handed)
  let tx: Transaction;
  try {
    tx = Transaction.from(signed.serialize({ requireAllSignatures: false, verifySignatures: false }));
  } catch (e) {
    return [`not a serializable transaction: ${(e as Error).message}`];
  }
  if (tx.feePayer?.toBase58() !== p.signer) out.push(`fee payer ${tx.feePayer?.toBase58() ?? "none"} ≠ the proposal's signer ${p.signer}`);
  if (tx.signatures.length !== 1 || tx.signatures[0].publicKey.toBase58() !== p.signer) out.push(`signers [${tx.signatures.map((s) => s.publicKey.toBase58()).join(", ")}] ≠ [${p.signer}]`);
  else if (!tx.signatures[0].signature) out.push("not signed");
  else {
    let ok = false;
    try {
      ok = tx.verifySignatures(true);
    } catch {
      ok = false;
    }
    if (!ok) out.push("signature does not verify");
  }
  const body = tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId));
  if (!sameIxs(body, p)) out.push("instructions differ from the proposal (the wallet or something else changed them)");
  return out;
}

export function explorerTxUrl(cluster: ProposalCluster, sig: string): string | null {
  if (cluster === "mainnet") return `https://solscan.io/tx/${sig}`;
  if (cluster === "devnet" || cluster === "testnet") return `https://solscan.io/tx/${sig}?cluster=${cluster}`;
  return null;
}

/** Wallet Standard chain id for the cluster. */
export const walletChain = (c: ProposalCluster) => (c === "mainnet" ? "solana:mainnet" : c === "local" ? "solana:localnet" : `solana:${c}`);

/** The JSON-RPC methods the local proxy forwards; everything else is refused. */
export const RPC_ALLOW = ["getLatestBlockhash", "simulateTransaction", "sendTransaction", "getSignatureStatuses", "getAccountInfo", "getBalance"] as const;
