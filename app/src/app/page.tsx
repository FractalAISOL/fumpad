import { FeedView } from "@/components/feed/FeedView";
import { DEMO_WALLET, getFumpadData } from "@/data";

export default async function Home() {
  const data = getFumpadData();
  const [feed, stats, closest, trending] = await Promise.all([
    data.getFeed({ limit: 24 }),
    data.getStats(),
    data.getClosestTo10x(5, DEMO_WALLET),
    data.listCoins({ sort: "trending", limit: 6 }),
  ]);
  return <FeedView initial={feed} stats={stats} closest={closest} trending={trending} />;
}
