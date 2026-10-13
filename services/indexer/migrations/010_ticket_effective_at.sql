-- TicketAttested.effective_at (INTERFACE-v0.7 §8.4) gets its own column: attested_at is when the
-- 2-of-3 attestation landed (event ts), effective_at when the ticket takes effect (later when the
-- coin's attestation rate cap deferred it). NULL = unknown (rows indexed before this column, or an
-- event without effective_at): readers fall back to attested_at (which those rows filled with the
-- effective time, so their challenge window is unchanged).
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS effective_at BIGINT;
