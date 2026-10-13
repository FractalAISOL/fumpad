// Key separation: the jobs keeper runs only with an operator key, an attestor never with one (role.ts).
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { roleProblem } from "../src/role.js";

const [a0, a1, a2, op] = [0, 1, 2, 3].map(() => Keypair.generate().publicKey);
const g = { keepers: [a0, a1, a2], operators: [op, PublicKey.default] };

describe("key roles", () => {
  it("jobs mode: operator only", () => {
    expect(roleProblem("jobs", g, op)).toBeNull();
    expect(roleProblem("jobs", g, a0)).toMatch(/attestor key/);
    expect(roleProblem("jobs", g, Keypair.generate().publicKey)).toMatch(/not an operator/);
    expect(roleProblem("jobs", { keepers: [a0], operators: [a0] }, a0)).toMatch(/set_operators/);
  });
  it("attestor mode: never an operator key", () => {
    expect(roleProblem("attestor", g, a1)).toBeNull();
    expect(roleProblem("attestor", g, op)).toMatch(/operator \(jobs\) key/);
    expect(roleProblem("attestor", { keepers: [a0], operators: [a0] }, a0)).toMatch(/operator \(jobs\) key/);
    // not yet in the set: the attestor idles (not_active_keeper), it doesn't refuse to start
    expect(roleProblem("attestor", g, Keypair.generate().publicKey)).toBeNull();
  });
  it("tolerates a Global decoded without operators", () => {
    expect(roleProblem("attestor", { keepers: [a0] } as never, a0)).toBeNull();
    expect(roleProblem("jobs", { keepers: [a0] } as never, op)).toMatch(/not an operator/);
  });
});
