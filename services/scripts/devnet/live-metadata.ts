/**
 * FUMPAD LIVE devnet check of the coin-metadata path, the way the app does it, against the live Railway API:
 *   1. POST /v1/launch/metadata (signed creator auth, logo PNG + name / ticker / description / website / X) → uri
 *   2. POST /v1/launch/prepare with that uri + a first buy → a v0 tx through the launch ALT; creator signs + sends
 *   3. verify: on-chain Token-2022 metadata uri = https://ipfs.io/ipfs/<cid>; the JSON + image resolve; our API's
 *      /v1/coins/by-mint/<mint> + /v1/img/<mint>; Helius DAS getAsset (what wallets read) shows name + image.
 *
 *   npx tsx scripts/devnet/live-metadata.ts [--name "…"] [--symbol FMBLT] [--image <png>] [--buy-lamports N]
 *   npx tsx scripts/devnet/live-metadata.ts --verify <mint>      # step 3 only (e.g. after the indexer's retries)
 *
 * Keys: ~/fumpad-keys/devnet/v07/creator.json. RPC: RPC_URL from ~/fumpad-keys/devnet/rpc.env (never printed);
 * refuses a non-devnet genesis. Spends only the creator's devnet SOL (the first buy + fees + rent).
 * Record (no secrets): ~/fumpad-keys/devnet/v07/live-metadata.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction } from "@solana/web3.js";

import { confirmSignature, inspectLaunchTx, isFumpadVanityMint, launchTxLookupTables } from "@fumpad/sdk";
import { signLaunchAuth } from "@fumpad/api";

import { readRpcUrl } from "./bootstrap-v07.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const KEYS = join(homedir(), "fumpad-keys/devnet/v07");
const RECORD = join(KEYS, "live-metadata.json");
const API = process.env.FUMPAD_API ?? "https://api-production-66441.up.railway.app";
const REPO = join(import.meta.dirname, "../../..");
const FALLBACK_GATEWAY = "https://gateway.pinata.cloud/ipfs/";
const SSR_FILES = [join(homedir(), "fumpad-keys/devnet/api_ssr_secret"), join(homedir(), "fumpad-keys/api_ssr_secret")];

const arg = (k: string) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const redact = (s: string) => s.replace(/api-key=[^&\s"]+/g, "api-key=***");
let failed = 0;
const check = (name: string, ok: boolean, detail?: string) => {
  console.log(`${ok ? "  ✔" : "  ✘"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};
const ssr = SSR_FILES.find(existsSync);
const ssrHeaders: Record<string, string> = ssr ? { "x-fumpad-ssr": readFileSync(ssr, "utf8").trim() } : {};

/** Token-2022 TokenMetadata extension (TLV type 19) on the mint: name / symbol / uri. */
function token2022Metadata(data: Buffer): { name: string; symbol: string; uri: string } | null {
  let o = 166; // 165 (base account size, mint padded) + 1 account-type byte
  while (o + 4 <= data.length) {
    const type = data.readUInt16LE(o);
    const len = data.readUInt16LE(o + 2);
    const v = data.subarray(o + 4, o + 4 + len);
    if (type === 19) {
      let p = 64; // update authority + mint
      const str = () => {
        const n = v.readUInt32LE(p);
        const s = v.subarray(p + 4, p + 4 + n).toString("utf8");
        p += 4 + n;
        return s;
      };
      return { name: str(), symbol: str(), uri: str() };
    }
    if (type === 0 && len === 0) break;
    o += 4 + len;
  }
  return null;
}

async function fetchRetry(url: string, init?: RequestInit, tries = 8): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if (r.ok) return r;
      last = new Error(`${r.status}`);
    } catch (e) {
      last = e;
    }
    await sleep(5_000 * (i + 1));
  }
  throw new Error(`GET ${redact(url)} failed: ${String(last)}`);
}

