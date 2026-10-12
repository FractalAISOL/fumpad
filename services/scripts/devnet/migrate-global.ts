/**
 * Upgrade the devnet Global (v0.3/v0.4 layout, 672 bytes) to the current layout in place with
 * `migrate_global`. Run right AFTER the fumpad program upgrade — every instruction that loads
 * Global fails until this lands. Idempotent: on a current Global it only prints it.
 *
 *   npx tsx scripts/devnet/migrate-global.ts [--window 4] [--start-bps 9900] [--simulate]
 *
 * Signer = Global.admin = ~/.config/solana/id.json (pays the ~0.0000557 SOL extra rent + fee).
 */
import fs from "node:fs";
import os from "node:os";

import { Connection, Keypair, Transaction } from "@solana/web3.js";

import { decodeGlobal, GLOBAL_ACCOUNT_LEN, globalNeedsMigration, globalPda, migrateGlobalIx } from "@fumpad/sdk";

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const arg = (name: string, def: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
};
const window = Number(arg("window", "4"));
const startBps = Number(arg("start-bps", "9900"));
const simulate = process.argv.includes("--simulate");

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(`${os.homedir()}/.config/solana/id.json`, "utf8"))));
const conn = new Connection(RPC, "confirmed");

const show = async (label: string) => {
  const a = await conn.getAccountInfo(globalPda());
  if (!a) throw new Error("Global not initialized");
  const g = decodeGlobal(new Uint8Array(a.data));
  console.log(`${label}: ${a.data.length} bytes (current ${GLOBAL_ACCOUNT_LEN}), ${a.lamports} lamports, admin ${g.admin.toBase58()}`);
  console.log(`  snipe window ${g.params.snipeWindowSlots} slots, start ${g.params.snipeStartBps} bps, graduation fee ${g.params.graduationFeeLamports}, pending eta ${g.pendingEta}`);
  return { data: new Uint8Array(a.data), g };
};

const { data, g } = await show("before");
if (!globalNeedsMigration(data)) {
  console.log("Global is already current — nothing to do.");
  process.exit(0);
}
if (!g.admin.equals(admin.publicKey)) throw new Error(`signer ${admin.publicKey.toBase58()} is not Global.admin ${g.admin.toBase58()}`);
const tx = new Transaction().add(migrateGlobalIx({ admin: admin.publicKey, snipeWindowSlots: window, snipeStartBps: startBps }));
tx.feePayer = admin.publicKey;
tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
tx.sign(admin);
if (simulate) {
  const sim = await conn.simulateTransaction(tx);
  console.log(sim.value.err ? `simulation FAILED: ${JSON.stringify(sim.value.err)}` : "simulation ok");
  console.log((sim.value.logs ?? []).join("\n"));
  process.exit(sim.value.err ? 1 : 0);
}
const sig = await conn.sendRawTransaction(tx.serialize());
await conn.confirmTransaction(sig, "confirmed");
console.log(`migrate_global: https://solscan.io/tx/${sig}?cluster=devnet`);
await show("after");
