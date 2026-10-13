// Pre-flight read-only checks: fmbL mint keypair unused, config creation sig, DBC pool authority flash-rent
// balance, DAMM v2 Customizable migration config on devnet.
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { deriveDbcPoolAuthority, DAMM_V2_MIGRATION_FEE_ADDRESS, createDammV2Program } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connection, HOME, loadState, saveState } from "./common.js";

const dir = path.join(HOME, "fumpad-keys/devnet");
const fmbl = fs.readdirSync(dir).filter((f) => /fmbL\.json$/.test(f));
const out: Record<string, any> = { fmblKeyfiles: [] };
for (const f of fmbl) {
  const pk = new PublicKey(f.replace(".json", ""));
  const acc = await connection.getAccountInfo(pk);
  out.fmblKeyfiles.push({ file: f, pubkey: pk.toBase58(), existsOnDevnet: !!acc });
}
const st = loadState();
if (st.config?.config) {
  const sigs = await connection.getSignaturesForAddress(new PublicKey(st.config.config));
  out.configSigs = sigs.map((s) => s.signature);
}
const pa = deriveDbcPoolAuthority();
out.dbcPoolAuthority = { address: pa.toBase58(), lamports: (await connection.getAccountInfo(pa))?.lamports ?? 0 };
const dc = DAMM_V2_MIGRATION_FEE_ADDRESS[6];
const acc = await connection.getAccountInfo(dc);
out.dammCustomizableConfig = { address: dc.toBase58(), owner: acc?.owner.toBase58(), len: acc?.data.length };
if (acc) {
  const prog = createDammV2Program(connection);
  const c: any = await (prog.account as any).config.fetch(dc);
  out.dammCustomizableConfig.decoded = {
    poolCreatorAuthority: c.poolCreatorAuthority.toBase58(),
    protocolFeePercent: c.poolFees.protocolFeePercent,
    referralFeePercent: c.poolFees.referralFeePercent,
    configType: c.configType,
    activationType: c.activationType,
    collectFeeMode: c.collectFeeMode,
  };
}
console.log(JSON.stringify(out, null, 2));
saveState({ preflight: out });
