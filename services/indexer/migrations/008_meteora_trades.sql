-- Meteora DBC / DAMM v2 trades of FUMPAD coins from ANY app (feature flag METEORA_INDEXER_ENABLED).
-- New tables only: nothing here is read by the curve/PumpSwap pipeline (transactions/trades/…).
-- One row per swap, keyed by (signature, ix_key) = the attestation uniqueness key (see
-- meteora/ATTESTATION.md). Amounts are raw token units (NUMERIC: exact u64/u128).

-- Signature cursors: DBC config keys (every swap / pool init / migration of their pools passes the
-- config account), FUMPAD mints (every swap passes the mint), and DAMM v2 pools discovered from migrations.
CREATE TABLE IF NOT EXISTS meteora_cursors (
  address        TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('dbc_config', 'mint', 'pool')),
  last_signature TEXT,
  last_slot      BIGINT NOT NULL DEFAULT 0,
  backfill_done  BOOLEAN NOT NULL DEFAULT false,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The FUMPAD pool set. A trade is stored only if its pool is here.
CREATE TABLE IF NOT EXISTS meteora_pools (
  pool         TEXT PRIMARY KEY,
  venue        TEXT NOT NULL CHECK (venue IN ('dbc', 'damm_v2')),
  base_mint    TEXT NOT NULL,
  quote_mint   TEXT,
  config       TEXT,                       -- DBC config key (dbc) / the DBC config it migrated from (damm_v2)
  dbc_pool     TEXT,                       -- damm_v2: the curve it graduated from
  source       TEXT NOT NULL,              -- 'pool_init' | 'swap' | 'migration'
  created_sig  TEXT,                       -- the tx that registered it (rolled back with it)
  created_slot BIGINT,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meteora_pools_mint ON meteora_pools (base_mint);

CREATE TABLE IF NOT EXISTS meteora_transactions (
  signature    TEXT PRIMARY KEY,
  slot         BIGINT NOT NULL,
  block_time   BIGINT,
  commitment   TEXT NOT NULL,              -- 'confirmed' | 'finalized'
  source       TEXT NOT NULL,              -- 'rpc' | 'webhook' | 'backfill' | 'reconcile'
  status       TEXT NOT NULL,              -- parse status: 'ok' | 'failed' (tx failed on chain) | 'error'
  version      TEXT NOT NULL,              -- 'legacy' | '0' | '1'
  trade_count  INT NOT NULL DEFAULT 0,
  issue_count  INT NOT NULL DEFAULT 0,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS meteora_transactions_pending ON meteora_transactions (slot, signature) WHERE commitment <> 'finalized';

CREATE TABLE IF NOT EXISTS meteora_trades (
  signature              TEXT NOT NULL REFERENCES meteora_transactions (signature) ON DELETE CASCADE,
  ix_key                 INT NOT NULL,     -- (top_ix << 16) | (inner_ix + 1)
  top_ix                 INT NOT NULL,
  inner_ix               INT NOT NULL,
  stack_height           INT NOT NULL,
  slot                   BIGINT NOT NULL,
  block_time             BIGINT,
  venue                  TEXT NOT NULL,
  pool                   TEXT NOT NULL,
  config                 TEXT,
  base_mint              TEXT NOT NULL,
  quote_mint             TEXT NOT NULL,
  side                   TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  trader                 TEXT,
  trader_source          TEXT NOT NULL,
  swap_authority         TEXT NOT NULL,
  fee_payer              TEXT NOT NULL,
  signers                TEXT[] NOT NULL,
  input_token_account    TEXT NOT NULL,
  output_token_account   TEXT NOT NULL,
  input_owner            TEXT,
  output_owner           TEXT,
  base_amount            NUMERIC(20, 0) NOT NULL,
  quote_gross            NUMERIC(20, 0) NOT NULL,
  quote_net              NUMERIC(20, 0) NOT NULL,
  amount_in              NUMERIC(20, 0) NOT NULL,
  amount_in_after_fee    NUMERIC(20, 0) NOT NULL,
  amount_out             NUMERIC(20, 0) NOT NULL,
  amount_in_incl_transfer_fee NUMERIC(20, 0) NOT NULL,
  amount_out_received    NUMERIC(20, 0) NOT NULL,
  fee_token              TEXT NOT NULL,
  fee_on_input           BOOLEAN NOT NULL,
  fee_total              NUMERIC(20, 0) NOT NULL,
  fee_trading            NUMERIC(20, 0) NOT NULL,
  fee_protocol           NUMERIC(20, 0) NOT NULL,
  fee_referral           NUMERIC(20, 0) NOT NULL,
  fee_compounding        NUMERIC(20, 0) NOT NULL,
  has_referral           BOOLEAN NOT NULL,
  referral_token_account TEXT,
  referral_owner         TEXT,
  swap_mode              SMALLINT NOT NULL,
  instruction            TEXT NOT NULL,
  next_sqrt_price        NUMERIC(40, 0) NOT NULL,
  curve_complete         BOOLEAN NOT NULL DEFAULT false,
  app                    TEXT NOT NULL,
  app_via                TEXT NOT NULL,
  app_evidence           TEXT,
  outer_programs         TEXT[] NOT NULL,
  event_ts               BIGINT NOT NULL,
  event_raw              TEXT NOT NULL,     -- base64 EvtSwap2, re-decodable (decodeEventRaw)
  PRIMARY KEY (signature, ix_key)
);
CREATE INDEX IF NOT EXISTS meteora_trades_pool ON meteora_trades (pool, slot DESC);
CREATE INDEX IF NOT EXISTS meteora_trades_mint ON meteora_trades (base_mint, slot DESC);
-- hold-time / rebuy-rule inputs: one wallet's trades of one coin in order
CREATE INDEX IF NOT EXISTS meteora_trades_trader ON meteora_trades (trader, base_mint, slot);

-- Swaps in fetched transactions that could NOT be turned into an exact record (fail closed).
CREATE TABLE IF NOT EXISTS meteora_parse_issues (
  signature TEXT NOT NULL REFERENCES meteora_transactions (signature) ON DELETE CASCADE,
  n         INT NOT NULL,
  code      TEXT NOT NULL,
  ix_key    INT,
  pool      TEXT,
  message   TEXT NOT NULL,
  PRIMARY KEY (signature, n)
);
