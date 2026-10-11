"use client";

import { type ReactNode, useState } from "react";
import type { LeaderRow, PricePoint, Ticket } from "@/data";
import {
  Address,
  AmountInput,
  Avatar,
  Badge,
  Button,
  Change,
  Chips,
  CoinTile,
  type Column,
  CurveMeter,
  Dialog,
  EmptyState,
  Gauge,
  IconButton,
  IconCopy,
  IconPlus,
  InfoTip,
  KV,
  LevelBar,
  Mark,
  Multiple,
  Panel,
  PanelBody,
  PanelHead,
  PoolMeter,
  Price,
  PriceChart,
  Segmented,
  Skeleton,
  Sol,
  Sparkline,
  SplitBar,
  Table,
  Tabs,
  TextArea,
  TextInput,
  TicketCard,
  Tokens,
  Tooltip,
  Usd,
  Wordmark,
  cx,
  useToast,
} from "@/design";
import * as f from "@/design/format";
import { type ColorToken, colorDark, colorLight, duration, easing, radius, typeScale } from "@/design/tokens";
import { ClaimMoment, type ClaimResult } from "../moment/ClaimMoment";
import { useNow } from "../shell/Providers";
import s from "./Design.module.css";

type Mode = "both" | "light" | "dark";

/** Renders a specimen in the light theme, the dark theme, or both side by side. */
function Spec({ title, note, children, mode }: { title: string; note?: string; children: (theme: "light" | "dark") => ReactNode; mode: Mode }) {
  const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <section className={s.spec} aria-labelledby={id}>
      <div className={s.specHead}>
        <h2 id={id} className={s.specTitle}>
          {title}
        </h2>
        {note && <p className={s.specNote}>{note}</p>}
      </div>
      <div className={cx(s.panes, mode === "both" && s.both)}>
        {mode !== "dark" && (
          <div className={cx("theme-light", s.pane)}>
            <span className={s.paneLabel}>Light</span>
            {children("light")}
          </div>
        )}
        {mode !== "light" && (
          <div className={cx("theme-dark", s.pane)}>
            <span className={s.paneLabel}>Dark</span>
            {children("dark")}
          </div>
        )}
      </div>
    </section>
  );
}

const Row = ({ children, label }: { children: ReactNode; label?: string }) => (
  <div className={s.row}>
    {label && <span className={s.rowLabel}>{label}</span>}
    <div className={s.rowItems}>{children}</div>
  </div>
);

interface SampleRow {
  id: string;
  who: string;
  sol: number;
  x: number;
  me?: boolean;
}
const SAMPLE: SampleRow[] = [
  { id: "a", who: "whale_of_regret", sol: 582.2, x: 41 },
  { id: "b", who: "nobody_sells", sol: 406.1, x: 13.1 },
  { id: "c", who: "ramen_maxi", sol: 45.0, x: 11.4, me: true },
  { id: "d", who: "paperhandpete", sol: 103.4, x: 3.4 },
];

