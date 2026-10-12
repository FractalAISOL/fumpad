import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { CoinSkeleton } from "@/components/coin/CoinSkeleton";
import { CoinView } from "@/components/coin/CoinView";
import { DEMO_WALLET } from "@/data";
import { cachedClaimQueue, cachedCoin, cachedCoins, cachedHolders, cachedPriceSeries, cachedRecentFumbles, cachedSolUsd } from "@/data/server";

export async function generateStaticParams() {
  const coins = await cachedCoins();
  // Cache Components needs at least one param; "_" resolves to "not found" like any unknown symbol.
  return coins.length ? coins.map((c) => ({ symbol: c.symbol })) : [{ symbol: "_" }];
}

export async function generateMetadata({ params }: { params: Promise<{ symbol: string }> }): Promise<Metadata> {
  const { symbol } = await params;
  const c = await cachedCoin(symbol);
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
  const coin = await cachedCoin(symbol);
  if (!coin) notFound();
  const [series, holders, fumbles, queue, solUsd] = await Promise.all([
    cachedPriceSeries(coin.mint, "7d"),
    cachedHolders(coin.mint, DEMO_WALLET),
    cachedRecentFumbles(coin.mint, DEMO_WALLET),
    cachedClaimQueue(coin.mint, DEMO_WALLET),
    cachedSolUsd(),
  ]);
  return <CoinView coin={coin} series={series} holders={holders} fumbles={fumbles} queue={queue} solUsd={solUsd} />;
}
