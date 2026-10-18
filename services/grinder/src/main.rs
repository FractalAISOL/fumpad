//! fumpad-grinder — keeps a Postgres pool of vanity mint keypairs (D18).
//!
//! Every coin launched from the FUMPAD app gets a mint whose base58 address ends in
//! `fmbL` (configurable). Grinding one takes ~58^4 ≈ 11.3M random keys, so this worker
//! grinds ahead of demand on all cores and stores each match in `vanity_mints`
//! (indexer/migrations/002_vanity_mints.sql) with the 32-byte seed AES-256-GCM-encrypted
//! under `MINT_POOL_KEY`. The API reserves a row per launch and co-signs as the mint;
//! secrets never leave the server side and are never logged here.
//!
//! Modes:
//!   (default)        pool keeper: top `available` up to POOL_TARGET, sleep when full
//!   --once N         grind N keys into the pool and exit (tests, seeding)
//!   --bench SECS     measure keys/sec on this machine (no DB, nothing stored)
//! Options: --suffix S (VANITY_SUFFIX, default fmbL) --threads T (GRINDER_THREADS,
//! default = cores) --target N (POOL_TARGET, default 200).
//! Env: DATABASE_URL, MINT_POOL_KEY, POOL_POLL_SECS (30), DATABASE_SSL (L-4, S-10). A server certificate is never
//! accepted unverified:
//!   auto         (default) private-network host (localhost, 127.0.0.0/8, ::1, *.railway.internal — Railway's private
//!                network is WireGuard-encrypted) → `verify-full` if a CA is pinned, else plaintext; any other host →
//!                `verify-ca` if a CA is pinned, else `verify-full` against the system roots
//!   disable      plaintext (only for a trusted private network / local dev)
//!   verify-ca    TLS mandatory, chain verified against the PINNED CA only (DATABASE_SSL_ROOT_CERT = PEM path, or
//!                DATABASE_SSL_ROOT_CERT_PEM = the PEM itself); the hostname is not checked. For Railway Postgres
//!                through its public TCP proxy: the server cert is issued by a per-database CA
//!                (`/var/lib/postgresql/data/certs/root.crt`, CN=root-ca) with SAN localhost (+ the private domain on
//!                current templates), never the `*.proxy.rlwy.net` name — so pin root.crt and use verify-ca.
//!   verify-full  TLS mandatory, chain + hostname verified (pinned CA if set, else the system roots)
//!   require      legacy: = verify-ca (a pinned CA is then required);  prefer  legacy: = auto
//! Run the grinder under its own Postgres role limited to `vanity_mints` (see README).

mod crypto;
mod suffix;

use std::{
    env,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};

use ed25519_dalek::SigningKey;
use native_tls::{Certificate, TlsConnector};
use postgres::{config::SslMode, Client};
use postgres_native_tls::MakeTlsConnector;
use rand_chacha::{rand_core::SeedableRng, ChaCha20Rng};
use rand_core::RngCore;
use zeroize::Zeroizing;

use crypto::{PoolKey, ENC_VERSION};
use suffix::Matcher;

struct Found {
    pubkey: String,
    seed: Zeroizing<[u8; 32]>,
}

