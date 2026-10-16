/**
 * The disclaimer gate's text: the one place to edit it. Rendered by `components/legal/DisclaimerGate.tsx`.
 *
 * PENDING LAWYER REVIEW: this copy is a draft written for FUMPAD and has not been approved by counsel yet.
 * After a material change, bump DISCLAIMER_VERSION in `./disclaimer.ts` so every visitor confirms again.
 *
 * No Fumi, no jokes, no orange here (marketing/STYLE-ANIME.md: never on legal surfaces). Plain, short sentences.
 */
import type { Cluster } from "@/chain/cluster";

/** A run of text, or a link to one of our legal pages (opens in a new tab from the gate). */
export type Segment = string | { href: string; label: string };

export interface DisclaimerCopy {
  title: string;
  intro: string;
  /** Accessible name of the scrollable list. */
  listLabel: string;
  items: Segment[][];
  checkbox: string;
  confirm: string;
  leave: string;
}

/** Wording follows the build's cluster: real funds on mainnet, test funds on devnet/testnet/localnet. */
export function disclaimerCopy(cluster: Cluster): DisclaimerCopy {
  const network = cluster === "mainnet" ? null : cluster.charAt(0).toUpperCase() + cluster.slice(1);
  const funds = network
    ? `This version runs on Solana ${network.toLowerCase()}: launches and trades use test funds with no value. On mainnet they use real funds.`
    : "Launches and trades use real funds on Solana mainnet.";
  return {
    title: "Before you use FUMPAD",
    intro: "Read each point. By continuing you confirm that all of them apply to you.",
    listLabel: "Risks and conditions",
    items: [
      [
        "FUMPAD is experimental software, provided “as is”. Nothing on this site is financial, investment, legal or tax advice, or an offer to buy or sell a security or any other financial instrument.",
      ],
      ["Crypto assets are high risk. A coin launched here can lose all of its value, and blockchain transactions can’t be reversed. You can lose all the money you use."],
      [
        `${funds} A launch can’t be undone, and a coin’s fee and fee split are fixed when it launches. FUMPAD coins also trade on other apps, which FUMPAD doesn’t control.`,
      ],
      [
        "Fumble Tickets are conditional. They are not insurance and not a guarantee. A ticket pays only if the coin graduates, holds 10× your sell price on the 30-minute average, and the coin’s reward pool can cover it. Tickets can be voided during the 6-hour safety check. Many tickets will never pay.",
      ],
      [
        "Coins launched on FUMPAD, including FUMPAD’s own coin, give you no rights: no ownership, no share of revenue or profit, and no claim on FUMPAD or its treasury. Nobody promises a price, a payout or a return.",
      ],
      [
        "You are 18 or older and not a U.S. person. You don’t live in, and you aren’t currently in, the United States, the United Kingdom, Canada, Cuba, Iran, North Korea, Syria, Russia, Belarus, Myanmar, or the Crimea, Donetsk, Luhansk, Kherson or Zaporizhzhia regions of Ukraine. You aren’t on any sanctions list, and you don’t use a VPN or any other tool to hide where you are. Using this service is legal where you live.",
      ],
      [
        "You accept the ",
        { href: "/terms", label: "Terms" },
        ", the ",
        { href: "/privacy", label: "Privacy Policy" },
        " and the ",
        { href: "/risk", label: "Risk disclosure" },
        ".",
      ],
    ],
    checkbox: "I confirm all of the above, and I accept the Terms.",
    confirm: "I confirm and continue",
    leave: "I do not meet these conditions · leave",
  };
}
