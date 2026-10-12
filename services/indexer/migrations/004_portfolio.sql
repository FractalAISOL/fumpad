-- Wallet portfolio (API /v1/wallets/:wallet/{positions,closed,created}). The ledger reads
-- use trades_wallet and claims_owner (001); these cover the creator side.
CREATE INDEX IF NOT EXISTS coins_creator ON coins (creator, created_at DESC);
CREATE INDEX IF NOT EXISTS fee_withdrawals_mint ON fee_withdrawals (mint) WHERE is_creator;
