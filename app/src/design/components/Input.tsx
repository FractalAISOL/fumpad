"use client";

import { type ComponentPropsWithoutRef, type ReactNode, useId } from "react";
import { cx } from "../cx";
import * as f from "../format";
import s from "./Input.module.css";

/* ── Field wrapper ────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  error,
  optional,
  children,
  id,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  id: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx(s.field, error ? s.invalid : undefined, className)}>
      <label htmlFor={id} className={s.label}>
        {label}
        {optional && <span className={s.optional}>Optional</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-msg`} className={s.error}>
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-msg`} className={s.hint}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/* ── Text input ───────────────────────────────────────────────────────────── */

export function TextInput({
  label,
  hint,
  error,
  optional,
  prefix,
  suffix,
  className,
  id: idProp,
  ...rest
}: Omit<ComponentPropsWithoutRef<"input">, "prefix"> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
}) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Field label={label} hint={hint} error={error} optional={optional} id={id} className={className}>
      <div className={s.box}>
        {prefix && <span className={s.affix}>{prefix}</span>}
        <input id={id} className={s.input} aria-invalid={error ? true : undefined} aria-describedby={hint || error ? `${id}-msg` : undefined} {...rest} />
        {suffix && <span className={s.affix}>{suffix}</span>}
      </div>
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  error,
  optional,
  className,
  id: idProp,
  ...rest
}: ComponentPropsWithoutRef<"textarea"> & { label: ReactNode; hint?: ReactNode; error?: ReactNode; optional?: boolean }) {
  const auto = useId();
  const id = idProp ?? auto;
  return (
    <Field label={label} hint={hint} error={error} optional={optional} id={id} className={className}>
      <div className={cx(s.box, s.areaBox)}>
        <textarea
          id={id}
          className={cx(s.input, s.area)}
          aria-invalid={error ? true : undefined}
          aria-describedby={hint || error ? `${id}-msg` : undefined}
          {...rest}
        />
      </div>
    </Field>
  );
}

/* ── Amount input ─────────────────────────────────────────────────────────── */

/** Strips everything but digits and one dot. */
export function parseAmount(raw: string): number {
  const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
  return isFinite(n) ? n : 0;
}

/**
 * The trade input: big Martian Mono figure, unit, balance with Max, quick percentages.
 * Over-balance is shown inline and announced; the parent disables the action.
 */
export function AmountInput({
  label,
  value,
  onChange,
  unit,
  balance,
  decimals = 2,
  quick = [25, 50, 75],
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  unit: ReactNode;
  balance?: number;
  decimals?: number;
  quick?: number[];
  error?: ReactNode;
  hint?: ReactNode;
}) {
  const id = useId();
  const amount = parseAmount(value);
  const over = balance !== undefined && amount > balance + 1e-9;
  const msg = error ?? (over ? "More than your balance." : undefined);
  const set = (n: number) => onChange(decimals === 0 ? f.int(Math.floor(n)) : String(Math.floor(n * 10 ** decimals) / 10 ** decimals));
  return (
    <div className={cx(s.amount, msg ? s.invalid : undefined)}>
      <div className={s.amountTop}>
        <label htmlFor={id} className={s.label}>
          {label}
        </label>
        {balance !== undefined && (
          <span className={s.balance}>
            Balance <span className="num">{decimals === 0 ? f.tokens(balance) : f.sol(balance)}</span>
          </span>
        )}
      </div>
      <div className={cx(s.box, s.amountBox)}>
        <input
          id={id}
          className={cx(s.input, s.amountInput)}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ""))}
          aria-invalid={msg ? true : undefined}
          aria-describedby={msg || hint ? `${id}-msg` : undefined}
        />
        <span className={s.unit}>{unit}</span>
      </div>
      {balance !== undefined && (
        <div className={s.quick} role="group" aria-label="Quick amounts">
          {quick.map((q) => (
            <button key={q} type="button" className="num" onClick={() => set((balance * q) / 100)}>
              {q}%
            </button>
          ))}
          <button type="button" onClick={() => set(balance)}>
            Max
          </button>
        </div>
      )}
      {(msg || hint) && (
        <p id={`${id}-msg`} className={msg ? s.error : s.hint} aria-live="polite">
          {msg ?? hint}
        </p>
      )}
    </div>
  );
}
