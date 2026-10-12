import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { Providers } from "@/components/shell/Providers";
import { Header, TabBar, THEME_SCRIPT } from "@/components/shell/Shell";
import { shellSnapshot } from "@/data/server";
import { archivo, martian } from "@/design/fonts";
import { colorDark, colorLight, tokensToCss } from "@/design/tokens";
import "./globals.css";
import s from "./layout.module.css";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://fumpad.app"),
  title: { default: "FUMPAD", template: "%s | FUMPAD" },
  description: "The Solana launchpad that pays you back when you sell too early. Sell, and if the coin later holds 10× your price, claim 10% of what you sold.",
  applicationName: "FUMPAD",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: colorLight.canvas },
    { media: "(prefers-color-scheme: dark)", color: colorDark.canvas },
  ],
};

const TOKENS_CSS = tokensToCss();

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Cached (data/server.ts) so the shell stays prerenderable against the live API.
  const { solUsd, now, params } = await shellSnapshot();
  return (
    <html lang="en" className={`${archivo.variable} ${martian.variable}`} suppressHydrationWarning>
      <head>
        <Script id="theme" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>
        <style dangerouslySetInnerHTML={{ __html: TOKENS_CSS }} />
      </head>
      <body>
        <Providers now={now} params={params}>
          <Header solUsd={solUsd} />
          <main id="main" className={s.main}>
            {children}
          </main>
          <TabBar />
        </Providers>
      </body>
    </html>
  );
}
