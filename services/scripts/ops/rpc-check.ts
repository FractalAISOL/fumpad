/**
 * `npm run rpc-check -- --env <file> [--env <file> …] [--public devnet|mainnet] [--swap-cluster mainnet]`
 *
 * Does an RPC provider serve what the FUMPAD keepers (attestors, watcher, jobs) need? Read-only; the URL is never
 * printed (only a redacted host), errors are redacted. Checks, per provider:
 *   1. cluster (genesis hash) and version
 *   2. getSignaturesForAddress pagination: a busy address (DBC program, `--pages` × 1000) with cursor continuity
 *      (no duplicates, no gaps, slots non-increasing), and a FULL pagination to the oldest signature of a smaller
 *      address (`--full-address`, default the FUMPAD program; capped by `--full-pages`)
 *   3. getTransaction with maxSupportedTransactionVersion 1 for the oldest tx of (2), recent txs, and a
 *      version-1 tx if one is found in recent blocks (web3.js v1 can't decode those; the keepers use MeteoraRpc)
 *   4. getBlock(transactionDetails: "signatures") ordering: contains the tx, identical across providers
 *   5. history floor (L8): getFirstAvailableBlock / minimumLedgerSlot vs `--l8-slot` (default: the slot of the
 *      oldest signature found in (2); attestors refuse coins launched before the floor)
 *   6. rate limits: requests spaced by RPC_MIN_GAP_MS for ≥ 12 s, then a 30-request burst without spacing
 *      (429 count). Gap from the env file, else `--min-gap-ms` (default 0); the spaced run must see no 429, else the
 *      smallest spacing that does is measured and suggested
 *   7. across providers: @fumpad/meteora `parseMeteoraTrades` records for the same finalized signatures must be
 *      byte-identical (canonical JSON, sha256 per tx)
 *
 * `--swap-cluster mainnet` rewrites "devnet" → "mainnet" in each env file's host (Helius-style URLs), for a
 * read-only mainnet check with the same key. Exit code 1 if any check FAILS (WARN doesn't fail).
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { type ConfirmedTx, DBC_PROGRAM_ID, MeteoraRpc, parseMeteoraTrades, type SignatureInfo } from "@fumpad/meteora";
import { FUMPAD_PROGRAM_ID } from "@fumpad/sdk";

import { GENESIS, parseArgs, readEnvValue, redactHost, redactText } from "./common.js";

export interface Provider {
  name: string;
  url: string;
  host: string;
  minGapMs: number;
}

type Verdict = "PASS" | "WARN" | "FAIL" | "INFO";
export interface Finding {
  provider: string;
  check: string;
  verdict: Verdict;
  detail: string;
}

const PUBLIC_GAP_MS = 250;
/** Spaced tests run ≥ 12 s so they span a whole provider window (public: 10 s). */
const sustained = (gapMs: number) => (gapMs > 0 ? Math.max(30, Math.ceil(12_000 / gapMs)) : 30);
const isPublic = (url: string) => /^https?:\/\/api\.(devnet|testnet|mainnet-beta)\.solana\.com/.test(url);
const PUBLIC: Record<string, string> = { devnet: "https://api.devnet.solana.com", mainnet: "https://api.mainnet-beta.solana.com" };

