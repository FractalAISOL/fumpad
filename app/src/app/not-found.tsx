import { Button, Panel } from "@/design";
import { FumiEmptyState } from "@/design/anime";
import states from "@/components/shell/states.module.css";

export default function NotFound() {
  return (
    <div className="wrap" style={{ paddingTop: 48 }}>
      <h1 className="sr-only">Page not found</h1>
      <Panel>
        <FumiEmptyState
          className={states.quipFix}
          pose="facepalm"
          quip="Wrong turn. Happens to everyone."
          title="Nothing at this address"
          action={
            <>
              <Button href="/">Back to the feed</Button>
              <Button href="/launches" variant="line">
                Browse launches
              </Button>
            </>
          }
        >
          The coin, ticket or wallet you followed doesn&apos;t exist here. Check the link, or start from the feed.
        </FumiEmptyState>
      </Panel>
    </div>
  );
}
