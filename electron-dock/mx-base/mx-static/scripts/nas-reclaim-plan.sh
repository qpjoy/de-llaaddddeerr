#!/usr/bin/env bash
set -euo pipefail
case "${1:-help}" in help|-h|--help)
  cat <<'HELP'
Usage: sudo bash scripts/nas-reclaim-plan.sh <successful-Part-1-report-directory>
Read-only media inventory after successful po_infra NAS cutover.
Checks live mounts/health and sealed identities, writes a private SSD metadata
manifest below the existing report directory, and reports allocated space.
No deletion, service stop/recreation, rsync, NAS media scan, content hashing,
marker change or business-acceptance approval. Extra write flags are refused.
HELP
  exit 0 ;;
esac
[[ $# == 1 && "$1" != -* ]] || { echo 'Use --help; no deletion options exist.' >&2; exit 2; }
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Run as root on the Linux Docker host.' >&2; exit 2; }
for cmd in python3 docker findmnt du; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }; done
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -B "$script_dir/nas/reclaim_plan.py" "$@"
