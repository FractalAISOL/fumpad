"use client";

import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { cx } from "../cx";
import { IconSort } from "./Icons";
import s from "./Table.module.css";

export interface Column<R> {
  key: string;
  header: ReactNode;
  /** Right-align numbers. */
  align?: "start" | "end";
  render: (row: R, index: number) => ReactNode;
  /** Makes the column sortable. */
  sortValue?: (row: R) => number | string;
  /** Hide below this breakpoint to keep 375px free of horizontal scroll. */
  hideBelow?: "sm" | "md" | "lg";
  width?: string;
}

/**
 * Dense data table. Sortable headers expose aria-sort; numbers are tabular. `rowHref`
 * makes the whole row a link (the first cell carries the real anchor for keyboard and
 * screen readers; the rest of the row is a pointer shortcut).
 */
export function Table<R>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowLabel,
  highlight,
  caption,
  initialSort,
  empty,
  className,
}: {
  columns: Column<R>[];
  rows: R[];
  rowKey: (row: R) => string;
  rowHref?: (row: R) => string;
  rowLabel?: (row: R) => string;
  /** Rows to tint (the viewer's own). */
  highlight?: (row: R) => boolean;
  caption?: string;
  initialSort?: { key: string; dir: "asc" | "desc" };
  empty?: ReactNode;
  className?: string;
}) {
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const get = col.sortValue;
    return [...rows].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      const d = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.dir === "asc" ? d : -d;
    });
  }, [rows, columns, sort]);

  const toggle = (key: string) =>
    setSort((cur) => (cur?.key === key ? { key, dir: cur.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }));

  if (!rows.length && empty) return <>{empty}</>;

  return (
    <div className={cx(s.scroll, className)}>
      <table className={s.tbl}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(c.align === "end" && s.end, c.hideBelow && s[`hide-${c.hideBelow}`])}
                  style={c.width ? { width: c.width } : undefined}
                  aria-sort={c.sortValue ? (active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none") : undefined}
                >
                  {c.sortValue ? (
                    <button type="button" className={s.sortBtn} onClick={() => toggle(c.key)}>
                      {c.header}
                      <IconSort dir={active ? sort!.dir : false} />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r, i) => {
            const href = rowHref?.(r);
            return (
              <tr key={rowKey(r)} className={cx(href && s.linked, highlight?.(r) && s.me)}>
                {columns.map((c, ci) => (
                  <td key={c.key} className={cx(c.align === "end" && s.end, c.hideBelow && s[`hide-${c.hideBelow}`])}>
                    {ci === 0 && href ? (
                      <Link href={href} className={s.rowLink} aria-label={rowLabel?.(r)}>
                        {c.render(r, i)}
                      </Link>
                    ) : (
                      c.render(r, i)
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