export function providerFromEnvFile(file: string, opts: { swapCluster?: string; defaultGapMs?: number } = {}): Provider {
  let url = readEnvValue(file, "RPC_URL");
  if (!url) throw new Error(`no RPC_URL in ${file}`);
  if (opts.swapCluster) {
    const u = new URL(url);
    if (!u.hostname.includes("devnet")) throw new Error(`${file}: host has no "devnet" to swap`);
    u.hostname = u.hostname.replace("devnet", opts.swapCluster);
    url = u.toString();
  }
  const gap = readEnvValue(file, "RPC_MIN_GAP_MS");
  return { name: file.replace(/^.*\//, "") + (opts.swapCluster ? `→${opts.swapCluster}` : ""), url, host: redactHost(url), minGapMs: gap !== undefined ? Number(gap) : (opts.defaultGapMs ?? 0) };
}

/** Canonical JSON (bigints as "123n") so two providers' records compare byte for byte. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
}
export const tradeDigest = (tx: ConfirmedTx | null) => {
  if (!tx) return "missing";
  const r = parseMeteoraTrades(tx);
  return createHash("sha256").update(canonical({ status: r.status, version: r.version, slot: r.slot, blockTime: r.blockTime, trades: r.trades, issues: r.issues })).digest("hex");
};

/** Pages of getSignaturesForAddress with continuity checks. */
export async function paginate(rpc: MeteoraRpc, address: string, maxPages: number): Promise<{ sigs: SignatureInfo[]; pages: number; exhausted: boolean; problems: string[] }> {
  const sigs: SignatureInfo[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  let before: string | undefined;
  let pages = 0;
  let exhausted = false;
  while (pages < maxPages) {
    const page = await rpc.getSignaturesForAddress(address, { before, limit: 1000, commitment: "finalized" });
    pages++;
    for (const s of page) {
      if (seen.has(s.signature)) problems.push(`duplicate ${s.signature.slice(0, 12)}… on page ${pages}`);
      seen.add(s.signature);
      const prev = sigs[sigs.length - 1];
      if (prev && s.slot > prev.slot) problems.push(`slot went up ${prev.slot} → ${s.slot} on page ${pages}`);
      sigs.push(s);
    }
    if (page.length < 1000) {
      exhausted = true;
      break;
    }
    before = page[page.length - 1].signature;
  }
  return { sigs, pages, exhausted, problems: problems.slice(0, 5) };
}

async function rawBurst(url: string, n: number, gapMs: number): Promise<{ ok: number; limited: number; other: number; ms: number }> {
  const one = async () => {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }), signal: AbortSignal.timeout(15_000) });
      if (r.status === 429) return "limited";
      const j = (await r.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null;
      if (!r.ok || j?.error) return j?.error?.code === 429 || /rate/i.test(String(j?.error?.message)) ? "limited" : "other";
      return "ok";
    } catch {
      return "other";
    }
  };
  const t0 = Date.now();
  const results: string[] = [];
  if (gapMs <= 0) results.push(...(await Promise.all(Array.from({ length: n }, one))));
  else
    for (let i = 0; i < n; i++) {
      results.push(await one());
      await new Promise((r) => setTimeout(r, gapMs));
    }
  return { ok: results.filter((r) => r === "ok").length, limited: results.filter((r) => r === "limited").length, other: results.filter((r) => r === "other").length, ms: Date.now() - t0 };
}

interface BlockAccounts {
  transactions?: { version?: number | "legacy"; transaction: { signatures: string[] } }[];
}

export interface CheckOptions {
  busyAddress?: string;
  fullAddress?: string;
  pages?: number;
  fullPages?: number;
  l8Slot?: number;
  sample?: number;
}

