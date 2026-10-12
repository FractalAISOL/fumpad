"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Button, cx } from "@/design";
import { type LaneFilter, type LaneId, LANE_NAME } from "./model";
import s from "./Board.module.css";

type Key = "minMcUsd" | "minVolUsd" | "minHolders" | "curveMin" | "curveMax" | "maxAgeMin";

const FIELDS: { key: Key; label: string; prefix?: string; suffix?: string; curveOnly?: boolean }[] = [
  { key: "minMcUsd", label: "Min market cap", prefix: "$" },
  { key: "minVolUsd", label: "Min 24h volume", prefix: "$" },
  { key: "minHolders", label: "Min holders" },
  { key: "curveMin", label: "Curve from", suffix: "%", curveOnly: true },
  { key: "curveMax", label: "Curve to", suffix: "%", curveOnly: true },
  { key: "maxAgeMin", label: "Max age", suffix: "min" },
];

/** "12,000" / "12k" / "1.5m" → number; empty → undefined; junk → NaN. */
function parse(raw: string): number | undefined {
  const t = raw.trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!t) return undefined;
  const m = /^(\d*\.?\d+)([km]?)$/.exec(t);
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : 1);
}

/**
 * A lane's filter popover. Changes apply as you type (the lane re-filters live); Escape or
 * a click outside closes it and returns focus to the button that opened it.
 */
export function FilterPanel({
  lane,
  filter,
  onChange,
  onClose,
  id,
}: {
  lane: LaneId;
  filter: LaneFilter;
  onChange: (f: LaneFilter) => void;
  onClose: () => void;
  id: string;
}) {
  const base = useId();
  const ref = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Record<Key, string>>(() => {
    const out = {} as Record<Key, string>;
    for (const f of FIELDS) out[f.key] = filter[f.key] === undefined ? "" : String(filter[f.key]);
    return out;
  });

  useEffect(() => {
    ref.current?.querySelector<HTMLInputElement>("input")?.focus();
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (ref.current && t && !ref.current.contains(t) && !t.closest(`[aria-controls="${id}"]`)) onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [id, onClose]);

  const set = (key: Key, raw: string) => {
    setDraft((d) => ({ ...d, [key]: raw }));
    const v = parse(raw);
    if (v === undefined || Number.isFinite(v)) {
      const capped = v !== undefined && (key === "curveMin" || key === "curveMax") ? Math.min(100, v) : v;
      onChange({ ...filter, [key]: capped });
    }
  };
  const fields = FIELDS.filter((f) => !f.curveOnly || lane !== "graduated");

  return (
    <div
      ref={ref}
      id={id}
      role="group"
      aria-label={`Filter ${LANE_NAME[lane]}`}
      className={s.pop}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className={s.popGrid}>
        {fields.map((f) => {
          const bad = Number.isNaN(parse(draft[f.key]));
          return (
            <label key={f.key} className={s.popField} htmlFor={`${base}-${f.key}`}>
              <span className={s.popLabel}>{f.label}</span>
              <span className={cx(s.popBox, bad && s.popBad)}>
                {f.prefix && <span className={s.popAffix}>{f.prefix}</span>}
                <input
                  id={`${base}-${f.key}`}
                  className={cx("num", s.popInput)}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="Any"
                  value={draft[f.key]}
                  aria-invalid={bad || undefined}
                  onChange={(e) => set(f.key, e.target.value)}
                />
                {f.suffix && <span className={s.popAffix}>{f.suffix}</span>}
              </span>
            </label>
          );
        })}
      </div>
      <label className={s.popCheck}>
        <input type="checkbox" checked={!!filter.hideFlagged} onChange={(e) => onChange({ ...filter, hideFlagged: e.target.checked || undefined })} />
        <span>
          Hide flagged creators
          <small>Wallets the indexer linked to other wallets or caught rebuying elsewhere.</small>
        </span>
      </label>
      <div className={s.popFoot}>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft({ minMcUsd: "", minVolUsd: "", minHolders: "", curveMin: "", curveMax: "", maxAgeMin: "" });
            onChange({});
          }}
        >
          Reset
        </Button>
        <Button variant="line" size="sm" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
