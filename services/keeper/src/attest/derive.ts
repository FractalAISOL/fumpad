/**
 * Independent re-derivation of one coin's ticket decisions from THIS keeper's own RPC, finalized data only:
 * crawl (mint + every token account + the Coin PDA + attested ticket PDAs) → @fumpad/meteora records →
 * engine events (+ fumpad ticket-lifecycle events) → deterministic engine output. Nothing from peers,
 * the indexer or a webhook is trusted.
 */
import { PublicKey } from "@solana/web3.js";

import {
  buildEvents,
  type CoinFacts,
  crawlMintHistory,
  DEFAULT_ENGINE_PARAMS,
  type EngineEvent,
  type EngineOutput,
  type EngineParams,
  type HistoryTx,
  type PythPrice,
  runEngineWithPrices,
} from "@fumpad/engine";
import { type ConfirmedTx, type MeteoraRpc, parsePoolFacts } from "@fumpad/meteora";
import {
  buybackPda,
  type CoinAccount,
  coinPda,
  decodeDbcConfig,
  decodeFumpadEvents,
  eventSignature,
  feeClaimerPda,
  feeWsolPda,
  FUMPAD_PROGRAM_ID,
  type GlobalAccount,
  rewardPoolPda,
  TICKET_STATUS_NAMES,
  type TxLike,
} from "@fumpad/sdk";

/** Program-owned holders that are never wallets. */
export const PROTOCOL_OWNERS = (): Set<string> => new Set([rewardPoolPda(), buybackPda(), feeClaimerPda(), feeWsolPda()].map((k) => k.toBase58()));

/** Reward-pool PDA outflows mark a tx's inflows as FUMPAD payouts (claims, escrow withdrawals). */
export const PAYOUT_OWNERS = (): Set<string> => new Set([rewardPoolPda().toBase58()]);

/** Engine terms for a coin: its snapshotted reward terms + the global attestation params. */
export function engineParamsFor(coin: Pick<CoinAccount, "rewards">, global: Pick<GlobalAccount, "params">): EngineParams {
  const r = coin.rewards;
  return {
    ...DEFAULT_ENGINE_PARAMS,
    minSellUsdCents: r.minSellUsdCents,
    minHoldSecs: r.minHoldSecs,
    rebuyWindowSecs: r.rebuyWindowSecs,
    maxOpenTickets: r.maxOpenTickets,
    claimBps: BigInt(r.claimBps),
    maxPythDeltaSecs: Number(global.params.maxPriceAgeSecs),
    maxAttestAgeSecs: Number(global.params.maxAttestAgeSecs),
    trackAttestations: true,
  };
}

/**
 * fumpad ticket-lifecycle events (TicketAttested + every way a ticket leaves Open/Queued) as engine
 * events, in chain order. Tickets are mapped to the sell that created them through TicketAttested.
 */
export function lifecycleEvents(mint: string, history: readonly HistoryTx[]): EngineEvent[] {
  const out: EngineEvent[] = [];
  const refOf = new Map<string, { signature: string; ixKey: number }>();
  for (const { tx, txIndex } of history) {
    if (!tx.meta || tx.meta.err) continue;
    const signature = tx.transaction.signatures[0];
    const blockTime = tx.blockTime ?? 0;
    for (const ev of decodeFumpadEvents(tx as unknown as TxLike)) {
      const d = ev.data as Record<string, unknown>;
      const m = d.mint as PublicKey | undefined;
      if (m && m.toBase58() !== mint) continue;
      const key = { slot: tx.slot, txIndex, phase: 4 as const, ixKey: ev.index };
      const ticket = (d.ticket as PublicKey | undefined)?.toBase58();
      if (ev.name === "TicketAttested" && ticket) {
        const ref = { signature: eventSignature(d.signature as number[]), ixKey: Number(d.ixKey) };
        refOf.set(ticket, ref);
        out.push({ kind: "ticket_attested", key, signature, blockTime, ref, ticket });
        continue;
      }
      if (!ticket || !refOf.has(ticket)) continue;
      const ref = refOf.get(ticket)!;
      let status: "claimed" | "escrowed" | "expired" | "voided" | "closed" | null = null;
      if (ev.name === "ClaimPaid") status = "claimed";
      else if (ev.name === "ClaimEscrowed") status = "escrowed";
      else if (ev.name === "TicketVoided") status = "voided";
      else if (ev.name === "TicketDebited" && d.voided) status = "voided";
      else if (ev.name === "TicketClosed") {
        const s = TICKET_STATUS_NAMES[Number(d.finalStatus)];
        status = s === "expired" ? "expired" : "closed";
      }
      if (status) out.push({ kind: "ticket_status", key, signature, blockTime, ticket: ref, status });
    }
  }
  return out;
}

