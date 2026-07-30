#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <target-version> [universal|arm64|x64]" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SCRIPT_DIR}/.."

pnpm --dir "${PROJECT_DIR}" run build
node "${PROJECT_DIR}/scripts/build-asar-update.mjs" --version "$1" --platform darwin --arch "${2:-universal}"
