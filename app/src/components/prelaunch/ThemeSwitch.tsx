"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun } from "@/design/components/Icons";
import { THEME_KEY as KEY } from "../shell/theme";
import s from "./Room.module.css";

/* Same storage key as the app's toggle, so a choice made here carries into the app at launch. */

/**
 * The waiting room is dark unless you chose light (here or in the app). Runs before paint, so
 * there is no flash; the root THEME_SCRIPT has already applied a stored choice.
 */
export const ROOM_THEME_SCRIPT = `(function(){var d=document.documentElement;try{var t=localStorage.getItem("${KEY}");d.setAttribute("data-theme",t==="light"?"light":"dark")}catch(e){d.setAttribute("data-theme","dark")}})()`;

export function ThemeSwitch() {
  const [mode, setMode] = useState<"dark" | "light">("dark");
  useEffect(() => {
    // Sync with what the pre-paint script applied.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
  }, []);
  const next = mode === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className={s.iconBtn}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      onClick={() => {
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem(KEY, next);
        } catch {}
        setMode(next);
      }}
    >
      {mode === "dark" ? <IconSun width={18} height={18} /> : <IconMoon width={18} height={18} />}
    </button>
  );
}
