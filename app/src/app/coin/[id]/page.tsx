import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { CoinSkeleton } from "@/components/coin/CoinSkeleton";
import { CoinView } from "@/components/coin/CoinView";
import { coinHref, isMintAddress, normalizeSymbol } from "@/components/coin/ident";
import { SymbolChooser } from "@/components/coin/SymbolChooser";
import { DEMO_WALLET } from "@/data";
import { defaultInterval } from "@/data/candles";
import { cachedCandles, cachedClaimQueue, cachedCoin, cachedCoins, cachedCoinsBySymbol, cachedHolders, cachedRecentFumbles, cachedSolUsd, shellSnapshot } from "@/data/server";

/**
 * `/coin/<mint>` is the coin page; every link in the app uses it (H-3). `/coin/<SYMBOL>` (and the
 * short `/c/<SYMBOL>`) is a lookup: one match goes to that coin's mint URL, several show a
 * chooser, newest first. FUMPAD never picks a coin by symbol on the user's behalf.
 */

type Params = Promise<{ id: string }>;

/** Params arrive decoded; tolerate a stray encoded symbol from a hand-made link. */
const idOf = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export async function generateStaticParams() {
  const coins = await cachedCoins();
  // Cache Components needs at least one param; "_" resolves to "not found" like any unknown id.
  return coins.length ? coins.map((c) => ({ id: c.mint })) : [{ id: "_" }];
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const id = idOf((await params).id);
  if (isMintAddress(id)) {
    const c = await cachedCoin(id);
    if (!c || c.mint !== id) return { title: "Coin not found" };
    return { title: `${c.name} ($${c.symbol})`, description: c.description.trim() || undefined, alternates: { canonical: coinHref(c) } };
  }
  const list = await cachedCoinsBySymbol(normalizeSymbol(id));
  if (!list.length) return { title: "Coin not found" };
  return { title: list.length === 1 ? `${list[0].name} ($${list[0].symbol})` : `$${normalizeSymbol(id)}: ${list.length} coins`, robots: { index: false } };
}

export default function CoinPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<CoinSkeleton />}>
      <Coin params={params} />
    </Suspense>
  );
}

async function Coin({ params }: { params: Params }) {
  const id = idOf((await params).id);
  if (!isMintAddress(id)) {
    const symbol = normalizeSymbol(id);
    const list = symbol ? await cachedCoinsBySymbol(symbol) : [];
    if (!list.length) notFound();
    if (list.length === 1) redirect(coinHref(list[0]));
    return <SymbolChooser symbol={symbol} coins={list} solUsd={await cachedSolUsd()} />;
  }
  const coin = await cachedCoin(id);
  // The API also matches symbols; a mint URL must resolve to exactly that mint.
  if (!coin || coin.mint !== id) notFound();
  // The chart opens on 1m for a fresh coin, 5m otherwise (`defaultInterval`), by the data source's clock.
  const { now } = await shellSnapshot();
  const [candles, holders, fumbles, queue, solUsd] = await Promise.all([
    cachedCandles(coin.mint, defaultInterval(coin.createdAt, now)),
    cachedHolders(coin.mint, DEMO_WALLET),
    cachedRecentFumbles(coin.mint, DEMO_WALLET),
    cachedClaimQueue(coin.mint, DEMO_WALLET),
    cachedSolUsd(),
  ]);
  return <CoinView coin={coin} candles={candles} holders={holders} fumbles={fumbles} queue={queue} solUsd={solUsd} />;
}
