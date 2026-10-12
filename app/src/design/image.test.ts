/** L-1 coin image URLs. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeImageSrc } from "./image";

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