export interface DeriveCaches {
  txCache: Map<string, ConfirmedTx>;
  blockIndexCache: Map<number, Map<string, number>>;
  /** Ticket PDAs known per mint (crawled for guardian voids). */
  tickets: Map<string, Set<string>>;
}
export const newCaches = (): DeriveCaches => ({ txCache: new Map(), blockIndexCache: new Map(), tickets: new Map() });

export interface Derivation {
  coin: CoinFacts;
  output: EngineOutput;
  /** Finalized snapshot slot the derivation is bounded by. */
  maxSlot: number;
  txCount: number;
  /** The crawled finalized history (watcher decodes the on-chain attestations from it). */
  history: HistoryTx[];
}

export interface DeriveDeps {
  rpc: MeteoraRpc;
  fetchPrice: (blockTime: number, maxDeltaSecs: number) => Promise<PythPrice | null>;
  caches: DeriveCaches;
  priceCache?: Map<number, PythPrice | null>;
}

/** Derive one registered coin. Throws on any inconsistency between the Coin account and the chain history. */
export async function deriveCoin(d: DeriveDeps, coin: CoinAccount, global: GlobalAccount, maxSlot?: number): Promise<Derivation> {
  const mint = coin.mint.toBase58();
  const known = d.caches.tickets.get(mint) ?? new Set<string>();
  const crawl = await crawlMintHistory(d.rpc, mint, {
    maxSlot,
    protocolOwners: PROTOCOL_OWNERS(),
    txCache: d.caches.txCache,
    blockIndexCache: d.caches.blockIndexCache,
    extraAddresses: [coinPda(coin.mint).toBase58(), ...known],
  });
  // Pool creation tx: the DBC EvtInitializePool for this mint must match the Coin account.
  let launch: HistoryTx | undefined;
  for (const h of crawl.history) {
    const p = parsePoolFacts(h.tx).dbcPools.find((x) => x.baseMint === mint);
    if (p) {
      if (p.pool !== coin.dbcPool.toBase58() || p.config !== coin.dbcConfig.toBase58() || p.creator !== coin.creator.toBase58()) {
        throw new Error(`coin ${mint}: pool creation (${p.pool}/${p.config}/${p.creator}) disagrees with the Coin account`);
      }
      launch = h;
      break;
    }
  }
  if (!launch) throw new Error(`coin ${mint}: no DBC pool creation in its finalized history`);
  const cfg = await d.rpc.call<{ value: { data: [string, string]; owner: string } | null }>("getAccountInfo", [coin.dbcConfig.toBase58(), { encoding: "base64", commitment: "finalized" }]);
  if (!cfg.value) throw new Error(`coin ${mint}: DBC config missing`);
  const config = decodeDbcConfig(Uint8Array.from(Buffer.from(cfg.value.data[0], "base64")));
  const facts: CoinFacts = {
    mint,
    creator: coin.creator.toBase58(),
    dbcPool: coin.dbcPool.toBase58(),
    config: coin.dbcConfig.toBase58(),
    startSqrtPrice: config.sqrtStartPrice,
    launchBlockTime: launch.tx.blockTime ?? 0,
    launchSlot: launch.tx.slot,
    dammPool: coin.dammPool.equals(PublicKey.default) ? null : coin.dammPool.toBase58(),
  };
  const events = [
    ...buildEvents(facts, crawl.history, { protocolOwners: PROTOCOL_OWNERS(), payoutOwners: PAYOUT_OWNERS(), routerProgramId: FUMPAD_PROGRAM_ID.toBase58() }),
    ...lifecycleEvents(mint, crawl.history),
  ];
  for (const e of events) if (e.kind === "ticket_attested") known.add(e.ticket);
  d.caches.tickets.set(mint, known);
  const params = engineParamsFor(coin, global);
  const output = await runEngineWithPrices(facts, events, params, (t) => d.fetchPrice(t, params.maxPythDeltaSecs), {
    protocolOwners: PROTOCOL_OWNERS(),
    cache: d.priceCache,
  });
  return { coin: facts, output, maxSlot: crawl.maxSlot, txCount: crawl.history.length, history: crawl.history };
}
