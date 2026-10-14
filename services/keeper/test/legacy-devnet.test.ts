// Regression (devnet 2026-10-14): attestor-1/2/3 and the watcher failed every tick on HAwjL35… — its history holds
// FUMPAD events written before the fee-policy upgrade (160-byte CoinRegistered, 82-byte FeesClaimed) and the decoder
// read past their end. Real finalized txs of that coin (sdk/test/vectors/devnet-HAwjL35.json, trimmed).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { HistoryTx } from "@fumpad/engine";

import { lifecycleEvents } from "../src/attest/derive.js";
import { onchainAttestations } from "../src/watch/verify.js";

const COIN = JSON.parse(readFileSync(new URL("../../sdk/test/vectors/devnet-HAwjL35.json", import.meta.url), "utf8")) as { mint: string; txs: HistoryTx[] };
const ALICE = "9zLVbFe9uSfwL9HzdVGX4T1UJfoG8DQD3rWdqpfTWcdN";
const BOB = "6uCk7vSeYyu7NYyg4EvFu6gaijPri2NcS8Sr22Kzu5E5";
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x && typeof x === "object" && "toBase58" in x ? (x as { toBase58(): string }).toBase58() : x));

describe("devnet coin HAwjL35… (pre-fee-policy events)", () => {
  it("attestor lifecycle: its two earlier tickets (alice, bob), deterministic across keepers", () => {
    const life = lifecycleEvents(COIN.mint, COIN.txs);
    const att = life.filter((e) => e.kind === "ticket_attested") as { owner?: string; ticket: string }[];
    expect(att.map((e) => e.owner)).toEqual([ALICE, BOB]);
    expect(att.map((e) => e.ticket)).toEqual(["DQn5aHjwJ7cPMnwPFsoEKDTLnt2NxEDLjhnN7CJUpp57", "EJQQbYzvtpgnaiPUmgDdJZSx1G8Mhj1pkygb3obEbhEx"]);
    // a second keeper decoding the same finalized txs (fresh copies) derives byte-identical records
    expect(json(lifecycleEvents(COIN.mint, structuredClone(COIN.txs)))).toBe(json(life));
  });

  it("watcher: on-chain attestations of the coin decode (effective time present, one rebuy debit)", () => {
    const { sells, debits, voided } = onchainAttestations(COIN.mint, COIN.txs);
    expect(sells.map((s) => s.ev.owner.toBase58())).toEqual([ALICE, BOB]);
    for (const s of sells) expect(s.ev.effectiveAt >= s.ev.ts).toBe(true);
    expect(debits).toHaveLength(1);
    expect(voided.size).toBe(0);
  });
});
