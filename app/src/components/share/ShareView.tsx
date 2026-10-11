"use client";

import Link from "next/link";
import { useState } from "react";
import type { Ticket } from "@/data";
import { Button, IconArrowLeft, IconX, Segmented, cx, useToast } from "@/design";
import { type CardStyle, postText } from "./card";
import s from "./Share.module.css";

export function ShareView({ ticket, siteUrl }: { ticket: Ticket; siteUrl: string }) {
  const [style, setStyle] = useState<CardStyle>("flare");
  const [loaded, setLoaded] = useState<Record<string, boolean>>({});
  const toast = useToast();
  const src = `/og/${ticket.id}?style=${style}`;
  const url = `${siteUrl.replace(/^https?:\/\//, "")}/c/${ticket.symbol}`;
  const text = postText(ticket, url);
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(`${siteUrl}/share/${ticket.id}`)}`;

  return (
    <div className="wrap">
      <div className={s.head}>
        <div>
          <Link href="/fumbles" className={s.back}>
            <IconArrowLeft width={16} height={16} /> My fumbles
          </Link>
          <h1 className={s.h1}>Share card</h1>
          <p className={s.lede}>1200 × 630, made for X. The ring is where you sold; the needle is where it went.</p>
        </div>
        <Segmented
          label="Card style"
          value={style}
          onChange={setStyle}
          items={[
            { value: "flare", label: "Flare" },
            { value: "paper", label: "Paper" },
            { value: "night", label: "Night" },
          ]}
        />
      </div>

      <div className={s.stage}>
        <div className={cx(s.frame, !loaded[style] && s.loading)}>
          {/* eslint-disable-next-line @next/next/no-img-element -- generated PNG from our own /og route */}
          <img
            key={style}
            src={src}
            width={1200}
            height={630}
            alt={`Share card: ${ticket.symbol} ticket at ${ticket.multiple.toFixed(1)}× of the sell price.`}
            className={s.img}
            onLoad={() => setLoaded((l) => ({ ...l, [style]: true }))}
          />
        </div>
      </div>

      <div className={s.tools}>
        <div className={s.btns}>
          <Button href={intent} target="_blank" rel="noreferrer" icon={<IconX />}>
            Post to X
          </Button>
          <Button variant="line" href={src} download={`fumpad-${ticket.symbol}-${ticket.multiple.toFixed(1)}x.png`}>
            Save image
          </Button>
          <Button
            variant="line"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(text);
                toast("Copied the post text.");
              } catch {
                toast("Copy blocked. Select the text below instead.");
              }
            }}
          >
            Copy text
          </Button>
        </div>
        <span className={s.fine}>The card links to the ticket on-chain, so anyone can check it.</span>
      </div>
      <p className={s.copy}>{text}</p>
    </div>
  );
}
