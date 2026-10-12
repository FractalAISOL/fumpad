-- Contracts v0.4 (D17): keeper auto-claim. ClaimPaid / ClaimQueued / ClaimEscrowed carry
-- `triggered_by` (owner for claim, keeper for claim_for, cranker for process_queue);
-- AutoClaimSet toggles a wallet's opt-out per coin (on by default).

ALTER TABLE claims ADD COLUMN IF NOT EXISTS triggered_by TEXT;
-- A keeper claimed on the owner's behalf (not a queue payout, which is always cranked).
ALTER TABLE claims ADD COLUMN IF NOT EXISTS auto BOOLEAN
  GENERATED ALWAYS AS (triggered_by IS NOT NULL AND triggered_by <> owner AND NOT from_queue) STORED;
ALTER TABLE queue_entries ADD COLUMN IF NOT EXISTS triggered_by TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS auto_claimed BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE positions ADD COLUMN IF NOT EXISTS auto_claim_opt_out BOOLEAN NOT NULL DEFAULT false;
