// Regression: events / accounts written by EARLIER program versions on the same program id (layouts.ts). Real devnet
// payloads (vectors/devnet-*.json, captured read-only 2026-10-14) — the live failure was HAwjL35…'s 160-byte
// CoinRegistered (no fee_policy): "offset out of range … <= 151. Received 152" in every attestor / watcher tick.
import { readFileSync } from "node:fs";

import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  accountDiscriminator,
  bn,
  coinPda,
  decodeCoin,
  decodeConsumed,
  decodeEventRaw,
  decodeFumpadEvents,
  decodeGlobal,
  decodePosition,
  decodeTicket,
  eventLayouts,
  eventsNamed,
  FUMPAD_IDL,
  FumpadDecodeError,
  fumpadCoder,
  STANDARD_FEE_POLICY,
  type TxLike,
} from "../src/index.js";

const vec = (f: string) => JSON.parse(readFileSync(new URL(`./vectors/${f}`, import.meta.url), "utf8"));
const LAYOUTS = vec("devnet-event-layouts.json") as { events: Record<string, { len: number; raw: string; sig: string }[]> };
const COIN = vec("devnet-HAwjL35.json") as { mint: string; txs: { txIndex: number; events: string[]; tx: TxLike }[]; accounts: Record<string, string | null> };
const ALICE = "9zLVbFe9uSfwL9HzdVGX4T1UJfoG8DQD3rWdqpfTWcdN";
const BOB = "6uCk7vSeYyu7NYyg4EvFu6gaijPri2NcS8Sr22Kzu5E5";

const b = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x instanceof PublicKey ? x.toBase58() : x));
const sample = (name: string, len: number) => b(LAYOUTS.events[name].find((x) => x.len === len)!.raw);
const encodeType = (name: string, v: unknown): Uint8Array => {
  const layout = (fumpadCoder().types as unknown as { typeLayouts: Map<string, { encode(v: unknown, b: Buffer): number }> }).typeLayouts.get(name)!;
  const buf = Buffer.alloc(4096);
  return Uint8Array.from(buf.subarray(0, layout.encode(v, buf)));
};
const eventDisc = (name: string) =>
  Uint8Array.from((FUMPAD_IDL as unknown as { events: { name: string; discriminator: number[] }[] }).events.find((e) => e.name === name)!.discriminator);
const cat = (...p: Uint8Array[]) => Uint8Array.from(Buffer.concat(p.map((x) => Buffer.from(x))));

