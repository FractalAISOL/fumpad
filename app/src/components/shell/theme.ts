/**
 * The theme preference, shared by the root layout's pre-paint script and the toggles. A plain
 * module (not "use client"): importing a value from a client module into the server layout
 * pulls that module's whole client graph (wallet, Solana libraries) into every page's bundle.
 */
export const THEME_KEY = "fumpad-theme";

/** Inline, pre-paint: applies the saved theme before the first frame (no flash). */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}})()`;