export async function checkProviders(providers: Provider[], o: CheckOptions = {}, log: (s: string) => void = console.log): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (provider: string, check: string, verdict: Verdict, detail: string) => {
    findings.push({ provider, check, verdict, detail });
    log(`${verdict.padEnd(4)} ${provider.padEnd(22)} ${check.padEnd(16)} ${detail}`);
  };
  const busy = o.busyAddress ?? DBC_PROGRAM_ID;
  const full = o.fullAddress ?? FUMPAD_PROGRAM_ID.toBase58();
  // The checks themselves pace public endpoints (documented limit ≈ 40 req / 10 s per method per IP); the
  // rate-limit check below tests the provider's CONFIGURED RPC_MIN_GAP_MS.
  const rpcs = providers.map((p) => new MeteoraRpc(p.url, { minGapMs: Math.max(p.minGapMs, isPublic(p.url) ? PUBLIC_GAP_MS : 0), attempts: 7 }));
  const firstWithUrl = new Map<string, string>();
  const sampleSigs: string[] = [];
  let oldestSlot: number | undefined;
  const blockSlots: number[] = [];

  for (const [i, p] of providers.entries()) {
    const rpc = rpcs[i];
    const dup = firstWithUrl.get(p.url);
    if (dup) {
      add(p.name, "distinct", "WARN", `same endpoint as ${dup}: two keepers on one provider (each attestor needs its own; checks skipped)`);
      continue;
    }
    firstWithUrl.set(p.url, p.name);
    const tag = `${p.name} (${p.host})`.slice(0, 60);
    log(`\n── ${tag} · RPC_MIN_GAP_MS=${p.minGapMs}`);
    const guard = async (check: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        add(p.name, check, "FAIL", redactText((e as Error).message, p.url));
      }
    };
    let cluster = "?";
    await guard("cluster", async () => {
      const g = await rpc.call<string>("getGenesisHash", []);
      cluster = Object.entries(GENESIS).find(([, h]) => h === g)?.[0] ?? "unknown";
      const ver = await rpc.call<{ "solana-core": string }>("getVersion", []);
      add(p.name, "cluster", "INFO", `${cluster}, solana-core ${ver["solana-core"]}`);
    });

    // 2. pagination
    let fullSigs: SignatureInfo[] = [];
    await guard("pagination", async () => {
      const b = await paginate(rpc, busy, o.pages ?? 5);
      const okB = b.problems.length === 0 && (b.exhausted || b.sigs.length === b.pages * 1000);
      add(p.name, "pagination", okB ? "PASS" : "FAIL", `busy ${busy.slice(0, 8)}…: ${b.sigs.length} sigs over ${b.pages} pages, slots ${b.sigs[0]?.slot ?? "-"} → ${b.sigs[b.sigs.length - 1]?.slot ?? "-"}${b.problems.length ? `; ${b.problems.join("; ")}` : ", contiguous, no duplicates"}`);
      if (i === 0) for (const s of b.sigs.filter((s) => !s.err).slice(0, o.sample ?? 20)) sampleSigs.push(s.signature);
      const f = await paginate(rpc, full, o.fullPages ?? 30);
      fullSigs = f.sigs;
      const verdict: Verdict = f.problems.length ? "FAIL" : !f.sigs.length ? "WARN" : f.exhausted ? "PASS" : "WARN";
      add(p.name, "full history", verdict, `${full.slice(0, 8)}…: ${f.sigs.length} sigs, ${f.pages} page(s), ${f.exhausted ? `reached the oldest (slot ${f.sigs[f.sigs.length - 1]?.slot ?? "-"})` : `not exhausted after ${f.pages} pages`}${f.problems.length ? `; ${f.problems.join("; ")}` : ""}`);
      if (f.exhausted && f.sigs.length && i === 0) oldestSlot = f.sigs[f.sigs.length - 1].slot;
    });

    // 3. getTransaction v1
    await guard("getTransaction", async () => {
      const targets: { what: string; sig: string }[] = [];
      if (fullSigs.length) targets.push({ what: "oldest", sig: fullSigs[fullSigs.length - 1].signature });
      if (sampleSigs[0]) targets.push({ what: "recent", sig: sampleSigs[0] });
      const tip = await rpc.getSlot("finalized");
      let v1: string | undefined;
      for (let s = tip - 2, tries = 0; s > tip - 40 && tries < 6 && !v1; s -= 7, tries++) {
        const blk = await rpc.call<BlockAccounts | null>("getBlock", [s, { encoding: "json", transactionDetails: "accounts", rewards: false, maxSupportedTransactionVersion: 1, commitment: "finalized" }]).catch(() => null);
        if (!blk?.transactions) continue;
        blockSlots.push(s);
        v1 = blk.transactions.find((t) => t.version === 1)?.transaction.signatures[0];
      }
      if (v1) targets.push({ what: "version-1", sig: v1 });
      const got: string[] = [];
      for (const t of targets) {
        const tx = await rpc.getTransaction(t.sig, "finalized");
        got.push(`${t.what} ${tx ? `v${tx.version ?? "legacy"} slot ${tx.slot}` : "MISSING"}`);
        if (!tx) throw new Error(`${t.what} tx ${t.sig.slice(0, 12)}… not served (${got.join(", ")})`);
      }
      add(p.name, "getTransaction", v1 ? "PASS" : "WARN", `${got.join(", ")}${v1 ? "" : `; no version-1 tx in the sampled blocks (param accepted, v1 decoding not exercised)`}`);
    });

    // 5. L8 floor
    await guard("history floor", async () => {
      const first = Number(await rpc.call<number>("getFirstAvailableBlock", []));
      const min = Number(await rpc.call<number>("minimumLedgerSlot", []).catch(() => NaN));
      const need = o.l8Slot ?? oldestSlot;
      const detail = `getFirstAvailableBlock ${first}, minimumLedgerSlot ${Number.isNaN(min) ? "n/a" : min}`;
      if (need === undefined) add(p.name, "history floor", "INFO", `${detail} (no L8 reference slot: pass --l8-slot <oldest live coin launch slot>)`);
      else add(p.name, "history floor", first <= need ? "PASS" : "FAIL", `${detail} ${first <= need ? "≤" : ">"} L8 reference slot ${need}${first <= need ? "" : ": attestors would refuse coins older than the floor"}`);
    });

    // 6. rate limits
    await guard("rate limit", async () => {
      const spaced = await rawBurst(p.url, sustained(p.minGapMs), p.minGapMs);
      const burst = await rawBurst(p.url, 30, 0);
      const settle = () => new Promise((r) => setTimeout(r, 11_000)); // let the provider's window reset
      if (burst.limited || spaced.limited) await settle();
      const v: Verdict = spaced.limited > 0 || spaced.other > 0 ? "FAIL" : burst.limited > 0 ? "WARN" : "PASS";
      let advice = "";
      if (v === "FAIL") {
        // smallest spacing (sequential, 20 requests) that sees no 429
        let found: number | undefined;
        for (const gap of [50, 100, 150, 250, 400, 700]) {
          const r = await rawBurst(p.url, sustained(gap), gap);
          if (!r.limited && !r.other) {
            found = gap;
            break;
          }
          await settle();
        }
        advice = found !== undefined ? ` → set RPC_MIN_GAP_MS=${found} (or more) for this provider` : " → no spacing up to 700 ms avoided 429: provider unusable for a keeper";
      }
      add(p.name, "rate limit", v, `burst 30: ${burst.ok} ok / ${burst.limited} × 429 / ${burst.other} other in ${burst.ms} ms; spaced ${p.minGapMs} ms: ${spaced.ok} ok / ${spaced.limited} × 429${advice}${v === "WARN" ? " (keepers back off on 429; keep RPC_MIN_GAP_MS)" : ""}`);
    });
    void cluster;
  }

  // 4 + 7. across providers
  const uniq = providers.map((_, i) => i).filter((i) => firstWithUrl.get(providers[i].url) === providers[i].name);
  if (uniq.length > 1 && sampleSigs.length) {
    log("\n── across providers");
    const digests = new Map<number, string[]>();
    let trades = 0;
    for (const i of uniq) {
      const row: string[] = [];
      for (const s of sampleSigs) {
        const tx = await rpcs[i].getTransaction(s, "finalized").catch(() => null);
        row.push(tradeDigest(tx));
        if (i === 0 && tx) trades += parseMeteoraTrades(tx).trades.length;
      }
      digests.set(i, row);
    }
    const d0 = digests.get(0)!;
    for (const i of uniq.slice(1)) {
      const di = digests.get(i)!;
      const same = di.filter((d, k) => d === d0[k] && d !== "missing").length;
      const missing = di.filter((d) => d === "missing").length;
      add(`${providers[0].name}↔${providers[i].name}`, "trade records", same === sampleSigs.length ? "PASS" : "FAIL", `${same}/${sampleSigs.length} finalized txs parse to byte-identical @fumpad/meteora records${missing ? ` (${missing} not served)` : ""}; ${trades} trades in the sample`);
    }
    const slot = (await rpcs[0].getTransaction(sampleSigs[0], "finalized").catch(() => null))?.slot;
    if (slot !== undefined) {
      const lists = new Map<number, string[] | null>();
      for (const i of uniq) lists.set(i, await rpcs[i].call<{ signatures: string[] } | null>("getBlock", [slot, { encoding: "json", transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 1, commitment: "finalized" }]).then((b) => b?.signatures ?? null, () => null));
      const base = lists.get(0) ?? null;
      for (const i of uniq.slice(1)) {
        const li = lists.get(i) ?? null;
        const ok = !!base && !!li && canonical(base) === canonical(li) && base.includes(sampleSigs[0]);
        add(`${providers[0].name}↔${providers[i].name}`, "block order", ok ? "PASS" : "FAIL", `getBlock(${slot}) signatures: ${base?.length ?? "none"} vs ${li?.length ?? "none"}, ${ok ? "identical order, contains the tx" : "DIFFER"}`);
      }
    }
  }
  return findings;
}

