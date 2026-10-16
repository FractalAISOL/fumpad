/**
 * Fumi's line on a wallet profile (marketing/STYLE-ANIME.md), without React (`mood.test.ts`). The profile shows one
 * Fumi, a bust in its header; her line also covers the wallet's empty states (nothing traded, no fumbles yet), so the
 * portfolio's own empty states stay plain and the screen never has two of her. Quips: at most 8 words, comic about the
 * fumble, never about money, no promises.
 */
import type { Profile, Ticket } from "../../../data/types";

export type ProfilePose = "thinking" | "waving" | "cheering" | "ticket";

export function profileMood(
  p: Pick<Profile, "ticketsFiled" | "crossed10x">,
  d: { tickets: readonly Pick<Ticket, "state">[]; positions: readonly unknown[]; closed: readonly unknown[]; created: readonly unknown[] },
): { pose: ProfilePose; quip: string } {
  const traded = d.positions.length + d.closed.length + d.created.length + d.tickets.length > 0;
  if (!traded && !p.ticketsFiled) return { pose: "thinking", quip: "Quiet wallet. Suspiciously quiet." };
  if (!d.tickets.length && !p.ticketsFiled) return { pose: "waving", quip: "No fumbles yet. Clean hands!" };
  if (d.tickets.some((t) => t.state === "claimable" || t.state === "queued")) return { pose: "cheering", quip: "Claim time?" };
  if (p.crossed10x > 0) return { pose: "cheering", quip: "Sold too early. Officially." };
  return { pose: "ticket", quip: "Certified fumbler. Tickets on file." };
}