async function verify(conn: Connection, rpcUrl: string, mint: string, expect: { name: string; symbol: string; uri?: string }) {
  console.log(`\nverify ${mint}`);
  const info = await conn.getAccountInfo(new PublicKey(mint));
  const onchain = info ? token2022Metadata(Buffer.from(info.data)) : null;
  check("on-chain Token-2022 metadata name + symbol", !!onchain && onchain.name === expect.name && onchain.symbol === expect.symbol, onchain ? `"${onchain.name}" / ${onchain.symbol}` : "no metadata extension");
  const uri = onchain?.uri ?? "";
  check("on-chain uri is https://ipfs.io/ipfs/<cid>", /^https:\/\/ipfs\.io\/ipfs\/Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(uri) && (!expect.uri || uri === expect.uri), uri);
  // ipfs.io (the on-chain gateway) retired 2026-09-21 (gatewaychanges.ipfs.io): report a direct fetch, then read the
  // same CID through Pinata's public gateway so the remaining checks still run.
  const direct = async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
    check(`direct fetch ${url}`, !!r?.ok, r ? `${r.status} ${r.headers.get("sunset") ? `(sunset ${r.headers.get("sunset")})` : ""}` : "network error");
    return r?.ok ? r : fetchRetry(url.replace(/^https:\/\/[^/]+\/ipfs\//, FALLBACK_GATEWAY), undefined, 4);
  };
  const json = (await (await direct(uri)).json()) as Record<string, unknown>;
  console.log("  metadata JSON:", JSON.stringify(json));
  check("metadata JSON name / symbol / image", json.name === expect.name && json.symbol === expect.symbol && typeof json.image === "string", String(json.image));
  const img = await direct(String(json.image));
  const bytes = Buffer.from(await img.arrayBuffer());
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  check("image URL serves a PNG", png, `${img.headers.get("content-type")}, ${bytes.length} B`);

  // Our API (indexer fetches the JSON with retries; allow a few minutes).
  let coin: Record<string, unknown> | null = null;
  for (let i = 0; i < 36 && !(coin && coin.imageUrl && coin.socials); i++) {
    const r = await fetch(`${API}/v1/coins/by-mint/${mint}`, { headers: ssrHeaders });
    coin = r.ok ? ((await r.json()) as Record<string, unknown>) : null;
    if (!(coin && coin.imageUrl && coin.socials)) await sleep(10_000);
  }
  const pick = coin ? Object.fromEntries(["name", "symbol", "imageUrl", "description", "socials"].filter((k) => k in coin!).map((k) => [k, coin![k]])) : null;
  console.log("  API coin:", JSON.stringify(pick));
  check("API /v1/coins/by-mint shows name / symbol / image / socials", !!coin && coin.name === expect.name && coin.symbol === expect.symbol && !!coin.imageUrl && !!(coin.socials as { x?: string; website?: string } | undefined)?.x && !!(coin.socials as { website?: string } | undefined)?.website);
  const ri = await fetch(`${API}/v1/img/${mint}`);
  const ib = Buffer.from(await ri.arrayBuffer());
  check("API /v1/img/<mint> serves the image", ri.ok && ib.length > 0 && /image\//.test(ri.headers.get("content-type") ?? ""), `${ri.status} ${ri.headers.get("content-type")} ${ib.length} B`);

  // What wallets read: Helius DAS getAsset.
  if (/helius/.test(rpcUrl)) {
    let a: { content?: { json_uri?: string; metadata?: { name?: string; symbol?: string }; links?: { image?: string }; files?: { uri?: string; cdn_uri?: string }[] }; token_info?: unknown } | undefined;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAsset", params: { id: mint } }) });
      a = ((await r.json()) as { result?: typeof a }).result;
      if (a?.content?.links?.image) break;
      await sleep(10_000);
    }
    console.log("  DAS content:", JSON.stringify(a?.content ?? null));
    check("DAS getAsset: json_uri + name + image resolve", a?.content?.json_uri === uri && a?.content?.metadata?.name === expect.name && !!a?.content?.links?.image, a?.content?.links?.image);
  } else console.log("  (RPC is not Helius: DAS check skipped)");
  return { uri, json, image: String(json.image) };
}

async function main() {
  const rpcUrl = readRpcUrl();
  const conn = new Connection(rpcUrl, "confirmed");
  if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error("RPC_URL is not devnet: refusing");
  const vMint = arg("--verify");
  if (vMint) {
    const rec = existsSync(RECORD) ? (JSON.parse(readFileSync(RECORD, "utf8")) as { mint: string; name: string; symbol: string; uri: string }) : null;
    const exp = rec?.mint === vMint ? rec : { name: arg("--name") ?? "", symbol: arg("--symbol") ?? "" };
    await verify(conn, rpcUrl, vMint, exp);
    process.exit(failed ? 1 : 0);
  }

  const creator = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(KEYS, "creator.json"), "utf8")) as number[]));
  // 32 characters: the longest name, proving the https uri fits the launch tx's byte budget through the ALT.
  const name = arg("--name") ?? "Fumble Pad Test Max Length 32 ch";
  const symbol = arg("--symbol") ?? "FMBLT";
  const imagePath = arg("--image") ?? join(REPO, "marketing/brand/logo/png/fumpad-mark-on-dark-1024.png");
  const buy = BigInt(arg("--buy-lamports") ?? String(LAMPORTS_PER_SOL / 100)); // 0.01 SOL
  const c58 = creator.publicKey.toBase58();
  console.log(`creator ${c58} balance ${(await conn.getBalance(creator.publicKey)) / LAMPORTS_PER_SOL} SOL; name "${name}" (${name.length}), ${symbol}`);

  // One signed auth covers both calls (as in the app).
  const auth = signLaunchAuth(creator.secretKey, { creator: c58, symbol });
  const meta = {
    creator: c58,
    name,
    symbol,
    description: "FUMPAD devnet metadata test: logo, socials and an https IPFS uri through the launch lookup table.",
    website: "https://fumpad.app",
    twitter: "https://x.com/fumpadapp",
    image: readFileSync(imagePath).toString("base64"),
    firstBuy: true,
    auth,
  };
  const mr = await fetch(`${API}/v1/launch/metadata`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(meta) });
  if (!mr.ok) throw new Error(`metadata → ${mr.status} ${await mr.text()}`);
  const m = (await mr.json()) as { uri: string; image?: string; placeholder?: boolean };
  console.log("  metadata →", JSON.stringify(m));
  check("metadata: https://ipfs.io/ipfs/<cid> uri, image pinned, not a placeholder", m.uri.startsWith("https://ipfs.io/ipfs/") && !!m.image && !m.placeholder);

  const pr = await fetch(`${API}/v1/launch/prepare`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ creator: c58, name, symbol, uri: m.uri, initialBuyLamports: String(buy), auth }),
  });
  if (!pr.ok) throw new Error(`prepare → ${pr.status} ${await pr.text()}`);
  const prepared = (await pr.json()) as { mint: string; transaction: string; lastValidBlockHeight: number };
  const ltx = VersionedTransaction.deserialize(Buffer.from(prepared.transaction, "base64"));
  const lookups = ltx.message.addressTableLookups.map((l) => l.accountKey.toBase58());
  const info = inspectLaunchTx(ltx, await launchTxLookupTables(conn, ltx));
  const size = ltx.serialize().length;
  check("prepare: v0 tx through the launch ALT, creator pays, …fmbL mint, first buy", ltx.version === 0 && lookups.length === 1 && info.feePayer === c58 && isFumpadVanityMint(prepared.mint) && info.buyLamports === buy, `ALT ${lookups.join(",")}, ${size} B, mint ${prepared.mint}`);
  ltx.sign([creator]);
  const raw = ltx.serialize();
  const sig = await conn.sendRawTransaction(raw, { maxRetries: 0 });
  await confirmSignature(conn, sig, prepared.lastValidBlockHeight, "confirmed", raw);
  const t = await conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  check("launch tx confirmed without error", !!t && !t.meta?.err, `https://solscan.io/tx/${sig}?cluster=devnet`);
  const rec = { at: new Date().toISOString(), mint: prepared.mint, sig, name, symbol, uri: m.uri, image: m.image, alt: lookups[0], txBytes: size, buyLamports: String(buy) };
  writeFileSync(RECORD, JSON.stringify(rec, null, 2), { mode: 0o600 });
  console.log(`  token: https://solscan.io/token/${prepared.mint}?cluster=devnet`);

  await verify(conn, rpcUrl, prepared.mint, { name, symbol, uri: m.uri });
  console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(redact(String(e instanceof Error ? (e.stack ?? e.message) : e)));
  process.exit(1);
});
