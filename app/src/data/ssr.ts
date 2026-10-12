/**
 * The data source for server rendering (Server Components, `generateMetadata`, `/og`).
 *
 * When `API_SSR_SECRET` is set, every server-side API request carries `x-fumpad-ssr: <secret>`,
 * so the API can tell our renderer (Vercel, many IPs) from the public and exempt it from
 * per-IP limits without an IP allow-list. The secret is a plain server env var (no
 * NEXT_PUBLIC_ prefix, so never inlined) and this module is `server-only`: importing it from a
 * Client Component fails the build. See LAUNCH.md.
 */
import "server-only";
import { ApiFumpadData } from "./api";
import type { FumpadData } from "./interface";
import { mockData } from "./mock";

export const SSR_HEADER = "x-fumpad-ssr";

let shared: FumpadData | null = null;

export function serverData(): FumpadData {
  if (shared) return shared;
  const base = process.env.NEXT_PUBLIC_FUMPAD_API;
  if (!base) return (shared = mockData);
  const secret = process.env.API_SSR_SECRET?.trim();
  return (shared = new ApiFumpadData(base, { headers: secret ? { [SSR_HEADER]: secret } : {} }));
}
