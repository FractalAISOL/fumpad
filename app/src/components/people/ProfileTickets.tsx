"use client";

import { useCallback, useMemo, useState } from "react";
import { keepSnapshot, type Ticket, getFumpadData } from "@/data";
import { EmptyState, TicketCard } from "@/design";
import * as f from "@/design/format";
import { useRefresh } from "../shell/live";
import { useNow, useProtocolParams } from "../shell/Providers";
import s from "./People.module.css";

export function ProfileTickets({ tickets: initial, owner }: { tickets: Ticket[]; owner: string }) {
  const now = useNow();
  const params = useProtocolParams();
  const [tickets, setTickets] = useState(initial);
  // Public tickets move with the wallet and with the coins they're on.
  const load = useCallback(() => {
    getFumpadData().getTickets(owner).then(setTickets).catch(keepSnapshot);
  }, [owner]);
  const mints = useMemo(() => [...new Set(tickets.filter((t) => t.state !== "claimed" && t.state !== "expired" && t.state !== "voided").map((t) => t.mint))].sort(), [tickets]);
  useRefresh(load, { wallets: [owner], mints, pollMs: 60_000, debounceMs: 2_000 });

  if (!tickets.length)
    return (
      <EmptyState title="No tickets yet" compact>
        This wallet hasn&apos;t sold {f.usdRule(params.minSellUsd)} or more of anything through FUMPAD.
      </EmptyState>
    );
  const sorted = [...tickets].sort((a, b) => b.multiple - a.multiple);
  return (
    <ul className={s.list}>
      {sorted.map((t) => (
        <TicketCard key={t.id} as="li" ticket={t} now={now} />
      ))}
    </ul>
  );
}
