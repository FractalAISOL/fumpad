# Pre-launch waiting room, launch-window checker, and how to open the app

Until launch, **fumpad.app** and **www.fumpad.app** show only the waiting room. Between the first coin's launch and the full release (~30–60 min) they show the **launch-window checker**: one read-only page about the first coin (live chart, price, market cap, curve, trades from every app, the Fumble Checker for any pasted wallet, the rules, the "How to play" video, "Trade it now" links). Every other host (fumpad.vercel.app, preview URLs, localhost) serves the full app as before, so the team can keep testing it.

| `NEXT_PUBLIC_PRELAUNCH` | fumpad.app shows |
|---|---|
| unset (or anything else) | the waiting room (`/soon`) |
| `checker` + `NEXT_PUBLIC_CHECKER_MINT=<first coin's mint>` | the launch-window checker (`/live`) at `/`; every other app route redirects to `/`; `/terms` `/risk` `/privacy` as in the waiting room. Without a valid mint it stays the waiting room. |
| `off` | the full app |

The full app has the same checker for every coin at **`/checker`** (linked from My fumbles), e.g. `/checker?wallet=<address>`.

**Launches closed until the opening (API `LAUNCHES_OPEN`).** The gate above only covers fumpad.app; the full app on fumpad.vercel.app stays reachable. So the API also refuses standard launches while its `LAUNCHES_OPEN` is `false` (the mainnet default; every launch needs the API's co-signature, so none lands on chain either). The launch page asks `GET <API>/v1/launch/options` first: with `launchesOpen: false` (or after a prepare answered 403 `launches_closed`) `/launch` shows "Launches open soon." with links to the waiting room (`/soon`) and X instead of the form (Fumi's reaction stays in the header, never beside the form). `/launch?config=first-coin` keeps its form while the API offers the first-coin config (`LAUNCH_FIRST_COIN=true`). Code: `src/chain/launchGate.ts` (tests: `launchGate.test.ts`), `src/components/launch/LaunchView.tsx`. Without `NEXT_PUBLIC_FUMPAD_API` (mock) the page is never gated.

## How it works

| Piece | File | What it does |
|---|---|---|
| Gate | `src/proxy.ts` + `src/prelaunch/gate.ts` (tests: `gate.test.ts`) | Next.js 16 Proxy (the old "middleware"). On a gated host: `/` is rewritten to the waiting room, `/terms` `/risk` `/privacy` to the waiting-room copies of the legal pages, and every other page redirects (307, temporary) to `/`. Build assets (`/_next/*`), share cards (`/og/*`), `/api/*` and static files (favicon, icons, OG images, `robots.txt`, manifest) pass through. |
| Waiting room | `src/app/soon/` (page, layout, legal pages, OG image), `src/components/prelaunch/` | Its own frame: no app header, tab bar, footer, wallet, live socket or Privy. `components/prelaunch/ShellGate.tsx` drops the app shell for the `soon` segment in the root layout. On other hosts it's viewable at `/soon`. |
| Launch-window checker | `src/app/live/` (page + its own frame), `src/components/checker/` (`LaunchWindow`, `CoinWindow`, `FumbleCheck`, `Rules`, `HowToPlayVideo`, `model.ts` + tests) | Same frame rules as the waiting room (no app shell, wallet, Privy or signing code; `ShellGate` drops the shell for the `live` segment). Live data from the API: REST + the WebSocket (`coin` messages). The wallet lookup is `GET /v1/wallets/<address>/fumbles?mint=<mint>` from the browser (rate-limited per IP: `FUMBLES_RATE_LIMIT_PER_MIN`, 60). `?wallet=` makes a result a link. The video is self-hosted (`public/video/howtoplay-*.mp4`, CSP `media-src 'self'`, no new origin). On other hosts it's viewable at `/live` (needs the env below). |
| Waitlist | `POST /v1/waitlist` on the API (`services/api/src/waitlist.ts`), stored in its **own** Postgres (`waitlist-db`, `WAITLIST_DATABASE_URL`; services/DEPLOY-v07.md §7) | Email or X handle, deduped, IP stored only as an HMAC hash. The page posts to `NEXT_PUBLIC_FUMPAD_API`. |

