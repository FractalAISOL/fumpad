import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { imageFileError, validateLaunch } from "./validate";

const empty = { name: "", symbol: "", description: "", x: "", telegram: "", website: "" };

describe("launch form validation", () => {
  it("only the name and the ticker are required: no image, description, links or first buy is a valid launch", () => {
    assert.deepEqual(validateLaunch({ ...empty, name: "Sad Pigeon", symbol: "PIGN" }), {});
  });

  it("there is no image check at all (a coin without an image shows its monogram)", () => {
    const e = validateLaunch(empty);
    assert.deepEqual(Object.keys(e).sort(), ["name", "symbol"]);
    assert.equal(e.image, undefined);
  });

  it("name and ticker rules", () => {
    assert.match(validateLaunch({ ...empty, name: "   ", symbol: "PIGN" }).name!, /name/);
    assert.match(validateLaunch({ ...empty, name: "x".repeat(33), symbol: "PIGN" }).name!, /32/);
    assert.match(validateLaunch({ ...empty, name: "A", symbol: "P" }).symbol!, /2 to 10/);
    assert.match(validateLaunch({ ...empty, name: "A", symbol: "pign" }).symbol!, /2 to 10/);
  });

  it("optional fields are checked only when filled", () => {
    const e = validateLaunch({ name: "A", symbol: "AB", description: "d".repeat(281), x: "not a handle!", telegram: "t.me", website: "http://x.y" });
    assert.deepEqual(Object.keys(e).sort(), ["description", "telegram", "website", "x"]);
    assert.deepEqual(validateLaunch({ name: "A", symbol: "AB", description: "hi", x: "@fumpad", telegram: "https://t.me/fumpad", website: "https://fumpad.app" }), {});
  });

  it("a picked file must still be a PNG / JPEG / GIF / WebP up to 4 MB", () => {
    assert.equal(imageFileError({ type: "image/png", size: 1_000 }), null);
    assert.match(imageFileError({ type: "image/svg+xml", size: 1_000 })!, /PNG/);
    assert.match(imageFileError({ type: "image/webp", size: 5 * 1024 * 1024 })!, /4 MB/);
  });
});
