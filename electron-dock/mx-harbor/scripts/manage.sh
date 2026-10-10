#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "ops" && "${2:-}" == "internal-production" ]]; then shift 2; fi
exec node scripts/operations.mjs "${@:-help}"
