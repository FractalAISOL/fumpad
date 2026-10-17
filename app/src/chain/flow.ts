/**
 * The live transaction pipeline, without React: build (`./build`) → vet + sign (`./signer`, the
 * silent-signing allow-list) → send → confirm, and the D18 launch (M-2 signed prepare → M-1
 * binding → sign → send). `./tx.ts` wraps these in hooks (status, on-screen confirms, toasts);
 * `scripts/local-app-e2e.ts` drives the same functions headless against the local stack, so what
 * the scripts prove is what the app runs.
 *
 * No React, no `@/` imports.
 */
import { type AddressLookupTableAccount, type Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { SilentPolicy } from "./allowlist";
import { LAUNCH_ALT_ADDRESS } from "./cluster";
import type { BuiltTx, FumpadClient, PreparedTrade } from "./build";
import { checkLaunchBinding, LAUNCH_SLIPPAGE_BPS } from "./launch";
import { dropLaunchAuth, getLaunchAuth, type LaunchAuth } from "./launchAuth";
import { type FumpadSigner, signFumpadTx, signLaunchMessage } from "./signer";

export type TxStage = "building" | "signing" | "confirming" | "done";

export class PrepareError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The API's machine-readable code, when it sent one (e.g. "launches_closed", `./launchGate`). */
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface PrepareArgs {
  name: string;
  symbol: string;
  uri: string;
  /** The creator's first buy, lamports (fee included); 0 = none. */
  initialBuyLamports: bigint;
  /** "first_coin": the one-off first-coin launch config (3% fee, contracts INTERFACE §5.9); default the standard one. */
  launchConfig?: "first_coin";
  /** The trading fee (bps) the review step showed: the launch is refused unless its config has exactly this fee. */
  expectedFeeBps?: number;
}

/** The config the API prepared the launch on, with its fees (POST /v1/launch/prepare `config`). */
export interface LaunchConfigInfo {
  kind: "standard" | "first_coin";
  dbcConfig: string;
  feeBps: number;
  snipeStartBps: number;
  snipeWindowSlots: number;
  migratedPoolFeeBps: number;
  feePolicy: { kind: number; buybackShareBps: number; walletShareBps: number; wallet: string | null; maxCoins: number; coinsRegistered: number };
}

export interface PrepareResult {
  mint: string;
  /** base64 v0 transaction, already signed by the mint. */
  transaction: string;
  lastValidBlockHeight: number;
  suffix: string;
  /** Absent from older APIs. */
  config?: LaunchConfigInfo;
}

/** The prepare body (M-2: with the creator's signed ownership message). */
export function prepareBody(creator: PublicKey, args: PrepareArgs, auth: LaunchAuth): Record<string, unknown> {
  return {
    creator: creator.toBase58(),
    name: args.name,
    symbol: args.symbol,
    uri: args.uri,
    initialBuyLamports: args.initialBuyLamports > BigInt(0) ? args.initialBuyLamports.toString() : undefined,
    slippageBps: LAUNCH_SLIPPAGE_BPS,
    ...(args.launchConfig ? { launchConfig: args.launchConfig } : {}),
    auth,
  };
}

/** A wallet's "user rejected" error, whatever the wallet calls it. */
export const rejected = (e: unknown) => /reject|denied|declin|cancel|closed/i.test(e instanceof Error ? e.message : String(e ?? ""));

export async function postPrepare(api: string, body: Record<string, unknown>): Promise<PrepareResult> {
  const res = await fetch(`${api}/v1/launch/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.status === 503 ? "No launch addresses are ready right now. Try again in a minute." : "Couldn't prepare the launch.";
    let code: string | undefined;
    try {
      const j = (await res.json()) as { error?: string; code?: string };
      const e = j.error;
      if (e && res.status < 500) msg = e.charAt(0).toUpperCase() + e.slice(1) + (/[.!?]$/.test(e) ? "" : ".");
      if (typeof j.code === "string") code = j.code;
    } catch {
      /* not json */
    }
    throw new PrepareError(res.status, msg, code);
  }
  return res.json();
}

/**
 * M-2: the prepare call with the creator's signed ownership message. The message is signed
 * once per (wallet, ticker) and reused while the API still accepts it (10 min); a cached one
 * the API refuses is dropped and signed again, once.
 */
export async function prepareLaunchSigned(
  api: string,
  s: FumpadSigner,
  args: PrepareArgs,
  instant: boolean,
  onStep: (step: "auth" | "reserve") => void = () => {},
): Promise<PrepareResult> {
  for (let attempt = 0; ; attempt++) {
    onStep("auth");
    let auth: LaunchAuth;
    let fresh: boolean;
    try {
      ({ auth, fresh } = await getLaunchAuth(s.publicKey, args.symbol, (m) => signLaunchMessage(s, m, instant)));
    } catch (e) {
      if (rejected(e)) throw new Error("You didn't confirm in your wallet, so nothing was reserved.");
      throw e;
    }
    onStep("reserve");
    try {
      return await postPrepare(api, prepareBody(s.publicKey, args, auth));
    } catch (e) {
      if (e instanceof PrepareError && e.status === 401) {
        dropLaunchAuth(s.publicKey.toBase58(), args.symbol);
        if (!fresh && attempt === 0) continue;
      }
      throw e;
    }
  }
}

export interface SendOpts {
  connection: Connection;
  client: FumpadClient;
  signer: FumpadSigner;
  /** Sign without a prompt (embedded wallet + Instant trading). */
  instant: boolean;
  /** Called with the built, unsigned transaction before anything is signed (the M-9/L-8 instant guard). */
  beforeSign?: (tx: VersionedTransaction) => Promise<void>;
  /** Called once the transaction is sent (instant spend bookkeeping). */
  onSent?: (signature: string) => void;
  onStage?: (stage: TxStage) => void;
  /** Error when the transaction lands but fails. */
  failed: string;
}

/** Build → vet + sign (silently when allowed) → send → confirm. Program errors surface from preflight. */
export async function sendBuilt(
  build: () => Promise<BuiltTx | PreparedTrade> | BuiltTx | PreparedTrade,
  policy: SilentPolicy,
  o: SendOpts,
): Promise<{ signature: string; tx: VersionedTransaction }> {
  o.onStage?.("building");
  const b = await build();
  let built: BuiltTx;
  if ("built" in b) {
    // A trade checked against the app's own quote (V7-M3) brings its own, tighter policy; it must
    // be for the same action and coin, and spend no more than the caller allows.
    const p = b.policy;
    const max = policy.maxSolInLamports;
    if (p.action !== policy.action || p.mint !== policy.mint || (max !== undefined && (p.maxSolInLamports === undefined || p.maxSolInLamports > max)))
      throw new Error("Refusing to sign: the trade doesn't match what you entered.");
    policy = p;
    built = b.built;
  } else built = b;
  const { tx, blockhash, lastValidBlockHeight } = await o.client.toTransaction(o.signer.publicKey, built);
  if (built.signers?.length) tx.sign(built.signers);
  await o.beforeSign?.(tx);
  o.onStage?.("signing");
  const signed = await signFumpadTx(o.signer, tx, policy, o.instant);
  o.onStage?.("confirming");
  const signature = await o.connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
  o.onSent?.(signature);
  const res = await o.connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(o.failed);
  o.onStage?.("done");
  return { signature, tx: signed };
}

/**
 * The configured launch lookup table (NEXT_PUBLIC_LAUNCH_ALT) from chain when `tx` uses a table, else undefined. Never
 * the table the transaction (or the API) names: a launch through any other table is refused by the allow-list.
 */
export async function launchLookupTable(connection: Pick<Connection, "getAddressLookupTable">, tx: VersionedTransaction, configured: string | undefined = LAUNCH_ALT_ADDRESS): Promise<AddressLookupTableAccount | undefined> {
  if (!tx.message.addressTableLookups.length) return undefined;
  if (!configured) throw new Error("Refusing to sign: the launch uses a lookup table and this app has none configured.");
  let table: AddressLookupTableAccount | null = null;
  try {
    table = (await connection.getAddressLookupTable(new PublicKey(configured), { commitment: "confirmed" })).value;
  } catch {
    throw new Error("Couldn't read FUMPAD's launch lookup table to check this launch. Try again.");
  }
  if (!table) throw new Error("Refusing to sign: FUMPAD's launch lookup table isn't on chain.");
  return table;
}

export interface PreparedTx {
  mint: string;
  suffix: string;
  transaction: string;
  lastValidBlockHeight: number;
  /** What the API says it prepared (re-checked on chain before signing). */
  config?: LaunchConfigInfo;
}

/**
 * D18 step 2: the wallet signs the API's launch as creator / fee payer and sends it. Checked twice
 * before signing: `checkLaunchBinding` (M-1: the reserved mint, the form's name/symbol/uri, the
 * first buy on that mint for exactly the amount typed with a real slippage bound, the mint's
 * signature; the curve read from chain, not from the API) and the silent-signing allow-list.
 */
export async function signAndSendLaunch(
  p: PreparedTx,
  args: PrepareArgs,
  o: Omit<SendOpts, "failed"> & { onSigning?: () => void; onConfirming?: () => void },
): Promise<{ signature: string; tx: VersionedTransaction }> {
  const s = o.signer;
  const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(p.transaction), (ch) => ch.charCodeAt(0)));
  // §8.1: the launch co-signer the program requires, from the chain's Global (not from the API).
  const launchSigner = await o.client.launchSigner();
  // The launch lookup table: OUR configured one (NEXT_PUBLIC_LAUNCH_ALT), read from chain; the allow-list refuses any
  // other table and checks this one's contents (exact launch accounts, frozen) before resolving the message.
  const lookupTable = await launchLookupTable(o.connection, tx);
  // §5.9: the first-coin config only when the user chose it AND the API says it prepared it (checked on chain next).
  let firstCoinConfig: string | undefined;
  if (args.launchConfig === "first_coin") {
    if (p.config?.kind !== "first_coin") throw new Error("Refusing to sign: the API didn't prepare the first-coin launch config you chose.");
    firstCoinConfig = p.config.dbcConfig;
  }
  await checkLaunchBinding(
    tx,
    {
      wallet: s.publicKey,
      mint: p.mint,
      suffix: p.suffix,
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      initialBuyLamports: args.initialBuyLamports,
      launchSigner,
      firstCoinConfig,
      expectedFeeBps: args.expectedFeeBps,
      lookupTable,
    },
    (config) => o.client.dbcConfig(config),
    (config) => o.client.configPolicy(config),
  );
  await o.beforeSign?.(tx);
  o.onSigning?.();
  // A wallet that rewrites the message would void the mint's signature: signFumpadTx refuses it.
  const signed = await signFumpadTx(s, tx, { action: "launch", mint: p.mint, coSigner: p.mint, maxSolInLamports: args.initialBuyLamports, launchSigner, lookupTable }, o.instant);
  o.onConfirming?.();
  const signature = await o.connection.sendRawTransaction(signed.serialize(), { maxRetries: 3 });
  o.onSent?.(signature);
  const res = await o.connection.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: p.lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error("The launch transaction failed on chain. Nothing but the network fee was spent.");
  return { signature, tx: signed };
}
