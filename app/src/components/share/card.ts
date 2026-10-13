import type { CoinSummary, ProtocolParams, Ticket } from "@/data";
import * as f from "@/design/format";
import { colorDark, colorLight } from "@/design/tokens";

export type CardStyle = "flare" | "paper" | "night";
export const CARD_STYLES: CardStyle[] = ["flare", "paper", "night"];

/**
 * What the card says, by ticket state. Three of them are money (orange allowed); the rest
 * are ink, because orange only ever means money.
 *  - fumbled:   tracking, below 10× (also while verifying / in the challenge window, graduated coins)
 *  - curve:     waiting for graduation (also while verifying / in the challenge window)
 *  - claimable: 10× held, claim open
 *  - queued:    10× held, waiting in the payout queue
 *  - paid:      claimed (or paid into escrow)
 *  - gone:      expired or voided
 */
export type CardKind = "fumbled" | "curve" | "claimable" | "queued" | "paid" | "gone";

export function cardKind(t: Ticket): CardKind {
  switch (t.state) {
    case "verifying":
    case "challenge":
      return t.coinStatus === "graduated" ? "fumbled" : "curve";
    case "tracking":
      return "fumbled";
    case "awaiting-graduation":
      return "curve";
    case "claimable":
      return "claimable";
    case "queued":
      return "queued";
    case "claimed":
      return "paid";
    default:
      return "gone";
  }
}

export const isMoney = (k: CardKind) => k === "claimable" || k === "queued" || k === "paid";

export interface CardPalette {
  bg: string;
  fg: string;
  sub: string;
  line: string;
  /** The needle, fill and big figure. Orange only on money cards (on the flare stage it's ink on orange). */
  accent: string;
  /** The 10× post on the ruler and the mark's dot. */
  post: string;
}

/**
 * Share-card palettes, derived from the tokens. The first style is the stage: orange when the
 * ticket is money, the instrument-grey canvas with ink until then (the same card, waiting to
 * turn orange). Paper is light, night is dark; both use orange only for money.
 */
export function cardPalette(style: CardStyle, money: boolean): CardPalette {
  if (style === "flare")
    return money
      ? { bg: colorLight.flare, fg: colorLight["on-flare"], sub: "rgba(0,0,0,.62)", line: "rgba(0,0,0,.22)", accent: colorLight["on-flare"], post: colorLight["on-flare"] }
      : { bg: colorLight.canvas, fg: colorLight.ink, sub: colorLight["ink-2"], line: colorLight["rule-2"], accent: colorLight.ink, post: colorLight.ink };
  const c = style === "paper" ? { bg: colorLight.surface, fg: colorLight.ink, sub: colorLight["ink-3"], line: colorLight.rule, flare: colorLight.flare } : { bg: colorDark.canvas, fg: colorDark.ink, sub: colorDark["ink-3"], line: colorDark.rule, flare: colorDark.flare };
  return { bg: c.bg, fg: c.fg, sub: c.sub, line: c.line, accent: money ? c.flare : c.fg, post: money ? c.flare : c.fg };
}

/** The name of the first style for this ticket: orange is only for money. */
export const loudLabel = (money: boolean) => (money ? "Flare" : "Canvas");

/** Image URL for one style. `v` changes with the ticket's state so X doesn't reuse a stale card. */
export function ogSrc(t: Pick<Ticket, "id" | "state">, style: CardStyle = "flare") {
  return `/og/${t.id}?style=${style}&v=${t.state}`;
}

export function parseStyle(v: string | null | undefined): CardStyle {
  return v === "paper" || v === "night" ? v : "flare";
}

/** "<0.1×" instead of "0.0×" for a coin that went nowhere (same rule as everywhere: `f.multiple`). */
export function multipleText(x: number): string {
  return f.multiple(x);
}

