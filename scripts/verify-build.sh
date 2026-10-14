#!/usr/bin/env bash
# FUMPAD verifiable build: `solana-verify build` of contracts/ in the pinned docker image, then print the hash.
# Runbook: services/LAUNCH-DAY.md §10. Build profile: contracts/CONTRACTS.md "Verifiable build".
#
# Usage: scripts/verify-build.sh [--mainnet] [--image <tag>] [--program-id <id> -u <rpc>]
#   (default)            devnet id build (declare_id! = contracts/program-ids/devnet.txt)
#   --mainnet            `-- --features mainnet`: compiles in contracts/program-ids/mainnet.txt (fails while UNSET)
#   --image <tag>        override the pinned image (default below; must ship platform-tools v1.57)
#   --program-id <id>    also print `solana-verify get-program-hash` of that deployed program (read-only) and
#   -u <rpc>             compare it with the build (exit 3 on mismatch). -u defaults to the Solana CLI config.
# Output: contracts/target/deploy/fumpad.so (overwrites any local `anchor build` output), its size, sha256 and
# executable hash (= what get-program-hash prints once deployed). Exit 0 = built (and matched, if compared).
#
# Needs: docker (running), solana-verify >= 0.5.2. On Apple Silicon the amd64 image runs under emulation
# (DOCKER_DEFAULT_PLATFORM=linux/amd64 is set here): ~17 min cold on an M1, ~1.5 min with deps cached in
# contracts/target; a few minutes on x86_64 Linux. qemu can hang (log stuck at `Compiling fumpad`, container at 0% CPU
# for > 5 min): stop and rerun, or enable Rosetta in colima (LAUNCH-DAY.md §10 "Rehearsal").
# Network: the container downloads crates (and nothing else: platform-tools v1.57 is baked into the image).
set -euo pipefail

IMAGE="solanafoundation/solana-verifiable-build:4.3.0"   # Agave 4.3.0: cargo-build-sbf defaults to platform-tools v1.57
MAINNET=0; PROGRAM_ID=""; RPC=""
while [ $# -gt 0 ]; do
  case "$1" in
    --mainnet) MAINNET=1 ;;
    --image) shift; IMAGE="${1:?--image needs a tag}" ;;
    --program-id) shift; PROGRAM_ID="${1:?--program-id needs a pubkey}" ;;
    -u|--url) shift; RPC="${1:?-u needs an RPC url}" ;;
    -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

for d in "$HOME/.cargo/bin" "$HOME/.local/share/solana/install/active_release/bin"; do
  [ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$d:$PATH" ;; esac
done
export PATH DOCKER_DEFAULT_PLATFORM=linux/amd64

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/contracts"
SO="$CONTRACTS/target/deploy/fumpad.so"
command -v solana-verify >/dev/null || { echo "solana-verify not found (cargo install solana-verify)" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "docker is not running (colima start / Docker Desktop)" >&2; exit 1; }

# solana-verify searches the whole mount (contracts/, target/ included) for the crate to build and takes the first
# match: a stray copy of the program (e.g. an old build tree under contracts/target/) would silently be built instead.
STRAY="$(cd "$CONTRACTS" && grep -rl --include=Cargo.toml '^name = "fumpad"' . | grep -vE '^(\./)?programs/fumpad/Cargo.toml$' || true)"
[ -z "$STRAY" ] || { echo "other fumpad crates inside contracts/ (solana-verify could build one of them instead):" >&2; echo "$STRAY" >&2; exit 1; }

sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1" | cut -d' ' -f1; else sha256sum "$1" | cut -d' ' -f1; fi; }
first_id() { grep -v '^[[:space:]]*#' "$1" | grep -v '^[[:space:]]*$' | head -1 | tr -d '[:space:]'; }

if [ "$MAINNET" = 1 ]; then
  ID="$(first_id "$CONTRACTS/program-ids/mainnet.txt")"
  [ "$ID" != "UNSET" ] || { echo "contracts/program-ids/mainnet.txt is UNSET: commit the mainnet program pubkey first (LAUNCH-DAY.md §10)" >&2; exit 1; }
  CARGO_ARGS=(-- --features mainnet)
else
  ID="$(first_id "$CONTRACTS/program-ids/devnet.txt")"
  CARGO_ARGS=()
fi

echo "commit:   $(git -C "$ROOT" rev-parse HEAD)$(git -C "$ROOT" diff --quiet HEAD -- contracts 2>/dev/null || echo ' (contracts/ modified: not a release build)')"
echo "image:    $IMAGE"
echo "build:    $([ "$MAINNET" = 1 ] && echo 'mainnet (--features mainnet)' || echo devnet) — program id $ID"
T0=$SECONDS
(cd "$CONTRACTS" && solana-verify build --library-name fumpad --base-image "$IMAGE" --arch v3 ${CARGO_ARGS[@]+"${CARGO_ARGS[@]}"})
[ -f "$SO" ] || { echo "build produced no $SO" >&2; exit 1; }
HASH="$(solana-verify get-executable-hash "$SO")"
echo
echo "built in: $((SECONDS - T0)) s"
echo "so:       $SO ($(wc -c < "$SO" | tr -d ' ') bytes, sha256 $(sha256 "$SO"))"
echo "HASH:     $HASH"

if [ -n "$PROGRAM_ID" ]; then
  ONCHAIN="$(solana-verify get-program-hash ${RPC:+-u "$RPC"} "$PROGRAM_ID")"
  echo "on-chain: $ONCHAIN ($PROGRAM_ID)"
  [ "$ONCHAIN" = "$HASH" ] && echo "MATCH" || { echo "MISMATCH: the deployed program is not this build" >&2; exit 3; }
fi
