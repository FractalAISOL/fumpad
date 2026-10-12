import { type NextRequest, NextResponse } from "next/server";
import { decide } from "./prelaunch/gate";

/**
 * Pre-launch gate (see `prelaunch/gate.ts` and `LAUNCH.md`): on fumpad.app / www.fumpad.app the
 * whole site is the waiting room; every other host serves the app unchanged.
 */
export function proxy(req: NextRequest) {
  const d = decide(req.headers.get("host"), req.nextUrl.pathname, {
    PRELAUNCH_HOSTS: process.env.PRELAUNCH_HOSTS,
    NEXT_PUBLIC_PRELAUNCH: process.env.NEXT_PUBLIC_PRELAUNCH,
  });
  if (d.action === "next") return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = d.pathname;
  if (d.action === "rewrite") return NextResponse.rewrite(url);
  // Back to the host that was asked for (behind a proxy, nextUrl can carry an internal one).
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
  const to = host ? new URL(d.pathname, `${proto}://${host}`) : url;
  if (!host) to.search = "";
  // 307: temporary, so browsers and crawlers don't remember it past launch.
  return NextResponse.redirect(to, 307);
}

export const config = {
  // Build assets never need the gate; everything else (pages, public files) goes through it.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
