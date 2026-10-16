"use client";

import type { ReactNode } from "react";
import type { HealthLevel, ServiceVersion, SystemStatus } from "@/data";
import { Panel, PanelHead, cx } from "@/design";
import { Fumi, type FumiPose, SpeechBubble } from "@/design/anime";
import * as f from "@/design/format";
import s from "./Status.module.css";
import { LEVEL_TEXT, age, levelOf, useSystemStatus } from "./useStatus";

const WORD: Record<HealthLevel | "loading", string> = { ok: "Normal", degraded: "Behind", down: "Down", unknown: "No signal", loading: "Checking" };

function Row({ name, level, word, children }: { name: string; level: HealthLevel | "loading"; word?: string; children: ReactNode }) {
  return (
    <li className={s.row}>
      <span className={cx(s.dot, s[level])} aria-hidden="true" />
      <span className={s.name}>{name}</span>
      <span className={s.word}>{word ?? WORD[level]}</span>
      <p className={s.detail}>{children}</p>
    </li>
  );
}

function indexerText(x: SystemStatus["indexer"]) {
  if (x.lagSecs === null) return "The indexer hasn't reported in yet. Pages may show older data until it does.";
  const last = x.lastTxAgeSecs === null ? "" : ` The newest indexed transaction is ${age(x.lastTxAgeSecs)} old.`;
  return `Indexed data is about ${age(x.lagSecs)} behind the chain.${last}`;
}

function keeperText(x: SystemStatus["keeper"]) {
  if (x.graduatedCoins === 0) return "No graduated coins yet, so there are no prices to sample.";
  if (x.lastSampleAgeSecs === null) return "No price samples yet. Claims wait for the median, so they wait for these.";
  return `Last price sample ${age(x.lastSampleAgeSecs)} ago, across ${f.int(x.graduatedCoins)} graduated coin${x.graduatedCoins === 1 ? "" : "s"}. Each is sampled at least every 8 minutes; claims and auto-claims use these medians.`;
}

function vanityText(x: SystemStatus["vanityPool"]) {
  if (!x) return "Launching is switched off on this API.";
  if (x.available === 0) return "No launch addresses left. New launches can't start until more are ground; try again in a minute.";
  return `${f.int(x.available)} launch addresses ready (each ends in fmbL), ${f.int(x.reserved)} reserved by launches in progress.`;
}

/** Fumi's reaction to the overall level: header only, never next to the service rows or the table. */
const REACT: Record<HealthLevel | "loading", { pose: FumiPose; quip: string }> = {
  ok: { pose: "cheering", quip: "All humming along!" },
  degraded: { pose: "facepalm", quip: "A bit behind. Hang on." },
  down: { pose: "facepalm", quip: "Oops. Something's down." },
  unknown: { pose: "thinking", quip: "Hmm, no signal yet." },
  loading: { pose: "thinking", quip: "Checking…" },
};

const short =(v: string | null, n = 7) => (v ? v.slice(0, n) : "–");

function Versions({ rows, now }: { rows: ServiceVersion[]; now: number }) {
  return (
    <div className={s.tableWrap}>
      <table className={s.versions}>
        <caption className="sr-only">Deployed services</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Build</th>
            <th scope="col">Deployment</th>
            <th scope="col">Started</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((v) => (
            <tr key={v.name}>
              <td>{v.name}</td>
              <td className="num">{short(v.sha)}</td>
              <td className="num">{short(v.deploymentId, 8)}</td>
              <td className="num">{v.startedAt ? `${f.dateTime(v.startedAt)} UTC` : "–"}</td>
              <td className="num">{v.seenAt ? (now - v.seenAt < 45_000 ? "now" : `${age((now - v.seenAt) / 1000)} ago`) : "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function StatusView() {
  const st = useSystemStatus(30_000);
  const level = levelOf(st);
  const x = st.status;
  return (
    <div className={cx("wrap", s.page)}>
      <header className={s.head}>
        <h1 className={s.h1}>Status</h1>
        <div className={s.react} aria-hidden="true">
          <SpeechBubble key={level} tail="right" className={s.quip}>
            {REACT[level].quip}
          </SpeechBubble>
          <Fumi key={REACT[level].pose} pose={REACT[level].pose} size={120} fx fade pop className={s.reactFumi} />
        </div>
        <p className={s.overall} role="status">
          <span className={cx(s.dot, s[level])} aria-hidden="true" />
          {st.error ? "Can't reach the FUMPAD API." : LEVEL_TEXT[level]}
        </p>
        <p className={s.checked}>
          {st.checkedAt ? `Checked ${f.clock(st.checkedAt)} UTC. ` : ""}Refreshes every 30 seconds. Your funds are on Solana either way; this is about how fresh the
          pages are.
        </p>
      </header>

      <Panel aria-labelledby="checks-h">
        <PanelHead id="checks-h" title="Services" />
        <ul className={s.rows}>
          <Row name="API" level={st.error ? "down" : x ? "ok" : "loading"}>
            {st.error ? "Not answering. Pages fall back to what they last loaded." : "Answering. Prices, tickets and the feed come from here."}
          </Row>
          <Row name="Indexer" level={x?.indexer.level ?? "loading"}>
            {x ? indexerText(x.indexer) : "…"}
          </Row>
          <Row name="Keeper" level={x?.keeper.level ?? "loading"}>
            {x ? keeperText(x.keeper) : "…"}
          </Row>
          <Row name="Launch addresses" level={x ? (x.vanityPool?.level ?? "unknown") : "loading"} word={x && !x.vanityPool ? "Off" : undefined}>
            {x ? vanityText(x.vanityPool) : "…"}
          </Row>
        </ul>
      </Panel>

      {x && x.services.length > 0 && (
        <Panel aria-labelledby="versions-h">
          <PanelHead id="versions-h" title="Versions" />
          <Versions rows={x.services} now={x.at} />
        </Panel>
      )}
      <p className={s.note}>Build is the git commit a service runs, when the host reports one. The keeper appears here once the API can reach its health check.</p>
    </div>
  );
}
