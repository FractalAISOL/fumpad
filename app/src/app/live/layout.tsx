import type { Metadata } from "next";
import { META, launchState } from "@/components/checker/launchState";
import { RoomFooter, RoomHeader } from "@/components/prelaunch/Frame";
import { ROOM_THEME_SCRIPT } from "@/components/prelaunch/ThemeSwitch";
import s from "@/components/prelaunch/Room.module.css";

/**
 * The launch-window page's frame: fumpad.app's only page until the full app opens. Public URL: `/` on fumpad.app
 * unless NEXT_PUBLIC_PRELAUNCH=off (`prelaunch/gate.ts`). Its own chrome: no app shell, wallet, Privy or signing
 * code; the root layout drops the shell for this segment (`ShellGate`) and keeps the disclaimer gate.
 * Metadata follows the page's state (coming soon / live, `launchState.ts`); NEXT_PUBLIC_CHECKER_MINT is inlined at
 * build, so it's fixed per deployment. The OG/Twitter image is the Fumi card next to this file (absolute via the
 * root layout's metadataBase, NEXT_PUBLIC_SITE_URL).
 */

const meta = META[launchState(process.env.NEXT_PUBLIC_CHECKER_MINT).state];

export const metadata: Metadata = {
  title: { absolute: meta.title, template: "%s | FUMPAD" },
  description: meta.description,
  alternates: { canonical: "https://fumpad.app/" },
  openGraph: {
    type: "website",
    siteName: "FUMPAD",
    url: "https://fumpad.app/",
    title: meta.socialTitle,
    description: meta.socialDescription,
  },
  twitter: {
    card: "summary_large_image",
    site: "@Fumblepad",
    title: meta.socialTitle,
    description: meta.socialDescription,
  },
};

const DISCLAIMER =
  "FUMPAD is software for launching and trading memecoins on Solana. Memecoins are extremely risky and most go to zero. A fumble ticket is not insurance: claims pay only while the coin’s reward pool can cover them. Links to other apps are not endorsements. Nothing here is financial advice.";

export default function LiveLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={s.room}>
      <script dangerouslySetInnerHTML={{ __html: ROOM_THEME_SCRIPT }} />
      <div className={s.gridBg} aria-hidden="true">
        <div className={s.gridCols} />
      </div>
      <a href="#content" className={s.skip}>
        Skip to content
      </a>
      <RoomHeader />
      <main id="content" className={s.main}>
        {children}
      </main>
      <RoomFooter disclaimer={DISCLAIMER} />
    </div>
  );
}
