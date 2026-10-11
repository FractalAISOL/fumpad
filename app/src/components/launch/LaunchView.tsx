"use client";

import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { useFumpadTx } from "@/chain/tx";
import { PARAMS, cpOut } from "@/data/chain";
import { AmountInput, Button, CoinTile, CurveMeter, Dialog, EmptyState, IconUpload, KV, Panel, PanelHead, SplitBar, TextArea, TextInput, Tokens, cx, parseAmount, useToast } from "@/design";
import * as f from "@/design/format";
import { useViewer } from "../shell/Providers";
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
  const [done, setDone] = useState<string | null>(null);
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
  const firstTokens = firstBuy > 0 ? cpOut(PARAMS.initialVirtualSol, PARAMS.initialVirtualTokens, net) : 0;
  const tick = symbol || "TICKER";

  const launch = async () => {
    const res = await tx.launch({ name, symbol, uri: "ipfs://pending", initialBuySol: firstBuy });
    setReview(false);
    if (!res) {
      toast(tx.error ?? "The launch didn't go through. Nothing was charged.");
      return;
    }
    setDone(symbol);
    toast(`Launched $${symbol}.`);
    tx.reset();
  };

  if (done) {
    return (
      <div className="wrap">
        <Panel className={s.done}>
          <EmptyState
            title={`$${done} is live`}
            action={
              <>
                <Button href="/coins">See it with the other coins</Button>
                <Button variant="line" onClick={() => location.reload()}>
                  Launch another
                </Button>
              </>
            }
          >
            50,000,000 {done} sit in its reward pool already. The first person to sell it too early will be glad.
          </EmptyState>
        </Panel>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className={s.head}>
        <h1 className={s.h1}>Launch a coin</h1>
        <p className={s.lede}>Every coin on FUMPAD starts with 5% of its supply in a reward pool, so people who sell too early get paid back. Takes about a minute.</p>
      </div>

      <div className={s.grid}>
        <form
          className={s.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            setTried(true);
            if (valid) setReview(true);
          }}
        >
          <Panel>
            <PanelHead title="The coin" />
            <div className={s.fields}>
              <div className={s.row2}>
                <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sad Pigeon" maxLength={40} error={shown.name} autoComplete="off" />
                <TextInput
                  label="Ticker"
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10))}
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
                <TextInput label="Telegram" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="t.me/sadpigeon" error={shown.telegram} autoComplete="off" />
                <TextInput label="Website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" error={shown.website} inputMode="url" autoComplete="off" />
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
                    You get about <Tokens value={firstTokens} symbol={tick} /> at the opening price. As the creator you can&apos;t file fumble tickets on this coin; you earn 20% of every trade fee instead.
                  </>
                ) : (
                  <>Buying first in the launch transaction means nobody can buy ahead of you. As the creator you earn 20% of every trade fee.</>
                )}
              </p>
            </div>
          </Panel>

          <div className={s.submit}>
            <Button type="submit" size="lg" block>
              Review launch
            </Button>
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
                <CoinTile symbol={tick} size="lg" imageUrl={preview ?? undefined} />
                <div className={s.pvText}>
                  <div className={s.pvName}>{name || "Your coin"}</div>
                  <div className="ticker">${tick}</div>
                </div>
              </div>
              {description && <p className={s.pvDesc}>{description}</p>}
              <CurveMeter raised={firstBuy > 0 ? Math.min(85, net) : 0} />
            </div>
            <div className={s.facts}>
              <KV
                rows={[
                  { k: "Supply, mint authority revoked", v: <Tokens value={PARAMS.totalSupply} /> },
                  { k: "Reward pool, 5%", v: <Tokens value={PARAMS.rewardPoolSupply} /> },
                  { k: "On the bonding curve", v: <Tokens value={PARAMS.curveSupply} compact /> },
                  { k: "Graduates at", v: <span className="num">85 SOL</span> },
                  { k: "Network rent", v: <span className="num">≈ 0.02 SOL</span> },
                ]}
              />
              <p className={s.splitLabel}>Each 1% trade fee</p>
              <SplitBar
                label="Fee split"
                parts={[
                  { label: "pool", share: 50 },
                  { label: "FUMPAD", share: 30 },
                  { label: "you", share: 20 },
                ]}
              />
              <p className={s.hint}>At graduation the liquidity moves to PumpSwap and is locked forever. Nobody can pull it, including you.</p>
            </div>
          </Panel>
        </aside>
      </div>

      <Dialog
        open={review}
        onClose={() => setReview(false)}
        title={`Launch $${symbol}?`}
        description="Launching is permanent. The name, ticker and image can't be changed later."
        footer={
          <>
            <Button variant="ghost" onClick={() => setReview(false)}>
              Keep editing
            </Button>
            <Button onClick={launch} loading={tx.status !== "idle" && tx.status !== "error" && tx.status !== "done"}>
              Launch ${symbol}
            </Button>
          </>
        }
      >
        <div className={s.review}>
          <CoinTile symbol={symbol} size="lg" imageUrl={preview ?? undefined} />
          <div>
            <div className={s.pvName}>{name}</div>
            <div className="ticker">${symbol}</div>
          </div>
        </div>
        <KV
          rows={[
            { k: "First buy", v: firstBuy > 0 ? <span className="num">{f.sol(firstBuy)} SOL</span> : <span className="muted">None</span> },
            ...(firstBuy > 0 ? [{ k: "You receive", v: <Tokens value={firstTokens} symbol={symbol} /> }] : []),
            { k: "Network rent", v: <span className="num">≈ 0.02 SOL</span> },
            { k: "Total", v: <span className="num">{f.sol(firstBuy + 0.02)} SOL</span> },
          ]}
        />
        {isDemo && <p className={s.hint}>Demo wallet: the launch is simulated.</p>}
      </Dialog>
    </div>
  );
}
