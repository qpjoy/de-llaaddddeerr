#!/usr/bin/env bash
set -euo pipefail
case "${1:-help}" in help|-h|--help)
  cat <<'HELP'
Usage: sudo bash scripts/nas-cutover.sh --cutover <successful-Part-1-report-directory>
Recovery: --restore-ssd (only before possible NAS writes), --resume-nas (never recopies SSD)
Part 1 po_infra_media_data only. Stops ten mx_data media services gracefully,
performs incremental sync and per-path quick-check, retains NAS extras outside
live media, recreates only these services with existing images, then checks
health and one existing-media HTTP Range read. No full SHA256 scan, SSD deletion,
volume deletion, database/Redis restart, task purge, pull or build.
Run in the agreed maintenance window via systemd-run to survive SSH disconnects.
Keep deployment and any external host/K8s/NAS writers to these paths frozen.
HELP
  exit 0 ;;
esac
[[ $# == 2 && ( "$1" == --cutover || "$1" == --restore-ssd || "$1" == --resume-nas ) ]] || { echo 'Use --help.' >&2; exit 2; }
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Run as root on the Linux Docker host.' >&2; exit 2; }
for cmd in python3 docker rsync findmnt; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }; done
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -B "$script_dir/nas/cutover.py" "$@"
