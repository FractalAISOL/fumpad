/** Program errors → toast sentences (names from the SDK's IDL). `npm test` */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DBC_PROGRAM_ID, FUMPAD_ERROR, FUMPAD_PROGRAM_ID } from "@fumpad/sdk";
import { FUMPAD_ERROR_MESSAGES, txErrorMessage } from "./errors";

const fumpadFail = (code: number) => [`Program ${FUMPAD_PROGRAM_ID.toBase58()} failed: custom program error: 0x${code.toString(16)}`];

describe("txErrorMessage", () => {
  it("every message is keyed by a real error name (or one the next IDL adds)", () => {
    for (const name of Object.keys(FUMPAD_ERROR_MESSAGES)) assert.ok(name in FUMPAD_ERROR || name === "PoolDisabled", name);
  });

  it("maps FUMPAD codes by name, Meteora failures generically, and 6058 PoolDisabled", () => {
    assert.match(txErrorMessage("x", fumpadFail(FUMPAD_ERROR.SlippageExceeded)), /slippage/);
    assert.match(txErrorMessage("x", fumpadFail(6058)), /paused on this pool by Meteora/);
    assert.match(txErrorMessage("x", [`Program ${DBC_PROGRAM_ID.toBase58()} failed: custom program error: 0x1772`]), /Meteora rejected/);
    assert.equal(txErrorMessage("plain"), "plain");
  });
});
