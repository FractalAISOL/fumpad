/**
 * READ-ONLY mainnet snapshot for the local mainnet fork (services/scripts/mainnet/rehearsal.ts) and the launch-day
 * program check (services/LAUNCH-DAY.md §1):
 *
 *   npx tsx scripts/mainnet/fork.ts snapshot [--out <dir>]            # dump programs + accounts, print the manifest
 *   npx tsx scripts/mainnet/fork.ts compare  [--tested <manifest>]    # re-dump, compare with what the rehearsal ran
 *
 * Only `get*` JSON-RPC methods are ever called (asserted per request); nothing is signed or sent. The RPC URL comes
 * from `~/fumpad-keys/mainnet/rpc.env` (RPC_URL) when it exists, else `~/fumpad-keys/devnet/rpc.env` with "devnet"
 * → "mainnet" in the host (Helius-style); `MAINNET_RPC_URL` overrides both. It is never printed (errors redacted).
 * Requests are spaced (`--min-gap-ms`, default 2,500: the shared key 429s at 1 req/s) with backoff on 429.
 *
 * What is dumped (everything the FUMPAD stack touches on mainnet that we don't deploy ourselves):
 *   programs  Meteora DBC, DAMM v2, Squads v4, Token-2022, Pyth receiver: the ProgramData payload as the loader
 *             runs it (+ upgrade authority, last deployed slot, sha256, and whether it equals the committed
 *             fixture contracts/tests/fixtures/*.so the test suites ran on)
 *   accounts  DAMM v2 migration config, Squads ProgramConfig, Pyth SOL/USD PriceUpdateV2, WSOL mint, the DBC and
 *             DAMM v2 pool authorities (DBC's fronts the migration flash rent)
 *   numbers   rent-exempt minimums for the sizes in MAINNET-COSTS.md (measured, and checked to be linear),
 *             recent prioritization fees on DBC / DAMM v2 writable accounts
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PublicKey } from "@solana/web3.js";

import {
  DAMM_V2_MIGRATION_CONFIG,
  DAMM_V2_POOL_AUTHORITY,
  DAMM_V2_PROGRAM_ID,
  DBC_POOL_AUTHORITY,
  DBC_PROGRAM_ID,
  PYTH_RECEIVER_PROGRAM_ID,
  PYTH_SOL_USD_ACCOUNT,
  TOKEN_2022_PROGRAM_ID,
  WSOL_MINT,
} from "@fumpad/sdk";

import { GENESIS, readEnvValue, redactText } from "../ops/common.js";

const here = dirname(fileURLToPath(import.meta.url));
export const SERVICES = resolve(here, "../..");
export const FIXTURES = resolve(SERVICES, "../contracts/tests/fixtures");
/** The manifest of the programs the last passing rehearsal ran (committed; LAUNCH-DAY.md compares against it). */
export const TESTED_MANIFEST = join(here, "tested-programs.json");

export const SQUADS_PROGRAM_ID = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
export const SQUADS_PROGRAM_CONFIG = new PublicKey("BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr");
const BPF_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";

export const FORK_PROGRAMS = [
  { name: "dbc", id: DBC_PROGRAM_ID, fixture: "dbc_mainnet.so" },
  { name: "damm_v2", id: DAMM_V2_PROGRAM_ID, fixture: "damm_v2_mainnet.so" },
  { name: "squads_v4", id: SQUADS_PROGRAM_ID, fixture: "squads_v4_mainnet.so" },
  { name: "token_2022", id: TOKEN_2022_PROGRAM_ID, fixture: undefined },
  { name: "pyth_receiver", id: PYTH_RECEIVER_PROGRAM_ID, fixture: undefined },
] as const;

export const FORK_ACCOUNTS = [
  { name: "damm_v2_migration_config", id: DAMM_V2_MIGRATION_CONFIG, fixture: "damm_v2_migration_config_mainnet.json" },
  { name: "squads_program_config", id: SQUADS_PROGRAM_CONFIG, fixture: "squads_v4_program_config_mainnet.json" },
  { name: "pyth_sol_usd", id: PYTH_SOL_USD_ACCOUNT, fixture: undefined },
  { name: "wsol_mint", id: WSOL_MINT, fixture: "wsol_mint.json" },
  { name: "dbc_pool_authority", id: DBC_POOL_AUTHORITY, fixture: undefined },
  { name: "damm_v2_pool_authority", id: DAMM_V2_POOL_AUTHORITY, fixture: undefined },
] as const;

