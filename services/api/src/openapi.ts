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
      "Read API over the FUMPAD indexer (REST + WebSocket). Responses are the app's `FumpadData` types (app/src/data/types.ts): SOL amounts in SOL, token amounts in whole tokens (6 decimals), prices in SOL per token, times in unix milliseconds. Rate limited per IP.",
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
    "/v1/params": { get: { summary: "Global.params in display units (getParams)", responses: ok(ref("ProtocolParams")) } },
    "/v1/sol-usd": { get: { summary: "SOL/USD from Pyth (getSolUsd)", responses: ok({ type: "object", properties: { solUsd: { type: "number" } }, required: ["solUsd"] }) } },
    "/v1/coins": {
      get: {
        summary: "List coins (listCoins)",
        parameters: [
          q("sort", { enum: ["trending", "new", "mcap", "closest", "graduating"] }),
          q("status", { enum: ["curve", "graduated", "all"] }),
          q("limit", { type: "integer", minimum: 1, maximum: 200 }),
        ],
        responses: ok(arr("CoinSummary")),
      },
    },
    "/v1/coins/{symbolOrMint}": { get: { summary: "Coin detail (getCoin)", parameters: [p("symbolOrMint")], responses: { ...ok(ref("CoinDetail")), ...notFound } } },
    "/v1/coins/{mint}/prices": {
      get: { summary: "Price series (getPriceSeries)", parameters: [p("mint"), q("range", { enum: ["1h", "1d", "7d", "all"] }, undefined, true)], responses: ok(arr("PricePoint")) },
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
    "/health": { get: { summary: "Liveness + indexer lag", responses: ok({ type: "object" }) } },
  },
  components: { schemas: SCHEMAS },
} as const;
