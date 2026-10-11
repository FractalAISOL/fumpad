import type { Metadata } from "next";
import { DesignView } from "@/components/design/DesignView";
import { DEMO_WALLET, getFumpadData } from "@/data";

export const metadata: Metadata = { title: "Design system", robots: { index: false } };

export default async function DesignPage() {
  const data = getFumpadData();
  const coin = await data.getCoin("MIDC");
  const [tickets, series, leaders] = await Promise.all([data.getTickets(DEMO_WALLET), data.getPriceSeries(coin!.mint, "all"), data.getLeaderboard("fumbles")]);
  return <DesignView tickets={tickets} series={series} leaders={leaders} />;
}
