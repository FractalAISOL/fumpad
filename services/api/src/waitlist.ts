/**
 * `POST /v1/waitlist`: the pre-launch waiting room (fumpad.app) collects an email, an X
 * handle, or both, deduped case-insensitively.
 *
 * Storage: the waitlist has its OWN database (`WAITLIST_DATABASE_URL`, Railway `waitlist-db`),
 * a separate pool, and its own schema (`migrateWaitlist`: idempotent, only the `waitlist` table)
 * run at API start. A backend/devnet schema reset therefore never touches sign-ups. Outside
 * production it falls back to DATABASE_URL; in production without its own DB (or without
 * WAITLIST_IP_SALT) the route answers 503 and the API logs it loudly; every other route works.
 *
 * Privacy: the raw IP is never stored or logged here. `ip_hash` = HMAC-SHA256(ip) under
 * `WAITLIST_IP_SALT` (independent of any database URL), used only to cap sign-ups per IP per day.
 *
 * Abuse: a per-IP route limit (in memory, per instance), a per-IP daily cap in the DB (holds
 * across instances and restarts), and a honeypot field. The response is the same whether the
 * contact was new or already on the list, so the endpoint can't be used to test who signed up.
 */
import { createHmac } from "node:crypto";

import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import pg from "pg";

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

/** The ip_hash key: WAITLIST_IP_SALT (the config already applied the dev fallback / the production requirement). */
export function waitlistSalt(cfg: Pick<ApiConfig, "waitlistIpSalt">): string {
  if (!cfg.waitlistIpSalt) throw new Error("waitlist: WAITLIST_IP_SALT is not set");
  return cfg.waitlistIpSalt;
}

/**
 * The waitlist's own schema: only the `waitlist` table (same shape as indexer migration 007, which
 * stays in the backend DB for history). Idempotent; serialised by an advisory lock so several API
 * instances starting at once don't race.
 */
export const WAITLIST_SCHEMA = `
CREATE TABLE IF NOT EXISTS waitlist (
  id         BIGSERIAL PRIMARY KEY,
  email      TEXT,
  x_handle   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_hash    TEXT NOT NULL,
  CONSTRAINT waitlist_contact CHECK (email IS NOT NULL OR x_handle IS NOT NULL),
  CONSTRAINT waitlist_email_len CHECK (email IS NULL OR length(email) <= 254),
  CONSTRAINT waitlist_handle_len CHECK (x_handle IS NULL OR length(x_handle) <= 15)
);
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_email_key ON waitlist (email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS waitlist_x_handle_key ON waitlist (x_handle) WHERE x_handle IS NOT NULL;
CREATE INDEX IF NOT EXISTS waitlist_ip_recent ON waitlist (ip_hash, created_at DESC);
`;
const WAITLIST_MIGRATION_LOCK = 7271101;

export async function migrateWaitlist(db: Pick<pg.Pool, "connect">): Promise<void> {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock($1)", [WAITLIST_MIGRATION_LOCK]);
    await c.query(WAITLIST_SCHEMA);
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Pool for the waitlist DB: small, with a connect timeout so a dead waitlist DB can't hang a request. */
export function createWaitlistPool(url: string): pg.Pool {
  return new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 10_000, application_name: "fumpad-waitlist" });
}

