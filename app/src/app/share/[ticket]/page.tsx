import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { cardCopy } from "@/components/share/card";
import { ShareView } from "@/components/share/ShareView";
import { DEMO_WALLET, getFumpadData } from "@/data";
import { Loading, Skeleton } from "@/design";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://fumpad.app";

export async function generateStaticParams() {
  const ts = await getFumpadData().getTickets(DEMO_WALLET);
  return ts.map((t) => ({ ticket: t.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ ticket: string }> }): Promise<Metadata> {
  const { ticket } = await params;
  const t = await getFumpadData().getTicket(ticket);
  if (!t) return { title: "Ticket not found" };
  const { head, body } = cardCopy(t);
  const image = { url: `/og/${t.id}`, width: 1200, height: 630, alt: `${head} ${body}` };
  return {
    title: `$${t.symbol} at ${t.multiple.toFixed(1)}×`,
    description: body,
    openGraph: { title: head, description: body, images: [image] },
    twitter: { card: "summary_large_image", title: head, description: body, images: [image] },
  };
}

export default function SharePage({ params }: { params: Promise<{ ticket: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="wrap" style={{ paddingTop: 120 }}>
          <Loading label="Loading share card">
            <div style={{ aspectRatio: "1200 / 630" }}>
              <Skeleton h="100%" />
            </div>
          </Loading>
        </div>
      }
    >
      <Share params={params} />
    </Suspense>
  );
}

async function Share({ params }: { params: Promise<{ ticket: string }> }) {
  const { ticket } = await params;
  const t = await getFumpadData().getTicket(ticket);
  if (!t) notFound();
  return <ShareView ticket={t} siteUrl={SITE} />;
}
