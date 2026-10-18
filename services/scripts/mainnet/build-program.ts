/**
 * Build `fumpad.so` for another program id (the mainnet deployment, or the rehearsal's stand-in):
 *
 *   npx tsx scripts/mainnet/build-program.ts --program-keypair ~/fumpad-keys/mainnet/fumpad-program-keypair.json
 *   npx tsx scripts/mainnet/build-program.ts --program-id <pubkey> [--out <dir>]
 *
 * The local (non-docker) path of the mainnet build mechanism (LAUNCH-DAY.md "Verifiable build"): copies contracts/
 * (sources only, no target/) into services/.local/program-build/<id>/, writes the id into the copy's
 * program-ids/mainnet.txt (unless the committed file already holds it) and runs the same build as `anchor build -p
 * fumpad` plus `--features mainnet` (`cargo build-sbf --tools-version v1.57 --arch v3 --features mainnet -- --locked`:
 * exactly the committed Cargo.lock, §9;
 * contracts/.cargo/config.toml included) with a shared target dir; programs/fumpad/build.rs compiles the id in.
 * Nothing else in the program depends on its id (PDAs use `crate::ID`). The checked-in sources are never modified.
 * Prints the .so path, size, sha256 and the solana-verify executable hash (sha256 with trailing zero bytes trimmed);
 * the .so is verified to contain the new id and not the default one.
 *
 * The release build of record is `solana-verify build` (docker) of the commit whose program-ids/mainnet.txt holds the
 * mainnet id; this script is the quick local equivalent (the rehearsal uses it with a stand-in id).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Keypair, PublicKey } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVICES = resolve(here, "../..");
const CONTRACTS = resolve(SERVICES, "../contracts");
const DEFAULT_ID = "5YMFbHZsEaebs1Ac9P8bPe3nfh1oxbemVRcLBAcxS9Fb";
const PATH = `${join(homedir(), ".local/share/solana/install/active_release/bin")}:${join(homedir(), ".cargo/bin")}:/opt/homebrew/bin:${process.env.PATH}`;

export interface BuiltProgram {
  programId: string;
  so: string;
  bytes: number;
  sha256: string;
  /** solana-verify's executable hash (trailing zeros trimmed): what `solana-verify get-program-hash` shows once deployed */
  executableHash: string;
  seconds: number;
}

const containsBytes = (hay: Buffer, needle: Uint8Array) => hay.indexOf(Buffer.from(needle)) >= 0;

/** Does `so` embed `programId` (declare_id! bytes) and not the default devnet id? */
export function soDeclares(so: string, programId: PublicKey): boolean {
  const b = readFileSync(so);
  return containsBytes(b, programId.toBytes()) && (programId.toBase58() === DEFAULT_ID || !containsBytes(b, new PublicKey(DEFAULT_ID).toBytes()));
}

export function buildProgram(programId: PublicKey, o: { outDir?: string; log?: (s: string) => void } = {}): BuiltProgram {
  const log = o.log ?? ((s: string) => console.log(s));
  const id = programId.toBase58();
  const root = resolve(o.outDir ?? join(SERVICES, ".local/program-build"));
  const src = join(root, id);
  rmSync(src, { recursive: true, force: true });
  mkdirSync(src, { recursive: true });
  for (const f of ["Cargo.toml", "Cargo.lock", "Anchor.toml", "rust-toolchain.toml", ".cargo", "programs", "program-ids", "tests"]) {
    if (existsSync(join(CONTRACTS, f))) cpSync(join(CONTRACTS, f), join(src, f), { recursive: true, filter: (p) => !p.includes("/target/") });
  }
  const committed = committedMainnetId();
  if (committed === id) log(`program-ids/mainnet.txt (committed) = ${id}: this is the release build's input`);
  else {
    log(`program-ids/mainnet.txt (committed) = ${committed ?? "unset"}: building a stand-in with ${id} written into the copy`);
    writeFileSync(join(src, "program-ids/mainnet.txt"), `# written by build-program.ts (stand-in build)\n${id}\n`);
  }
  const anchor = join(src, "Anchor.toml");
  writeFileSync(anchor, readFileSync(anchor, "utf8").replace(/^fumpad = ".*"$/m, `fumpad = "${id}"`));
  const target = join(root, "target");
  log(`building fumpad.so for program id ${id} (cargo build-sbf --features mainnet, platform-tools v1.57, sbpf v3; shared target ${target})`);
  const t0 = Date.now();
  execFileSync("cargo", ["build-sbf", "--tools-version", "v1.57", "--arch", "v3", "--manifest-path", join(src, "programs/fumpad/Cargo.toml"), "--sbf-out-dir", join(src, "deploy"), "--features", "mainnet", "--", "--locked"], {
    cwd: src,
    env: { ...process.env, PATH, CARGO_TARGET_DIR: target },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const so = join(src, "deploy/fumpad.so");
  if (!existsSync(so)) throw new Error("build produced no fumpad.so");
  if (!soDeclares(so, programId)) throw new Error("the built .so does not embed the requested program id");
  const b = readFileSync(so);
  const r = { programId: id, so, bytes: b.length, sha256: createHash("sha256").update(b).digest("hex"), executableHash: executableHash(b), seconds: Math.round((Date.now() - t0) / 1000) };
  log(`  ${so}: ${r.bytes} bytes, sha256 ${r.sha256}, executable hash ${r.executableHash} (${r.seconds}s)`);
  return r;
}

/** The id in contracts/program-ids/mainnet.txt (first non-comment line), or null while it is UNSET. */
export function committedMainnetId(file = join(CONTRACTS, "program-ids/mainnet.txt")): string | null {
  const line = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("#"));
  return !line || line === "UNSET" ? null : line;
}

/** `solana-verify get-executable-hash`: sha256 of the program bytes without trailing zero bytes (ProgramData pads). */
export function executableHash(b: Uint8Array): string {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return createHash("sha256").update(b.subarray(0, n)).digest("hex");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  const get = (f: string) => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    const kp = get("--program-keypair");
    const id = kp ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(kp.replace(/^~/, homedir()), "utf8")) as number[])).publicKey : get("--program-id") ? new PublicKey(get("--program-id")!) : null;
    if (!id) throw new Error("pass --program-keypair <file> or --program-id <pubkey>");
    buildProgram(id, { outDir: get("--out") });
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