/** The waitlist's DB handle + schema readiness (migrated once; retried after a failure). */
export class WaitlistStore {
  private ready: Promise<void> | null = null;
  constructor(
    readonly db: Db,
    /** true when this store created the pool (it ends it on close). */
    readonly ownsPool: boolean,
    /** false = development fallback on the backend DATABASE_URL. */
    readonly dedicated: boolean,
  ) {}
  ensureSchema(): Promise<void> {
    this.ready ??= migrateWaitlist(this.db).catch((e: Error) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }
  async close() {
    if (this.ownsPool) await this.db.end();
  }
}

const UNAVAILABLE = "The waitlist is unavailable right now. Try again later or follow @fumpadapp for the launch.";

/**
 * Where the waitlist lives: `injected` (tests) > WAITLIST_DATABASE_URL (its own pool) > outside production
 * the backend pool. Null = disabled (`registerWaitlistRoutes` logs the reason loudly and answers 503).
 */
export function openWaitlistStore(cfg: ApiConfig, backendDb: Db, injected?: WaitlistStore | null): WaitlistStore | null {
  if (injected !== undefined) return injected;
  if (cfg.waitlistDisabledReason || !cfg.waitlistDatabaseUrl) return null;
  if (cfg.waitlistDatabaseUrl === cfg.databaseUrl) return new WaitlistStore(backendDb, false, false);
  return new WaitlistStore(createWaitlistPool(cfg.waitlistDatabaseUrl), true, true);
}

function shout(log: FastifyBaseLogger, reason: string) {
  log.error({ waitlist: "disabled", reason }, `!!! WAITLIST DISABLED: POST /v1/waitlist answers 503: ${reason} !!!`);
}

export function registerWaitlistRoutes(app: FastifyInstance, cfg: ApiConfig, store: WaitlistStore | null) {
  const routeOpts = { config: { rateLimit: { max: cfg.waitlistRateLimitPerMin, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => clientIp(req) } } };
  if (!store) {
    const reason = cfg.waitlistDisabledReason ?? "no waitlist database configured";
    shout(app.log, reason);
    // Keep shouting (hourly) while it's misconfigured, so it can't scroll out of sight.
    const t = setInterval(() => shout(app.log, reason), 3_600_000);
    t.unref();
    app.addHook("onClose", async () => clearInterval(t));
    app.post("/v1/waitlist", routeOpts, async (_req, reply) => reply.code(503).send({ error: UNAVAILABLE }));
    return;
  }
  const hash = ipHasher(waitlistSalt(cfg));
  if (!store.dedicated) app.log.warn("waitlist: using the backend DATABASE_URL (development fallback; production requires WAITLIST_DATABASE_URL)");
  // Schema at start, in the background: a slow or down waitlist DB never delays the rest of the API.
  store.ensureSchema().then(
    () => app.log.info({ dedicated: store.dedicated }, "waitlist schema ready"),
    (e: Error) => app.log.error({ err: e.message }, "!!! waitlist schema migration failed (retried on the next sign-up) !!!"),
  );
  app.addHook("onClose", async () => store.close());
  app.post("/v1/waitlist", routeOpts, async (req, reply) => {
    const entry = parseWaitlistBody(req.body);
    if (entry.bot) return reply.code(201).send({ ok: true });
    try {
      await store.ensureSchema();
    } catch (e) {
      app.log.error({ err: (e as Error).message }, "waitlist database unavailable");
      throw new WaitlistError(503, UNAVAILABLE);
    }
    const ipHash = hash(clientIp(req));
    const recent = await store.db.query<{ n: string }>("SELECT count(*) AS n FROM waitlist WHERE ip_hash = $1 AND created_at > now() - interval '1 day'", [ipHash]);
    if (Number(recent.rows[0]?.n ?? 0) >= cfg.waitlistPerIpPerDay) throw new WaitlistError(429, "Too many sign-ups from this network today. Try again tomorrow.");
    // Any unique hit (same email or same handle) is a duplicate: keep the first row.
    await store.db.query("INSERT INTO waitlist (email, x_handle, ip_hash) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [entry.email, entry.xHandle, ipHash]);
    return reply.code(201).send({ ok: true });
  });
}

const CSV_COLUMNS = ["id", "email", "x_handle", "created_at"];

/**
 * One CSV field. Audit S-6: a value starting with `=`, `+`, `-`, `@`, tab or CR is a formula to Excel / Sheets /
 * LibreOffice (an email like `=HYPERLINK(...)@x.io` passes the email check), so it gets a leading `'` (shown as
 * text, the OWASP recommendation) and is quoted. Quotes, commas and newlines are quoted as before.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
  const formula = /^[=+\-@\t\r]/.test(s);
  if (formula) s = `'${s}`;
  return formula || /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The sign-ups as CSV (header + one row per sign-up, oldest first). `ip_hash` only on request
 * (`includeIpHash`, for a full-fidelity restore); nobody needs it to contact anyone.
 */
export async function waitlistCsv(db: Pick<Db, "query">, opts: { includeIpHash?: boolean } = {}): Promise<{ csv: string; rows: number }> {
  const cols = opts.includeIpHash ? [...CSV_COLUMNS, "ip_hash"] : CSV_COLUMNS;
  const r = await db.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM waitlist ORDER BY created_at, id`);
  const lines = [cols.join(","), ...r.rows.map((row) => cols.map((c) => csvCell(row[c])).join(","))];
  return { csv: lines.join("\n") + "\n", rows: r.rows.length };
}
