// Watcher: every on-chain TicketAttested / TicketDebited compared with an independent derivation.
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";

import type { EngineOutput, HistoryTx } from "@fumpad/engine";
import { DEFAULT_PARAMS, EVENT_IX_TAG, eventAuthorityPda, FUMPAD_IDL, FUMPAD_PROGRAM_ID, fumpadCoder, toIdl } from "@fumpad/sdk";

import { lifecycleEvents } from "../src/attest/derive.js";
import { governanceAlerts } from "../src/watch/governance.js";
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

describe("guardian voids (INTERFACE §8.2)", () => {
  it("a mismatching ticket the guardian already voided is reported but not re-alerted", async () => {
    const alerts: string[] = [];
    const voidEv = eventIx("TicketVoided", { ticket, mint, owner, reason: 1, authority: owner, ts: 400n, coin: Keypair.generate().publicKey, reopened: true });
    const w = new Watcher({
      coins: async () => [{ mint } as never],
      global: async () => ({ params: { ticketChallengeSecs: 21_600n, maxAttestAgeSecs: 86_400n } }) as never,
      derive: async () => ({ coin: {} as never, output: derived(), maxSlot: 1, txCount: 2, history: [tx("att", 11, [attested(901n)]), tx("void", 12, [voidEv])] }),
      alerts: { alert: async (k: string) => void alerts.push(k) },
      now: () => NOW,
    });
    await w.tick();
    expect(w.feed(mint.toBase58()).coins[0].verdicts[0]).toMatchObject({ verdict: "mismatch", voided: true });
    expect(alerts.some((k) => k.startsWith("mismatch:"))).toBe(false);
  });
});

describe("watcher liveness alerts (L7)", () => {
  it("alerts on a sell that was never attested (with time left) and on engine issues", async () => {
    const alerts: string[] = [];
    const out = derived();
    out.sells[0].blockTime = NOW - 2_000;
    out.issues.push({ signature: "bad", slot: 5, kind: "negative_balance", scope: "wallet", wallet: owner.toBase58(), detail: "x" });
    const w = new Watcher({
      coins: async () => [{ mint } as never],
      global: async () => ({ params: { ticketChallengeSecs: 21_600n, maxAttestAgeSecs: 86_400n } }) as never,
      derive: async () => ({ coin: {} as never, output: out, maxSlot: 1, txCount: 0, history: [] }),
      alerts: { alert: async (k: string, text: string) => void alerts.push(`${k} ${text}`) },
      now: () => NOW,
    });
    await w.tick();
    expect(alerts.some((a) => a.startsWith("missing-sell:") && a.includes("expires in"))).toBe(true);
    expect(alerts.some((a) => a.startsWith("issues:") && a.includes("negative_balance/wallet"))).toBe(true);
    expect(w.stats.issues).toBe(1);
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

describe("governance alerts (C-TL: 1 h / 6 h timelocks)", () => {
  const k = () => Keypair.generate().publicKey;
  const base = { ...DEFAULT_PARAMS };
  const g0 = {
    admin: k(),
    platformTreasury: k(),
    guardian: k(),
    params: base,
    pendingParams: base,
    pendingEta: 0n,
    pendingAdmin: PublicKey.default,
    pendingTreasury: PublicKey.default,
    pendingGuardian: PublicKey.default,
    pendingAdminEta: 0n,
    pendingConfig: PublicKey.default,
    pendingConfigAdd: 0,
    pendingConfigEta: 0n,
  };

  it("nothing pending → no alert", () => {
    expect(governanceAlerts(g0 as never, NOW)).toEqual([]);
  });

  it("ParamsQueued / ConfigQueued / AdminProposed state → one alert each, with the diff and the eta", async () => {
    const cfg = k();
    const newAdmin = k();
    const g = {
      ...g0,
      pendingParams: { ...base, claimBps: 2_500, ticketChallengeSecs: 3_600n },
      pendingEta: BigInt(NOW + 3_600),
      pendingConfig: cfg,
      pendingConfigAdd: 1,
      pendingConfigEta: BigInt(NOW + 1_800),
      pendingAdmin: newAdmin,
      pendingTreasury: g0.platformTreasury,
      pendingGuardian: g0.guardian,
      pendingAdminEta: BigInt(NOW + 6 * 3_600),
    };
    const a = governanceAlerts(g as never, NOW);
    expect(a.map((x) => x.key)).toEqual([`gov:params:${NOW + 3_600}`, `gov:config:${cfg.toBase58()}:ADD:${NOW + 1_800}`, `gov:admin:${newAdmin.toBase58()}:${NOW + 6 * 3_600}`]);
    expect(a[0].text).toMatch(/ParamsQueued.*executable in 1h00m.*claimBps 1000→2500; ticketChallengeSecs 21600→3600.*cancel_params/);
    expect(a[1].text).toMatch(/ConfigQueued.*executable in 0h30m.*cancel_config/);
    expect(a[2].text).toMatch(new RegExp(`AdminProposed.*executable in 6h00m.*admin ${g0.admin.toBase58()}→${newAdmin.toBase58()}; platform_treasury .*\\(same\\).*cancel_admin`));

    // The watcher sends them on every tick (before the coins), deduplicated by the Alerter's cooldown.
    const sent: string[] = [];
    const w = new Watcher({ coins: async () => [], global: async () => g as never, derive: async () => ({}) as never, alerts: { alert: async (key: string) => void sent.push(key) }, now: () => NOW });
    await w.tick();
    expect(sent).toEqual(a.map((x) => x.key));
    expect(w.stats.governancePending).toBe(3);
  });
});
