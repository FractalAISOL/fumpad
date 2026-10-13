import type { NextConfig } from "next";
import { securityHeaders } from "./src/security/headers";
import { rpcWarnings } from "./src/security/rpc";

// M-8: NEXT_PUBLIC_SOLANA_RPC ships to every browser (LAUNCH.md → "Frontend RPC key").
for (const w of rpcWarnings(process.env)) console.warn(`[fumpad] warning: ${w}`);

const nextConfig: NextConfig = {
  // The FUMPAD deployment (src/chain/cluster.ts): @fumpad/sdk reads `process.env.FUMPAD_PROGRAM_ID` /
  // `FUMPAD_CLUSTER`; inline the app's NEXT_PUBLIC_ values under those names (server and browser bundles alike) so
  // the SDK and the app's allow-list use the same program. src/chain/allowlist.ts refuses to load if they differ.
  env: {
    FUMPAD_PROGRAM_ID: process.env.NEXT_PUBLIC_FUMPAD_PROGRAM_ID ?? "",
    FUMPAD_CLUSTER: process.env.NEXT_PUBLIC_FUMPAD_CLUSTER ?? "",
  },
  cacheComponents: true,
  partialPrefetching: true,
  // @fumpad/sdk is vendored as a packed tarball (vendor/fumpad-sdk-*.tgz) so the app deploys
  // on its own. After changing services/sdk, run `npm run sdk` to repack it.
  // The coin list moved from /coins to /launches; old links keep working. /c/<mint> is the short
  // coin link (share cards print it); /c/<SYMBOL> still works as a lookup (chooser if ambiguous).
  // H-5: CSP (enforced in production, report-only in `next dev`), HSTS, X-Frame-Options… on
  // every route. See src/security/headers.ts for the policy and why script-src has no nonce.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env) }];
  },
  async redirects() {
    return [
      { source: "/coins", destination: "/launches", permanent: true },
      { source: "/c/:id", destination: "/coin/:id", permanent: false },
    ];
  },
};

export default nextConfig;
