"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { IconCoins, IconFeed, IconFumbles, IconMoon, IconPlus, IconRanks, IconSun, IconSystem, Mark, Wordmark, cx } from "@/design";
import { DEMO_NAME } from "@/data";
import { useViewer } from "./Providers";
import s from "./Shell.module.css";
import { WalletButton } from "./Wallet";

/**
 * `self` is the viewer's own profile path. A profile page highlights "My fumbles" when it is
 * the viewer's own wallet and nothing otherwise (it isn't part of the leaderboard).
 */
const NAV = [
  { href: "/", label: "Feed", icon: IconFeed, match: (p: string) => p === "/" },
  { href: "/launches", label: "Launches", short: "Launches", icon: IconCoins, match: (p: string) => p.startsWith("/launches") || p.startsWith("/coin/") },
  {
    href: "/fumbles",
    label: "My fumbles",
    short: "Fumbles",
    icon: IconFumbles,
    match: (p: string, self: string) => p.startsWith("/fumbles") || p.startsWith("/share") || p === self,
  },
  { href: "/leaderboard", label: "Leaderboard", short: "Ranks", icon: IconRanks, match: (p: string) => p.startsWith("/leaderboard") },
];

/** The pathname with an encoded profile segment decoded, and the viewer's own profile path. */
function useNavPath(): [string, string] {
  const path = usePathname();
  const { address, isDemo } = useViewer();
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    /* malformed: compare raw */
  }
  const clean = p.replace(/\/+$/, "") || "/";
  // The demo profile is also reachable by its name.
  return [isDemo && clean === `/u/${DEMO_NAME}` ? `/u/${address}` : clean, `/u/${address}`];
}

export function Header({ solUsd }: { solUsd: number }) {
  const [path, self] = useNavPath();
  const { claimable } = useViewer();
  return (
    <header className={s.top}>
      <a href="#main" className={s.skip}>
        Skip to content
      </a>
      <div className={cx("wrap", s.topIn)}>
        <Link href="/" className={s.brand} aria-label="FUMPAD home">
          <Mark size={28} />
          <Wordmark />
        </Link>
        <nav className={s.nav} aria-label="Main">
          {NAV.map((n) => {
            const on = n.match(path, self);
            return (
              <Link key={n.href} href={n.href} className={s.navLink} aria-current={on ? "page" : undefined}>
                {n.label}
                {n.href === "/fumbles" && claimable > 0 && (
                  <span className={cx("num", s.count)} aria-label={`${claimable} claimable`}>
                    {claimable}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className={s.right}>
          <span className={cx("num", s.sol)}>SOL ${solUsd.toFixed(2)}</span>
          <ThemeToggle />
          <Link href="/launch" className={s.launch}>
            <IconPlus width={16} height={16} />
            <span className={s.launchText}>Launch a coin</span>
          </Link>
          <WalletButton />
        </div>
      </div>
    </header>
  );
}

export function TabBar() {
  const [path, self] = useNavPath();
  const { claimable } = useViewer();
  return (
    <nav className={s.tabbar} aria-label="Main">
      {NAV.map((n) => {
        const on = n.match(path, self);
        const Icon = n.icon;
        return (
          <Link key={n.href} href={n.href} className={s.tab} aria-current={on ? "page" : undefined}>
            <Icon />
            {n.short ?? n.label}
            {n.href === "/fumbles" && claimable > 0 && <span className={s.dot} aria-label={`${claimable} claimable`} />}
          </Link>
        );
      })}
    </nav>
  );
}

type Mode = "system" | "light" | "dark";
const MODES: Mode[] = ["system", "light", "dark"];
const KEY = "fumpad-theme";

/** Inline, pre-paint: applies the saved theme before the first frame (no flash). */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("system");
  useEffect(() => {
    let m: Mode = "system";
    try {
      const v = localStorage.getItem(KEY);
      if (v === "light" || v === "dark") m = v;
    } catch {}
    // Sync with what the pre-paint script applied.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(m);
  }, []);
  const next = () => {
    const m = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
    setMode(m);
    try {
      if (m === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, m);
    } catch {}
    if (m === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", m);
  };
  const Icon = mode === "light" ? IconSun : mode === "dark" ? IconMoon : IconSystem;
  return (
    <button type="button" className={s.theme} onClick={next} aria-label={`Theme: ${mode}. Switch theme`} title={`Theme: ${mode}`}>
      <Icon />
    </button>
  );
}
