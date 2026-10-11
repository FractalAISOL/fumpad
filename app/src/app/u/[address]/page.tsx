import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ProfileTickets } from "@/components/people/ProfileTickets";
import { ProfileCard } from "@/components/people/ProfileCard";
import s from "@/components/people/People.module.css";
import { DEMO_WALLET, getFumpadData } from "@/data";
import { Loading, Panel, PanelHead, Skeleton } from "@/design";
import * as f from "@/design/format";

export async function generateStaticParams() {
  return [{ address: DEMO_WALLET }];
}

export async function generateMetadata({ params }: { params: Promise<{ address: string }> }): Promise<Metadata> {
  const { address } = await params;
  const p = await getFumpadData().getProfile(address);
  return { title: p ? (p.name ?? f.shortAddr(p.address)) : "Wallet not found" };
}

export default function ProfilePage({ params }: { params: Promise<{ address: string }> }) {
  return (
    <Suspense
      fallback={
        <div className="wrap">
          <Loading label="Loading profile">
            <div className={s.profileGrid}>
              <Panel as="div">
                <div style={{ padding: 20, display: "grid", gap: 12 }}>
                  <Skeleton w={64} h={64} round />
                  <Skeleton w="60%" h={22} />
                  <Skeleton h={120} />
                </div>
              </Panel>
              <Panel as="div">
                <div style={{ padding: 20 }}>
                  <Skeleton h={240} />
                </div>
              </Panel>
            </div>
          </Loading>
        </div>
      }
    >
      <ProfileBody params={params} />
    </Suspense>
  );
}

async function ProfileBody({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const data = getFumpadData();
  const p = await data.getProfile(decodeURIComponent(address));
  if (!p) notFound();
  const tickets = await data.getTickets(p.address);
  return (
    <div className="wrap">
      <div className={s.profileGrid}>
        <Panel>
          <ProfileCard p={p} headingLevel={1} />
        </Panel>
        <Panel aria-labelledby="pt-h">
          <PanelHead id="pt-h" title="Tickets" aside="public, like everything on-chain" />
          <ProfileTickets tickets={tickets} />
        </Panel>
      </div>
    </div>
  );
}
