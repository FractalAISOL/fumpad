"use client";

import { Button, Panel } from "@/design";
import { FumiErrorState } from "@/design/anime";

/**
 * A page threw while rendering. The header, tab bar and footer stay (this sits inside the root
 * layout); Fumi softens it, the copy says what happened and what to do.
 */
export default function PageError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="wrap" style={{ paddingTop: 48 }}>
      <h1 className="sr-only">Something went wrong</h1>
      <Panel>
        <FumiErrorState
          pose="facepalm"
          quip="Oops. That one's on us."
          title="This page didn't load"
          action={
            <>
              <Button onClick={() => retry()}>Try again</Button>
              <Button href="/status" variant="line">
                Check status
              </Button>
            </>
          }
        >
          Something broke while showing it. Your coins and tickets are on Solana, not on this page. Try again, and if it keeps happening, check the status page.
          {error.digest ? ` Reference: ${error.digest}.` : ""}
        </FumiErrorState>
      </Panel>
    </div>
  );
}