/** Account sizes (bytes) whose rent MAINNET-COSTS.md uses. */
export const RENT_SIZES: Record<string, number> = {
  "0 (system account / rent floor)": 0,
  "program account (36)": 36,
  "Consumed marker (98)": 98,
  "Ticket (276)": 276,
  "Position (315)": 315,
  "Coin (546)": 546,
  "Coin + fee-policy tail (593, wallet-split coins only)": 593,
  "Global (1,491)": 1_491,
  "DBC config (1,048)": 1_048,
  "Observations (8,280)": 8_280,
  "ClaimQueue (81,976)": 81_976,
};

export interface ProgramEntry {
  name: string;
  id: string;
  programData: string | null;
  upgradeAuthority: string | null;
  lastDeployedSlot: number | null;
  payloadBytes: number;
  sha256: string;
  fixture?: string;
  fixtureSha256?: string;
  /** live payload = the fixture bytes followed only by zero padding */
  matchesFixture?: boolean;
  file: string;
}
export interface AccountEntry {
  name: string;
  id: string;
  owner: string;
  lamports: number;
  space: number;
  sha256: string;
  fixture?: string;
  matchesFixture?: boolean;
  file: string;
}
export interface Manifest {
  takenAt: string;
  slot: number;
  genesis: string;
  programs: ProgramEntry[];
  accounts: AccountEntry[];
  rent: { label: string; bytes: number; lamports: number }[];
  /** lamports = (128 + bytes) × perByteYear × exemptionYears, if every measured size fits */
  rentLinear: { perByteTwoYears: number; ok: boolean };
  priorityFees: { program: string; samples: number; p50: number; p75: number; p90: number; max: number }[];
  pyth: { priceUsd: number; publishTime: number; ageSecs: number };
  /** Feature gates the local validator knows, and which of them are NOT active on mainnet (deactivated in the fork). */
  features?: { checked: number; inactiveOnMainnet: string[] };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mainnet RPC URL (never printed). */
export function mainnetRpcUrl(): string {
  if (process.env.MAINNET_RPC_URL) return process.env.MAINNET_RPC_URL;
  const own = join(homedir(), "fumpad-keys/mainnet/rpc.env");
  if (existsSync(own)) {
    const v = readEnvValue(own, "RPC_URL");
    if (v) return v;
  }
  const dev = readEnvValue(join(homedir(), "fumpad-keys/devnet/rpc.env"), "RPC_URL");
  if (!dev) throw new Error("no RPC_URL in ~/fumpad-keys/devnet/rpc.env");
  const u = new URL(dev);
  u.hostname = u.hostname.replace("devnet", "mainnet");
  return u.toString();
}

/** Spaced, read-only JSON-RPC (only `get*` methods; anything else throws before a request is made). */
export class ReadOnlyRpc {
  private last = 0;
  requests = 0;
  constructor(
    private readonly url: string,
    private readonly minGapMs = 2_500,
  ) {}
  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (!/^get[A-Z]/.test(method)) throw new Error(`read-only RPC: refusing ${method}`);
    let lastErr = "";
    for (let attempt = 0; attempt < 8; attempt++) {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
      this.requests++;
      let res: Response;
      try {
        res = await fetch(this.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      } catch (e) {
        lastErr = redactText(String(e), this.url);
        await sleep(1_000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = `HTTP ${res.status}`;
        await sleep(2_000 * 2 ** attempt);
        continue;
      }
      const j = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (j.error) {
        if (j.error.code === 429 || /rate limit/i.test(j.error.message)) {
          lastErr = "rate limited";
          await sleep(2_000 * 2 ** attempt);
          continue;
        }
        throw new Error(`${method}: ${redactText(j.error.message, this.url).slice(0, 200)}`);
      }
      return j.result as T;
    }
    throw new Error(`${method}: gave up (${lastErr})`);
  }
}

type RawAccount = { lamports: number; owner: string; executable: boolean; rentEpoch: number; space?: number; data: [string, string] } | null;

const accountJson = (pubkey: string, a: NonNullable<RawAccount>, data: Buffer) => ({
  pubkey,
  account: { lamports: a.lamports, data: [data.toString("base64"), "base64"], owner: a.owner, executable: a.executable, rentEpoch: 0, space: data.length },
});

/** PriceUpdateV2 (Pyth receiver): price_message at offset 41 → price i64 @+32, exponent i32 @+48, publish_time i64 @+52. */
export function pythPrice(data: Buffer): { priceUsd: number; publishTime: number } {
  const m = 41;
  const price = Number(data.readBigInt64LE(m + 32));
  const expo = data.readInt32LE(m + 48);
  return { priceUsd: price * 10 ** expo, publishTime: Number(data.readBigInt64LE(m + 52)) };
}

/** The live Pyth account with publish_time far in the future, so the local validator always sees a fresh price. */
export function freshPythCopy(file: string, out: string): void {
  const v = JSON.parse(readFileSync(file, "utf8")) as { account: { data: [string, string] } };
  const data = Buffer.from(v.account.data[0], "base64");
  const future = 4_102_444_800n;
  data.writeBigInt64LE(future, 41 + 52);
  data.writeBigInt64LE(future - 1n, 41 + 60);
  v.account.data[0] = data.toString("base64");
  writeFileSync(out, JSON.stringify(v));
}

/** Feature account (bincode Option<u64>): activated iff it exists and byte 0 = 1. */
export async function inactiveOnMainnet(rpc: ReadOnlyRpc, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const r = (await rpc.call<{ value: RawAccount[] }>("getMultipleAccounts", [chunk, { encoding: "base64", commitment: "finalized", dataSlice: { offset: 0, length: 9 } }])).value;
    r.forEach((a, j) => {
      const d = a ? Buffer.from(a.data[0], "base64") : null;
      if (!d || d[0] !== 1) out.push(chunk[j]);
    });
  }
  return out;
}

export async function snapshotMainnet(o: { outDir: string; minGapMs?: number; log?: (s: string) => void; url?: string; featureIds?: string[] }): Promise<Manifest> {
  const log = o.log ?? ((s: string) => console.log(s));
  const url = o.url ?? mainnetRpcUrl();
  const rpc = new ReadOnlyRpc(url, o.minGapMs ?? 2_500);
  mkdirSync(join(o.outDir, "programs"), { recursive: true });
  mkdirSync(join(o.outDir, "accounts"), { recursive: true });
  try {
    const genesis = await rpc.call<string>("getGenesisHash");
    if (genesis !== GENESIS.mainnet) throw new Error("the RPC is not mainnet-beta (genesis hash mismatch)");
    const slot = await rpc.call<number>("getSlot", [{ commitment: "finalized" }]);
    log(`mainnet (read-only) at finalized slot ${slot}`);

    const multi = async (keys: string[]) => (await rpc.call<{ value: RawAccount[] }>("getMultipleAccounts", [keys, { encoding: "base64", commitment: "finalized" }])).value;

    // programs: Program account → ProgramData (tag 3 | slot u64 | Option<authority> | payload)
    const progAccs = await multi(FORK_PROGRAMS.map((p) => p.id.toBase58()));
    const pdKeys = progAccs.map((a, i) => {
      if (!a?.executable) throw new Error(`${FORK_PROGRAMS[i].name}: not an executable account on mainnet`);
      if (a.owner !== BPF_UPGRADEABLE) return null;
      const d = Buffer.from(a.data[0], "base64");
      return new PublicKey(d.subarray(4, 36)).toBase58();
    });
    const pdAccs: RawAccount[] = [];
    for (const k of pdKeys) pdAccs.push(k ? (await multi([k]))[0] : null); // one at a time: each is MBs
    const programs: ProgramEntry[] = FORK_PROGRAMS.map((p, i) => {
      const pd = pdAccs[i];
      const raw = pd ? Buffer.from(pd.data[0], "base64") : Buffer.from(progAccs[i]!.data[0], "base64");
      const payload = pd ? raw.subarray(45) : raw;
      const authority = pd && raw[12] === 1 ? new PublicKey(raw.subarray(13, 45)).toBase58() : null;
      const file = join(o.outDir, "programs", `${p.name}.so`);
      writeFileSync(file, payload);
      const e: ProgramEntry = {
        name: p.name,
        id: p.id.toBase58(),
        programData: pdKeys[i],
        upgradeAuthority: authority,
        lastDeployedSlot: pd ? Number(raw.readBigUInt64LE(4)) : null,
        payloadBytes: payload.length,
        sha256: sha(payload),
        file,
      };
      if (p.fixture && existsSync(join(FIXTURES, p.fixture))) {
        const fx = readFileSync(join(FIXTURES, p.fixture));
        e.fixture = p.fixture;
        e.fixtureSha256 = sha(fx);
        e.matchesFixture = payload.length >= fx.length && sha(payload.subarray(0, fx.length)) === sha(fx) && payload.subarray(fx.length).every((b) => b === 0);
      }
      return e;
    });

    const accs = await multi(FORK_ACCOUNTS.map((a) => a.id.toBase58()));
    const accounts: AccountEntry[] = [];
    let pyth = { priceUsd: 0, publishTime: 0, ageSecs: 0 };
    FORK_ACCOUNTS.forEach((a, i) => {
      const acc = accs[i];
      if (!acc) {
        if (a.name.endsWith("pool_authority")) return; // a pool authority may hold nothing
        throw new Error(`${a.name} ${a.id.toBase58()} missing on mainnet`);
      }
      const data = Buffer.from(acc.data[0], "base64");
      const file = join(o.outDir, "accounts", `${a.name}.json`);
      writeFileSync(file, JSON.stringify(accountJson(a.id.toBase58(), acc, data)));
      const e: AccountEntry = { name: a.name, id: a.id.toBase58(), owner: acc.owner, lamports: acc.lamports, space: data.length, sha256: sha(data), file };
      if (a.fixture && existsSync(join(FIXTURES, a.fixture))) {
        const fx = JSON.parse(readFileSync(join(FIXTURES, a.fixture), "utf8")) as { account: { data: [string, string]; owner: string } };
        e.fixture = a.fixture;
        // the WSOL mint's supply moves every block: compare everything but the supply (bytes 36..44)
        const fxd = Buffer.from(fx.account.data[0], "base64");
        const mask = (b: Buffer) => (a.name === "wsol_mint" ? Buffer.concat([b.subarray(0, 36), b.subarray(44)]) : b);
        e.matchesFixture = fx.account.owner === acc.owner && sha(mask(fxd)) === sha(mask(data));
      }
      if (a.name === "pyth_sol_usd") {
        const p = pythPrice(data);
        pyth = { ...p, ageSecs: Math.round(Date.now() / 1000) - p.publishTime };
        freshPythCopy(file, join(o.outDir, "accounts", "pyth_sol_usd_fresh.json"));
      }
      accounts.push(e);
    });

    const rent: Manifest["rent"] = [];
    for (const [label, bytes] of Object.entries(RENT_SIZES)) rent.push({ label, bytes, lamports: await rpc.call<number>("getMinimumBalanceForRentExemption", [bytes]) });
    const per = rent[0].lamports / 128;
    const rentLinear = { perByteTwoYears: per, ok: rent.every((r) => r.lamports === (128 + r.bytes) * per) };

    const priorityFees: Manifest["priorityFees"] = [];
    for (const [name, keys] of [
      ["dbc (program + pool authority)", [DBC_PROGRAM_ID.toBase58(), DBC_POOL_AUTHORITY.toBase58()]],
      ["damm_v2 (program + pool authority)", [DAMM_V2_PROGRAM_ID.toBase58(), DAMM_V2_POOL_AUTHORITY.toBase58()]],
    ] as const) {
      const r = await rpc.call<{ slot: number; prioritizationFee: number }[]>("getRecentPrioritizationFees", [[...keys]]);
      const xs = r.map((x) => x.prioritizationFee).sort((a, b) => a - b);
      const q = (f: number) => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(f * xs.length))] : 0);
      priorityFees.push({ program: name, samples: xs.length, p50: q(0.5), p75: q(0.75), p90: q(0.9), max: xs.at(-1) ?? 0 });
    }

    const features = o.featureIds?.length ? { checked: o.featureIds.length, inactiveOnMainnet: await inactiveOnMainnet(rpc, o.featureIds) } : undefined;
    const m: Manifest = { takenAt: new Date().toISOString(), slot, genesis, programs, accounts, rent, rentLinear, priorityFees, pyth, features };
    writeFileSync(join(o.outDir, "manifest.json"), `${JSON.stringify(m, null, 2)}\n`);
    log(`  ${rpc.requests} read-only requests · written to ${o.outDir}`);
    return m;
  } catch (e) {
    throw new Error(redactText((e as Error).message, url));
  }
}

