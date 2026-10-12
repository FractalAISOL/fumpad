import { cx } from "@/design";
import { mintTail } from "./ident";
import s from "./Coin.module.css";

/**
 * The mint, shortened so the part that tells coins apart stands out: `Ab3x…` + the last eight
 * characters in ink. Every FUMPAD mint ends in `fmbL`, so the four before it are what differ.
 */
export function MintTag({ mint, className }: { mint: string; className?: string }) {
  const tail = mintTail(mint, 8);
  return (
    <span className={cx("num", s.mintTag, className)} title={mint} aria-label={`Mint ${mint}`}>
      <span className={s.mintHead}>{mint.slice(0, 4)}…</span>
      <b className={s.mintTail}>{tail}</b>
    </span>
  );
}
