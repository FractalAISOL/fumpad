"use client";

import type { Ticket } from "@/data";
import { EmptyState, TicketCard } from "@/design";
import { useNow } from "../shell/Providers";
import s from "./People.module.css";

export function ProfileTickets({ tickets }: { tickets: Ticket[] }) {
  const now = useNow();
  if (!tickets.length) return <EmptyState title="No tickets yet" compact>This wallet hasn&apos;t sold $50 or more of anything through FUMPAD.</EmptyState>;
  const sorted = [...tickets].sort((a, b) => b.multiple - a.multiple);
  return (
    <ul className={s.list}>
      {sorted.map((t) => (
        <TicketCard key={t.id} as="li" ticket={t} now={now} />
      ))}
    </ul>
  );
}
