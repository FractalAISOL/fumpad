import type { Metadata } from "next";
import { LeaderboardView } from "@/components/people/LeaderboardView";
import { DEMO_WALLET } from "@/data";
import { cachedLeaderboard, cachedProfile } from "@/data/server";

export const metadata: Metadata = { title: "Leaderboard" };

export default async function LeaderboardPage() {
  const [fumbles, claimers, diamond, profile] = await Promise.all([
    cachedLeaderboard("fumbles"),
    cachedLeaderboard("claimers"),
    cachedLeaderboard("diamond"),
    cachedProfile(DEMO_WALLET),
  ]);
  return <LeaderboardView initial={{ fumbles, claimers, diamond }} profile={profile} />;
}
