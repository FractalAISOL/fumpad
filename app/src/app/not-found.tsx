import { Button, EmptyState, Panel } from "@/design";

export default function NotFound() {
  return (
    <div className="wrap" style={{ paddingTop: 48 }}>
      <Panel>
        <EmptyState title="Nothing at this address" action={<Button href="/">Back to the feed</Button>}>
          The coin, ticket or wallet you followed doesn&apos;t exist here. Check the link, or start from the feed.
        </EmptyState>
      </Panel>
    </div>
  );
}
