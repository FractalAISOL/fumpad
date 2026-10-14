// The indexer decodes the same fumpad events as the keepers (SDK decodeFumpadEvents at ingest, decodeEventRaw on
// replay): events from earlier program versions (devnet HAwjL35…, pre-fee-policy) must ingest and replay identically.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { TxLike } from "@fumpad/sdk";

import { indexedEvents } from "../src/ingest.js";
import { decodeStored } from "../src/replay.js";

const COIN = JSON.parse(readFileSync(new URL("../../sdk/test/vectors/devnet-HAwjL35.json", import.meta.url), "utf8")) as { txs: { events: string[]; tx: TxLike }[] };
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x && typeof x === "object" && "toBase58" in x ? (x as { toBase58(): string }).toBase58() : x));

describe("indexer: legacy devnet events", () => {
  it("ingest decodes every event of HAwjL35…; replay of the stored raw gives the same data", () => {
    let n = 0;
    for (const { tx, events } of COIN.txs) {
      const evs = indexedEvents(tx).filter((e) => e.program === "fumpad");
      expect(evs.map((e) => e.name)).toEqual(events);
      for (const e of evs) {
        expect(json(decodeStored("fumpad", e.name, e.index, e.raw)!.data)).toBe(json(e.data));
        n++;
      }
    }
    expect(n).toBeGreaterThan(15);
    const reg = COIN.txs.flatMap(({ tx }) => indexedEvents(tx)).find((e) => e.name === "CoinRegistered")!;
    expect((reg.data.feePolicy as { kind: number }).kind).toBe(0); // 160-byte event → standard policy
  });
});
