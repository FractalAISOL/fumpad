import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { safeSocialHref } from "./socialLinks";

describe("safeSocialHref (APP-7)", () => {
  it("keeps https links on the right hosts", () => {
    assert.equal(safeSocialHref("x", "https://x.com/fumpadapp"), "https://x.com/fumpadapp");
    assert.equal(safeSocialHref("x", " https://twitter.com/fumpadapp "), "https://twitter.com/fumpadapp");
    assert.equal(safeSocialHref("telegram", "https://t.me/fumpad"), "https://t.me/fumpad");
    assert.equal(safeSocialHref("website", "https://fumpad.app/about?x=1"), "https://fumpad.app/about?x=1");
    assert.equal(safeSocialHref("x", "HTTPS://X.COM/a"), "https://x.com/a");
  });

  it("refuses other schemes: javascript:, data:, http:, protocol-relative, mailto:", () => {
    for (const k of ["x", "telegram", "website"] as const) {
      for (const raw of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "http://x.com/a", "//x.com/a", "mailto:a@b.c", "vbscript:x", "x.com/a", ""]) {
        assert.equal(safeSocialHref(k, raw), null, `${k}: ${raw}`);
      }
    }
    assert.equal(safeSocialHref("website", undefined), null);
    assert.equal(safeSocialHref("website", 42 as unknown as string), null);
  });

  it("refuses look-alike or foreign hosts for X and Telegram", () => {
    for (const raw of ["https://x.com.evil.io/a", "https://evil.io/x.com", "https://xcom.io/a", "https://x.co/a", "https://twitter.com@evil.io/a", "https://evil.io#https://x.com", "https://xn--x-com.io/a"]) assert.equal(safeSocialHref("x", raw), null, raw);
    for (const raw of ["https://t.me.evil.io/a", "https://telegram.org.evil.io", "https://tme.io/a"]) assert.equal(safeSocialHref("telegram", raw), null, raw);
  });

  it("refuses credentials, ports, whitespace and control characters, single-label and over-long hosts", () => {
    assert.equal(safeSocialHref("website", "https://user:pass@fumpad.app/"), null);
    assert.equal(safeSocialHref("website", "https://fumpad.app:8443/"), null);
    assert.equal(safeSocialHref("website", "https://fumpad.app/a b"), null);
    assert.equal(safeSocialHref("website", "https://fumpad.app/\u0000"), null);
    assert.equal(safeSocialHref("website", "https://localhost/"), null);
    assert.equal(safeSocialHref("website", `https://fumpad.app/${"a".repeat(600)}`), null);
  });
});
