-- Pre-launch waitlist (API POST /v1/waitlist, fed by the fumpad.app waiting room).
-- An email, an X handle, or both. Both are stored lowercased so the unique indexes dedupe
-- "Name@Example.com" and "name@example.com". No raw IP is ever stored: ip_hash is an
-- HMAC-SHA256 of the client IP under a server secret, used only for the per-IP daily cap.
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
