/**
 * D31 keeper attestations (INTERFACE-v0.7 §4): the exact fixed-width little-endian messages, the
 * Ed25519 precompile instruction that carries the keeper signatures, and the attest_sell /
 * attest_rebuy transaction pair. Must stay byte-identical to programs/fumpad/src/attestation.rs
 * (checked against contracts/tests/vectors/attestation.json).
 */
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

import {
  CLUSTER_TAG,
  ED25519_PROGRAM_ID,
  FUMPAD_PROGRAM_ID,
  REBUY_DOMAIN,
  REBUY_MESSAGE_LEN,
  SELL_DOMAIN,
  SELL_MESSAGE_LEN,
  VENUE_DAMM_BIT,
  VENUE_ROUTED_BIT,
} from "./constants.js";
import { ed25519Sign, ed25519Verify, sha256 } from "./hash.js";

export interface SellRecord {
  programId: PublicKey;
  clusterTag: number;
  mint: PublicKey;
  pool: PublicKey;
  /** bit0: 0 DBC, 1 DAMM v2; bit7: routed by the fumpad router. */
  venue: number;
  /** 64-byte tx signature */
  signature: Uint8Array;
  ixKey: number;
  trader: PublicKey;
  baseAmount: bigint;
  quoteGross: bigint;
  ticketTokens: bigint;
  ticketPriceQ64: bigint;
  usdCents: bigint;
  pythPublishTime: bigint;
  slot: bigint;
  blockTime: bigint;
}

export interface RebuyRecord {
  programId: PublicKey;
  clusterTag: number;
  mint: PublicKey;
  ticket: PublicKey;
  owner: PublicKey;
  signature: Uint8Array;
  ixKey: number;
  debitTokens: bigint;
  slot: bigint;
  blockTime: bigint;
}

export const venueByte = (venue: "dbc" | "damm_v2", routed: boolean): number => (venue === "damm_v2" ? VENUE_DAMM_BIT : 0) | (routed ? VENUE_ROUTED_BIT : 0);

/** Signature string (base58) ↔ 64 bytes. */
export function signatureBytes(sig: string | Uint8Array): Uint8Array {
  const b = typeof sig === "string" ? bs58.decode(sig) : sig;
  if (b.length !== 64) throw new Error(`signature must be 64 bytes, got ${b.length}`);
  return b;
}

class W {
  private readonly b: Uint8Array;
  private readonly v: DataView;
  private o = 0;
  constructor(n: number) {
    this.b = new Uint8Array(n);
    this.v = new DataView(this.b.buffer);
  }
  bytes(x: Uint8Array) {
    this.b.set(x, this.o);
    this.o += x.length;
    return this;
  }
  u8(x: number) {
    this.v.setUint8(this.o, x);
    this.o += 1;
    return this;
  }
  u32(x: number) {
    this.v.setUint32(this.o, x >>> 0, true);
    this.o += 4;
    return this;
  }
  u64(x: bigint) {
    this.v.setBigUint64(this.o, BigInt.asUintN(64, x), true);
    this.o += 8;
    return this;
  }
  i64(x: bigint) {
    this.v.setBigInt64(this.o, BigInt.asIntN(64, x), true);
    this.o += 8;
    return this;
  }
  u128(x: bigint) {
    this.u64(x & ((1n << 64n) - 1n));
    return this.u64(x >> 64n);
  }
  done(): Uint8Array {
    if (this.o !== this.b.length) throw new Error(`message is ${this.o} bytes, expected ${this.b.length}`);
    return this.b;
  }
}

