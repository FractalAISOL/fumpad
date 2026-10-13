/**
 * Transaction normalisation. Accepts what `getTransaction` returns for
 *   - encoding "json"       (accountKeys: string[], compiled instructions with account indexes),
 *   - encoding "jsonParsed" (accountKeys: {pubkey, signer, …}[], instructions with base58 account
 *                            strings or a `parsed` body for known programs),
 *   - web3.js v1 objects    (staticAccountKeys / compiledInstructions / PublicKey values),
 * for legacy, version 0 (address lookup tables → meta.loadedAddresses) and version 1 messages
 * (no lookup tables; `transactionConfig` instead of compute-budget instructions).
 *
 * Output: one flat list of instructions in execution order (top-level instruction followed by its
 * inner instructions), each with its stack height, so CPI parents can be resolved exactly.
 */
import bs58 from "bs58";

type KeyLike = string | { toBase58(): string } | { pubkey: string | { toBase58(): string }; signer?: boolean };

interface RawIx {
  programIdIndex?: number;
  programId?: string | { toBase58(): string };
  accounts?: (number | string | { toBase58(): string })[];
  accountKeyIndexes?: number[];
  data?: string | Uint8Array;
  parsed?: unknown;
  stackHeight?: number | null;
}

export interface RawTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals?: number };
}

/** Structural type of a confirmed transaction (any of the encodings above). */
export interface ConfirmedTx {
  slot: number;
  blockTime?: number | null;
  version?: number | "legacy" | null;
  transaction: { signatures: string[]; message: unknown };
  meta: {
    err: unknown;
    fee?: number;
    innerInstructions?: { index: number; instructions: unknown[] }[] | null;
    loadedAddresses?: { writable: KeyLike[]; readonly: KeyLike[] } | null;
    preTokenBalances?: RawTokenBalance[] | null;
    postTokenBalances?: RawTokenBalance[] | null;
    preBalances?: number[];
    postBalances?: number[];
    logMessages?: string[] | null;
  } | null;
}

export interface FlatIx {
  /** Position in `flat` (execution order). */
  ordinal: number;
  /** Index of the top-level instruction this belongs to. */
  topIx: number;
  /** Index inside `meta.innerInstructions[topIx].instructions`, or -1 for the top-level instruction itself. */
  innerIx: number;
  /** 1 = top level, 2 = CPI from a top-level program, … */
  stackHeight: number;
  programId: string;
  /** Account pubkeys (base58), empty for an RPC-`parsed` instruction. */
  accounts: string[];
  /** Raw data, or null for an RPC-`parsed` instruction (system/token/…: never a Meteora instruction). */
  data: Uint8Array | null;
  /** Ordinal of the invoking instruction (null for top level). */
  parent: number | null;
}

export interface TokenBalanceEntry {
  account: string;
  mint: string;
  owner: string | null;
  pre: bigint | null;
  post: bigint | null;
}

export interface NormalizedTx {
  signature: string;
  slot: number;
  blockTime: number | null;
  version: number | "legacy";
  err: unknown;
  accountKeys: string[];
  signers: string[];
  feePayer: string;
  flat: FlatIx[];
  /** false when inner instructions lack `stackHeight` (very old RPC data): CPI parents unknown. */
  hasStackHeights: boolean;
  /** Token accounts with a pre and/or post balance, by address. */
  tokenBalances: Map<string, TokenBalanceEntry>;
  /** Lamport balance change per account key (post − pre). */
  lamportDeltas: Map<string, bigint>;
}

const b58 = (k: unknown): string => {
  if (typeof k === "string") return k;
  if (k && typeof k === "object") {
    if ("pubkey" in k) return b58((k as { pubkey: unknown }).pubkey);
    if ("toBase58" in k && typeof (k as { toBase58: unknown }).toBase58 === "function") return (k as { toBase58(): string }).toBase58();
  }
  throw new Error(`not a pubkey: ${JSON.stringify(k)}`);
};

export class TxShapeError extends Error {}

