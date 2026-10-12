import { FeedView } from "@/components/feed/FeedView";
import { DEMO_WALLET } from "@/data";
import { cachedClosestTo10x, cachedCoins, cachedFeed, cachedStats } from "@/data/server";

export default async function Home() {
  const [feed, stats, closest, trending] = await Promise.all([
    cachedFeed({ limit: 24 }),
    cachedStats(),
    cachedClosestTo10x(5, DEMO_WALLET),
    cachedCoins({ sort: "trending", limit: 6 }),
  ]);
  return <FeedView initial={feed} stats={stats} closest={closest} trending={trending} />;
}
