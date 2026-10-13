/** L-1 coin image URLs. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coinImageSrc, safeImageSrc } from "./image";

describe("safeImageSrc", () => {
  it("keeps https and maps IPFS / Arweave to HTTPS gateways", () => {
    assert.equal(safeImageSrc("https://cdn.example.com/a.png"), "https://cdn.example.com/a.png");
    assert.equal(safeImageSrc("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/img.png"), "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/img.png");
    assert.equal(safeImageSrc("ar://abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"), "https://arweave.net/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ");
  });

  it("drops every other scheme and odd URLs", () => {
    for (const u of [
      "http://cdn.example.com/a.png",
      "javascript:alert(1)",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "file:///etc/passwd",
      "/og/abc",
      "//evil.example/a.png",
      "https://user:pass@cdn.example.com/a.png",
      "https://localhost/a.png",
      'https://cdn.example.com/a.png" onerror="x',
      "ipfs://../../etc",
      "blob:https://fumpad.app/123",
      "",
      undefined,
      "https://x.example/" + "a".repeat(3000),
    ])
      assert.equal(safeImageSrc(u), undefined, String(u));
  });

  it("allows the launch form's local blob preview only when asked", () => {
    assert.equal(safeImageSrc("blob:https://fumpad.app/123", { allowBlob: true }), "blob:https://fumpad.app/123");
  });
});

describe("coinImageSrc (V7-L6 image proxy)", () => {
  const API = "https://api.example.app";
  const mint = "SM5k4LWqXTrZZYtmbKCvVDiJrk44mEiaJdag9GnfmbL";
  it("points at the API's image proxy by mint, never at the creator's host", () => {
    const src = coinImageSrc(mint, "https://evil.example/a.png", API + "/");
    assert.ok(src?.startsWith(`${API}/v1/img/${mint}?v=`), src);
    assert.ok(!src?.includes("evil.example"));
    assert.ok(coinImageSrc(mint, "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/img.png", API)?.startsWith(`${API}/v1/img/${mint}?v=`));
  });
  it("changes the URL when the image changes (cache-buster), stable otherwise", () => {
    assert.equal(coinImageSrc(mint, "https://a.example/1.png", API), coinImageSrc(mint, "https://a.example/1.png", API));
    assert.notEqual(coinImageSrc(mint, "https://a.example/1.png", API), coinImageSrc(mint, "https://a.example/2.png", API));
  });
  it("monogram (undefined) without an API, a usable image or a base58 mint", () => {
    assert.equal(coinImageSrc(mint, "https://a.example/1.png", ""), undefined);
    assert.equal(coinImageSrc(mint, "javascript:alert(1)", API), undefined);
    assert.equal(coinImageSrc(mint, "http://a.example/1.png", API), undefined);
    assert.equal(coinImageSrc(mint, undefined, API), undefined);
    assert.equal(coinImageSrc("../../v1/admin", "https://a.example/1.png", API), undefined);
    assert.equal(coinImageSrc(undefined, "https://a.example/1.png", API), undefined);
  });
});
