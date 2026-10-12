"use client";

import type { Ticket } from "@/data";
import { EmptyState, TicketCard } from "@/design";
import * as f from "@/design/format";
import { useNow, useProtocolParams } from "../shell/Providers";
import s from "./People.module.css";

/** A wallet's tickets, closest to 10× first. The portfolio view owns loading and live updates. */
export function ProfileTickets({ tickets }: { tickets: Ticket[] }) {
  const now = useNow();
  const params = useProtocolParams();
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
