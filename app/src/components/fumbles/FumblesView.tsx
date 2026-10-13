"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFumpadTx } from "@/chain/tx";
import { keepSnapshot, type ProtocolParams, type Ticket, getFumpadData } from "@/data";
import { Button, EmptyState, Loading, Multiple, Panel, PanelHead, Segmented, Skeleton, TicketCard, cx, useToast } from "@/design";
import * as f from "@/design/format";
import { ClaimMoment, type ClaimResult } from "../moment/ClaimMoment";
import { ShareButton } from "../share/ShareButton";
import { useRefresh } from "../shell/live";
import { useNow, useProtocolParams, useViewer } from "../shell/Providers";
import s from "./Fumbles.module.css";

type Filter = "all" | "new" | "claimable" | "tracking" | "waiting" | "queued" | "closed" | "flagged";

/** States a ticket can still move out of (the views watch these coins and count them as open). */
const LIVE: Ticket["state"][] = ["verifying", "challenge", "claimable", "tracking", "queued", "awaiting-graduation"];

const MATCH: Record<Filter, (t: Ticket) => boolean> = {
  all: () => true,
  new: (t) => t.state === "verifying" || t.state === "challenge",
  claimable: (t) => t.state === "claimable",
  tracking: (t) => t.state === "tracking",
  waiting: (t) => t.state === "awaiting-graduation",
  queued: (t) => t.state === "queued",
  closed: (t) => t.state === "claimed" || t.state === "expired" || t.state === "voided",
  flagged: () => false,
};

const ORDER: Record<Ticket["state"], number> = {
  claimable: 0,
  queued: 1,
  verifying: 2,
  challenge: 3,
  tracking: 4,
  "awaiting-graduation": 5,
  claimed: 6,
  expired: 7,
  voided: 8,
};

/** One sentence for any ticket state that needs explaining. */
function note(t: Ticket, p: ProtocolParams): React.ReactNode {
  const median = `${f.durationShort(p.oracleWindowSecs)} median`;
  const rebuy = f.duration(p.rebuyWindowSecs);
  const parts: React.ReactNode[] = [];
  if (t.state === "verifying") {
    parts.push(
      <>
        Your sell landed. FUMPAD&apos;s keepers check it against the chain and attest it, usually within {f.duration(p.attestDelaySecs)}; then the
        ticket exists on chain.
      </>,
    );
  }
  if (t.state === "challenge") {
    parts.push(
      <>
        Attested. It already counts toward 10×; claims open {t.claimableFrom ? <>at {f.dateTime(t.claimableFrom)} UTC</> : "after the challenge window"}, once the{" "}
        {f.duration(p.ticketChallengeSecs)} window to catch a bad attestation has passed.
      </>,
    );
  }
  if (t.state === "queued" && t.queueNeedsPool) {
    parts.push(
      <>
        Queued at position {t.queuePosition}. A claim can take at most 10% of the pool, so your {f.int(t.claimAmount)} pays when the ${t.symbol} pool reaches{" "}
        {f.compact(t.queueNeedsPool)}
        {t.queueEta ? `, ${f.eta(t.queueEta)} at current volume` : ""}. Queued claims don&apos;t expire.
      </>,
    );
  }
  if (t.state === "awaiting-graduation") {
    parts.push(
      t.multiple >= 10 ? (
        <>
          Already past 10×. ${t.symbol} is still on the curve; claiming opens when it graduates and the {median} holds 10× there.
        </>
      ) : (
        <>${t.symbol} is still on the bonding curve. Your ticket counts toward 10× now; claiming opens when it graduates.</>
      ),
    );
  }
  if (t.rebuyDebited > 0 && t.state !== "expired") {
    parts.push(
      <>
        You rebought {f.int(t.rebuyDebited)} {t.symbol} within {rebuy} of this sell, so the claim shrank from {f.int(t.originalTokens * 0.1)} to{" "}
        {f.int(t.claimAmount)}.
      </>,
    );
  }
  if (t.execPrice < t.sellPrice * 0.999 && t.state !== "expired" && t.state !== "claimed") {
    parts.push(<>Priced at the recent-average floor, above your fill of {f.priceText(t.execPrice)} SOL, because the price had just dropped.</>);
  }
  if (t.state === "expired") {
    parts.push(
      <>
        Expired {f.duration(p.claimWindowSecs)} after the sell. It peaked at {f.multiple(t.peakMultiple)}. Sometimes selling was right.
      </>,
    );
  }
  if (t.state === "voided")
    parts.push(
      t.voidReason === "guardian" ? (
        <>Voided in the challenge window: the attestation didn&apos;t match the chain, so this ticket never counted.</>
      ) : (
        <>Rebuys within {rebuy} brought this ticket to zero.</>
      ),
    );
  if (t.state === "claimed" && t.escrowed)
    parts.push(<>Your token account refused the payout, so it went to this ticket&apos;s escrow. It&apos;s yours to withdraw any time.</>);
  if (t.autoClaimed && (t.state === "claimed" || t.state === "queued")) parts.push(<>Auto-claimed: the keeper claimed it for you, straight to your wallet.</>);
  if (!parts.length) return undefined;
  return parts.map((p, i) => (
    <span key={i}>
      {i > 0 && " "}
      {p}
    </span>
  ));
}

