import type { Metadata } from "next";
import { LaunchesBoard } from "@/components/launches/Board";
import { cachedCoins, cachedSolUsd } from "@/data/server";

export const metadata: Metadata = {
  title: "Launches",
  description: "Every FUMPAD coin, live: new launches, the final stretch to graduation, and graduated coins with the ticket closest to 10×.",
};

export default async function LaunchesPage() {
  const [curve, graduated, solUsd] = await Promise.all([
    cachedCoins({ sort: "new", status: "curve", limit: 150 }),
    cachedCoins({ sort: "trending", status: "graduated", limit: 80 }),
    cachedSolUsd(),
  ]);
  return <LaunchesBoard curve={curve} graduated={graduated} solUsd={solUsd} />;
}
