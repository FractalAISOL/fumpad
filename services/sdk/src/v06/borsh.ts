import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

export const bn = (v: bigint | number): BN => new BN(BigInt(v).toString());

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/**
 * Normalise an Anchor-decoded value: BN → bigint, snake_case → camelCase keys,
 * unit enums (`{ curve: {} }`) → `"curve"`. PublicKeys and byte arrays pass through.
 */
export function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (BN.isBN(v)) return BigInt((v as BN).toString());
  if (v instanceof PublicKey) return v;
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 1) {
      const [k, inner] = entries[0];
      if (inner && typeof inner === "object" && !Array.isArray(inner) && Object.keys(inner).length === 0 && !(inner instanceof PublicKey)) {
        return k.charAt(0).toLowerCase() + k.slice(1);
      }
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of entries) out[camel(k)] = normalize(val);
    return out;
  }
  return v;
}

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

/** camelCase + bigint → snake_case + BN, for encoding instruction args. */
export function toIdl(v: unknown): unknown {
  if (typeof v === "bigint") return bn(v);
  if (v instanceof PublicKey || v instanceof Uint8Array || BN.isBN(v)) return v;
  if (Array.isArray(v)) return v.map(toIdl);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[snake(k)] = toIdl(val);
    return out;
  }
  return v;
}

export function hexToBytes(hex: string): number[] {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}
export function bytesToHex(b: ArrayLike<number>): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
