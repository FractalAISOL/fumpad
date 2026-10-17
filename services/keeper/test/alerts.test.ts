// Derivation-failure alerts: at most once per hour per (coin, error signature); a new distinct error alerts at once.
import { describe, expect, it } from "vitest";

import { Alerter, deriveAlert, errorSignature, telegramClusterTag, telegramText } from "../src/alerts.js";
import { Watcher } from "../src/watch/run.js";

const MINT = "HAwjL35BQrqKCFpmguuHshY39RwgzJNTPFVwzfEfmbL";
const range = (n: number) => new RangeError(`The value of "offset" is out of range. It must be >= 0 and <= ${n - 1}. Received ${n}`);

function alerter(clock: { t: number }) {
  const sent: { key: string; text: string }[] = [];
  const log = { warn: (o: { alert?: string }, text: string) => o.alert && sent.push({ key: o.alert, text }) };
  return { a: new Alerter(log as never, { now: () => clock.t, cooldownMs: 30 * 60_000 }), sent };
}

describe("derivation alert deduplication", () => {
  it("error signature: numbers / keys blanked, class and wording kept", () => {
    expect(errorSignature(range(152))).toBe(errorSignature(range(153)));
    expect(errorSignature(new Error(`coin ${MINT}: no DBC pool creation`))).toBe(errorSignature(new Error("coin 9zLVbFe9uSfwL9HzdVGX4T1UJfoG8DQD3rWdqpfTWcdN: no DBC pool creation")));
    expect(errorSignature(range(152))).not.toBe(errorSignature(new Error(range(152).message)));
    expect(errorSignature(new Error("RPC history incomplete"))).not.toBe(errorSignature(new Error("DBC config missing")));
  });

  it("once per hour per coin per signature; distinct errors and other coins alert immediately", async () => {
    const clock = { t: 0 };
    const { a, sent } = alerter(clock);
    const fire = async (mint: string, e: unknown) => {
      const d = deriveAlert("derive", mint, e);
      await a.alert(d.key, `derivation failed for ${mint}: ${String(e)}`, d.opts);
    };
    // the live spam: the same failure every 30 s tick for 2 h → 2 alerts (t = 0, t = 1 h)
    for (clock.t = 0; clock.t < 2 * 3_600_000; clock.t += 30_000) await fire(MINT, range(152));
    expect(sent).toHaveLength(2);
    // a different error on the same coin is not hidden
    await fire(MINT, new Error("DBC config missing"));
    expect(sent).toHaveLength(3);
    // nor the same error on another coin
    await fire("VE4HC2wrPG4adFRxcAD6MAhaLXQ4xS8zfqEKJAhfmbL", range(152));
    expect(sent).toHaveLength(4);
  });

  it("watcher: a coin failing every tick alerts once per hour", async () => {
    const clock = { t: 0 };
    const { a, sent } = alerter(clock);
    const w = new Watcher({
      coins: async () => [{ mint: { toBase58: () => MINT } } as never],
      global: async () => ({ params: { ticketChallengeSecs: 21_600n, maxAttestAgeSecs: 86_400n }, pendingEta: 0n, pendingConfigEta: 0n, pendingAdminEta: 0n }) as never,
      derive: async () => {
        throw range(152);
      },
      alerts: a,
      now: () => Math.floor(clock.t / 1000),
    });
    for (clock.t = 0; clock.t < 3_600_000 - 1; clock.t += 30_000) await w.tick();
    expect(sent.filter((s) => s.key.startsWith("watch:"))).toHaveLength(1);
    expect(w.stats.errors).toBe(120);
    clock.t = 3_600_000;
    await w.tick();
    expect(sent.filter((s) => s.key.startsWith("watch:"))).toHaveLength(2);
  });
});

describe("telegram cluster tag (one bot + chat for devnet and mainnet)", () => {
  it("tag from FUMPAD_CLUSTER, TELEGRAM_PREFIX overrides, unset = devnet", () => {
    expect(telegramClusterTag({ FUMPAD_CLUSTER: "mainnet" })).toBe("[MAINNET]");
    expect(telegramClusterTag({ FUMPAD_CLUSTER: " Devnet " })).toBe("[DEVNET]");
    expect(telegramClusterTag({ FUMPAD_CLUSTER: "localnet" })).toBe("[LOCALNET]");
    expect(telegramClusterTag({ FUMPAD_CLUSTER: "testnet" })).toBe("[TESTNET]");
    expect(telegramClusterTag({})).toBe("[DEVNET]");
    expect(telegramClusterTag({ FUMPAD_CLUSTER: "" })).toBe("[DEVNET]");
    expect(telegramClusterTag({ FUMPAD_CLUSTER: "mainnet", TELEGRAM_PREFIX: " [MAINNET-canary] " })).toBe("[MAINNET-canary]");
    expect(telegramClusterTag({ FUMPAD_CLUSTER: "mainnet", TELEGRAM_PREFIX: "  " })).toBe("[MAINNET]");
  });

  it("message = tag + service prefix + text, otherwise unchanged", () => {
    expect(telegramText("[MAINNET]", "[fumpad-watcher]", "pending change")).toBe("[MAINNET] [fumpad-watcher] pending change");
    expect(telegramText("[DEVNET]", "[fumpad-keeper]", "x".repeat(5_000))).toHaveLength(4000);
  });

  it("every sent Telegram message starts with the tag (keeper, attestor, watcher prefixes)", async () => {
    const bodies: { chat_id: string; text: string }[] = [];
    const orig = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }) as never;
    try {
      const log = { warn: () => {} } as never;
      const opts = { botToken: "t", chatId: "c" };
      await new Alerter(log, { ...opts, env: { FUMPAD_CLUSTER: "mainnet" } }).alert("balance", "keeper balance low: 0.1 SOL");
      await new Alerter(log, { ...opts, prefix: "[fumpad-attestor AbCdEf]", env: { FUMPAD_CLUSTER: "devnet" } }).alert("k", "derivation failed");
      await new Alerter(log, { ...opts, prefix: "[fumpad-watcher]", env: { FUMPAD_CLUSTER: "mainnet", TELEGRAM_PREFIX: "[MAIN-B]" } }).alert("k", "mismatch");
      expect(bodies.map((b) => b.text)).toEqual([
        "[MAINNET] [fumpad-keeper] keeper balance low: 0.1 SOL",
        "[DEVNET] [fumpad-attestor AbCdEf] derivation failed",
        "[MAIN-B] [fumpad-watcher] mismatch",
      ]);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
