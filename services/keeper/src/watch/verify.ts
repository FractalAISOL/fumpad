/**
 * Watcher verification (SPEC v0.7 §5.3): every on-chain TicketAttested / TicketDebited is compared field by
 * field with this process's own independent derivation. Pure: (derivation, on-chain events, now) → verdicts.
 */
import { type EngineOutput, type HistoryTx, refKey } from "@fumpad/engine";
import { decodeFumpadEvents, eventSignature, type TicketAttestedEvent, type TicketDebitedEvent, type TxLike, VENUE_DAMM_BIT, VENUE_ROUTED_BIT } from "@fumpad/sdk";

export type Verdict = "match" | "mismatch";

export interface AttestationVerdict {
  kind: "sell" | "rebuy";
  verdict: Verdict;
  mint: string;
  ticket: string;
  owner: string;
  /** trade / acquisition tx + ix key */
  signature: string;
  ixKey: number;
  /** attestation tx */
  attestedIn: string;
  attestedAt: number;
  /** field → [on-chain, derived] */
  diffs: Record<string, [string, string]>;
  /** sells: derived no-ticket reason when the engine made none */
  reason?: string | null;
  keepers?: string[];
}

export interface MissingAttestation {
  kind: "sell" | "rebuy";
  mint: string;
  owner: string;
  signature: string;
  ixKey: number;
  ticket?: string | null;
  blockTime: number;
  ageSecs: number;
}

export interface CoinVerification {
  mint: string;
  verdicts: AttestationVerdict[];
  /** Derived attestations not on chain after the grace period (liveness / missed debits). */
  missing: MissingAttestation[];
}

const s = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v));

export function onchainAttestations(mint: string, history: readonly HistoryTx[]) {
  const sells: { ev: TicketAttestedEvent; tx: string; ts: number }[] = [];
  const debits: { ev: TicketDebitedEvent; tx: string; ts: number }[] = [];
  for (const { tx } of history) {
    if (!tx.meta || tx.meta.err) continue;
    for (const e of decodeFumpadEvents(tx as unknown as TxLike)) {
      const d = e.data as unknown as { mint?: { toBase58(): string } };
      if (d.mint?.toBase58() !== mint) continue;
      if (e.name === "TicketAttested") sells.push({ ev: e.data as unknown as TicketAttestedEvent, tx: tx.transaction.signatures[0], ts: tx.blockTime ?? 0 });
      if (e.name === "TicketDebited") debits.push({ ev: e.data as unknown as TicketDebitedEvent, tx: tx.transaction.signatures[0], ts: tx.blockTime ?? 0 });
    }
  }
  return { sells, debits };
}

export function verifyCoin(mint: string, output: EngineOutput, history: readonly HistoryTx[], now: number, graceSecs = 900): CoinVerification {
  const { sells, debits } = onchainAttestations(mint, history);
  const derivedSells = new Map(output.sells.map((x) => [refKey({ signature: x.signature, ixKey: x.ixKey }), x]));
  const verdicts: AttestationVerdict[] = [];
  const attestedRefs = new Set<string>();
  const ticketToRef = new Map<string, string>();
  for (const { ev, tx, ts } of sells) {
    const signature = eventSignature(ev.signature);
    const key = refKey({ signature, ixKey: Number(ev.ixKey) });
    attestedRefs.add(key);
    ticketToRef.set(ev.ticket.toBase58(), key);
    const d = derivedSells.get(key);
    const diffs: Record<string, [string, string]> = {};
    const cmp = (f: string, a: unknown, b: unknown) => {
      if (s(a) !== s(b)) diffs[f] = [s(a), s(b)];
    };
    if (!d || !d.ticket) {
      diffs.ticket = ["attested", d ? `no ticket (${d.reason})` : "no such sell on our pools"];
    } else {
      const venue = (d.venue === "damm_v2" ? VENUE_DAMM_BIT : 0) | (d.routed ? VENUE_ROUTED_BIT : 0);
      cmp("owner", ev.owner.toBase58(), d.trader);
      cmp("pool", ev.pool.toBase58(), d.pool);
      cmp("venue", Number(ev.venue) | (Number(ev.source) ? VENUE_ROUTED_BIT : 0), venue);
      cmp("baseAmount", ev.baseAmount, d.baseAmount);
      cmp("quoteGross", ev.quoteGross, d.quoteGross);
      cmp("tokens", ev.tokens, d.ticket.ticketTokens);
      cmp("sellPriceQ64", ev.sellPriceQ64, d.ticket.ticketPriceQ64);
      cmp("sellUsdCents", ev.sellUsdCents, d.ticket.usdCents);
      cmp("pythPublishTime", ev.pythPublishTime, d.ticket.pythPublishTime);
      cmp("slot", ev.slot, d.slot);
      cmp("sellTs", ev.sellTs, d.blockTime);
    }
    verdicts.push({
      kind: "sell",
      verdict: Object.keys(diffs).length ? "mismatch" : "match",
      mint,
      ticket: ev.ticket.toBase58(),
      owner: ev.owner.toBase58(),
      signature,
      ixKey: Number(ev.ixKey),
      attestedIn: tx,
      attestedAt: ts,
      diffs,
      reason: d?.reason ?? null,
      keepers: ev.keepers.map((k) => k.toBase58()),
    });
  }
  const derivedDebits = new Map(output.rebuys.filter((r) => r.ticketAddress).map((r) => [`${r.signature}:${r.ixKey}:${r.ticketAddress}`, r]));
  const onchainDebitKeys = new Set<string>();
  for (const { ev, tx, ts } of debits) {
    const signature = eventSignature(ev.signature);
    const k = `${signature}:${Number(ev.ixKey)}:${ev.ticket.toBase58()}`;
    onchainDebitKeys.add(k);
    const d = derivedDebits.get(k);
    const diffs: Record<string, [string, string]> = {};
    if (!d) diffs.debit = [s(ev.debited), "no such debit derived"];
    else if (s(ev.debited) !== s(d.debit)) diffs.debit = [s(ev.debited), s(d.debit)];
    verdicts.push({ kind: "rebuy", verdict: Object.keys(diffs).length ? "mismatch" : "match", mint, ticket: ev.ticket.toBase58(), owner: ev.owner.toBase58(), signature, ixKey: Number(ev.ixKey), attestedIn: tx, attestedAt: ts, diffs });
  }
  const missing: MissingAttestation[] = [];
  for (const x of output.sells) {
    if (!x.ticket || !x.trader) continue;
    const key = refKey({ signature: x.signature, ixKey: x.ixKey });
    if (!attestedRefs.has(key) && now - x.blockTime > graceSecs) missing.push({ kind: "sell", mint, owner: x.trader, signature: x.signature, ixKey: x.ixKey, blockTime: x.blockTime, ageSecs: now - x.blockTime });
  }
  for (const r of output.rebuys) {
    if (!r.ticketAddress) continue;
    const k = `${r.signature}:${r.ixKey}:${r.ticketAddress}`;
    if (!onchainDebitKeys.has(k) && now - r.blockTime > graceSecs) missing.push({ kind: "rebuy", mint, owner: r.wallet, signature: r.signature, ixKey: r.ixKey, ticket: r.ticketAddress, blockTime: r.blockTime, ageSecs: now - r.blockTime });
  }
  return { mint, verdicts, missing };
}
