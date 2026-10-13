//! Every `FumpadError` the program can return is asserted by at least one test (audit TEST-COVERAGE §1). This test
//! reads `programs/fumpad/src/error.rs` and the test sources, so a new error code without a test fails the suite.

/// Codes kept only for numbering stability: the program never returns them (checked below against its source).
/// * `WouldCompleteCurve`: buybacks cap their slice below the migration threshold instead
///   (`oracle_buyback_tests::pre_graduation_buyback_keeper_only_guarded_and_never_completes`).
/// * `AttestRateLimited`: the rate cap defers tickets instead of rejecting them (REVIEW-v0.7 M-1;
///   `attest_tests::rate_cap_defers_tokens_beyond_the_hourly_cap`).
const RESERVED: [&str; 2] = ["WouldCompleteCurve", "AttestRateLimited"];

fn read(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// Variant names of `FumpadError`, in declaration order (= error code − 6000).
fn variants() -> Vec<String> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let src = read(&root.join("../programs/fumpad/src/error.rs"));
    let body = &src[src.find("pub enum FumpadError").expect("enum")..];
    body.lines()
        .map(str::trim)
        .filter(|l| !l.starts_with("#[") && !l.starts_with("//") && !l.starts_with("pub enum") && l.ends_with(','))
        .map(|l| l.trim_end_matches(',').to_string())
        .collect()
}

/// All Rust sources under `dir` (recursive), concatenated, without comment lines.
fn sources(dir: &std::path::Path, skip: &str) -> String {
    let mut out = String::new();
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out += &sources(&p, skip);
        } else if p.extension().is_some_and(|x| x == "rs") && !p.ends_with(skip) {
            for l in read(&p).lines().filter(|l| !l.trim_start().starts_with("//")) {
                out.push_str(l);
                out.push('\n');
            }
        }
    }
    out
}

/// `needle` occurs in `hay` not followed by an identifier character.
fn contains_word(hay: &str, needle: &str) -> bool {
    hay.match_indices(needle).any(|(i, _)| {
        hay[i + needle.len()..].chars().next().is_none_or(|c| !(c.is_alphanumeric() || c == '_'))
    })
}

#[test]
fn every_error_code_is_asserted_by_a_test() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let names = variants();
    assert_eq!(names.first().map(String::as_str), Some("Unauthorized"));
    // Codes are 6000 + declaration index: spot-check the parse against the compiled enum.
    use fumpad::error::FumpadError as E;
    for (name, e) in [("PoolDisabled", E::PoolDisabled), ("TicketPriceBelowExecution", E::TicketPriceBelowExecution), ("PoolIsRegistered", E::PoolIsRegistered)] {
        let i = names.iter().position(|n| n == name).expect(name);
        assert_eq!(6000 + i as u32, crate::fumpad_err(e), "{name}");
    }
    let tests = sources(&root.join("src"), "error_coverage.rs");
    let program = sources(&root.join("../programs/fumpad/src"), "error.rs");
    let mut missing = vec![];
    for n in &names {
        let needle = format!("FumpadError::{n}");
        let returned = contains_word(&program, &needle);
        if RESERVED.contains(&n.as_str()) {
            assert!(!returned, "{n} is reserved but the program returns it");
            continue;
        }
        assert!(returned, "{n} is never returned by the program: mark it reserved");
        if !contains_word(&tests, &needle) {
            missing.push(n.clone());
        }
    }
    assert!(missing.is_empty(), "error codes no test asserts: {missing:?}");
}
