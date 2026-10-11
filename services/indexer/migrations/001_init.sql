-- FUMPAD indexer schema. u64/u128 chain values are NUMERIC(40,0); times are unix seconds (BIGINT).
-- Raw layer: transactions → events (source of truth, SPEC §6). Event tables and "current state"
-- tables are derived from events and can be rebuilt per mint (indexer/src/replay.ts).

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-address ingestion cursor (program ids and watched PumpSwap pools).
CREATE TABLE IF NOT EXISTS cursors (
  address        TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,            -- 'program' | 'pool'
  mint           TEXT,
  last_signature TEXT,
  last_slot      BIGINT NOT NULL DEFAULT 0,
  backfill_done  BOOLEAN NOT NULL DEFAULT false,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  signature   TEXT PRIMARY KEY,
  seq         BIGSERIAL UNIQUE,
  slot        BIGINT NOT NULL,
  block_time  BIGINT,
  commitment  TEXT NOT NULL,               -- 'confirmed' | 'finalized'
  source      TEXT NOT NULL,               -- 'rpc' | 'webhook' | 'backfill' | 'reconcile'
  kind        TEXT NOT NULL,               -- 'fumpad' (has FUMPAD/locker events) | 'external' (pool trade outside FUMPAD) | 'none'
  event_count INT NOT NULL DEFAULT 0,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS transactions_slot ON transactions (slot);
CREATE INDEX IF NOT EXISTS transactions_unfinalized ON transactions (slot) WHERE commitment <> 'finalized';

CREATE TABLE IF NOT EXISTS events (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx       INT NOT NULL,
  program   TEXT NOT NULL,                 -- 'fumpad' | 'locker'
  name      TEXT NOT NULL,
  mint      TEXT,
  slot      BIGINT NOT NULL,
  ts        BIGINT,
  data      JSONB NOT NULL,                -- decoded, for humans/ad-hoc SQL
  raw       TEXT NOT NULL,                 -- base64 discriminator‖borsh, re-decoded on replay
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS events_mint ON events (mint, slot);
CREATE INDEX IF NOT EXISTS events_name ON events (name, slot);

-- ── current state ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS coins (
  mint            TEXT PRIMARY KEY,
  creator         TEXT NOT NULL,
  name            TEXT NOT NULL,
  symbol          TEXT NOT NULL,
  uri             TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  created_sig     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'curve',     -- curve | complete | graduated (D13: complete → curve on reopen)
  completed_at    BIGINT,
  graduated_at    BIGINT,
  amm_pool        TEXT,
  raised_lamports NUMERIC(40,0) NOT NULL DEFAULT 0,  -- SOL deposited into PumpSwap at graduation
  tokens_to_lp    NUMERIC(40,0),
  lp_locked       NUMERIC(40,0),
  virtual_sol     NUMERIC(40,0) NOT NULL,
  virtual_tokens  NUMERIC(40,0) NOT NULL,
  real_sol        NUMERIC(40,0) NOT NULL DEFAULT 0,
  real_tokens     NUMERIC(40,0) NOT NULL,
  amm_base        NUMERIC(40,0),
  amm_quote       NUMERIC(40,0),                    -- effective (vault + virtual_quote_reserves)
  price_q64       NUMERIC(40,0) NOT NULL,            -- last observed spot
  price_slot      BIGINT NOT NULL DEFAULT 0,
  reference_q64   NUMERIC(40,0),
  median_q64      NUMERIC(40,0),
  median_samples  INT NOT NULL DEFAULT 0,
  volume_lamports NUMERIC(40,0) NOT NULL DEFAULT 0,
  trade_count     BIGINT NOT NULL DEFAULT 0,
  last_trade_at   BIGINT,
  pool_seeded     NUMERIC(40,0) NOT NULL,
  pool_tokens     NUMERIC(40,0) NOT NULL,            -- reward vault (event-derived; chain sync overwrites)
  pool_bought     NUMERIC(40,0) NOT NULL DEFAULT 0,
  pool_paid_out   NUMERIC(40,0) NOT NULL DEFAULT 0,
  queue_owed      NUMERIC(40,0) NOT NULL DEFAULT 0,
  tickets_created BIGINT NOT NULL DEFAULT 0,
  tickets_open    BIGINT NOT NULL DEFAULT 0,
  buyback_pending NUMERIC(40,0) NOT NULL DEFAULT 0,
  platform_fees_unclaimed NUMERIC(40,0) NOT NULL DEFAULT 0,
  creator_fees_unclaimed  NUMERIC(40,0) NOT NULL DEFAULT 0,
  metadata        JSONB,                             -- off-chain JSON at `uri` (description, image, links)
  chain_synced_at TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS coins_status ON coins (status, created_at DESC);
CREATE INDEX IF NOT EXISTS coins_symbol ON coins (upper(symbol));

CREATE TABLE IF NOT EXISTS trades (
  signature  TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx        INT NOT NULL,
  slot       BIGINT NOT NULL,
  ts         BIGINT NOT NULL,
  mint       TEXT NOT NULL,
  wallet     TEXT NOT NULL,
  is_buy     BOOLEAN NOT NULL,
  on_amm     BOOLEAN NOT NULL,
  token_amount NUMERIC(40,0) NOT NULL,
  sol_amount   NUMERIC(40,0) NOT NULL,
  fee_pool     NUMERIC(40,0) NOT NULL,
  fee_platform NUMERIC(40,0) NOT NULL,
  fee_creator  NUMERIC(40,0) NOT NULL,
  pool_tokens_bought NUMERIC(40,0) NOT NULL,
  price_q64    NUMERIC(40,0) NOT NULL,
  virtual_sol  NUMERIC(40,0) NOT NULL,
  virtual_tokens NUMERIC(40,0) NOT NULL,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS trades_mint_ts ON trades (mint, ts DESC);
CREATE INDEX IF NOT EXISTS trades_wallet ON trades (wallet, ts DESC);

CREATE TABLE IF NOT EXISTS tickets (
  ticket          TEXT PRIMARY KEY,
  mint            TEXT NOT NULL,
  owner           TEXT NOT NULL,
  seq             BIGINT NOT NULL,
  tokens          NUMERIC(40,0) NOT NULL,
  original_tokens NUMERIC(40,0) NOT NULL,
  sell_price_q64  NUMERIC(40,0) NOT NULL,
  exec_price_q64  NUMERIC(40,0) NOT NULL,
  sell_usd_cents  NUMERIC(40,0) NOT NULL,
  sell_lamports   NUMERIC(40,0) NOT NULL,
  sell_ts         BIGINT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',      -- open | queued | claimed | expired | voided | escrowed
  queued_at       BIGINT,
  claim_amount    NUMERIC(40,0) NOT NULL DEFAULT 0,
  claimed_at      BIGINT,
  claim_sig       TEXT,
  claim_median_q64 NUMERIC(40,0),
  escrow          TEXT,                              -- D16 escrow PDA when paid into escrow
  debited         NUMERIC(40,0) NOT NULL DEFAULT 0,
  peak_multiple   DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_multiple   DOUBLE PRECISION NOT NULL DEFAULT 0,
  crossed_at      BIGINT,
  crossed_multiple DOUBLE PRECISION,
  closed_at       BIGINT,
  created_sig     TEXT NOT NULL,
  created_slot    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_owner ON tickets (owner, sell_ts DESC);
CREATE INDEX IF NOT EXISTS tickets_mint_status ON tickets (mint, status);

CREATE TABLE IF NOT EXISTS ticket_debits (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  ticket TEXT NOT NULL,
  mint TEXT,
  debited NUMERIC(40,0) NOT NULL,
  remaining NUMERIC(40,0) NOT NULL,
  voided BOOLEAN NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (signature, idx)
);

CREATE TABLE IF NOT EXISTS claims (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  mint TEXT NOT NULL,
  ticket TEXT NOT NULL,
  owner TEXT NOT NULL,
  amount NUMERIC(40,0) NOT NULL,
  from_queue BOOLEAN NOT NULL,
  escrowed BOOLEAN NOT NULL DEFAULT false,           -- D16: paid into the ticket's escrow
  skipped_ahead BOOLEAN NOT NULL DEFAULT false,
  median_q64 NUMERIC(40,0) NOT NULL,
  sell_price_q64 NUMERIC(40,0),
  ts BIGINT NOT NULL,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS claims_owner ON claims (owner, ts DESC);
CREATE INDEX IF NOT EXISTS claims_ts ON claims (ts DESC);

-- Mirror of the on-chain claim queue (ClaimQueued → ClaimPaid / close / void).
CREATE TABLE IF NOT EXISTS queue_entries (
  ticket    TEXT PRIMARY KEY,
  mint      TEXT NOT NULL,
  owner     TEXT NOT NULL,
  amount    NUMERIC(40,0) NOT NULL,
  sell_ts   BIGINT NOT NULL,
  queued_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_mint ON queue_entries (mint, sell_ts, ticket);

CREATE TABLE IF NOT EXISTS samples (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  mint TEXT NOT NULL,
  price_q64 NUMERIC(40,0) NOT NULL,
  fallback BOOLEAN NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (signature, idx)
);
CREATE INDEX IF NOT EXISTS samples_mint_ts ON samples (mint, ts DESC);

CREATE TABLE IF NOT EXISTS buybacks (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  mint TEXT NOT NULL,
  lamports_in NUMERIC(40,0) NOT NULL,
  tokens_out NUMERIC(40,0) NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (signature, idx)
);

CREATE TABLE IF NOT EXISTS fee_withdrawals (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  mint TEXT NOT NULL,
  recipient TEXT NOT NULL,
  lamports NUMERIC(40,0) NOT NULL,
  is_creator BOOLEAN NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (signature, idx)
);

CREATE TABLE IF NOT EXISTS lp_locks (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  pool TEXT NOT NULL,
  mint TEXT NOT NULL,
  lp_locked NUMERIC(40,0) NOT NULL,
  lp_supply NUMERIC(40,0) NOT NULL,
  sqrt_k NUMERIC(40,0) NOT NULL,
  PRIMARY KEY (signature, idx)
);

CREATE TABLE IF NOT EXISTS lp_skims (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  pool TEXT NOT NULL,
  mint TEXT NOT NULL,
  lp_withdrawn NUMERIC(40,0) NOT NULL,
  base_out NUMERIC(40,0) NOT NULL,
  quote_out NUMERIC(40,0) NOT NULL,
  lp_held NUMERIC(40,0) NOT NULL,
  ts BIGINT,
  PRIMARY KEY (signature, idx)
);

CREATE TABLE IF NOT EXISTS lp_settlements (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  mint TEXT NOT NULL,
  lamports NUMERIC(40,0) NOT NULL,
  platform NUMERIC(40,0) NOT NULL,
  creator NUMERIC(40,0) NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (signature, idx)
);

CREATE TABLE IF NOT EXISTS holdings_registered (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  idx INT NOT NULL,
  mint TEXT NOT NULL,
  wallet TEXT NOT NULL,
  added NUMERIC(40,0) NOT NULL,
  ts BIGINT NOT NULL,
  PRIMARY KEY (signature, idx)
);

-- Wallet balances as seen through FUMPAD (trades, claims). Approximate: transfers and
-- other venues are invisible to events (external_trades covers FUMPAD pools).
CREATE TABLE IF NOT EXISTS positions (
  mint      TEXT NOT NULL,
  wallet    TEXT NOT NULL,
  balance   NUMERIC(40,0) NOT NULL DEFAULT 0,
  bought    NUMERIC(40,0) NOT NULL DEFAULT 0,
  sold      NUMERIC(40,0) NOT NULL DEFAULT 0,
  claimed   NUMERIC(40,0) NOT NULL DEFAULT 0,
  sol_in    NUMERIC(40,0) NOT NULL DEFAULT 0,
  sol_out   NUMERIC(40,0) NOT NULL DEFAULT 0,
  buys      INT NOT NULL DEFAULT 0,
  sells     INT NOT NULL DEFAULT 0,
  first_ts  BIGINT,
  last_ts   BIGINT,
  PRIMARY KEY (mint, wallet)
);
CREATE INDEX IF NOT EXISTS positions_wallet ON positions (wallet);

CREATE TABLE IF NOT EXISTS users (
  address    TEXT PRIMARY KEY,
  name       TEXT,
  first_seen BIGINT,
  last_seen  BIGINT
);

CREATE TABLE IF NOT EXISTS feed_events (
  id        TEXT PRIMARY KEY,                -- signature:idx:kind (or derived key)
  seq       BIGSERIAL UNIQUE,
  kind      TEXT NOT NULL,                   -- launch | fumble | cross | graduation | claim
  ts        BIGINT NOT NULL,
  mint      TEXT NOT NULL,
  actor     TEXT NOT NULL,
  signature TEXT REFERENCES transactions(signature) ON DELETE CASCADE,
  payload   JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS feed_ts ON feed_events (ts DESC, seq DESC);
CREATE INDEX IF NOT EXISTS feed_kind_ts ON feed_events (kind, ts DESC);

-- PumpSwap trades on FUMPAD pools that did NOT go through FUMPAD (rebuys elsewhere, arbs).
CREATE TABLE IF NOT EXISTS external_trades (
  signature TEXT NOT NULL REFERENCES transactions(signature) ON DELETE CASCADE,
  mint      TEXT NOT NULL,
  wallet    TEXT NOT NULL,
  base_delta  NUMERIC(40,0) NOT NULL,        -- + = bought
  quote_delta NUMERIC(40,0) NOT NULL,        -- lamports, + = received
  slot      BIGINT NOT NULL,
  ts        BIGINT,
  PRIMARY KEY (signature, mint, wallet)
);
CREATE INDEX IF NOT EXISTS external_trades_wallet ON external_trades (wallet, mint, ts);

-- Funding graph (first SOL funder of a wallet) and flags (D9: public, leaderboard-excluding, never blocking).
CREATE TABLE IF NOT EXISTS wallet_funding (
  wallet     TEXT PRIMARY KEY,
  funder     TEXT,
  lamports   NUMERIC(40,0),
  signature  TEXT,
  ts         BIGINT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS wallet_funding_funder ON wallet_funding (funder);

CREATE TABLE IF NOT EXISTS wallet_clusters (
  wallet     TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  size       INT NOT NULL
);

CREATE TABLE IF NOT EXISTS wallet_flags (
  wallet  TEXT NOT NULL,
  reason  TEXT NOT NULL,                     -- rebuy_elsewhere | creator_linked | linked_wallets
  mint    TEXT NOT NULL DEFAULT '',
  detail  JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts      BIGINT NOT NULL,
  PRIMARY KEY (wallet, reason, mint)
);

-- Game layer (recomputed by the derive job).
CREATE TABLE IF NOT EXISTS user_stats (
  address        TEXT PRIMARY KEY,
  xp             BIGINT NOT NULL,
  level          INT NOT NULL,
  tickets_filed  INT NOT NULL,
  crossed        INT NOT NULL,
  claims         INT NOT NULL,
  claimed_lamports NUMERIC(40,0) NOT NULL,
  worst_mint     TEXT,
  worst_multiple DOUBLE PRECISION,
  fumble_value_lamports NUMERIC(40,0) NOT NULL DEFAULT 0,
  fumble_rank    INT,
  achievements   JSONB NOT NULL,
  flagged        BOOLEAN NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
