#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ "${1:-}" == "k8s" ]]; then
  shift
  exec python3 -B "$SCRIPT_DIR/../k8s/inventory.py" "$@"
fi
exec python3 "$SCRIPT_DIR/../etcd/move.py" "$@"
