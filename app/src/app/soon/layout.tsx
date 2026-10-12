import type { Metadata } from "next";
import { RoomFooter, RoomHeader } from "@/components/prelaunch/Frame";
import { ROOM_THEME_SCRIPT } from "@/components/prelaunch/ThemeSwitch";
import s from "@/components/prelaunch/Room.module.css";

/**
 * The pre-launch waiting room's frame. Public URL: `/` on fumpad.app (the proxy rewrites it
 * here; `prelaunch/gate.ts`). The root layout drops the app shell for this segment.
 */

export const metadata: Metadata = {
  title: { absolute: "FUMPAD — The launchpad for people who sell too early.", template: "%s | FUMPAD" },
  description: "Sell a coin through FUMPAD. If it later holds 10× your sell price, you claim 10% of the tokens you sold. Coming to Solana mainnet.",
  alternates: { canonical: "https://fumpad.app/" },
  openGraph: {
    type: "website",
    siteName: "FUMPAD",
    url: "https://fumpad.app/",
    title: "FUMPAD — The launchpad for people who sell too early.",
    description: "Sell, and if the coin later holds 10× your price, claim 10% of what you sold. Coming to Solana mainnet.",
  },
  twitter: {
    card: "summary_large_image",
    site: "@Fumblepad",
    title: "FUMPAD — The launchpad for people who sell too early.",
    description: "Sell, and if the coin later holds 10× your price, claim 10% of what you sold. Coming to Solana mainnet.",
  },
};

export default function RoomLayout({ children }: { children: React.ReactNode }) {
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
      <RoomFooter />
    </div>
  );
}
