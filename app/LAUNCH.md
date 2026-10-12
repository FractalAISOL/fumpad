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
