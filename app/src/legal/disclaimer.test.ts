/** Disclaimer gate: acceptance storage, version bump, legal routes, pre-paint script. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DISCLAIMER_SCRIPT, DISCLAIMER_VERSION, type KeyValueStore, disclaimerKey, isLegalPath, isLegalRoute, parseAcceptance, readAcceptance, writeAcceptance } from "./disclaimer";

function memStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
  };
}

const throwing: KeyValueStore = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("disclaimer acceptance", () => {
  it("uses a versioned key", () => {
    assert.equal(disclaimerKey(1), "fumpad.disclaimer.v1");
    assert.equal(disclaimerKey(), `fumpad.disclaimer.v${DISCLAIMER_VERSION}`);
  });

  it("is not accepted on a fresh browser", () => {
    assert.equal(readAcceptance(memStore()), null);
  });

  it("round-trips with a timestamp", () => {
    const s = memStore();
    assert.equal(writeAcceptance(s, 1_760_000_000_000), true);
    assert.deepEqual(readAcceptance(s), { v: DISCLAIMER_VERSION, at: 1_760_000_000_000 });
    assert.deepEqual(JSON.parse(s.data.get(disclaimerKey())!), { v: DISCLAIMER_VERSION, at: 1_760_000_000_000 });
  });

  it("re-asks after a version bump and clears older records", () => {
    const s = memStore();
    writeAcceptance(s, 1000, 1);
    assert.ok(readAcceptance(s, 1));
    assert.equal(readAcceptance(s, 2), null, "a v1 acceptance does not count for v2");
    writeAcceptance(s, 2000, 2);
    assert.deepEqual(readAcceptance(s, 2), { v: 2, at: 2000 });
    assert.equal(s.data.has(disclaimerKey(1)), false, "the v1 record is dropped");
  });

  it("rejects a record whose version doesn't match its key", () => {
    const s = memStore({ [disclaimerKey(2)]: JSON.stringify({ v: 1, at: 1000 }) });
    assert.equal(readAcceptance(s, 2), null);
  });

  it("treats malformed records as not accepted", () => {
    for (const raw of ["", "true", "1", "null", "{", "[]", '{"v":1}', '{"v":1,"at":"x"}', '{"v":1,"at":0}', '{"v":1,"at":-5}', '{"v":"1","at":5}']) {
      assert.equal(parseAcceptance(raw, 1), null, raw);
    }
    assert.deepEqual(parseAcceptance('{"v":1,"at":5}', 1), { v: 1, at: 5 });
  });

  it("survives blocked or missing storage (asks again, no throw)", () => {
    assert.equal(readAcceptance(throwing), null);
    assert.equal(writeAcceptance(throwing, 1000), false);
    assert.equal(readAcceptance(null), null);
    assert.equal(writeAcceptance(undefined, 1000), false);
  });
});

describe("legal routes skip the gate", () => {
  it("by path", () => {
    for (const p of ["/terms", "/privacy", "/risk", "/risk/", "/soon/terms", "/soon/privacy", "/soon/risk"]) assert.equal(isLegalPath(p), true, p);
    for (const p of ["/", "/soon", "/live", "/launches", "/terms/x", "/coin/terms", "/termsx", "/how-it-works"]) assert.equal(isLegalPath(p), false, p);
  });

  it("by route segments", () => {
    assert.equal(isLegalRoute(["terms"]), true);
    assert.equal(isLegalRoute(["soon", "risk"]), true);
    assert.equal(isLegalRoute([]), false);
    assert.equal(isLegalRoute(["soon"]), false);
    assert.equal(isLegalRoute(["live"]), false);
    assert.equal(isLegalRoute(["coin", "terms"]), false);
  });
});

describe("pre-paint script", () => {
  function run(pathname: string, store: KeyValueStore | null) {
    const attrs = new Map<string, string>();
    const document = { documentElement: { setAttribute: (k: string, v: string) => attrs.set(k, v) } };
    const localStorage = store ?? throwing;
    new Function("location", "localStorage", "document", DISCLAIMER_SCRIPT)({ pathname }, localStorage, document);
    return attrs.get("data-disclaimer") ?? null;
  }

  it("hides app pages until accepted, matching readAcceptance", () => {
    const s = memStore();
    assert.equal(run("/", s), "pending");
    assert.equal(run("/live", s), "pending");
    writeAcceptance(s, 1000);
    assert.equal(run("/", s), null);
  });

  it("ignores an older version's record", () => {
    const s = memStore({ [disclaimerKey(DISCLAIMER_VERSION + 1)]: JSON.stringify({ v: DISCLAIMER_VERSION + 1, at: 1 }) });
    assert.equal(run("/", s), "pending");
  });

  it("leaves legal pages alone, and hides when storage is blocked", () => {
    assert.equal(run("/terms", memStore()), null);
    assert.equal(run("/soon/risk", memStore()), null);
    assert.equal(run("/launches", null), "pending");
  });
});
