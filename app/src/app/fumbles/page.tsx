import type { Metadata } from "next";
import { FumblesView } from "@/components/fumbles/FumblesView";
import { DEMO_WALLET, getFumpadData } from "@/data";

export const metadata: Metadata = { title: "My fumbles" };

export default async function FumblesPage() {
  const tickets = await getFumpadData().getTickets(DEMO_WALLET);
  return <FumblesView initial={tickets} />;
}
