/**
 * The disclaimer gate's acceptance record and the routes it skips. A plain module (no React, no "use client"):
 * the root layout inlines `DISCLAIMER_SCRIPT` before paint, the gate (`components/legal/DisclaimerGate.tsx`) reads
 * and writes through these helpers, and `disclaimer.test.ts` covers them. The text itself is in `./disclaimerCopy.ts`.
 *
 * Acceptance is per browser: localStorage `fumpad.disclaimer.v<VERSION>` = `{"v":<VERSION>,"at":<ms>}`.
 * Bump `DISCLAIMER_VERSION` when the text changes materially: the key changes, older records no longer count,
 * and every visitor is asked again. Storage that throws or is missing counts as "not accepted" (asked every visit).
 */

/** Bump to re-ask everyone (e.g. after the lawyer's edits land). */
export const DISCLAIMER_VERSION = 1;

export const disclaimerKey = (version: number = DISCLAIMER_VERSION) => `fumpad.disclaimer.v${version}`;

export interface Acceptance {
  v: number;
  /** When it was accepted (ms since epoch). */
  at: number;
}

/** The slice of `Storage` the gate uses (so tests can pass a fake, or one that throws). */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** A stored record → the acceptance, if it is well-formed and for `version`. Anything else is "not accepted". */
export function parseAcceptance(raw: string | null, version: number = DISCLAIMER_VERSION): Acceptance | null {
  if (!raw) return null;
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== "object") return null;
    const { v, at } = o as Record<string, unknown>;
    if (v !== version || typeof at !== "number" || !Number.isFinite(at) || at <= 0) return null;
    return { v, at };
  } catch {
    return null;
  }
}

/** The acceptance for `version` in `store`, or null (none, stale, malformed, or storage unavailable). */
export function readAcceptance(store: KeyValueStore | null | undefined, version: number = DISCLAIMER_VERSION): Acceptance | null {
  if (!store) return null;
  try {
    return parseAcceptance(store.getItem(disclaimerKey(version)), version);
  } catch {
    return null;
  }
}

/**
 * Records acceptance of `version` at `now` and drops records of earlier versions. Returns false when storage
 * refused the write (blocked site data, private mode, quota): the caller keeps it in memory for this page view.
 */
export function writeAcceptance(store: KeyValueStore | null | undefined, now: number, version: number = DISCLAIMER_VERSION): boolean {
  if (!store) return false;
  const record: Acceptance = { v: version, at: now };
  try {
    store.setItem(disclaimerKey(version), JSON.stringify(record));
  } catch {
    return false;
  }
  for (let old = 1; old < version; old++) {
    try {
      store.removeItem(disclaimerKey(old));
    } catch {}
  }
  return true;
}

/** The legal pages stay readable without accepting (the gate links to them). */
const LEGAL = new Set(["terms", "privacy", "risk"]);

/** By URL path: /terms /privacy /risk and the waiting room's /soon/terms /soon/privacy /soon/risk. */
export function isLegalPath(pathname: string): boolean {
  return LEGAL_PATH.test(pathname);
}
const LEGAL_PATH = /^\/(?:soon\/)?(?:terms|privacy|risk)\/?$/;

/** By route segments (`useSelectedLayoutSegments()` in the root layout): right under the prelaunch proxy's rewrites. */
export function isLegalRoute(segments: readonly string[]): boolean {
  if (segments.length === 1) return LEGAL.has(segments[0]);
  if (segments.length === 2 && segments[0] === "soon") return LEGAL.has(segments[1]);
  return false;
}

/** The attribute on <html> that hides the page until the gate is accepted (globals.css). */
export const PENDING_ATTR = "data-disclaimer";

/**
 * Inline, pre-paint (root layout <head>): marks <html> `data-disclaimer="pending"` unless this browser already
 * accepted the current version or the page is a legal page, so the page is hidden and inert from the first frame
 * until the gate (client-side, after hydration) takes over. Same rules as `readAcceptance` / `isLegalPath`.
 */
export const DISCLAIMER_SCRIPT = `(function(){try{if(${LEGAL_PATH.toString()}.test(location.pathname))return;var r=null;try{r=JSON.parse(localStorage.getItem(${JSON.stringify(
  disclaimerKey(),
)}))}catch(e){}if(r&&r.v===${DISCLAIMER_VERSION}&&typeof r.at==="number"&&r.at>0)return;document.documentElement.setAttribute("${PENDING_ATTR}","pending")}catch(e){}})()`;
