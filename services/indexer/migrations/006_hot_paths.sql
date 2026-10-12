-- Pre-mainnet: indexes for the API's hot paths (measured with services/scripts/loadtest.ts at
-- 5k coins / 2M trades / 200k tickets / 50k wallets). Each one is named after the read it serves.

-- Recent trades on a coin (ORDER BY ts, slot, idx DESC LIMIT n) without a sort, and every
-- per-coin time range (24 h volume, spark, chart). Supersedes trades_mint_ts.
CREATE INDEX IF NOT EXISTS trades_mint_recent ON trades (mint, ts DESC, slot DESC, idx DESC);
DROP INDEX IF EXISTS trades_mint_ts;
-- Launches board "trending": 24 h volume of every coin in one index-only range scan.
CREATE INDEX IF NOT EXISTS trades_ts_vol ON trades (ts) INCLUDE (mint, sol_amount);

-- Holder counts and the top-20 holders list touch only non-zero balances.
CREATE INDEX IF NOT EXISTS positions_holders ON positions (mint, balance DESC) WHERE balance > 0;

-- Closest open ticket to the trigger per coin: the smallest sell price above a bound.
CREATE INDEX IF NOT EXISTS tickets_open_price ON tickets (mint, sell_price_q64) WHERE status = 'open';
-- "Closest to 10x" across the platform.
CREATE INDEX IF NOT EXISTS tickets_open_multiple ON tickets (last_multiple DESC) WHERE status = 'open';
-- Recent fumbles on a coin.
CREATE INDEX IF NOT EXISTS tickets_mint_sell ON tickets (mint, sell_ts DESC);
-- Stats: crossings in the last 24 h.
CREATE INDEX IF NOT EXISTS tickets_crossed_at ON tickets (crossed_at) WHERE crossed_at IS NOT NULL;

-- Payout median of a claimed ticket (ticket view) and the diamond-hands board join.
CREATE INDEX IF NOT EXISTS claims_ticket ON claims (ticket, ts DESC);

-- Reward-pool inflow over 24 h (coin detail, claim queue ETAs).
CREATE INDEX IF NOT EXISTS buybacks_mint_ts ON buybacks (mint, ts DESC);
CREATE INDEX IF NOT EXISTS lp_skims_mint_ts ON lp_skims (mint, ts DESC);

-- /v1/status: newest keeper sample.
CREATE INDEX IF NOT EXISTS samples_ts ON samples (ts DESC) WHERE NOT fallback;

-- Profile lookup by name (`address = $1 OR lower(name) = lower($1)` → BitmapOr).
CREATE INDEX IF NOT EXISTS users_lower_name ON users (lower(name));

-- Launches board "new" across all statuses.
CREATE INDEX IF NOT EXISTS coins_created ON coins (created_at DESC);

-- ── Maintained per-coin aggregates (exact; triggers keep them right through ingest, replay and
--    rollback, since those all go through INSERT/DELETE on trades and positions) ──────────────

-- Hourly FUMPAD volume per coin. 24 h volume = whole hours from here + the partial edge hour
-- from `trades`, so the Launches board never sums a day of trades per coin.
CREATE TABLE IF NOT EXISTS coin_hourly (
  mint   TEXT NOT NULL,
  hour   BIGINT NOT NULL,                  -- ts / 3600
  volume BIGINT NOT NULL DEFAULT 0,        -- sum(trades.sol_amount), lamports
  trades INT NOT NULL DEFAULT 0,
  PRIMARY KEY (mint, hour)
);
CREATE INDEX IF NOT EXISTS coin_hourly_hour ON coin_hourly (hour) INCLUDE (mint, volume);

-- Wallets with a non-zero FUMPAD-observed balance per coin (positions.balance > 0).
CREATE TABLE IF NOT EXISTS coin_holders (
  mint TEXT PRIMARY KEY,
  n    INT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION fumpad_trades_rollup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'UPDATE') THEN
    UPDATE coin_hourly SET volume = volume - OLD.sol_amount::bigint, trades = trades - 1 WHERE mint = OLD.mint AND hour = OLD.ts / 3600;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO coin_hourly AS h (mint, hour, volume, trades) VALUES (NEW.mint, NEW.ts / 3600, NEW.sol_amount::bigint, 1)
    ON CONFLICT (mint, hour) DO UPDATE SET volume = h.volume + EXCLUDED.volume, trades = h.trades + 1;
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION fumpad_positions_holders() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  was BOOLEAN := TG_OP IN ('DELETE', 'UPDATE') AND OLD.balance > 0;
  now_ BOOLEAN := TG_OP IN ('INSERT', 'UPDATE') AND NEW.balance > 0;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.mint = NEW.mint AND was = now_ THEN
    RETURN NULL;
  END IF;
  IF was THEN
    INSERT INTO coin_holders AS h (mint, n) VALUES (OLD.mint, -1) ON CONFLICT (mint) DO UPDATE SET n = h.n - 1;
  END IF;
  IF now_ THEN
    INSERT INTO coin_holders AS h (mint, n) VALUES (NEW.mint, 1) ON CONFLICT (mint) DO UPDATE SET n = h.n + 1;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trades_rollup ON trades;
CREATE TRIGGER trades_rollup AFTER INSERT OR DELETE OR UPDATE OF mint, ts, sol_amount ON trades
  FOR EACH ROW EXECUTE FUNCTION fumpad_trades_rollup();
DROP TRIGGER IF EXISTS positions_holders ON positions;
CREATE TRIGGER positions_holders AFTER INSERT OR DELETE OR UPDATE OF mint, balance ON positions
  FOR EACH ROW EXECUTE FUNCTION fumpad_positions_holders();

-- Recompute both from scratch (after bulk loads with triggers disabled; also a repair tool).
CREATE OR REPLACE FUNCTION fumpad_rebuild_aggregates() RETURNS void LANGUAGE sql AS $$
  DELETE FROM coin_hourly;
  INSERT INTO coin_hourly (mint, hour, volume, trades) SELECT mint, ts / 3600, sum(sol_amount)::bigint, count(*) FROM trades GROUP BY 1, 2;
  DELETE FROM coin_holders;
  INSERT INTO coin_holders (mint, n) SELECT mint, count(*) FROM positions WHERE balance > 0 GROUP BY mint;
$$;
-- The triggers above hold their table locks until this migration commits, so nothing slips
-- between them and the rebuild.
SELECT fumpad_rebuild_aggregates();
