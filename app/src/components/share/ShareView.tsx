"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { Ticket } from "@/data";
import { Button, IconArrowLeft, IconCopy, IconDownload, IconX, Segmented, cx, useToast } from "@/design";
import { useViewer } from "../shell/Providers";
import { type CardStyle, cardCopy, loudLabel, ogSrc, postText } from "./card";
import s from "./Share.module.css";
import { coinHref } from "@/components/coin/ident";

export function ShareView({ ticket, siteUrl }: { ticket: Ticket; siteUrl: string }) {
  const [style, setStyle] = useState<CardStyle>("flare");
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const toast = useToast();
  // The PNG can finish before hydration attaches onLoad; catch that case on mount.
  const img = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = img.current;
    if (el?.complete && el.naturalWidth) setLoaded((l) => (l[style] ? l : { ...l, [style]: true }));
  }, [style]);
  const { address } = useViewer();
  const own = ticket.owner === address;
  const copy = cardCopy(ticket);
  const src = ogSrc(ticket, style);
  const link = `${siteUrl}/share/${ticket.id}`;
  const text = postText(ticket, own);
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast("Copied the link.");
    } catch {
      toast("Copy blocked. Copy the address bar instead.");
    }
  };

  return (
    <div className="wrap">
      <div className={s.head}>
        <div>
          {own ? (
            <Link href="/fumbles" className={s.back}>
              <IconArrowLeft width={16} height={16} /> My fumbles
            </Link>
          ) : (
            <Link href={`/u/${ticket.owner}`} className={s.back}>
              <IconArrowLeft width={16} height={16} /> Wallet profile
            </Link>
          )}
          <h1 className={s.h1}>Share card</h1>
          <p className={s.lede}>
            1200 × 630, made for X. The ring is where it was sold; the needle is where it went.{" "}
            <Link href={coinHref(ticket)} className={s.coin}>
              View ${ticket.symbol}
            </Link>
          </p>
        </div>
        <Segmented
          label="Card style"
          value={style}
          onChange={setStyle}
          items={[
            { value: "flare", label: loudLabel(copy.money) },
            { value: "paper", label: "Paper" },
            { value: "night", label: "Night" },
          ]}
        />
      </div>

      <div className={s.stage}>
        <Link href={coinHref(ticket)} className={cx(s.frame, !loaded[style] && s.loading)} aria-label={`$${ticket.symbol} coin page`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- generated PNG from our own /og route */}
          <img
            key={style}
            ref={img}
            src={src}
            width={1200}
            height={630}
            alt={`Share card for a $${ticket.symbol} ticket: ${copy.head} ${copy.kicker}`}
            className={s.img}
            onLoad={() => setLoaded((l) => ({ ...l, [style]: true }))}
          />
        </Link>
      </div>

      <div className={s.tools}>
        <div className={s.btns}>
          <Button href={intent} target="_blank" rel="noreferrer" icon={<IconX />}>
            Post to X
          </Button>
          <Button variant="line" icon={<IconCopy />} onClick={copyLink}>
            Copy link
          </Button>
          <Button variant="line" icon={<IconDownload />} href={src} download={`fumpad-${ticket.symbol}-${ticket.state}-${style}.png`}>
            Save PNG
          </Button>
        </div>
        <span className={s.fine}>The link opens this card with the ticket&apos;s live state; the card links to ${ticket.symbol}.</span>
      </div>
      <p className={s.copy}>{text}</p>
    </div>
  );
}
