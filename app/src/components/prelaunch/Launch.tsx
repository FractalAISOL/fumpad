"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { IconX } from "@/design/components/Icons";
import { Greeter } from "./Greeter";
import { X_URL } from "./links";
import s from "./Sections.module.css";

/** Launch time, if public. Unset or unparseable = no countdown. */
const LAUNCH_AT = (() => {
  const raw = process.env.NEXT_PUBLIC_LAUNCH_AT?.trim();
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
})();
const API = process.env.NEXT_PUBLIC_FUMPAD_API?.replace(/\/+$/, "");

/* A one-second clock, client-only (the prerendered page shows no digits until hydration). */
let now: number | null = null;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
function subscribe(cb: () => void) {
  subs.add(cb);
  timer ??= setInterval(() => {
    now = Date.now();
    subs.forEach((f) => f());
  }, 1000);
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

function Countdown({ at }: { at: number }) {
  const t = useSyncExternalStore(
    subscribe,
    () => (now ??= Date.now()),
    () => null,
  );
  if (t === null) return <div className={s.countdown} aria-hidden="true" />;
  const left = Math.max(0, at - t);
  if (left === 0) return <p className={s.countNote}>Opening now.</p>;
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor(left / 3_600_000) % 24;
  const m = Math.floor(left / 60_000) % 60;
  const sec = Math.floor(left / 1000) % 60;
  const cells: [string, number][] = [
    ["days", d],
    ["hours", h],
    ["minutes", m],
    ["seconds", sec],
  ];
  return (
    <div className={s.countdown} role="timer" aria-label={`Opens in ${d} days, ${h} hours and ${m} minutes`}>
      {cells.map(([k, v]) => (
        <div key={k} className={s.countCell}>
          <span className={s.countNum}>{String(v).padStart(2, "0")}</span>
          <span className={s.countLbl}>{k}</span>
        </div>
      ))}
    </div>
  );
}

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; what: string; email: boolean } | { kind: "error"; msg: string };

function Waitlist({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<State>({ kind: "idle" });
  const [trap, setTrap] = useState("");
  useEffect(() => {
    if (state.kind !== "done") return;
    document.getElementById("waitlist-done")?.focus();
    onDone();
  }, [state.kind, onDone]);

  if (state.kind === "done") {
    return (
      <div id="waitlist-done" className={s.done} tabIndex={-1} role="status">
        <p className={s.doneHead}>You&rsquo;re on the list.</p>
        <p className={s.doneSub}>
          {state.email ? "We\u2019ll email you once, when FUMPAD opens." : `Saved ${state.what}.`} Launch news goes out first on{" "}
          <a href={X_URL} target="_blank" rel="noopener noreferrer">
            @Fumblepad
          </a>
          .
        </p>
      </div>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = value.trim();
    if (!v) return setState({ kind: "error", msg: "Add an email or an X handle." });
    if (!API) return setState({ kind: "error", msg: "The waitlist isn't connected on this deployment. Follow @Fumblepad for the launch." });
    setState({ kind: "sending" });
    try {
      const r = await fetch(`${API}/v1/waitlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contact: v, website: trap }),
      });
      if (r.ok) {
        const isEmail = v.includes("@") && !v.startsWith("@");
        return setState({ kind: "done", email: isEmail, what: isEmail ? v : `@${v.replace(/^@/, "").replace(/^.*\//, "")}` });
      }
      const body = (await r.json().catch(() => null)) as { error?: string } | null;
      setState({
        kind: "error",
        msg: r.status === 429 ? "Too many tries from this network. Wait a minute, then try again." : (body?.error ?? "That didn't go through. Try again in a moment."),
      });
    } catch {
      setState({ kind: "error", msg: "Couldn't reach the waitlist. Check your connection and try again." });
    }
  };

  const err = state.kind === "error" ? state.msg : null;
  return (
    <form className={s.form} onSubmit={submit} noValidate>
      <label htmlFor="waitlist-contact" className={s.formLabel}>
        Email or X handle
      </label>
      <div className={s.formRow}>
        <input
          id="waitlist-contact"
          className={s.input}
          type="text"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="you@example.com or @handle"
          maxLength={254}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (state.kind === "error") setState({ kind: "idle" });
          }}
          aria-invalid={err ? true : undefined}
          aria-describedby={err ? "waitlist-error" : "waitlist-hint"}
        />
        <button type="submit" className={s.submit} disabled={state.kind === "sending"}>
          {state.kind === "sending" ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
      {/* Honeypot: hidden from people and assistive tech; bots fill it. */}
      <input className={s.trap} type="text" name="website" tabIndex={-1} autoComplete="off" aria-hidden="true" value={trap} onChange={(e) => setTrap(e.target.value)} />
      {err ? (
        <p id="waitlist-error" className={s.formError} role="alert">
          {err}
        </p>
      ) : (
        <p id="waitlist-hint" className={s.formHint}>
          One message when it opens. No newsletter.
        </p>
      )}
    </form>
  );
}

export function Launch() {
  // Fumi points at the waitlist, then cheers once you're on it (same box: no layout shift).
  const [joined, setJoined] = useState(false);
  const onDone = useCallback(() => setJoined(true), []);
  return (
    <div className={s.launch}>
      <div className={s.launchTop}>
        <div className={s.launchCopy}>
          <h2 id="launch-title" className={s.launchTitle}>
            Coming to Solana mainnet.
          </h2>
          <p className={s.launchLede}>Launching soon. Get one message when it opens, or follow along on X.</p>
          {LAUNCH_AT !== null && <Countdown at={LAUNCH_AT} />}
        </div>
        {joined ? (
          <Greeter pose="cheering" quip="You’re in! See you at launch." className={s.launchFumi} />
        ) : (
          <Greeter pose="pointing" quip="One message at launch. That’s it." pop={false} className={s.launchFumi} />
        )}
      </div>
      <div className={s.launchActions}>
        <Waitlist onDone={onDone} />
        <a href={X_URL} className={s.xCta} target="_blank" rel="noopener noreferrer">
          <IconX width={18} height={18} aria-hidden="true" />
          Follow @Fumblepad
        </a>
      </div>
    </div>
  );
}
