/** Fumble Checker model. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FumbleSell, ProtocolParams, Ticket } from "../../data/types";
import { base58Bytes, checkerMood, countdown, feeNote, isPublicKey, opensInText, parseOpensAt, parseWalletInput, reasonText, solscan, targetProgress, ticketStatus, tradeLinks } from "./model";

const ALICE = "9zLVbFe9uSfwL9HzdVGX4T1UJfoG8DQD3rWdqpfTWcdN";
const MINT = "EsWqW6inhiDYKaYqpX4kGXaUkBUBmVqbXypoUB4bfmbL";
const P = {
  minSellUsd: 50,
  minHoldSecs: 600,
  maxOpenTickets: 5,
  triggerMultiple: 10,
  claimBps: 1000,
  oracleWindowSecs: 1800,
  attestDelaySecs: 60,
  ticketChallengeSecs: 21_600,
} as ProtocolParams;

describe("wallet input", () => {
  it("accepts a bare address, with spaces or quotes", () => {
    assert.deepEqual(parseWalletInput(ALICE), { ok: true, address: ALICE });
    assert.deepEqual(parseWalletInput(`  "${ALICE}"\n`), { ok: true, address: ALICE });
    assert.deepEqual(parseWalletInput(`${ALICE.slice(0, 20)} ${ALICE.slice(20)}`), { ok: true, address: ALICE });
  });
  it("pulls the address out of an explorer or profile link", () => {
    for (const u of [`https://solscan.io/account/${ALICE}?cluster=devnet`, `https://explorer.solana.com/address/${ALICE}`, `https://fumpad.app/u/${ALICE}`, `https://gmgn.ai/sol/address/${ALICE}`]) {
      assert.deepEqual(parseWalletInput(u), { ok: true, address: ALICE }, u);
    }
    assert.equal(parseWalletInput("https://solscan.io/").ok, false);
  });
  it("refuses what isn't a public key, with a reason", () => {
    assert.deepEqual(parseWalletInput(""), { ok: false, error: null });
    for (const bad of ["hello", "0x52908400098527886E0F7030069857D2E4169EE7", ALICE.replace("9", "0"), ALICE + "1111", "<script>alert(1)</script>", `${ALICE}'; DROP TABLE`]) {
      const r = parseWalletInput(bad);
      assert.equal(r.ok, false, bad);
      assert.ok(!r.ok && r.error, bad);
    }
  });
  it("base58 decodes to 32 bytes for keys only", () => {
    assert.equal(base58Bytes(ALICE), 32);
    assert.equal(base58Bytes(MINT), 32);
    assert.equal(base58Bytes("11111111111111111111111111111111"), 32);
    assert.equal(base58Bytes("1111111111111111111111111111111"), 31);
    assert.equal(base58Bytes("0"), null);
    assert.equal(isPublicKey(MINT), true);
    assert.equal(isPublicKey("z".repeat(44)), false); // 44 chars but > 32 bytes
  });
});

const ticket = (over: Partial<Ticket>): Ticket => ({ state: "challenge", claimableFrom: 10_000_000, ...over }) as Ticket;
const sell = (over: Partial<FumbleSell>): FumbleSell => ({ outcome: "ticket", ...over }) as FumbleSell;

describe("ticket status", () => {
  it("walks the path with a live countdown in the 6-hour check", () => {
    assert.equal(ticketStatus(sell({ outcome: "verifying" }), 0, P).step, "verifying");
    const c = ticketStatus(sell({ ticket: ticket({ claimableFrom: 3_600_000 + 5 * 60_000 }) }), 0, P);
    assert.equal(c.step, "challenge");
    assert.equal(c.title, "6-hour check: 1h 05m left");
    assert.equal(ticketStatus(sell({ ticket: ticket({ state: "awaiting-graduation" }) }), 0, P).title, "Open, waiting for graduation");
    assert.equal(ticketStatus(sell({ ticket: ticket({ state: "tracking" }) }), 0, P).step, "open");
    assert.deepEqual(
      (({ step, money }) => ({ step, money }))(ticketStatus(sell({ ticket: ticket({ state: "claimable" }) }), 0, P)),
      { step: "claimable", money: true },
    );
    assert.equal(ticketStatus(sell({ ticket: ticket({ state: "queued", queuePosition: 3 }) }), 0, P).title, "Queued, #3");
    assert.equal(ticketStatus(sell({ ticket: ticket({ state: "claimed" }) }), 0, P).step, "done");
    const v = ticketStatus(sell({ ticket: ticket({ state: "voided", voidReason: "guardian" }) }), 0, P);
    assert.equal(v.closed, true);
    assert.match(v.detail, /guardian/);
    assert.equal(ticketStatus(sell({ outcome: "no-ticket" }), 0, P).step, null);
  });
  it("countdowns", () => {
    assert.equal(countdown(41_000), "41s");
    assert.equal(countdown(12 * 60_000 + 3_000), "12m 03s");
    assert.equal(countdown(5 * 3_600_000 + 12 * 60_000), "5h 12m");
    assert.equal(countdown(-5), "0s");
    assert.equal(countdown(2 * 86_400_000 + 3_600_000), "2d 1h");
  });
  it("reasons quote the params", () => {
    assert.match(reasonText("below_minimum_usd", P), /\$50/);
    assert.match(reasonText("not_matured", P), /10 min/);
    assert.match(reasonText("too_many_open_tickets", P), /5 open tickets/);
    assert.match(reasonText("creator", P), /launched/);
  });
});

describe("claim target", () => {
  it("progress from the market cap now to the target", () => {
    assert.deepEqual(targetProgress(500, 1000, 10), { fraction: 0.5, multiple: 5, reached: false });
    assert.deepEqual(targetProgress(1500, 1000, 10), { fraction: 1, multiple: 15, reached: true });
    assert.deepEqual(targetProgress(10, 0, 10), { fraction: 0, multiple: 0, reached: false });
  });
});

describe("fees", () => {
  it("a note only when the coin's own fee differs from the standard model", () => {
    assert.equal(feeNote("PIGN", { feeBps: 125, migratedFeeBps: 125, snipeStartBps: 9900, snipeWindowSlots: 8, policy: "standard" }, 125), null);
    assert.equal(feeNote("PIGN", undefined, 125), null);
    assert.equal(
      feeNote("FIRST", { feeBps: 300, migratedFeeBps: 300, snipeStartBps: 9900, snipeWindowSlots: 25, policy: "wallet_split", poolShareBps: 100, walletShareBps: 140, wallet: ALICE }, 125),
      "Launch coin $FIRST: 3% fee. 1% of volume buys $FIRST back into its Reward Pool; 1.4% goes to the team wallet, with no creator share.",
    );
    assert.equal(feeNote("X", { feeBps: 200, migratedFeeBps: 200, snipeStartBps: 0, snipeWindowSlots: 0, policy: "standard" }, 125), "Launch coin $X: 2% fee instead of 1.25%.");
  });
});

describe("links", () => {
  it("trade links for the mint, Solscan per cluster", () => {
    const l = tradeLinks(MINT);
    assert.deepEqual(
      l.map((x) => x.label),
      ["Axiom", "Jupiter", "Phantom", "GMGN"],
    );
    assert.ok(l.every((x) => x.href.startsWith("https://") && x.href.includes(MINT)));
    assert.equal(solscan("token", MINT, "?cluster=devnet"), `https://solscan.io/token/${MINT}?cluster=devnet`);
    assert.equal(solscan("tx", "abc", ""), "https://solscan.io/tx/abc");
  });
  it("app-opens countdown text", () => {
    assert.equal(parseOpensAt(undefined), null);
    assert.equal(parseOpensAt("nope"), null);
    const t = parseOpensAt("2026-10-15T17:00:00Z")!;
    assert.equal(opensInText(t, t - 25 * 60_000), "The full app opens in ~25 min.");
    assert.equal(opensInText(t, t - 30_000), "The full app opens any minute now.");
    assert.match(opensInText(t, t + 1)!, /opening now/);
    assert.equal(opensInText(null, 0), "The full app opens shortly.");
  });
});

describe("Fumi's reaction", () => {
  const sell = (outcome: FumbleSell["outcome"], state?: Ticket["state"]) => ({ outcome, ticket: state ? ({ state } as Ticket) : undefined }) as FumbleSell;
  const done = (sells: FumbleSell[], found = true) => ({ kind: "done" as const, data: { found, coins: sells.length ? [{ sells } as never] : [] } });
  it("idle, loading and error", () => {
    assert.equal(checkerMood({ kind: "idle" }).pose, "thinking");
    assert.equal(checkerMood({ kind: "loading" }).pose, "thinking");
    assert.equal(checkerMood({ kind: "error" }).pose, "facepalm");
  });
  it("the strongest beat wins", () => {
    assert.equal(checkerMood(done([], false)).pose, "thinking");
    assert.equal(checkerMood(done([])).pose, "waving");
    assert.equal(checkerMood(done([sell("no-ticket")])).pose, "thumbsdown");
    assert.equal(checkerMood(done([sell("no-ticket"), sell("verifying")])).pose, "thinking");
    assert.equal(checkerMood(done([sell("verifying"), sell("ticket", "tracking")])).pose, "crying");
    assert.equal(checkerMood(done([sell("ticket", "expired"), sell("ticket", "claimed")])).pose, "cheering");
    assert.equal(checkerMood(done([sell("ticket", "claimed"), sell("ticket", "queued")])).pose, "moneyeyes");
    assert.equal(checkerMood(done([sell("ticket", "tracking"), sell("ticket", "claimable")])).pose, "moneyeyes");
  });
  it("quips stay short and promise nothing", () => {
    const all = [
      checkerMood({ kind: "idle" }),
      checkerMood({ kind: "loading" }),
      checkerMood({ kind: "error" }),
      ...[[], [sell("no-ticket")], [sell("verifying")], [sell("ticket", "tracking")], [sell("ticket", "claimed")], [sell("ticket", "claimable")]].map((x) => checkerMood(done(x))),
      checkerMood(done([], false)),
    ];
    for (const m of all) {
      assert.ok(m.quip.split(/\s+/).length <= 8, m.quip);
      assert.doesNotMatch(m.quip, /profit|guarantee|earn|returns|free money|\$|\bSOL\b/i, m.quip);
    }
  });
});