export interface CardCopy {
  kind: CardKind;
  money: boolean;
  /** The headline, set wide and heavy. */
  head: string;
  /** The line under it: the state in a breath. */
  kicker: string;
  /** One sentence of facts. Subject-less, so it reads right for the owner and for anyone else. */
  body: string;
  /** The big number and what it measures. */
  figure: number;
  figureNote: string;
  /** Muted figure (closed tickets). */
  muted: boolean;
  /** Bottom-right line. */
  foot: string;
}

/** Curve progress for "on the curve" cards, when the coin is known. */
export function curveProgress(coin: Pick<CoinSummary, "curveSol" | "graduationSol"> | null | undefined): number | undefined {
  if (!coin?.graduationSol) return undefined;
  return Math.max(0, Math.min(1, coin.curveSol / coin.graduationSol));
}

/** Headline, sentence and figure for the card, by ticket state. Same voice as the product. */
export function cardCopy(t: Ticket, params?: Pick<ProtocolParams, "oracleWindowSecs" | "claimWindowSecs" | "rebuyWindowSecs">): CardCopy {
  const kind = cardKind(t);
  const money = isMoney(kind);
  const median = params ? `${f.durationShort(params.oracleWindowSecs)} median` : "median";
  const venue = t.source === "router" ? "FUMPAD" : f.appName(t.app);
  const sold = `Sold ${f.int(t.originalTokens)} $${t.symbol}${venue ? ` on ${venue}` : ""} at ${f.priceText(t.sellPrice)} SOL.`;
  // v0.7: a fresh ticket is first verified (keeper attestation), then sits in the challenge window.
  const fresh = t.state === "verifying" ? "Sell landed. Being verified." : t.state === "challenge" ? (t.multiple >= 10 ? "Past 10×. Claims open after the challenge window." : "Verified. In the challenge window.") : null;
  const claim = `${f.int(t.claimAmount)} $${t.symbol}`;
  const x = multipleText(t.multiple);
  const pool = `from the $${t.symbol} pool`;
  const base = { kind, money, muted: false };
  switch (kind) {
    case "fumbled": {
      const climbing = t.multiple >= 1 && t.multiple >= t.peakMultiple * 0.97;
      return {
        ...base,
        head: "FUMBLED.",
        kicker:
          fresh ?? (climbing ? `Now ${x} of the sell price. And climbing.` : t.multiple < 1 ? `Now ${x} of the sell price. Waiting, with dignity.` : `Now ${x} of the sell price. Waiting.`),
        body: `${sold} If it holds 10×, FUMPAD pays back ${claim}.`,
        figure: t.multiple,
        figureNote: `of 10×, ${median} now`,
        foot: `Claim: 10% of tokens sold, ${pool}`,
      };
    }
    case "curve":
      return {
        ...base,
        head: "FUMBLED on the curve.",
        kicker: fresh ?? (t.multiple >= 10 ? `Already past 10×. Claiming opens at graduation.` : `Now ${x} of the sell price. Still on the curve.`),
        body: `${sold} At 10× after graduation, FUMPAD pays back ${claim}.`,
        figure: t.multiple,
        figureNote: "of 10×, on the curve now",
        foot: `Claim: 10% of tokens sold, ${pool}`,
      };
    case "claimable":
      return {
        ...base,
        head: "10× CROSSED.",
        kicker: "Claim unlocked.",
        body: `${sold} It's holding ${x}. FUMPAD owes ${claim}.`,
        figure: t.multiple,
        figureNote: `${median} now`,
        foot: `Claim: ${claim}, ${pool}`,
      };
    case "queued": {
      const at = t.crossedMultiple ?? t.peakMultiple;
      return {
        ...base,
        head: "10× CROSSED.",
        kicker: t.queuePosition ? `In the payout queue (#${t.queuePosition}).` : "In the payout queue.",
        body: `${sold} It crossed 10×. FUMPAD pays ${claim} as the pool fills, in order.`,
        figure: at,
        figureNote: t.crossedMultiple ? `at the crossing${t.crossedAt ? `, ${f.date(t.crossedAt)}` : ""}` : "peak",
        foot: `Owed ${claim}, ${pool}${t.queuePosition ? `, #${t.queuePosition} in line` : ""}`,
      };
    }
    case "paid": {
      const held = t.claimMultiple ?? t.multiple;
      return {
        ...base,
        head: "PAID BACK.",
        kicker: t.escrowed ? "Paid into escrow, ready to withdraw." : "Sold too early. Officially.",
        body: `${sold} It held ${multipleText(held)}. FUMPAD paid back ${claim}.`,
        figure: held,
        figureNote: t.claimedAt ? `${median} at claim, ${f.date(t.claimedAt)}` : `${median} at claim`,
        foot: t.claimTx ? `Paid ${pool}, tx ${f.shortAddr(t.claimTx)}` : `Paid ${pool}`,
      };
    }
    case "gone":
      if (t.state === "voided" && t.voidReason === "guardian")
        return {
          ...base,
          muted: true,
          head: "Voided.",
          kicker: "Caught in the challenge window.",
          body: `${sold} The attestation didn't match the chain, so the ticket never counted.`,
          figure: t.peakMultiple,
          figureNote: "peak, ticket voided",
          foot: "No claim",
        };
      return t.state === "voided"
        ? {
            ...base,
            muted: true,
            head: "Fumbled. Fully.",
            kicker: "Bought back in. The ticket went to zero.",
            body: `${sold} Rebuys within ${params ? f.duration(params.rebuyWindowSecs) : "the window"} debited it to nothing. It happens.`,
            figure: t.peakMultiple,
            figureNote: "peak, ticket voided",
            foot: "No claim",
          }
        : {
            ...base,
            muted: true,
            head: "Fumbled. Fully.",
            kicker: `It never held 10×. ${params ? `${f.duration(params.claimWindowSecs)} ran out.` : "The window ran out."}`,
            body: `${sold} It peaked at ${multipleText(t.peakMultiple)}. Sometimes selling was right.`,
            figure: t.peakMultiple,
            figureNote: t.expiresAt ? `peak, expired ${f.date(t.expiresAt)}` : "peak, expired",
            foot: "No claim",
          };
  }
}

