/**
 * The local admin signing page (served + bundled by admin-sign-server.ts). Shows the proposal, connects the wallet
 * (Wallet Standard, or the injected Phantom / Solflare / Backpack provider), refuses any address but the proposal's
 * signer, and on ONE click: fresh blockhash → simulate → wallet signTransaction (the user approves in the wallet) →
 * check the signed bytes → send through the local proxy → poll to confirmed / finalized. Never signs by itself; one
 * action per page load. All RPC goes to /rpc on 127.0.0.1 (the server holds the RPC URL).
 */
import { Transaction } from "@solana/web3.js";

import {
  b64,
  buildProposalTx,
  explorerTxUrl,
  type Proposal,
  proposalProblems,
  signedTxProblems,
  unsignedWire,
  walletChain,
} from "../admin-sign-tx.js";

// ── DOM helpers (textContent only: proposal text is never parsed as HTML) ──────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}
const setState = (s: string) => document.body.setAttribute("data-state", s);
function logLine(text: string, cls?: string) {
  $("log").appendChild(el("div", text, cls));
}
function status(id: string, text: string, cls?: string) {
  const e = $(id);
  e.textContent = text;
  e.className = `status ${cls ?? ""}`;
}

// ── local JSON-RPC proxy ──────────────────────────────────────────────────────────────────────────────────────────
let rpcId = 0;
async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const r = await fetch("/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

// ── wallets ─────────────────────────────────────────────────────────────────────────────────────────────────────
interface WalletOption {
  name: string;
  connect(): Promise<string>;
  sign(tx: Transaction): Promise<Transaction>;
}
interface StdAccount { address: string; publicKey: Uint8Array; chains: readonly string[]; features: readonly string[] }
interface StdWallet {
  name: string;
  chains: readonly string[];
  accounts: readonly StdAccount[];
  features: Record<string, unknown>;
}
interface InjectedProvider {
  publicKey?: { toBase58(): string } | null;
  connect(): Promise<{ publicKey?: { toBase58(): string } } | void>;
  signTransaction(tx: Transaction): Promise<{ serialize(o?: unknown): Uint8Array }>;
}

const toOurTx = (signed: { serialize(o?: unknown): Uint8Array } | Uint8Array) =>
  Transaction.from(signed instanceof Uint8Array ? signed : signed.serialize({ requireAllSignatures: false, verifySignatures: false }));

const standard: StdWallet[] = [];
function stdOption(w: StdWallet, chain: string): WalletOption {
  let account: StdAccount | undefined;
  return {
    name: w.name,
    async connect() {
      const f = w.features["standard:connect"] as { connect(): Promise<{ accounts: readonly StdAccount[] }> };
      const r = await f.connect();
      const accs = r.accounts.length ? r.accounts : w.accounts;
      account = accs.find((a) => a.address === proposal.signer) ?? accs[0];
      if (!account) throw new Error("the wallet returned no account");
      return account.address;
    },
    async sign(tx) {
      if (!account) throw new Error("connect first");
      const f = w.features["solana:signTransaction"] as { signTransaction(...i: { account: StdAccount; transaction: Uint8Array; chain: string }[]): Promise<{ signedTransaction: Uint8Array }[]> };
      const [out] = await f.signTransaction({ account, transaction: unsignedWire(tx), chain });
      return toOurTx(out.signedTransaction);
    },
  };
}
function injectedOption(name: string, p: InjectedProvider): WalletOption {
  return {
    name,
    async connect() {
      const r = await p.connect();
      const pk = (r && r.publicKey) || p.publicKey;
      if (!pk) throw new Error("the wallet returned no public key");
      return pk.toBase58();
    },
    sign: async (tx) => toOurTx(await p.signTransaction(tx)),
  };
}
function walletOptions(): WalletOption[] {
  const chain = walletChain(proposal.cluster);
  const out = standard.filter((w) => "standard:connect" in w.features && "solana:signTransaction" in w.features).map((w) => stdOption(w, chain));
  const has = (n: string) => out.some((o) => o.name.toLowerCase().includes(n));
  const win = window as unknown as { phantom?: { solana?: InjectedProvider & { isPhantom?: boolean } }; solflare?: InjectedProvider & { isSolflare?: boolean }; backpack?: InjectedProvider & { solana?: InjectedProvider } };
  if (!has("phantom") && win.phantom?.solana?.isPhantom) out.push(injectedOption("Phantom", win.phantom.solana));
  if (!has("solflare") && win.solflare?.isSolflare) out.push(injectedOption("Solflare", win.solflare));
  const bp = win.backpack?.solana ?? win.backpack;
  if (!has("backpack") && bp && typeof bp.signTransaction === "function") out.push(injectedOption("Backpack", bp));
  return out;
}
// Wallet Standard discovery (no dependency): wallets that loaded first answer app-ready, later ones register-wallet.
const api = {
  register(...ws: StdWallet[]) {
    for (const w of ws) if (!standard.includes(w)) standard.push(w);
    renderWallets();
    return () => {};
  },
};
window.addEventListener("wallet-standard:register-wallet", (e) => (e as CustomEvent<(a: typeof api) => void>).detail?.(api));

// ── state ───────────────────────────────────────────────────────────────────────────────────────────────────────
let proposal: Proposal;
let connected: { wallet: WalletOption; address: string } | null = null;
let used = false; // one action per page load
const SOL = 1_000_000_000;

function renderProposal(p: Proposal) {
  document.title = `FUMPAD admin · ${p.title}`;
  const badge = $("cluster");
  badge.textContent = p.cluster;
  badge.className = `badge ${p.cluster}`;
  $("title").textContent = p.title;
  const ul = $("summary");
  for (const s of p.summary) ul.appendChild(el("li", s));
  const dl = $("values");
  for (const v of p.values) {
    dl.appendChild(el("dt", v.label));
    dl.appendChild(el("dd", v.value));
  }
  $("signer").textContent = p.signer;
  $("role").textContent = `(${p.signerRole})`;
  const tb = $("accounts");
  for (const a of p.accounts) {
    const tr = el("tr", undefined, a.address === p.signer ? "you" : undefined);
    tr.append(el("td", a.label), el("td", a.address), el("td", a.signer ? "yes" : ""), el("td", a.writable ? "yes" : ""));
    tb.appendChild(tr);
  }
  $("raw").textContent = JSON.stringify(
    { programId: p.programId, computeUnitLimit: p.computeUnitLimit, computeUnitPriceMicroLamports: p.computeUnitPriceMicroLamports, instructions: p.instructions.map((ix) => ({ ...ix, dataHex: [...b64.decode(ix.data)].map((b) => b.toString(16).padStart(2, "0")).join("") })), simulatedByCli: p.simulation.unitsConsumed, createdAt: p.createdAt },
    null,
    2,
  );
}

function renderWallets() {
  if (!proposal) return;
  const box = $("wallets");
  box.replaceChildren();
  const opts = walletOptions();
  if (!opts.length) {
    box.appendChild(el("p", "No Solana wallet detected in this browser. Open this URL in the browser profile with Phantom / Solflare / Backpack (unlocked), then reload.", "warn"));
    return;
  }
  for (const w of opts) {
    const b = el("button", `Connect ${w.name}`);
    b.dataset.wallet = w.name;
    b.disabled = used;
    b.addEventListener("click", () => void connect(w));
    box.appendChild(b);
  }
}

async function connect(w: WalletOption) {
  const btn = $("sign") as HTMLButtonElement;
  btn.disabled = true;
  connected = null;
  try {
    status("wallet-status", `connecting ${w.name}…`);
    const address = await w.connect();
    if (address !== proposal.signer) {
      setState("wrong-wallet");
      status("wallet-status", `Connected ${address} — REFUSED: this proposal must be signed by ${proposal.signer}. Switch to that account in ${w.name} and connect again.`, "bad");
      return;
    }
    const lamports = await rpc<{ value: number }>("getBalance", [address, { commitment: "confirmed" }]);
    const bal = lamports.value;
    if (bal < proposal.maxFeeLamports) {
      setState("no-funds");
      status("wallet-status", `Connected ${address} (${w.name}) but it has ${(bal / SOL).toFixed(6)} SOL: it pays the fee, send it ~0.02 SOL.`, "bad");
      return;
    }
    connected = { wallet: w, address };
    setState("connected");
    status("wallet-status", `✓ Connected ${address} (${w.name}) — the expected ${proposal.signerRole} · balance ${(bal / SOL).toFixed(6)} SOL`, "ok");
    btn.disabled = used;
  } catch (e) {
    setState("error");
    status("wallet-status", `connect failed: ${(e as Error).message}`, "bad");
  }
}

async function signAndSend() {
  if (!connected || used) return;
  const btn = $("sign") as HTMLButtonElement;
  btn.disabled = true;
  setState("signing");
  let sent = false;
  try {
    const { value: bh } = await rpc<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const tx = buildProposalTx(proposal, bh.blockhash);
    logLine(`built with fresh blockhash ${bh.blockhash}`);
    const sim = await rpc<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>("simulateTransaction", [b64.encode(unsignedWire(tx)), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: false, commitment: "confirmed" }]);
    if (sim.value.err) {
      logLine(`✗ simulation failed: ${JSON.stringify(sim.value.err)}`, "bad");
      for (const l of (sim.value.logs ?? []).slice(-12)) logLine(`  ${l}`);
      throw new Error("simulation failed: nothing was signed");
    }
    logLine(`✓ simulation OK (${sim.value.unitsConsumed ?? "?"} CU) — approve it in ${connected.wallet.name}…`, "ok");
    setState("awaiting-wallet");
    const signed = await connected.wallet.sign(tx);
    const bad = signedTxProblems(proposal, signed);
    if (bad.length) throw new Error(`refusing to send the signed transaction: ${bad.join("; ")}`);
    const wire = b64.encode(signed.serialize());
    const sig = await rpc<string>("sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 0 }]);
    sent = true;
    used = true;
    setState("sent");
    const url = explorerTxUrl(proposal.cluster, sig);
    const res = $("result");
    res.replaceChildren(el("span", "Signature: "), el("code", sig, "addr"));
    if (url) {
      const a = el("a", " view on Solscan ↗");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      res.appendChild(a);
    }
    logLine(`→ sent ${sig}`);
    await poll(sig, wire);
  } catch (e) {
    logLine(`✗ ${(e as Error).message}`, "bad");
    setState(sent ? "error-after-send" : "error");
    // nothing was sent: the same page may try again (fresh blockhash); after a send, never
    if (!sent) btn.disabled = false;
  } finally {
    renderWallets();
  }
}

async function poll(sig: string, wire: string) {
  let last = "";
  const t0 = Date.now();
  for (let i = 0; Date.now() - t0 < 150_000; i++) {
    await new Promise((r) => setTimeout(r, 1_000));
    const r = await rpc<{ value: ({ err: unknown; confirmationStatus?: string } | null)[] }>("getSignatureStatuses", [[sig], { searchTransactionHistory: true }]).catch(() => null);
    const st = r?.value?.[0];
    if (st?.err) {
      setState("failed");
      logLine(`✗ failed on chain: ${JSON.stringify(st.err)}`, "bad");
      return;
    }
    if (st?.confirmationStatus && st.confirmationStatus !== last) {
      last = st.confirmationStatus;
      logLine(`✓ ${last}`, "ok");
      if (last === "confirmed" || last === "finalized") setState(last);
      if (last === "finalized") {
        logLine("Done. One action per page load: close this tab (and Ctrl-C the server).");
        return;
      }
    }
    // not landed yet: rebroadcast the SAME signed bytes (same signature; the proxy allows only this one)
    if (!st && i % 4 === 3) await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]).catch(() => null);
  }
  if (last !== "finalized") logLine(last ? `still ${last}: check Solscan` : "not seen after 150 s: the blockhash has likely expired; check Solscan, reload the page and sign again if it never landed", "warn");
}

async function main() {
  setState("loading");
  const raw = (await (await fetch("/proposal.json")).json()) as Proposal;
  const problems = proposalProblems(raw);
  if (problems.length) {
    $("title").textContent = "Invalid proposal — refusing";
    $("summary").appendChild(el("li", problems.join("; "), "bad"));
    setState("invalid");
    return;
  }
  proposal = raw;
  renderProposal(proposal);
  window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
  renderWallets();
  setTimeout(renderWallets, 600); // providers injected late
  $("sign").addEventListener("click", () => void signAndSend());
  setState("ready");
}

void main().catch((e) => {
  $("title").textContent = `Error: ${(e as Error).message}`;
  setState("error");
});
