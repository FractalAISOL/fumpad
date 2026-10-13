#!/usr/bin/env bash
# Wrapper: runs the solana CLI against the DEVNET RPC from ~/fumpad-keys/devnet/rpc.env
# without ever echoing the URL / API key (output is redacted).
set -euo pipefail
export PATH="$HOME/.avm/bin:$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
# shellcheck disable=SC1090
source "$HOME/fumpad-keys/devnet/rpc.env"
case "$RPC_URL" in
  *devnet*) ;;
  *) echo "refusing: RPC_URL is not a devnet URL" >&2; exit 1 ;;
esac
solana -u "$RPC_URL" -k "$HOME/.config/solana/id.json" "$@" 2>&1 | sed -E 's/api-key=[A-Za-z0-9-]+/api-key=REDACTED/g'
