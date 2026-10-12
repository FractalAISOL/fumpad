import type { NextConfig } from "next";
import { securityHeaders } from "./src/security/headers";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // @fumpad/sdk is vendored as a packed tarball (vendor/fumpad-sdk-*.tgz) so the app deploys
  // on its own. After changing services/sdk, run `npm run sdk` to repack it.
  // The coin list moved from /coins to /launches; old links keep working. Share cards print
  // the short coin link fumpad.app/c/<symbol>.
  // H-5: CSP (enforced in production, report-only in `next dev`), HSTS, X-Frame-Options… on
  // every route. See src/security/headers.ts for the policy and why script-src has no nonce.
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders(process.env) }];
  },
  async redirects() {
    return [
      { source: "/coins", destination: "/launches", permanent: true },
      { source: "/c/:symbol", destination: "/coin/:symbol", permanent: false },
    ];
  },
};

export default nextConfig;
