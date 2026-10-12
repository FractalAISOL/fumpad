"use client";

import { useEffect, useState } from "react";
import { getFumpadData, type HealthLevel, type SystemStatus } from "@/data";

export type StatusState = { status: SystemStatus | null; error: boolean; checkedAt: number | null };

/** `/v1/status`, polled while the tab is visible. A failed fetch reads as the API being down. */
export function useSystemStatus(pollMs = 60_000): StatusState {
  const [st, setSt] = useState<StatusState>({ status: null, error: false, checkedAt: null });
  useEffect(() => {
    let alive = true;
    const load = () => {
      if (document.visibilityState !== "visible") return;
      getFumpadData()
        .getStatus()
        .then((status) => alive && setSt({ status, error: false, checkedAt: Date.now() }))
        .catch(() => alive && setSt((p) => ({ ...p, error: true, checkedAt: Date.now() })));
    };
    load();
    const t = setInterval(load, pollMs);
    document.addEventListener("visibilitychange", load);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", load);
    };
  }, [pollMs]);
  return st;
}

export function levelOf(st: StatusState): HealthLevel | "loading" {
  if (st.error) return "down";
  return st.status?.level ?? "loading";
}

export const LEVEL_TEXT: Record<HealthLevel | "loading", string> = {
  ok: "All systems normal",
  degraded: "Running behind",
  down: "Something is down",
  unknown: "Waiting for a signal",
  loading: "Checking status",
};

/** "12 s", "4 min", "3 h", "2 days". */
export function age(secs: number | null): string {
  if (secs === null) return "never";
  if (secs < 90) return `${Math.round(secs)} s`;
  if (secs < 90 * 60) return `${Math.round(secs / 60)} min`;
  if (secs < 36 * 3600) return `${Math.round(secs / 3600)} h`;
  return `${Math.round(secs / 86_400)} days`;
}
