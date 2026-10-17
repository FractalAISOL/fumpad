import type { Metadata } from "next";
import { DesignView } from "@/components/design/DesignView";
import { DEMO_WALLET } from "@/data";
import { mockData } from "@/data/mock";

export const metadata: Metadata = { title: "Design system", robots: { index: false } };

/** Specimens always come from the deterministic mock, whichever data source the app runs on. */
export default async function DesignPage() {
  const coin = await mockData.getCoin("MIDC");
  const [tickets, candles] = await Promise.all([mockData.getTickets(DEMO_WALLET), mockData.getCandles(coin!.mint, "30m")]);
  return <DesignView tickets={tickets} candles={candles} />;
}
