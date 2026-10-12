-- D18: pre-ground vanity mint keypairs (base58 address ending in `fmbL`), app-level only.
-- Written by services/grinder (Rust), reserved + co-signed by the API (POST /v1/launch/prepare),
-- marked `used` by the indexer when CoinCreated lands. The 32-byte seed is AES-256-GCM encrypted
-- under MINT_POOL_KEY (format: services/grinder/src/crypto.rs) and wiped once the mint is used.

CREATE TABLE IF NOT EXISTS vanity_mints (
  pubkey       TEXT PRIMARY KEY,
  suffix       TEXT NOT NULL,
  secret_enc   BYTEA,                               -- nonce ‖ ciphertext ‖ tag; NULL once used
  enc_version  SMALLINT NOT NULL DEFAULT 1,
  key_fp       TEXT NOT NULL,                       -- fingerprint of the encrypting key (rotation)
  status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'used')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reserved_at  TIMESTAMPTZ,
  reserved_by  TEXT,                                -- creator wallet the mint is reserved for
  reserved_ip  TEXT,
  last_valid_block_height BIGINT,                   -- of the newest co-signed tx (release only after it expires)
  reserve_count INT NOT NULL DEFAULT 0,
  used_tx      TEXT,
  used_at      TIMESTAMPTZ,
  CHECK (status = 'used' OR secret_enc IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS vanity_mints_available ON vanity_mints (suffix, key_fp, created_at) WHERE status = 'available';
CREATE INDEX IF NOT EXISTS vanity_mints_reserved_by ON vanity_mints (reserved_by) WHERE status = 'reserved';
CREATE INDEX IF NOT EXISTS vanity_mints_reserved_at ON vanity_mints (reserved_at) WHERE status = 'reserved';
