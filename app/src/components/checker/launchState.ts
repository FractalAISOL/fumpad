/**
 * The launch-window page's two states (app/LAUNCH.md), without React (unit-tested by `launchState.test.ts`):
 *   `soon` — no first coin yet (NEXT_PUBLIC_CHECKER_MINT unset or not a valid mint): a pre-launch hero, the rules and
 *            the video; no coin panel, trade links or checker box.
 *   `live` — the mint is set: the coin panel and "Did you fumble?" checker above the rules.
 * Copy for each state, including the page metadata, lives here so the two never mix ("live" only when a mint is set).
 * No `@/` imports.
 */
import { isPublicKey } from "./model";

export type LaunchState = { state: "soon"; mint: null } | { state: "live"; mint: string };

/** NEXT_PUBLIC_CHECKER_MINT → the page's state. Anything that isn't a 32-byte base58 key is "no coin yet". */
export function launchState(mintEnv: string | undefined | null): LaunchState {
  const mint = (mintEnv ?? "").trim();
  return isPublicKey(mint) ? { state: "live", mint } : { state: "soon", mint: null };
}

/** Which blocks the page renders in each state. The rules, fees and video show in both. */
export function launchSections(state: LaunchState["state"]) {
  const live = state === "live";
  return { opensBanner: live, soonBanner: !live, intro: !live, follow: !live, coin: live, checker: live, rules: true };
}

export interface HeroCopy {
  eyebrow: string;
  title: string;
  quiet: string;
  /** Fumi's bubble (≤ 8 words, marketing/STYLE-ANIME.md). */
  bubble: string;
}

export const HERO: Record<LaunchState["state"], HeroCopy> = {
  soon: { eyebrow: "Coming soon", title: "The first coin launches soon.", quiet: "Sold too early? Same.", bubble: "Hi, fumbler! Almost time." },
  live: { eyebrow: "Launch window", title: "The first coin is live.", quiet: "Sold too early? Check.", bubble: "Hi, fumbler!" },
};

const fmtPct = (bps: number) => `${Number.isInteger(bps / 100) ? bps / 100 : (bps / 100).toFixed(1)}%`;

/** The pre-launch lede: what FUMPAD is, in two sentences, with the numbers from Global.params (10× / 10% on mainnet). */
export function soonLede(p: { triggerMultiple: number; claimBps: number }): string {
  return (
    "FUMPAD is a Solana launchpad for people who sell too early. " +
    `Sell a FUMPAD coin on any app and you get a Fumble Ticket at your sell price; if the coin later holds ${p.triggerMultiple}× that price, ` +
    `you can claim ${fmtPct(p.claimBps)} of the tokens you sold, from the coin’s own Reward Pool.`
  );
}

/** Under the lede: no promises, and where the real mint comes from. */
export const SOON_CAVEAT =
  "Nothing is guaranteed: most memecoins go to zero, and claims pay only while the coin’s Reward Pool can cover them. The first coin’s address will be posted by @Fumblepad and shown on this page; trust no other.";

export const SOON_BANNER = { strong: "Coming soon.", rest: "The first coin launches here, then the full app opens." };

export interface PageMeta {
  title: string;
  description: string;
  socialTitle: string;
  socialDescription: string;
}

/** Title, description and OG/Twitter text for each state (the image is the Fumi card in `app/live/`). */
export const META: Record<LaunchState["state"], PageMeta> = {
  soon: {
    title: "FUMPAD — The first coin launches soon.",
    description:
      "FUMPAD is a Solana launchpad for people who sell too early: sell, and if the coin later holds 10× your price, claim 10% of what you sold. The first coin launches soon. Follow @Fumblepad.",
    socialTitle: "FUMPAD — The first coin launches soon.",
    socialDescription: "The launchpad for people who sell too early. Sell, and if the coin later holds 10× your price, claim 10% of what you sold. Coming soon to Solana.",
  },
  live: {
    title: "FUMPAD — The first coin is live. Did you fumble?",
    description: "The first FUMPAD coin is live on Solana. Paste a wallet to see which sells count, where each ticket stands, and the market cap it claims at.",
    socialTitle: "The first FUMPAD coin is live. Did you fumble?",
    socialDescription: "Sell on any app. If the coin later holds 10× your price, claim 10% of what you sold. Check any wallet.",
  },
};
