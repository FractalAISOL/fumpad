/**
 * Coin identity for links and display (H-3, security-review/REPORT.md). Symbols aren't unique:
 * anyone can launch another `$PIGN`, or a look-alike with Cyrillic letters. So every link
 * points at the mint (`/coin/<mint>`), and a bare symbol (`/coin/PIGN`, `/c/PIGN`) is a lookup
 * that shows a chooser when more than one coin answers to it. No React, no `@/` imports:
 * unit-tested by `ident.test.ts`.
 */

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A Solana address (base58, 32–44 chars): mints, wallets, ticket PDAs. */
export function isAddress(s: string): boolean {
  return BASE58_ADDRESS.test(s);
}

/** A mint-shaped id. Symbols are ≤ 10 bytes, so they never look like one. */
export const isMintAddress = isAddress;

/** The coin page for a coin. Always by mint; `symbol` only when the mint is unknown (legacy rows). */
export function coinHref(c: { mint?: string | null; symbol?: string | null }): string {
  if (c.mint && isMintAddress(c.mint)) return `/coin/${c.mint}`;
  return `/coin/${encodeURIComponent((c.symbol ?? "").replace(/^\$/, ""))}`;
}

/** Symbol comparison the API uses (`upper(symbol)`), without a leading `$`. */
export function normalizeSymbol(s: string): string {
  return s.trim().replace(/^\$/, "").trim().toUpperCase();
}

/** Case-insensitive symbol match, like the API's lookup. */
export function sameSymbol(a: string, b: string): boolean {
  return normalizeSymbol(a) === normalizeSymbol(b);
}

/**
 * Characters outside printable ASCII in a symbol or name: Cyrillic `А`, Greek `Ο`, full-width
 * letters, zero-width joiners… A `$PIGN` spelled with any of them looks identical to the real
 * one, so the UI flags it and shows the mint suffix.
 */
export function hasLookalikeChars(s: string): boolean {
  return /[^\x20-\x7e]/.test(s);
}

/** The last `n` characters of the mint: the part people compare (`…XXXXfmbL`). */
export function mintTail(mint: string, n = 8): string {
  return mint.length > n ? mint.slice(-n) : mint;
}

/** Newest first, then by mint so the order is stable. */
export function newestFirst<T extends { createdAt: number; mint: string }>(xs: T[]): T[] {
  return [...xs].sort((a, b) => b.createdAt - a.createdAt || (a.mint < b.mint ? -1 : 1));
}

/** Merge lookup results from several sources (dedupe by mint), newest first. */
export function mergeCoins<T extends { createdAt: number; mint: string; symbol: string }>(symbol: string, ...lists: (T | null | undefined | T[])[]): T[] {
  const by = new Map<string, T>();
  for (const l of lists) for (const c of Array.isArray(l) ? l : l ? [l] : []) if (sameSymbol(c.symbol, symbol) && !by.has(c.mint)) by.set(c.mint, c);
  return newestFirst([...by.values()]);
}
