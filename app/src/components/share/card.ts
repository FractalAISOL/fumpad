import type { Ticket } from "@/data";
import * as f from "@/design/format";
import { colorDark, colorLight } from "@/design/tokens";

export type CardStyle = "flare" | "paper" | "night";
export const CARD_STYLES: CardStyle[] = ["flare", "paper", "night"];

/** Share-card palettes, derived from the tokens. Flare: orange stage; paper: light; night: dark. */
export const CARD_COLORS: Record<CardStyle, { bg: string; fg: string; sub: string; line: string; accent: string }> = {
  flare: { bg: colorLight.flare, fg: colorLight["on-flare"], sub: "rgba(0,0,0,.62)", line: "rgba(0,0,0,.22)", accent: colorLight["on-flare"] },
  paper: { bg: colorLight.surface, fg: colorLight.ink, sub: colorLight["ink-3"], line: colorLight.rule, accent: colorLight.flare },
  night: { bg: colorDark.canvas, fg: colorDark.ink, sub: colorDark["ink-3"], line: colorDark.rule, accent: colorDark.flare },
};

export function parseStyle(v: string | null | undefined): CardStyle {
  return v === "paper" || v === "night" ? v : "flare";
}

/** Headline + sentence for the card, by ticket state. Same voice as the product. */
export function cardCopy(t: Ticket) {
  const sold = `I sold ${f.int(t.originalTokens)} $${t.symbol} at ${f.priceText(t.sellPrice)} SOL.`;
  if (t.state === "claimed")
    return { head: "Sold too early. Officially.", body: `${sold} It held ${f.multiple(t.multiple)}. FUMPAD paid me back ${f.int(t.claimAmount)} ${t.symbol}.` };
  if (t.state === "claimable" || t.state === "queued")
    return { head: "Sold too early. Officially.", body: `${sold} It's holding ${f.multiple(t.multiple)}. FUMPAD owes me ${f.int(t.claimAmount)} ${t.symbol}.` };
  if (t.state === "expired")
    return { head: "Sold at the right time.", body: `${sold} It peaked at ${f.multiple(t.peakMultiple)}. Sometimes selling was right.` };
  return {
    head: "Sold. Watching.",
    body: `${sold} It's at ${f.multiple(t.multiple)}. If it holds 10×, FUMPAD pays me back ${f.int(t.claimAmount)} ${t.symbol}.`,
  };
}

export function postText(t: Ticket, url: string) {
  if (t.state === "claimed")
    return `Sold $${t.symbol} too early. It ran ${f.multiple(t.multiple)} and @fumpad paid me back ${f.int(t.claimAmount)} ${t.symbol} from the coin's own pool. ${url}`;
  if (t.state === "claimable" || t.state === "queued")
    return `Sold $${t.symbol} too early. It's holding ${f.multiple(t.multiple)}, so @fumpad owes me ${f.int(t.claimAmount)} ${t.symbol}. ${url}`;
  return `Sold $${t.symbol}. It's at ${f.multiple(t.multiple)} of my price. At 10×, @fumpad pays me back. ${url}`;
}
