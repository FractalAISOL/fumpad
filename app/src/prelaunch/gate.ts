/**
 * Pre-launch gate. On the public hosts (`PRELAUNCH_HOSTS`, default fumpad.app and www.fumpad.app) the site is, by
 * `NEXT_PUBLIC_PRELAUNCH`:
 *   unset / anything else → the waiting room (`/soon`) on every page;
 *   `checker`             → the launch-window one-pager (`/live`: the first coin, live, and the Fumble Checker) at `/`,
 *                           every other app route still gated; needs `NEXT_PUBLIC_CHECKER_MINT` (a base58 mint),
 *                           else it stays the waiting room;
 *   `off`                 → the full app.
 * Any other host (fumpad.vercel.app, previews, localhost) serves the full app, with both pages viewable at their
 * internal paths. Pure, so it's unit-tested without a server; `src/proxy.ts` applies the decision. Release steps:
 * `app/LAUNCH.md`.
 */

export const DEFAULT_PRELAUNCH_HOSTS = "fumpad.app,www.fumpad.app";

/** Where the waiting room lives in the route tree. Its public URL on a gated host is `/`. */
export const WAITING_ROOM = "/soon";

/** Where the launch-window checker lives in the route tree. Its public URL on a gated host is `/` (checker mode). */
export const CHECKER = "/live";

/** Legal pages the waiting room links to; served inside the waiting room's own frame. */
export const LEGAL = ["terms", "risk", "privacy"] as const;

export type GateDecision =
  | { action: "next" }
  | { action: "rewrite"; pathname: string }
  /** `keepQuery`: carry the query string (the checker's shareable `?wallet=` links). */
  | { action: "redirect"; pathname: string; keepQuery?: true };

export interface GateEnv {
  PRELAUNCH_HOSTS?: string;
  NEXT_PUBLIC_PRELAUNCH?: string;
  NEXT_PUBLIC_CHECKER_MINT?: string;
}

export type GateMode = "room" | "checker" | "off";

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** The mode the gated hosts are in. `checker` without a valid mint falls back to the waiting room. */
export function gateMode(env: GateEnv): GateMode {
  const v = (env.NEXT_PUBLIC_PRELAUNCH ?? "").trim().toLowerCase();
  if (v === "off") return "off";
  if (v === "checker") return MINT.test((env.NEXT_PUBLIC_CHECKER_MINT ?? "").trim()) ? "checker" : "room";
  return "room";
}

/** Comma list → lowercased host names (ports stripped). An empty string gates nothing. */
export function gatedHosts(env: GateEnv): Set<string> {
  const raw = env.PRELAUNCH_HOSTS ?? DEFAULT_PRELAUNCH_HOSTS;
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase().replace(/:\d+$/, ""))
      .filter(Boolean),
  );
}

export function prelaunchOn(env: GateEnv): boolean {
  return gateMode(env) !== "off";
}

/** Files that may load on a gated host: icons, OG images, robots, manifest, fonts, scripts, the self-hosted video. */
const STATIC_FILE = /\.(?:ico|png|jpe?g|gif|webp|avif|svg|txt|xml|webmanifest|woff2?|ttf|js|css|map|mp4|webm)$/i;

export function decide(host: string | null | undefined, pathname: string, env: GateEnv): GateDecision {
  const mode = gateMode(env);
  if (mode === "off") return { action: "next" };
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!h || !gatedHosts(env).has(h)) return { action: "next" };

  // Assets, share cards and API/health routes pass through untouched.
  if (pathname.startsWith("/_next/") || pathname.startsWith("/og/") || pathname === "/api" || pathname.startsWith("/api/") || STATIC_FILE.test(pathname)) {
    return { action: "next" };
  }

  const path = pathname.replace(/\/+$/, "") || "/";
  const home = mode === "checker" ? CHECKER : WAITING_ROOM;
  if (path === "/") return { action: "rewrite", pathname: home };
  // The checker's internal path has one public URL (`/`), and keeps its shareable `?wallet=`.
  if (mode === "checker" && path === CHECKER) return { action: "redirect", pathname: "/", keepQuery: true };
  const legal = LEGAL.find((d) => path === `/${d}`);
  if (legal) return { action: "rewrite", pathname: `${WAITING_ROOM}/${legal}` };
  // The internal route itself, and its legal pages, have one public URL each.
  if (path === WAITING_ROOM) return { action: "redirect", pathname: "/" };
  const inner = LEGAL.find((d) => path === `${WAITING_ROOM}/${d}`);
  if (inner) return { action: "redirect", pathname: `/${inner}` };
  // Everything else is the app, which isn't open yet.
  return { action: "redirect", pathname: "/" };
}
