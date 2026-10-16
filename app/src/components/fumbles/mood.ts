/**
 * Fumi's reaction on My fumbles (marketing/STYLE-ANIME.md), without React (`mood.test.ts`). One Fumi per screen, so
 * the page shows a single reaction to the wallet's most notable ticket stage, beside the page head and never next to
 * amounts, claim buttons or progress numbers. Quips: at most 8 words, comic about the fumble, no promises.
 */
import type { Ticket } from "../../data/types";

/** Poses this page uses (a subset of the anime kit's `FumiPose`). */
export type FumblesPose = "cheering" | "thinking" | "ticket" | "crying";

export interface FumblesMood {
  pose: FumblesPose;
  quip: string;
}

/**
 * The strongest stage wins: claimable or queued → cheering; a sell being verified → thinking; a fresh ticket in its
 * challenge window → ticket; paid → cheering; open (tracking, waiting to graduate) → ticket; only closed tickets →
 * crying. No tickets → null (the page shows its Fumi empty state instead).
 */
export function fumblesMood(tickets: readonly Pick<Ticket, "state">[] | null | undefined): FumblesMood | null {
  if (!tickets?.length) return null;
  const has = (...st: Ticket["state"][]) => tickets.some((t) => st.includes(t.state));
  if (has("claimable", "queued")) return { pose: "cheering", quip: "Claim time?" };
  if (has("verifying")) return { pose: "thinking", quip: "Keepers are checking your sell…" };
  if (has("challenge")) return { pose: "ticket", quip: "Fresh fumble, fresh ticket!" };
  if (has("claimed")) return { pose: "cheering", quip: "Sold too early. Officially." };
  if (has("tracking", "awaiting-graduation")) return { pose: "ticket", quip: "Sold too early? Same." };
  return { pose: "crying", quip: "Fumbled. Fully. It happens." };
}
