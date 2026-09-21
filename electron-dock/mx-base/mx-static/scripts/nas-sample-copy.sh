#!/usr/bin/env bash
# Bounded copy experiment. Not a full migration or cutover command.
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: sudo bash scripts/nas-sample-copy.sh <po_infra_media_data|delta_59202_media_data> --copy-test
Select up to 8 old regular files (formal media and tmp), at most 256 MiB total
at selection time. Copy to ONE new private NAS test directory at 10 MiB/s.
Verify SHA256, uid/gid, mode, size and whole-second mtime; retain test copies.
Never delete source/destination files, create final migration targets, change
mounts or restart services. Requires Linux, root, Python 3.6+, Docker and rsync.
Hard NFS may wait. One shared lock prevents concurrent sample-copy runs.
HELP
}
case "${1:-help}" in -h|--help|help) usage; exit 0 ;; esac
[[ $# == 2 && "$2" == --copy-test ]] || { usage >&2; exit 2; }
case "$1" in po_infra_media_data|delta_59202_media_data) ;; *) usage >&2; exit 2 ;; esac
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Run as root on the Linux Docker host.' >&2; exit 2; }
for cmd in python3 docker findmnt rsync; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }; done
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 2)'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if command -v ionice >/dev/null 2>&1; then
  exec ionice -c 3 nice -n 19 python3 -B "$script_dir/nas/sample_copy.py" "$@"
fi
exec nice -n 19 python3 -B "$script_dir/nas/sample_copy.py" "$@"