/** Normalise a confirmed transaction. Throws TxShapeError on a shape it can't read exactly. */
export function normalizeTx(tx: ConfirmedTx): NormalizedTx {
  if (!tx?.transaction || !tx.meta) throw new TxShapeError("transaction or meta missing");
  const m = tx.transaction.message as Record<string, unknown>;
  const rawKeys = (m.staticAccountKeys ?? m.accountKeys) as KeyLike[] | undefined;
  if (!Array.isArray(rawKeys)) throw new TxShapeError("message has no account keys");
  const parsedKeys = rawKeys.length > 0 && typeof rawKeys[0] === "object" && rawKeys[0] !== null && "pubkey" in rawKeys[0];
  const accountKeys = rawKeys.map(b58);
  // jsonParsed already lists lookup-table addresses in accountKeys (source: "lookupTable").
  if (!parsedKeys && tx.meta.loadedAddresses) {
    accountKeys.push(...tx.meta.loadedAddresses.writable.map(b58), ...tx.meta.loadedAddresses.readonly.map(b58));
  }

  let signers: string[];
  if (parsedKeys) signers = (rawKeys as { pubkey: KeyLike; signer?: boolean }[]).filter((k) => k.signer).map((k) => b58(k.pubkey));
  else {
    const header = m.header as { numRequiredSignatures?: number } | undefined;
    const n = header?.numRequiredSignatures ?? tx.transaction.signatures.length;
    signers = accountKeys.slice(0, n);
  }

  const resolveIx = (raw: unknown): Omit<FlatIx, "ordinal" | "topIx" | "innerIx" | "parent"> => {
    const r = raw as RawIx;
    const programId = r.programId !== undefined ? b58(r.programId) : accountKeys[r.programIdIndex ?? -1];
    if (!programId) throw new TxShapeError("instruction program id unresolvable");
    if (r.parsed !== undefined) return { programId, accounts: [], data: null, stackHeight: r.stackHeight ?? 0 };
    const accts = (r.accountKeyIndexes ?? r.accounts ?? []).map((a) => {
      if (typeof a === "number") {
        const k = accountKeys[a];
        if (k === undefined) throw new TxShapeError(`account index ${a} out of range`);
        return k;
      }
      return b58(a);
    });
    const data = r.data === undefined ? new Uint8Array() : typeof r.data === "string" ? bs58.decode(r.data) : Uint8Array.from(r.data);
    return { programId, accounts: accts, data, stackHeight: r.stackHeight ?? 0 };
  };

  const top = ((m.compiledInstructions ?? m.instructions) as unknown[]) ?? [];
  const innerByTop = new Map<number, unknown[]>();
  for (const g of tx.meta.innerInstructions ?? []) innerByTop.set(g.index, g.instructions);

  const flat: FlatIx[] = [];
  let hasStackHeights = true;
  top.forEach((rawTop, topIx) => {
    const t = resolveIx(rawTop);
    const topOrd = flat.length;
    flat.push({ ...t, stackHeight: 1, ordinal: topOrd, topIx, innerIx: -1, parent: null });
    // stack[h] = ordinal of the most recent instruction at height h
    const stack: number[] = [];
    stack[1] = topOrd;
    (innerByTop.get(topIx) ?? []).forEach((rawInner, innerIx) => {
      const ix = resolveIx(rawInner);
      let h = ix.stackHeight;
      if (!h) {
        hasStackHeights = false;
        h = 2; // unknown nesting; parent links are then not trusted (hasStackHeights=false)
      }
      const parent = stack[h - 1];
      if (parent === undefined) throw new TxShapeError(`inner instruction ${topIx}.${innerIx} at height ${h} has no parent`);
      const ordinal = flat.length;
      flat.push({ ...ix, stackHeight: h, ordinal, topIx, innerIx, parent });
      stack[h] = ordinal;
      stack.length = h + 1;
    });
  });

  const tokenBalances = new Map<string, TokenBalanceEntry>();
  const addBal = (list: RawTokenBalance[] | null | undefined, which: "pre" | "post") => {
    for (const b of list ?? []) {
      const account = accountKeys[b.accountIndex];
      if (!account) throw new TxShapeError(`token balance index ${b.accountIndex} out of range`);
      const e = tokenBalances.get(account) ?? { account, mint: b.mint, owner: b.owner ?? null, pre: null, post: null };
      if (e.mint !== b.mint) throw new TxShapeError(`token account ${account} changed mint`);
      e[which] = BigInt(b.uiTokenAmount.amount);
      if (!e.owner && b.owner) e.owner = b.owner;
      tokenBalances.set(account, e);
    }
  };
  addBal(tx.meta.preTokenBalances, "pre");
  addBal(tx.meta.postTokenBalances, "post");

  const lamportDeltas = new Map<string, bigint>();
  const pre = tx.meta.preBalances ?? [];
  const post = tx.meta.postBalances ?? [];
  for (let i = 0; i < Math.min(pre.length, post.length, accountKeys.length); i++) {
    const d = BigInt(post[i]) - BigInt(pre[i]);
    if (d !== 0n) lamportDeltas.set(accountKeys[i], (lamportDeltas.get(accountKeys[i]) ?? 0n) + d);
  }

  const v = tx.version;
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    version: v === undefined || v === null || v === "legacy" ? "legacy" : v,
    err: tx.meta.err ?? null,
    accountKeys,
    signers,
    feePayer: accountKeys[0],
    flat,
    hasStackHeights,
    tokenBalances,
    lamportDeltas,
  };
}

/** Ancestor chain of an instruction, outermost (top level) first, excluding itself. */
export function ancestors(tx: NormalizedTx, ordinal: number): FlatIx[] {
  const out: FlatIx[] = [];
  let p = tx.flat[ordinal].parent;
  while (p !== null) {
    out.unshift(tx.flat[p]);
    p = tx.flat[p].parent;
  }
  return out;
}

/** post − pre token amount of one token account (absent side = 0). */
export function tokenDelta(tx: NormalizedTx, account: string): bigint {
  const e = tx.tokenBalances.get(account);
  if (!e) return 0n;
  return (e.post ?? 0n) - (e.pre ?? 0n);
}

/** Net token change of `mint` per owner across the whole transaction (zero entries dropped). */
export function ownerDeltas(tx: NormalizedTx, mint: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const e of tx.tokenBalances.values()) {
    if (e.mint !== mint || !e.owner) continue;
    out.set(e.owner, (out.get(e.owner) ?? 0n) + (e.post ?? 0n) - (e.pre ?? 0n));
  }
  for (const [k, v] of out) if (v === 0n) out.delete(k);
  return out;
}
