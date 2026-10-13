// Verification + cleanup:
//  - re-parse every logged swap with EvtSwap3 and with the EvtSwap2-only (mainnet 0.2.1) fallback, assert equal
//  - check which event discriminators exist in the devnet vs mainnet DBC ELF (read-only mainnet RPC)
//  - account rent of a launched coin
//  - recover devnet SOL: sell all spike-held tokens on DAMM v2, unwrap WSOL, sweep helper wallets back to the deployer
import crypto from "node:crypto";
import BN from "bn.js";
import { Connection, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAccount, createCloseAccountInstruction } from "@solana/spl-token";
import { CpAmm } from "@meteora-ag/cp-amm-sdk";
import { deriveDammV2TokenVaultAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, payer, send, saveState, loadState, spikeKey, getTx, DBC_PROGRAM, DAMM_V2_PROGRAM } from "./common.js";
import { parseSwaps, parseSwapsDbcV2Only, fmt } from "./events.js";
import { ata, baseAta, poolKeys } from "./dbc.js";

const MAINNET_READONLY = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const evDisc = (n: string) => crypto.createHash("sha256").update(`event:${n}`).digest().subarray(0, 8);

async function elf(conn: Connection, program: PublicKey) {
  const acc = await conn.getAccountInfo(program);
  const pd = await conn.getAccountInfo(new PublicKey(acc!.data.subarray(4, 36)));
  return pd!.data.subarray(45);
}

async function main() {
  const st = loadState();
  const out: any = {};

  // 1) parser cross-check
  const checks: any[] = [];
  for (const t of st.txs as any[]) {
    if (!/swap|BUY|SELL|buy|PartialFill|buyback/i.test(t.label)) continue;
    const tx = await getTx(t.sig);
    if (!tx || tx.meta?.err) continue;
    const a = parseSwaps(tx).filter((s) => s.venue === "dbc").map(fmt);
    const b = parseSwapsDbcV2Only(tx).filter((s) => s.venue === "dbc").map(fmt);
    if (a.length) checks.push({ label: t.label, n: a.length, evtSwap2EqualsEvtSwap3: JSON.stringify(a) === JSON.stringify(b) });
  }
  out.parserCrossCheck = checks;
  console.log(checks);

  // 2) event discriminators present in bytecode
  const [dDev, dMain] = [await elf(connection, DBC_PROGRAM), await elf(MAINNET_READONLY, DBC_PROGRAM)];
  const ev: any = {};
  for (const n of ["EvtSwap", "EvtSwap2", "EvtSwap3", "EvtCurveComplete", "EvtCreateConfig3"]) ev[n] = { devnet: dDev.indexOf(evDisc(n)) >= 0, mainnet: dMain.indexOf(evDisc(n)) >= 0 };
  const [mDev, mMain] = [await elf(connection, DAMM_V2_PROGRAM), await elf(MAINNET_READONLY, DAMM_V2_PROGRAM)];
  ev.DAMM_EvtSwap2 = { devnet: mDev.indexOf(evDisc("EvtSwap2")) >= 0, mainnet: mMain.indexOf(evDisc("EvtSwap2")) >= 0 };
  const ixd = (n: string) => crypto.createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
  for (const n of ["create_config2", "create_config", "swap2", "claim_trading_fee", "withdraw_leftover", "migration_damm_v2"]) ev[`ix_${n}`] = { devnet: dDev.indexOf(ixd(n)) >= 0, mainnet: dMain.indexOf(ixd(n)) >= 0 };
  out.bytecodeMarkers = ev;
  console.log(ev);

  // 3) rent of a launched coin's accounts
  const config = new PublicKey(st.config.config);
  const mint = new PublicKey(st.launch.mint);
  const { pool, baseVault, quoteVault } = poolKeys(config, mint);
  const rent: any = {};
  for (const [k, a] of Object.entries({ virtualPool: pool, baseVault, quoteVault, mint, config, dammPool: new PublicKey(st.dammPool) })) {
    const i = await connection.getAccountInfo(a as PublicKey);
    rent[k] = { bytes: i?.data.length, lamports: i?.lamports };
  }
  out.rent = rent;
  console.log(rent);

  // 4) recovery
  const dammPool = new PublicKey(st.dammPool);
  const cp = new CpAmm(connection);
  const sellAll = async (kp: any, label: string) => {
    const acc = baseAta(kp.publicKey, mint);
    let amt = 0n;
    try { amt = (await getAccount(connection, acc, "confirmed", TOKEN_2022_PROGRAM_ID)).amount; } catch { return; }
    if (amt === 0n) return;
    const tx = await cp.swap({
      payer: kp.publicKey, pool: dammPool, inputTokenMint: mint, outputTokenMint: NATIVE_MINT, amountIn: new BN(amt.toString()), minimumAmountOut: new BN(0),
      tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: deriveDammV2TokenVaultAddress(dammPool, mint), tokenBVault: deriveDammV2TokenVaultAddress(dammPool, NATIVE_MINT),
      tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID, referralTokenAccount: null,
    });
    await send(`cleanup: ${label} sells all tokens on DAMM v2`, tx.instructions, [kp]);
  };
  const before = await connection.getBalance(payer.publicKey);
  const creator = spikeKey("creator"), sniper = spikeKey("sniper"), platform = spikeKey("platform");
  await sellAll(payer, "deployer");
  await sellAll(creator, "creator");
  await sellAll(sniper, "sniper");
  for (const [kp, label] of [[creator, "creator"], [sniper, "sniper"], [platform, "platform"]] as const) {
    const ixs = [];
    const w = ata(kp.publicKey, NATIVE_MINT);
    if (await connection.getAccountInfo(w)) ixs.push(createCloseAccountInstruction(w, kp.publicKey, kp.publicKey));
    if (ixs.length) await send(`cleanup: unwrap ${label} WSOL`, ixs, [kp]);
    const lam = await connection.getBalance(kp.publicKey);
    if (lam > 0) await send(`cleanup: sweep ${label} -> deployer`, [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: payer.publicKey, lamports: lam })], [kp]);
  }
  const w = ata(payer.publicKey, NATIVE_MINT);
  if (await connection.getAccountInfo(w)) await send("cleanup: unwrap deployer WSOL", [createCloseAccountInstruction(w, payer.publicKey, payer.publicKey)], []);
  const after = await connection.getBalance(payer.publicKey);
  out.recovery = { deployerBefore: before / LAMPORTS_PER_SOL, deployerAfter: after / LAMPORTS_PER_SOL };
  console.log(out.recovery);
  saveState({ verify: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
