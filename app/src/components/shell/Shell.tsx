"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { type SVGProps, useEffect, useRef, useState } from "react";
import { IconCoins, IconFeed, IconFumbles, IconMoon, IconPlus, IconRanks, IconSearch, IconSun, IconSystem, IconUser, Mark, Wordmark, cx } from "@/design";
import { useViewer } from "./Providers";
import s from "./Shell.module.css";
import { THEME_KEY, THEME_SCRIPT } from "./theme";
import { WalletButton, requestWalletConnect } from "./Wallet";

/**
 * Main sections. "Profile" is the connected wallet's own `/u/<address>`: active there and
 * nowhere else, so another wallet's profile highlights nothing. Without a wallet it stays in
 * place (the bar doesn't reflow when autoConnect lands) and opens the connect dialog, like the
 * wallet button, then goes to the profile once connected.
 */
type NavItem = { href: string; label: string; short?: string; icon: (p: SVGProps<SVGSVGElement>) => React.ReactNode; match: (p: string) => boolean; desktopOnly?: boolean };
const NAV: NavItem[] = [
  { href: "/", label: "Feed", icon: IconFeed, match: (p) => p === "/" },
  { href: "/launches", label: "Launches", icon: IconCoins, match: (p) => p.startsWith("/launches") || p.startsWith("/coin/") },
  { href: "/fumbles", label: "My fumbles", short: "Fumbles", icon: IconFumbles, match: (p) => p === "/fumbles" },
  { href: "/checker", label: "Checker", icon: IconSearch, match: (p) => p.startsWith("/checker"), desktopOnly: true },
  { href: "/leaderboard", label: "Leaderboard", short: "Ranks", icon: IconRanks, match: (p) => p.startsWith("/leaderboard") },
];

/** The pathname with an encoded profile segment decoded and trailing slashes dropped. */
function useNavPath(): string {
  const path = usePathname();
  let p = path;
  try {
    p = decodeURIComponent(path);
  } catch {
    /* malformed: compare raw */
  }
  return p.replace(/\/+$/, "") || "/";
}

/**
 * The Profile item's state: where it goes when connected, whether it's the current page, and
 * the connect-then-go handler when no wallet is connected.
 */
function useProfileNav(path: string) {
  const { address, connected } = useViewer();
  const router = useRouter();
  const href = connected ? `/u/${address}` : undefined;
  // When "Profile" asked for the connection (ms), so a connect made much later through the
  // wallet button doesn't jump to the profile.
  const asked = useRef(0);
  useEffect(() => {
    if (!href || !asked.current) return;
    const recent = Date.now() - asked.current < 120_000;
    asked.current = 0;
    if (recent) router.push(href);
  }, [href, router]);
  return {
    href,
    on: !!href && path === href,
    connect: () => {
      asked.current = Date.now();
      requestWalletConnect();
    },
  };
}

export function Header({ solUsd }: { solUsd: number }) {
  const path = useNavPath();
  const profile = useProfileNav(path);
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
            const on = n.match(path);
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
          {profile.href ? (
            <Link href={profile.href} className={s.navLink} aria-current={profile.on ? "page" : undefined}>
              Profile
            </Link>
          ) : (
            <button type="button" className={s.navLink} onClick={profile.connect} aria-haspopup="dialog" title="Connect a wallet to see your profile">
              Profile
            </button>
          )}
        </nav>
        <div className={s.right}>
          <span className={cx("num", s.sol)}>SOL ${solUsd.toFixed(2)}</span>
          <ThemeToggle />
          <Link href="/launch" className={s.launch} aria-label="Launch a coin">
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
  const path = useNavPath();
  const profile = useProfileNav(path);
  const { claimable } = useViewer();
  return (
    <nav className={s.tabbar} aria-label="Main">
      {NAV.filter((n) => !n.desktopOnly).map((n) => {
        const on = n.match(path);
        const Icon = n.icon;
        return (
          <Link key={n.href} href={n.href} className={s.tab} aria-current={on ? "page" : undefined}>
            <Icon />
            {n.short ?? n.label}
            {n.href === "/fumbles" && claimable > 0 && <span className={s.dot} aria-label={`${claimable} claimable`} />}
          </Link>
        );
      })}
      {profile.href ? (
        <Link href={profile.href} className={s.tab} aria-current={profile.on ? "page" : undefined}>
          <IconUser />
          Profile
        </Link>
      ) : (
        <button type="button" className={s.tab} onClick={profile.connect} aria-haspopup="dialog">
          <IconUser />
          Profile
        </button>
      )}
    </nav>
  );
}

type Mode = "system" | "light" | "dark";
const MODES: Mode[] = ["system", "light", "dark"];
const KEY = THEME_KEY;
export { THEME_SCRIPT };

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
