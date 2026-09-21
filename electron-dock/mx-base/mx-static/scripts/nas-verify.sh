#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: sudo bash scripts/nas-verify.sh <po_infra_media_data|delta_59202_media_data> --verify
Read ALL source and NAS media bytes for SHA256, including tmp files.
Requires a completed pre-copy and unchanged deployment/target identity.
Never copies, deletes, mounts, changes media permissions or stops containers.
Writes a new private local report under /var/lib/mx-static/nas-verification/.
Online changes/missing/extra files are reported, never silently skipped/repaired.
Exit 0: observed match; 2: differences or live changes; 1: operation failed.
Even exit 0 is NOT a frozen snapshot, cutover approval or SSD deletion readiness.
No deadline or bandwidth cap. Shares the copy lock; hard NFS may block.
HELP
}
case "${1:-help}" in help|-h|--help) usage; exit 0 ;; esac
[[ $# == 2 && "$2" == --verify ]] || { usage >&2; exit 2; }
case "$1" in po_infra_media_data|delta_59202_media_data) ;; *) usage >&2; exit 2 ;; esac
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Run as root on the Linux Docker host.' >&2; exit 2; }
for cmd in python3 docker findmnt; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }; done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 2)'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v ionice >/dev/null 2>&1; then
  exec ionice -c 3 nice -n 19 python3 -B "$script_dir/nas/verify.py" "$@"
fi
exec nice -n 19 python3 -B "$script_dir/nas/verify.py" "$@"
