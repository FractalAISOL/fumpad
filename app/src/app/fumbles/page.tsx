import type { Metadata } from "next";
import { FumblesView } from "@/components/fumbles/FumblesView";
import { DEMO_WALLET } from "@/data";
import { cachedTickets } from "@/data/server";

export const metadata: Metadata = { title: "My fumbles" };

export default async function FumblesPage() {
  const tickets = await cachedTickets(DEMO_WALLET);
  return <FumblesView initial={tickets} />;
}
