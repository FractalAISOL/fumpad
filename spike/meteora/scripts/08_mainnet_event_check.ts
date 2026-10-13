// (a) Diff EvtSwap2 vs EvtSwap3 on the PartialFill completion tx (devnet).
// (b) Read-only: which DBC swap events do recent MAINNET DBC swaps emit? (no mainnet transactions are sent)
import crypto from "node:crypto";
import bs58 from "bs58";
import { Connection, PublicKey } from "@solana/web3.js";
import { getTx, loadState, saveState, DBC_PROGRAM } from "./common.js";
import { parseSwaps, parseSwapsDbcV2Only, fmt } from "./events.js";

const MAINNET_READONLY = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const evDisc = (n: string) => crypto.createHash("sha256").update(`event:${n}`).digest().subarray(0, 8).toString("hex");
const TAG = "e445a52e51cb9a1d";
const names: Record<string, string> = {};
for (const n of ["EvtSwap", "EvtSwap2", "EvtSwap3", "EvtCurveComplete", "EvtSwap2WithTransferHook", "EvtSwap3WithTransferHook"]) names[evDisc(n)] = n;

async function main() {
  const st = loadState();
  const out: any = {};
  const c = (st.txs as any[]).find((t) => t.label.startsWith("PartialFill"));
  const tx = (await getTx(c.sig))!;
  out.partialFill = { evtSwap3: parseSwaps(tx).map((s) => JSON.parse(fmt(s))), evtSwap2: parseSwapsDbcV2Only(tx).map((s) => JSON.parse(fmt(s))) };
  console.log(JSON.stringify(out.partialFill, null, 2));

  const sigs = await MAINNET_READONLY.getSignaturesForAddress(DBC_PROGRAM, { limit: 40 });
  const seen: Record<string, number> = {};
  let inspected = 0;
  for (const s of sigs) {
    if (s.err) continue;
    const t = await MAINNET_READONLY.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
    if (!t?.meta) continue;
    inspected++;
    for (const g of t.meta.innerInstructions ?? []) for (const i of g.instructions) {
      const d = Buffer.from(bs58.decode(i.data)).toString("hex");
      if (d.startsWith(TAG)) { const n = names[d.slice(16, 32)] ?? "other"; seen[n] = (seen[n] ?? 0) + 1; }
    }
    if (inspected >= 15) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  out.mainnetRecentDbcEvents = { inspectedTxs: inspected, eventCounts: seen };
  console.log(out.mainnetRecentDbcEvents);
  saveState({ eventCheck: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
