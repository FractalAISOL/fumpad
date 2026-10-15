import type { Metadata } from "next";
import { Suspense } from "react";
import { FumbleCheck } from "@/components/checker/FumbleCheck";
import { Rules } from "@/components/checker/Rules";
import s from "@/components/checker/Checker.module.css";
import { SOLSCAN_QUERY } from "@/chain/cluster";
import { shellSnapshot } from "@/data/server";
import { Skeleton } from "@/design";

export const metadata: Metadata = {
  title: "Fumble Checker",
  description: "Paste any Solana wallet: every sell of a FUMPAD coin, whether it counts, where its ticket stands, and the market cap it claims at.",
};

/**
 * The Fumble Checker in the full app (every coin). Same components as the launch-window page; any pasted address,
 * no login, read-only. `?wallet=` makes a result a link.
 */
export default async function CheckerPage() {
  const { solUsd, now, params } = await shellSnapshot();
  return (
    <div className="wrap">
      <div className={s.appHead}>
        <p className={s.eyebrow}>Fumble Checker</p>
        <h1 className={s.appH1} id="checker-h">
          Did you fumble?
        </h1>
        <p className={s.lede}>
          Paste any wallet to see its sells of every FUMPAD coin, on any app: which ones count, where each ticket stands, and the market cap it claims at. Nothing
          to connect or sign.
        </p>
      </div>
      <Suspense fallback={<Skeleton h={120} />}>
        <FumbleCheck params={params} solUsd={solUsd} clusterQuery={SOLSCAN_QUERY} coinLinks serverNow={now} headingId="checker-h" />
      </Suspense>
      <section className={s.appRules} aria-labelledby="rules-h">
        <h2 id="rules-h" className={s.h2Small}>
          The rules
        </h2>
        <Rules params={params} />
      </section>
    </div>
  );
}
