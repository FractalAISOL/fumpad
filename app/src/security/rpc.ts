/**
 * M-8 (security-review/REPORT.md): NEXT_PUBLIC_SOLANA_RPC is inlined into the client bundle, so
 * any API key in it is public. It must be a frontend-only key restricted to our origins (Helius:
 * Dashboard → the key → Access Control → Allowed Domains: fumpad.app, www.fumpad.app,
 * fumpad.vercel.app) and never the backend services' key. The build can't see the backend's
 * env, so this only catches what it can and warns; LAUNCH.md has the full rule.
 */
export interface RpcEnv {
  NODE_ENV?: string;
  NEXT_PUBLIC_SOLANA_RPC?: string;
  /** Backend variable names, in case they leak into the app's build env. */
  RPC_URL?: string;
  HELIUS_API_KEY?: string;
}

const keyOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.searchParams.get("api-key") ?? u.searchParams.get("apiKey") ?? (u.pathname.length > 20 ? u.pathname.replace(/^\/+/, "") : null);
  } catch {
    return null;
  }
};

/** Human-readable build warnings (empty when nothing looks wrong). */
export function rpcWarnings(env: RpcEnv): string[] {
  const out: string[] = [];
  const rpc = env.NEXT_PUBLIC_SOLANA_RPC?.trim();
  if (!rpc) {
    if (env.NODE_ENV === "production") out.push("NEXT_PUBLIC_SOLANA_RPC is unset: the app falls back to the public mainnet RPC (rate-limited, not for production).");
    return out;
  }
  const key = keyOf(rpc);
  if (key && (key === env.HELIUS_API_KEY?.trim() || key === keyOf(env.RPC_URL))) {
    out.push("NEXT_PUBLIC_SOLANA_RPC reuses the backend's RPC key. It is public in the browser bundle: use a separate, domain-restricted frontend key.");
  }
  if (key) {
    out.push("NEXT_PUBLIC_SOLANA_RPC carries an API key, which ships to every browser. Make sure it is a frontend-only key restricted to the app's domains (Helius → Access Control), not the backend's.");
  }
  return out;
}
