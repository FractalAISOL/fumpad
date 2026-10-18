/**
 * APP-6: the instant-trading spend window, shared by every tab of the browser origin (stored in localStorage by
 * `components/wallet/store.ts`). No imports (the header's wallet store loads it): unit-tested by `instantWindow.test.ts`.
 */
/** APP-6: how long one instant-trading session (its spend budget) lasts, from its first instant spend. */
export const INSTANT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface SpentRecord {
  lamports: bigint;
  /** When this window's first instant spend happened (ms). */
  since: number;
}

/**
 * The stored instant spend (`{"l":"<lamports>","t":<ms>}`), or null when there is none, it is malformed, or its window
 * is over. A start time in the future (clock moved back, or a tampered value) counts from now: never a reset.
 */
export function parseSpent(raw: string | null | undefined, now: number): SpentRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { l?: unknown; t?: unknown };
    if (typeof v.l !== "string" || !/^\d{1,20}$/.test(v.l) || typeof v.t !== "number" || !Number.isFinite(v.t)) return null;
    const since = Math.min(v.t, now);
    if (now - since >= INSTANT_WINDOW_MS) return null;
    return { lamports: BigInt(v.l), since };
  } catch {
    return null;
  }
}

/** The stored value after an instant spend of `add` lamports (a new window if the old one is over). */
export function addSpent(raw: string | null | undefined, add: bigint, now: number): string {
  const cur = parseSpent(raw, now);
  const l = (cur?.lamports ?? BigInt(0)) + (add > BigInt(0) ? add : BigInt(0));
  return JSON.stringify({ l: l.toString(), t: cur?.since ?? now });
}
