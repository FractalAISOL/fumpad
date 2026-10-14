/**
 * Read-only: every FUMPAD event payload and program account on devnet, grouped by name and byte length (which
 * historical layouts the program has written). `RPC_URL` from the environment; never printed. Writes a JSON
 * summary (one sample per layout) to argv[2].
 *
 *   set -a; . ~/fumpad-keys/devnet/rpc.env; set +a; npx tsx scripts/devnet/scan-layouts.ts /tmp/layouts.json
 */
import { writeFileSync } from "node:fs";

import { MeteoraRpc } from "@fumpad/meteora";
import { accountKeys, EVENT_IX_TAG, eventAuthorityPda, eventNameOf, FUMPAD_IDL, FUMPAD_PROGRAM_ID, type TxLike } from "@fumpad/sdk";
import bs58 from "bs58";

const rpc = new MeteoraRpc(process.env.RPC_URL!, { minGapMs: 40 });
const program = FUMPAD_PROGRAM_ID.toBase58();
const auth = eventAuthorityPda().toBase58();
const sigs: { signature: string; slot: number; err: unknown }[] = [];
let before: string | undefined;
for (;;) {
  const page = await rpc.call<{ signature: string; slot: number; err: unknown }[]>("getSignaturesForAddress", [program, { limit: 1000, before, commitment: "finalized" }]);
  sigs.push(...page);
  if (page.length < 1000) break;
  before = page[page.length - 1].signature;
}
console.log("program txs", sigs.length);
type Seen = { n: number; sample: string; slot: number; sig: string };
const ev: Record<string, Record<number, Seen>> = {};
for (const s of sigs) {
  if (s.err) continue;
  const tx = (await rpc.getTransaction(s.signature, "finalized")) as unknown as TxLike | null;
  if (!tx?.meta) continue;
  const keys = accountKeys(tx);
  for (const g of tx.meta.innerInstructions ?? []) {
    for (const i of g.instructions as unknown as { programIdIndex: number; accounts?: number[]; data: string }[]) {
      if (keys[i.programIdIndex] !== program || keys[(i.accounts ?? [])[0]] !== auth) continue;
      const d = bs58.decode(i.data);
      if (!EVENT_IX_TAG.every((x: number, k: number) => d[k] === x)) continue;
      const p = d.subarray(8);
      const name = eventNameOf(p) ?? `unknown:${Buffer.from(p.subarray(0, 8)).toString("hex")}`;
      const e = ((ev[name] ??= {})[p.length] ??= { n: 0, sample: Buffer.from(p).toString("base64"), slot: tx.slot, sig: s.signature });
      e.n++;
      if (tx.slot < e.slot) Object.assign(e, { slot: tx.slot, sig: s.signature, sample: Buffer.from(p).toString("base64") });
    }
  }
}
const accounts: Record<string, Record<string, number>> = {};
const SIZES = [82, 98, 276, 315, 546, 593, 1_044, 1_491, 8_280, 81_976];
for (const a of (FUMPAD_IDL as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts) {
  const disc = { memcmp: { offset: 0, bytes: bs58.encode(Uint8Array.from(a.discriminator)) } };
  const all = await rpc.call<unknown[]>("getProgramAccounts", [program, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 }, filters: [disc] }]);
  const sizes: Record<string, number> = { total: all.length };
  if (all.length) {
    for (const len of SIZES) {
      const n = await rpc.call<unknown[]>("getProgramAccounts", [program, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 0 }, filters: [{ dataSize: len }, disc] }]);
      if (n.length) sizes[len] = n.length;
    }
  }
  accounts[a.name] = sizes;
}
const summary = Object.fromEntries(Object.entries(ev).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([l, x]) => [l, { n: x.n, firstSlot: x.slot, sig: x.sig, sample: x.sample }]))]));
writeFileSync(process.argv[2], JSON.stringify({ programTxs: sigs.length, events: summary, accounts }, null, 1));
for (const [k, v] of Object.entries(ev)) console.log(k, Object.entries(v).map(([l, x]) => `${l}B×${x.n}`).join(" "));
console.log(JSON.stringify(accounts));
