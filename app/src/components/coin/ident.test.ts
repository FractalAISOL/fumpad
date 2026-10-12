/** H-3 coin identity: links by mint, symbol lookups never pick one silently. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coinHref, hasLookalikeChars, isMintAddress, mergeCoins, mintTail, normalizeSymbol } from "./ident";

const MINT_A = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosfmbL";
const MINT_B = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtfmbL";
const MINT_C = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gfmbL";

describe("coin identity", () => {
  it("links by mint only (no symbol fallback)", () => {
    assert.equal(coinHref({ mint: MINT_A }), `/coin/${MINT_A}`);
    // A garbage id is encoded, never spliced raw (the page then 404s).
    assert.equal(coinHref({ mint: "A/B?" }), "/coin/A%2FB%3F");
  });

  it("tells mints from symbols", () => {
    assert.ok(isMintAddress(MINT_A));
    assert.ok(!isMintAddress("PIGN"));
    assert.ok(!isMintAddress("0OIl" + MINT_A.slice(4))); // 0 O I l aren't base58
    assert.ok(!isMintAddress(MINT_A + "xx"));
  });

  it("lists every coin answering to a symbol, newest first, deduped by mint", () => {
    const squatter = { mint: MINT_A, symbol: "PIGN", createdAt: 1 };
    const real = { mint: MINT_B, symbol: "pign", createdAt: 3 };
    const other = { mint: MINT_C, symbol: "PIGGY", createdAt: 2 };
    // The API's /v1/coins/:symbol answer (oldest match) plus the newest-coins list.
    const merged = mergeCoins("$pign", squatter, [real, other, squatter]);
    assert.deepEqual(
      merged.map((c) => c.mint),
      [MINT_B, MINT_A],
    );
    assert.deepEqual(mergeCoins("PIGN", null, []), []);
  });

  it("flags look-alike characters", () => {
    assert.ok(!hasLookalikeChars("PIGN"));
    assert.ok(!hasLookalikeChars("Pig Nation 2"));
    assert.ok(hasLookalikeChars("PІGN")); // Cyrillic І
    assert.ok(hasLookalikeChars("PIGN​")); // zero-width space
    assert.ok(hasLookalikeChars("ＰＩＧＮ")); // full-width
  });

  it("normalizes and shortens", () => {
    assert.equal(normalizeSymbol(" $pign "), "PIGN");
    assert.equal(mintTail(MINT_A), "uJosfmbL");
  });
});
