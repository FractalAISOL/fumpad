import type { NextConfig } from "next";
import { securityHeaders } from "./src/security/headers";
import { rpcWarnings } from "./src/security/rpc";

// M-8: NEXT_PUBLIC_SOLANA_RPC ships to every browser (LAUNCH.md → "Frontend RPC key").
for (const w of rpcWarnings(process.env)) console.warn(`[fumpad] warning: ${w}`);

const nextConfig: NextConfig = {
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
