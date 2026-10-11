import type { ReactNode } from "react";
import type { Ticket } from "@/data/types";
import { cx } from "../cx";
import * as f from "../format";
import { Gauge } from "./Gauge";
import { CoinTile } from "./Identity";
import { Multiple, Price, Tokens } from "./Num";
import { Badge } from "./Surface";
import s from "./TicketCard.module.css";

export const TICKET_LABEL: Record<Ticket["state"], string> = {
  claimable: "Claimable",
  queued: "Queued",
  tracking: "Tracking",
  "awaiting-graduation": "Waiting for graduation",
  claimed: "Paid",
  expired: "Expired",
  voided: "Voided",
};

export function TicketBadge({ ticket }: { ticket: Ticket }) {
  const st = ticket.state;
  if (st === "claimable") return <Badge tone="flare">Claimable</Badge>;
  if (st === "queued")
    return (
      <Badge tone="flare-line" dot>
        Queue #{ticket.queuePosition}
      </Badge>
    );
  if (st === "claimed") return <Badge tone="flare-line">Paid</Badge>;
  if (st === "expired" || st === "voided") return <Badge tone="muted">{TICKET_LABEL[st]}</Badge>;
  return <Badge>{TICKET_LABEL[st]}</Badge>;
}

/**
 * One fumble ticket: coin, the 10× gauge, the facts, and the next action.
 * `action` is the right-hand slot (Claim button, share link…); `note` explains any
 * state that needs a sentence (queue, rebuy, graduation, expiry).
 */
export function TicketCard({
  ticket: t,
  now,
  action,
  note,
  as: As = "article",
}: {
  ticket: Ticket;
  now: number;
  action?: ReactNode;
  note?: ReactNode;
  as?: "article" | "div" | "li";
}) {
  const closed = t.state === "expired" || t.state === "voided";
  const days = t.expiresAt ? f.daysLeft(t.expiresAt, now) : undefined;
  const sub =
    t.state === "queued"
      ? "Clock paused while queued"
      : t.state === "claimed"
        ? t.claimedAt
          ? `Paid ${f.date(t.claimedAt)}`
          : "Paid"
        : closed
          ? t.expiresAt
            ? `Closed ${f.date(t.expiresAt)}`
            : "Closed"
          : days !== undefined
            ? `${days} ${days === 1 ? "day" : "days"} left`
            : undefined;
  return (
    <As className={cx(s.cq, t.state === "claimable" && s.ready)} aria-label={`$${t.symbol} ticket, ${TICKET_LABEL[t.state].toLowerCase()}`}>
      <div className={cx(s.tk, s[t.state])}>
        <div className={s.id}>
          <CoinTile symbol={t.symbol} variant={t.tile} />
          <div className={s.idText}>
            <h3 className={cx("ticker", s.sym)}>${t.symbol}</h3>
            <div className={s.idSub}>
              {t.coinName}, sold {f.date(t.sellTs)}
            </div>
          </div>
        </div>

        <div className={s.g}>
          <Gauge value={t.multiple} dead={closed} label={`$${t.symbol} ticket progress to 10×`} />
          <Multiple x={t.multiple} size="lg" className={s.read} />
        </div>

        <dl className={s.facts}>
          <div>
            <dt>Sold</dt>
            <dd>
              <Tokens value={t.originalTokens} />
            </dd>
          </div>
          <div>
            <dt>At, SOL</dt>
            <dd>
              <Price value={t.sellPrice} />
            </dd>
          </div>
          <div>
            <dt>Claim, 10%</dt>
            <dd>
              <Tokens value={t.claimAmount} />
            </dd>
            <dd className={s.factSub}>
              {t.state === "claimed"
                ? "paid"
                : closed
                  ? "–"
                  : t.multiple >= 10
                    ? `≈ ${f.sol(t.claimValueSol)} SOL`
                    : `≈ ${f.sol(t.claimAmount * t.sellPrice * 10)} SOL at 10×`}
            </dd>
          </div>
        </dl>

        <div className={s.act}>
          <TicketBadge ticket={t} />
          {action}
          {sub && <div className={s.days}>{sub}</div>}
        </div>

        {note && <div className={s.note}>{note}</div>}
      </div>
    </As>
  );
}
