import type { Metadata } from "next";
import { CoinsView } from "@/components/coin/CoinsView";
import { getFumpadData } from "@/data";

export const metadata: Metadata = { title: "Coins" };

export default async function CoinsPage() {
  const data = getFumpadData();
  const [coins, solUsd] = await Promise.all([data.listCoins({ sort: "mcap" }), data.getSolUsd()]);
  return <CoinsView coins={coins} solUsd={solUsd} />;
}
