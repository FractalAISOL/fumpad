/**
 * Token movements of pool vaults that are NOT made by the swaps being cross-checked (V7-H2): a donation
 * (`Transfer` / `TransferChecked` into the vault — token accounts accept transfers from anyone), the
 * pool program's own fee claims / migration / leftover withdrawals in the same tx, a launch `MintTo`,
 * and `SyncNative` on a WSOL vault. The vault cross-check adds them to what the swap events imply, so
 * these never turn an authentic swap into an issue.
 */
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "./constants.js";
import type { FlatIx, NormalizedTx } from "./tx.js";

const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]);

export interface TokenMovement {
  from?: string;
  to?: string;
  /** Leaves `from`. */
  amount: bigint;
  /** Arrives at `to` (amount − Token-2022 transfer fee). */
  received: bigint;
  /** SyncNative target. */
  sync?: string;
}

const u64At = (d: Uint8Array, o: number): bigint | null => {
  if (d.length < o + 8) return null;
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]);
  return v;
};

const mv = (from: string | undefined, to: string | undefined, amount: bigint, received = amount): TokenMovement => ({ from, to, amount, received });

/**
 * One SPL Token / Token-2022 instruction as a balance movement (raw `json` or `jsonParsed` encoding).
 * null = moves no balance (or isn't a token instruction); "unknown" = a movement we can't read exactly.
 */
export function tokenMovement(ix: FlatIx): TokenMovement | "unknown" | null {
  if (!TOKEN_PROGRAMS.has(ix.programId)) return null;
  if (ix.data === null) {
    const p = ix.parsed as { type?: string; info?: Record<string, unknown> } | undefined;
    const info = p?.info ?? {};
    const big = (v: unknown): bigint | null => (typeof v === "string" || typeof v === "number" ? BigInt(v) : null);
    const amt = big(info.amount ?? (info.tokenAmount as { amount?: unknown } | undefined)?.amount);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    switch (p?.type) {
      case "transfer":
      case "transferChecked":
        return amt === null ? "unknown" : mv(str(info.source), str(info.destination), amt);
      case "transferCheckedWithFee": {
        const fee = big((info.feeAmount as { amount?: unknown } | undefined)?.amount);
        return amt === null || fee === null ? "unknown" : mv(str(info.source), str(info.destination), amt, amt - fee);
      }
      case "mintTo":
      case "mintToChecked":
        return amt === null ? "unknown" : mv(undefined, str(info.account), amt);
      case "burn":
      case "burnChecked":
        return amt === null ? "unknown" : mv(str(info.account), undefined, amt);
      case "syncNative":
        return { amount: 0n, received: 0n, sync: str(info.account) };
      default:
        return null;
    }
  }
  const d = ix.data;
  const acc = ix.accounts;
  const a = u64At(d, 1);
  switch (d[0]) {
    case 3: // Transfer [source, destination, authority]
      return a === null || acc.length < 2 ? "unknown" : mv(acc[0], acc[1], a);
    case 12: // TransferChecked [source, mint, destination, authority]
      return a === null || acc.length < 3 ? "unknown" : mv(acc[0], acc[2], a);
    case 7: // MintTo [mint, destination, authority]
    case 14:
      return a === null || acc.length < 2 ? "unknown" : mv(undefined, acc[1], a);
    case 8: // Burn [account, mint, authority]
    case 15:
      return a === null || acc.length < 1 ? "unknown" : mv(acc[0], undefined, a);
    case 17: // SyncNative [account]
      return acc.length < 1 ? "unknown" : { amount: 0n, received: 0n, sync: acc[0] };
    case 26: {
      // TransferFeeExtension; 1 = TransferCheckedWithFee [source, mint, destination, authority]
      if (d[1] !== 1) return null;
      const amount = u64At(d, 2);
      const fee = u64At(d, 11);
      return amount === null || fee === null || acc.length < 3 ? "unknown" : mv(acc[0], acc[2], amount, amount - fee);
    }
    default:
      return null;
  }
}

export interface ForeignFlow {
  /** Net movement of the vault by instructions outside the counted swaps. */
  delta: bigint;
  /** A SyncNative targeted the vault (WSOL: its amount may grow by lamports sent with plain system transfers). */
  synced: boolean;
  /** A token instruction listing the vault couldn't be read exactly. */
  unknown: boolean;
}

/** Movements of `vaults` by token instructions that are not (descendants of) `swapOrdinals`. */
export function foreignVaultFlows(tx: NormalizedTx, vaults: ReadonlySet<string>, swapOrdinals: ReadonlySet<number>): Map<string, ForeignFlow> {
  const out = new Map<string, ForeignFlow>();
  const get = (v: string) => {
    let x = out.get(v);
    if (!x) {
      x = { delta: 0n, synced: false, unknown: false };
      out.set(v, x);
    }
    return x;
  };
  const insideSwap = (ix: FlatIx) => {
    for (let p: number | null = ix.ordinal; p !== null; p = tx.flat[p].parent) if (swapOrdinals.has(p)) return true;
    return false;
  };
  for (const ix of tx.flat) {
    if (!TOKEN_PROGRAMS.has(ix.programId) || insideSwap(ix)) continue;
    const m = tokenMovement(ix);
    if (m === null) continue;
    if (m === "unknown") {
      for (const acc of ix.accounts) if (vaults.has(acc)) get(acc).unknown = true;
      continue;
    }
    if (m.from && vaults.has(m.from)) get(m.from).delta -= m.amount;
    if (m.to && vaults.has(m.to)) get(m.to).delta += m.received;
    if (m.sync && vaults.has(m.sync)) get(m.sync).synced = true;
  }
  return out;
}
