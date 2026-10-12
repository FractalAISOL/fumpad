-- Contracts v0.5. D19 snipe tax: `Trade` carries `snipe_tax` (lamports, all of it to the reward
-- pool via the inline buyback, on top of the normal fee) and `snipe_tax_bps`; both 0 outside the
-- launch window and for events from the v0.4 program. D20: `Graduated` splits the graduation fee
-- into `caller_refund` + `setup_prefunded` + `platform_fee` (NULL = graduated under v0.4).

ALTER TABLE trades ADD COLUMN IF NOT EXISTS snipe_tax NUMERIC(40,0) NOT NULL DEFAULT 0;
ALTER TABLE trades ADD COLUMN IF NOT EXISTS snipe_tax_bps INT NOT NULL DEFAULT 0;

-- Early-launch stats per coin.
ALTER TABLE coins ADD COLUMN IF NOT EXISTS snipe_tax_lamports NUMERIC(40,0) NOT NULL DEFAULT 0;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS snipe_taxed_buys INT NOT NULL DEFAULT 0;
-- SOL that went to the reward pool from FUMPAD trades: the pool's fee share + snipe tax.
ALTER TABLE coins ADD COLUMN IF NOT EXISTS pool_inflow_lamports NUMERIC(40,0) NOT NULL DEFAULT 0;
UPDATE coins c SET pool_inflow_lamports = t.v
  FROM (SELECT mint, sum(fee_pool + snipe_tax) AS v FROM trades GROUP BY mint) t
 WHERE t.mint = c.mint AND c.pool_inflow_lamports = 0;

ALTER TABLE coins ADD COLUMN IF NOT EXISTS graduation_caller_refund NUMERIC(40,0);
ALTER TABLE coins ADD COLUMN IF NOT EXISTS graduation_setup_prefunded NUMERIC(40,0);
ALTER TABLE coins ADD COLUMN IF NOT EXISTS graduation_platform_fee NUMERIC(40,0);
