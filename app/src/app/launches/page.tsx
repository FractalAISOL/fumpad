import type { Metadata } from "next";
import { CoinsView } from "@/components/coin/CoinsView";
import { cachedCoins, cachedSolUsd } from "@/data/server";

export const metadata: Metadata = { title: "Launches" };

export default async function LaunchesPage() {
  const [coins, solUsd] = await Promise.all([cachedCoins({ sort: "mcap" }), cachedSolUsd()]);
  return <CoinsView coins={coins} solUsd={solUsd} />;
}