## Environment variables (Vercel, Production)

| Variable | Default | Meaning |
|---|---|---|
| `PRELAUNCH_HOSTS` | `fumpad.app,www.fumpad.app` | Comma list of hosts that show only the waiting room. Read at request time. An empty value gates nothing. |
| `NEXT_PUBLIC_PRELAUNCH` | unset (gate on) | `checker` = the launch-window checker; `off` = open the app on every host. Read by the proxy at request time and inlined at build, so redeploy after changing it. |
| `NEXT_PUBLIC_CHECKER_MINT` | unset | The first coin's mint (base58) for the launch-window checker. Required for `checker` mode. Inlined at build. |
| `NEXT_PUBLIC_APP_OPENS_AT` | unset | Optional ISO time, e.g. `2026-11-03T18:00:00Z`: the checker's banner counts down to it ("Full app opens in ~25 min"). Unset: "The full app opens shortly." Inlined at build. |
| `NEXT_PUBLIC_LAUNCH_AT` | unset | ISO time, e.g. `2026-11-03T17:00:00Z`. When set, the waiting room shows a countdown; unset or unparseable hides it. Inlined at build: redeploy after changing it. |
| `NEXT_PUBLIC_FUMPAD_API` | (already set) | The waitlist posts to `<API>/v1/waitlist`. Without it the form says the waitlist isn't connected. |
| `NEXT_PUBLIC_SITE_URL` | (currently `https://fumpad.vercel.app`) | Base for absolute OG/Twitter image URLs. Set it to `https://fumpad.app` once the domain is attached so previews point at the real domain. |

The API's `CORS_ORIGINS` (Railway, service `api`) must include `https://fumpad.app` and `https://www.fumpad.app` (done on Oct 12 2026). Required in production: `WAITLIST_DATABASE_URL` (`${{waitlist-db.DATABASE_URL}}`) and `WAITLIST_IP_SALT` (HMAC key for IP hashes, set); without either the API answers 503 on the waitlist only. Optional: `WAITLIST_RATE_LIMIT_PER_MIN` (5), `WAITLIST_PER_IP_PER_DAY` (20).

## Security settings (Vercel env, all environments)

