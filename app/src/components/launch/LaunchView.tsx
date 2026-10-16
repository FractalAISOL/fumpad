"use client";

import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { splitVanity } from "@/chain/program";
import { type LaunchStep, type PreparedLaunch, useFumpadTx } from "@/chain/tx";
import { curveReservesAt, quoteBuy } from "@/data/meteora";
import {
  AmountInput,
  Button,
  CoinTile,
  CopyButton,
  CurveMeter,
  Dialog,
  IconUpload,
  KV,
  Panel,
  PanelHead,
  SplitBar,
  TextArea,
  TextInput,
  Tokens,
  cx,
  parseAmount,
  useToast,
} from "@/design";
import { Fumi, FumiEmptyState, SpeechBubble } from "@/design/anime";
import * as f from "@/design/format";
import { useProtocolParams, useViewer } from "../shell/Providers";
import s from "./Launch.module.css";

const MAX_IMG = 4 * 1024 * 1024;
const IMG_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface Errors {
  name?: string;
  symbol?: string;
  description?: string;
  image?: string;
  x?: string;
  telegram?: string;
  website?: string;
}

function validate(v: { name: string; symbol: string; description: string; x: string; telegram: string; website: string; hasImage: boolean }): Errors {
  const e: Errors = {};
  if (!v.name.trim()) e.name = "Give the coin a name.";
  else if (v.name.length > 32) e.name = "Keep the name to 32 characters.";
  if (!v.symbol) e.symbol = "Pick a ticker.";
  else if (!/^[A-Z0-9]{2,10}$/.test(v.symbol)) e.symbol = "Use 2 to 10 letters or digits.";
  if (v.description.length > 280) e.description = "Keep it to 280 characters.";
  if (!v.hasImage) e.image = "Add an image. It's the coin's face everywhere.";
  if (v.x && !/^@?[A-Za-z0-9_]{1,15}$/.test(v.x)) e.x = "Use an X handle, like @fumpad.";
  if (v.telegram && !/^(https:\/\/t\.me\/)?[A-Za-z0-9_]{4,}$/.test(v.telegram)) e.telegram = "Use a t.me link or group name.";
  if (v.website && !/^https:\/\/\S+\.\S+/.test(v.website)) e.website = "Use a full https:// address.";
  return e;
}

