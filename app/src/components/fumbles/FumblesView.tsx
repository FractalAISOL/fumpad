"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useFumpadTx } from "@/chain/tx";
import { DEMO_WALLET, type Ticket, getFumpadData } from "@/data";
import { Button, EmptyState, Loading, Multiple, Panel, PanelHead, Segmented, Skeleton, TicketCard, cx, useToast } from "@/design";
import * as f from "@/design/format";
import { ClaimMoment, type ClaimResult } from "../moment/ClaimMoment";
import { useNow, useViewer } from "../shell/Providers";
import s from "./Fumbles.module.css";

type Filter = "all" | "claimable" | "tracking" | "waiting" | "queued" | "closed" | "flagged";

const MATCH: Record<Filter, (t: Ticket) => boolean> = {
  all: () => true,
  claimable: (t) => t.state === "claimable",
  tracking: (t) => t.state === "tracking",
  waiting: (t) => t.state === "awaiting-graduation",
  queued: (t) => t.state === "queued",
  closed: (t) => t.state === "claimed" || t.state === "expired" || t.state === "voided",
  flagged: () => false,
};

const ORDER: Record<Ticket["state"], number> = { claimable: 0, queued: 1, tracking: 2, "awaiting-graduation": 3, claimed: 4, expired: 5, voided: 6 };

/** One sentence for any ticket state that needs explaining. */
function note(t: Ticket): React.ReactNode {
  const parts: React.ReactNode[] = [];
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
        <>Already past 10×. ${t.symbol} is still on the curve; claiming opens when it graduates and the 30-min median holds 10× there.</>
      ) : (
        <>${t.symbol} is still on the bonding curve. Your ticket counts toward 10× now; claiming opens when it graduates.</>
      ),
    );
  }
  if (t.rebuyDebited > 0 && t.state !== "expired") {
    parts.push(
      <>
        You rebought {f.int(t.rebuyDebited)} {t.symbol} within 7 days of this sell, so the claim shrank from {f.int(t.originalTokens * 0.1)} to{" "}
        {f.int(t.claimAmount)}.
      </>,
    );
  }
  if (t.execPrice < t.sellPrice * 0.999 && t.state !== "expired" && t.state !== "claimed") {
    parts.push(<>Priced at the recent-average floor, above your fill of {f.priceText(t.execPrice)} SOL, because the price had just dropped.</>);
  }
  if (t.state === "expired") {
    parts.push(<>Expired 90 days after the sell. It peaked at {f.multiple(t.peakMultiple)}. Sometimes selling was right.</>);
  }
  if (t.state === "voided") parts.push(<>Rebuys within 7 days brought this ticket to zero.</>);
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
  const [tickets, setTickets] = useState<Ticket[] | null>(initial);
  const [filter, setFilter] = useState<Filter>("all");
  const [moment, setMoment] = useState<Ticket | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(DEMO_WALLET);

  useEffect(() => {
    if (loadedFor === address) return;
    let live = true;
    data.getTickets(address).then((ts) => {
      if (!live) return;
      setTickets(ts);
      setLoadedFor(address);
    });
    return () => {
      live = false;
    };
  }, [data, address, loadedFor]);

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
  const open = tickets?.filter((t) => ["claimable", "tracking", "queued", "awaiting-graduation"].includes(t.state)) ?? [];
  const queued = tickets?.filter((t) => t.state === "queued") ?? [];
  const closest = tickets
    ?.filter((t) => (t.state === "tracking" || t.state === "awaiting-graduation") && t.multiple < 10)
    .sort((a, b) => b.multiple - a.multiple)[0];

  // D17: auto-claim is per coin (Position.auto_claim_opt_out); list coins with open tickets.
  const autoCoins = useMemo(() => {
    const m = new Map<string, { mint: string; symbol: string; autoClaim: boolean; open: number }>();
    for (const t of tickets ?? []) {
      if (!["claimable", "tracking", "queued", "awaiting-graduation"].includes(t.state)) continue;
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
      setTickets((ts) => ts?.map((t) => (t.mint === mint ? { ...t, autoClaim: enabled } : t)) ?? ts);
      toast(enabled ? `Auto-claim on for $${symbol}.` : `Auto-claim off for $${symbol}. You'll claim by hand.`);
    },
    [tx, address, toast],
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
      setTickets(
        (ts) =>
          ts?.map((t) =>
            t.id === moment.id
              ? { ...t, state: "queued", chainStatus: "queued", queuePosition: position, queueNeedsPool: t.claimAmount * 10, expiresAt: undefined }
              : t,
          ) ?? ts,
      );
      return { status: "queued", position, needsPool: moment.claimAmount * 10 };
    }
    const at = data.now();
    setTickets(
      (ts) =>
        ts?.map((t) =>
          t.id === moment.id ? { ...t, state: "claimed", chainStatus: "claimed", claimedAt: at, claimTx: res.signature, expiresAt: undefined } : t,
        ) ?? ts,
    );
    setClaimable(Math.max(0, (tickets?.filter((t) => t.state === "claimable").length ?? 1) - 1));
    toast(`Claimed ${f.int(moment.claimAmount)} ${moment.symbol}.`, "money");
    return { status: "paid", signature: res.signature, at };
  }, [moment, data, tx, address, setClaimable, tickets, toast]);

  const FILTERS: { value: Filter; label: string; count: number }[] = [
    { value: "all", label: "All", count: counts.all },
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
          Every sell you made through FUMPAD, measured against 10× of your price. Claim 10% of what you sold once the 30-minute median holds there.
        </p>
        {isDemo && <p className={s.demo}>Showing a demo wallet. Connect yours to see your own tickets.</p>}
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
            When a ticket&apos;s 30-minute median holds 10×, the keeper claims it for you and the tokens land in your wallet. Turn it off to claim by hand.
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
                note={note(t)}
                action={
                  t.state === "claimable" ? (
                    <Button variant="flare" onClick={() => setMoment(t)}>
                      Claim {f.int(t.claimAmount)}
                    </Button>
                  ) : t.state === "claimed" ? (
                    <Button variant="line" size="sm" href={`/share/${t.id}`}>
                      Share card
                    </Button>
                  ) : undefined
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
            Your wallet is clean, which is rarer than a 10×. Rebuys elsewhere within 7 days or linked wallets would show up here.
          </EmptyState>
        ) : tickets.length === 0 ? (
          <EmptyState title="No fumbles yet" action={<Button href="/coins">Find a coin</Button>}>
            Sell $50 or more of any coin through FUMPAD and the ticket shows up here, measured against 10× of your price.
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
