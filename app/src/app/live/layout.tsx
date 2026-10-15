import type { Metadata } from "next";
import { RoomFooter, RoomHeader } from "@/components/prelaunch/Frame";
import { ROOM_THEME_SCRIPT } from "@/components/prelaunch/ThemeSwitch";
import s from "@/components/prelaunch/Room.module.css";

/**
 * The launch-window page's frame (between the first coin's launch and the full app). Public URL: `/` on fumpad.app
 * when NEXT_PUBLIC_PRELAUNCH=checker (`prelaunch/gate.ts`). Same chrome as the waiting room: no app shell, wallet,
 * Privy or signing code; the root layout drops the shell for this segment (`ShellGate`).
 */

export const metadata: Metadata = {
  title: { absolute: "FUMPAD — The first coin is live. Did you fumble?", template: "%s | FUMPAD" },
  description: "The first FUMPAD coin is live on Solana. Paste a wallet to see which sells count, where each ticket stands, and the market cap it claims at.",
  alternates: { canonical: "https://fumpad.app/" },
  openGraph: {
    type: "website",
    siteName: "FUMPAD",
    url: "https://fumpad.app/",
    title: "The first FUMPAD coin is live. Did you fumble?",
    description: "Sell on any app. If the coin later holds 10× your price, claim 10% of what you sold. Check any wallet.",
  },
  twitter: {
    card: "summary_large_image",
    site: "@Fumblepad",
    title: "The first FUMPAD coin is live. Did you fumble?",
    description: "Sell on any app. If the coin later holds 10× your price, claim 10% of what you sold. Check any wallet.",
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
