-- Per-config fee policies (INTERFACE-v0.7 §5.9, 2026-10-14): each coin carries the policy its config had at
-- registration (CoinRegistered.fee_policy) and its own fee schedule (from its DBC config: the first-coin config
-- trades at 3% instead of 1.25%). NULL fee columns = not known yet (chain sync fills them from the DBC config);
-- readers fall back to the protocol's standard config.
ALTER TABLE coins ADD COLUMN IF NOT EXISTS fee_policy_kind SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS fee_wallet TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS fee_buyback_share INT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS fee_wallet_share INT;
-- Normal trading fee on the curve (bps), the launch-window start fee (bps), the window (slots), the DAMM v2 fee (bps).
ALTER TABLE coins ADD COLUMN IF NOT EXISTS fee_bps INT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS snipe_start_bps INT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS snipe_window_slots INT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS migrated_fee_bps INT;
-- FeesClaimed.to_wallet / fee_wallet (wallet-split coins; 0 / NULL otherwise).
ALTER TABLE fee_claims ADD COLUMN IF NOT EXISTS to_wallet NUMERIC(40,0) NOT NULL DEFAULT 0;
ALTER TABLE fee_claims ADD COLUMN IF NOT EXISTS fee_wallet TEXT;
ALTER TABLE coins ADD COLUMN IF NOT EXISTS wallet_fees_paid NUMERIC(40,0) NOT NULL DEFAULT 0;
