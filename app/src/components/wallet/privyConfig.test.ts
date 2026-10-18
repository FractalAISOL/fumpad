/** APP-10: no fallback Privy app id. `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privyBuildProblem, resolvePrivyAppId } from "./privyConfig";

const API = "https://api.example.app";

describe("Privy app id (APP-10)", () => {
  it("comes from NEXT_PUBLIC_PRIVY_APP_ID only: unset is null, never a built-in id", () => {
    assert.equal(resolvePrivyAppId(undefined), null);
    assert.equal(resolvePrivyAppId("  "), null);
    assert.equal(resolvePrivyAppId(" cmabcdefghijklmnopqrstuvw "), "cmabcdefghijklmnopqrstuvw");
    assert.throws(() => resolvePrivyAppId("abc def<script>"), /doesn't look like a Privy app id/);
  });

  it("a production build of the live app without it fails; mock and dev builds don't", () => {
    assert.match(privyBuildProblem({ NODE_ENV: "production", NEXT_PUBLIC_FUMPAD_API: API }) ?? "", /NEXT_PUBLIC_PRIVY_APP_ID is unset/);
    assert.equal(privyBuildProblem({ NODE_ENV: "production", NEXT_PUBLIC_FUMPAD_API: API, NEXT_PUBLIC_PRIVY_APP_ID: "cmabcdefghijklmnopqrstuvw" }), null);
    assert.equal(privyBuildProblem({ NODE_ENV: "production" }), null); // mock: no Privy at all
    assert.equal(privyBuildProblem({ NODE_ENV: "development", NEXT_PUBLIC_FUMPAD_API: API }), null); // dev: wallet off, login says why
    assert.match(privyBuildProblem({ NODE_ENV: "production", NEXT_PUBLIC_PRIVY_APP_ID: "bad id!" }) ?? "", /doesn't look like/);
  });
});
