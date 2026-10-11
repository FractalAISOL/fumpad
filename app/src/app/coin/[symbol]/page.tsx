import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CoinSkeleton } from "@/components/coin/CoinSkeleton";
import { CoinView } from "@/components/coin/CoinView";
import { DEMO_WALLET, getFumpadData } from "@/data";

export async function generateStaticParams() {
  const coins = await getFumpadData().listCoins();
  return coins.map((c) => ({ symbol: c.symbol }));
}

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const { symbol } = await params;
  const c = await getFumpadData().getCoin(symbol);
  if (!c) return { title: "Coin not found" };
  return { title: `${c.name} ($${c.symbol})`, description: c.description };
}

export default function CoinPage({ params }: { params: Promise<{ symbol: string }> }) {
  return (
    <Suspense fallback={<CoinSkeleton />}>
      <Coin params={params} />
    </Suspense>
  );
}

async function Coin({ params }: { params: Promise<{ symbol: string }> }) {
  const { symbol } = await params;
  const data = getFumpadData();
  const coin = await data.getCoin(symbol);
  if (!coin) notFound();
  const [series, holders, fumbles, queue, solUsd] = await Promise.all([
    data.getPriceSeries(coin.mint, "7d"),
    data.getHolders(coin.mint, DEMO_WALLET),
    data.getRecentFumbles(coin.mint, DEMO_WALLET),
    data.getClaimQueue(coin.mint, DEMO_WALLET),
    data.getSolUsd(),
  ]);
  return <CoinView coin={coin} series={series} holders={holders} fumbles={fumbles} queue={queue} solUsd={solUsd} />;
}
