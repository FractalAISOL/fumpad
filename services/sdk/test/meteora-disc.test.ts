import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { METEORA_ACCOUNT_DISCRIMINATOR } from "../src/index.js";

describe("Meteora account discriminators", () => {
  it("are sha256('account:<Name>')[..8]", () => {
    const d = (n: string) => Uint8Array.from(createHash("sha256").update(`account:${n}`).digest().subarray(0, 8));
    expect(METEORA_ACCOUNT_DISCRIMINATOR.dbcPoolConfig).toEqual(d("PoolConfig"));
    expect(METEORA_ACCOUNT_DISCRIMINATOR.dbcVirtualPool).toEqual(d("VirtualPool"));
    expect(METEORA_ACCOUNT_DISCRIMINATOR.dammPool).toEqual(d("Pool"));
  });
});
