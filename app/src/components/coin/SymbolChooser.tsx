import Link from "next/link";
import type { CoinSummary } from "@/data";
import { Badge, CoinTile, Panel, PanelHead, Usd } from "@/design";
import * as f from "@/design/format";
import { coinHref, hasLookalikeChars } from "./ident";
import { MintTag } from "./MintTag";
import s from "./Coin.module.css";

/**
 * `/coin/<SYMBOL>` when more than one coin answers to the symbol (H-3). Symbols aren't unique,
 * so FUMPAD never picks one for you: newest first, each with its mint and creator.
 */
export function SymbolChooser({ symbol, coins, solUsd }: { symbol: string; coins: CoinSummary[]; solUsd: number }) {
  return (
    <div className="wrap">
      <header className={s.head}>
        <div className={s.headText} style={{ gridColumn: "1 / -1" }}>
          <h1 className={s.name}>{coins.length} coins are called ${symbol}</h1>
          <p className={s.sub}>Symbols aren&apos;t unique. Check the mint address before you trade: it&apos;s the only thing that identifies a coin.</p>
        </div>
      </header>
      <Panel aria-labelledby="choose-h">
        <PanelHead id="choose-h" title="Pick the coin" aside={<span className={s.chooseAside}>newest first</span>} />
        <ul className={s.choose}>
          {coins.map((c) => (
            <li key={c.mint}>
              <Link href={coinHref(c)} className={s.chooseRow} prefetch={false}>
                <CoinTile symbol={c.symbol} variant={c.tile} mint={c.mint} imageUrl={c.imageUrl} size="md" />
                <span className={s.chooseMain}>
                  <span className={s.chooseName}>
                    <span className="ticker">${c.symbol}</span> <span>{c.name}</span>
                    {(hasLookalikeChars(c.symbol) || hasLookalikeChars(c.name)) && <Badge tone="ink">Look-alike characters</Badge>}
                  </span>
                  <span className={s.chooseMeta}>
                    <MintTag mint={c.mint} />
                    <span>
                      by <span className="num">{f.shortAddr(c.creator)}</span>
                    </span>
                    <span>launched {f.date(c.createdAt)}</span>
                  </span>
                </span>
                <span className={s.chooseCap}>
                  <Usd value={c.marketCapSol * solUsd} />
                  <span className={s.chooseCapLabel}>market cap</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
