"use client";

import Link from "next/link";
import { cx } from "@/design";
import s from "./Status.module.css";
import { LEVEL_TEXT, levelOf, useSystemStatus } from "./useStatus";

/** Footer: a small dot + the overall level, linking to /status. */
export function StatusDot() {
  const level = levelOf(useSystemStatus(60_000));
  return (
    <Link href="/status" prefetch={false} className={s.link}>
      <span className={cx(s.dot, s[level])} aria-hidden="true" />
      <span>{LEVEL_TEXT[level]}</span>
    </Link>
  );
}
