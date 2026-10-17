import type { Metadata } from "next";
import { DocPage, DocSection, UpdatedNotice } from "@/components/docs/Doc";

export const metadata: Metadata = { title: "Privacy", description: "Privacy notice for FUMPAD." };

const TOC = [
  { id: "public", label: "Public by design" },
  { id: "login", label: "Login and the Trading wallet" },
  { id: "waitlist", label: "The launch waitlist" },
  { id: "device", label: "On your device" },
  { id: "logs", label: "Servers and logs" },
  { id: "sharing", label: "Who else sees data" },
  { id: "choices", label: "Your choices" },
];

export default function PrivacyPage() {
  return (
    <DocPage
      title="Privacy"
      lede="What FUMPAD knows about you, where it comes from and who else sees it."
      notice={<UpdatedNotice updated="October 12, 2026" />}
      toc={TOC}
    >
      <DocSection id="public" title="Public by design">
        <p>
          Wallet addresses, trades, tickets and claims are recorded on a public blockchain. FUMPAD indexes them to show feeds, coin pages, profiles and
          leaderboards. On-chain data is permanent: nobody, including FUMPAD, can delete it.
        </p>
      </DocSection>
      <DocSection id="login" title="Login and the Trading wallet">
        <p>
          Login (email, X, Google or a Solana wallet) and the embedded Trading wallet are provided by Privy. Privy processes your login details under its
          own privacy policy. FUMPAD receives your wallet address and account identifier, never your private key.
        </p>
      </DocSection>
      <DocSection id="waitlist" title="The launch waitlist">
        <p>
          If you join the waitlist, FUMPAD stores the email address or X handle you give, the time, and a one-way hash of your IP address (used only to
          limit sign-ups per network; the address itself isn&apos;t stored). It&apos;s used to tell you once when FUMPAD opens, and nothing else.
        </p>
      </DocSection>
      <DocSection id="device" title="On your device">
        <p>
          The app stores a few preferences in your browser, such as theme and board filters. They stay on your device. FUMPAD does not use advertising
          trackers.
        </p>
      </DocSection>
      <DocSection id="logs" title="Servers and logs">
        <p>
          The hosting and API providers that run FUMPAD keep standard request logs (IP address, browser, time) for security and debugging, for a limited
          time.
        </p>
      </DocSection>
      <DocSection id="sharing" title="Who else sees data">
        <p>
          Service providers that run parts of FUMPAD: hosting, the API database, Solana RPC providers and Privy. FUMPAD doesn&apos;t sell personal data.
        </p>
      </DocSection>
      <DocSection id="choices" title="Your choices">
        <p>
          You can use FUMPAD without logging in to browse. You can clear browser storage at any time. Contact details for privacy requests will be added
          with the reviewed version of this notice.
        </p>
      </DocSection>
    </DocPage>
  );
}
