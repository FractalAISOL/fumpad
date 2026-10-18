import { type NextRequest, NextResponse } from "next/server";
import { decide, redirectLocation } from "./prelaunch/gate";

/**
 * Pre-launch gate (see `prelaunch/gate.ts` and `LAUNCH.md`): on fumpad.app / www.fumpad.app the
 * whole site is the launch-window page (coming soon, then the first coin live) until NEXT_PUBLIC_PRELAUNCH=off;
 * every other host serves the app unchanged.
 */
export function proxy(req: NextRequest) {
  const env = { PRELAUNCH_HOSTS: process.env.PRELAUNCH_HOSTS, NEXT_PUBLIC_PRELAUNCH: process.env.NEXT_PUBLIC_PRELAUNCH, NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL };
  const host = req.headers.get("host");
  const d = decide(host, req.nextUrl.pathname, env);
  if (d.action === "next") return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = d.pathname;
  if (d.action === "rewrite") return NextResponse.rewrite(url);
  // APP-5: back to the gated host that was asked for, over https, built from the allow-listed host list (and
  // NEXT_PUBLIC_SITE_URL), never from x-forwarded-host / x-forwarded-proto. 307: temporary, so browsers and crawlers
  // don't remember it past launch.
  const search = d.keepQuery ? req.nextUrl.search : "";
  const to = redirectLocation(host, d.pathname, search, env);
  if (to) return NextResponse.redirect(to, 307);
  return new NextResponse(null, { status: 307, headers: { Location: `${d.pathname}${search}` } });
}

export const config = {
  // Build assets never need the gate; everything else (pages, public files) goes through it.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
