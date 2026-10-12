import Link from "next/link";
import { Mark } from "@/design/components/Brand";
import { IconX } from "@/design/components/Icons";
import s from "./Room.module.css";
import { X_URL } from "./links";
import { ThemeSwitch } from "./ThemeSwitch";

export function RoomHeader() {
  return (
    <header className={s.top}>
      <Link href="/" className={s.brand} aria-label="FUMPAD home">
        <Mark size={26} />
        <span className={s.word}>FUMPAD</span>
      </Link>
      <div className={s.topRight}>
        <a href={X_URL} className={s.follow} target="_blank" rel="noopener noreferrer">
          <IconX width={15} height={15} aria-hidden="true" />
          <span>
            Follow <span className={s.hideSm}>@Fumblepad</span>
          </span>
        </a>
        <ThemeSwitch />
      </div>
    </header>
  );
}

export function RoomFooter() {
  return (
    <footer className={s.foot}>
      <div className={s.footInner}>
        <div className={s.footBrand}>
          <Mark size={22} />
          <span className={s.word}>FUMPAD</span>
        </div>
        <p className={s.disclaimer}>
          FUMPAD is software for launching and trading memecoins on Solana. Memecoins are extremely risky and most go to zero. A fumble ticket is not insurance: claims pay
          only while the coin&rsquo;s reward pool can cover them. Nothing here is financial advice. Examples on this page use made-up coins and numbers.
        </p>
        <nav className={s.footLinks} aria-label="Legal and social">
          <Link href="/terms">Terms</Link>
          <Link href="/risk">Risk disclosure</Link>
          <Link href="/privacy">Privacy</Link>
          <a href={X_URL} target="_blank" rel="noopener noreferrer">
            X (@Fumblepad)
          </a>
        </nav>
        <p className={s.copy}>© 2026 FUMPAD</p>
      </div>
    </footer>
  );
}
