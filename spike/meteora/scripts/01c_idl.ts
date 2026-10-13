// Item 1c: fetch on-chain Anchor IDL (legacy "anchor:idl" account) for DBC/DAMM v2 on devnet and mainnet (read-only).
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { Connection, PublicKey } from "@solana/web3.js";
import { connection, DBC_PROGRAM, DAMM_V2_PROGRAM, SPIKE_DIR } from "./common.js";

const MAINNET_READONLY = new Connection("https://api.mainnet-beta.solana.com", "confirmed");

async function idlAddress(programId: PublicKey) {
  const [base] = PublicKey.findProgramAddressSync([], programId);
  return PublicKey.createWithSeed(base, "anchor:idl", programId);
}
// Program Metadata Program (anchor 0.31+/1.x `anchor idl upload` default) — seeds ["idl"] style is used by pmp; try both.
const PMP = new PublicKey("ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S");

async function fetchIdl(conn: Connection, programId: PublicKey) {
  const addr = await idlAddress(programId);
  const acc = await conn.getAccountInfo(addr);
  if (acc) {
    // layout: 8 disc + 32 authority + 4 len + zlib data
    const len = acc.data.readUInt32LE(40);
    const json = zlib.inflateSync(acc.data.subarray(44, 44 + len)).toString();
    return { source: `anchor:idl ${addr.toBase58()}`, idl: JSON.parse(json) };
  }
  // PMP canonical metadata: seeds [program, (authority none), "idl"]
  const [pmpAddr] = PublicKey.findProgramAddressSync([programId.toBuffer(), Buffer.from("idl")], PMP);
  const p = await conn.getAccountInfo(pmpAddr);
  if (p) return { source: `pmp ${pmpAddr.toBase58()} (len ${p.data.length})`, idl: null, raw: p.data };
  return { source: "none", idl: null };
}

async function main() {
  for (const [name, id] of [["dbc", DBC_PROGRAM], ["damm_v2", DAMM_V2_PROGRAM]] as const) {
    for (const [cl, conn] of [["devnet", connection], ["mainnet", MAINNET_READONLY]] as const) {
      try {
        const r = await fetchIdl(conn, id);
        const ixs = r.idl?.instructions?.map((i: any) => i.name) ?? [];
        console.log(name, cl, r.source, r.idl?.metadata?.version ?? r.idl?.version ?? "", ixs.length, "ixs");
        if (r.idl) fs.writeFileSync(path.join(SPIKE_DIR, "idls", `${name}.${cl}.json`), JSON.stringify(r.idl, null, 2));
        if ((r as any).raw) {
          const raw: Buffer = (r as any).raw;
          fs.writeFileSync(path.join(SPIKE_DIR, "idls", `${name}.${cl}.pmp.bin`), raw);
        }
      } catch (e) {
        console.log(name, cl, "error", String(e));
      }
    }
  }
}
fs.mkdirSync(path.join(SPIKE_DIR, "idls"), { recursive: true });
main();
