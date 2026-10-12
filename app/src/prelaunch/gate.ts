/**
 * Pre-launch gate. On the public hosts (`PRELAUNCH_HOSTS`, default fumpad.app and
 * www.fumpad.app) every page is the waiting room until `NEXT_PUBLIC_PRELAUNCH=off`; any other
 * host (fumpad.vercel.app, previews, localhost) serves the full app. Pure, so it's unit-tested
 * without a server; `src/proxy.ts` applies the decision. Release steps: `app/LAUNCH.md`.
 */

export const DEFAULT_PRELAUNCH_HOSTS = "fumpad.app,www.fumpad.app";

/** Where the waiting room lives in the route tree. Its public URL on a gated host is `/`. */
export const WAITING_ROOM = "/soon";

/** Legal pages the waiting room links to; served inside the waiting room's own frame. */
export const LEGAL = ["terms", "risk", "privacy"] as const;

export type GateDecision =
  | { action: "next" }
  | { action: "rewrite"; pathname: string }
  | { action: "redirect"; pathname: string };

export interface GateEnv {
  PRELAUNCH_HOSTS?: string;
  NEXT_PUBLIC_PRELAUNCH?: string;
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
  return (env.NEXT_PUBLIC_PRELAUNCH ?? "").trim().toLowerCase() !== "off";
}

/** Files that may load on a gated host: icons, OG images, robots, manifest, fonts, scripts. */
const STATIC_FILE = /\.(?:ico|png|jpe?g|gif|webp|avif|svg|txt|xml|webmanifest|woff2?|ttf|js|css|map)$/i;

export function decide(host: string | null | undefined, pathname: string, env: GateEnv): GateDecision {
  if (!prelaunchOn(env)) return { action: "next" };
  const h = (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
  if (!h || !gatedHosts(env).has(h)) return { action: "next" };

  // Assets, share cards and API/health routes pass through untouched.
  if (pathname.startsWith("/_next/") || pathname.startsWith("/og/") || pathname === "/api" || pathname.startsWith("/api/") || STATIC_FILE.test(pathname)) {
    return { action: "next" };
  }

  const path = pathname.replace(/\/+$/, "") || "/";
  if (path === "/") return { action: "rewrite", pathname: WAITING_ROOM };
  const legal = LEGAL.find((d) => path === `/${d}`);
  if (legal) return { action: "rewrite", pathname: `${WAITING_ROOM}/${legal}` };
  // The internal route itself, and its legal pages, have one public URL each.
  if (path === WAITING_ROOM) return { action: "redirect", pathname: "/" };
  const inner = LEGAL.find((d) => path === `${WAITING_ROOM}/${d}`);
  if (inner) return { action: "redirect", pathname: `/${inner}` };
  // Everything else is the app, which isn't open yet.
  return { action: "redirect", pathname: "/" };
}