| Variable | Default | Meaning |
|---|---|---|
| `API_SSR_SECRET` | unset | Server-side only (no `NEXT_PUBLIC_`, never in the browser bundle). When set, every request the Next server makes to the API (Server Components, metadata, `/og` cards) carries `x-fumpad-ssr: <secret>`, so the API can recognise our renderer and exempt it from per-IP limits instead of trusting an IP allow-list. Set the same value on the API service (Railway) once it reads the header; generate with `openssl rand -hex 32`; rotate by setting the new value on both and redeploying. Code: `src/data/ssr.ts` (`server-only`). |
| `NEXT_PUBLIC_SOLANA_RPC` | public mainnet RPC | **Public by design**: inlined into the client bundle, so any key in it is visible to everyone. It must be a frontend-only key, **restricted to our origins** (Helius → the key → Access Control → Allowed Domains: `fumpad.app`, `www.fumpad.app`, `fumpad.vercel.app`; add preview domains only if needed) and **never the backend's key** (indexer, API, keeper each have their own). An unrestricted key here lets anyone burn our RPC credits. `next build` prints a warning when the URL carries a key, when it matches `RPC_URL`/`HELIUS_API_KEY` in the build env, or when it is unset in production. Its origin (https + wss) is added to the CSP automatically. |
| `CSP_MODE` | `enforce` in production builds, `report-only` in `next dev` | `report-only` sends `Content-Security-Policy-Report-Only` (violations only logged in the console) — use it on a preview deployment to try a policy change; `off` removes the CSP (emergency only). Read at build time: redeploy after changing. |
| `CSP_REPORT_URI` | unset | Optional endpoint for CSP violation reports. |
| `NEXT_PUBLIC_IPFS_GATEWAY` | `https://ipfs.io` | No longer used to load images (the browser only loads coin images from the API's proxy, see below); kept for `safeImageSrc`'s URL check. The gateway the proxy fetches `ipfs://` images through is the API's `IPFS_GATEWAY` (Railway, default `https://ipfs.io/ipfs/`). |

Headers on every route (`src/security/headers.ts`, applied in `next.config.ts`): the CSP (scripts only from our origin + Cloudflare Turnstile; connections only to the API, the Solana RPC and Privy; frames only Privy + Turnstile; no plugins, no framing, `base-uri`/`form-action` self), `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, a minimal `Permissions-Policy`. `script-src` allows inline scripts (no nonce) because Cache Components prerenders static shells; a nonce would force every page to render per request. If the API or RPC host changes, rebuild so the CSP follows it.

**Coin images (security review V7-L6, fixed).** The browser never loads a creator's image host. Every coin image is `GET <NEXT_PUBLIC_FUMPAD_API>/v1/img/<mint>?v=<hash>` (`src/design/image.ts` → `coinImageSrc`, rendered by `CoinTile`; a failure or a coin without an image shows the monogram, and mock mode always does). The API looks up the coin's `metadata.image` itself (a caller can't name a URL), fetches it with the indexer's SSRF-safe fetcher (https / ipfs:// / ar:// only, every resolved address public, redirects re-checked, 2 MB / 6 s caps), serves it only if the bytes are PNG / JPEG / GIF / WebP (SVG and anything else refused), with `Content-Security-Policy: default-src 'none'; sandbox`, `X-Content-Type-Options: nosniff`, the sniffed `Content-Type` and long cache headers; results are cached in memory (bounded) and the route is rate-limited per IP (`IMG_RATE_LIMIT_PER_MIN`, 600; also `IMG_MAX_BYTES`, `IMG_CACHE_MB`). So the CSP's `img-src` is `'self' data: blob: <API origin> https://explorer-api.walletconnect.com` (the last one: wallet logos in Privy's list, a host Privy already fetches from) — no `https:` wildcard; an injected script can no longer send data out through an image URL on a host of its choosing. The `/og` share cards are rendered on our server and don't embed coin images. The API must be redeployed with `/v1/img` before (or with) this app build, or coin images fall back to monograms.

**CSP assumption that remains.** `script-src` keeps `'unsafe-inline'` (see above), and the silent-signing allow-list (`src/chain/allowlist.ts`) cannot protect against same-context scripts: a script already running in our origin (an XSS, a compromised dependency) can call the wallet bridge directly, and can still reach the hosts in `connect-src` (our API, our RPC, Privy). The allow-list protects against a wrong builder or a compromised API (V7-M3: trade minimums are bounded by the app's own RPC quote), not against code running in the page. Keeping that code out (no user HTML rendered, no `dangerouslySetInnerHTML` on untrusted data, pinned dependencies) is what the app relies on.

Privy dashboard (privy.io → the app → Settings → Domains): allowed origins should be exactly `https://fumpad.app`, `https://www.fumpad.app`, `https://fumpad.vercel.app` (plus `http://localhost:3000`/`3100` only while testing). Login is refused from anywhere else, which limits what a copied front end can do with our app id.

After deploying: open the site, log in, open the wallet menu and a coin page with DevTools → Console open; there should be no `Content-Security-Policy` violations. `curl -sI https://fumpad.app/ | grep -i content-security` shows the enforced header.

## Launch day: the 3-step flip

Each step is a Vercel Production env change + a redeploy (`NEXT_PUBLIC_*` are inlined at build; ~2 min). The API must already run the build with `GET /v1/wallets/:wallet/fumbles` (this commit or later) before step 2.

1. **Waiting room** (now): `NEXT_PUBLIC_PRELAUNCH` unset. Launch the first coin from a non-gated host (`https://fumpad.vercel.app/launch?config=first-coin`, services/LAUNCH-DAY.md §5).
2. **Checker, right after the first coin registers** (its page at `https://fumpad.vercel.app/coin/<mint>` loads, i.e. the indexer has it):
   set `NEXT_PUBLIC_CHECKER_MINT=<mint>`, optionally `NEXT_PUBLIC_APP_OPENS_AT=<ISO time>`, then `NEXT_PUBLIC_PRELAUNCH=checker` → redeploy.
   Check: `curl -s https://fumpad.app/ | grep '<title>'` → "FUMPAD — The first coin is live. Did you fumble?"; `curl -sI https://fumpad.app/launches` → `307` to `/`;
   open `https://fumpad.app/?wallet=<a wallet that sold>` and see its sells; DevTools console free of CSP violations; the video plays.
3. **Full app** (~30–60 min later): `NEXT_PUBLIC_PRELAUNCH=off` → redeploy (the steps below), **and at the same time** the API's `LAUNCHES_OPEN=true` (Railway `api`) → redeploy, so standard launches open with the app. `NEXT_PUBLIC_CHECKER_MINT` / `NEXT_PUBLIC_APP_OPENS_AT` can stay; they only affect `/live`.

Rollback at any step: set the previous value and redeploy (or promote the previous production deployment in Vercel → Deployments → ⋯ → Promote, instant).

## Open the app (launch day)

1. Vercel → project `fumpad` → Settings → Environment Variables → Production: set `NEXT_PUBLIC_PRELAUNCH` = `off`. (Or delete `PRELAUNCH_HOSTS`'s value / set it to an empty string; `off` is clearer.)
2. Redeploy production: Deployments → latest production deployment → ⋯ → Redeploy (clear the build cache is not needed). From the CLI: `cd app && vercel --prod`.
3. Same time, the API: Railway → service `api` → Variables: `LAUNCHES_OPEN=true` → redeploy (services/LAUNCH-DAY.md §5 step 4). Until then `/launch` says "Launches open soon.".
4. Check: `curl -sI https://fumpad.app/launches` returns `200` (not `307`), `https://fumpad.app/` shows the feed, `curl -s <API>/v1/launch/options` shows `"launchesOpen":true`, and `https://fumpad.app/launch` shows the form.
5. Optional: delete `NEXT_PUBLIC_LAUNCH_AT`.

The waiting room stays reachable at `/soon` afterwards; delete `src/app/soon`, `src/components/prelaunch`, `src/prelaunch`, `src/proxy.ts` and the `ShellGate` wrapper in `src/app/layout.tsx` when it's no longer wanted.

## Close it again (or test the gate)

- Set `NEXT_PUBLIC_PRELAUNCH` back to anything but `off` (or remove it) and redeploy.
- Stop new launches only (trading keeps working): the API's `LAUNCHES_OPEN=false` + redeploy; `/launch` shows "Launches open soon." again.
- Local test without DNS: `npm run build && npx next start -p 3100`, then
  `curl -sI -H 'Host: fumpad.app' http://localhost:3100/launches` → `307` to `/`;
  `curl -s -H 'Host: fumpad.app' http://localhost:3100/ | grep '<title>'` → the waiting room;
  `curl -sI http://localhost:3100/launches` → `200` (the app).

## Export the waitlist

```sh
cd ~/fumpad/services
railway variables --service waitlist-db --kv | sed -n 's/^DATABASE_PUBLIC_URL=//p' \
  | npx tsx scripts/ops/waitlist-export.ts --url-stdin      # → ~/fumpad-keys/waitlist/waitlist-<ts>.csv (mode 600)
```

Columns `id,email,x_handle,created_at` (handles without `@`, lowercased). `ip_hash` is not personal data on its own but is only for rate limiting, so it is left out unless `--include-ip-hash` (full restore). The database must never be reset with the devnet backend (services/DEPLOY-v07.md §7).
