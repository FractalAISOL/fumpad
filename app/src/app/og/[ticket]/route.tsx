import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { isAddress } from "@/components/coin/ident";
import { cardCopy, cardPalette, curveProgress, multipleText, parseStyle } from "@/components/share/card";
import { serverData } from "@/data/ssr";
import * as f from "@/design/format";
import { gauge as G } from "@/design/tokens";

/**
 * 1200×630 share card for X, rendered with next/og (Satori). Static TTF instances of
 * Archivo and Martian Mono live in src/assets/og (Satori can't read variable woff2).
 * GET /og/<ticket>?style=flare|paper|night. Every ticket state has its own card; orange only
 * appears on money states (claimable, queued, paid). The flare style is the grey canvas otherwise.
 * Fumi (anime kit, marketing/STYLE-ANIME.md) sits in the top-right corner as a small bust, above the figure and
 * clear of every number: holding a ticket on money cards, crying ("I fumbled") on the rest.
 */

const dir = join(process.cwd(), "src/assets/og");
const fonts = Promise.all([
  readFile(join(dir, "archivo-expanded-900.ttf")),
  readFile(join(dir, "archivo-500.ttf")),
  readFile(join(dir, "martian-condensed-600.ttf")),
  readFile(join(dir, "martian-semicondensed-400.ttf")),
]);

/**
 * Fumi's corner busts: the anime kit's head-normalised bust crop of public/fumi/<pose>-720.webp, pre-cut to 128 px
 * PNGs in src/assets/og (Satori/resvg can't draw WebP; ~25 KB each). Ticket on money cards, crying ("I fumbled") on
 * the rest. Read once; a missing file drops her, never the card.
 */
const BUST = 128;
const BUST_FILES = { ticket: join(dir, "fumi-ticket-bust.png"), crying: join(dir, "fumi-crying-bust.png") };
type CardPose = keyof typeof BUST_FILES;
const busts = new Map<CardPose, Promise<string | null>>();
function bustSrc(pose: CardPose): Promise<string | null> {
  let p = busts.get(pose);
  if (!p) {
    p = readFile(BUST_FILES[pose])
      .then((b) => `data:image/png;base64,${b.toString("base64")}`)
      .catch(() => null);
    busts.set(pose, p);
  }
  return p;
}

/** The big multiple shrinks with its length so "11.6×" and "<0.1×" fit beside the copy. */
const figureSize = (text: string) => (text.length <= 4 ? 176 : text.length === 5 ? 140 : 118);

/** Cards change when the ticket does (crossing, claim): an hour at the edge, served stale while it refreshes. */
const CARD_CACHE = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400";
/** Misses are cached briefly so a flood of made-up ids doesn't reach the API each time. */
const MISS_CACHE = "public, max-age=60, s-maxage=300";

