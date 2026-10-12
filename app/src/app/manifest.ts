import type { MetadataRoute } from "next";

/** Web app manifest: the brand's favicon set (marketing/brand/favicon). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "FUMPAD",
    short_name: "FUMPAD",
    description: "The launchpad for people who sell too early.",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#000000",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