export function describeManifest(m: Manifest): string[] {
  const out: string[] = [];
  for (const p of m.programs) {
    const fx = p.fixture ? (p.matchesFixture ? `= tested fixture ${p.fixture}` : `≠ tested fixture ${p.fixture} (${p.fixtureSha256?.slice(0, 12)}…)`) : "(no fixture)";
    out.push(`  program ${p.name.padEnd(14)} ${p.id}  sha256 ${p.sha256.slice(0, 16)}…  ${p.payloadBytes} B  deployed slot ${p.lastDeployedSlot ?? "-"}  authority ${p.upgradeAuthority ?? "none"}  ${fx}`);
  }
  for (const a of m.accounts) out.push(`  account ${a.name.padEnd(24)} ${a.id}  owner ${a.owner.slice(0, 8)}…  ${a.space} B  ${(a.lamports / 1e9).toFixed(6)} SOL${a.fixture ? (a.matchesFixture ? "  = tested fixture" : "  ≠ tested fixture") : ""}`);
  out.push(`  rent: ${m.rentLinear.ok ? "linear" : "NOT linear"}, ${m.rentLinear.perByteTwoYears} lamports per byte (incl. the 128-byte overhead), e.g. ${m.rent.map((r) => `${r.bytes} B → ${(r.lamports / 1e9).toFixed(6)}`).join(", ")} SOL`);
  for (const f of m.priorityFees) out.push(`  priority fees ${f.program}: ${f.samples} slots, p50 ${f.p50} / p75 ${f.p75} / p90 ${f.p90} / max ${f.max} µlamports/CU`);
  if (m.features) out.push(`  feature gates: ${m.features.checked} known to the local validator, ${m.features.inactiveOnMainnet.length} not active on mainnet${m.features.inactiveOnMainnet.length ? ` (${m.features.inactiveOnMainnet.join(", ")})` : ""}`);
  out.push(`  Pyth SOL/USD ${m.pyth.priceUsd.toFixed(2)} (published ${m.pyth.ageSecs}s before the read)`);
  return out;
}

