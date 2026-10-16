import Link from "next/link";
import { CLUSTER, CLUSTER_LABEL, FUMPAD_PROGRAM_ADDRESS, solscanAccount } from "@/chain/cluster";
import { Badge, IconExternal, IconX, Mark, Wordmark } from "@/design";
import { StatusDot } from "../status/StatusDot";
import { FooterSignoff } from "./FooterSignoff";
import s from "./Footer.module.css";

const CLUSTER_NAME = CLUSTER_LABEL ?? "Mainnet";
const SOLSCAN = solscanAccount(FUMPAD_PROGRAM_ADDRESS);

/** Only an http(s) URL is ever linked; anything else hides the X link. */
function xUrl(): string | undefined {
  const raw = process.env.NEXT_PUBLIC_X_URL?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

const GROUPS: { title: string; links: { href: string; label: string }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/launches", label: "Launches" },
      { href: "/fumbles", label: "My fumbles" },
      { href: "/leaderboard", label: "Leaderboard" },
      { href: "/launch", label: "Launch a coin" },
    ],
  },
  {
    title: "Learn",
    links: [
      { href: "/how-it-works", label: "How it works" },
      { href: "/how-it-works#verify", label: "Sells on any app" },
      { href: "/how-it-works#fees", label: "Fees & rewards" },
      { href: "/how-it-works#snipe", label: "Snipe protection" },
      { href: "/how-it-works#faq", label: "FAQ" },
    ],
  },
  {
    title: "Legal",
    links: [
      { href: "/terms", label: "Terms" },
      { href: "/risk", label: "Risk disclosure" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
];

export function Footer() {
  const x = xUrl();
  const network = CLUSTER === "mainnet" ? "Solana" : `Solana ${CLUSTER}`;
  return (
    <footer className={s.foot}>
      <div className={`wrap ${s.inner}`}>
        <div className={s.brand}>
          <Link href="/" className={s.brandLink} aria-label="FUMPAD home">
            <Mark size={24} />
            <Wordmark />
          </Link>
          <p className={s.tagline}>The launchpad for people who sell too early.</p>
          <FooterSignoff />
        </div>

        {GROUPS.map((g) => (
          <nav key={g.title} className={s.group} aria-label={g.title}>
            <h2 className={s.title}>{g.title}</h2>
            <ul>
              {g.links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} prefetch={false}>
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}

        <nav className={s.group} aria-label="Elsewhere">
          <h2 className={s.title}>Elsewhere</h2>
          <ul>
            {x && (
              <li>
                <a href={x} target="_blank" rel="noopener noreferrer">
                  <IconX width={14} height={14} aria-hidden="true" />
                  X<span className="sr-only"> (opens in a new tab)</span>
                </a>
              </li>
            )}
            <li>
              <a href={SOLSCAN} target="_blank" rel="noopener noreferrer">
                Program on Solscan
                <IconExternal width={12} height={12} aria-hidden="true" className={s.ext} />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            </li>
            <li>
              <StatusDot />
            </li>
            <li className={s.status}>
              <Badge dot tone={CLUSTER === "mainnet" ? "neutral" : "muted"}>
                {CLUSTER_NAME}
              </Badge>
            </li>
          </ul>
        </nav>

        <div className={s.base}>
          <p className={s.disclaimer}>
            FUMPAD is experimental software running on {network}. Coins trade on Meteora&apos;s pools, which FUMPAD doesn&apos;t control. Fumble rewards are
            not insurance and are not guaranteed: payouts depend on each coin&apos;s reward pool. Nothing here is financial advice.
          </p>
          <p className={s.copy}>© 2026 FUMPAD</p>
        </div>
      </div>
    </footer>
  );
}
