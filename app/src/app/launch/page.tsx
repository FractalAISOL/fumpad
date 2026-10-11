import type { Metadata } from "next";
import { LaunchView } from "@/components/launch/LaunchView";

export const metadata: Metadata = { title: "Launch a coin" };

export default function LaunchPage() {
  return <LaunchView />;
}
