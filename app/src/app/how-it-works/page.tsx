import type { Metadata } from "next";
import { CLUSTER_LABEL } from "@/chain/cluster";
import { HowItWorksView } from "@/components/docs/HowItWorksView";

export const metadata: Metadata = {
  title: "How it works",
  description: "Tickets, the 10× median, claims, fees, snipe protection, graduation and locked liquidity on FUMPAD.",
};

export default function HowItWorksPage() {
  return <HowItWorksView cluster={CLUSTER_LABEL} />;
}
