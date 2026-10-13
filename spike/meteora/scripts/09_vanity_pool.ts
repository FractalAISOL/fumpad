// Item 7 (vanity): create a second pool on the same config with a ground "...fmbL" mint keypair (no buys).
// Also shows one config serves many coins (per-coin pool PDA = [pool, config, max(mint, WSOL), min(mint, WSOL)]).
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { connection, payer, send, saveState, loadState, KEYS_DIR, loadKeypair } from "./common.js";
import { initPoolIx, poolKeys } from "./dbc.js";

async function main() {
  const st = loadState();
  const config = new PublicKey(st.config.config);
  const f = fs.readdirSync(KEYS_DIR).find((x) => x.endsWith("fmbL.json"))!;
  const mint = loadKeypair(path.join(KEYS_DIR, f));
  const { pool } = poolKeys(config, mint.publicKey);
  let sig = st.vanity?.sig, cu = st.vanity?.cu;
  if (!(await connection.getAccountInfo(pool))) {
    const r = await send("init pool with vanity ...fmbL mint keypair (caller-chosen)", [await initPoolIx({ config, baseMint: mint.publicKey, creator: payer.publicKey, payer: payer.publicKey, name: "Fumble Vanity", symbol: "FMBL", uri: "https://fumpad.fun/v.json" })], [mint]);
    sig = r.sig; cu = r.cu;
  }
  const m = await getMint(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  const md = await getTokenMetadata(connection, mint.publicKey, "confirmed", TOKEN_2022_PROGRAM_ID);
  const out = {
    sig, cu, mint: mint.publicKey.toBase58(), pool: pool.toBase58(), supply: m.supply.toString(), decimals: m.decimals,
    mintAuthority: m.mintAuthority?.toBase58() ?? null, freezeAuthority: m.freezeAuthority?.toBase58() ?? null,
    metadata: md ? { name: md.name, symbol: md.symbol, uri: md.uri, updateAuthority: md.updateAuthority?.toBase58() ?? null } : null,
    tlvLen: m.tlvData.length,
  };
  console.log(out);
  saveState({ vanity: out });
}
main().catch((e) => { console.error(e); process.exit(1); });
