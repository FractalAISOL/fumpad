#!/usr/bin/env node
// Regenerate services/sdk/test/vectors.json from the Rust program math.
import { execFileSync } from "node:child_process";
import { copyFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const crate = join(here, "../sdk/test-vectors");
copyFileSync(join(here, "../../contracts/Cargo.lock"), join(crate, "Cargo.lock"));
const env = { ...process.env, PATH: `${homedir()}/.cargo/bin:${process.env.PATH}` };
const out = execFileSync("cargo", ["run", "--quiet", "--release", "--manifest-path", join(crate, "Cargo.toml")], {
  env,
  maxBuffer: 256 * 1024 * 1024,
  stdio: ["ignore", "pipe", "inherit"],
});
writeFileSync(join(here, "../sdk/test/v06/vectors.json"), out);
console.log(`wrote sdk/test/vectors.json (${out.length} bytes)`);
