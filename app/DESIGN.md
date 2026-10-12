# FUMPAD design system

Direction C, "Signal" (`design/direction-c-signal/`), built for production. Everything is calm, grey and measured, so the one thing that isn't, your fumble turning into money, hits hard. Live reference: `/design` renders every component in every state, light and dark side by side.

## Principles

1. **One signal.** International Orange (`--flare`) means money: a 10× crossing, a claim, a payout, the claim queue fitting. It is never decoration, never a brand wash, never price direction. If something orange doesn't involve money, it's a bug, with no exceptions: the keyboard focus ring is ink (`--focus`, black on light, near-white on dark), not orange.
2. **The gauge is the brand.** The log ruler from 1× to 30×, hatched past 10×, appears wherever a ticket appears: feed embeds, coin tables, My Fumbles, the claim moment, the share card. The mark (ring, dotted run, orange dot) is the same chart in miniature.
3. **Instrument, not casino.** Hairline rules carry structure; panels are flat paper on instrument grey; shadows only float overlays. Numbers are Martian Mono with tabular figures so columns line up like a readout.
4. **Serious UI, funny copy.** The interface never jokes in its layout. The humour lives in sentences, and only where nobody needs to act.
5. **Explain the money in one sentence.** Every number that affects a payout (ticket price, floor, queue position, rebuy debit, expiry) has a plain sentence next to it. Tooltips add detail; they never hold the only explanation.

## Stack choices

| Choice | Why |
|---|---|
| Next.js 16 App Router, TS strict, npm | Server components render pages from the data layer; Cache Components prerender every coin, share and profile shell; dynamic segments stream behind Suspense skeletons with the same geometry (no layout shift). npm because pnpm isn't installed. |
| CSS custom properties + CSS Modules | Tokens are generated from one TypeScript file into CSS variables, so a theme switch is one attribute and no re-render. Modules keep component CSS co-located with zero runtime. Tailwind would duplicate the token layer in class names; vanilla-extract adds a build step for little gain here. |
| Hand-rolled SVG chart | The chart's job is FUMPAD-specific marks (your sell ring, the 10× line and zone, the crossing tick, other fumbles), in our type and tokens, on a log axis so 10× is always the same distance. That's ~250 lines of SVG. lightweight-charts would add ~45 KB of canvas we would have to fight to draw those marks. Swap to it if candles and volume become requirements. |
| Native `<dialog>` | Focus trap, Escape, inert background and top layer for free. Becomes a bottom sheet under 600 px. |
| next/font (Google) | Archivo and Martian Mono self-hosted with their width axes, `display: swap`, size-adjusted fallbacks. |
| next/og | Share card is a real 1200×630 PNG at `/og/<ticket>?style=flare|paper|night`. Satori can't read variable woff2, so static TTF instances live in `src/assets/og/` (OFL). |
| Wallet Standard via `@solana/wallet-adapter-react` | Phantom, Solflare and Backpack are detected without bundling adapters. Connect UI is ours. Transactions are typed stubs in `src/chain/tx.ts`. |

## Tokens — `src/design/tokens.ts`

Single source of truth. `tokensToCss()` renders it to `:root` variables inlined by the root layout; the OG image and the claim moment import raw values from the same file. `@media` queries can't read variables, so breakpoints (600 / 760 / 900 / 1000) are repeated literally; search for the number when changing one.

| Group | Variables | Notes |
|---|---|---|
| Colour | `--canvas --surface --sunken --ink --ink-2 --ink-3 --rule --rule-2 --on-ink --flare --flare-soft --flare-text --on-flare --hatch --scrim --focus` | Light first. Dark is pure black (`#000`), not tinted. `--flare-text` is orange at text size (5.6:1 on paper). `.theme-light` / `.theme-dark` scope a theme to a subtree. |
| Type | `--f-sans --f-num`, `--fs-{2xs…3xl,display}` + `--lh-*`, `--w-{regular…black}`, `--wdth-{display 125, title 118, ticker 108, body 100, tile 62, num 85, readout 75}`, `--tr-*` | Hierarchy comes from Archivo's width axis as much as size. Body 15/22. |
| Space | `--s-{0…16}` | 4 px base. |
| Radius | `--r-1` 3 px tiles and tags, `--r-2` 6 px controls, `--r-3` 12 px panels, `--r-pill` | Three radii only, by hierarchy. |
| Motion | `--dur-{instant 80, fast 120, base 200, slow 350, gauge 1100, curve 1400}`, `--ease-{out, inOut, stamp}` | Reduced motion collapses durations to 1 ms. |
| Layer | `--z-{base, raised, sticky, tabbar, sheet, moment, toast, tooltip}` | |
| Layout | `--max-w 1320`, `--gut 16/32`, `--header-h 58`, `--tabbar-h 60` | |

## Price direction without red and green

Signal bans red/green; traders still need up/down at a glance. FUMPAD encodes direction three ways at once, none of them hue:

- **Glyph:** ▲ up, ▼ down, – flat. The glyph is the sign; it survives greyscale, colour blindness and screenshots.
- **Weight and tone:** up is ink at medium weight; down is graphite (`--ink-3`) at regular weight. Down reads quieter, not alarming, which is also the product's attitude to losses.
- **Words for assistive tech:** `<Change>` speaks "up 38.2 percent" / "down 6.3 percent".

Sparklines follow the same rule (ink if the period closed up, graphite if down). If candles are ever added: hollow ink for up, filled graphite for down (the old hollow-candle convention). Orange is never used for direction, so "orange = money" stays unambiguous: a coin up 60% is not orange; a ticket at 10.1× is.