export async function GET(req: Request, ctx: { params: Promise<{ ticket: string }> }) {
  const { ticket: id } = await ctx.params;
  // L-2: a ticket id is a base58 PDA; anything else never reaches the API.
  if (!isAddress(id)) return new Response("Invalid ticket id", { status: 400, headers: { "Cache-Control": MISS_CACHE, "Content-Type": "text/plain; charset=utf-8" } });
  const style = parseStyle(new URL(req.url).searchParams.get("style"));
  const data = serverData();
  const [t, params] = await Promise.all([data.getTicket(id), data.getParams()]);
  if (!t) return new Response("Ticket not found", { status: 404, headers: { "Cache-Control": MISS_CACHE, "Content-Type": "text/plain; charset=utf-8" } });
  const copy = cardCopy(t, params);
  // Curve cards show how far the coin is from graduating.
  const progress = copy.kind === "curve" ? curveProgress(await data.getCoin(t.mint).catch(() => null)) : undefined;
  const [wide, body, monoBig, mono] = await fonts;
  const fumi = await bustSrc(copy.money ? "ticket" : "crying");
  const c = cardPalette(style, copy.money);
  const name = t.owner.slice(0, 4) + "…" + t.owner.slice(-4);
  const pos = f.gaugePos(copy.figure) * 100;
  // Closed tickets draw the needle and fill in the secondary tone; money in the accent.
  const needle = copy.muted ? c.sub : copy.money ? c.accent : c.fg;
  const W = 1200 - 124;

  return new ImageResponse(
    <div
      style={{
        width: 1200,
        height: 630,
        display: "flex",
        flexDirection: "column",
        background: c.bg,
        color: c.fg,
        padding: "60px 62px 52px",
        fontFamily: "Archivo",
        position: "relative",
      }}
    >
      {/* Fumi: corner bust, under the coin link and above the figure (the figure and the copy stay clear of her). */}
      {fumi && (
        <div
          style={{
            position: "absolute",
            right: 62,
            top: 112,
            width: BUST + 4,
            height: BUST + 4,
            display: "flex",
            overflow: "hidden",
            borderRadius: 18,
            border: `2px solid ${c.line}`,
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text -- Satori renders this to a PNG */}
          <img src={fumi} width={BUST} height={BUST} />
        </div>
      )}
      {/* top */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <svg width="40" height="40" viewBox="0 0 32 32">
            <rect width="32" height="32" rx="5" fill={c.fg} />
            <circle cx="9" cy="22.5" r="3.6" fill="none" stroke={c.bg} strokeWidth="2.4" />
            <path d="M12.2 20.6 L21.5 11" stroke={c.bg} strokeWidth="1.6" strokeDasharray="1.6 2" />
            <circle cx="23.5" cy="9" r="4.4" fill={copy.money && style !== "flare" ? c.post : c.bg} />
          </svg>
          <span style={{ fontFamily: "ArchivoWide", fontSize: 30, letterSpacing: "-0.04em" }}>FUMPAD</span>
        </div>
        {/* H-3: the coin by mint (symbols aren't unique); the last eight characters are what tell coins apart. */}
        <span style={{ display: "flex", fontFamily: "Mono", fontSize: 18, color: c.sub }}>
          fumpad.app/c/{t.mint.slice(0, 4)}…<span style={{ color: c.fg }}>{t.mint.slice(-8)}</span>
        </span>
      </div>

      {/* middle */}
      <div style={{ display: "flex", flex: 1, alignItems: "flex-end", justifyContent: "space-between", gap: 36, paddingBottom: 36 }}>
        <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, maxWidth: 640 }}>
          <div style={{ fontFamily: "ArchivoWide", fontSize: copy.head.length > 14 ? 60 : 72, lineHeight: 0.92, letterSpacing: "-0.05em" }}>{copy.head}</div>
          <div style={{ marginTop: 18, fontSize: 28, lineHeight: 1.2, color: c.fg }}>{copy.kicker}</div>
          <div style={{ marginTop: 10, fontSize: 21, lineHeight: 1.32, color: c.sub }}>{copy.body}</div>
          {progress !== undefined && (
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 18 }}>
              <div style={{ display: "flex", position: "relative", width: 300, height: 8, background: c.line, borderRadius: 4 }}>
                <div style={{ position: "absolute", left: 0, top: 0, height: 8, width: Math.max(4, 300 * progress), background: c.fg, borderRadius: 4 }} />
              </div>
              <span style={{ fontFamily: "Mono", fontSize: 17, color: c.sub }}>curve {Math.floor(progress * 100)}% to graduation</span>
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0 }}>
          <div
            style={{
              fontFamily: "Martian",
              fontSize: figureSize(multipleText(copy.figure)),
              lineHeight: 0.8,
              letterSpacing: "-0.07em",
              color: copy.muted ? c.sub : copy.money ? c.accent : c.fg,
            }}
          >
            {multipleText(copy.figure)}
          </div>
          <div style={{ display: "flex", marginTop: 14, fontSize: 18, color: c.sub }}>{copy.figureNote}</div>
        </div>
      </div>

      {/* ruler */}
      <div style={{ display: "flex", position: "relative", height: 64, borderTop: `2px solid ${copy.muted ? c.sub : c.fg}` }}>
        {G.ticks.map((v) => (
          <div
            key={v}
            style={{
              position: "absolute",
              left: f.gaugePos(v) * W - (v === 10 ? 2 : 1),
              top: 0,
              width: v === 10 ? 5 : (G.major as readonly number[]).includes(v) ? 2 : 1.5,
              height: v === 10 ? 26 : (G.major as readonly number[]).includes(v) ? 22 : 13,
              background: v === 10 ? c.post : copy.muted ? c.sub : c.fg,
            }}
          />
        ))}
        {G.major.map((v) => (
          <span
            key={v}
            style={{
              position: "absolute",
              top: 34,
              left: Math.min(W - 40, Math.max(0, f.gaugePos(v) * W - 14)),
              fontFamily: "Mono",
              fontSize: 15,
              color: c.sub,
            }}
          >
            {v}×
          </span>
        ))}
        <div style={{ position: "absolute", left: 0, top: -7, height: 11, width: (pos / 100) * W, background: needle }} />
        <div style={{ position: "absolute", left: -14, top: -16, width: 29, height: 29, borderRadius: 15, border: `5px solid ${c.fg}`, background: c.bg }} />
        <div style={{ position: "absolute", left: (pos / 100) * W - 3, top: -29, width: 6, height: 50, background: needle }} />
      </div>

      {/* foot */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 17, color: c.sub }}>
        <span style={{ display: "flex", gap: 10 }}>
          <span style={{ color: c.fg }}>{name}</span>
          <span>
            sold {f.date(t.sellTs)}, {f.int(t.originalTokens)} {t.symbol}
          </span>
        </span>
        <span style={{ display: "flex" }}>{copy.foot}</span>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: "ArchivoWide", data: wide, weight: 900, style: "normal" },
        { name: "Archivo", data: body, weight: 500, style: "normal" },
        { name: "Martian", data: monoBig, weight: 600, style: "normal" },
        { name: "Mono", data: mono, weight: 400, style: "normal" },
      ],
      headers: { "Cache-Control": CARD_CACHE },
    },
  );
}
