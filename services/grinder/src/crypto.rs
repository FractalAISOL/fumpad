//! At-rest encryption of mint secrets (format shared with `services/api/src/launch/vault.ts`).
//!
//! - `MINT_POOL_KEY`: 32 bytes, as 64 hex chars or standard base64.
//! - `secret_enc` (enc_version 1) = nonce(12) ‖ AES-256-GCM(seed[32]) ‖ tag(16), with
//!   AAD = `"fumpad-vanity-mint:v1:" ‖ pubkey_base58`, so a ciphertext can't be moved to
//!   another row.
//! - `key_fp` = first 16 hex chars of SHA-256(`"fumpad-mint-pool-key-fp:" ‖ key`): lets the
//!   API reserve only rows it can decrypt (key rotation) without revealing the key.

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::Engine;
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

pub const ENC_VERSION: i16 = 1;
const AAD_PREFIX: &[u8] = b"fumpad-vanity-mint:v1:";
const FP_PREFIX: &[u8] = b"fumpad-mint-pool-key-fp:";

pub struct PoolKey {
    cipher: Aes256Gcm,
    pub fingerprint: String,
}

impl PoolKey {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let raw = raw.trim();
        let bytes: Zeroizing<Vec<u8>> = Zeroizing::new(if raw.len() == 64 && raw.bytes().all(|c| c.is_ascii_hexdigit()) {
            hex::decode(raw).map_err(|_| "MINT_POOL_KEY: bad hex")?
        } else {
            base64::engine::general_purpose::STANDARD
                .decode(raw)
                .map_err(|_| "MINT_POOL_KEY must be 32 bytes as 64 hex chars or base64")?
        });
        if bytes.len() != 32 {
            return Err(format!("MINT_POOL_KEY must be 32 bytes (got {})", bytes.len()));
        }
        let mut h = Sha256::new();
        h.update(FP_PREFIX);
        h.update(&bytes[..]);
        let fingerprint = hex::encode(&h.finalize()[..8]);
        let cipher = Aes256Gcm::new_from_slice(&bytes).map_err(|_| "bad key length")?;
        Ok(Self { cipher, fingerprint })
    }

    pub fn encrypt(&self, pubkey_b58: &str, seed: &[u8; 32]) -> Vec<u8> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = [AAD_PREFIX, pubkey_b58.as_bytes()].concat();
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), Payload { msg: seed, aad: &aad })
            .expect("AES-GCM encryption cannot fail for 32-byte input");
        [nonce.as_slice(), &ct].concat()
    }

    #[cfg(test)]
    pub fn decrypt(&self, pubkey_b58: &str, blob: &[u8]) -> Option<Vec<u8>> {
        let (nonce, ct) = blob.split_at(12);
        let aad = [AAD_PREFIX, pubkey_b58.as_bytes()].concat();
        self.cipher.decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: &aad }).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_binding() {
        let k = PoolKey::parse(&"11".repeat(32)).unwrap();
        let seed = [7u8; 32];
        let blob = k.encrypt("Abc", &seed);
        assert_eq!(blob.len(), 12 + 32 + 16);
        assert_eq!(k.decrypt("Abc", &blob).unwrap(), seed);
        assert!(k.decrypt("Abd", &blob).is_none(), "AAD binds the pubkey");
        let b64 = base64::engine::general_purpose::STANDARD.encode([0x11u8; 32]);
        assert_eq!(PoolKey::parse(&b64).unwrap().fingerprint, k.fingerprint);
        assert!(PoolKey::parse("abcd").is_err());
    }

    /// Pinned so the TypeScript side (`api/test/vault.test.ts`) computes the same value.
    #[test]
    fn fingerprint_vector() {
        let k = PoolKey::parse(&"11".repeat(32)).unwrap();
        assert_eq!(k.fingerprint, "cc290de99b2f1d15");
    }
}
