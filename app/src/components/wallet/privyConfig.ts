/**
 * APP-10: the Privy app id comes from NEXT_PUBLIC_PRIVY_APP_ID only. There is no built-in fallback id: a live build
 * (NEXT_PUBLIC_FUMPAD_API set) without one fails `next build` in production (`next.config.ts`), and at run time the
 * wallet stays off (login says why) instead of logging people into whatever app a hardcoded id points at.
 * No React, no `@/` imports: unit-tested by `privyConfig.test.ts` with `npm test`.
 */

/** Privy app ids are short alphanumeric ids (e.g. `cm…`, 25 chars); anything else is a typo or an injected value. */
const APP_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** NEXT_PUBLIC_PRIVY_APP_ID, trimmed; null when unset. Throws on a malformed value. */
export function resolvePrivyAppId(v: string | undefined): string | null {
  const s = (v ?? "").trim();
  if (!s) return null;
  if (!APP_ID.test(s)) throw new Error(`NEXT_PUBLIC_PRIVY_APP_ID=${JSON.stringify(s)} doesn't look like a Privy app id`);
  return s;
}

/** Why this build must not ship (null = fine): a production build of the live app without a Privy app id. */
export function privyBuildProblem(env: { NODE_ENV?: string; NEXT_PUBLIC_FUMPAD_API?: string; NEXT_PUBLIC_PRIVY_APP_ID?: string }): string | null {
  let id: string | null;
  try {
    id = resolvePrivyAppId(env.NEXT_PUBLIC_PRIVY_APP_ID);
  } catch (e) {
    return (e as Error).message;
  }
  if (id || !env.NEXT_PUBLIC_FUMPAD_API) return null;
  return env.NODE_ENV === "production" ? "NEXT_PUBLIC_PRIVY_APP_ID is unset: a live build (NEXT_PUBLIC_FUMPAD_API) needs the Privy app id (there is no fallback)" : null;
}
