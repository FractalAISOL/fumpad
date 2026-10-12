# Pre-launch waiting room and how to open the app

Until launch, **fumpad.app** and **www.fumpad.app** show only the waiting room. Every other host (fumpad.vercel.app, preview URLs, localhost) serves the full app as before, so the team can keep testing it.

## How it works

| Piece | File | What it does |
|---|---|---|
| Gate | `src/proxy.ts` + `src/prelaunch/gate.ts` (tests: `gate.test.ts`) | Next.js 16 Proxy (the old "middleware"). On a gated host: `/` is rewritten to the waiting room, `/terms` `/risk` `/privacy` to the waiting-room copies of the legal pages, and every other page redirects (307, temporary) to `/`. Build assets (`/_next/*`), share cards (`/og/*`), `/api/*` and static files (favicon, icons, OG images, `robots.txt`, manifest) pass through. |
| Waiting room | `src/app/soon/` (page, layout, legal pages, OG image), `src/components/prelaunch/` | Its own frame: no app header, tab bar, footer, wallet, live socket or Privy. `components/prelaunch/ShellGate.tsx` drops the app shell for the `soon` segment in the root layout. On other hosts it's viewable at `/soon`. |
| Waitlist | `POST /v1/waitlist` on the API (`services/api/src/waitlist.ts`, table from `services/indexer/migrations/007_waitlist.sql`) | Email or X handle, deduped, IP stored only as an HMAC hash. The page posts to `NEXT_PUBLIC_FUMPAD_API`. |

## Environment variables (Vercel, Production)

| Variable | Default | Meaning |
|---|---|---|
| `PRELAUNCH_HOSTS` | `fumpad.app,www.fumpad.app` | Comma list of hosts that show only the waiting room. Read at request time. An empty value gates nothing. |
| `NEXT_PUBLIC_PRELAUNCH` | unset (gate on) | Set to `off` to open the app on every host. Read by the proxy at request time and inlined at build, so redeploy after changing it. |
| `NEXT_PUBLIC_LAUNCH_AT` | unset | ISO time, e.g. `2026-11-03T17:00:00Z`. When set, the waiting room shows a countdown; unset or unparseable hides it. Inlined at build: redeploy after changing it. |
| `NEXT_PUBLIC_FUMPAD_API` | (already set) | The waitlist posts to `<API>/v1/waitlist`. Without it the form says the waitlist isn't connected. |
| `NEXT_PUBLIC_SITE_URL` | (currently `https://fumpad.vercel.app`) | Base for absolute OG/Twitter image URLs. Set it to `https://fumpad.app` once the domain is attached so previews point at the real domain. |

The API's `CORS_ORIGINS` (Railway, service `api`) must include `https://fumpad.app` and `https://www.fumpad.app` (done on Oct 12 2026). Optional API knobs: `WAITLIST_IP_SALT` (HMAC key for IP hashes, set), `WAITLIST_RATE_LIMIT_PER_MIN` (5), `WAITLIST_PER_IP_PER_DAY` (20).

## Security settings (Vercel env, all environments)

| Variable | Default | Meaning |
|---|---|---|
| `API_SSR_SECRET` | unset | Server-side only (no `NEXT_PUBLIC_`, never in the browser bundle). When set, every request the Next server makes to the API (Server Components, metadata, `/og` cards) carries `x-fumpad-ssr: <secret>`, so the API can recognise our renderer and exempt it from per-IP limits instead of trusting an IP allow-list. Set the same value on the API service (Railway) once it reads the header; generate with `openssl rand -hex 32`; rotate by setting the new value on both and redeploying. Code: `src/data/ssr.ts` (`server-only`). |
| `NEXT_PUBLIC_SOLANA_RPC` | public mainnet RPC | **Public by design**: inlined into the client bundle, so any key in it is visible to everyone. It must be a frontend-only key, **restricted to our origins** (Helius → the key → Access Control → Allowed Domains: `fumpad.app`, `www.fumpad.app`, `fumpad.vercel.app`; add preview domains only if needed) and **never the backend's key** (indexer, API, keeper each have their own). An unrestricted key here lets anyone burn our RPC credits. `next build` prints a warning when the URL carries a key, when it matches `RPC_URL`/`HELIUS_API_KEY` in the build env, or when it is unset in production. Its origin (https + wss) is added to the CSP automatically. |
| `CSP_MODE` | `enforce` in production builds, `report-only` in `next dev` | `report-only` sends `Content-Security-Policy-Report-Only` (violations only logged in the console) — use it on a preview deployment to try a policy change; `off` removes the CSP (emergency only). Read at build time: redeploy after changing. |
| `CSP_REPORT_URI` | unset | Optional endpoint for CSP violation reports. |
| `NEXT_PUBLIC_IPFS_GATEWAY` | `https://ipfs.io` | Gateway for `ipfs://` coin images (`src/design/image.ts`). |

Headers on every route (`src/security/headers.ts`, applied in `next.config.ts`): the CSP (scripts only from our origin + Cloudflare Turnstile; connections only to the API, the Solana RPC and Privy; frames only Privy + Turnstile; no plugins, no framing, `base-uri`/`form-action` self), `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a minimal `Permissions-Policy`. `script-src` allows inline scripts (no nonce) because Cache Components prerenders static shells; a nonce would force every page to render per request. If the API or RPC host changes, rebuild so the CSP follows it.

Privy dashboard (privy.io → the app → Settings → Domains): allowed origins should be exactly `https://fumpad.app`, `https://www.fumpad.app`, `https://fumpad.vercel.app` (plus `http://localhost:3000`/`3100` only while testing). Login is refused from anywhere else, which limits what a copied front end can do with our app id.

After deploying: open the site, log in, open the wallet menu and a coin page with DevTools → Console open; there should be no `Content-Security-Policy` violations. `curl -sI https://fumpad.app/ | grep -i content-security` shows the enforced header.

## Open the app (launch day)

1. Vercel → project `fumpad` → Settings → Environment Variables → Production: set `NEXT_PUBLIC_PRELAUNCH` = `off`. (Or delete `PRELAUNCH_HOSTS`'s value / set it to an empty string; `off` is clearer.)
2. Redeploy production: Deployments → latest production deployment → ⋯ → Redeploy (clear the build cache is not needed). From the CLI: `cd app && vercel --prod`.
3. Check: `curl -sI https://fumpad.app/launches` returns `200` (not `307`), and `https://fumpad.app/` shows the feed.
4. Optional: delete `NEXT_PUBLIC_LAUNCH_AT`.

The waiting room stays reachable at `/soon` afterwards; delete `src/app/soon`, `src/components/prelaunch`, `src/prelaunch`, `src/proxy.ts` and the `ShellGate` wrapper in `src/app/layout.tsx` when it's no longer wanted.

## Close it again (or test the gate)

- Set `NEXT_PUBLIC_PRELAUNCH` back to anything but `off` (or remove it) and redeploy.
- Local test without DNS: `npm run build && npx next start -p 3100`, then
  `curl -sI -H 'Host: fumpad.app' http://localhost:3100/launches` → `307` to `/`;
  `curl -s -H 'Host: fumpad.app' http://localhost:3100/ | grep '<title>'` → the waiting room;
  `curl -sI http://localhost:3100/launches` → `200` (the app).

## Export the waitlist

```sql
SELECT coalesce(email, '') AS email, coalesce('@' || x_handle, '') AS x, created_at FROM waitlist ORDER BY created_at;
```

(Railway → Postgres → Query, or `psql "$DATABASE_URL"`.) Contacts are stored lowercased; `ip_hash` is not personal data on its own but is only for rate limiting, so leave it out of exports.
