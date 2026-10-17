import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TtlCache } from "../src/cache.js";
import { OPENAPI } from "../src/openapi.js";
import { levelOf, mult, tileOf } from "../src/repo.js";

const here = dirname(fileURLToPath(import.meta.url));
const strip = (s: string) => s.replace(/^\/\/ GENERATED.*\n/, "");

describe("API ↔ app data contract", () => {
  it("generated app-types.ts / app-interface.ts are identical to app/src/data (run `npm run api-types` if not)", () => {
    const app = join(here, "../../../app/src/data");
    expect(strip(readFileSync(join(here, "../src/generated/app-types.ts"), "utf8"))).toBe(readFileSync(join(app, "types.ts"), "utf8"));
    expect(strip(readFileSync(join(here, "../src/generated/app-interface.ts"), "utf8"))).toBe(readFileSync(join(app, "interface.ts"), "utf8").replace('from "./types";', 'from "./app-types.js";'));
  });
  it("OpenAPI documents one route per FumpadData method + ws + health", () => {
    const methods = ["getStats", "getSolUsd", "getParams", "getRecentTrades", "subscribeLive", "listCoins", "getCoin", "getPriceSeries", "getCandles", "getHolders", "getRecentFumbles", "getClaimQueue", "getFeed", "subscribeFeed", "getClosestTo10x", "getTickets", "getTicket", "getLeaderboard", "getProfile", "quoteTrade", "getBalances", "getPositions", "getClosedPositions", "getCreatedCoins"];
    const summaries = Object.values(OPENAPI.paths).map((p) => ((p as { get?: { summary: string } }).get ?? (p as { post: { summary: string } }).post).summary).join(" ");
    for (const m of methods) if (m !== "subscribeFeed" && m !== "subscribeLive") expect(summaries).toContain(`(${m})`);
    expect(summaries).toContain("(subscribeFeed, subscribeLive)");
    expect(Object.keys(OPENAPI.components.schemas)).toEqual(expect.arrayContaining(["CoinDetail", "Ticket", "TradeQuote", "FeedEvent", "Profile"]));
  });
});

describe("helpers", () => {
  it("tileOf is deterministic and in {0,1,2}", () => {
    const m = "So11111111111111111111111111111111111111112";
    expect(tileOf(m)).toBe(tileOf(m));
    expect([0, 1, 2]).toContain(tileOf(m));
  });
  it("levels grow with xp; titles from the mock's ladder", () => {
    expect(levelOf(0)).toMatchObject({ level: 1, title: "fresh exit" });
    expect(levelOf(250).level).toBe(2);
    expect(levelOf(250 * 16).level).toBe(5);
    expect(levelOf(1e9).title).toBe("regret connoisseur");
  });
  it("multiples are exact ratios of Q64 prices", () => {
    expect(mult(10n << 64n, 1n << 64n)).toBe(10);
    expect(mult(1n, 0n)).toBe(0);
  });
  it("cache coalesces and invalidates", async () => {
    const c = new TtlCache();
    let n = 0;
    const load = async () => ++n;
    expect(await Promise.all([c.get("coin:a", 1_000, load), c.get("coin:a", 1_000, load)])).toEqual([1, 1]);
    c.invalidate(["coin:a"]);
    expect(await c.get("coin:a", 1_000, load)).toBe(2);
  });
});
