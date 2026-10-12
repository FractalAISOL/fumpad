import { describe, expect, it } from "vitest";
import { socialsOf } from "../src/repo.js";

describe("socialsOf", () => {
  it("keeps http(s) links and expands bare handles", () => {
    expect(socialsOf({ twitter: "@frog", telegram: "https://t.me/frogs", website: "https://frog.fun" })).toEqual({
      x: "https://x.com/frog",
      telegram: "https://t.me/frogs",
      website: "https://frog.fun/",
    });
  });
  it("drops scripts and junk", () => {
    expect(socialsOf({ website: "javascript:alert(1)", twitter: "not a handle!", telegram: "data:text/html,hi" })).toBeUndefined();
    expect(socialsOf(null)).toBeUndefined();
  });
});
