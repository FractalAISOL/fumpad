import type { ReactNode } from "react";
import { cx } from "@/design";
import s from "./Doc.module.css";

export type TocItem = { id: string; label: string };

/**
 * Reading pages (How it works, Terms, Risk, Privacy): a title block, an "On this page" index
 * (sticky beside the text from 1000 px, a wrapping row above it below), and the sections.
 * `companion`: an optional sticky rail right of the text from 1200 px (How it works: Fumi). Legal pages never pass one.
 */
export function DocPage({
  title,
  lede,
  notice,
  toc,
  aside,
  companion,
  children,
}: {
  title: string;
  lede: ReactNode;
  notice?: ReactNode;
  toc: TocItem[];
  aside?: ReactNode;
  companion?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={cx("wrap", s.page)}>
      <header className={s.head}>
        <div className={s.headText}>
          <h1 className={s.h1}>{title}</h1>
          <p className={s.lede}>{lede}</p>
          {notice}
        </div>
        {aside && <div className={s.headAside}>{aside}</div>}
      </header>
      <div className={cx(s.layout, companion != null && s.layoutCompanion)}>
        <nav className={s.toc} aria-label="On this page">
          <p className={s.tocTitle}>On this page</p>
          <ul>
            {toc.map((t) => (
              <li key={t.id}>
                <a href={`#${t.id}`}>{t.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <article className={s.body}>{children}</article>
        {companion != null && <div className={s.companion}>{companion}</div>}
      </div>
    </div>
  );
}

export function DocSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className={s.section} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className={s.h2}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** The rule's numbers, one per row, each with its plain sentence. */
export function Facts({ rows, label }: { rows: { k: ReactNode; v: ReactNode; key?: string }[]; label: string }) {
  return (
    <dl className={s.facts} aria-label={label}>
      {rows.map((r, i) => (
        <div key={r.key ?? i}>
          <dt>{r.k}</dt>
          <dd>{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Legal pages ship as drafts until reviewed; the notice says so above the text. */
export function DraftNotice({ updated }: { updated: string }) {
  return (
    <p className={s.draft} role="note">
      <b>Draft, pending legal review.</b> This text is a placeholder, not final terms. Last edited {updated}.
    </p>
  );
}