## Components — `src/design/components/`

| Component | States |
|---|---|
| `Button` / `IconButton` | ink, line, flare (money only), ghost, quiet × sm/md/lg; icon, disabled, loading (three dots), press (1 px down). Renders a Link when given `href`. |
| `TextInput`, `TextArea`, `Field` | hint, optional, error (hatched field + ✕ message, `aria-invalid`), disabled, prefix/suffix. |
| `AmountInput` | Martian Mono figure, unit, balance, 25/50/75% + Max, over-balance error announced politely. |
| `Tabs` | ARIA tablist with arrow/Home/End roving focus; pair with `tabPanelId`. |
| `Segmented`, `Chips` | radiogroups with roving focus; counts; block (full width) variant. |
| `Table` | sortable headers (`aria-sort`), dense rows, tabular numbers, `hideBelow` per column for 375 px, row links, "you" row tint, empty state. |
| `Badge` | neutral, ink, flare, flare-line (+ pulsing dot), muted. |
| `Tooltip`, `InfoTip` | hover, focus, tap; Escape closes; portal with edge clamping. |
| `Dialog` | native modal; bottom sheet under 600 px; title, description, footer actions. |
| `ToastProvider` / `useToast` | one at a time, `role=status`; `money` tone in flare for payouts. |
| `Skeleton`, `Loading` | shimmer blocks; one `role=status` per region. |
| `EmptyState` | mark glyph, title, one sentence, action. |
| `Price`, `Sol`, `Usd`, `Tokens`, `Multiple`, `Change`, `Pct`, `Int` | subscript-zero prices (`0.0₅94`) with spoken long form; compact tokens; multiples turn orange at ≥ 10×. |
| `Address`, `Avatar`, `CopyButton`, `CoinTile` | identicon, name or short address, "you" tag, copy; tile monograms in three styles at Archivo width 62. |
| `Gauge` | log 1×–30×, hatched past 10×, ink fill then orange; `dead` (expired); md, mini, lg; sweeps in on mount; container-queried labels; `role=meter` with spoken value. |
| `PriceChart`, `Sparkline` | log axis, your-sell ring, 10× line and zone, crossing tick, other fumbles, crosshair by pointer or arrow keys, summary label. |
| `CurveMeter`, `PoolMeter`, `LevelBar`, `SplitBar` | curve to 85 SOL with orange graduation post; pool vs queue with hatched shortfall; XP; fee split. |
| `TicketCard` | claimable, queued, tracking, waiting for graduation, rebuy-reduced (note), claimed, expired, voided. Lays out by its own width (container query). |
| `Mark`, `Wordmark` | the chart-as-logo; Archivo 850 at width 125. |

Feature pieces built on these: `ClaimMoment` (the cinematic unlock), `TradePanel` (ticket preview with the D10/D12 floor), `FeedPost`, `ProfileCard`, the share card renderer.

## Motion rules

- **One loud moment.** The claim unlock: letterbox bars, needle sweep on a log ease, hard cut to orange at 10×, title wipe, amount count-up, PAID stamp with the only overshoot easing in the system. No confetti.
- **Everything else answers an action.** Gauges sweep once on mount (that is the data arriving), dialogs rise, the sheet slides up, buttons press 1 px. New live posts get a one-time grey fade; if you've scrolled down they wait behind "Show N new posts" so the page never moves under your thumb.
- **Durations:** 80–200 ms for controls, 350 ms for overlays, 1.1 s for instruments. Ease: `--ease-out` (fast out, long settle).
- **Reduced motion:** all durations collapse; the claim moment jumps to its final frame; smooth scroll becomes instant.

## Copy voice

Dry, exact, a little sorry for you. Sentence case, plain verbs, numbers in full where money is involved.

- Buttons say what happens: "Sell and file a ticket", "Claim 420,000", "Launch $PIGN". The toast echoes the verb: "Claimed 420,000 MIDC."
- The joke goes where nobody needs to act: "Sold too early. Officially.", "Later. It might go higher.", "Your wallet is clean, which is rarer than a 10×."
- Errors say what happened and what to do, never apologise: "Tokens need 10 minutes in your wallet before a sell counts. This sell goes through without a ticket."
- Explain the floor in one breath: "Priced at your fill. The recent-average floor is below it, so it doesn't apply." / "The price dropped in the last 10 minutes, so the ticket uses the recent-average floor instead. It errs higher, never lower."
- Empty screens invite: "Sell $50 or more of any coin through FUMPAD and the ticket shows up here."

## Accessibility checklist

Visible 2 px ink focus ring everywhere (`--focus`, 2 px outline at 2 px offset that follows the control's radius; text fields draw it on the field box); skip link; landmarks and one `h1` per page; roving focus in tab/segmented/chip groups; tables with captions and `aria-sort`; meters with `aria-valuetext`; charts with a text summary and keyboard readout; modal focus trap and Escape (dialog and claim moment); toasts and live feed announced politely; reduced motion honoured; text contrast ≥ 4.5:1 in both themes (`--ink-3` 5.6:1 on paper, 6.3:1 on night).

## Data layer

`src/data/interface.ts` (`FumpadData`) is the contract; `src/data/mock/` is a deterministic world (fixed epoch Oct 11 2026 14:00 UTC, seeded PRNG, price paths bridged through every ticket's sell price so chart and gauge agree, simulated live events). `src/data/chain.ts` converts raw chain units (Q64.64 prices, lamports, 6-decimal base units, enum indices) for the indexer client that will implement the same interface. Switch sources in `src/data/index.ts`.
