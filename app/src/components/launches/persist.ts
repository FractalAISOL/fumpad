"use client";

/**
 * Per-browser preferences in localStorage, read through `useSyncExternalStore` so the
 * server render (and hydration) use the default and the stored value follows without a
 * mismatch. Every storage access is wrapped: private windows, blocked site data and
 * previews throw or return nothing, and the board must work the same without them.
 */
import { useCallback, useSyncExternalStore } from "react";

const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function read<T>(key: string, fallback: T, clean: (raw: unknown) => T): T {
  if (cache.has(key)) return cache.get(key) as T;
  let v = fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null) v = clean(JSON.parse(raw));
  } catch {
    /* unavailable or malformed: keep the default */
  }
  cache.set(key, v);
  return v;
}

export function usePersisted<T>(key: string, fallback: T, clean: (raw: unknown) => T): [T, (v: T) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key !== key) return;
        cache.delete(key);
        cb();
      };
      window.addEventListener("storage", onStorage);
      return () => {
        set.delete(cb);
        window.removeEventListener("storage", onStorage);
      };
    },
    [key],
  );
  const value = useSyncExternalStore(
    subscribe,
    () => read(key, fallback, clean),
    () => fallback,
  );
  const update = useCallback(
    (v: T) => {
      cache.set(key, v);
      try {
        window.localStorage.setItem(key, JSON.stringify(v));
      } catch {
        /* storage blocked: the value still holds for this page view */
      }
      listeners.get(key)?.forEach((l) => l());
    },
    [key],
  );
  return [value, update];
}
