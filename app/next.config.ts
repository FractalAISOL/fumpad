import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // @fumpad/sdk is vendored as a packed tarball (vendor/fumpad-sdk-*.tgz) so the app deploys
  // on its own. After changing services/sdk, run `npm run sdk` to repack it.
  // The coin list moved from /coins to /launches; old links keep working.
  async redirects() {
    return [{ source: "/coins", destination: "/launches", permanent: true }];
  },
};

export default nextConfig;