describe("historical event layouts (real devnet payloads)", () => {
  it("every payload the program ever emitted on devnet decodes", () => {
    for (const [name, list] of Object.entries(LAYOUTS.events)) for (const x of list) expect(decodeEventRaw(x.raw)?.name, `${name} ${x.len} B`).toBe(name);
  });

  it("devnet legacy layouts: CoinRegistered 160 B, FeesClaimed 82 B, ConfigUpdated 49 B → documented defaults", () => {
    const cr = decodeEventRaw(sample("CoinRegistered", 160))!.data;
    expect(json(cr.feePolicy)).toBe(json(STANDARD_FEE_POLICY));
    expect((cr.mint as PublicKey).toBase58()).toBe(COIN.mint);
    const fc = decodeEventRaw(sample("FeesClaimed", 82))!.data;
    expect(fc.toWallet).toBe(0n);
    expect((fc.feeWallet as PublicKey).equals(PublicKey.default)).toBe(true);
    expect(fc.toBuyback + "").toBe(fc.claimed + ""); // launch window → buyback, nothing elsewhere
    const cu = decodeEventRaw(sample("ConfigUpdated", 49))!.data;
    expect(json(cu.policy)).toBe(json(STANDARD_FEE_POLICY));
    // current layouts of the same events still decode their real trailing fields
    expect((decodeEventRaw(sample("CoinRegistered", 199))!.data.feePolicy as { kind: number }).kind).toBe(1);
    expect((decodeEventRaw(sample("ConfigUpdated", 88))!.data.policy as { walletShare: number }).walletShare).toBe(140);
  });

  it("an older payload decodes exactly like the current layout with zero trailing fields (all keepers agree)", () => {
    for (const [name, len] of [["CoinRegistered", 160], ["FeesClaimed", 82], ["ConfigUpdated", 49]] as const) {
      const old = sample(name, len);
      const cur = eventLayouts().get(name)!.current;
      expect(json(decodeEventRaw(old))).toBe(json(decodeEventRaw(cat(old, new Uint8Array(cur - len)))));
      expect(json(decodeEventRaw(old))).toBe(json(decodeEventRaw(Buffer.from(old).toString("base64")))); // raw string = bytes
    }
  });

  it("TicketAttested without effective_at (pre-M-1): effectiveAt = ts", () => {
    const cur = sample("TicketAttested", 398);
    const now = decodeEventRaw(cur)!.data;
    const old = decodeEventRaw(cur.subarray(0, 390))!.data;
    expect(old.effectiveAt).toBe(old.ts);
    expect(json({ ...old, effectiveAt: 0 })).toBe(json({ ...now, effectiveAt: 0 }));
  });

  it("TicketVoided without coin / reopened (pre-L3): coin = coinPda(mint), reopened = false", () => {
    const mint = Keypair.generate().publicKey;
    const body = encodeType("TicketVoided", { ticket: Keypair.generate().publicKey, mint, owner: Keypair.generate().publicKey, reason: 2, authority: Keypair.generate().publicKey, ts: bn(1_791_900_000n), coin: coinPda(mint), reopened: true });
    const full = cat(eventDisc("TicketVoided"), body);
    expect(full.length).toBe(eventLayouts().get("TicketVoided")!.current);
    const old = decodeEventRaw(full.subarray(0, full.length - 33))!.data;
    expect((old.coin as PublicKey).equals(coinPda(mint))).toBe(true);
    expect(old.reopened).toBe(false);
    expect(decodeEventRaw(full)!.data.reopened).toBe(true);
  });

  it("Params events without Params.launch_signer (pre-L1): launchSigner = default, eta / ts unshifted", () => {
    for (const [name, len] of [["ParamsUpdated", 184], ["ParamsQueued", 192], ["GlobalInitialized", 281]] as const) {
      const cur = sample(name, len);
      const at = eventLayouts().get(name)!.legacy[0].at;
      const old = cat(cur.subarray(0, at), cur.subarray(at + 32));
      const a = decodeEventRaw(cur)!.data;
      const o = decodeEventRaw(old)!.data;
      expect(((o.params as { launchSigner: PublicKey }).launchSigner).equals(PublicKey.default)).toBe(true);
      expect(json({ ...o, params: { ...(o.params as object), launchSigner: 0 } })).toBe(json({ ...a, params: { ...(a.params as object), launchSigner: 0 } }));
    }
  });

  it("fails closed on lengths matching no known layout", () => {
    const cr = sample("CoinRegistered", 160);
    for (const bad of [cr.subarray(0, 159), cat(cr, new Uint8Array(1)), cat(cr, new Uint8Array(40))]) expect(() => decodeEventRaw(bad)).toThrow(FumpadDecodeError);
    expect(() => decodeEventRaw(cr.subarray(0, 159))).toThrow(/CoinRegistered: 159 bytes matches no known layout \(199 \/ 160 bytes\)/);
    const rt = sample("RoutedTrade", 146);
    expect(() => decodeEventRaw(rt.subarray(0, 145))).toThrow(FumpadDecodeError);
  });
});

