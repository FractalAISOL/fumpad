import type { Metadata } from "next";
import Link from "next/link";
import { CLUSTER_LABEL } from "@/chain/cluster";
import { DocPage, DocSection, DraftNotice } from "@/components/docs/Doc";

export const metadata: Metadata = { title: "Terms", description: "Draft terms of use for FUMPAD, pending legal review." };

const NETWORK = CLUSTER_LABEL ? `Solana ${CLUSTER_LABEL.toLowerCase()}` : "Solana";

const TOC = [
  { id: "status", label: "Status of these terms" },
  { id: "service", label: "What FUMPAD is" },
  { id: "eligibility", label: "Eligibility and regions" },
  { id: "wallets", label: "Your wallet and keys" },
  { id: "rewards", label: "Fumble rewards" },
  { id: "advice", label: "No financial advice" },
  { id: "coins", label: "Coins made by users" },
  { id: "use", label: "Acceptable use" },
  { id: "liability", label: "No warranty, limited liability" },
  { id: "changes", label: "Changes" },
];

export default function TermsPage() {
  return (
    <DocPage
      title="Terms of use"
      lede="The rules for using FUMPAD's website and app. By using FUMPAD you agree to them."
      notice={<DraftNotice updated="October 13, 2026" />}
      toc={TOC}
    >
      <DocSection id="status" title="Status of these terms">
        <p>
          These terms are a working draft, pending legal review. They describe how FUMPAD is meant to be used today and will be replaced by reviewed
          terms before any mainnet launch.
        </p>
      </DocSection>
      <DocSection id="service" title="What FUMPAD is">
        <p>
          FUMPAD is experimental software: an interface to smart contracts on {NETWORK} for launching and trading tokens, and for filing and claiming fumble
          tickets. {CLUSTER_LABEL ? `On ${CLUSTER_LABEL.toLowerCase()}, tokens and SOL have no market value.` : ""} The contracts run on a public
          blockchain; FUMPAD does not hold your funds and cannot reverse a transaction.
        </p>
      </DocSection>
      <DocSection id="eligibility" title="Eligibility and regions">
        <ul>
          <li>You must be old enough to form a binding contract where you live, and at least 18.</li>
          <li>
            You may not use FUMPAD from, or on behalf of anyone in, a country or region under comprehensive sanctions (including those maintained by the
            US, UK, EU or UN), or anywhere using it would be unlawful. The full list of restricted regions is pending legal review.
          </li>
          <li>You are responsible for knowing and following the laws, tax rules and reporting duties that apply to you.</li>
        </ul>
      </DocSection>
      <DocSection id="wallets" title="Your wallet and keys">
        <p>
          You control your wallet. Your Trading wallet is non-custodial: FUMPAD never sees its private key. You are responsible for your login, your
          keys and every transaction you sign. Lost keys or a compromised login can mean lost funds, and nobody, including FUMPAD, can recover them.
        </p>
      </DocSection>
      <DocSection id="rewards" title="Fumble rewards">
        <p>
          A ticket is a conditional claim on one coin&apos;s reward pool, under the rules in <Link href="/how-it-works">How it works</Link>.{" "}
          <b>Fumble rewards are not insurance and are not guaranteed.</b> A claim pays only if the coin graduates, its median price holds at the trigger,
          the claim is made in time, and that coin&apos;s pool can cover it. Rules and parameters can change under the protocol&apos;s timelock.
        </p>
        <p>
          Tickets are created by FUMPAD&apos;s keepers attesting qualifying sells, including sells made on other apps. An attestation can be late, can be
          missing if a sell can&apos;t be verified, and can be voided during its challenge window if it doesn&apos;t match the chain. Other apps that trade
          FUMPAD coins are run by third parties; FUMPAD doesn&apos;t control or endorse them.
        </p>
      </DocSection>
      <DocSection id="advice" title="No financial advice">
        <p>
          Nothing on FUMPAD is financial, investment, legal or tax advice, or a recommendation to buy or sell anything. Coin pages, leaderboards and
          tickets are information, not endorsements.
        </p>
      </DocSection>
      <DocSection id="coins" title="Coins made by users">
        <p>
          Anyone can launch a coin. FUMPAD does not vet, endorse or stand behind any coin, its name, image, description or links. Treat every coin as
          able to go to zero.
        </p>
      </DocSection>
      <DocSection id="use" title="Acceptable use">
        <p>
          Don&apos;t use FUMPAD to break the law, launder money, evade sanctions, manipulate markets, impersonate others, or attack the contracts, the app or
          other users. FUMPAD may block access to its interface for anyone who does.
        </p>
      </DocSection>
      <DocSection id="liability" title="No warranty, limited liability">
        <p>
          FUMPAD is provided as is, without warranties of any kind. Smart contracts can have bugs, and networks, wallets, oracles and third-party
          services can fail. To the extent the law allows, FUMPAD is not liable for losses from using it. See the <Link href="/risk">risk disclosure</Link>.
        </p>
      </DocSection>
      <DocSection id="changes" title="Changes">
        <p>These terms will change, starting with the reviewed version. The date at the top shows the last edit.</p>
      </DocSection>
    </DocPage>
  );
}
