/** Deterministic randomness for the mock. Same seed → same world, on server and client. */

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** mulberry32 */
export function rng(seed: number | string): Rng {
  let a = (typeof seed === "string" ? hash(seed) : seed) >>> 0 || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller. */
export function gauss(r: Rng): number {
  const u = Math.max(1e-12, r());
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function pick<T>(r: Rng, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

export function between(r: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * r();
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** A plausible base58 public key (44 chars) derived from a seed. */
export function address(seed: string, suffix = ""): string {
  const r = rng("addr:" + seed);
  let s = "";
  const n = 44 - suffix.length;
  for (let i = 0; i < n; i++) s += B58[Math.floor(r() * 58)];
  return s + suffix;
}
/** Mints on FUMPAD are ground to end in "fum" (vanity, like pump's "pump"). */
export function mintAddress(symbol: string): string {
  return address("mint:" + symbol, "fum");
}
/** 88-char base58 signature. */
export function signature(seed: string): string {
  const r = rng("sig:" + seed);
  let s = "";
  for (let i = 0; i < 88; i++) s += B58[Math.floor(r() * 58)];
  return s;
}
