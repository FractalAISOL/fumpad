#!/usr/bin/env bash
# FUMPAD audit: build the program and run every test suite an auditor needs (audit/README.md §5).
#
# Prerequisites (versions the suite was run with; README §4):
#   - Rust via rustup (the toolchain in contracts/rust-toolchain.toml, 1.99.0, is installed on first use)
#   - Anchor CLI 1.2.1 (avm), Solana / Agave CLI 4.1.x (cargo-build-sbf, solana-test-validator)
#   - Node.js >= 22 and npm
#   - PostgreSQL binaries initdb + pg_ctl on PATH, or DATABASE_URL pointing at an empty database
#     (only for the services integration step)
#   - shasum (or sha256sum)
# Nothing here needs a key, a funded account, network access to a cluster, or Docker. npm / cargo download
# dependencies on the first run.
#
# Usage: audit/build-and-test.sh [--skip-integration] [--skip-app] [--skip-pocs] [--keypair <path>]
#   --keypair <path>     copy this program keypair to contracts/target/deploy/fumpad-keypair.json before the
#                        build (git-ignored, never printed). Not needed: without it `anchor build` makes a
#                        throwaway one and the compiled bytes are the same.
#   --skip-integration   skip `npm run test:integration` (validator + Postgres + local e2e, ~4 min)
#   --skip-app           skip the app tests
#   --skip-pocs          skip the security-review PoCs
# Exit status: 0 if every step passed, 1 otherwise. Logs: a temp directory printed at the start.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SKIP_INTEGRATION=0; SKIP_APP=0; SKIP_POCS=0; KEYPAIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-integration) SKIP_INTEGRATION=1 ;;
    --skip-app) SKIP_APP=1 ;;
    --skip-pocs) SKIP_POCS=1 ;;
    --keypair) shift; KEYPAIR="${1:-}"; [ -n "$KEYPAIR" ] || { echo "--keypair needs a path" >&2; exit 2; } ;;
    -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# Usual install locations (avm, rustup, Agave installer) in case the shell profile didn't add them.
for d in "$HOME/.avm/bin" "$HOME/.cargo/bin" "$HOME/.local/share/solana/install/active_release/bin"; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH

TMP_BASE="${TMPDIR:-/tmp}"; LOGS="$(mktemp -d "${TMP_BASE%/}/fumpad-audit.XXXXXX")"
RESULTS=()
FAILED=0
echo "FUMPAD audit build + tests — repo $ROOT"
echo "logs: $LOGS"
echo "commit: $(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo unknown)$(git -C "$ROOT" diff --quiet 2>/dev/null || echo ' (working tree modified)')"
echo

sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }

# step <name> <dir> <command...>: run, log, record pass/fail, keep going.
step() {
  local name="$1" dir="$2"; shift 2
  local log="$LOGS/$(echo "$name" | tr ' /:' '___').log"
  local t0=$SECONDS
  printf '%-48s ' "$name"
  if (cd "$dir" && "$@") >"$log" 2>&1; then
    printf 'PASS  (%ss)\n' "$((SECONDS - t0))"; RESULTS+=("PASS  $name")
  else
    printf 'FAIL  (%ss) — see %s\n' "$((SECONDS - t0))" "$log"; RESULTS+=("FAIL  $name  ($log)"); FAILED=1
    tail -n 25 "$log" | sed 's/^/    | /'
  fi
}

# ── 0. prerequisites ────────────────────────────────────────────────────────────────────────────────────────
missing=()
for t in cargo rustup anchor solana cargo-build-sbf node npm; do command -v "$t" >/dev/null || missing+=("$t"); done
if [ "$SKIP_INTEGRATION" = 0 ]; then
  command -v solana-test-validator >/dev/null || missing+=("solana-test-validator")
  if [ -z "${DATABASE_URL:-}" ]; then
    for t in initdb pg_ctl; do command -v "$t" >/dev/null || missing+=("$t (or set DATABASE_URL)"); done
  fi
