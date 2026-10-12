import type { Metadata } from "next";
import { StatusView } from "@/components/status/StatusView";

export const metadata: Metadata = {
  title: "Status",
  description: "Is FUMPAD's backend keeping up? Indexer lag, keeper price samples, launch addresses and deployed versions.",
};

export default function StatusPage() {
  return <StatusView />;
}
