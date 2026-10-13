// Shared helpers for the FUMPAD x Meteora devnet spike.
// DEVNET ONLY. The RPC URL (with API key) is read from ~/fumpad-keys/devnet/rpc.env and never printed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  sendAndConfirmRawTransaction,
  TransactionInstruction,
  AddressLookupTableAccount,
} from "@solana/web3.js";

export const HOME = os.homedir();
export const SPIKE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
export const STATE_FILE = path.join(SPIKE_DIR, "state.json"); // public keys + signatures only
export const KEYS_DIR = path.join(SPIKE_DIR, ".keys"); // gitignored, spike-only throwaway keypairs

function readRpcUrl(): string {
  const txt = fs.readFileSync(path.join(HOME, "fumpad-keys/devnet/rpc.env"), "utf8");
  const m = txt.match(/^RPC_URL=(.+)$/m);
  if (!m) throw new Error("RPC_URL missing in rpc.env");
  const url = m[1].trim().replace(/^"|"$/g, "");
  if (!url.includes("devnet")) throw new Error("refusing: RPC_URL is not a devnet URL");
  return url;
}

export const RPC_URL = readRpcUrl();
export const connection = new Connection(RPC_URL, "confirmed");

export function redact(s: string): string {
  return s.replace(/api-key=[A-Za-z0-9-]+/g, "api-key=REDACTED");
}

export function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export const payer = loadKeypair(path.join(HOME, ".config/solana/id.json"));

/** Throwaway spike keypair, persisted under spike/meteora/.keys (gitignored). */
export function spikeKey(name: string): Keypair {
  fs.mkdirSync(KEYS_DIR, { recursive: true });
  const p = path.join(KEYS_DIR, `${name}.json`);
  if (fs.existsSync(p)) return loadKeypair(p);
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

export function loadState(): Record<string, any> {
  if (!fs.existsSync(STATE_FILE)) return {};
  return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
}
export function saveState(patch: Record<string, any>) {
  const s = loadState();
  Object.assign(s, patch);
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}
export function logTx(label: string, sig: string, extra: Record<string, any> = {}) {
  const s = loadState();
  s.txs = s.txs ?? [];
  s.txs.push({ label, sig, url: solscan(sig), ...extra });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  console.log(`[tx] ${label}: ${solscan(sig)}`, Object.keys(extra).length ? JSON.stringify(extra) : "");
}

export const solscan = (sig: string) => `https://solscan.io/tx/${sig}?cluster=devnet`;
export const solscanAcc = (a: PublicKey | string) => `https://solscan.io/account/${a.toString()}?cluster=devnet`;

/** Send a set of instructions as a v0 tx, return signature + CU consumed + logs. */
export async function send(
  label: string,
  ixs: TransactionInstruction[],
  signers: Keypair[],
  opts: { cuLimit?: number; luts?: AddressLookupTableAccount[]; skipPreflight?: boolean; feePayer?: Keypair } = {},
): Promise<{ sig: string; cu: number | null; logs: string[]; slot: number }> {
  const feePayer = opts.feePayer ?? payer;
  const all = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: opts.cuLimit ?? 1_400_000 }),
    ...ixs.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)),
  ];
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: feePayer.publicKey, recentBlockhash: blockhash, instructions: all }).compileToV0Message(opts.luts);
  const tx = new VersionedTransaction(msg);
  const uniq = new Map<string, Keypair>();
  for (const s of [feePayer, ...signers]) uniq.set(s.publicKey.toBase58(), s);
  tx.sign([...uniq.values()]);
  let sig: string;
  try {
    sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: opts.skipPreflight ?? false, maxRetries: 5 });
  } catch (e: any) {
    const logs = e?.logs ?? e?.transactionLogs ?? [];
    console.error(`[FAIL] ${label}:`, redact(String(e?.message ?? e)));
    if (logs.length) console.error(logs.join("\n"));
    throw e;
  }
  // poll (no websocket subscription)
  let err: any = null;
  for (let i = 0; ; i++) {
    const st = (await connection.getSignatureStatuses([sig])).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) { err = st.err; break; }
    if (i > 90) throw new Error(`timeout confirming ${label} ${sig} (lastValidBlockHeight ${lastValidBlockHeight})`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const info = await getTx(sig);
  const cu = info?.meta?.computeUnitsConsumed ?? null;
  const logs = info?.meta?.logMessages ?? [];
  if (err) {
    console.error(`[FAIL on-chain] ${label} ${solscan(sig)}`, JSON.stringify(err));
    console.error(logs.join("\n"));
    throw new Error(`tx failed: ${label}`);
  }
  logTx(label, sig, { cu, slot: info?.slot });
  return { sig, cu, logs, slot: info?.slot ?? 0 };
}

export async function getTx(sig: string) {
  for (let i = 0; i < 20; i++) {
    const t = await connection.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (t) return t;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}

export async function sendLegacy(label: string, tx: Transaction, signers: Keypair[]) {
  // For SDK-built legacy transactions: re-pack instructions into our v0 sender (adds CU limit, logs CU).
  return send(label, tx.instructions.filter((ix) => !ix.programId.equals(ComputeBudgetProgram.programId)), signers);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
export const DBC_PROGRAM = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
export const DAMM_V2_PROGRAM = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
