#!/usr/bin/env bash
set -euo pipefail
case "${1:-help}" in help|-h|--help)
  cat <<'HELP'
Usage: sudo bash scripts/nas-reclaim.sh --business-accepted <successful-reclaim-plan-directory>
Deletes only unchanged manifested SSD files in Part 1 po_infra data_hub_raw_media.
Run only after old media, new upload/collection and task results pass business acceptance.
Retains the source root/all directories, named volume and other media. No NAS deletion,
copy, full content hashing, service restart, image pull/build or database/queue change.
Checks current NAS files/consumer mounts/health and journals batches before unlinking.
Rerun the SAME command after an interrupted run; unexpected changes stop the operation.
Keep deployments and external host/K8s writers to the retained SSD path frozen.
HELP
  exit 0 ;;
esac
[[ $# == 2 && "$1" == --business-accepted ]] || { echo 'Use --help; explicit business acceptance and exact plan path required.' >&2; exit 2; }
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Run as root on the Linux Docker host.' >&2; exit 2; }
for cmd in python3 docker findmnt; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }; done
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -B "$script_dir/nas/reclaim.py" "$@"
