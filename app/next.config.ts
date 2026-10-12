import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // One @solana/web3.js for the app, the wallet adapter and the linked SDK (whose copy
    // would otherwise come from ../services/node_modules and ship twice).
    resolveAlias: { "@solana/web3.js": "./node_modules/@solana/web3.js" },
  },
  experimental: {
    // @fumpad/sdk is linked from ../services/sdk (file: dependency); its own dependencies
    // resolve from ../services/node_modules. Build it first: `npm run sdk` (runs on prebuild).
    turbopackAdditionalRoots: {
      services: { path: path.join(__dirname, "../services") },
    },
  },
};

export default nextConfig;