export function LaunchView() {
  const { isDemo } = useViewer();
  const PARAMS = useProtocolParams();
  const tx = useFumpadTx();
  const toast = useToast();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [x, setX] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");
  const [buy, setBuy] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [tried, setTried] = useState(false);
  const [review, setReview] = useState(false);
  const [done, setDone] = useState<{ symbol: string; mint: string; suffix: string } | null>(null);
  const [prepared, setPrepared] = useState<PreparedLaunch | null>(null);
  /**
   * `?config=first-coin`: ask the API for the one-off first-coin launch config (3% fee, contracts INTERFACE §5.9). The
   * API decides whether it is offered (server flag + on-chain allow-list); the review step then shows its real fee.
   */
  const [firstCoin, setFirstCoin] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the URL on the client
    setFirstCoin(new URLSearchParams(window.location.search).get("config") === "first-coin");
  }, []);
  const fileRef = useRef<HTMLInputElement>(null);
  const imgId = useId();

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- derived from the file, cleaned up below
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const pickFile = (fl: File | undefined | null) => {
    if (!fl) return;
    if (!IMG_TYPES.includes(fl.type)) return setImgErr("Use a PNG, JPG, GIF or WebP.");
    if (fl.size > MAX_IMG) return setImgErr(`That's ${f.fixed(fl.size / 1024 / 1024, 1)} MB. The limit is 4 MB.`);
    setImgErr(null);
    setFile(fl);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    pickFile(e.dataTransfer.files?.[0]);
  };

  const errs = validate({ name, symbol, description, x, telegram, website, hasImage: !!file });
  const shown: Errors = tried ? errs : {};
  if (imgErr) shown.image = imgErr;
  const valid = Object.keys(errs).length === 0;

  const firstBuy = parseAmount(buy);
  const net = firstBuy * (1 - PARAMS.feeBps / 10_000);
  // The creator's buy is the fresh DBC pool's first swap, at the normal fee (D33).
  const firstTokens = firstBuy > 0 ? quoteBuy(curveReservesAt(PARAMS.initialVirtualSol, PARAMS.initialVirtualTokens, 0), firstBuy, PARAMS.feeBps, PARAMS.curveSupply).amountOut : 0;
  const tick = symbol || "TICKER";
  // D33: trades in the first slots after launch pay the DBC scheduler's fee, 99% falling to the
  // normal fee; FUMPAD's share of it goes to the reward pool. The creator's first buy, the first
  // swap in the launch transaction, pays the normal fee.
  const snipeSecs = (PARAMS.snipeWindowSlots ?? 0) * 0.4;
  const snipeOn = snipeSecs > 0 && (PARAMS.snipeStartBps ?? 0) > PARAMS.feeBps;
  const snipePct = f.fixed((PARAMS.snipeStartBps ?? 0) / 100, 0);
  const feePct = f.fixed(PARAMS.feeBps / 100, PARAMS.feeBps % 100 ? 2 : 0);

  // D18 step 1: reserve the coin's `…fmbL` address (server-side vanity mint) for the review.
  const openReview = async () => {
    const p = await tx.prepareLaunch({ name, symbol, uri: "ipfs://pending", initialBuySol: firstBuy, ...(firstCoin ? { launchConfig: "first_coin" as const } : {}) });
    if (!p) {
      toast(tx.error ?? "Couldn't prepare the launch. Nothing was charged.");
      tx.reset();
      return;
    }
    // The fee shown in the review is the prepared config's real fee; signing then checks it against the chain.
    const fee = p.config?.feeBps ?? PARAMS.feeBps;
    setPrepared({ ...p, args: { ...p.args, expectedFeeBps: p.simulated ? undefined : fee } });
    setReview(true);
  };
  /** The prepared launch's config fees (the one-off first-coin config: 3%, its own split), else the protocol's. */
  const cfgFee = prepared?.config;
  const reviewFeePct = f.fixed((cfgFee?.feeBps ?? PARAMS.feeBps) / 100, (cfgFee?.feeBps ?? PARAMS.feeBps) % 100 ? 2 : 0);
  const firstCoinReview = cfgFee?.kind === "first_coin" ? cfgFee : null;
  const closeReview = () => {
    setReview(false);
    setPrepared(null);
  };

  const launch = async () => {
    if (!prepared) return;
    const res = await tx.launch(prepared);
    setReview(false);
    if (!res) {
      toast(tx.error ?? "The launch didn't go through. Nothing was charged.");
      return;
    }
    setDone({ symbol, mint: prepared.mint, suffix: prepared.suffix });
    // The form was long; start the success screen at its top, not mid-page under the header.
    window.scrollTo({ top: 0 });
    setPrepared(null);
    toast(`Launched $${symbol}.`);
    tx.reset();
  };

  if (done) {
    return (
      <div className="wrap">
        <Panel className={s.done}>
          <FumiEmptyState
            pose="cheering"
            quip="It's live!"
            title={`$${done.symbol} is live`}
            action={
              <>
                <Button href="/launches">See it with the other launches</Button>
                <Button variant="line" onClick={() => location.reload()}>
                  Launch another
                </Button>
              </>
            }
          >
            80,000,000 {done.symbol} sit in its reward pool already. The first person to sell it too early will be glad.
          </FumiEmptyState>
          <MintAddress mint={done.mint} suffix={done.suffix} />
        </Panel>
      </div>
    );
  }

  return (
    <div className="wrap">
      {/* Fumi stays up here, above the form: never beside the inputs, the fee review or the sign button. */}
      <div className={s.head}>
        <h1 className={s.h1}>Launch a coin</h1>
        <p className={s.lede}>
          Every coin on FUMPAD sets aside 8% of its supply for a reward pool, so people who sell too early, on any app, get paid back. Takes about a minute.
        </p>
        <div className={s.react} aria-hidden="true">
          <SpeechBubble tail="right" className={s.quip}>
            New coin incoming!
          </SpeechBubble>
          <Fumi pose="running" size={120} fx fade className={s.reactFumi} />
        </div>
      </div>

      <div className={s.grid}>
        <form
          className={s.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            setTried(true);
            if (valid) void openReview();
            else requestAnimationFrame(() => (form.querySelector("[aria-invalid=true]") as HTMLElement | null)?.focus());
          }}
        >
          <Panel>
            <PanelHead title="The coin" />
            <div className={s.fields}>
              <div className={s.row2}>
                <TextInput
                  label="Name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Sad Pigeon"
                  maxLength={40}
                  error={shown.name}
                  autoComplete="off"
                />
                <TextInput
                  label="Ticker"
                  value={symbol}
                  onChange={(e) =>
                    setSymbol(
                      e.target.value
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, "")
                        .slice(0, 10),
                    )
                  }
                  placeholder="PIGN"
                  prefix="$"
                  error={shown.symbol}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <TextArea
                label="Description"
                optional
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="He's not sad, he's just like that."
                hint={`${description.length} / 280`}
                error={shown.description}
                rows={3}
              />

              <div className={s.imgField}>
                <label htmlFor={imgId} className={s.label}>
                  Image
                </label>
                <div
                  className={cx(s.drop, drag && s.dragging, shown.image && s.dropErr)}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDrag(true);
                  }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={onDrop}
                >
                  {preview ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                    <img src={preview} alt="Selected coin image" className={s.dropImg} />
                  ) : (
                    <span className={s.dropIcon}>
                      <IconUpload />
                    </span>
                  )}
                  <div className={s.dropText}>
                    <b>{file ? file.name : "Drop an image, or choose one"}</b>
                    <span>PNG, JPG, GIF or WebP, up to 4 MB. Square works best.</span>
                  </div>
                  <Button variant="line" size="sm" onClick={() => fileRef.current?.click()}>
                    {file ? "Replace" : "Choose"}
                  </Button>
                  <input
                    ref={fileRef}
                    id={imgId}
                    type="file"
                    accept={IMG_TYPES.join(",")}
                    className="sr-only"
                    aria-describedby={`${imgId}-msg`}
                    aria-invalid={shown.image ? true : undefined}
                    onChange={(e) => pickFile(e.target.files?.[0])}
                  />
                </div>
                <p id={`${imgId}-msg`} className={shown.image ? s.err : s.hint}>
                  {shown.image ?? "Uploaded with the coin's metadata when you launch."}
                </p>
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHead title="Links" aside="optional" />
            <div className={s.fields}>
              <div className={s.row3}>
                <TextInput label="X" value={x} onChange={(e) => setX(e.target.value)} placeholder="@sadpigeon" error={shown.x} autoComplete="off" />
                <TextInput
                  label="Telegram"
                  value={telegram}
                  onChange={(e) => setTelegram(e.target.value)}
                  placeholder="t.me/sadpigeon"
                  error={shown.telegram}
                  autoComplete="off"
                />
                <TextInput
                  label="Website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder="https://"
                  error={shown.website}
                  inputMode="url"
                  autoComplete="off"
                />
              </div>
            </div>
          </Panel>

          <Panel>
            <PanelHead title="First buy" aside="optional, same transaction" />
            <div className={s.fields}>
              <AmountInput label="You pay" value={buy} onChange={setBuy} unit="SOL" balance={24.8} />
              <p className={s.hint}>
                {firstBuy > 0 ? (
                  <>
                    You get about <Tokens value={firstTokens} symbol={tick} /> at the opening price.{" "}
                    {snipeOn && (
                      <>
                        <b>Your first buy gets the normal {feePct}% fee; snipers pay up to {snipePct}%.</b> It&apos;s the first trade in the launch transaction, so
                        nobody gets in ahead of you, and anyone trading in the next ~{f.fixed(snipeSecs, 0)} s pays the launch-window fee, with FUMPAD&apos;s share
                        going to ${tick}&apos;s reward pool.{" "}
                      </>
                    )}
                    As the creator you can&apos;t file fumble tickets on this coin; you earn {f.fixed(PARAMS.feeCreatorShareBps / 100, 0)}% of FUMPAD&apos;s share
                    of every trade fee instead, on every app.
                  </>
                ) : (
                  <>
                    Buying first in the launch transaction means nobody can buy ahead of you, and your buy pays the normal {feePct}% fee.
                    {snipeOn && (
                      <>
                        {" "}
                        Bots that try anyway pay up to {snipePct}% for the first ~{f.fixed(snipeSecs, 0)} s, and FUMPAD&apos;s share of that goes to the reward pool.
                      </>
                    )}{" "}
                    As the creator you earn {f.fixed(PARAMS.feeCreatorShareBps / 100, 0)}% of FUMPAD&apos;s share of every trade fee, on every app.
                  </>
                )}
              </p>
            </div>
          </Panel>

          <div className={s.submit}>
            <Button type="submit" size="lg" block loading={!review && tx.status === "building"}>
              Review launch
            </Button>
            {!review && (tx.launchStep === "auth" || tx.launchStep === "reserve") && <LaunchProgress step={tx.launchStep} instant={tx.instant} />}
            {tried && !valid && (
              <p className={s.err} role="alert">
                Fix the {Object.keys(errs).length === 1 ? "field" : `${Object.keys(errs).length} fields`} above to continue.
              </p>
            )}
          </div>
        </form>

        <aside className={s.side} aria-label="Preview">
          <Panel>
            <PanelHead title="Preview" />
            <div className={s.preview}>
              <div className={s.pvHead}>
                <CoinTile symbol={tick} size="lg" imageUrl={preview ?? undefined} localPreview />
                <div className={s.pvText}>
                  <div className={s.pvName}>{name || "Your coin"}</div>
                  <div className="ticker">${tick}</div>
                </div>
              </div>
              {description && <p className={s.pvDesc}>{description}</p>}
              <CurveMeter raised={firstBuy > 0 ? Math.min(PARAMS.graduationSol, net) : 0} target={PARAMS.graduationSol} />
            </div>
            <div className={s.facts}>
              <KV
                rows={[
                  { k: "Supply, mint authority revoked", v: <Tokens value={PARAMS.totalSupply} /> },
                  {
                    k: `Reward pool at graduation, ${f.fixed((PARAMS.rewardPoolSupply / PARAMS.totalSupply) * 100, 0)}%`,
                    v: <Tokens value={PARAMS.rewardPoolSupply} />,
                  },
                  { k: "On the bonding curve", v: <Tokens value={PARAMS.curveSupply} compact /> },
                  { k: "Graduates at", v: <span className="num">{f.fixed(PARAMS.graduationSol, PARAMS.graduationSol < 10 ? 2 : 0)} SOL</span> },
                  ...(snipeOn
                    ? [{ k: "Snipe protection", v: <span className="num">{snipePct}% → {feePct}% in ~{f.fixed(snipeSecs, 0)} s</span> }]
                    : []),
                  { k: "Network rent", v: <span className="num">≈ 0.02 SOL</span> },
                ]}
              />
              <p className={s.splitLabel}>
                Each {feePct}% trade fee, on any app: Meteora keeps {f.fixed(PARAMS.venueFeeShareBps / 100, 0)}%, FUMPAD&apos;s share goes
              </p>
              <SplitBar
                label="Fee split"
                parts={[
                  { label: "pool", share: PARAMS.feePoolShareBps / 100 },
                  { label: "FUMPAD", share: PARAMS.feePlatformShareBps / 100 },
                  { label: "you", share: PARAMS.feeCreatorShareBps / 100 },
                ]}
              />
              <p className={s.hint}>
                ${tick} trades on Meteora from the first block, so Axiom, Jupiter and other Solana apps can trade it too, and every sell over{" "}
                {f.usdRule(PARAMS.minSellUsd)} counts wherever it happens. At graduation the liquidity moves to a Meteora pool, 100% locked forever. Nobody can pull it,
                including you.
              </p>
            </div>
          </Panel>
        </aside>
      </div>

      <Dialog
        open={review}
        onClose={closeReview}
        title={`Launch $${symbol}?`}
        description="Launching is permanent. The name, ticker and image can't be changed later."
        footer={
          <>
            <Button variant="ghost" onClick={closeReview}>
              Keep editing
            </Button>
            <Button onClick={launch} disabled={!prepared} loading={tx.status !== "idle" && tx.status !== "error" && tx.status !== "done"}>
              Launch ${symbol}
            </Button>
          </>
        }
      >
        <div className={s.review}>
          <CoinTile symbol={symbol} size="lg" imageUrl={preview ?? undefined} localPreview />
          <div>
            <div className={s.pvName}>{name}</div>
            <div className="ticker">${symbol}</div>
          </div>
        </div>
        {prepared && <MintAddress mint={prepared.mint} suffix={prepared.suffix} />}
        {firstCoinReview && (
          <p className={s.hint} role="note">
            <b>First-coin launch config.</b> Every trade of ${symbol} pays a <b className="num">{reviewFeePct}%</b> fee, on any app, before and after
            graduation (the first ~{f.fixed(firstCoinReview.snipeWindowSlots * 0.4, 0)} s fall from {f.fixed(firstCoinReview.snipeStartBps / 100, 0)}% to{" "}
            {reviewFeePct}%). Meteora keeps a fifth; of FUMPAD&apos;s {f.fixed(((firstCoinReview.feePolicy.buybackShareBps + firstCoinReview.feePolicy.walletShareBps) / 100), 1)}%,{" "}
            {f.fixed(firstCoinReview.feePolicy.buybackShareBps / 100, 1)}% buys ${symbol} into its reward pool and {f.fixed(firstCoinReview.feePolicy.walletShareBps / 100, 1)}%
            (plus FUMPAD&apos;s whole launch-window share) goes to {firstCoinReview.feePolicy.wallet ? f.shortAddr(firstCoinReview.feePolicy.wallet) : "a designated wallet"}. No creator share.
          </p>
        )}
        <KV
          rows={[
            { k: "First buy", v: firstBuy > 0 ? <span className="num">{f.sol(firstBuy)} SOL</span> : <span className="muted">None</span> },
            ...(firstBuy > 0 ? [{ k: "You receive", v: <Tokens value={firstTokens} symbol={symbol} /> }] : []),
            { k: "Trading fee", v: <span className="num">{reviewFeePct}%{firstCoinReview ? ", first-coin config" : ""}</span> },
            ...(firstBuy > 0 && snipeOn ? [{ k: "Fee on your buy", v: <span className="num">{reviewFeePct}%, first in line</span> }] : []),
            { k: "Network rent", v: <span className="num">≈ 0.02 SOL</span> },
            { k: "Total", v: <span className="num">{f.sol(firstBuy + 0.02)} SOL</span> },
          ]}
        />
        {tx.launchStep && <LaunchProgress step={tx.launchStep} instant={tx.instant} />}
        {isDemo && <p className={s.hint}>Demo wallet: the launch is simulated.</p>}
      </Dialog>
    </div>
  );
}