async function main() {
  const args = parseArgs(["check", ...process.argv.slice(2)]);
  const argv = process.argv.slice(2);
  const envs = argv.flatMap((a, i) => (a === "--env" ? [argv[i + 1]] : []));
  const publics = argv.flatMap((a, i) => (a === "--public" ? [argv[i + 1]] : []));
  const swap = args.get("swap-cluster");
  const defaultGap = Number(args.get("min-gap-ms") ?? 0);
  const providers: Provider[] = envs.map((f) => providerFromEnvFile(f, { swapCluster: swap, defaultGapMs: defaultGap }));
  for (const c of publics) {
    if (!PUBLIC[c]) throw new Error("--public devnet|mainnet");
    providers.push({ name: `public-${c}`, url: PUBLIC[c], host: redactHost(PUBLIC[c]), minGapMs: Math.max(defaultGap, PUBLIC_GAP_MS) });
  }
  if (!providers.length) throw new Error("pass at least one --env <file> or --public <cluster>");
  const findings = await checkProviders(providers, {
    busyAddress: args.get("address"),
    fullAddress: args.get("full-address"),
    pages: args.get("pages") ? Number(args.get("pages")) : undefined,
    fullPages: args.get("full-pages") ? Number(args.get("full-pages")) : undefined,
    l8Slot: args.get("l8-slot") ? Number(args.get("l8-slot")) : undefined,
    sample: args.get("sample") ? Number(args.get("sample")) : undefined,
  });
  const fails = findings.filter((f) => f.verdict === "FAIL").length;
  const warns = findings.filter((f) => f.verdict === "WARN").length;
  console.log(`\n${fails ? "✗" : "✓"} ${findings.length} findings: ${fails} FAIL, ${warns} WARN`);
  process.exitCode = fails ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e: Error) => {
    console.error(redactText(`✗ ${e.message}`));
    process.exit(1);
  });
}
