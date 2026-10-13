// Watcher: every on-chain TicketAttested / TicketDebited compared with an independent derivation.
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import type { EngineOutput, HistoryTx } from "@fumpad/engine";
import { EVENT_IX_TAG, eventAuthorityPda, FUMPAD_IDL, FUMPAD_PROGRAM_ID, fumpadCoder, toIdl } from "@fumpad/sdk";

import { lifecycleEvents } from "../src/attest/derive.js";
import { Watcher } from "../src/watch/run.js";
import { verifyCoin } from "../src/watch/verify.js";

const mint = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const pool = Keypair.generate().publicKey;
const ticket = Keypair.generate().publicKey;
const sellSig = bs58.encode(new Uint8Array(64).fill(5));
const buySig = bs58.encode(new Uint8Array(64).fill(6));
const NOW = 1_800_000_000;

function eventIx(name: string, data: Record<string, unknown>): string {
  const disc = (FUMPAD_IDL as unknown as { events: { name: string; discriminator: number[] }[] }).events.find((e) => e.name === name)!.discriminator;
  const body = fumpadCoder().types.encode(name, toIdl(data) as never);
  return bs58.encode(Uint8Array.from([...EVENT_IX_TAG, ...disc, ...body]));
}

function tx(sig: string, slot: number, events: string[]): HistoryTx {
  return {
    txIndex: -1,
    tx: {
      slot,
      blockTime: NOW - 500,
      transaction: { signatures: [sig], message: { accountKeys: [Keypair.generate().publicKey.toBase58(), FUMPAD_PROGRAM_ID.toBase58(), eventAuthorityPda().toBase58()], instructions: [] } },
      meta: { err: null, innerInstructions: [{ index: 0, instructions: events.map((data) => ({ programIdIndex: 1, accounts: [2], data })) }] },
    } as never,
  };
}

const attested = (tokens: bigint) =>
  eventIx("TicketAttested", {
    mint,
    owner,
    ticket,
    seq: 0n,
    pool,
    venue: 0,
    source: 0,
    signature: Array.from(bs58.decode(sellSig)),
    ixKey: 7,
    baseAmount: 1_000n,
    quoteGross: 500n,
    tokens,
    sellPriceQ64: 123n,
    sellUsdCents: 6_000n,
    pythPublishTime: 99n,
    slot: 10n,
    sellTs: 100n,
    keepers: [Keypair.generate().publicKey, Keypair.generate().publicKey],
    submitter: Keypair.generate().publicKey,
    ts: 200n,
  });
const debited = (amount: bigint) =>
  eventIx("TicketDebited", { ticket, mint, owner, signature: Array.from(bs58.decode(buySig)), ixKey: 0xffff_ffff, debited: amount, remaining: 1n, voided: false, ts: 300n });

function derived(withTicket = true): EngineOutput {
  return {
    mint: mint.toBase58(),
    sells: [
      {
        signature: sellSig,
        ixKey: 7,
        slot: 10,
        txIndex: -1,
        blockTime: 100,
        venue: "dbc",
        pool: pool.toBase58(),
        routed: false,
        trader: owner.toBase58(),
        baseAmount: 1_000n,
        quoteGross: 500n,
        ticket: withTicket ? { ticketTokens: 900n, ticketPriceQ64: 123n, usdCents: 6_000n, pythPublishTime: 99, executionQ64: 1n, referenceQ64: 1n, preSpotQ64: 1n } : null,
        reason: withTicket ? null : "not_matured",
      },
    ],
    rebuys: [
      { signature: buySig, ixKey: 0xffff_ffff, kind: "transfer_in", slot: 20, blockTime: 150, wallet: owner.toBase58(), ticket: { signature: sellSig, ixKey: 7 }, ticketAddress: ticket.toBase58(), debit: 50n, remaining: 850n, voided: false },
    ],
    issues: [],
    reference: { avgQ64: 0n, lastSpotQ64: 0n, updatedAt: 0n },
    lastKey: null,
  };
}

describe("watcher verification", () => {
  it("all fields match → match", () => {
    const v = verifyCoin(mint.toBase58(), derived(), [tx("att", 11, [attested(900n)]), tx("deb", 21, [debited(50n)])], NOW);
    expect(v.verdicts.map((x) => [x.kind, x.verdict])).toEqual([
      ["sell", "match"],
      ["rebuy", "match"],
    ]);
    expect(v.missing).toEqual([]);
  });
  it("a different ticket size or debit → mismatch with the diff", () => {
    const v = verifyCoin(mint.toBase58(), derived(), [tx("att", 11, [attested(901n)]), tx("deb", 21, [debited(49n)])], NOW);
    expect(v.verdicts[0].verdict).toBe("mismatch");
    expect(v.verdicts[0].diffs).toEqual({ tokens: ["901", "900"] });
    expect(v.verdicts[1].diffs).toEqual({ debit: ["49", "50"] });
  });
  it("an attestation for a sell the engine gave no ticket → mismatch", () => {
    const v = verifyCoin(mint.toBase58(), derived(false), [tx("att", 11, [attested(900n)])], NOW);
    expect(v.verdicts[0].verdict).toBe("mismatch");
    expect(v.verdicts[0].diffs.ticket[1]).toContain("not_matured");
  });
  it("derived but never attested after the grace period → missing", () => {
    const v = verifyCoin(mint.toBase58(), derived(), [], NOW);
    expect(v.missing.map((m) => m.kind).sort()).toEqual(["rebuy", "sell"]);
    expect(verifyCoin(mint.toBase58(), derived(), [], 160, 900).missing).toEqual([]);
  });
  it("Watcher alerts once per mismatch and serves the feed", async () => {
    const alerts: string[] = [];
    const coin = { mint } as never;
    const w = new Watcher({
      coins: async () => [coin],
      global: async () => ({ params: { ticketChallengeSecs: 21_600n } }) as never,
      derive: async () => ({ coin: {} as never, output: derived(), maxSlot: 1, txCount: 2, history: [tx("att", 11, [attested(901n)])] }),
      alerts: { alert: async (k: string) => void alerts.push(k) },
      now: () => NOW,
    });
    await w.tick();
    expect(w.stats.mismatches).toBe(1);
    expect(alerts.some((k) => k.startsWith("mismatch:sell"))).toBe(true);
    expect(w.feed(mint.toBase58()).coins[0].verdicts[0].verdict).toBe("mismatch");
    expect(w.ticket(ticket.toBase58())?.kind).toBe("sell");
    void PublicKey;
  });
});

describe("ticket lifecycle → engine events", () => {
  it("maps TicketAttested to the sell and later claims / voids to status events", () => {
    const paid = eventIx("ClaimPaid", { mint, ticket, owner, amount: 1n, fromQueue: false, medianPriceQ64: 1n, ts: 1n, triggeredBy: owner });
    const ev = lifecycleEvents(mint.toBase58(), [tx("att", 11, [attested(900n)]), tx("claim", 30, [paid])]);
    expect(ev.map((e) => e.kind)).toEqual(["ticket_attested", "ticket_status"]);
    expect(ev[0]).toMatchObject({ ref: { signature: sellSig, ixKey: 7 }, ticket: ticket.toBase58() });
    expect(ev[1]).toMatchObject({ status: "claimed", ticket: { signature: sellSig, ixKey: 7 } });
    // other mints' events are ignored
    expect(lifecycleEvents(Keypair.generate().publicKey.toBase58(), [tx("att", 11, [attested(900n)])])).toEqual([]);
  });
});
