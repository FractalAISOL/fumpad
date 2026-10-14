// Record a golden fixture for PYTH_SOURCE=onchain from Solana MAINNET (read-only) and cross-check it:
//   FUMPAD_RPC_ENV_FILE=~/fumpad-keys/devnet/rpc.env FUMPAD_PYTH_ENV_FILE=~/fumpad-keys/devnet/pyth.env \
//     npx tsx engine/scripts/record-pyth-onchain.ts [spanSecs=900] [samples=24]
// 1. Records the finalized signature lists of the SOL/USD push account and the push-oracle program over the
//    last `spanSecs`, the candidate transactions (A ∩ P) and the account's current data.
// 2. Answers sample trade times with two independent OnchainPythSource instances: provider A (Helius
//    mainnet, from FUMPAD_RPC_ENV_FILE / MAINNET_RPC_URL) and provider B (public api.mainnet-beta, or
//    PYTH_CHECK_RPC_B) — the outputs must be identical (determinism across providers).
// 3. For every on-chain write, asks Hermes for the same publish_time (Authorization: Bearer, key from
//    FUMPAD_PYTH_ENV_FILE / PYTH_API_KEY; skipped without one) and records whether the prices match.
// Writes engine/test/fixtures/pyth-onchain.mainnet.json.gz. No URL or key is ever printed or stored.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { type ConfirmedTx, MeteoraRpc, type SignatureInfo } from "@fumpad/meteora";

import { decodeOnchainWrites, OnchainPythSource, PYTH_PUSH_ORACLE_PROGRAM_ID, PYTH_SOL_USD_FEED_ID, PYTH_SOL_USD_PUSH_ACCOUNT, type PythPrice, selectUpdate } from "../src/index.js";
// @ts-expect-error untyped .mjs helper
import { mainnetRpcUrl, PUBLIC_MAINNET } from "../../meteora/scripts/rpc-url.mjs";

const span = Number(process.argv[2] ?? 900);
const nSamples = Number(process.argv[3] ?? 24);
const MAX_DELTA = 60;
const urlA = mainnetRpcUrl() as string;
const urlB = process.env.PYTH_CHECK_RPC_B || (PUBLIC_MAINNET as string);
if (urlA === urlB) throw new Error("provider A and B are the same URL: set FUMPAD_RPC_ENV_FILE or MAINNET_RPC_URL");
const rpcA = new MeteoraRpc(urlA, { minGapMs: 120, attempts: 10 });
const rpcB = new MeteoraRpc(urlB, { minGapMs: 1_100, attempts: 10 });
const log = (m: string) => process.stderr.write(`${m}\n`);

