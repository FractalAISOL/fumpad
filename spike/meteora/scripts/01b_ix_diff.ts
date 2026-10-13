// Item 1b: diff the "Instruction: X" log strings + error strings embedded in devnet vs mainnet ELFs,
// and identify the mainnet upgrade authority's owner program (multisig or plain key). Read-only.
import { Connection, PublicKey } from "@solana/web3.js";
import { connection, DBC_PROGRAM, DAMM_V2_PROGRAM, saveState } from "./common.js";

const MAINNET_READONLY = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

async function elf(conn: Connection, program: PublicKey): Promise<string> {
  const acc = await conn.getAccountInfo(program);
  const pd = await conn.getAccountInfo(new PublicKey(acc!.data.subarray(4, 36)));
  return pd!.data.subarray(45).toString("latin1");
}
function ixNames(s: string): Set<string> {
  // Anchor logs "Instruction: CamelName" — names are stored as separate literals; collect CamelCase words near "Instruction: "
  const set = new Set<string>();
  for (const m of s.matchAll(/Instruction: ([A-Za-z0-9]+)/g)) set.add(m[1]);
  return set;
}
function words(s: string, re: RegExp): Set<string> {
  return new Set([...s.matchAll(re)].map((m) => m[0]));
}

async function main() {
  const out: Record<string, any> = {};
  for (const [name, id] of [["DBC", DBC_PROGRAM], ["DAMM_V2", DAMM_V2_PROGRAM]] as const) {
    const d = await elf(connection, id);
    const m = await elf(MAINNET_READONLY, id);
    // Anchor 0.30+/1.x concatenate string literals, so match camel-case identifiers that look like ix names.
    const re = /(?:Swap2?|Initialize[A-Za-z0-9]*|Claim[A-Za-z0-9]*|Migrat[A-Za-z0-9]*|Withdraw[A-Za-z0-9]*|Create[A-Za-z0-9]*|Close[A-Za-z0-9]*|Lock[A-Za-z0-9]*|Permanent[A-Za-z0-9]*|Transfer[A-Za-z0-9]*|AddLiquidity|RemoveLiquidity[A-Za-z0-9]*|SplitPosition[A-Za-z0-9]*|Refresh[A-Za-z0-9]*|Update[A-Za-z0-9]*|Set[A-Z][A-Za-z0-9]*|Zap[A-Za-z0-9]*|Fund[A-Za-z0-9]*|Dummy[A-Za-z0-9]*)/g;
    const dw = words(d, re), mw = words(m, re);
    out[name] = {
      onlyDevnet: [...dw].filter((x) => !mw.has(x)).sort(),
      onlyMainnet: [...mw].filter((x) => !dw.has(x)).sort(),
      ixLogDev: [...ixNames(d)].length,
      ixLogMain: [...ixNames(m)].length,
    };
  }
  for (const auth of ["JADaUV8kvDpDbJr55wxXJHVaBS3VCj8thZZHjfeuCVLd"]) {
    const a = await MAINNET_READONLY.getAccountInfo(new PublicKey(auth));
    out.mainnetUpgradeAuthority = { address: auth, owner: a?.owner.toBase58() ?? "(no account => plain keypair / system wallet)", dataLen: a?.data.length ?? 0 };
  }
  for (const auth of ["DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX"]) {
    const a = await connection.getAccountInfo(new PublicKey(auth));
    out.devnetUpgradeAuthority = { address: auth, owner: a?.owner.toBase58() ?? "(no account)", dataLen: a?.data.length ?? 0 };
  }
  console.log(JSON.stringify(out, null, 2));
  saveState({ item1b: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
