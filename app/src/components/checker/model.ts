/**
 * Fumble Checker logic without React (unit-tested by `model.test.ts`): wallet input parsing, the copy for each sell's
 * conditions and ticket state, the claim target's numbers, countdowns, "trade it now" links. No `@/` imports.
 */
import type { CoinFees, FumbleSell, ProtocolParams, SellNoTicketReason, Ticket } from "../../data/types";

/* ── Wallet input ──────────────────────────────────────────────────────────── */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Decoded length in bytes of a base58 string (null when it isn't base58). Byte-array long division, no BigInt. */
export function base58Bytes(str: string): number | null {
  const bytes: number[] = [];
  for (const ch of str) {
    let carry = ALPHABET.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === "1") zeros++;
  return bytes.length + zeros;
}

/** A Solana public key: base58 that decodes to exactly 32 bytes. */
export function isPublicKey(s: string): boolean {
  return B58.test(s) && base58Bytes(s) === 32;
}

export type WalletInput = { ok: true; address: string } | { ok: false; error: string | null };

/**
 * What the user pasted → a wallet address. Accepts the bare address, with stray spaces or quotes, or an explorer /
 * profile link that ends in one (Solscan, Solana Explorer, GMGN, FUMPAD `/u/<address>`). Empty → no error yet.
 */
export function parseWalletInput(raw: string): WalletInput {
  const s = raw.trim().replace(/^["'`<]+|["'`>]+$/g, "");
  if (!s) return { ok: false, error: null };
  let candidate = s;
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      const parts = u.pathname.split("/").filter(Boolean);
      candidate = [...parts].reverse().find((p) => B58.test(p)) ?? "";
    } catch {
      candidate = "";
    }
    if (!candidate) return { ok: false, error: "That link doesn’t end in a wallet address. Paste the address itself." };
  }
  candidate = candidate.replace(/\s+/g, "");
  if (!B58.test(candidate)) {
    if (/[0OIl]/.test(candidate) && /^[0-9A-Za-z]+$/.test(candidate)) return { ok: false, error: "Solana addresses never contain 0, O, I or l. Check for a typo." };
    return { ok: false, error: "That isn’t a Solana address. It should be 32 to 44 letters and numbers." };
  }
  if (base58Bytes(candidate) !== 32) return { ok: false, error: "That isn’t a valid Solana address (wrong length). Check for a missing or extra character." };
  return { ok: true, address: candidate };
}

/* ── Copy for conditions, reasons and states ───────────────────────────────── */

type RuleParams = Pick<ProtocolParams, "minSellUsd" | "minHoldSecs" | "maxOpenTickets" | "triggerMultiple" | "claimBps" | "oracleWindowSecs" | "attestDelaySecs">;

const usdRule = (n: number) => (Number.isInteger(n) ? `$${n.toLocaleString("en-US")}` : `$${n.toFixed(2)}`);
export const minutes = (secs: number) => {
  const m = Math.round(secs / 60);
  return secs % 60 === 0 && m >= 1 ? `${m} min` : `${Math.round(secs)} s`;
};

export function reasonText(r: SellNoTicketReason, p: RuleParams): string {
  switch (r) {
    case "creator":
      return "You launched this coin. Creators never get tickets on their own coin.";
    case "not_matured":
      return `None of these tokens sat in your wallet for ${minutes(p.minHoldSecs)} before the sell, so it doesn’t count.`;
    case "below_minimum_usd":
      return `Worth less than ${usdRule(p.minSellUsd)} at the time of the sell (the part held ${minutes(p.minHoldSecs)}+), so no ticket.`;
    case "too_many_open_tickets":
      return `You already had ${p.maxOpenTickets} open tickets on this coin, the most one wallet can hold.`;
    case "same_tx_buy":
      return "Bought and sold in the same transaction, so it doesn’t count.";
    case "not_attested":
      return "It looked eligible, but no ticket was filed. Usually the tokens arrived by transfer less than 10 minutes before, or the SOL price couldn’t be verified at that second.";
  }
}

export function checkLabel(kind: "usd" | "hold" | "creator", p: RuleParams): string {
  return kind === "usd" ? `${usdRule(p.minSellUsd)}+ at sell time` : kind === "hold" ? `Held ${minutes(p.minHoldSecs)}+` : "Not the creator";
}

/** "5h 12m", "12m 03s", "41s". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export type StepKey = "verifying" | "challenge" | "open" | "claimable" | "done";

/** "6-hour check" (the challenge window from Global.params; 1 hour on devnet). */
export function checkName(challengeSecs: number): string {
  const h = challengeSecs / 3600;
  return Number.isInteger(h) ? `${h}-hour check` : `${Math.round(challengeSecs / 60)}-minute check`;
}

export function steps(challengeSecs: number): { key: StepKey; label: string }[] {
  return [
    { key: "verifying", label: "Verifying" },
    { key: "challenge", label: checkName(challengeSecs) },
    { key: "open", label: "Open" },
    { key: "claimable", label: "Claimable" },
    { key: "done", label: "Paid" },
  ];
}

/** Where a sell sits on the ticket's path, and the sentence that explains it (with live countdowns). */
export function ticketStatus(
  sell: Pick<FumbleSell, "outcome" | "ticket">,
  now: number,
  p: Pick<ProtocolParams, "attestDelaySecs" | "oracleWindowSecs" | "triggerMultiple" | "ticketChallengeSecs">,
): { step: StepKey | null; title: string; detail: string; closed?: boolean; money?: boolean } {
  if (sell.outcome === "no-ticket") return { step: null, title: "No ticket", detail: "", closed: true };
  if (sell.outcome === "verifying" || !sell.ticket)
    return {
      step: "verifying",
      title: "Verifying",
      detail: `Three independent keepers check the sell on chain; two must agree. Usually about ${Math.max(1, Math.round(p.attestDelaySecs / 60))} minute after the sell.`,
    };
  const t: Ticket = sell.ticket;
  const hold = `${Math.round(p.oracleWindowSecs / 60)}-minute`;
  const check = checkName(p.ticketChallengeSecs);
  switch (t.state) {
    case "verifying":
      return { step: "verifying", title: "Verifying", detail: "The keepers are attesting this sell." };
    case "challenge": {
      const left = t.claimableFrom !== undefined ? t.claimableFrom - now : undefined;
      return {
        step: "challenge",
        title: left !== undefined && left > 0 ? `${check[0].toUpperCase()}${check.slice(1)}: ${countdown(left)} left` : `${check[0].toUpperCase()}${check.slice(1)}`,
        detail: `Ticket filed. For ${f_dur(p.ticketChallengeSecs)} after it takes effect, a guardian can void it if the keepers got it wrong. It already counts toward ${p.triggerMultiple}×.`,
      };
    }
    case "awaiting-graduation":
      return { step: "open", title: "Open, waiting for graduation", detail: "Claims open once the coin graduates to Meteora. Your ticket is tracking already." };
    case "tracking":
      return { step: "open", title: "Open, tracking", detail: `Claimable when the ${hold} median holds ${p.triggerMultiple}× your ticket price.` };
    case "claimable":
      return { step: "claimable", title: "Claimable", detail: "The median holds the target. Claim in the app (it can also auto-claim).", money: true };
    case "queued":
      return {
        step: "claimable",
        title: t.queuePosition ? `Queued, #${t.queuePosition}` : "Queued",
        detail: "Your claim is in the coin’s claim queue. It pays as the reward pool grows; queued claims don’t expire.",
        money: true,
      };
    case "claimed":
      return { step: "done", title: t.escrowed ? "Paid to escrow" : "Paid", detail: "This ticket has been paid out.", money: true };
    case "voided":
      return {
        step: null,
        title: "Voided",
        detail: t.voidReason === "guardian" ? `A guardian voided this ticket during its ${check}.` : "Rebuys within 7 days used the ticket up.",
        closed: true,
      };
    case "expired":
      return { step: null, title: "Expired", detail: "The claim window ended before the coin held the target.", closed: true };
  }
}

function f_dur(secs: number): string {
  const h = secs / 3600;
  return Number.isInteger(h) ? `${h} hour${h === 1 ? "" : "s"}` : `${Math.round(secs / 60)} minutes`;
}

/* ── Claim target ──────────────────────────────────────────────────────────── */

/**
 * Progress from the coin's market cap now to the claim target: `fraction` (0…1, linear for the bar) and `multiple`
 * (market cap now ÷ market cap at the ticket price, the same number as the ticket's multiple).
 */
export function targetProgress(currentMcSol: number, targetMcSol: number, triggerMultiple: number) {
  if (!(targetMcSol > 0)) return { fraction: 0, multiple: 0, reached: false };
  const fraction = Math.max(0, Math.min(1, currentMcSol / targetMcSol));
  return { fraction, multiple: (currentMcSol / targetMcSol) * triggerMultiple, reached: currentMcSol >= targetMcSol };
}

/* ── Fees ──────────────────────────────────────────────────────────────────── */

export const pct = (bps: number) => {
  const v = bps / 100;
  return `${Number.isInteger(v) ? v : Number(v.toFixed(2))}%`;
};

/**
 * One line when a coin's own fee differs from the standard model the rules describe, e.g. the first coin:
 * "Launch coin: 3% fee. 1% of volume buys $FIRST back into its Reward Pool; 1.4% goes to the team wallet."
 */
export function feeNote(symbol: string, fees: CoinFees | undefined, standardFeeBps: number, label = "Launch coin"): string | null {
  if (!fees) return null;
  const differs = fees.feeBps !== standardFeeBps || fees.policy === "wallet_split";
  if (!differs) return null;
  if (fees.policy === "wallet_split" && fees.poolShareBps !== undefined && fees.walletShareBps !== undefined)
    return `${label} $${symbol}: ${pct(fees.feeBps)} fee. ${pct(fees.poolShareBps)} of volume buys $${symbol} back into its Reward Pool; ${pct(fees.walletShareBps)} goes to the team wallet, with no creator share.`;
  return `${label} $${symbol}: ${pct(fees.feeBps)} fee instead of ${pct(standardFeeBps)}.`;
}

/* ── Links ─────────────────────────────────────────────────────────────────── */

/** Where to trade a mint. Plain links to third-party apps, no referral codes. */
export function tradeLinks(mint: string): { label: string; href: string }[] {
  const m = encodeURIComponent(mint);
  return [
    { label: "Axiom", href: `https://axiom.trade/t/${m}` },
    { label: "Jupiter", href: `https://jup.ag/swap/SOL-${m}` },
    { label: "Phantom", href: `https://phantom.com/tokens/solana/${m}` },
    { label: "GMGN", href: `https://gmgn.ai/sol/token/${m}` },
  ];
}

/** Solscan for this cluster (query from `chain/cluster.ts`): token page, account, transaction. */
export function solscan(kind: "token" | "account" | "tx", id: string, clusterQuery: string): string {
  return `https://solscan.io/${kind}/${encodeURIComponent(id)}${clusterQuery}`;
}

/* ── App-opens countdown ──────────────────────────────────────────────────── */

/** NEXT_PUBLIC_APP_OPENS_AT → ms, or null when unset/unparseable. */
export function parseOpensAt(iso: string | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.trim());
  return Number.isFinite(t) ? t : null;
}

/** "Full app opens in ~25 min" / "… any minute now" / null once past. */
export function opensInText(opensAt: number | null, now: number): string | null {
  if (opensAt === null) return "The full app opens shortly.";
  const left = opensAt - now;
  if (left <= 0) return "The full app is opening now. Refresh in a moment.";
  if (left < 90_000) return "The full app opens any minute now.";
  return `The full app opens in ~${Math.round(left / 60_000)} min.`;
}