export function FumblesView({ initial }: { initial: Ticket[] }) {
  const data = getFumpadData();
  const { address, isDemo, setClaimable } = useViewer();
  const now = useNow();
  const toast = useToast();
  const tx = useFumpadTx();
  const params = useProtocolParams();
  const [tickets, setTickets] = useState<Ticket[] | null>(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [moment, setMoment] = useState<Ticket | null>(null);

  /**
   * Local results of the viewer's own actions (claimed, queued, auto-claim) layered on top
   * of fetched tickets until the indexer reports the same change, so a refetch that lands
   * before the indexer can't flip a claimed ticket back to "claimable" for a moment.
   */
  const overrides = useRef(new Map<string, { patch: Partial<Ticket>; from: Ticket["state"]; fromAuto: boolean; until: number }>());
  const applyOverrides = useCallback((ts: Ticket[]) => {
    const now = Date.now();
    return ts.map((t) => {
      const o = overrides.current.get(t.id);
      if (!o) return t;
      const settled = now > o.until || t.state !== o.from || ("autoClaim" in o.patch && t.autoClaim !== o.fromAuto);
      if (settled) {
        overrides.current.delete(t.id);
        return t;
      }
      return { ...t, ...o.patch };
    });
  }, []);
  const override = useCallback((t: Ticket, patch: Partial<Ticket>) => {
    overrides.current.set(t.id, { patch, from: t.state, fromAuto: t.autoClaim, until: Date.now() + 30_000 });
  }, []);

  // Tickets move when this wallet transacts, when anything touches it (a keeper auto-claim,
  // a queue payout) and when the coins it holds tickets in move (progress toward 10×).
  const current = useRef(address);
  useEffect(() => {
    current.current = address;
  }, [address]);
  const load = useCallback(() => {
    const want = address;
    data
      .getTickets(want)
      .then((ts) => {
        if (want !== current.current) return;
        const next = applyOverrides(ts);
        setTickets(next);
        setClaimable(next.filter((t) => t.state === "claimable").length);
      })
      .catch(keepSnapshot);
  }, [data, address, applyOverrides, setClaimable]);
  const watchMints = useMemo(
    () => [...new Set((tickets ?? []).filter((t) => LIVE.includes(t.state)).map((t) => t.mint))].sort(),
    [tickets],
  );
  useRefresh(load, { wallets: [address], mints: watchMints, pollMs: 30_000, debounceMs: 1_000 });

  const list = useMemo(() => {
    if (!tickets) return [];
    return tickets.filter(MATCH[filter]).sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.multiple - a.multiple);
  }, [tickets, filter]);

  const counts = useMemo(() => {
    const c = {} as Record<Filter, number>;
    (Object.keys(MATCH) as Filter[]).forEach((k) => (c[k] = tickets?.filter(MATCH[k]).length ?? 0));
    return c;
  }, [tickets]);

  const claimableSol = tickets?.filter((t) => t.state === "claimable").reduce((a, t) => a + t.claimValueSol, 0) ?? 0;
  const open = tickets?.filter((t) => LIVE.includes(t.state)) ?? [];
  const queued = tickets?.filter((t) => t.state === "queued") ?? [];
  const closest = tickets
    ?.filter((t) => (t.state === "tracking" || t.state === "awaiting-graduation" || t.state === "challenge") && t.multiple < 10)
    .sort((a, b) => b.multiple - a.multiple)[0];

  // D17: auto-claim is per coin (Position.auto_claim_opt_out); list coins with open tickets.
  const autoCoins = useMemo(() => {
    const m = new Map<string, { mint: string; symbol: string; autoClaim: boolean; open: number }>();
    for (const t of tickets ?? []) {
      if (!LIVE.includes(t.state) || t.state === "verifying") continue;
      const e = m.get(t.mint) ?? { mint: t.mint, symbol: t.symbol, autoClaim: t.autoClaim, open: 0 };
      e.open++;
      m.set(t.mint, e);
    }
    return [...m.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }, [tickets]);
  const [autoBusy, setAutoBusy] = useState<string | null>(null);

  const toggleAuto = useCallback(
    async (mint: string, symbol: string, enabled: boolean) => {
      setAutoBusy(mint);
      const res = await tx.setAutoClaim({ mint, enabled, owner: address });
      setAutoBusy(null);
      tx.reset();
      if (!res) {
        toast(tx.error ?? "Auto-claim didn't change. Try again.");
        return;
      }
      setTickets(
        (ts) =>
          ts?.map((t) => {
            if (t.mint !== mint) return t;
            override(t, { autoClaim: enabled });
            return { ...t, autoClaim: enabled };
          }) ?? ts,
      );
      toast(enabled ? `Auto-claim on for $${symbol}.` : `Auto-claim off for $${symbol}. You'll claim by hand.`);
    },
    [tx, address, toast, override],
  );

  const onClaim = useCallback(async (): Promise<ClaimResult> => {
    if (!moment) return { status: "error", message: "No ticket selected." };
    const coin = await data.getCoin(moment.mint);
    const fits = coin ? moment.claimAmount <= coin.poolTokens * 0.1 : true;
    const res = await tx.claim({ mint: moment.mint, ticket: moment.id });
    if (!res) return { status: "error", message: tx.error ?? "The claim didn't go through. Nothing was sent; try again." };
    if (!fits) {
      const q = await data.getClaimQueue(moment.mint, address);
      const position = q.entries.length + 1;
      const patch: Partial<Ticket> = { state: "queued", chainStatus: "queued", queuePosition: position, queueNeedsPool: moment.claimAmount * 10, expiresAt: undefined };
      override(moment, patch);
      setTickets((ts) => ts?.map((t) => (t.id === moment.id ? { ...t, ...patch } : t)) ?? ts);
      return { status: "queued", position, needsPool: moment.claimAmount * 10 };
    }
    const at = data.now();
    const patch: Partial<Ticket> = { state: "claimed", chainStatus: "claimed", claimedAt: at, claimTx: res.signature, expiresAt: undefined };
    override(moment, patch);
    setTickets((ts) => ts?.map((t) => (t.id === moment.id ? { ...t, ...patch } : t)) ?? ts);
    setClaimable(Math.max(0, (tickets?.filter((t) => t.state === "claimable").length ?? 1) - 1));
    toast(`Claimed ${f.int(moment.claimAmount)} ${moment.symbol}.`, "money");
    return { status: "paid", signature: res.signature, at };
  }, [moment, data, tx, address, setClaimable, tickets, toast, override]);

  /** D16: move an escrowed payout into the wallet's own token account. */
  const [escrowBusy, setEscrowBusy] = useState<string | null>(null);
  const onWithdrawEscrow = useCallback(
    async (t: Ticket) => {
      setEscrowBusy(t.id);
      const res = await tx.withdrawEscrow({ mint: t.mint, ticket: t.id });
      setEscrowBusy(null);
      tx.reset();
      if (!res) {
        toast(tx.lastError() ?? "The withdrawal didn't go through. Nothing was sent; try again.");
        return;
      }
      const patch: Partial<Ticket> = { escrowed: false, chainStatus: "claimed" };
      override(t, patch);
      if (res.simulated && "markEscrowWithdrawn" in data) (data as { markEscrowWithdrawn: (id: string) => void }).markEscrowWithdrawn(t.id);
      setTickets((ts) => ts?.map((x) => (x.id === t.id ? { ...x, ...patch } : x)) ?? ts);
      toast(`Withdrew ${f.int(t.claimAmount)} ${t.symbol} to your wallet.`, "money");
    },
    [tx, toast, override, data],
  );

  const FILTERS: { value: Filter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.all },
    { value: "new", label: "Verifying", count: counts.new },
    { value: "claimable", label: "Claimable", count: counts.claimable },
    { value: "tracking", label: "Tracking", count: counts.tracking },
    { value: "waiting", label: "Waiting to graduate", count: counts.waiting },
    { value: "queued", label: "Queued", count: counts.queued },
    { value: "closed", label: "Closed", count: counts.closed },
    { value: "flagged", label: "Flagged", count: counts.flagged },
  ];

  return (
    <div className="wrap">
      <div className={s.pageHead}>
        <h1 className={s.h1}>My fumbles</h1>
        <p className={s.lede}>
          Every sell of a FUMPAD coin over {f.usdRule(params.minSellUsd)}, on any app, measured against 10× of your price. Claim 10% of what you sold once the{" "}
          {f.durationAdj(params.oracleWindowSecs)} median holds there.
        </p>
        {isDemo && <p className={s.demo}>Showing a demo wallet. Log in to see your own tickets.</p>}
      </div>

      <div className={s.sum} role="group" aria-label="Summary">
        <div className={s.hot}>
          <div className={s.k}>Claimable now</div>
          <div className={cx("num", s.v)}>
            {f.sol(claimableSol)} <small>SOL</small>
          </div>
        </div>
        <div>
          <div className={s.k}>Open tickets</div>
          <div className={cx("num", s.v)}>
            {open.length} <small>of {tickets?.length ?? 0}</small>
          </div>
        </div>
        <div>
          <div className={s.k}>In a queue</div>
          <div className={cx("num", s.v)}>
            {queued.length} {queued[0] && <small>position {queued[0].queuePosition}</small>}
          </div>
        </div>
        <div>
          <div className={s.k}>Next closest</div>
          <div className={s.v}>
            {closest ? (
              <>
                <Multiple x={closest.multiple} /> <small className="ticker">${closest.symbol}</small>
              </>
            ) : (
              <span className="num">–</span>
            )}
          </div>
        </div>
      </div>

      {autoCoins.length > 0 && (
        <Panel className={s.auto} aria-label="Auto-claim">
          <PanelHead title="Auto-claim" aside="per coin" />
          <p className={s.autoLede}>
            When a ticket&apos;s {f.durationAdj(params.oracleWindowSecs)} median holds 10×, the keeper claims it for you and the tokens land in your wallet.
            Turn it off to claim by hand.
          </p>
          <ul className={s.autoList}>
            {autoCoins.map((c) => (
              <li key={c.mint} className={s.autoRow}>
                <span className="ticker">${c.symbol}</span>
                <span className={s.autoCount}>
                  {c.open} open {c.open === 1 ? "ticket" : "tickets"}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={c.autoClaim}
                  aria-label={`Auto-claim $${c.symbol}`}
                  className={s.switch}
                  disabled={autoBusy !== null}
                  aria-busy={autoBusy === c.mint || undefined}
                  onClick={() => toggleAuto(c.mint, c.symbol, !c.autoClaim)}
                >
                  <span className={s.knob} aria-hidden="true" />
                  <span className={s.switchText}>{c.autoClaim ? "On" : "Off"}</span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className={s.bar}>
        <Segmented label="Filter tickets" value={filter} onChange={setFilter} items={FILTERS} />
        <span className={s.sorted}>Claimable first, then closest to 10×</span>
      </div>

      <Panel className={s.tickets} aria-label="Tickets">
        {!tickets ? (
          <Loading label="Loading tickets">
            {[0, 1, 2].map((i) => (
              <div key={i} className={s.skelRow}>
                <Skeleton w={36} h={36} />
                <Skeleton h={10} />
                <Skeleton w={80} h={30} />
              </div>
            ))}
          </Loading>
        ) : list.length ? (
          <ul className={s.list}>
            {list.map((t) => (
              <TicketCard
                key={t.id}
                as="li"
                ticket={t}
                now={now}
                note={note(t, params)}
                action={
                  t.state === "claimable" ? (
                    <>
                      <Button variant="flare" onClick={() => setMoment(t)}>
                        Claim {f.int(t.claimAmount)}
                      </Button>
                      <ShareButton ticket={t} />
                    </>
                  ) : t.state === "claimed" && t.escrowed ? (
                    <>
                      <Button variant="flare" onClick={() => onWithdrawEscrow(t)} loading={escrowBusy === t.id} disabled={escrowBusy !== null}>
                        Withdraw {f.int(t.claimAmount)}
                      </Button>
                      <ShareButton ticket={t} />
                    </>
                  ) : (
                    <ShareButton ticket={t} />
                  )
                }
              />
            ))}
          </ul>
        ) : filter === "flagged" ? (
          <EmptyState
            title="No flags"
            action={
              <Button variant="line" size="sm" onClick={() => setFilter("all")}>
                Show all tickets
              </Button>
            }
          >
            Your wallet is clean, which is rarer than a 10×. Rebuys elsewhere within {f.duration(params.rebuyWindowSecs)} or linked wallets would show up here.
          </EmptyState>
        ) : tickets.length === 0 ? (
          <EmptyState title="No fumbles yet" action={<Button href="/launches">Browse launches</Button>}>
            Sell {f.usdRule(params.minSellUsd)} or more of any FUMPAD coin, here or on any other app, and the ticket shows up here about a minute later, measured
            against 10× of your price.
          </EmptyState>
        ) : (
          <EmptyState
            title="Nothing here"
            action={
              <Button variant="line" size="sm" onClick={() => setFilter("all")}>
                Show all tickets
              </Button>
            }
          >
            No tickets in this state right now.
          </EmptyState>
        )}
      </Panel>

      {moment && <ClaimMoment ticket={moment} walletLabel={f.shortAddr(address)} onClose={() => setMoment(null)} onClaim={onClaim} />}
    </div>
  );
}
