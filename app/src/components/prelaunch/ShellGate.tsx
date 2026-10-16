"use client";

import dynamic from "next/dynamic";
import { useSelectedLayoutSegments } from "next/navigation";
import type { ReactNode } from "react";
import type { ProtocolParams } from "@/data";
import { isLegalRoute } from "@/legal/disclaimer";
import { DisclaimerGate } from "../legal/DisclaimerGate";

/*
 * Loaded through next/dynamic (still server-rendered) so their chunks — the data layer,
 * wallet and Solana libraries — are only fetched by pages that render the app shell. The
 * waiting room ships none of it.
 */
const Providers = dynamic(() => import("../shell/Providers").then((m) => m.Providers));
const Header = dynamic(() => import("../shell/Shell").then((m) => m.Header));
const TabBar = dynamic(() => import("../shell/Shell").then((m) => m.TabBar));

/**
 * The waiting room (`app/soon`, served at `/` on the pre-launch hosts) has its own chrome and
 * none of the app's: no header, tab bar, footer, wallet, live socket or Privy, and none of their JS. The segment
 * comes from the route tree, not the URL, so it is right under the proxy's rewrite too, and
 * it's known at prerender time (no client-only branch, no hydration flash).
 */
export function ShellGate({
  footer,
  mainClassName,
  now,
  params,
  solUsd,
  children,
}: {
  footer: ReactNode;
  mainClassName: string;
  now: number;
  params: ProtocolParams;
  solUsd: number;
  children: ReactNode;
}) {
  const segments = useSelectedLayoutSegments();
  const segment = segments[0] ?? null;
  // Every page asks for the legal disclaimer first, except the legal pages it links to.
  const gate = <DisclaimerGate legal={isLegalRoute(segments)} />;
  // The launch-window checker (`app/live`) has its own frame too.
  if (segment === "soon" || segment === "live")
    return (
      <>
        {children}
        {gate}
      </>
    );
  return (
    <Providers now={now} params={params} solUsd={solUsd}>
      {gate}
      <Header solUsd={solUsd} />
      <main id="main" className={mainClassName}>
        {children}
      </main>
      {footer}
      <TabBar />
    </Providers>
  );
}