/** The post for X. First person for the owner, third person for anyone else sharing it. */
export function postText(t: Ticket, own: boolean) {
  const who = own ? "I" : f.shortAddr(t.owner);
  const my = own ? "my" : "their";
  const me = own ? "me" : "them";
  const x = multipleText(t.multiple);
  switch (cardKind(t)) {
    case "fumbled":
      return `${who} sold $${t.symbol}. It's at ${x} of ${my} price. At 10×, @fumpad pays ${me} back.`;
    case "curve":
      return `${who} fumbled $${t.symbol} on the curve. It's at ${x} of ${my} price; at 10× after graduation, @fumpad pays ${me} back.`;
    case "claimable":
      return `${who} sold $${t.symbol} too early. It crossed 10×, so @fumpad owes ${me} ${f.int(t.claimAmount)} ${t.symbol}. Claim unlocked.`;
    case "queued":
      return `${who} sold $${t.symbol} too early. It crossed 10×; ${own ? "I'm" : "they're"} ${t.queuePosition ? `#${t.queuePosition} ` : ""}in the @fumpad payout queue for ${f.int(t.claimAmount)} ${t.symbol}.`;
    case "paid":
      return `${who} sold $${t.symbol} too early. It ran ${multipleText(t.claimMultiple ?? t.multiple)} and @fumpad paid ${me} back ${f.int(t.claimAmount)} ${t.symbol} from the coin's own pool.`;
    case "gone":
      return t.state === "voided"
        ? t.voidReason === "guardian"
          ? t.reopened
            ? `${who} sold $${t.symbol}; the ticket was reopened for correction in its challenge window.`
            : `${who} sold $${t.symbol}; the ticket was voided in its challenge window.`
          : `${who} sold $${t.symbol}, bought back in, and the ticket went to zero. Fumbled. Fully.`
        : `${who} sold $${t.symbol}. It peaked at ${multipleText(t.peakMultiple)} and never held 10×. Fumbled. Fully. Sometimes selling was right.`;
  }
}
