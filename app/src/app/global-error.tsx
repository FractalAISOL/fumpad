"use client";

import { useEffect } from "react";
import { THEME_KEY } from "@/components/shell/theme";
import { Button, Panel } from "@/design";
import { FumiErrorState } from "@/design/anime";
import states from "@/components/shell/states.module.css";
import { archivo, martian } from "@/design/fonts";
import { tokensToCss } from "@/design/tokens";
import "./globals.css";

const TOKENS_CSS = tokensToCss();

/**
 * The root layout itself failed, so there's no header, footer or theme toggle: this page brings its
 * own <html>, tokens and fonts, and applies the saved theme itself.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  // Apply a saved light/dark choice (the root layout's pre-paint script isn't here).
  useEffect(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    } catch {}
  }, []);
  return (
    <html lang="en" className={`${archivo.variable} ${martian.variable}`} suppressHydrationWarning>
      <head>
        <title>Something went wrong | FUMPAD</title>
        <style dangerouslySetInnerHTML={{ __html: TOKENS_CSS }} />
      </head>
      <body>
        <main className="wrap" style={{ paddingTop: 48, paddingBottom: 48 }}>
          <h1 className="sr-only">Something went wrong</h1>
          <Panel>
            <FumiErrorState
              className={states.quipFix}
              pose="crying"
              quip="We fumbled this one."
              title="FUMPAD didn't load"
              action={
                <>
                  <Button onClick={() => retry()}>Try again</Button>
                  <Button href="/status" variant="line">
                    Check status
                  </Button>
                </>
              }
            >
              The app hit an error before it could start. Your coins and tickets are on Solana, not on this page. Try again in a moment, or reload.
              {error.digest ? ` Reference: ${error.digest}.` : ""}
            </FumiErrorState>
          </Panel>
        </main>
      </body>
    </html>
  );
}
