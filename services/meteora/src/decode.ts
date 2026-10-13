/**
 * IDL-driven decoding of Meteora `emit_cpi!` events and swap instruction args (Anchor BorshCoder over
 * the on-chain IDLs in ./idl). Strict: the body must be exactly one event in the IDL layout (Anchor's
 * decoder silently accepts trailing bytes and short u64 tails; re-encoding pins the length).
 */
import { BorshCoder, type Idl } from "@anchor-lang/core";
import BN from "bn.js";

import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, EVENT_IX_TAG } from "./constants.js";
import { DAMM_V2_IDL } from "./idl/damm_v2.idl.js";
import { DBC_IDL } from "./idl/dbc.idl.js";

export { DAMM_V2_IDL, DBC_IDL };
export type Venue = "dbc" | "damm_v2";

const coders: Partial<Record<Venue, BorshCoder>> = {};
export function coder(venue: Venue): BorshCoder {
  return (coders[venue] ??= new BorshCoder(venue === "dbc" ? DBC_IDL : DAMM_V2_IDL));
}
export const venueOf = (programId: string): Venue | null => (programId === DBC_PROGRAM_ID ? "dbc" : programId === DAMM_V2_PROGRAM_ID ? "damm_v2" : null);

const b64 = (d: Uint8Array) => Buffer.from(d).toString("base64");

export function startsWith(d: Uint8Array, prefix: ArrayLike<number>): boolean {
  if (d.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (d[i] !== prefix[i]) return false;
  return true;
}

/** BN → bigint, PublicKey → base58, recursively; keys keep the IDL's snake_case. */
export function plain(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "object") {
    const o = v as Record<string, unknown> & { toBase58?: () => string };
    if (typeof o.toBase58 === "function") return o.toBase58();
    if (BN.isBN(o)) return BigInt((o as unknown as BN).toString(10));
    if (Array.isArray(v)) return v.map(plain);
    if (v instanceof Uint8Array) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) out[k] = plain(x);
    return out;
  }
  return v;
}

export interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
  /** base64 of discriminator ‖ borsh body (re-decodable with `decodeEventRaw`). */
  raw: string;
}

export class EventDecodeError extends Error {}

/** Decode one event payload (bytes after EVENT_IX_TAG). null = not an event of this IDL subset. */
export function decodeEventPayload(venue: Venue, payload: Uint8Array): DecodedEvent | null {
  const c = coder(venue);
  const idlEvents = ((venue === "dbc" ? DBC_IDL : DAMM_V2_IDL) as unknown as { events: { name: string; discriminator: number[] }[] }).events;
  const known = idlEvents.find((e) => startsWith(payload, e.discriminator));
  if (!known) return null;
  let ev: { name: string; data: unknown } | null;
  try {
    ev = c.events.decode(b64(payload));
  } catch (e) {
    throw new EventDecodeError(`${venue} ${known.name}: ${(e as Error).message}`);
  }
  if (!ev) throw new EventDecodeError(`${venue} ${known.name}: decoder returned null`);
  const len = c.types.encode(ev.name, ev.data).length;
  if (len !== payload.length - 8) throw new EventDecodeError(`${venue} ${ev.name}: body is ${payload.length - 8} bytes, IDL layout needs ${len}`);
  return { name: ev.name, data: plain(ev.data) as Record<string, unknown>, raw: b64(payload) };
}

/** Re-decode a stored `raw` event. */
export function decodeEventRaw(venue: Venue, raw: string): DecodedEvent | null {
  return decodeEventPayload(venue, Uint8Array.from(Buffer.from(raw, "base64")));
}

/** If `data` is an emit_cpi self-invocation payload, the event bytes after the tag. */
export function eventPayload(data: Uint8Array | null): Uint8Array | null {
  if (!data || !startsWith(data, EVENT_IX_TAG)) return null;
  return data.subarray(8);
}

/** Name of the IDL instruction whose discriminator prefixes `data` (subset in ./idl), or null. */
export function instructionName(venue: Venue, data: Uint8Array | null): string | null {
  if (!data) return null;
  const ixs = ((venue === "dbc" ? DBC_IDL : DAMM_V2_IDL) as unknown as { instructions: { name: string; discriminator: number[] }[] }).instructions;
  return ixs.find((i) => startsWith(data, i.discriminator))?.name ?? null;
}

export type { Idl };
