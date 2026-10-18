#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ "${1:-}" == "ops" && "${2:-}" == "internal-production" ]]; then shift 2; fi
if [[ "${1:-}" == "enroll" ]]; then shift; exec node scripts/enroll.mjs "$@"; fi
if [[ "${1:-}" == "recover-lock" ]]; then shift; exec node scripts/recover-lock.mjs "$@"; fi
exec node scripts/operations.mjs "${@:-help}"
