import type { Metadata } from "next";
import { CLUSTER_LABEL } from "@/chain/cluster";
import { HowItWorksView } from "@/components/docs/HowItWorksView";

export const metadata: Metadata = {
  title: "How it works",
  description: "Trade FUMPAD coins anywhere: every sell over $50 counts. Tickets, attestation, the 10× median, claims, fees, snipe protection, graduation to Meteora.",
};

export default function HowItWorksPage() {
  return <HowItWorksView cluster={CLUSTER_LABEL} />;
}