/** The coin's mint address with its FUMPAD `…fmbL` ending set apart (weight + underline, not color). */
function MintAddress({ mint, suffix }: { mint: string; suffix: string }) {
  const { head, tail } = splitVanity(mint, suffix);
  return (
    <div className={s.mintBox}>
      <div className={s.mintLabel}>
        <span>Coin address</span>
        <CopyButton value={mint} label="Copy coin address" />
      </div>
      <div className={cx("num", s.mintAddr)} aria-label={`Coin address ${mint}`}>
        {head}
        {tail && <span className={s.mintSuffix}>{tail}</span>}
      </div>
      {tail && <p className={s.hint}>Every coin launched on FUMPAD ends in {tail}, so fakes are easy to spot.</p>}
    </div>
  );
}

const STEPS: { id: Exclude<LaunchStep, "done">; label: (instant: boolean) => string; hint: (instant: boolean) => string }[] = [
  {
    id: "auth",
    label: () => "Confirm you own this wallet",
    hint: (instant) =>
      instant
        ? "Your Trading wallet signs a short FUMPAD message. It costs nothing and sends nothing."
        : "Sign the FUMPAD message in your wallet. It costs nothing and sends nothing.",
  },
  { id: "reserve", label: () => "Reserve your coin's address", hint: () => "FUMPAD sets aside an address ending in fmbL for your coin." },
  {
    id: "sign",
    label: (instant) => (instant ? "Sign the launch" : "Approve the launch"),
    hint: (instant) => (instant ? "Signing with your Trading wallet." : "Approve the transaction in your wallet."),
  },
  { id: "confirm", label: () => "Confirm on Solana", hint: () => "Waiting for the network. Usually a few seconds." },
];

/** The launch's steps: done, current (with what to do), still to come. */
function LaunchProgress({ step, instant }: { step: LaunchStep; instant: boolean }) {
  const at = step === "done" ? STEPS.length : STEPS.findIndex((x) => x.id === step);
  return (
    <ol className={s.steps} aria-label="Launch progress">
      {STEPS.map((x, i) => {
        const state = i < at ? "done" : i === at ? "active" : "todo";
        return (
          <li key={x.id} className={cx(s.step, state === "done" && s.stepDone, state === "active" && s.stepActive)} aria-current={state === "active" ? "step" : undefined}>
            <span className={s.stepMark} aria-hidden>
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className={s.stepText}>
              <span className={s.stepLabel}>
                {x.label(instant)}
                {state === "done" && <span className="sr-only"> (done)</span>}
              </span>
              {state === "active" && <span className={s.stepHint}>{x.hint(instant)}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
