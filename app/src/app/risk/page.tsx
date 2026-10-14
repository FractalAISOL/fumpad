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
  { id: "meteora", label: "Meteora" },
  { id: "attestation", label: "Keeper attestations" },
  { id: "dependencies", label: "Services FUMPAD depends on" },
  { id: "keys", label: "Keys and wallets" },
  { id: "law", label: "Law, tax and your region" },
];

export default function RiskPage() {
  return (
    <DocPage
      title="Risk disclosure"
      lede="What can go wrong when you use FUMPAD. Read it before you trade; only use money you can afford to lose."
      notice={<DraftNotice updated="October 13, 2026" />}
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
          FUMPAD&apos;s contracts may contain bugs that lose or lock funds. Reviews and tests reduce that risk; they don&apos;t remove it. The FUMPAD program
          is upgradeable by its admin. Parameter changes wait 1 hour and changes to the admin keys wait 6 hours before they apply, so
          the rules can change at short notice. Trading, the bonding curve and the locked liquidity run on Meteora&apos;s
          programs, which FUMPAD doesn&apos;t control (next section).
        </p>
      </DocSection>
      <DocSection id="meteora" title="Meteora">
        <p>
          Every FUMPAD coin trades on Meteora&apos;s Dynamic Bonding Curve and, after graduation, a Meteora DAMM v2 pool. That brings risks FUMPAD can&apos;t
          remove:
        </p>
        <ul>
          <li>
            <b>Upgrades.</b> Meteora can upgrade both programs at any time through a single upgrade authority; whether it is a multisig is unverified. An
            upgrade could change fees, the liquidity lock or anything else, for every coin at once.
          </li>
          <li>
            <b>Pool controls.</b> Meteora&apos;s operators can disable trading on a DAMM v2 pool or change its fee, including a FUMPAD coin&apos;s pool.
          </li>
          <li>
            <b>Fees.</b> Meteora keeps 20% of every trading fee and 0.2% of the liquidity at graduation. These go to Meteora, not to the reward pool.
          </li>
          <li>
            <b>Bugs and outages.</b> A bug or outage in Meteora&apos;s programs or apps can stop trading or lose funds, and FUMPAD can&apos;t fix it.
          </li>
          <li>
            <b>Other pools and apps.</b> Anyone can open other pools for a FUMPAD coin; sells there don&apos;t file tickets. Apps that route trades to
            Meteora are third parties with their own fees and risks.
          </li>
        </ul>
      </DocSection>
      <DocSection id="attestation" title="Keeper attestations">
        <p>
          Tickets exist because FUMPAD&apos;s keepers attest qualifying sells (two of three must agree). If keepers are down, disagree or can&apos;t attribute a
          sell to its seller, a sell may get its ticket late or not at all. A ticket can be voided within its challenge window if its attestation was wrong.
          Keys controlling the keepers or the guardian could be lost or stolen; FUMPAD&apos;s safeguards limit, but don&apos;t remove, the damage.
        </p>
      </DocSection>
      <DocSection id="dependencies" title="Services FUMPAD depends on">
        <p>
          FUMPAD relies on Solana, Meteora, the Pyth price feed, RPC providers, its own keepers and indexer, and Privy for login and the Trading wallet.
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
