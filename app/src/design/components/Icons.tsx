import type { SVGProps } from "react";

/** Hand-drawn 20px stroke icons. Decorative by default (aria-hidden). */
type P = SVGProps<SVGSVGElement>;
const base = (p: P) => ({
  width: 20,
  height: 20,
  viewBox: "0 0 20 20",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
  ...p,
});

export const IconFeed = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 5h14M3 10h14M3 15h9" />
  </svg>
);
export const IconCoins = (p: P) => (
  <svg {...base(p)}>
    <path d="M2 15l5-5 3 3 7-8" />
  </svg>
);
/** Ring (your sell), dotted run, dot (10×) — the mark as an icon. */
export const IconFumbles = (p: P) => (
  <svg {...base(p)}>
    <circle cx="5.5" cy="14.5" r="2.5" />
    <path d="M8 12l6-6" strokeDasharray="1.5 2" />
    <circle cx="15" cy="5" r="2.5" fill="currentColor" stroke="none" />
  </svg>
);
export const IconRanks = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 17V9M10 17V3M16 17v-5" />
  </svg>
);
export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 4v12M4 10h12" />
  </svg>
);
export const IconClose = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 5l10 10M15 5L5 15" />
  </svg>
);
export const IconSun = (p: P) => (
  <svg {...base(p)}>
    <circle cx="10" cy="10" r="3.2" />
    <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3L6 14M14 6l1.3-1.3" />
  </svg>
);
export const IconMoon = (p: P) => (
  <svg {...base(p)}>
    <path d="M15.5 12.5A6 6 0 0 1 7.5 4.5a6 6 0 1 0 8 8z" />
  </svg>
);
export const IconSystem = (p: P) => (
  <svg {...base(p)}>
    <circle cx="10" cy="10" r="6.5" />
    <path d="M10 3.5v13" />
    <path d="M10 3.5a6.5 6.5 0 0 1 0 13z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconCopy = (p: P) => (
  <svg {...base(p)}>
    <rect x="7" y="7" width="9" height="9" rx="1.5" />
    <path d="M4 13V5.5A1.5 1.5 0 0 1 5.5 4H13" />
  </svg>
);
export const IconCheck = (p: P) => (
  <svg {...base(p)}>
    <path d="M4.5 10.5l3.5 3.5 7.5-8" />
  </svg>
);
export const IconInfo = (p: P) => (
  <svg {...base(p)}>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 9v5M10 6.2v.1" />
  </svg>
);
export const IconReply = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 4h14v9H8l-5 3.5z" />
  </svg>
);
export const IconRepost = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 8V5.5h11L12.5 3M16 12v2.5H5L7.5 17" />
  </svg>
);
export const IconWallet = (p: P) => (
  <svg {...base(p)}>
    <rect x="2.5" y="5" width="15" height="11" rx="1.5" />
    <path d="M13 10.5h4.5M5 5l8-2.5V5" />
  </svg>
);
export const IconUpload = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 13V3.5M6 7.5l4-4 4 4M3.5 13v3.5h13V13" />
  </svg>
);
export const IconDownload = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 3.5V13M6 9l4 4 4-4M3.5 13v3.5h13V13" />
  </svg>
);
/** Share: a box with an arrow out of it. */
export const IconShare = (p: P) => (
  <svg {...base(p)}>
    <path d="M10 12.5V3M6.5 6.5L10 3l3.5 3.5M6 9.5H4.5v7h11v-7H14" />
  </svg>
);
/** A person: head and shoulders. */
export const IconUser = (p: P) => (
  <svg {...base(p)}>
    <circle cx="10" cy="7" r="3.2" />
    <path d="M3.8 17c.8-3.1 3.3-5 6.2-5s5.4 1.9 6.2 5" />
  </svg>
);
export const IconArrowLeft = (p: P) => (
  <svg {...base(p)}>
    <path d="M16 10H4M9 5l-5 5 5 5" />
  </svg>
);
export const IconExternal = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8" />
  </svg>
);
export const IconX = (p: P) => (
  <svg {...base(p)} strokeWidth={0} fill="currentColor">
    <path d="M14.6 3h2.5l-5.4 6.2L18 17h-5l-3.9-5.1L4.6 17H2.1l5.8-6.6L1.8 3h5.1l3.5 4.7zm-.9 12.6h1.4L6.3 4.3H4.8z" />
  </svg>
);
export const IconSort = ({ dir, ...p }: P & { dir?: "asc" | "desc" | false }) => (
  <svg {...base(p)} width={10} height={10} viewBox="0 0 10 10" strokeWidth={1.4}>
    <path d="M2.5 4L5 1.5 7.5 4" opacity={dir === "asc" ? 1 : 0.35} />
    <path d="M2.5 6L5 8.5 7.5 6" opacity={dir === "desc" ? 1 : 0.35} />
  </svg>
);
export const IconBolt = (p: P) => (
  <svg {...base(p)} strokeWidth={0} fill="currentColor">
    <path d="M11.4 1.8 3.6 11.2h5.1l-1.1 7 7.8-9.4h-5.1z" />
  </svg>
);
export const IconTelegram = (p: P) => (
  <svg {...base(p)} strokeWidth={0} fill="currentColor">
    <path d="M17.6 3.3 2.4 9.2c-.9.4-.9 1.1 0 1.3l3.9 1.2 1.5 4.6c.2.5.4.6.8.6.3 0 .5-.1.7-.3l1.9-1.8 3.9 2.9c.7.4 1.2.2 1.4-.7l2.6-12.1c.3-1.1-.4-1.6-1.5-1.6Zm-2.7 3.2-7 6.3-.3 3-1.3-4.2 8.2-5.2c.4-.2.7.1.4.1Z" />
  </svg>
);
export const IconGlobe = (p: P) => (
  <svg {...base(p)}>
    <circle cx="10" cy="10" r="7.2" />
    <path d="M2.8 10h14.4M10 2.8c2 2 3 4.4 3 7.2s-1 5.2-3 7.2c-2-2-3-4.4-3-7.2s1-5.2 3-7.2Z" />
  </svg>
);
export const IconFilter = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 5h14M5.5 10h9M8 15h4" />
  </svg>
);
export const IconSearch = (p: P) => (
  <svg {...base(p)}>
    <circle cx="8.6" cy="8.6" r="5.4" />
    <path d="m12.6 12.6 4.4 4.4" />
  </svg>
);
