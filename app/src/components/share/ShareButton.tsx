import type { Ticket } from "@/data";
import { Button, IconShare } from "@/design";

/** Opens the ticket's share card. Every state has one, so every ticket gets the button. */
export function ShareButton({ ticket }: { ticket: Ticket }) {
  return (
    <Button variant="line" size="sm" href={`/share/${ticket.id}`} icon={<IconShare />} aria-label={`Share the $${ticket.symbol} ticket`}>
      Share
    </Button>
  );
}
