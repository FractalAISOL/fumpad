/**
 * Guardian `void_ticket` for one or more tickets. Simulates by default; `--yes` sends.
 *
 *   npx tsx scripts/ops/void-ticket.ts <ticket> [<ticket> …] [--reopen] [--reason <u8>] \
 *     [--env ~/fumpad-keys/devnet/rpc.env] [--keypair ~/.config/solana/id.json] [--yes]
 *
 * Devnet: guardian = admin = deployer (~/.config/solana/id.json). Mainnet: the guardian is a Squads vault —
 * use scripts/ops/multisig.ts instead; this script refuses mainnet.
 * Prints per ticket: status, effective attestation time, challenge-window end, then the simulation / signature.
 * The program only accepts `void_ticket` on an OPEN ticket inside its challenge window
 * (attested_at + params.ticket_challenge_secs); outside it the simulation shows ChallengeWindowOver.
 */
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";

import { decodeGlobal, decodeTicket, globalPda, voidTicketIx } from "@fumpad/sdk";

import { detectCluster, readEnvValue, readKeypair, redactHost, redactText } from "./common.js";

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const flags = new Set(["--reopen", "--yes"]);
const valued = new Set(["--reason", "--env", "--keypair"]);
const tickets: PublicKey[] = [];
for (let i = 0; i < args.length; i++) {
  if (flags.has(args[i])) continue;
  if (valued.has(args[i])) {
    i++;
    continue;
  }
  tickets.push(new PublicKey(args[i]));
}
if (!tickets.length) {
  console.error("usage: void-ticket.ts <ticket> [<ticket> …] [--reopen] [--reason n] [--env file] [--keypair file] [--yes]");
  process.exit(2);
}

const url = readEnvValue(opt("--env", "~/fumpad-keys/devnet/rpc.env")!, "RPC_URL");
if (!url) throw new Error("RPC_URL missing in the env file");
const conn = new Connection(url, "confirmed");
const guardian = readKeypair(opt("--keypair", "~/.config/solana/id.json")!);
const send = args.includes("--yes");
const reopen = args.includes("--reopen");
const reason = Number(opt("--reason", "1"));

async function main() {
  const cluster = await detectCluster(conn);
  console.log(`rpc ${redactHost(url!)} (${cluster}); guardian ${guardian.publicKey.toBase58()}; ${send ? "SEND" : "simulate"}`);
  if (cluster === "mainnet") throw new Error("refusing mainnet: the guardian is a multisig there (scripts/ops/multisig.ts)");
  const gInfo = await conn.getAccountInfo(globalPda());
  if (!gInfo) throw new Error("no Global");
  const g = decodeGlobal(gInfo.data);
  if (!g.guardian.equals(guardian.publicKey) && !g.admin.equals(guardian.publicKey))
    throw new Error(`keypair is neither guardian (${g.guardian.toBase58()}) nor admin (${g.admin.toBase58()})`);
  const challenge = Number(g.params.ticketChallengeSecs);
  const now = Math.floor(Date.now() / 1000);
  let failed = 0;
  for (const ticket of tickets) {
    const info = await conn.getAccountInfo(ticket);
    if (!info) {
      console.log(`${ticket.toBase58()}: no such account`);
      failed++;
      continue;
    }
    const t = decodeTicket(info.data);
    const ends = Number(t.attestedAt) + challenge;
    console.log(
      `${ticket.toBase58()}: status=${t.status} mint=${t.mint.toBase58()} owner=${t.owner.toBase58()} attested_at=${new Date(Number(t.attestedAt) * 1000).toISOString()} challenge ends ${new Date(ends * 1000).toISOString()} (${ends > now ? `${ends - now}s left` : "OVER"})`,
    );
    const ixs = [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
      voidTicketIx({ authority: guardian.publicKey, ticket, mint: t.mint, owner: t.owner, consumed: t.consumed, reason, reopen }),
    ];
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: guardian.publicKey, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
    tx.sign([guardian]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: true });
    if (sim.value.err) {
      failed++;
      console.log(`  simulation FAILED: ${JSON.stringify(sim.value.err)}`);
      for (const l of (sim.value.logs ?? []).filter((l) => /Error|failed/i.test(l))) console.log(`    ${l}`);
      continue;
    }
    console.log(`  simulation ok (${sim.value.unitsConsumed} CU)`);
    if (!send) continue;
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    console.log(`  voided: ${sig}`);
  }
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(redactText(String(e), url));
  process.exit(1);
});
