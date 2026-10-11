import type { Achievement, Profile } from "@/data";
import { Avatar, Badge, CopyButton, KV, LevelBar, Multiple, Sol, cx } from "@/design";
import * as f from "@/design/format";
import s from "./People.module.css";

function Glyph({ g }: { g: Achievement["glyph"] }) {
  return (
    <svg viewBox="0 0 28 28" aria-hidden="true" className={s.glyph}>
      {g === "ring" && <circle cx="9" cy="19" r="5" fill="none" stroke="currentColor" strokeWidth="2.4" />}
      {g === "ring-dot" && (
        <>
          <circle cx="9" cy="19" r="5" fill="none" stroke="currentColor" strokeWidth="2.4" />
          <circle cx="21" cy="8" r="5" fill="var(--flare)" />
        </>
      )}
      {g === "bar" && (
        <>
          <path d="M3 25h22" stroke="currentColor" strokeWidth="2" />
          <rect x="20" y="4" width="4" height="18" fill="var(--flare)" />
        </>
      )}
      {g === "queue" && (
        <>
          <rect x="3" y="12" width="6" height="6" fill="currentColor" />
          <rect x="11" y="12" width="6" height="6" fill="currentColor" opacity=".3" />
          <rect x="19" y="12" width="6" height="6" fill="currentColor" opacity=".3" />
        </>
      )}
      {g === "check" && <path d="M5 14l5 5 12-12" fill="none" stroke="currentColor" strokeWidth="2.4" />}
      {g === "down" && <path d="M3 6l11 16L25 6" fill="none" stroke="currentColor" strokeWidth="2" />}
    </svg>
  );
}

export function ProfileCard({ p, you, headingLevel = 2 }: { p: Profile; you?: boolean; headingLevel?: 1 | 2 }) {
  const H = headingLevel === 1 ? "h1" : "h2";
  return (
    <div className={s.prof}>
      <div className={s.hd}>
        <Avatar address={p.address} size="lg" />
        <div className={s.hdText}>
          <H className={s.name}>{p.name ?? f.shortAddr(p.address)}</H>
          <div className={s.addrRow}>
            <span className="num muted">{f.shortAddr(p.address)}</span>
            <CopyButton value={p.address} label="Copy address" />
          </div>
          <div className={s.badges}>
            <Badge tone="ink">Level {p.level}</Badge>
            {p.fumbleRank && <Badge>Rank {f.int(p.fumbleRank)} in fumbles</Badge>}
            {you && <Badge tone="muted">You</Badge>}
            {p.flagged && <Badge tone="muted">Flagged: linked wallets</Badge>}
          </div>
        </div>
      </div>

      <div className={s.lvl}>
        <div className={s.lvlRow}>
          <span>
            Level {p.level}, {p.levelTitle}
          </span>
          <span className="num muted">
            {f.int(p.xp)} / {f.int(p.xpNext)}
          </span>
        </div>
        <LevelBar value={p.xp} max={p.xpNext} label={`Progress to level ${p.level + 1}`} />
      </div>

      <KV
        className={s.kv}
        rows={[
          { k: "Tickets filed", v: <span className="num">{p.ticketsFiled}</span> },
          { k: "Crossed 10×", v: <span className="num">{p.crossed10x}</span> },
          { k: "Claimed, all time", v: <Sol value={p.claimedSol} /> },
          {
            k: "Worst fumble",
            v: p.worst ? (
              <span>
                <span className="ticker">${p.worst.symbol}</span>, <Multiple x={p.worst.multiple} />
              </span>
            ) : (
              <span className="muted">None yet</span>
            ),
          },
        ]}
      />

      <h3 className={s.achH}>Achievements</h3>
      <ul className={s.ach}>
        {p.achievements.map((a) => (
          <li key={a.id} className={cx(s.badge, !a.earned && s.locked)}>
            <Glyph g={a.glyph} />
            <b>{a.title}</b>
            <span>{a.detail}</span>
            {!a.earned && <span className="sr-only">Not earned yet</span>}
          </li>
        ))}
      </ul>
      {p.flagged && <p className={s.flag}>This wallet is linked to a coin creator by funding history. It can still claim, but it doesn&apos;t appear on leaderboards.</p>}
    </div>
  );
}
