/**
 * Historical layouts of fumpad v0.7 events and accounts on the SAME program id (devnet `5YMF…S9Fb`).
 *
 * Program upgrades only ever APPEND fields (to an event, to a struct inside one, or to an account), so an older
 * payload is a known, shorter prefix of the current one. Decoders accept exactly the byte lengths listed here: an
 * older payload is widened to the current layout (zero bytes inserted where the missing fields go), decoded with the
 * current IDL, and its missing fields are set to the documented defaults below — the values the older program
 * behaved as. Any other length is unknown or corrupt and throws `FumpadDecodeError` (fail closed): a keeper never
 * guesses. Every keeper runs the same table, so an old event decodes to the same record on all of them.
 *
 * Event history (contracts/programs/fumpad/src/events.rs; c9be557 = REVIEW-v0.7 fixes, cf79a59 = operators,
 * a3e9504 = fee policies 2026-10-14):
 *  - CoinRegistered      − fee_policy (a3e9504)             → standard policy (kind 0, shares 0, max 0, wallet default)
 *  - FeesClaimed         − to_wallet, fee_wallet (a3e9504)  → 0, default (standard coins pay no wallet)
 *  - ConfigQueued        − policy (a3e9504)                 → standard policy
 *  - ConfigUpdated       − policy (a3e9504)                 → standard policy
 *  - TicketAttested      − effective_at (c9be557, M-1)      → = ts (no rate-cap deferral existed: Ticket.attested_at = ts)
 *  - TicketVoided        − coin, reopened (c9be557, L3/L-2) → coin = coinPda(mint) (the ticket's coin: its mint is in
 *                                                             the event), reopened = false (no reopen existed)
 *  - GlobalInitialized / ParamsQueued / ParamsUpdated: Params without launch_signer (c9be557, Params 136 → 168 B; the
 *    field is inside the event, before eta / ts)        → launch_signer = default (no co-signer)
 * Seen on devnet (scripts/devnet/scan-layouts.ts, 2026-10-14): CoinRegistered 160 B, FeesClaimed 82 B, ConfigUpdated
 * 49 B; the c9be557 ones never reached this program id but are accepted the same way.
 *
 * Account history: Global 1,044 → 1,491 B (fee policies; `migrate_global` grows it, new bytes zero), Coin 546 B +
 * optional 47 B policy tail (a3e9504; size otherwise unchanged since v0.7: later fields were carved out of
 * `reserved`), Consumed 82 → 98 B (c9be557: + message_hash, zero for old markers = "no hash recorded"; old markers
 * are never kind 2). Ticket 276 B and Position 315 B never changed. Global before c9be557 (Params 136 B) never
 * existed on this program id (its GlobalInitialized already carries the 168 B Params).
 */
import type { Idl } from "@anchor-lang/core";

export class FumpadDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FumpadDecodeError";
  }
}

type IdlType = string | { array: [IdlType, number] } | { defined: { name: string } } | Record<string, unknown>;
type IdlField = { name: string; type: IdlType };
type IdlTypeDef = { name: string; type: { kind: string; fields?: IdlField[]; variants?: { name: string; fields?: unknown[] }[] } };

const PRIM: Record<string, number> = { bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, u64: 8, i64: 8, f64: 8, u128: 16, i128: 16, pubkey: 32 };

/** Borsh size of a fixed-size IDL type (throws on variable-size types: none in fumpad's events / accounts). */
export function idlTypeSize(idl: Idl, t: IdlType): number {
  if (typeof t === "string") {
    const n = PRIM[t];
    if (n === undefined) throw new Error(`variable-size IDL type ${t}`);
    return n;
  }
  if ("array" in t) {
    const [inner, len] = t.array as [IdlType, number];
    return idlTypeSize(idl, inner) * len;
  }
  if ("defined" in t) {
    const def = (idl.types as unknown as IdlTypeDef[] | undefined)?.find((x) => x.name === (t.defined as { name: string }).name);
    if (!def) throw new Error(`IDL type ${(t.defined as { name: string }).name} missing`);
    if (def.type.kind === "struct") return (def.type.fields ?? []).reduce((s, f) => s + idlTypeSize(idl, f.type), 0);
    if (def.type.kind === "enum" && (def.type.variants ?? []).every((v) => !v.fields?.length)) return 1;
    throw new Error(`variable-size IDL type ${def.name}`);
  }
  throw new Error(`variable-size IDL type ${JSON.stringify(t)}`);
}

export function idlStructFields(idl: Idl, name: string): IdlField[] {
  const def = (idl.types as unknown as IdlTypeDef[] | undefined)?.find((x) => x.name === name);
  if (!def?.type.fields) throw new Error(`IDL struct ${name} missing`);
  return def.type.fields;
}

/** One historical layout: the current payload minus `bytes` bytes at body offset `at` (after the 8-byte discriminator). */
export interface LegacyLayout {
  /** What the older program lacked (for errors / docs). */
  label: string;
  /** Byte offset (in the full payload, discriminator included) where the missing bytes belong. */
  at: number;
  bytes: number;
}

/** Insert `l.bytes` zero bytes at `l.at`: an older payload in the current layout. */
export function widen(data: Uint8Array, l: LegacyLayout): Uint8Array {
  const out = new Uint8Array(data.length + l.bytes);
  out.set(data.subarray(0, l.at), 0);
  out.set(data.subarray(l.at), l.at + l.bytes);
  return out;
}

/** Layout of a payload of `len` bytes for `name`: null = current, a LegacyLayout, or throw when unknown. */
export function pickLayout(kind: string, name: string, len: number, current: number, legacy: readonly LegacyLayout[]): LegacyLayout | null {
  if (len === current) return null;
  const l = legacy.find((x) => current - x.bytes === len);
  if (l) return l;
  const known = [current, ...legacy.map((x) => current - x.bytes)].join(" / ");
  throw new FumpadDecodeError(`${kind} ${name}: ${len} bytes matches no known layout (${known} bytes): unknown program version or corrupt data`);
}
