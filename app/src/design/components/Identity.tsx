"use client";

import Link from "next/link";
import { useState } from "react";
import { cx } from "../cx";
import { safeImageSrc } from "../image";
import { shortAddr } from "../format";
import { IconCheck, IconCopy } from "./Icons";
import s from "./Identity.module.css";

/* ── Coin tile ────────────────────────────────────────────────────────────── */

/**
 * Monogram tile in Archivo at its narrowest width. Three styles, assigned per coin,
 * so a feed of black squares still reads as different coins.
 */
export function CoinTile({
  symbol,
  variant = 0,
  size = "md",
  imageUrl,
  localPreview,
  className,
}: {
  symbol: string;
  variant?: 0 | 1 | 2;
  size?: "sm" | "md" | "lg" | "xl";
  /** Creator-supplied (coin metadata): only https / ipfs:// / ar:// render (L-1, `../image.ts`). */
  imageUrl?: string;
  /** The launch form's own `blob:` preview of the file being uploaded. */
  localPreview?: boolean;
  className?: string;
}) {
  const src = safeImageSrc(imageUrl, { allowBlob: localPreview });
  const [failed, setFailed] = useState<string | null>(null);
  return (
    <span className={cx(s.tile, s[`t${variant}`], s[size], className)} aria-hidden="true">
      {src && failed !== src ? (
        // eslint-disable-next-line @next/next/no-img-element -- third-party URL, no optimizer proxy; no referrer leaves the page
        <img src={src} alt="" className={s.tileImg} referrerPolicy="no-referrer" loading="lazy" decoding="async" onError={() => setFailed(src)} />
      ) : (
        symbol.slice(0, 2)
      )}
    </span>
  );
}

/* ── Avatar (identicon) ───────────────────────────────────────────────────── */

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Mirrored 5×5 identicon from the wallet address. Ink on paper; no colour. */
export function Avatar({ address, size = "md", className }: { address: string; size?: "sm" | "md" | "lg"; className?: string }) {
  let h = hash(address);
  const cells: [number, number][] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
      if (h % 2 === 0) {
        cells.push([x, y]);
        if (x < 2) cells.push([4 - x, y]);
      }
    }
  }
  return (
    <span className={cx(s.av, s[`a${size}`], className)} aria-hidden="true">
      <svg viewBox="0 0 20 20" fill="currentColor">
        {cells.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x * 4} y={y * 4} width="4" height="4" />
        ))}
      </svg>
    </span>
  );
}

/* ── Address ──────────────────────────────────────────────────────────────── */

/**
 * A wallet: identicon + name (or short address), linking to the profile. `copy` adds a
 * copy-to-clipboard button for the full address.
 */
export function Address({
  address,
  name,
  you,
  link = true,
  copy,
  avatar = true,
  size = "sm",
  className,
}: {
  address: string;
  name?: string;
  you?: boolean;
  link?: boolean;
  copy?: boolean;
  avatar?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const label = name ?? shortAddr(address);
  const body = (
    <>
      {avatar && <Avatar address={address} size={size === "md" ? "md" : "sm"} />}
      <span className={cx(s.name, !name && "num")}>{label}</span>
      {you && <span className={s.you}>you</span>}
    </>
  );
  return (
    <span className={cx(s.addr, className)}>
      {link ? (
        <Link href={`/u/${address}`} className={s.link} title={address}>
          {body}
        </Link>
      ) : (
        <span className={s.link} title={address}>
          {body}
        </span>
      )}
      {copy && <CopyButton value={address} label="Copy address" />}
    </span>
  );
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={s.copy}
      aria-label={done ? "Copied" : label}
      title={done ? "Copied" : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1400);
        } catch {
          /* clipboard blocked: the full value is in the title attribute */
        }
      }}
    >
      {done ? <IconCheck /> : <IconCopy />}
    </button>
  );
}