const pythKey = (() => {
  if (process.env.PYTH_API_KEY) return process.env.PYTH_API_KEY;
  if (!process.env.FUMPAD_PYTH_ENV_FILE) return undefined;
  return /^\s*(?:export\s+)?PYTH_API_KEY\s*=\s*["']?([^"'\s]+)/m.exec(readFileSync(process.env.FUMPAD_PYTH_ENV_FILE, "utf8"))?.[1];
})();

// 1. raw lists + candidate txs (provider A); the account first, so its last write is inside the lists
const acct = await rpcA.call<{ context: { slot: number }; value: { data: [string, string]; owner: string } }>("getAccountInfo", [PYTH_SOL_USD_PUSH_ACCOUNT, { encoding: "base64", commitment: "finalized" }]);
const headSlot = await rpcA.getSlot("finalized");
const headTime = (await rpcA.call<number>("getBlockTime", [headSlot])) as number;
const tStart = headTime - span;
const list = async (address: string) => {
  const out: Pick<SignatureInfo, "signature" | "slot" | "err" | "blockTime">[] = [];
  let before: string | undefined;
  for (;;) {
    const pg = await rpcA.getSignaturesForAddress(address, { limit: 1_000, commitment: "finalized", ...(before ? { before } : {}) });
    for (const s of pg) if (s.slot <= headSlot && (s.blockTime as number) >= tStart) out.push({ signature: s.signature, slot: s.slot, err: s.err ?? null, blockTime: s.blockTime });
    if (pg.length < 1_000 || (pg[pg.length - 1].blockTime as number) < tStart) return out;
    before = pg[pg.length - 1].signature;
  }
};
const a = await list(PYTH_SOL_USD_PUSH_ACCOUNT);
const p = await list(PYTH_PUSH_ORACLE_PROGRAM_ID);
const ps = new Set(p.map((s) => s.signature));
const cand = a.filter((s) => ps.has(s.signature) && s.err === null);
log(`lists: account ${a.length} (${a.filter((s) => s.err).length} failed), push program ${p.length}, candidates ${cand.length}`);
const txs: Record<string, ConfirmedTx> = {};
for (const s of cand) txs[s.signature] = (await rpcA.getTransaction(s.signature, "finalized")) as ConfirmedTx;
const writes = cand.flatMap((s) => decodeOnchainWrites(txs[s.signature])).sort((x, y) => x.slot - y.slot);
log(`writes: ${writes.length}; publish_time gaps ${writes.slice(1).map((w, i) => w.publishTime - writes[i].publishTime).join(",")}`);

// 2. samples answered independently on both providers
let seed = headSlot;
const rnd = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
const lo = tStart + MAX_DELTA + 30 + 5;
const hi = headTime - 1 - 20 - 30 - 60; // leave room for the finalized/index margins
const times = new Set<number>();
for (const w of writes) for (const t of [w.publishTime, w.publishTime - 1, w.publishTime + 1, w.publishTime + MAX_DELTA, w.publishTime + MAX_DELTA + 1]) if (t >= lo && t <= hi) times.add(t);
for (let i = 0; i < nSamples; i++) times.add(lo + Math.floor(rnd() * (hi - lo)));
const sampleTimes = [...times].sort((x, y) => x - y);
const srcA = new OnchainPythSource(rpcA);
const srcB = new OnchainPythSource(rpcB);
const ser = (x: PythPrice | null) => (x ? { price: x.price.toString(), conf: x.conf.toString(), expo: x.expo, publishTime: x.publishTime } : null);
const samples: { t: number; a: ReturnType<typeof ser>; b: ReturnType<typeof ser>; windowA: string[]; windowB: string[] }[] = [];
for (const t of sampleTimes) {
  const ra = ser(await srcA.priceAt(t, MAX_DELTA));
  const wa = (await srcA.writesFor(t, MAX_DELTA)).map((w) => w.signature).sort();
  const rb = ser(await srcB.priceAt(t, MAX_DELTA));
  const wb = (await srcB.writesFor(t, MAX_DELTA)).map((w) => w.signature).sort();
  samples.push({ t, a: ra, b: rb, windowA: wa, windowB: wb });
}
const same = samples.filter((s) => JSON.stringify([s.a, s.windowA]) === JSON.stringify([s.b, s.windowB])).length;
log(`determinism: ${same}/${samples.length} identical across providers; nulls ${samples.filter((s) => !s.a).length}`);
log(`rpc calls: A ${JSON.stringify(srcA.stats)} B ${JSON.stringify(srcB.stats)}`);

// 3. Hermes at the same publish_time
const hermes: { publishTime: number; onchain: ReturnType<typeof ser>; hermesUpdates: number | null; anyEqual: boolean | null; selectedEqual: boolean | null }[] = [];
for (const w of writes) {
  if (!pythKey) {
    hermes.push({ publishTime: w.publishTime, onchain: ser(w), hermesUpdates: null, anyEqual: null, selectedEqual: null });
    continue;
  }
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    await new Promise((r) => setTimeout(r, 1_200 * 2 ** Math.min(attempt, 4))); // Hermes rate-limits bursts (429)
    res = await fetch(`https://hermes.pyth.network/v2/updates/price/${w.publishTime}?ids%5B%5D=${PYTH_SOL_USD_FEED_ID}&parsed=true`, { headers: { Authorization: `Bearer ${pythKey}` } });
    if (res.status !== 429 || attempt >= 6) break;
  }
  if (!res.ok) {
    hermes.push({ publishTime: w.publishTime, onchain: ser(w), hermesUpdates: -res.status, anyEqual: null, selectedEqual: null });
    continue;
  }
  const j = (await res.json()) as { parsed?: { price: { price: string; conf: string; expo: number; publish_time: number }; metadata?: { slot?: number } }[] };
  const ups = (j.parsed ?? []).map((x) => ({ price: BigInt(x.price.price), conf: BigInt(x.price.conf), expo: x.price.expo, publishTime: x.price.publish_time, slot: x.metadata?.slot ?? null }));
  const eq = (u: PythPrice) => u.price === w.price && u.conf === w.conf && u.expo === w.expo && u.publishTime === w.publishTime;
  const sel = selectUpdate(ups, w.publishTime);
  hermes.push({ publishTime: w.publishTime, onchain: ser(w), hermesUpdates: ups.length, anyEqual: ups.some(eq), selectedEqual: sel ? eq(sel) : false });
}
if (pythKey) log(`hermes: ${hermes.filter((h) => h.anyEqual).length}/${hermes.length} on-chain writes equal a Hermes update at the same publish_time; ${hermes.filter((h) => h.selectedEqual).length} equal Hermes' pick`);

const out = {
  recordedAt: new Date().toISOString(),
  head: { slot: headSlot, blockTime: headTime },
  span,
  account: PYTH_SOL_USD_PUSH_ACCOUNT,
  lists: { account: a, program: p },
  txs,
  accountState: { slot: acct.context.slot, owner: acct.value.owner, data: acct.value.data[0] },
  maxDeltaSecs: MAX_DELTA,
  samples,
  hermes,
};
const file = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/pyth-onchain.mainnet.json.gz");
writeFileSync(file, gzipSync(JSON.stringify(out), { level: 9 }));
log(`→ ${file}`);
