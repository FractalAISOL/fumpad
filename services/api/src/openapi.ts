/** OpenAPI 3.1 document. Component schemas are generated from the app's types (scripts/gen-api-types.mjs). */
import { SCHEMAS } from "./generated/schemas.js";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const arr = (name: string) => ({ type: "array", items: ref(name) });
const q = (name: string, schema: object, description?: string, required = false) => ({ name, in: "query", required, schema, description });
const p = (name: string, description?: string) => ({ name, in: "path", required: true, schema: { type: "string" }, description });
const viewer = q("viewer", { type: "string" }, "Wallet of the viewer (marks `isYou` / `you` rows).");
const ok = (schema: object) => ({ "200": { description: "OK", content: { "application/json": { schema } } } });
const notFound = { "404": { description: "Not found" } };

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "FUMPAD API",
    version: "0.1.0",
    description:
      "Read API over the FUMPAD indexer (REST + WebSocket). Responses are the app's `FumpadData` types (app/src/data/types.ts): SOL amounts in SOL, token amounts in whole tokens (6 decimals), prices in SOL per token, times in unix milliseconds. Rate limited per client IP (server-side rendering authenticates with the x-fumpad-ssr header instead).",
  },
  servers: [{ url: "/" }],
  paths: {
    "/v1/stats": { get: { summary: "Platform stats (getStats)", responses: ok(ref("PlatformStats")) } },
    "/v1/status": {
      get: {
        summary: "Backend health: indexer lag, keeper last-sample age, vanity mint pool, deployed versions (getStatus)",
        responses: ok(ref("SystemStatus")),
      },
    },
    "/v1/img/{mint}": {
      get: {
        summary:
          "Coin image proxy (V7-L6): the coin's metadata image fetched server-side (SSRF-safe), PNG / JPEG / GIF / WebP only (SVG refused), served with CSP default-src 'none' + nosniff. 404 = no image, 502 = unusable source, 503 = busy.",
        parameters: [{ name: "mint", in: "path", required: true, schema: { type: "string" } }, { name: "v", in: "query", required: false, schema: { type: "string" } }],
        responses: { "200": { description: "image bytes", content: { "image/png": {}, "image/jpeg": {}, "image/gif": {}, "image/webp": {} } } },
      },
    },
    "/v1/params": { get: { summary: "Global.params in display units (getParams)", responses: ok(ref("ProtocolParams")) } },
    "/v1/sol-usd": { get: { summary: "SOL/USD from Pyth (getSolUsd)", responses: ok({ type: "object", properties: { solUsd: { type: "number" } }, required: ["solUsd"] }) } },
    "/v1/coins": {
      get: {
        summary: "List coins (listCoins)",
        parameters: [
          q("sort", { enum: ["trending", "new", "mcap", "closest", "graduating"] }),
          q("status", { enum: ["curve", "graduated", "all"] }),
          q("limit", { type: "integer", minimum: 1, maximum: 200 }),
          q("symbol", { type: "string" }, "Only coins with this symbol (case-insensitive, $ optional), newest first, at most 50."),
        ],
        responses: ok(arr("CoinSummary")),
      },
    },
    "/v1/coins/by-mint/{mint}": { get: { summary: "Coin detail by mint (preferred; mints are unique, symbols are not)", parameters: [p("mint")], responses: { ...ok(ref("CoinDetail")), ...notFound } } },
    "/v1/coins/by-symbol/{symbol}": {
      get: {
        summary: "Every coin with this symbol (case-insensitive, leading $ optional), newest first. Empty array when none.",
        parameters: [p("symbol"), q("limit", { type: "integer", minimum: 1, maximum: 50 })],
        responses: ok(arr("CoinSummary")),
      },
    },
    "/v1/coins/{symbolOrMint}": {
      get: {
        summary: "Coin detail, legacy (getCoin). Exact mint wins; a symbol must match exactly one coin, otherwise 300 with {error, symbol, matches: CoinSummary[] newest first}. Prefer /v1/coins/by-mint/{mint}.",
        parameters: [p("symbolOrMint")],
        responses: { ...ok(ref("CoinDetail")), "300": { description: "Ambiguous symbol", content: { "application/json": { schema: { type: "object", properties: { error: { type: "string" }, symbol: { type: "string" }, matches: arr("CoinSummary") } } } } }, ...notFound },
      },
    },
    "/v1/launch/prepare": {
      post: {
        summary:
          "D18 vanity launch: reserve a …fmbL mint and return the mint-signed launch tx. Body {creator, name, symbol, uri, initialBuyLamports?, slippageBps?, priorityMicroLamports?, launchConfig?: 'standard'|'first_coin', auth: {message, signature}}; response {mint, transaction (base64 v0 tx through the launch lookup table LAUNCH_ALT; inline only on localnet without it), lastValidBlockHeight, expiresAt, suffix, firstBuy?, config: {kind, dbcConfig, feeBps, snipeStartBps, snipeWindowSlots, migratedPoolFeeBps, feePolicy}, lookupTable?}. launchConfig 'first_coin' (the one-off 3% config, wallet-split fee policy) needs LAUNCH_FIRST_COIN=true (403 otherwise; 409 when it isn't allow-listed or its launch was used); a standard launch while LAUNCHES_OPEN=false (the mainnet default) is refused with 403 {error: 'Launches open soon', code: 'launches_closed'} (first_coin is not affected); auth.message = 'FUMPAD launch\\ncreator: <creator>\\nsymbol: <symbol>\\nnonce: <16-64 [A-Za-z0-9_-]>\\nissuedAt: <unix ms>' signed (ed25519 signMessage) by the creator wallet; signature base58 or base64.",
        responses: { "200": { description: "OK" }, "401": { description: "Missing/invalid wallet signature" }, "403": { description: "Standard launches closed (code 'launches_closed', LAUNCHES_OPEN=false) / first_coin not enabled" }, "409": { description: "first_coin not available" }, "429": { description: "Rate limited" }, "503": { description: "Pool empty / launches disabled / LAUNCH_ALT missing or failing verification" } },
      },
    },
    "/v1/launch/metadata": {
      post: {
        summary:
          "Pin the coin's metadata to IPFS (Pinata, server-side) before prepare. JSON body (≤ 6 MiB) {creator, name, symbol, description?, website?, twitter?, telegram?, image?: base64 PNG/JPEG/GIF/WebP ≤ 4 MB, firstBuy?: boolean (default true), launchConfig?, auth: same signed message as prepare}; response {uri, image?, placeholder?}. uri = https://ipfs.io/ipfs/<CIDv0> when the launch tx has room (always, through the launch lookup table), else ipfs://<CIDv0> (localnet inline launches only); placeholder ipfs://pending (placeholder: true) on devnet without PINATA_JWT. Same LAUNCHES_OPEN / first-coin gates, funded wallets only.",
        responses: { "200": { description: "OK" }, "400": { description: "Invalid field / image, or name + ticker too long to launch with an IPFS uri" }, "401": { description: "Missing/invalid wallet signature" }, "403": { description: "Launches closed / first_coin not enabled" }, "413": { description: "Body too large" }, "429": { description: "Rate limited (IP or wallet)" }, "502": { description: "Pinning failed, retry" }, "503": { description: "Launches or metadata uploads not configured" } },
      },
    },
    "/v1/launch/options": {
      get: {
        summary: "Launch configs this server offers: {launchesOpen: boolean, firstCoin: null | {dbcConfig, wallet, buybackShareBps, walletShareBps, launchesLeft}} (launchesOpen = LAUNCHES_OPEN: false means standard launches are refused until the public opening; first_coin only with LAUNCH_FIRST_COIN=true and while allow-listed with launches left)",
        responses: { "200": { description: "OK" } },
      },
    },
    "/v1/coins/{mint}/prices": {
      get: { summary: "Price series (getPriceSeries)", parameters: [p("mint"), q("range", { enum: ["1h", "1d", "7d", "all"] }, undefined, true)], responses: ok(arr("PricePoint")) },
    },
    "/v1/coins/{mint}/candles": {
      get: {
        summary:
          "OHLC candles for the coin chart (getCandles): the latest 150 buckets of `interval` (UTC-aligned), or since launch; only buckets with a price point (trades, oracle samples), each opening at the previous close; `open` = the price going into the window",
        parameters: [p("mint"), q("interval", { enum: ["1m", "5m", "30m"] }, "Candle size (default 1m).")],
        responses: ok(ref("CandleSeries")),
      },
    },
    "/v1/coins/{mint}/holders": {
      get: {
        summary: "Holders (getHolders) — FUMPAD-observed balances",
        parameters: [p("mint"), viewer],
        responses: ok({ type: "object", properties: { total: { type: "number" }, top: arr("Holder") }, required: ["total", "top"] }),
      },
    },
    "/v1/coins/{mint}/fumbles": { get: { summary: "Recent fumbles (getRecentFumbles)", parameters: [p("mint"), viewer], responses: ok(arr("FumbleRow")) } },
    "/v1/coins/{mint}/queue": {
      get: {
        summary: "Claim queue (getClaimQueue)",
        parameters: [p("mint"), viewer],
        responses: ok({ type: "object", properties: { pool: { type: "number" }, owed: { type: "number" }, entries: arr("QueueEntry") }, required: ["pool", "owed", "entries"] }),
      },
    },
    "/v1/coins/{mint}/trades": {
      get: { summary: "Recent trades, newest first (getRecentTrades)", parameters: [p("mint"), q("limit", { type: "integer", minimum: 1, maximum: 100 })], responses: ok(arr("TradeRow")) },
    },
    "/v1/feed": {
      get: {
        summary: "Feed (getFeed)",
        parameters: [q("kind", { enum: ["launch", "fumble", "cross", "graduation", "claim", "all"] }), q("before", { type: "number" }, "unix ms (exclusive)"), q("limit", { type: "integer", minimum: 1, maximum: 100 })],
        responses: ok(arr("FeedEvent")),
      },
    },
    "/v1/closest": { get: { summary: "Closest to 10x (getClosestTo10x)", parameters: [q("limit", { type: "integer" }), viewer], responses: ok(arr("CloseCall")) } },
    "/v1/wallets/{wallet}/fumbles": {
      get: {
        summary:
          "Fumble Checker: the wallet's sells (of `mint`, or of every coin it sold, ≤ 20 coins), each with its ticket conditions (USD minimum at the trade-time SOL price, hold time, not the creator), its attested ticket and the claim target (market cap at 10× the ticket price). Read-only, rate-limited per IP. Sells without a ticket are re-derived from indexed trades; the keepers' attestation is authoritative.",
        parameters: [p("wallet"), q("mint", { type: "string" }, "Only this coin.")],
        responses: { ...ok(ref("WalletFumbles")), "400": { description: "Malformed wallet or mint" }, "429": { description: "Rate limited" } },
      },
    },
    "/v1/wallets/{owner}/tickets": { get: { summary: "Tickets of a wallet (getTickets)", parameters: [p("owner")], responses: ok(arr("Ticket")) } },
    "/v1/wallets/{wallet}/positions": {
      get: { summary: "Open positions of a wallet, by value (getPositions) — chain balances, FUMPAD average-cost basis", parameters: [p("wallet")], responses: ok(arr("WalletPosition")) },
    },
    "/v1/wallets/{wallet}/closed": {
      get: { summary: "Fully exited positions, last trade first (getClosedPositions) — realized P&L, average cost", parameters: [p("wallet")], responses: ok(arr("ClosedPosition")) },
    },
    "/v1/wallets/{wallet}/created": {
      get: { summary: "Coins the wallet launched, newest first (getCreatedCoins) — with creator fees", parameters: [p("wallet")], responses: ok(arr("CreatedCoin")) },
    },
    "/v1/tickets/{id}": { get: { summary: "One ticket (getTicket)", parameters: [p("id")], responses: { ...ok(ref("Ticket")), ...notFound } } },
    "/v1/leaderboards/{board}": { get: { summary: "Leaderboard (getLeaderboard) — flagged wallets excluded", parameters: [p("board", "fumbles | claimers | diamond"), viewer], responses: ok(arr("LeaderRow")) } },
    "/v1/profiles/{addressOrName}": { get: { summary: "Profile (getProfile)", parameters: [p("addressOrName")], responses: { ...ok(ref("Profile")), ...notFound } } },
    "/v1/quote": {
      get: {
        summary: "Trade quote (quoteTrade) — mirrors the program's math on live chain state",
        parameters: [q("mint", { type: "string" }, undefined, true), q("side", { enum: ["buy", "sell"] }, undefined, true), q("amount", { type: "number" }, "SOL (buy, fee included) or tokens (sell)", true), q("wallet", { type: "string" })],
        responses: { ...ok(ref("TradeQuote")), ...notFound },
      },
    },
    "/v1/wallets/{wallet}/balances/{mint}": {
      get: {
        summary: "Balances for the trade panel (getBalances)",
        parameters: [p("wallet"), p("mint")],
        responses: ok({ type: "object", properties: { sol: { type: "number" }, tokens: { type: "number" }, maturedTokens: { type: "number" } }, required: ["sol", "tokens", "maturedTokens"] }),
      },
    },
    "/v1/ws": {
      get: {
        summary:
          "WebSocket (subscribeFeed, subscribeLive). Server → client messages (LiveMessage): {type:'feed', event: FeedEvent} | {type:'coins', mints: string[], wallets: string[]} (one per indexed tx) | {type:'coin', coin: CoinDetail, trades: TradeRow[], points: PricePoint[]} (per touched mint) | {type:'params'} | {type:'hello', serverTime}",
        responses: { "101": { description: "Switching protocols" } },
      },
    },
    "/health": { get: { summary: "Liveness ({ok}). Detail (indexer lag, WS, cache, vanity pool) only with the x-fumpad-ssr secret header.", responses: ok({ type: "object" }) } },
  },
  components: { schemas: SCHEMAS },
} as const;
