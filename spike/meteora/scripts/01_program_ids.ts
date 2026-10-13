// Item 1: DBC + DAMM v2 program IDs on devnet vs mainnet (read-only; no mainnet transactions).
import crypto from "node:crypto";
import { Connection, PublicKey } from "@solana/web3.js";
import { connection, DBC_PROGRAM, DAMM_V2_PROGRAM, saveState } from "./common.js";

const MAINNET_READONLY = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
const UPGRADEABLE_LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const PROGRAMDATA_HEADER = 45; // u32 tag + u64 slot + Option<Pubkey>

async function inspect(conn: Connection, program: PublicKey) {
  const acc = await conn.getAccountInfo(program);
  if (!acc) return { exists: false };
  if (!acc.owner.equals(UPGRADEABLE_LOADER)) return { exists: true, owner: acc.owner.toBase58() };
  const programData = new PublicKey(acc.data.subarray(4, 36));
  const pd = await conn.getAccountInfo(programData);
  if (!pd) return { exists: true, programData: programData.toBase58(), programDataMissing: true };
  const slot = Number(pd.data.readBigUInt64LE(4));
  const hasAuth = pd.data[12] === 1;
  const upgradeAuthority = hasAuth ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
  let elf = pd.data.subarray(PROGRAMDATA_HEADER);
  // trim zero padding at the end (programdata is allocated larger than the ELF)
  let end = elf.length;
  while (end > 0 && elf[end - 1] === 0) end--;
  elf = elf.subarray(0, end);
  const sha256 = crypto.createHash("sha256").update(elf).digest("hex");
  // Anchor programs embed no version string by default; look for a semver-ish "dynamic-bonding-curve" / crate hints.
  const txt = elf.toString("latin1");
  const hints = [...new Set((txt.match(/(?:dynamic[-_]bonding[-_]curve|cp[-_]amm|damm[-_]v2)[^\x00]{0,40}/gi) ?? []).slice(0, 5))];
  return {
    exists: true,
    executable: acc.executable,
    programData: programData.toBase58(),
    lastDeploySlot: slot,
    upgradeAuthority,
    programDataLen: pd.data.length,
    elfLen: elf.length,
    elfSha256: sha256,
    hints,
  };
}

async function main() {
  const out: Record<string, any> = {};
  for (const [name, id] of [["DBC", DBC_PROGRAM], ["DAMM_V2", DAMM_V2_PROGRAM]] as const) {
    const dev = await inspect(connection, id);
    const main = await inspect(MAINNET_READONLY, id);
    let devTime: number | null = null, mainTime: number | null = null;
    try { devTime = dev.lastDeploySlot ? await connection.getBlockTime(dev.lastDeploySlot) : null; } catch {}
    try { mainTime = main.lastDeploySlot ? await MAINNET_READONLY.getBlockTime(main.lastDeploySlot) : null; } catch {}
    out[name] = {
      programId: id.toBase58(),
      devnet: { ...dev, deployTime: devTime ? new Date(devTime * 1000).toISOString() : null },
      mainnet: { ...main, deployTime: mainTime ? new Date(mainTime * 1000).toISOString() : null },
      identicalBytecode: dev.elfSha256 && dev.elfSha256 === main.elfSha256,
    };
  }
  console.log(JSON.stringify(out, null, 2));
  saveState({ item1: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