export function DesignView({ tickets, series, leaders }: { tickets: Ticket[]; series: PricePoint[]; leaders: LeaderRow[] }) {
  const [mode, setMode] = useState<Mode>("both");
  const [tab, setTab] = useState("one");
  const [seg, setSeg] = useState("7d");
  const [chip, setChip] = useState("all");
  const [amt, setAmt] = useState("2,000,000");
  const [amtOver, setAmtOver] = useState("40");
  const [dialog, setDialog] = useState(false);
  const [moment, setMoment] = useState(false);
  const toast = useToast();
  const now = useNow();
  const claimable = tickets.find((t) => t.state === "claimable");
  const sell = series[Math.floor(series.length * 0.2)];

  const cols: Column<SampleRow>[] = [
    { key: "who", header: "Wallet", render: (r) => <Address address={r.id.repeat(44)} name={r.who} you={r.me} link={false} /> },
    { key: "sol", header: "Worth now", align: "end", render: (r) => <Sol value={r.sol} />, sortValue: (r) => r.sol },
    { key: "x", header: "×", align: "end", render: (r) => <Multiple x={r.x} size="sm" />, sortValue: (r) => r.x },
  ];

  return (
    <div className="wrap">
      <header className={s.head}>
        <div className={s.brand}>
          <Mark size={56} />
          <Wordmark size="xl" />
        </div>
        <p className={s.lede}>
          The FUMPAD design system: every component in every state. Tokens live in <code>src/design/tokens.ts</code>; this page renders them through scoped light and dark themes.
        </p>
        <Segmented
          label="Theme"
          value={mode}
          onChange={setMode}
          items={[
            { value: "both", label: "Side by side" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </header>

      <Spec title="Colour" note="One signal. Flare means money: 10× crossings, claims, payouts. Never decoration, never direction." mode={mode}>
        {() => (
          <div className={s.swatches}>
            {(Object.keys(colorLight) as ColorToken[]).map((k) => (
              <div key={k} className={s.swatch}>
                <i style={{ background: `var(--${k})` }} />
                <b>{k}</b>
                <span className="num">
                  {colorLight[k]} / {colorDark[k]}
                </span>
              </div>
            ))}
          </div>
        )}
      </Spec>

      <Spec title="Type" note="Archivo across its width axis for words; Martian Mono for every number." mode={mode}>
        {() => (
          <div className={s.type}>
            <div className={s.t_display}>Claim unlocked.</div>
            <div className={s.t_title}>My fumbles</div>
            <div className={s.t_ticker}>
              <span className="ticker">$MIDC</span> <CoinTile symbol="MC" /> <CoinTile symbol="CP" variant={1} /> <CoinTile symbol="GB" variant={2} />
            </div>
            <p className={s.t_body}>You sold 4,200,000 MIDC on Aug 19. It held 11.4× for thirty minutes. Officially, you fumbled.</p>
            <div className="num" style={{ fontSize: 22 }}>
              11.4× <Price value={0.00001071} unit />
            </div>
            <KV rows={Object.entries(typeScale).map(([k, [fs, lh]]) => ({ k: `--fs-${k}`, v: <span className="num">{`${fs} / ${lh}`}</span> }))} />
          </div>
        )}
      </Spec>

      <Spec title="Radius, motion" note="Three radii: 3 tiles and tags, 6 controls, 12 panels. Motion: fast out, long settle." mode={mode}>
        {() => (
          <div className={s.grid2}>
            <div className={s.radii}>
              {Object.entries(radius).map(([k, v]) => (
                <div key={k}>
                  <i style={{ borderRadius: v }} />
                  <span className="num">
                    r-{k} {v}
                  </span>
                </div>
              ))}
            </div>
            <KV
              rows={[
                ...Object.entries(duration).map(([k, v]) => ({ k: `--dur-${k}`, v: <span className="num">{v}</span> })),
                ...Object.entries(easing).map(([k, v]) => ({ k: `--ease-${k}`, v: <span className="num">{v}</span> })),
              ]}
            />
          </div>
        )}
      </Spec>

      <Spec title="Button" note="Ink is the primary action. Flare only for money (Claim). Press: 1px down." mode={mode}>
        {() => (
          <>
            {(["ink", "line", "flare", "ghost"] as const).map((v) => (
              <Row key={v} label={v}>
                <Button variant={v} size="sm">
                  Small
                </Button>
                <Button variant={v}>Medium</Button>
                <Button variant={v} size="lg">
                  Large
                </Button>
                <Button variant={v} icon={<IconPlus />}>
                  With icon
                </Button>
                <Button variant={v} disabled>
                  Disabled
                </Button>
                <Button variant={v} loading>
                  Loading
                </Button>
              </Row>
            ))}
            <Row label="other">
              <Button variant="quiet">Quiet text action</Button>
              <IconButton label="Copy">
                <IconCopy />
              </IconButton>
              <IconButton label="Add" size="sm">
                <IconPlus />
              </IconButton>
            </Row>
          </>
        )}
      </Spec>

      <Spec title="Inputs" mode={mode}>
        {() => (
          <div className={s.grid2}>
            <div className={s.stack}>
              <TextInput label="Name" placeholder="Sad Pigeon" />
              <TextInput label="Ticker" prefix="$" defaultValue="PIGN" hint="2 to 10 letters or digits." />
              <TextInput label="Website" optional defaultValue="pigeon.lol" error="Use a full https:// address." />
              <TextInput label="Disabled" disabled defaultValue="Can't touch this" />
              <TextArea label="Description" optional placeholder="He's not sad, he's just like that." hint="0 / 280" />
            </div>
            <div className={s.stack}>
              <AmountInput label="You sell" value={amt} onChange={setAmt} unit="MIDC" balance={6_120_000} decimals={0} />
              <AmountInput label="You pay" value={amtOver} onChange={setAmtOver} unit="SOL" balance={24.8} />
              <AmountInput label="No balance yet" value="" onChange={() => {}} unit="SOL" hint="Connect a wallet to see your balance." />
            </div>
          </div>
        )}
      </Spec>

      <Spec title="Tabs, segmented, chips" mode={mode}>
        {(theme) => (
          <div className={s.stack}>
            <Tabs
              idBase={`ds-${theme}`}
              label="Example tabs"
              value={tab}
              onChange={setTab}
              items={[
                { value: "one", label: "Biggest fumbles" },
                { value: "two", label: "Top claimers", count: 6 },
                { value: "three", label: "Diamond hands" },
                { value: "four", label: "Disabled", disabled: true },
              ]}
            />
            <Row>
              <Segmented label="Range" value={seg} onChange={setSeg} items={["1h", "1d", "7d", "All"].map((v) => ({ value: v, label: v }))} />
              <Segmented size="sm" label="Range small" value={seg} onChange={setSeg} items={["1h", "1d", "7d", "All"].map((v) => ({ value: v, label: v }))} />
            </Row>
            <Segmented
              block
              label="Side"
              value={seg === "1h" ? "buy" : "sell"}
              onChange={(v) => setSeg(v === "buy" ? "1h" : "7d")}
              items={[
                { value: "buy", label: "Buy" },
                { value: "sell", label: "Sell" },
              ]}
            />
            <Chips label="Filter" value={chip} onChange={setChip} items={["all", "cross", "claim", "fumble"].map((v) => ({ value: v, label: v === "all" ? "Everything" : v === "cross" ? "10× crossings" : v === "claim" ? "Claims" : "Fumbles" }))} />
          </div>
        )}
      </Spec>

      <Spec title="Badges" note="Flare tones are for money states only." mode={mode}>
        {() => (
          <Row>
            <Badge>Tracking</Badge>
            <Badge tone="ink">Graduated</Badge>
            <Badge tone="flare">Claimable</Badge>
            <Badge tone="flare-line" dot>
              Queue #4
            </Badge>
            <Badge tone="flare-line">Paid</Badge>
            <Badge tone="muted">Expired</Badge>
          </Row>
        )}
      </Spec>

      <Spec title="Numbers" note="Subscript zeros for tiny prices. Direction is glyph plus weight, never colour." mode={mode}>
        {() => (
          <KV
            rows={[
              { k: "Price 0.00000094", v: <Price value={0.00000094} unit /> },
              { k: "Price 0.00001071", v: <Price value={0.00001071} unit /> },
              { k: "Price 0.0042", v: <Price value={0.0042} unit /> },
              { k: "SOL", v: <Sol value={21.42} /> },
              { k: "SOL, small", v: <Sol value={0.107} /> },
              { k: "USD", v: <Usd value={1_630_000} /> },
              { k: "Tokens", v: <Tokens value={4_200_000} symbol="MIDC" /> },
              { k: "Tokens, compact", v: <Tokens value={50_184_300} compact /> },
              { k: "Multiple below 10×", v: <Multiple x={8.2} /> },
              { k: "Multiple at 10× and past", v: <Multiple x={11.4} /> },
              { k: "Change up", v: <Change pct={38.2} /> },
              { k: "Change down", v: <Change pct={-6.3} /> },
              { k: "Change flat", v: <Change pct={0} /> },
            ]}
          />
        )}
      </Spec>

      <Spec title="10× gauge" note="Log ruler 1×–30×, hatched past 10×, orange after the crossing. Animates on mount; instant with reduced motion." mode={mode}>
        {() => (
          <div className={s.stack}>
            {[
              [0.4, "Below sell price, 0.4×, closed", true],
              [1, "New ticket, 1×", false],
              [3.4, "Tracking, 3.4×", false],
              [9.6, "Close, 9.6×", false],
              [11.4, "Unlocked, 11.4×", false],
              [41, "Past the scale, 41×", false],
            ].map(([v, l, dead]) => (
              <div key={String(l)}>
                <div className={s.cap}>{l as string}</div>
                <Gauge value={v as number} dead={dead as boolean} />
              </div>
            ))}
            <div className={s.cap}>Large</div>
            <Gauge value={11.4} size="lg" />
            <div className={s.cap}>Mini</div>
            <Gauge value={7.8} size="mini" />
            <Gauge value={12.1} size="mini" />
          </div>
        )}
      </Spec>

      <Spec title="Meters" mode={mode}>
        {() => (
          <div className={s.stack}>
            <div className={s.cap}>Curve, 12.4 SOL</div>
            <CurveMeter raised={12.4} />
            <div className={s.cap}>Curve, 61.37 SOL</div>
            <CurveMeter raised={61.37} />
            <div className={s.cap}>Curve, complete</div>
            <CurveMeter raised={85} />
            <div className={s.cap}>Curve, small</div>
            <CurveMeter raised={40} size="sm" />
            <div className={s.cap}>Pool short of the queue</div>
            <PoolMeter pool={9_620_400} needed={18_400_000} symbol="MIDC" />
            <div className={s.cap}>Level</div>
            <LevelBar value={7420} max={9000} label="Level progress" />
            <div className={s.cap}>Fee split</div>
            <SplitBar label="Fee split" parts={[{ label: "pool", share: 50 }, { label: "FUMPAD", share: 30 }, { label: "creator", share: 20 }]} />
          </div>
        )}
      </Spec>

      <Spec title="Chart" note="Log price axis. Ring: your sell. Dashed orange: 10× of it. Arrow keys read values." mode={mode}>
        {() => (
          <Panel>
            <PriceChart points={series} sell={sell ? { t: sell.t, p: sell.p } : undefined} trigger={sell ? sell.p * 10 : undefined} others={series.filter((_, i) => i % 37 === 5)} rangeLabel="since launch" symbol="MIDC" height={260} />
            <PanelBody>
              <Row label="sparkline">
                <Sparkline values={[1, 1.2, 1.1, 1.5, 1.4, 1.9, 2.2]} />
                <Sparkline values={[2.2, 2, 2.1, 1.6, 1.7, 1.2, 1.1]} />
              </Row>
            </PanelBody>
          </Panel>
        )}
      </Spec>

      <Spec title="Table" note="Dense, sortable, tabular numbers. Your own row is tinted." mode={mode}>
        {() => (
          <div className={s.stack}>
            <Panel>
              <PanelHead title="Biggest fumbles" aside="sortable" />
              <Table caption="Sample" columns={cols} rows={SAMPLE} rowKey={(r) => r.id} highlight={(r) => !!r.me} initialSort={{ key: "sol", dir: "desc" }} />
            </Panel>
            <Panel>
              <PanelHead title="Claim queue" aside="empty state" />
              <Table caption="Empty" columns={cols} rows={[]} rowKey={(r) => r.id} empty={<EmptyState title="No one is waiting" compact>Every claim fits the pool right now, so claims pay in the same transaction.</EmptyState>} />
            </Panel>
          </div>
        )}
      </Spec>

      <Spec title="Ticket card" note="One per state." mode={mode}>
        {() => (
          <Panel>
            <ul className={s.list}>
              {tickets.map((t) => (
                <TicketCard
                  key={t.id}
                  as="li"
                  ticket={t}
                  now={now}
                  note={t.state === "queued" ? "Queued at position 4. Pays when the pool reaches 2.6M. Queued claims don't expire." : t.rebuyDebited > 0 ? "You rebought within 7 days, so the claim shrank." : undefined}
                  action={t.state === "claimable" ? <Button variant="flare">Claim {f.int(t.claimAmount)}</Button> : undefined}
                />
              ))}
            </ul>
          </Panel>
        )}
      </Spec>

      <Spec title="Identity" mode={mode}>
        {() => (
          <div className={s.stack}>
            <Row label="avatar">
              <Avatar address="7xKpR2mVq83fQe" size="sm" />
              <Avatar address="7xKpR2mVq83fQe" />
              <Avatar address="7xKpR2mVq83fQe" size="lg" />
              <Avatar address="Fq9vB2pp4" size="lg" />
            </Row>
            <Row label="coin tile">
              <CoinTile symbol="MIDC" size="sm" />
              <CoinTile symbol="COPE" variant={1} />
              <CoinTile symbol="GOBT" variant={2} size="lg" />
              <CoinTile symbol="WBSC" size="xl" />
            </Row>
            <Row label="address">
              <Address address="Fq9vB2ppTn5aHw1LbZcY9uD4sJgE6rNpXkM3fQeKk2a0" link={false} />
              <Address address="7xKpR2mVq83fQeTn5aHw1LbZcY9uD4sJgE6rNpXkM3fQe" name="ramen_maxi" you link={false} copy />
            </Row>
          </div>
        )}
      </Spec>

      <Spec title="Feedback" note="Dialog, toast and tooltip render in the page's theme (they portal to the top layer)." mode={mode}>
        {() => (
          <div className={s.stack}>
            <Row label="overlays">
              <Button variant="line" onClick={() => setDialog(true)}>
                Open dialog
              </Button>
              <Button variant="line" onClick={() => toast("Sold. Ticket filed for $MIDC, claimable at 10×.")}>
                Toast
              </Button>
              <Button variant="line" onClick={() => toast("Claimed 420,000 MIDC.", "money")}>
                Money toast
              </Button>
              <Tooltip content="30-minute median of keeper samples. Spikes don't count.">
                <Button variant="ghost">Hover for tooltip</Button>
              </Tooltip>
              <span>
                Ticket price <InfoTip>The higher of your fill and a 10-minute average floor.</InfoTip>
              </span>
              {claimable && (
                <Button variant="flare" onClick={() => setMoment(true)}>
                  Play the claim moment
                </Button>
              )}
            </Row>
            <div className={s.skels} aria-hidden="true">
              <Skeleton w={36} h={36} round />
              <div className={s.stack}>
                <Skeleton w="60%" />
                <Skeleton w="40%" />
              </div>
            </div>
            <Panel>
              <EmptyState title="No flags" action={<Button variant="line" size="sm">Show all tickets</Button>}>
                Your wallet is clean, which is rarer than a 10×.
              </EmptyState>
            </Panel>
          </div>
        )}
      </Spec>

      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Launch $PIGN?"
        description="Launching is permanent. The name, ticker and image can't be changed later."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(false)}>
              Keep editing
            </Button>
            <Button onClick={() => setDialog(false)}>Launch $PIGN</Button>
          </>
        }
      >
        <KV rows={[{ k: "First buy", v: <Sol value={1.5} /> }, { k: "Network rent", v: <span className="num">≈ 0.02 SOL</span> }]} />
      </Dialog>
      {moment && claimable && (
        <ClaimMoment
          ticket={claimable}
          walletLabel="7xKp…3fQe"
          onClose={() => setMoment(false)}
          onClaim={async (): Promise<ClaimResult> => {
            await new Promise((r) => setTimeout(r, 650));
            return { status: "paid", signature: "4tQmZp8cDemoSignature", at: now };
          }}
        />
      )}
    </div>
  );
}
