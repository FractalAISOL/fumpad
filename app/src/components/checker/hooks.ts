"use client";

import { useEffect, useRef, useState } from "react";

/** Wall clock that ticks every `ms` (countdowns). Starts from `initial` so server HTML and hydration agree. */
export function useClock(ms: number, initial: number): number {
  const [now, setNow] = useState(initial);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sync to the real clock once mounted
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** The latest value of `fn` for callbacks registered once. */
export function useLatest<T>(fn: T) {
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  return ref;
}
