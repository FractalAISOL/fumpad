/**
 * Canonical serialization: bigints as decimal strings, object keys sorted, no whitespace. Two runs (or
 * two keepers) over the same history must produce byte-identical canonical output.
 */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(normalize(v));
}

function normalize(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (v === undefined) return null;
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = normalize(x);
    }
    return out;
  }
  return v;
}

/** sha256 hex of the canonical JSON (Web Crypto; works in node ≥ 20 and browsers). */
export async function canonicalHash(v: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(v));
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