describe("devnet coin HAwjL35… (created before the fee-policy upgrade)", () => {
  it("decodes every fumpad event of its history, incl. its two earlier tickets (alice, bob)", () => {
    const names: string[] = [];
    const attested: { owner: string; ticket: string; effectiveAt: bigint; ts: bigint }[] = [];
    for (const { tx, events } of COIN.txs) {
      const evs = decodeFumpadEvents(tx);
      expect(evs.map((e) => e.name)).toEqual(events);
      names.push(...evs.map((e) => e.name));
      for (const e of eventsNamed(evs, "TicketAttested")) attested.push({ owner: e.data.owner.toBase58(), ticket: e.data.ticket.toBase58(), effectiveAt: e.data.effectiveAt, ts: e.data.ts });
      for (const e of eventsNamed(evs, "FeesClaimed")) expect(e.data.toWallet).toBe(0n);
    }
    expect(names).toContain("CoinRegistered");
    expect(attested.map((a) => a.owner)).toEqual([ALICE, BOB]);
    expect(attested.map((a) => a.ticket).sort()).toEqual(Object.keys(COIN.accounts).filter((k) => k !== coinPda(new PublicKey(COIN.mint)).toBase58()).sort());
    // the registration event of the coin: 160 B, standard policy
    const reg = COIN.txs.find((t) => t.events.includes("CoinRegistered"))!;
    expect(eventsNamed(decodeFumpadEvents(reg.tx), "CoinRegistered")[0].data.feePolicy.kind).toBe(0);
  });

  it("decodes its accounts (Coin 546 B, tickets 276 B)", () => {
    const coin = decodeCoin(b(COIN.accounts[coinPda(new PublicKey(COIN.mint)).toBase58()]!));
    expect(coin.mint.toBase58()).toBe(COIN.mint);
    expect(coin.feePolicyKind).toBe(0);
    expect(coin.feePolicy).toBeUndefined();
    const owners = Object.entries(COIN.accounts)
      .filter(([k]) => k !== coinPda(coin.mint).toBase58())
      .map(([, d]) => decodeTicket(b(d!)).owner.toBase58())
      .sort();
    expect(owners).toEqual([ALICE, BOB].sort());
  });
});

describe("historical account layouts", () => {
  it("Consumed 82 B (pre-L-2) reads message_hash = 0; 98 B current; others refused", () => {
    const ticket = Keypair.generate().publicKey;
    const body = encodeType("Consumed", { bump: 254, kind: 0, ticket, rent_payer: Keypair.generate().publicKey, block_time: bn(1_791_900_000n), message_hash: Array(16).fill(7) });
    const full = cat(accountDiscriminator("Consumed"), body);
    expect(full.length).toBe(98);
    expect(decodeConsumed(full).messageHash).toEqual(Array(16).fill(7));
    const old = decodeConsumed(full.subarray(0, 82));
    expect(old.ticket.equals(ticket)).toBe(true);
    expect(old.messageHash).toEqual(Array(16).fill(0));
    expect(() => decodeConsumed(full.subarray(0, 90))).toThrow(FumpadDecodeError);
  });

  it("Coin: 546 B / 593 B only, the tail iff a non-standard kind; Ticket / Position / Global unknown sizes refused", () => {
    const coin = b(COIN.accounts[coinPda(new PublicKey(COIN.mint)).toBase58()]!);
    expect(() => decodeCoin(cat(coin, new Uint8Array(47)))).toThrow(/fee_policy_kind 0 with 593 bytes/);
    expect(() => decodeCoin(coin.subarray(0, 545))).toThrow(FumpadDecodeError);
    const ticket = b(Object.entries(COIN.accounts).find(([k]) => k !== coinPda(new PublicKey(COIN.mint)).toBase58())![1]!);
    expect(() => decodeTicket(ticket.subarray(0, 270))).toThrow(FumpadDecodeError);
    expect(() => decodeTicket(cat(ticket, new Uint8Array(1)))).toThrow(FumpadDecodeError);
    expect(() => decodePosition(new Uint8Array(300))).toThrow(FumpadDecodeError);
    expect(() => decodeGlobal(new Uint8Array(1_200))).toThrow(/Global: 1200 bytes matches no known layout \(1491 \/ 1044 bytes\)/);
  });
});

