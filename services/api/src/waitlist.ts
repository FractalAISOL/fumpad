/**
 * `POST /v1/waitlist`: the pre-launch waiting room (fumpad.app) collects an email, an X
 * handle, or both. Stored in `waitlist` (indexer migration 007), deduped case-insensitively.
 *
 * Privacy: the raw IP is never stored or logged here. `ip_hash` = HMAC-SHA256(ip) under
 * `WAITLIST_IP_SALT` (falls back to a key derived from DATABASE_URL, which is already a server
 * secret), used only to cap sign-ups per IP per day.
 *
 * Abuse: a per-IP route limit (in memory, per instance), a per-IP daily cap in the DB (holds
 * across instances and restarts), and a honeypot field. The response is the same whether the
 * contact was new or already on the list, so the endpoint can't be used to test who signed up.
 */
import { createHash, createHmac } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Db } from "@fumpad/indexer";

import type { ApiConfig } from "./config.js";

export interface WaitlistEntry {
  email: string | null;
  xHandle: string | null;
}

export class WaitlistError extends Error {
  constructor(
    public statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** "@Name", "Name", "x.com/Name", "https://twitter.com/Name/" → "name"; null when it isn't a handle. */
export function normalizeHandle(raw: string): string | null {
  let v = raw.trim();
  v = v.replace(/^https?:\/\//i, "").replace(/^(www\.|mobile\.)?(x|twitter)\.com\//i, "");
  v = v.replace(/[/?#].*$/, "").replace(/^@/, "");
  return HANDLE.test(v) ? v.toLowerCase() : null;
}

export function normalizeEmail(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (v.length > 254 || !EMAIL.test(v)) return null;
  const [local] = v.split("@");
  return local.length <= 64 ? v : null;
}

const str = (v: unknown, name: string): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string" || v.length > 300) throw new WaitlistError(400, `invalid ${name}`);
  return v.trim() === "" ? undefined : v;
};

/**
 * Body: `{ email?, xHandle? }` (at least one), or `{ contact }`: one field that is either,
 * as the waiting room's single input sends it. `website` is a honeypot (bots fill it).
 */
export function parseWaitlistBody(body: unknown): WaitlistEntry & { bot: boolean } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new WaitlistError(400, "JSON body required");
  const b = body as Record<string, unknown>;
  const bot = typeof b.website === "string" && b.website.trim() !== "";
  let email: string | null = null;
  let xHandle: string | null = null;
  const contact = str(b.contact, "contact");
  if (contact !== undefined) {
    if (contact.includes("@") && !contact.trim().startsWith("@")) {
      email = normalizeEmail(contact);
      if (!email) throw new WaitlistError(400, "That email address doesn't look right.");
    } else {
      xHandle = normalizeHandle(contact);
      if (!xHandle) throw new WaitlistError(400, "X handles are 1 to 15 letters, numbers or underscores.");
    }
  }
  const e = str(b.email, "email");
  if (e !== undefined) {
    email = normalizeEmail(e);
    if (!email) throw new WaitlistError(400, "That email address doesn't look right.");
  }
  const h = str(b.xHandle, "xHandle");
  if (h !== undefined) {
    xHandle = normalizeHandle(h);
    if (!xHandle) throw new WaitlistError(400, "X handles are 1 to 15 letters, numbers or underscores.");
  }
  if (!email && !xHandle) throw new WaitlistError(400, "Add an email or an X handle.");
  return { email, xHandle, bot };
}

/**
 * The client IP: `req.ip`, i.e. the API's single client-IP derivation (TRUST_PROXY_HOPS,
 * net.ts / H-2) — the same address every rate limit and the WebSocket cap use.
 */
export function clientIp(req: Pick<FastifyRequest, "ip">): string {
  return req.ip || "unknown";
}

export function ipHasher(salt: string): (ip: string) => string {
  return (ip) => createHmac("sha256", salt).update(ip).digest("hex");
}

export function waitlistSalt(cfg: Pick<ApiConfig, "waitlistIpSalt" | "databaseUrl">): string {
  return cfg.waitlistIpSalt || createHash("sha256").update(`fumpad-waitlist:${cfg.databaseUrl}`).digest("hex");
}

export function registerWaitlistRoutes(app: FastifyInstance, cfg: ApiConfig, db: Db) {
  const hash = ipHasher(waitlistSalt(cfg));
  app.post(
    "/v1/waitlist",
    { config: { rateLimit: { max: cfg.waitlistRateLimitPerMin, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => clientIp(req) } } },
    async (req, reply) => {
      const entry = parseWaitlistBody(req.body);
      if (entry.bot) return reply.code(201).send({ ok: true });
      const ipHash = hash(clientIp(req));
      const recent = await db.query<{ n: string }>("SELECT count(*) AS n FROM waitlist WHERE ip_hash = $1 AND created_at > now() - interval '1 day'", [ipHash]);
      if (Number(recent.rows[0]?.n ?? 0) >= cfg.waitlistPerIpPerDay) throw new WaitlistError(429, "Too many sign-ups from this network today. Try again tomorrow.");
      // Any unique hit (same email or same handle) is a duplicate: keep the first row.
      await db.query("INSERT INTO waitlist (email, x_handle, ip_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [entry.email, entry.xHandle, ipHash]);
      return reply.code(201).send({ ok: true });
    },
  );
}