class R {
  private o: number;
  private readonly v: DataView;
  constructor(private readonly b: Uint8Array, start: number) {
    this.o = start;
    this.v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  take(n: number) {
    const s = this.b.slice(this.o, this.o + n);
    this.o += n;
    return s;
  }
  pk = () => new PublicKey(this.take(32));
  u8 = () => this.v.getUint8(this.o++);
  u32() {
    const x = this.v.getUint32(this.o, true);
    this.o += 4;
    return x;
  }
  u64() {
    const x = this.v.getBigUint64(this.o, true);
    this.o += 8;
    return x;
  }
  i64() {
    const x = this.v.getBigInt64(this.o, true);
    this.o += 8;
    return x;
  }
  u128() {
    const lo = this.u64();
    return lo | (this.u64() << 64n);
  }
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export function encodeSellMessage(r: SellRecord): Uint8Array {
  if ((r.venue & ~(VENUE_DAMM_BIT | VENUE_ROUTED_BIT)) !== 0) throw new Error(`bad venue byte ${r.venue}`);
  return new W(SELL_MESSAGE_LEN)
    .bytes(SELL_DOMAIN)
    .bytes(r.programId.toBytes())
    .u8(r.clusterTag)
    .bytes(r.mint.toBytes())
    .bytes(r.pool.toBytes())
    .u8(r.venue)
    .bytes(signatureBytes(r.signature))
    .u32(r.ixKey)
    .bytes(r.trader.toBytes())
    .u64(r.baseAmount)
    .u64(r.quoteGross)
    .u64(r.ticketTokens)
    .u128(r.ticketPriceQ64)
    .u64(r.usdCents)
    .i64(r.pythPublishTime)
    .u64(r.slot)
    .i64(r.blockTime)
    .done();
}

export function decodeSellMessage(m: Uint8Array): SellRecord | null {
  if (m.length !== SELL_MESSAGE_LEN || !eq(m.subarray(0, SELL_DOMAIN.length), SELL_DOMAIN)) return null;
  const r = new R(m, SELL_DOMAIN.length);
  return {
    programId: r.pk(),
    clusterTag: r.u8(),
    mint: r.pk(),
    pool: r.pk(),
    venue: r.u8(),
    signature: r.take(64),
    ixKey: r.u32(),
    trader: r.pk(),
    baseAmount: r.u64(),
    quoteGross: r.u64(),
    ticketTokens: r.u64(),
    ticketPriceQ64: r.u128(),
    usdCents: r.u64(),
    pythPublishTime: r.i64(),
    slot: r.u64(),
    blockTime: r.i64(),
  };
}

export function encodeRebuyMessage(r: RebuyRecord): Uint8Array {
  return new W(REBUY_MESSAGE_LEN)
    .bytes(REBUY_DOMAIN)
    .bytes(r.programId.toBytes())
    .u8(r.clusterTag)
    .bytes(r.mint.toBytes())
    .bytes(r.ticket.toBytes())
    .bytes(r.owner.toBytes())
    .bytes(signatureBytes(r.signature))
    .u32(r.ixKey)
    .u64(r.debitTokens)
    .u64(r.slot)
    .i64(r.blockTime)
    .done();
}

export function decodeRebuyMessage(m: Uint8Array): RebuyRecord | null {
  if (m.length !== REBUY_MESSAGE_LEN || !eq(m.subarray(0, REBUY_DOMAIN.length), REBUY_DOMAIN)) return null;
  const r = new R(m, REBUY_DOMAIN.length);
  return {
    programId: r.pk(),
    clusterTag: r.u8(),
    mint: r.pk(),
    ticket: r.pk(),
    owner: r.pk(),
    signature: r.take(64),
    ixKey: r.u32(),
    debitTokens: r.u64(),
    slot: r.u64(),
    blockTime: r.i64(),
  };
}

/** sha256 of the message bytes (hex): the key keepers exchange signatures under. */
export function messageId(message: Uint8Array): string {
  return Array.from(sha256(message), (x) => x.toString(16).padStart(2, "0")).join("");
}

export interface KeeperSignature {
  /** keeper public key */
  keeper: PublicKey;
  /** 64-byte Ed25519 signature over the message */
  signature: Uint8Array;
}

export const signAttestation = (message: Uint8Array, secretKey: Uint8Array): Uint8Array => ed25519Sign(message, secretKey);
export const verifyAttestation = (message: Uint8Array, s: KeeperSignature): boolean => ed25519Verify(s.signature, message, s.keeper.toBytes());

const SAME_IX = 0xffff;
const OFFSETS_LEN = 14;

/**
 * Ed25519 precompile instruction data for N signatures over ONE message (INTERFACE §4.3): header,
 * offsets (all `*_instruction_index = 0xFFFF`), then `sig0 ‖ pk0 ‖ sig1 ‖ pk1 …`, then the message.
 */
export function ed25519InstructionData(message: Uint8Array, sigs: readonly KeeperSignature[]): Uint8Array {
  const n = sigs.length;
  if (n < 1 || n > 255) throw new Error("1..255 signatures");
  const headerLen = 2 + n * OFFSETS_LEN;
  const msgOff = headerLen + n * 96;
  const out = new Uint8Array(msgOff + message.length);
  const v = new DataView(out.buffer);
  out[0] = n;
  out[1] = 0;
  sigs.forEach((s, i) => {
    const sigOff = headerLen + i * 96;
    const pkOff = sigOff + 64;
    const o = 2 + i * OFFSETS_LEN;
    v.setUint16(o, sigOff, true);
    v.setUint16(o + 2, SAME_IX, true);
    v.setUint16(o + 4, pkOff, true);
    v.setUint16(o + 6, SAME_IX, true);
    v.setUint16(o + 8, msgOff, true);
    v.setUint16(o + 10, message.length, true);
    v.setUint16(o + 12, SAME_IX, true);
    if (s.signature.length !== 64) throw new Error("signature must be 64 bytes");
    out.set(s.signature, sigOff);
    out.set(s.keeper.toBytes(), pkOff);
  });
  out.set(message, msgOff);
  return out;
}

export function ed25519Instruction(message: Uint8Array, sigs: readonly KeeperSignature[]): TransactionInstruction {
  return new TransactionInstruction({ programId: ED25519_PROGRAM_ID, keys: [], data: Buffer.from(ed25519InstructionData(message, sigs)) });
}

/** Parse Ed25519 instruction data back into (message, signers); null if entries don't all sign one in-ix message. */
export function parseEd25519InstructionData(data: Uint8Array): { message: Uint8Array; signatures: KeeperSignature[] } | null {
  if (data.length < 2) return null;
  const n = data[0];
  if (n === 0 || data.length < 2 + n * OFFSETS_LEN) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let message: Uint8Array | null = null;
  const signatures: KeeperSignature[] = [];
  for (let i = 0; i < n; i++) {
    const o = 2 + i * OFFSETS_LEN;
    const [sigOff, sigIx, pkOff, pkIx, msgOff, msgLen, msgIx] = [0, 2, 4, 6, 8, 10, 12].map((d) => v.getUint16(o + d, true));
    if (sigIx !== SAME_IX || pkIx !== SAME_IX || msgIx !== SAME_IX) return null;
    if (sigOff + 64 > data.length || pkOff + 32 > data.length || msgOff + msgLen > data.length) return null;
    const m = data.slice(msgOff, msgOff + msgLen);
    if (message && !eq(message, m)) return null;
    message = m;
    signatures.push({ keeper: new PublicKey(data.slice(pkOff, pkOff + 32)), signature: data.slice(sigOff, sigOff + 64) });
  }
  return message ? { message, signatures } : null;
}

/** Build a sell record from engine-style fields (strings / numbers) for the given program + cluster. */
export function sellRecord(a: {
  mint: PublicKey | string;
  pool: PublicKey | string;
  venue: "dbc" | "damm_v2";
  routed: boolean;
  signature: string | Uint8Array;
  ixKey: number;
  trader: PublicKey | string;
  baseAmount: bigint;
  quoteGross: bigint;
  ticketTokens: bigint;
  ticketPriceQ64: bigint;
  usdCents: bigint;
  pythPublishTime: bigint | number;
  slot: bigint | number;
  blockTime: bigint | number;
  clusterTag?: number;
  programId?: PublicKey;
}): SellRecord {
  const k = (x: PublicKey | string) => (typeof x === "string" ? new PublicKey(x) : x);
  return {
    programId: a.programId ?? FUMPAD_PROGRAM_ID,
    clusterTag: a.clusterTag ?? CLUSTER_TAG.mainnet,
    mint: k(a.mint),
    pool: k(a.pool),
    venue: venueByte(a.venue, a.routed),
    signature: signatureBytes(a.signature),
    ixKey: a.ixKey,
    trader: k(a.trader),
    baseAmount: a.baseAmount,
    quoteGross: a.quoteGross,
    ticketTokens: a.ticketTokens,
    ticketPriceQ64: a.ticketPriceQ64,
    usdCents: a.usdCents,
    pythPublishTime: BigInt(a.pythPublishTime),
    slot: BigInt(a.slot),
    blockTime: BigInt(a.blockTime),
  };
}
