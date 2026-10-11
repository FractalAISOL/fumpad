import type { Metadata } from "next";
import { LeaderboardView } from "@/components/people/LeaderboardView";
import { DEMO_WALLET, getFumpadData } from "@/data";

export const metadata: Metadata = { title: "Leaderboard" };

export default async function LeaderboardPage() {
  const data = getFumpadData();
  const [fumbles, claimers, diamond, profile] = await Promise.all([
    data.getLeaderboard("fumbles"),
    data.getLeaderboard("claimers"),
    data.getLeaderboard("diamond"),
    data.getProfile(DEMO_WALLET),
  ]);
  return <LeaderboardView initial={{ fumbles, claimers, diamond }} profile={profile} />;
}
