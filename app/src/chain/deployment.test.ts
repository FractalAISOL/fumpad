/**
 * Build-time FUMPAD deployment config (NEXT_PUBLIC_FUMPAD_PROGRAM_ID / NEXT_PUBLIC_FUMPAD_CLUSTER) and the
 * security property that depends on it: the silent-signing allow-list accepts the configured program id and
 * nothing else — not the devnet default, not another id — and refuses to load when the SDK disagrees with it.
 * The configured-id cases run in a child process with the env a mainnet build would have (next.config.ts maps
 * NEXT_PUBLIC_FUMPAD_* onto the SDK's FUMPAD_*).
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { FUMPAD_PROGRAM_ID, setAutoClaimIx } from "@fumpad/sdk";
import { configuredProgram, SilentSignRefused, vetFumpadTx } from "./allowlist";
import { DEVNET_PROGRAM_ADDRESS, FUMPAD_PROGRAM_ADDRESS, resolveDeployment } from "./cluster";

const MAINNET_ID = Keypair.generate().publicKey.toBase58();
const MAINNET_RPC = "https://mainnet.example-rpc.com/?api-key=x";
const APP = join(__dirname, "../..");

describe("resolveDeployment", () => {
  it("unset = the devnet deployment, cluster inferred from the RPC (backward compatible)", () => {
    assert.deepEqual(resolveDeployment({ rpc: "https://devnet.helius-rpc.com/?api-key=x" }), { program: DEVNET_PROGRAM_ADDRESS, cluster: "devnet", explicitCluster: false });
    assert.equal(resolveDeployment({}).cluster, "mainnet");
    assert.equal(resolveDeployment({ programId: "", cluster: "" }).program, DEVNET_PROGRAM_ADDRESS);
  });
  it("an explicit id + cluster", () => {
    assert.deepEqual(resolveDeployment({ rpc: MAINNET_RPC, programId: ` ${MAINNET_ID} `, cluster: "Mainnet" }), { program: MAINNET_ID, cluster: "mainnet", explicitCluster: true });
    assert.equal(resolveDeployment({ rpc: "http://127.0.0.1:8899", cluster: "localnet" }).cluster, "localnet");
  });
  it("refuses a malformed id, an unknown cluster, an id without a cluster, mainnet on a devnet RPC", () => {
    assert.throws(() => resolveDeployment({ programId: "0OIl-not-base58" }), /not a base58/);
    assert.throws(() => resolveDeployment({ cluster: "mainnet-beta" }), /expected mainnet, devnet or localnet/);
    assert.throws(() => resolveDeployment({ rpc: MAINNET_RPC, programId: MAINNET_ID }), /set NEXT_PUBLIC_FUMPAD_CLUSTER/);
    assert.throws(() => resolveDeployment({ rpc: "https://api.devnet.solana.com", programId: MAINNET_ID, cluster: "mainnet" }), /looks like devnet/);
  });
  it("APP-4: a mainnet build without a program id fails instead of falling back to the devnet program", () => {
    // explicit mainnet, live or not
    assert.throws(() => resolveDeployment({ rpc: MAINNET_RPC, cluster: "mainnet" }), /needs NEXT_PUBLIC_FUMPAD_PROGRAM_ID/);
    assert.throws(() => resolveDeployment({ rpc: MAINNET_RPC, cluster: "mainnet", live: true }), /needs NEXT_PUBLIC_FUMPAD_PROGRAM_ID/);
    // a live build on a mainnet RPC (or the default public mainnet RPC) with nothing configured
    assert.throws(() => resolveDeployment({ rpc: MAINNET_RPC, live: true }), /needs NEXT_PUBLIC_FUMPAD_PROGRAM_ID/);
    assert.throws(() => resolveDeployment({ live: true }), /needs NEXT_PUBLIC_FUMPAD_PROGRAM_ID/);
    // still fine: devnet (inferred or explicit) and localnet on the default devnet id, a configured mainnet id, the mock (no API)
    assert.equal(resolveDeployment({ rpc: "https://devnet.helius-rpc.com/?api-key=x", live: true }).program, DEVNET_PROGRAM_ADDRESS);
    assert.equal(resolveDeployment({ rpc: "https://rpc.example.com", cluster: "devnet", live: true }).cluster, "devnet");
    assert.equal(resolveDeployment({ rpc: "http://127.0.0.1:8899", cluster: "localnet", live: true }).cluster, "localnet");
    assert.equal(resolveDeployment({ rpc: MAINNET_RPC, programId: MAINNET_ID, cluster: "mainnet", live: true }).program, MAINNET_ID);
    assert.equal(resolveDeployment({ rpc: MAINNET_RPC }).program, DEVNET_PROGRAM_ADDRESS);
  });
  it("this test run uses the default (no NEXT_PUBLIC_FUMPAD_PROGRAM_ID): app and SDK agree", () => {
    if (!process.env.NEXT_PUBLIC_FUMPAD_PROGRAM_ID) assert.equal(FUMPAD_PROGRAM_ADDRESS, DEVNET_PROGRAM_ADDRESS);
    assert.equal(FUMPAD_PROGRAM_ID.toBase58(), FUMPAD_PROGRAM_ADDRESS);
  });
});

describe("allow-list program binding", () => {
  it("configuredProgram refuses an SDK/app disagreement and a non-canonical id", () => {
    assert.equal(configuredProgram(new PublicKey(MAINNET_ID), MAINNET_ID).toBase58(), MAINNET_ID);
    assert.throws(() => configuredProgram(new PublicKey(DEVNET_PROGRAM_ADDRESS), MAINNET_ID), /FUMPAD program mismatch/);
    assert.throws(() => configuredProgram(new PublicKey(MAINNET_ID), DEVNET_PROGRAM_ADDRESS), /FUMPAD program mismatch/);
  });

  it("default build: a FUMPAD-shaped instruction under any other program id is refused", () => {
    const wallet = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const ix = setAutoClaimIx(wallet, mint, true);
    const tx = (i: TransactionInstruction) =>
      new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: [i] }).compileToV0Message());
    vetFumpadTx(tx(ix), wallet, { action: "auto-claim", mint: mint.toBase58() });
    const foreign = new TransactionInstruction({ programId: new PublicKey(MAINNET_ID), keys: ix.keys, data: ix.data });
    assert.throws(() => vetFumpadTx(tx(foreign), wallet, { action: "auto-claim", mint: mint.toBase58() }), SilentSignRefused);
  });

  // A child process with a build's env: the SDK reads FUMPAD_*, the app NEXT_PUBLIC_FUMPAD_*.
  const run = (env: Record<string, string>) => {
    const script = `
      import { Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
      import { setAutoClaimIx } from "@fumpad/sdk";
      (async () => {
      const out = {};
      try {
        const m = await import("./src/chain/allowlist.ts");
        const vetFumpadTx = m.vetFumpadTx ?? m.default.vetFumpadTx;
        const wallet = Keypair.generate().publicKey, mint = Keypair.generate().publicKey;
        const tx = (i) => new VersionedTransaction(new TransactionMessage({ payerKey: wallet, recentBlockhash: PublicKey.default.toBase58(), instructions: [i] }).compileToV0Message());
        const vet = (i) => { try { vetFumpadTx(tx(i), wallet, { action: "auto-claim", mint: mint.toBase58() }); return "accepted"; } catch (e) { return "refused: " + e.message; } };
        const ix = setAutoClaimIx(wallet, mint, true);
        out.sdkProgram = ix.programId.toBase58();
        out.configured = vet(ix);
        out.devnet = vet(new TransactionInstruction({ programId: new PublicKey(${JSON.stringify(DEVNET_PROGRAM_ADDRESS)}), keys: ix.keys, data: ix.data }));
        out.other = vet(new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: ix.keys, data: ix.data }));
      } catch (e) { out.load = e.message; }
      console.log(JSON.stringify(out));
      })();`;
    const stdout = execFileSync(join(APP, "node_modules/.bin/tsx"), ["--eval", script], {
      cwd: APP,
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NEXT_PUBLIC_SOLANA_RPC: MAINNET_RPC, ...env },
    });
    return JSON.parse(stdout.trim().split("\n").pop()!) as Record<string, string>;
  };

  it("mainnet build (NEXT_PUBLIC_FUMPAD_PROGRAM_ID = SDK id): only the configured id is accepted, never the devnet one", () => {
    const r = run({ NEXT_PUBLIC_FUMPAD_PROGRAM_ID: MAINNET_ID, NEXT_PUBLIC_FUMPAD_CLUSTER: "mainnet", FUMPAD_PROGRAM_ID: MAINNET_ID, FUMPAD_CLUSTER: "mainnet" });
    assert.equal(r.load, undefined, r.load);
    assert.equal(r.sdkProgram, MAINNET_ID);
    assert.equal(r.configured, "accepted");
    assert.match(r.devnet, /^refused: .*program FUMPAD doesn't use/);
    assert.match(r.other, /^refused: .*program FUMPAD doesn't use/);
  });

  it("an app configured for one id with an SDK on another refuses to load (both directions)", () => {
    const sdkDefault = run({ NEXT_PUBLIC_FUMPAD_PROGRAM_ID: MAINNET_ID, NEXT_PUBLIC_FUMPAD_CLUSTER: "mainnet" });
    assert.match(sdkDefault.load ?? "", /FUMPAD program mismatch/);
    const appDefault = run({ FUMPAD_PROGRAM_ID: MAINNET_ID, FUMPAD_CLUSTER: "mainnet" });
    assert.match(appDefault.load ?? "", /FUMPAD program mismatch/);
  });

  it("a program id without a cluster refuses to load", () => {
    const r = run({ NEXT_PUBLIC_FUMPAD_PROGRAM_ID: MAINNET_ID, FUMPAD_PROGRAM_ID: MAINNET_ID });
    assert.match(r.load ?? "", /set NEXT_PUBLIC_FUMPAD_CLUSTER/);
  });
});
