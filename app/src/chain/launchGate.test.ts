/** Launch-day gate (`./launchGate`): the launch page's closed state, from the API's options or a 403 launches_closed. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { postPrepare, PrepareError } from "./flow";
import { fetchLaunchOptions, LAUNCHES_CLOSED_CODE, launchPageState, type LaunchOptions, parseLaunchOptions } from "./launchGate";

const FIRST = { dbcConfig: "Cfg1111111111111111111111111111111111111111", wallet: "W111111111111111111111111111111111111111111", buybackShareBps: 100, walletShareBps: 140, launchesLeft: 1 };
const open: LaunchOptions = { launchesOpen: true, firstCoin: null };
const closed: LaunchOptions = { launchesOpen: false, firstCoin: null };
const closedFirst: LaunchOptions = { launchesOpen: false, firstCoin: FIRST };

const jsonFetch = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("parseLaunchOptions / fetchLaunchOptions", () => {
  it("reads launchesOpen and firstCoin; an older API without launchesOpen counts as open", () => {
    assert.deepEqual(parseLaunchOptions({ launchesOpen: false, firstCoin: null }), closed);
    assert.deepEqual(parseLaunchOptions({ launchesOpen: true, firstCoin: FIRST }), { launchesOpen: true, firstCoin: FIRST });
    assert.deepEqual(parseLaunchOptions({ firstCoin: null }), open);
    assert.equal(parseLaunchOptions(null), null);
    assert.equal(parseLaunchOptions("nope"), null);
  });

  it("fetch: the parsed options; null when the API errors or can't be reached", async () => {
    assert.deepEqual(await fetchLaunchOptions("https://api.test", jsonFetch(200, { launchesOpen: false, firstCoin: null })), closed);
    assert.equal(await fetchLaunchOptions("https://api.test", jsonFetch(500, { error: "internal error" })), null);
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    assert.equal(await fetchLaunchOptions("https://api.test", down), null);
  });

  it("asks with the connected wallet (?creator=) so the API can offer it the first-coin config (S-2)", async () => {
    const urls: string[] = [];
    const rec = (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ launchesOpen: false, firstCoin: FIRST }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchLaunchOptions("https://api.test", rec, FIRST.wallet), closedFirst);
    await fetchLaunchOptions("https://api.test", rec);
    assert.deepEqual(urls, [`https://api.test/v1/launch/options?creator=${FIRST.wallet}`, "https://api.test/v1/launch/options"]);
  });
});

describe("launchPageState (what /launch shows)", () => {
  it("closed: 'Launches open soon.' instead of the form", () => {
    assert.equal(launchPageState(closed, false), "closed");
    // first-coin URL, but the API doesn't offer it: still closed
    assert.equal(launchPageState(closed, true), "closed");
  });

  it("closed, /launch?config=first-coin while the API offers the first coin: the form", () => {
    assert.equal(launchPageState(closedFirst, true), "form");
    // the plain /launch stays closed even then
    assert.equal(launchPageState(closedFirst, false), "closed");
  });

  it("open: the form, first coin or not", () => {
    assert.equal(launchPageState(open, false), "form");
    assert.equal(launchPageState(open, true), "form");
  });

  it("loading until the options arrive; unknown options (no API, or unreachable) fall back to the form", () => {
    assert.equal(launchPageState(undefined, false), "loading");
    assert.equal(launchPageState(null, false), "form");
  });

  it("a 403 launches_closed from prepare closes the page, whatever the options said", () => {
    assert.equal(launchPageState(open, false, true), "closed");
    assert.equal(launchPageState(null, false, true), "closed");
    assert.equal(launchPageState(undefined, false, true), "closed");
    assert.equal(launchPageState(closedFirst, true, true), "form");
  });
});

describe("postPrepare carries the API's error code", () => {
  it("403 launches_closed → PrepareError with the code and a readable message", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = jsonFetch(403, { error: "Launches open soon", code: LAUNCHES_CLOSED_CODE });
    try {
      await assert.rejects(postPrepare("https://api.test", {}), (e: unknown) => {
        assert.ok(e instanceof PrepareError);
        assert.equal(e.status, 403);
        assert.equal(e.code, LAUNCHES_CLOSED_CODE);
        assert.equal(e.message, "Launches open soon.");
        return true;
      });
      globalThis.fetch = jsonFetch(403, { error: "the first-coin launch config is not enabled on this server" });
      await assert.rejects(postPrepare("https://api.test", {}), (e: unknown) => e instanceof PrepareError && e.code === undefined && e.message === "The first-coin launch config is not enabled on this server.");
    } finally {
      globalThis.fetch = orig;
    }
  });
});
