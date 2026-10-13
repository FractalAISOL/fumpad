/**
 * Security headers for every response (H-5, security-review/REPORT.md), applied from
 * `next.config.ts`. No Next or React imports: unit-tested by `headers.test.ts` with `npm test`.
 *
 * Why the CSP matters here: the Privy Trading wallet signs vetted FUMPAD transactions without
 * a popup from this page's JS context. Any script that gets into the page could ask it to
 * sign. The policy only lets scripts load from our own origin (plus Cloudflare Turnstile,
 * which Privy's login uses) and only lets the page talk to our API, our Solana RPC and Privy.
 *
 * `script-src` keeps `'unsafe-inline'` and no nonce, on purpose: the app uses Cache Components,
 * so every page is a prerendered static shell (PPR) whose inline scripts (the RSC payload
 * `self.__next_f.push(…)`, the theme script) are written at build time. A nonce must be fresh
 * per request, which forces every page to render dynamically and turns PPR off (Next's own CSP
 * guide: "PPR is incompatible with nonce-based CSP"). Hashes don't work either: the RSC payload
 * differs per page and per revalidation. What still holds without a nonce: no script from any
 * other origin, no `eval` in production, no plugins, no <base> hijack, no framing, and
 * `connect-src` limits where an injected script could send anything. React escapes all
 * rendered text and the review found no HTML injection, so `'unsafe-inline'` has no sink.
 *
 * `img-src` (V7-L6): only our origin, data:/blob: (wallet icons, the launch form's local preview), our API
 * (coin images come through its proxy, `GET /v1/img/<mint>`, see `design/image.ts`) and the WalletConnect
 * registry Privy already reads wallet listings from. No `https:` wildcard, so an injected script can't
 * smuggle data out through an image URL on a host of its choosing.
 */

export interface SecurityEnv {
  NODE_ENV?: string;
  NEXT_PUBLIC_FUMPAD_API?: string;
  NEXT_PUBLIC_FUMPAD_WS?: string;
  NEXT_PUBLIC_SOLANA_RPC?: string;
  /** `enforce` (production default), `report-only` (development default) or `off`. */
  CSP_MODE?: string;
  /** Optional endpoint for violation reports (`report-uri`). */
  CSP_REPORT_URI?: string;
}

/** Same default as `chain/cluster.ts`. */
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";

/**
 * Privy: auth + embedded wallet iframe (auth.privy.io), its websockets, its hosted Solana RPCs,
 * and the WalletConnect registry it reads wallet names/icons from for "Continue with a wallet"
 * (seen as a connect-src violation in the browser check; WalletConnect itself is disabled).
 */
export const PRIVY_CONNECT = ["https://auth.privy.io", "wss://*.privy.io", "https://*.rpc.privy.systems", "https://explorer-api.walletconnect.com"];
export const PRIVY_FRAMES = ["https://auth.privy.io"];
/** Wallet logos in Privy's wallet list come from the registry it already fetches listings from (connect-src). */
export const PRIVY_IMAGES = ["https://explorer-api.walletconnect.com"];
/** Cloudflare Turnstile, Privy's bot check on login (script + iframe). */
export const TURNSTILE = "https://challenges.cloudflare.com";

/** `https://host[:port]` of a URL, or null if it isn't one. */
function origin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!/^(https?|wss?):$/.test(u.protocol)) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/** An http(s) origin and its ws(s) twin (the API's live feed, the RPC's subscriptions). */
function withSocket(url: string | undefined): string[] {
  const o = origin(url);
  if (!o) return [];
  const ws = o.replace(/^http/, "ws");
  return o.startsWith("http") ? [o, ws] : [o];
}

export type CspMode = "enforce" | "report-only" | "off";

export function cspMode(env: SecurityEnv): CspMode {
  const m = env.CSP_MODE?.trim().toLowerCase();
  if (m === "enforce" || m === "report-only" || m === "off") return m;
  return env.NODE_ENV === "production" ? "enforce" : "report-only";
}

/** The Content-Security-Policy value for this build's API and RPC. */
export function contentSecurityPolicy(env: SecurityEnv): string {
  const dev = env.NODE_ENV !== "production";
  const api = withSocket(env.NEXT_PUBLIC_FUMPAD_API);
  const apiOrigin = origin(env.NEXT_PUBLIC_FUMPAD_API);
  const ws = origin(env.NEXT_PUBLIC_FUMPAD_WS);
  const rpc = withSocket(env.NEXT_PUBLIC_SOLANA_RPC || DEFAULT_RPC);
  const connect = uniq([
    "'self'",
    ...api,
    ...(ws ? [ws] : []),
    ...rpc,
    ...PRIVY_CONNECT,
    // next dev's HMR socket.
    ...(dev ? ["ws://localhost:*", "ws://127.0.0.1:*"] : []),
  ]);
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    // 'unsafe-eval' only in development (React's dev tooling reconstructs server stacks with eval).
    ["script-src", ["'self'", "'unsafe-inline'", TURNSTILE, ...(dev ? ["'unsafe-eval'"] : [])]],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    // next/font self-hosts the fonts; Privy's modal uses data: fonts/icons.
    ["font-src", ["'self'", "data:"]],
    // V7-L6: coin images only through our API's image proxy; wallet icons are data: URIs; blob: = launch preview.
    ["img-src", uniq(["'self'", "data:", "blob:", ...(apiOrigin && apiOrigin.startsWith("http") ? [apiOrigin] : []), ...PRIVY_IMAGES])],
    ["connect-src", connect],
    ["frame-src", [...PRIVY_FRAMES, TURNSTILE]],
    ["child-src", [...PRIVY_FRAMES, TURNSTILE]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["media-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  if (env.CSP_REPORT_URI && origin(env.CSP_REPORT_URI)) directives.push(["report-uri", [env.CSP_REPORT_URI]]);
  return directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
}

/** Everything but the CSP: same on every route. */
export const STATIC_SECURITY_HEADERS: { key: string; value: string }[] = [
  { key: "X-Frame-Options", value: "DENY" },
  // Two years; only honoured over HTTPS (Vercel), ignored on http://localhost.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Nothing FUMPAD uses; clipboard-write stays default (copy buttons), Privy needs none of these.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), midi=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

/** All security headers for `next.config.ts` → `headers()`. */
export function securityHeaders(env: SecurityEnv): { key: string; value: string }[] {
  const mode = cspMode(env);
  const csp = mode === "off" ? [] : [{ key: mode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", value: contentSecurityPolicy(env) }];
  return [...csp, ...STATIC_SECURITY_HEADERS];
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}
