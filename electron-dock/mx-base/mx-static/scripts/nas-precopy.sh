#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: sudo bash scripts/nas-precopy.sh <po_infra_media_data|delta_59202_media_data> --copy|--status
--copy creates/resumes this volume's guarded NAS target and copies ALL raw media,
including tmp, at up to 60 MiB/s. This is a FULL ONLINE PRE-COPY, not a small test.
--status reads an existing job; it refuses while another copy/test holds the lock.
Never stops containers, cuts over storage, deletes originals or reclaims space.
No built-in deadline: the documented run uses RuntimeMaxSec=infinity.
Copy errors still fail the job; hard NFS may block.
An exit-0 pre-copy is NOT a consistent final backup or permission to delete SSD data.
HELP
}
case "${1:-help}" in -h|--help|help) usage; exit 0 ;; esac
[[ $# == 2 ]] || { usage >&2; exit 2; }
case "$1" in po_infra_media_data|delta_59202_media_data) ;; *) usage >&2; exit 2 ;; esac
case "$2" in --copy|--status) ;; *) usage >&2; exit 2 ;; esac
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Run as root on the Linux Docker host.' >&2; exit 2; }
for cmd in python3 docker findmnt rsync; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }; done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 2)'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v ionice >/dev/null 2>&1; then
  exec ionice -c 3 nice -n 19 python3 -B "$script_dir/nas/precopy.py" "$@"
fi
exec nice -n 19 python3 -B "$script_dir/nas/precopy.py" "$@"
