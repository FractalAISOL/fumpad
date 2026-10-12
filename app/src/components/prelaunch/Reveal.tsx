"use client";

import { type ReactNode, useEffect, useRef } from "react";

/**
 * Marks its element `data-in` once it is a third of the way into the viewport, so an
 * instrument can play its one entrance (CSS owns the motion; reduced motion collapses it).
 * Without JS the content is simply shown: CSS only hides it under `[data-reveal="armed"]`.
 */
export function Reveal({ className, children, as: Tag = "div" }: { className?: string; children: ReactNode; as?: "div" | "figure" }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.dataset.reveal = "armed";
    const io = new IntersectionObserver(
      ([e]) => {
        if (e.isIntersecting) {
          el.dataset.in = "1";
          io.disconnect();
        }
      },
      { rootMargin: "0px 0px -30% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag ref={ref as never} className={className}>
      {children}
    </Tag>
  );
}