/** What changed between the tested manifest and a fresh one (program bytes, upgrade authorities, account bytes). */
export function compareManifests(tested: Manifest, now: Manifest): string[] {
  const diffs: string[] = [];
  for (const p of tested.programs) {
    const q = now.programs.find((x) => x.name === p.name);
    if (!q) diffs.push(`${p.name}: missing now`);
    else {
      if (q.sha256 !== p.sha256) diffs.push(`${p.name}: program bytes CHANGED (tested ${p.sha256.slice(0, 12)}…, now ${q.sha256.slice(0, 12)}…, deployed slot ${p.lastDeployedSlot} → ${q.lastDeployedSlot})`);
      if (q.upgradeAuthority !== p.upgradeAuthority) diffs.push(`${p.name}: upgrade authority changed ${p.upgradeAuthority} → ${q.upgradeAuthority}`);
    }
  }
  for (const a of tested.accounts) {
    if (a.name === "pyth_sol_usd" || a.name === "wsol_mint" || a.name.endsWith("pool_authority")) continue; // move every block
    const b = now.accounts.find((x) => x.name === a.name);
    if (!b) diffs.push(`${a.name}: missing now`);
    else if (b.sha256 !== a.sha256 || b.owner !== a.owner) diffs.push(`${a.name}: account data CHANGED`);
  }
  return diffs;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const cmd = argv[0];
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = resolve(get("--out") ?? join(SERVICES, ".local/mainnet-snapshot", stamp));
  const minGapMs = Number(get("--min-gap-ms") ?? 2_500);
  try {
    if (cmd === "snapshot") {
      const m = await snapshotMainnet({ outDir, minGapMs });
      for (const l of describeManifest(m)) console.log(l);
    } else if (cmd === "compare") {
      const testedPath = resolve(get("--tested") ?? TESTED_MANIFEST);
      const tested = JSON.parse(readFileSync(testedPath, "utf8")) as Manifest;
      const m = await snapshotMainnet({ outDir, minGapMs });
      for (const l of describeManifest(m)) console.log(l);
      const d = compareManifests(tested, m);
      console.log(d.length ? `\n✗ ${d.length} difference(s) vs the rehearsed set (${testedPath}, taken ${tested.takenAt}):\n  - ${d.join("\n  - ")}\n→ re-run \`npm run mainnet:rehearsal\` before launching` : `\n✓ mainnet programs + accounts = what the rehearsal ran (${tested.takenAt})`);
      process.exit(d.length ? 1 : 0);
    } else {
      console.error("usage: fork.ts snapshot [--out dir] | compare [--tested manifest.json]  [--min-gap-ms 2500]");
      process.exit(2);
    }
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
