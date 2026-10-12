import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { isAddress } from "@/components/coin/ident";
import { cardCopy, ogSrc } from "@/components/share/card";
import { ShareView } from "@/components/share/ShareView";
import { DEMO_WALLET } from "@/data";
import { cachedParams, cachedTicket, cachedTickets } from "@/data/server";
import { Loading, Skeleton } from "@/design";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://fumpad.app";

/**
 * The demo wallet's tickets are prerendered; any other ticket id renders on its first request
 * (dynamic params) and is cached like the rest of the data layer.
 */
export async function generateStaticParams() {
  const ts = await cachedTickets(DEMO_WALLET);
  // Cache Components needs at least one param; "_" resolves to "not found" like any unknown id.
  return ts.length ? ts.map((t) => ({ ticket: t.id })) : [{ ticket: "_" }];
}

export async function generateMetadata({ params }: { params: Promise<{ ticket: string }> }): Promise<Metadata> {
  const { ticket } = await params;
  if (!isAddress(ticket)) return { title: "Ticket not found" };
  const [t, p] = await Promise.all([cachedTicket(ticket), cachedParams()]);
  if (!t) return { title: "Ticket not found" };
  const { head, kicker, body } = cardCopy(t, p);
  const title = `${head} ${kicker}`;
  const image = { url: ogSrc(t), width: 1200, height: 630, alt: `${title} ${body}` };
  return {
    title: `$${t.symbol} ticket: ${head.replace(/\.$/, "")}`,
    description: body,
    openGraph: { type: "website", title, description: body, url: `/share/${t.id}`, images: [image] },
    twitter: { card: "summary_large_image", title, description: body, images: [image] },
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
  if (!isAddress(ticket)) notFound();
  const t = await cachedTicket(ticket);
  if (!t) notFound();
  return <ShareView ticket={t} siteUrl={SITE} />;
}
