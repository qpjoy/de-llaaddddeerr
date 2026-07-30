#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <target-version> [universal|arm64|x64]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pnpm --dir "${SCRIPT_DIR}/.." run make:asar -- --version "$1" --platform darwin --arch "${2:-universal}"