fn log(msg: &str) {
    let ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    println!("{{\"ts\":{ts},\"svc\":\"grinder\",\"msg\":{}}}", json_str(msg));
}
fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            c if (c as u32) < 0x20 => o.push(' '),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Grind on `threads` workers until `want` matches were handed to `on_found` (or, with
/// `want == 0`, until `deadline`). Returns (tries, elapsed).
fn grind(matcher: &Matcher, threads: usize, want: u64, deadline: Option<Instant>, mut on_found: impl FnMut(Found)) -> (u64, Duration) {
    let stop = Arc::new(AtomicBool::new(false));
    let tries = Arc::new(AtomicU64::new(0));
    let (tx, rx) = mpsc::sync_channel::<Found>(64);
    let t0 = Instant::now();
    let mut found = 0u64;
    thread::scope(|s| {
        for _ in 0..threads {
            let (stop, tries, tx, m) = (stop.clone(), tries.clone(), tx.clone(), matcher.clone());
            s.spawn(move || {
                // CSPRNG per thread, seeded from the OS: seeds are real secrets.
                let mut rng = ChaCha20Rng::from_rng(rand_core::OsRng).expect("os rng");
                let mut seed = Zeroizing::new([0u8; 32]);
                let mut local = 0u64;
                while !stop.load(Ordering::Relaxed) {
                    for _ in 0..1024 {
                        rng.fill_bytes(&mut seed[..]);
                        let pk = SigningKey::from_bytes(&seed).verifying_key().to_bytes();
                        local += 1;
                        if m.matches(&pk) {
                            let s = bs58::encode(pk).into_string();
                            // Fast-path match confirmed by a real encode before storing.
                            if s.ends_with(&m.suffix) && tx.send(Found { pubkey: s, seed: seed.clone() }).is_err() {
                                return;
                            }
                        }
                    }
                    tries.fetch_add(local, Ordering::Relaxed);
                    local = 0;
                }
            });
        }
        drop(tx);
        loop {
            if want > 0 && found >= want {
                break;
            }
            if let Some(d) = deadline {
                if Instant::now() >= d {
                    break;
                }
            }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(f) => {
                    found += 1;
                    on_found(f);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        stop.store(true, Ordering::Relaxed);
        // Drain so no worker blocks on a full channel while stopping.
        while rx.recv_timeout(Duration::from_millis(50)).is_ok() {}
    });
    (tries.load(Ordering::Relaxed), t0.elapsed())
}

struct Pool {
    db: Client,
    key: PoolKey,
    suffix: String,
}

impl Pool {
    fn connect(url: &str, key: PoolKey, suffix: &str) -> Result<Self, String> {
        let mut db = connect_db(url)?;
        // The table comes from the indexer's migrations; wait for them on a fresh DB.
        let t0 = Instant::now();
        loop {
            let ok: bool = db
                .query_one("SELECT to_regclass('public.vanity_mints') IS NOT NULL", &[])
                .map_err(|e| format!("postgres: {e}"))?
                .get(0);
            if ok {
                break;
            }
            if t0.elapsed() > Duration::from_secs(600) {
                return Err("table vanity_mints missing (run the indexer migrations)".into());
            }
            log("waiting for table vanity_mints (indexer migrations)");
            thread::sleep(Duration::from_secs(3));
        }
        Ok(Self { db, key, suffix: suffix.to_string() })
    }

    fn available(&mut self) -> Result<i64, String> {
        self.db
            .query_one(
                "SELECT count(*) FROM vanity_mints WHERE status = 'available' AND suffix = $1 AND key_fp = $2",
                &[&self.suffix, &self.key.fingerprint],
            )
            .map(|r| r.get(0))
            .map_err(|e| format!("postgres: {e}"))
    }

    fn insert(&mut self, f: &Found) -> Result<(), String> {
        let enc = self.key.encrypt(&f.pubkey, &f.seed);
        self.db
            .execute(
                "INSERT INTO vanity_mints (pubkey, suffix, secret_enc, enc_version, key_fp, status)
                 VALUES ($1, $2, $3, $4, $5, 'available') ON CONFLICT (pubkey) DO NOTHING",
                &[&f.pubkey, &self.suffix, &enc, &ENC_VERSION, &self.key.fingerprint],
            )
            .map(|_| ())
            .map_err(|e| format!("postgres insert: {e}"))
    }
}

/// TLS policy actually applied (see the module docs).
#[derive(Debug, PartialEq, Eq)]
enum Tls {
    Disable,
    /// Chain verified against the pinned CA only; hostname not checked.
    VerifyCa,
    /// Chain + hostname verified (pinned CA if any, else the system roots).
    VerifyFull,
}

/// A host on a trusted private network: loopback, or Railway's (WireGuard-encrypted) private network.
fn private_host(host: &str) -> bool {
    let h = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    h == "localhost" || h == "::1" || h.starts_with("127.") || h.ends_with(".railway.internal") || h.starts_with('/')
}

/// S-10: DATABASE_SSL + host + whether a CA is pinned → the policy (never "TLS without verification").
fn tls_policy(mode: &str, host: &str, pinned: bool) -> Result<Tls, String> {
    match mode {
        "disable" => Ok(Tls::Disable),
        "verify-full" => Ok(Tls::VerifyFull),
        "verify-ca" | "require" => {
            if pinned {
                Ok(Tls::VerifyCa)
            } else {
                Err(format!(
                    "DATABASE_SSL={mode} needs the server's CA pinned: DATABASE_SSL_ROOT_CERT (PEM path) or DATABASE_SSL_ROOT_CERT_PEM \
                     (Railway Postgres: /var/lib/postgresql/data/certs/root.crt of the database service)"
                ))
            }
        }
        "auto" | "prefer" => Ok(match (private_host(host), pinned) {
            (true, true) => Tls::VerifyFull,
            (true, false) => Tls::Disable,
            (false, true) => Tls::VerifyCa,
            (false, false) => Tls::VerifyFull,
        }),
        other => Err(format!("DATABASE_SSL must be auto|disable|verify-ca|verify-full (legacy: prefer, require), got {other}")),
    }
}

/// The pinned CA PEM, from DATABASE_SSL_ROOT_CERT_PEM (inline) or DATABASE_SSL_ROOT_CERT (path).
fn pinned_ca() -> Result<Option<Vec<u8>>, String> {
    if let Ok(pem) = env::var("DATABASE_SSL_ROOT_CERT_PEM") {
        if !pem.trim().is_empty() {
            return Ok(Some(pem.replace("\\n", "\n").into_bytes()));
        }
    }
    match env::var("DATABASE_SSL_ROOT_CERT") {
        Ok(path) if !path.trim().is_empty() => std::fs::read(&path).map(Some).map_err(|e| format!("DATABASE_SSL_ROOT_CERT: {e}")),
        _ => Ok(None),
    }
}

/// Postgres connection honouring DATABASE_SSL (see the module docs).
fn connect_db(url: &str) -> Result<Client, String> {
    let mode = env::var("DATABASE_SSL").unwrap_or_else(|_| "auto".into());
    let mut cfg: postgres::Config = url.parse().map_err(|e| format!("DATABASE_URL: {e}"))?;
    let host = match cfg.get_hosts().first() {
        Some(postgres::config::Host::Tcp(h)) => h.clone(),
        #[cfg(unix)]
        Some(postgres::config::Host::Unix(p)) => p.to_string_lossy().into_owned(),
        None => "localhost".into(),
    };
    let ca = pinned_ca()?;
    let policy = tls_policy(mode.as_str(), &host, ca.is_some())?;
    log(&format!("database TLS: {policy:?} (DATABASE_SSL={mode}, pinned CA: {})", ca.is_some()));
    let mut tls = TlsConnector::builder();
    if let Some(pem) = &ca {
        tls.add_root_certificate(Certificate::from_pem(pem).map_err(|e| format!("pinned CA: {e}"))?);
    }
    match policy {
        Tls::Disable => {
            cfg.ssl_mode(SslMode::Disable);
        }
        Tls::VerifyCa => {
            cfg.ssl_mode(SslMode::Require);
            // Only the pinned CA is trusted; the chain is still fully verified. Hostname unchecked: Railway's
            // per-database certificate never names the public proxy host.
            tls.disable_built_in_roots(true).danger_accept_invalid_hostnames(true);
        }
        Tls::VerifyFull => {
            cfg.ssl_mode(SslMode::Require);
        }
    }
    let connector = MakeTlsConnector::new(tls.build().map_err(|e| format!("tls: {e}"))?);
    cfg.connect(connector).map_err(|e| {
        // the TLS cause (e.g. "certificate verify failed") is in the source chain, not the top-level message
        let mut msg = format!("postgres connect: {e}");
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg.push_str(&format!(": {s}"));
            src = s.source();
        }
        msg
    })
}

struct Opts {
    suffix: String,
    threads: usize,
    target: i64,
    once: Option<u64>,
    bench: Option<u64>,
    poll: Duration,
}

fn parse_opts() -> Result<Opts, String> {
    let mut o = Opts {
        suffix: env::var("VANITY_SUFFIX").unwrap_or_else(|_| "fmbL".into()),
        threads: env::var("GRINDER_THREADS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or_else(|| thread::available_parallelism().map(|n| n.get()).unwrap_or(4)),
        target: env::var("POOL_TARGET").ok().and_then(|v| v.parse().ok()).unwrap_or(200),
        once: None,
        bench: None,
        poll: Duration::from_secs(env::var("POOL_POLL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(30)),
    };
    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0;
    let num = |i: usize| -> Result<u64, String> {
        args.get(i + 1).and_then(|v| v.parse().ok()).ok_or_else(|| format!("{} needs a number", args[i]))
    };
    while i < args.len() {
        match args[i].as_str() {
            "--once" => o.once = Some(num(i)?),
            "--bench" => o.bench = Some(num(i)?),
            "--threads" => o.threads = num(i)? as usize,
            "--target" => o.target = num(i)? as i64,
            "--suffix" => o.suffix = args.get(i + 1).cloned().ok_or("--suffix needs a value")?,
            "-h" | "--help" => {
                println!("fumpad-grinder [--once N | --bench SECS] [--suffix fmbL] [--threads N] [--target 200]");
                std::process::exit(0);
            }
            a => return Err(format!("unknown argument {a}")),
        }
        i += 2;
    }
    o.threads = o.threads.max(1);
    Ok(o)
}

fn run() -> Result<(), String> {
    let o = parse_opts()?;
    let matcher = Matcher::new(&o.suffix)?;

    if let Some(secs) = o.bench {
        let mut matches = 0u64;
        let (tries, el) = grind(&matcher, o.threads, 0, Some(Instant::now() + Duration::from_secs(secs)), |_f| matches += 1);
        let rate = tries as f64 / el.as_secs_f64();
        println!(
            "{{\"threads\":{},\"secs\":{:.1},\"tries\":{tries},\"keys_per_sec\":{:.0},\"suffix\":{},\"expected_tries_per_match\":{},\"expected_secs_per_match\":{:.2},\"matches\":{matches}}}",
            o.threads,
            el.as_secs_f64(),
            rate,
            json_str(&o.suffix),
            matcher.expected_tries(),
            matcher.expected_tries() as f64 / rate
        );
        return Ok(());
    }

    let url = env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is required")?;
    let key = PoolKey::parse(&env::var("MINT_POOL_KEY").map_err(|_| "MINT_POOL_KEY is required")?)?;
    let mut pool = Pool::connect(&url, key, &o.suffix)?;
    log(&format!("suffix {} · {} threads · key_fp {} · target {}", o.suffix, o.threads, pool.key.fingerprint, o.target));

    let grind_into = |pool: &mut Pool, n: u64| -> Result<(), String> {
        let mut err: Option<String> = None;
        let mut stored = 0u64;
        let (tries, el) = grind(&matcher, o.threads, n, None, |f| {
            if err.is_some() {
                return;
            }
            match pool.insert(&f) {
                Ok(()) => {
                    stored += 1;
                    log(&format!("stored {} ({stored}/{n})", f.pubkey));
                }
                Err(e) => err = Some(e),
            }
        });
        log(&format!("{n} key(s) in {:.1}s · {:.0} keys/s", el.as_secs_f64(), tries as f64 / el.as_secs_f64().max(1e-9)));
        err.map_or(Ok(()), Err)
    };

    if let Some(n) = o.once {
        return grind_into(&mut pool, n);
    }

    loop {
        let have = match pool.available() {
            Ok(n) => n,
            Err(e) => {
                log(&format!("{e}; reconnecting in 10s"));
                thread::sleep(Duration::from_secs(10));
                let key = PoolKey::parse(&env::var("MINT_POOL_KEY").unwrap_or_default())?;
                pool = Pool::connect(&url, key, &o.suffix)?;
                continue;
            }
        };
        if have >= o.target {
            thread::sleep(o.poll);
            continue;
        }
        // Small batches so the count (and any reservations) are re-read regularly.
        let n = ((o.target - have) as u64).min(o.threads as u64 * 2).max(1);
        log(&format!("pool {have}/{} available, grinding {n}", o.target));
        if let Err(e) = grind_into(&mut pool, n) {
            log(&format!("{e}; retrying in 10s"));
            thread::sleep(Duration::from_secs(10));
            let key = PoolKey::parse(&env::var("MINT_POOL_KEY").unwrap_or_default())?;
            pool = Pool::connect(&url, key, &o.suffix)?;
        }
    }
}

fn main() {
    if let Err(e) = run() {
        log(&format!("fatal: {e}"));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tls_tests {
    use super::{private_host, tls_policy, Tls};

    #[test]
    fn never_unverified_tls() {
        // public host (e.g. Railway's TCP proxy): pinned CA → verify-ca, else verify-full on the system roots
        assert_eq!(tls_policy("auto", "x.proxy.rlwy.net", true), Ok(Tls::VerifyCa));
        assert_eq!(tls_policy("auto", "x.proxy.rlwy.net", false), Ok(Tls::VerifyFull));
        // private network: plaintext (WireGuard) unless a CA is pinned
        assert_eq!(tls_policy("auto", "postgres.railway.internal", false), Ok(Tls::Disable));
        assert_eq!(tls_policy("auto", "postgres.railway.internal", true), Ok(Tls::VerifyFull));
        assert_eq!(tls_policy("prefer", "127.0.0.1", false), Ok(Tls::Disable));
        // legacy require = verify-ca and needs a pinned CA
        assert!(tls_policy("require", "x.proxy.rlwy.net", false).is_err());
        assert_eq!(tls_policy("require", "x.proxy.rlwy.net", true), Ok(Tls::VerifyCa));
        assert!(tls_policy("verify-ca", "h", false).is_err());
        assert_eq!(tls_policy("verify-full", "h", false), Ok(Tls::VerifyFull));
        assert_eq!(tls_policy("disable", "h", false), Ok(Tls::Disable));
        assert!(tls_policy("allow", "h", false).is_err());
    }

    #[test]
    fn private_hosts() {
        for h in ["localhost", "127.0.0.1", "::1", "[::1]", "postgres.railway.internal", "/tmp/pg"] {
            assert!(private_host(h), "{h}");
        }
        for h in ["roundhouse.proxy.rlwy.net", "db.example.com", "10.0.0.1"] {
            assert!(!private_host(h), "{h}");
        }
    }
}
