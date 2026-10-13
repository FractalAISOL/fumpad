//! Program id per cluster without editing code (services/LAUNCH-DAY.md "Verifiable build").
//!
//! Default build: `declare_id!` in src/lib.rs = the devnet id (contracts/program-ids/devnet.txt).
//! `--features mainnet`: the id committed in contracts/program-ids/mainnet.txt (filled in on launch day from the
//! freshly generated program keypair, committed, then built verifiably from that commit) is written to
//! `$OUT_DIR/mainnet_id.rs` as `declare_id!("<id>");`, which src/lib.rs includes instead. The build fails if the
//! file holds no valid 32-byte base58 key, so a placeholder can never be deployed. No environment variable is read:
//! the bytes depend only on the commit + the feature flag (reproducible).
use std::{env, fs, path::Path};

const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn base58_decode(s: &str) -> Option<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new(); // little-endian base-256
    for c in s.bytes() {
        let mut carry = ALPHABET.iter().position(|&a| a == c)? as u32;
        for b in out.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            out.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    out.extend(s.bytes().take_while(|&c| c == b'1').map(|_| 0));
    out.reverse();
    Some(out)
}

/// The id in a program-ids/*.txt file: the first line that is neither empty nor a `#` comment.
fn read_id(path: &Path) -> String {
    let text = fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let id = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|l| *l != "UNSET")
        .unwrap_or_else(|| panic!("{} holds no program id yet: put the mainnet program keypair's pubkey there (LAUNCH-DAY.md)", path.display()));
    match base58_decode(id) {
        Some(b) if b.len() == 32 => id.to_string(),
        _ => panic!("{}: {id:?} is not a 32-byte base58 public key", path.display()),
    }
}

fn main() {
    let ids = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../program-ids");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", ids.join("mainnet.txt").display());
    println!("cargo:rerun-if-changed={}", ids.join("devnet.txt").display());
    if env::var_os("CARGO_FEATURE_MAINNET").is_some() {
        let id = read_id(&ids.join("mainnet.txt"));
        let devnet = read_id(&ids.join("devnet.txt"));
        if id == devnet {
            panic!("program-ids/mainnet.txt = the devnet id {devnet}: the mainnet program needs its own keypair");
        }
        let out = Path::new(&env::var("OUT_DIR").unwrap()).join("mainnet_id.rs");
        fs::write(out, format!("declare_id!(\"{id}\");\n")).unwrap();
    }
}
