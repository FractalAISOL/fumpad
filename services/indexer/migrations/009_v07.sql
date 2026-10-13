-- FUMPAD v0.7 (Meteora DBC → DAMM v2, attested tickets). Fresh program id (D39): the v0.6 rows of a
-- database are not migrated (devnet/local start from an empty schema); these columns extend the shared
-- tables for the v0.7 event set and for trades from every app on the coin's own pools.

ALTER TABLE coins ADD COLUMN IF NOT EXISTS dbc_pool TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS dbc_config TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS damm_pool TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS damm_position TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS launch_slot BIGINT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS launch_window_slots BIGINT;
-- DBC curve (from the config) and the current segment's liquidity, for quotes and "tokens left".
ALTER TABLE coins ADD COLUMN IF NOT EXISTS migration_threshold NUMERIC(40,0);
ALTER TABLE coins ADD COLUMN IF NOT EXISTS sqrt_price NUMERIC(60,0);
ALTER TABLE coins ADD COLUMN IF NOT EXISTS liquidity NUMERIC(60,0);
ALTER TABLE coins ADD COLUMN IF NOT EXISTS migration_fee_lamports NUMERIC(40,0);
ALTER TABLE coins ADD COLUMN IF NOT EXISTS leftover_tokens NUMERIC(40,0);
CREATE INDEX IF NOT EXISTS coins_dbc_pool ON coins (dbc_pool);
CREATE INDEX IF NOT EXISTS coins_damm_pool ON coins (damm_pool);

-- trades now come from @fumpad/meteora records (any app); idx = the swap's ix_key.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS venue TEXT;            -- 'dbc' | 'damm_v2'
ALTER TABLE trades ADD COLUMN IF NOT EXISTS routed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS app TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS trader_source TEXT;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee_total NUMERIC(40,0);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS fee_protocol NUMERIC(40,0);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS quote_net NUMERIC(40,0);

-- tickets are created by attestations (D31)
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'outside';   -- 'router' | 'outside'
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS venue TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sell_signature TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sell_ix_key BIGINT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS attested_at BIGINT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS keepers TEXT[];
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS void_reason TEXT;      -- 'rebuy' | 'guardian'
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS app TEXT;
CREATE INDEX IF NOT EXISTS tickets_sell ON tickets (sell_signature, sell_ix_key);

ALTER TABLE samples ADD COLUMN IF NOT EXISTS venue INT NOT NULL DEFAULT 1;  -- 0 pre-grad DBC (guard only), 1 DAMM v2

CREATE TABLE IF NOT EXISTS fee_claims (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  mint TEXT NOT NULL,
  venue INT NOT NULL,
  claimed NUMERIC(40,0) NOT NULL,
  to_buyback NUMERIC(40,0) NOT NULL,
  to_platform NUMERIC(40,0) NOT NULL,
  to_creator NUMERIC(40,0) NOT NULL,
  launch_window BOOLEAN NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS fee_claims_mint ON fee_claims (mint, ts);
