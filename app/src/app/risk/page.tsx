import type { Metadata } from "next";
import Link from "next/link";
import { CLUSTER_LABEL } from "@/chain/cluster";
import { DocPage, DocSection, DraftNotice } from "@/components/docs/Doc";

export const metadata: Metadata = { title: "Risk disclosure", description: "Draft risk disclosure for FUMPAD, pending legal review." };

const TOC = [
  { id: "experimental", label: "Experimental software" },
  { id: "network", label: "Network" },
  { id: "market", label: "Market risk" },
  { id: "rewards", label: "Rewards are not guaranteed" },
  { id: "contracts", label: "Smart-contract risk" },
  { id: "dependencies", label: "Services FUMPAD depends on" },
  { id: "keys", label: "Keys and wallets" },
  { id: "law", label: "Law, tax and your region" },
];

export default function RiskPage() {
  return (
    <DocPage
      title="Risk disclosure"
      lede="What can go wrong when you use FUMPAD. Read it before you trade; only use money you can afford to lose."
      notice={<DraftNotice updated="October 12, 2026" />}
      toc={TOC}
    >
      <DocSection id="experimental" title="Experimental software">
        <p>
          FUMPAD is new, experimental software. It can behave in ways nobody expected, be paused, or stop working. Features and parameters will change.
        </p>
      </DocSection>
      <DocSection id="network" title="Network">
        {CLUSTER_LABEL ? (
          <p>
            FUMPAD currently runs on Solana {CLUSTER_LABEL.toLowerCase()}, a test network. Tokens and SOL there have no market value, balances can be reset,
            and nothing you do there carries over to mainnet.
          </p>
        ) : (
          <p>FUMPAD runs on Solana mainnet. Transactions are final and use real funds. Network congestion or outages can delay or fail transactions.</p>
        )}
      </DocSection>
      <DocSection id="market" title="Market risk">
        <p>
          Coins launched on FUMPAD are highly speculative. Most lose nearly all their value; any of them can go to zero in minutes. Prices move on thin
          liquidity, and a large trade can move them sharply against you.
        </p>
      </DocSection>
      <DocSection id="rewards" title="Rewards are not guaranteed">
        <p>
          <b>Fumble rewards are not insurance.</b> A ticket pays only if the coin graduates, its median price holds at the trigger, you (or auto-claim)
          claim within the claim window, and the coin&apos;s reward pool can cover the payout. A claim the pool can&apos;t cover waits in a queue, possibly
          forever. The rules are in <Link href="/how-it-works">How it works</Link>.
        </p>
      </DocSection>
      <DocSection id="contracts" title="Smart-contract risk">
        <p>
          FUMPAD&apos;s contracts may contain bugs that lose or lock funds. Reviews and tests reduce that risk; they don&apos;t remove it. The main program is
          upgradeable by its admin, under a timelock for parameter changes; the liquidity locker is not upgradeable, which also means a bug in it
          can&apos;t be fixed.
        </p>
      </DocSection>
      <DocSection id="dependencies" title="Services FUMPAD depends on">
        <p>
          FUMPAD relies on Solana, PumpSwap, the Pyth price feed, RPC providers, its own keepers and indexer, and Privy for login and the Trading wallet.
          Any of them can fail, change or be unavailable, which can delay or block trades, tickets and claims.
        </p>
      </DocSection>
      <DocSection id="keys" title="Keys and wallets">
        <p>
          Whoever controls your login or keys controls your funds. Phishing, malware and lost keys cause losses no one can reverse. FUMPAD will never ask
          for your private key or seed phrase.
        </p>
      </DocSection>
      <DocSection id="law" title="Law, tax and your region">
        <p>
          Crypto rules differ by country and change often. FUMPAD may be unavailable or unlawful where you are. You are responsible for compliance and for
          any taxes. Nothing here is financial, legal or tax advice.
        </p>
      </DocSection>
    </DocPage>
  );
}
