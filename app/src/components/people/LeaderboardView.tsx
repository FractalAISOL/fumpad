"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { keepSnapshot, type Board, type LeaderRow, type Profile, getFumpadData } from "@/data";
import { Address, type Column, Multiple, Panel, PanelHead, PanelNote, Sol, Table, Tabs, cx, tabPanelId, tabId } from "@/design";
import { useRefresh } from "../shell/live";
import { useViewer } from "../shell/Providers";
import s from "./People.module.css";
import { ProfileCard } from "./ProfileCard";

const BOARDS: { value: Board; label: string; aside: string }[] = [
  { value: "fumbles", label: "Biggest fumbles", aside: "what the sold tokens are worth today" },
  { value: "claimers", label: "Top claimers", aside: "paid out in the last 30 days, valued at claim" },
  { value: "diamond", label: "Diamond hands", aside: "claims held open longest after crossing 10×" },
];

const rankCol: Column<LeaderRow> = {
  key: "rank",
  header: "#",
  render: (r) => <span className={cx("num", s.rank, r.rank <= 3 && s.rankTop)}>{r.rank}</span>,
  sortValue: (r) => r.rank,
};
const who = (address: string): Column<LeaderRow> => ({
  key: "who",
  header: "Wallet",
  render: (r) => <Address address={r.address} name={r.name} you={r.address === address} />,
});
const coin: Column<LeaderRow> = {
  key: "coin",
  header: "Coin",
  hideBelow: "md",
  render: (r) => (
    <Link href={`/coin/${r.symbol}`} className="ticker">
      ${r.symbol}
    </Link>
  ),
};

function columns(board: Board, address: string): Column<LeaderRow>[] {
  if (board === "fumbles")
    return [
      rankCol,
      who(address),
      coin,
      { key: "sold", header: "Sold for", align: "end", hideBelow: "sm", render: (r) => <Sol value={r.soldForSol!} />, sortValue: (r) => r.soldForSol! },
      { key: "now", header: "Worth now", align: "end", render: (r) => <Sol value={r.worthNowSol!} />, sortValue: (r) => r.worthNowSol! },
      { key: "x", header: "×", align: "end", render: (r) => <Multiple x={r.multiple!} size="sm" />, sortValue: (r) => r.multiple! },
    ];
  if (board === "claimers")
    return [
      rankCol,
      who(address),
      { key: "claims", header: "Claims", align: "end", hideBelow: "md", render: (r) => <span className="num">{r.claims}</span>, sortValue: (r) => r.claims! },
      { ...coin, header: "Best coin" },
      { key: "claimed", header: "Claimed", align: "end", render: (r) => <Sol value={r.claimedSol!} />, sortValue: (r) => r.claimedSol! },
      { key: "x", header: "Best ×", align: "end", hideBelow: "sm", render: (r) => <Multiple x={r.multiple!} size="sm" />, sortValue: (r) => r.multiple! },
    ];
  return [
    rankCol,
    who(address),
    coin,
    {
      key: "unl",
      header: "Unlocked at",
      align: "end",
      hideBelow: "sm",
      render: (r) => <Multiple x={r.unlockedAt!} size="sm" />,
      sortValue: (r) => r.unlockedAt!,
    },
    { key: "cl", header: "Claimed at", align: "end", render: (r) => <Multiple x={r.claimedAtMultiple!} size="sm" />, sortValue: (r) => r.claimedAtMultiple! },
    { key: "w", header: "Waited", align: "end", render: (r) => <span className="num">{r.waitedDays} days</span>, sortValue: (r) => r.waitedDays! },
  ];
}

export function LeaderboardView({ initial, profile: initialProfile }: { initial: Record<Board, LeaderRow[]>; profile: Profile | null }) {
  const data = getFumpadData();
  const { address } = useViewer();
  const [board, setBoard] = useState<Board>("fumbles");
  const [profile, setProfile] = useState(initialProfile);
  const [rows, setRows] = useState(initial);

  // Boards rank 30-day totals: claims and fumbles move them, so follow the feed, the viewer's
  // own transactions, and poll lightly.
  const load = useCallback(() => {
    data.getProfile(address).then(setProfile).catch(keepSnapshot);
    for (const b of BOARDS) data.getLeaderboard(b.value, address).then((r) => setRows((x) => ({ ...x, [b.value]: r }))).catch(keepSnapshot);
  }, [data, address]);
  useRefresh(load, { wallets: [address], onFeed: true, pollMs: 60_000, debounceMs: 3_000 });

  const meta = BOARDS.find((b) => b.value === board)!;
  return (
    <div className="wrap">
      <div className={s.pageHead}>
        <div>
          <h1 className={s.h1}>Leaderboard</h1>
          <p className={s.lede}>The hall of early exits. Ranked over the last 30 days; flagged wallets don&apos;t appear.</p>
        </div>
      </div>
      <div className={s.grid}>
        <Panel>
          <div className={s.tabsWrap}>
            <Tabs idBase="lb" label="Board" value={board} onChange={setBoard} items={BOARDS.map(({ value, label }) => ({ value, label }))} />
          </div>
          <div role="tabpanel" id={tabPanelId("lb", board)} aria-labelledby={tabId("lb", board)}>
            <PanelHead title={meta.label} level={3} aside={meta.aside} />
            <Table
              key={board}
              caption={meta.label}
              columns={columns(board, address)}
              rows={rows[board]}
              rowKey={(r) => r.address + r.rank}
              highlight={(r) => r.address === address}
            />
          </div>
          <PanelNote>Wallets linked to a coin&apos;s creator by funding history are flagged publicly and left off every board. They can still claim.</PanelNote>
        </Panel>
        <Panel aria-label="Your profile">{profile && <ProfileCard p={profile} you />}</Panel>
      </div>
    </div>
  );
}