fi
command -v shasum >/dev/null || command -v sha256sum >/dev/null || missing+=("shasum/sha256sum")
if [ ${#missing[@]} -gt 0 ]; then
  echo "missing prerequisites: ${missing[*]}" >&2
  echo "see the header of this script and audit/README.md §4" >&2
  exit 2
fi
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || { echo "Node.js >= 22 required (found $(node --version))" >&2; exit 2; }
{
  echo "rustc (contracts toolchain): $(cd "$ROOT/contracts" && rustc --version)"
  echo "anchor: $(anchor --version)"
  echo "solana: $(solana --version)"
  echo "cargo-build-sbf: $(cargo-build-sbf --version | head -1)"
  echo "node: $(node --version)  npm: $(npm --version)"
  [ "$SKIP_INTEGRATION" = 0 ] && echo "solana-test-validator: $(solana-test-validator --version)"
  [ "$SKIP_INTEGRATION" = 0 ] && [ -z "${DATABASE_URL:-}" ] && echo "postgres: $(initdb --version)"
} | tee "$LOGS/toolchain.txt"
echo

# ── 1. mainnet fixtures (committed; README §5.1) ────────────────────────────────────────────────────────────
check_fixtures() {
  local dir="$ROOT/contracts/tests/fixtures" bad=0 f want got
  while read -r want f; do
    got="$(sha256 "$dir/$f" 2>/dev/null || echo missing)"
    if [ "$got" = "$want" ]; then echo "ok  $f"; else echo "BAD $f: $got (want $want)"; bad=1; fi
  done <<'EOF'
e2bfc853c1a1778dd8ee40ea9a0f3edf5587442360c57c685e7e3024ad0cad47 dbc_mainnet.so
967ff9fb161eec2e62f66d2c899100739fb747c445f697b8625c86b31b9a2022 damm_v2_mainnet.so
fc5c08462fc2d118b09353121112725a33aa684e0f255719575e09efbc1f4c2f damm_v2_migration_config_mainnet.json
dec8d3e0fae58c7c8f2416e5f67c25e673f047afd6dd2bba4a47e0b29a01d34c squads_v4_mainnet.so
6dcbc4560e65bfc97dceb3bb75f801437568d3c417d9f716a332c654c8b9b81d squads_v4_program_config_mainnet.json
7c2ac8b0af827dd08fbcc1de88e1b619dd305d56355412a26729d4c787bc7e88 pyth_sol_usd_mainnet.json
11c50ae66cc2efb3b4965bab79ea6b1295f9cd9716c81861302156e015e6e7da wsol_mint.json
EOF
  return $bad
}
step "1 fixtures sha256" "$ROOT" check_fixtures

# ── 2. program build ────────────────────────────────────────────────────────────────────────────────────────
KP="$ROOT/contracts/target/deploy/fumpad-keypair.json"
if [ -n "$KEYPAIR" ] && [ ! -f "$KP" ]; then
  mkdir -p "$(dirname "$KP")" && cp "$KEYPAIR" "$KP" && chmod 600 "$KP"
fi
step "2 anchor build -p fumpad" "$ROOT/contracts" anchor build -p fumpad
SO="$ROOT/contracts/target/deploy/fumpad.so"
DEVNET_SHA="0d28b661cfc3fc45c7a07988d67685fee6a6a1f69d4df1f93c06f95a5615e598"
if [ -f "$SO" ]; then
  so_sha="$(sha256 "$SO")"
  echo "    fumpad.so: $(wc -c <"$SO" | tr -d ' ') bytes, sha256 $so_sha"
  if [ "$so_sha" = "$DEVNET_SHA" ]; then
    echo "    = the code deployed on devnet at 5YMF…S9Fb (first 754,288 bytes of its program data; README §6)"
  else
    echo "    differs from the devnet deployment ($DEVNET_SHA): expected if the source or toolchain differs (README §6)"
  fi
fi

# ── 3–4. program tests ──────────────────────────────────────────────────────────────────────────────────────
step "3 cargo test -p fumpad --lib (unit)" "$ROOT/contracts" cargo test -p fumpad --lib
step "4 cargo test -p tests (LiteSVM, mainnet binaries)" "$ROOT/contracts" cargo test -p tests
grep -h "test result" "$LOGS"/3_*.log "$LOGS"/4_*.log 2>/dev/null | grep -v " 0 passed; 0 failed; 0 ignored" | sed 's/^/    /'

# ── 5–6. services ───────────────────────────────────────────────────────────────────────────────────────────
step "5a services npm ci" "$ROOT/services" npm ci --no-audit --no-fund
step "5b services typecheck" "$ROOT/services" npm run typecheck
step "5c services unit tests (vitest)" "$ROOT/services" npm test
grep -hE "^ +(Test Files|Tests) " "$LOGS"/5c_*.log 2>/dev/null | sed 's/^ */    /'
if [ "$SKIP_INTEGRATION" = 0 ]; then
  # Pin the validator's gossip + dynamic ports (8001, 8002-8041) so it can't collide with another validator on the
  # machine; RPC 8899, API and Postgres ports keep their defaults. Override any of them (README §5 step 6):
  # FUMPAD_RPC_PORT, FUMPAD_API_PORT, FUMPAD_GOSSIP_PORT, FUMPAD_PG_PORT.
  export FUMPAD_GOSSIP_PORT="${FUMPAD_GOSSIP_PORT:-8001}"
  step "6 services integration + local e2e" "$ROOT/services" npm run test:integration
  grep -hE "^ +(Test Files|Tests) " "$LOGS"/6_*.log 2>/dev/null | sed 's/^ */    /'
fi

# ── 7. app ──────────────────────────────────────────────────────────────────────────────────────────────────
if [ "$SKIP_APP" = 0 ]; then
  step "7a app npm ci" "$ROOT/app" npm ci --no-audit --no-fund
  step "7b app tests (allow-list, signer, launch)" "$ROOT/app" npm test
  grep -hE "^# (tests|pass|fail) " "$LOGS"/7b_*.log 2>/dev/null | sed 's/^/    /'
fi

# ── 8. security-review v0.7 PoCs (flipped: each asserts its fix) ────────────────────────────────────────────
if [ "$SKIP_POCS" = 0 ]; then
  LINK="$ROOT/security-review/node_modules"   # git-ignored; the PoCs resolve services' dependencies through it
  [ -e "$LINK" ] || ln -s ../services/node_modules "$LINK"
  for f in "$ROOT"/security-review/v07-poc/*.test.ts; do
    n="$(basename "$f" .test.ts)"
    case "$n" in
      app-*) [ "$SKIP_APP" = 0 ] && step "8 poc $n" "$ROOT/app" node --import tsx --test "../security-review/v07-poc/$n.test.ts" ;;
      *) step "8 poc $n" "$ROOT/services" node --import tsx --test "../security-review/v07-poc/$n.test.ts" ;;
    esac
  done
fi

# ── summary ─────────────────────────────────────────────────────────────────────────────────────────────────
echo
echo "── summary ──"
printf '%s\n' "${RESULTS[@]}"
echo "logs: $LOGS"
if [ "$FAILED" = 0 ]; then echo "ALL STEPS PASSED"; else echo "SOME STEPS FAILED"; fi
exit "$FAILED"
