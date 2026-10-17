/**
 * Pre-launch gate. On the public hosts (`PRELAUNCH_HOSTS`, default fumpad.app and www.fumpad.app) the site is, by
 * `NEXT_PUBLIC_PRELAUNCH`:
 *   unset / `checker` / `live` / anything else → the launch-window page (`/live`) at `/`. The page itself decides what
 *                           it shows: "The first coin launches soon." until `NEXT_PUBLIC_CHECKER_MINT` is set, then
 *                           the coin, live, and the Fumble Checker (`components/checker/launchState.ts`); the gate
 *                           never reads the mint. Every other app route redirects to `/`; `/terms` `/risk` `/privacy`
 *                           are served in the pre-launch frame;
 *   `off`                 → the full app.
 * The old waiting room (`/soon`) is not served on these hosts any more (it stays viewable at `/soon` on other hosts;
 * its copies of the legal pages still frame `/terms` `/risk` `/privacy` here). Any other host (fumpad.vercel.app,
 * previews, localhost) serves the full app, with `/live` viewable at its internal path. Pure, so it's unit-tested
 * without a server; `src/proxy.ts` applies the decision. Release steps: `app/LAUNCH.md`.
 */

export const DEFAULT_PRELAUNCH_HOSTS = "fumpad.app,www.fumpad.app";

/** Where the old waiting room lives in the route tree. Not served on a gated host; its legal pages are. */
export const WAITING_ROOM = "/soon";

/** Where the launch-window page lives in the route tree. Its public URL on a gated host is `/`. */
export const CHECKER = "/live";

/** Legal pages the launch page links to; served in the pre-launch frame (`app/soon/<page>`: no app shell). */
export const LEGAL = ["terms", "risk", "privacy"] as const;

export type GateDecision =
  | { action: "next" }
  | { action: "rewrite"; pathname: string }
  /** `keepQuery`: carry the query string (the checker's shareable `?wallet=` links). */
  | { action: "redirect"; pathname: string; keepQuery?: true };

export interface GateEnv {
  PRELAUNCH_HOSTS?: string;
  NEXT_PUBLIC_PRELAUNCH?: string;
}

/** `launch`: the gated hosts show only the launch-window page (coming soon, or live). `off`: the full app. */
export type GateMode = "launch" | "off";

/** The mode the gated hosts are in: `off` opens the app; any other value, or none, is the launch-window page. */
export function gateMode(env: GateEnv): GateMode {
  return (env.NEXT_PUBLIC_PRELAUNCH ?? "").trim().toLowerCase() === "off" ? "off" : "launch";
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
  if (gateMode(env) === "off") return { action: "next" };
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!h || !gatedHosts(env).has(h)) return { action: "next" };

  // Assets, share cards and API/health routes pass through untouched.
  if (pathname.startsWith("/_next/") || pathname.startsWith("/og/") || pathname === "/api" || pathname.startsWith("/api/") || STATIC_FILE.test(pathname)) {
    return { action: "next" };
  }

  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { action: "rewrite", pathname: CHECKER };
  // The page's internal path has one public URL (`/`), and keeps its shareable `?wallet=`.
  if (path === CHECKER) return { action: "redirect", pathname: "/", keepQuery: true };
  const legal = LEGAL.find((d) => path === `/${d}`);
  if (legal) return { action: "rewrite", pathname: `${WAITING_ROOM}/${legal}` };
  // The old waiting room isn't served here; its legal pages have one public URL each.
  if (path === WAITING_ROOM) return { action: "redirect", pathname: "/" };
  const inner = LEGAL.find((d) => path === `${WAITING_ROOM}/${d}`);
  if (inner) return { action: "redirect", pathname: `/${inner}` };
  // Everything else is the app, which isn't open yet.
  return { action: "redirect", pathname: "/" };
}
