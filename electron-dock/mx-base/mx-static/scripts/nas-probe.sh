#!/usr/bin/env bash
# Explicit small write test, separate from the read-only nas-audit interface.
set -euo pipefail
usage() {
  cat <<'HELP'
Usage: sudo bash scripts/nas-probe.sh permissions --write-test
Creates ONE new .mx-static-probe-<random> directory under the existing NAS host
directory. Tests a 4 KiB file: write/fsync/read/rename, mode, mtime and chown 0:0.
Removes only its own test file and empty directory. Never accesses media volumes,
creates migration targets, mounts, changes old permissions or restarts services.
Requires Linux, Python 3.6+, findmnt and root (the observed application identity).
Hard-NFS I/O can wait indefinitely: do not run concurrent probes or remount NAS.
This is NOT a copy/cutover readiness certificate. See nas_docs/README.md.
HELP
}
case "${1:-help}" in -h|--help|help) usage; exit 0 ;; esac
[[ $# == 2 && "$1" == permissions && "$2" == --write-test ]] || { usage >&2; exit 2; }
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Run as root on the Linux host.' >&2; exit 2; }
command -v python3 >/dev/null || { echo 'Python 3.6+ is required.' >&2; exit 2; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 2)'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -B "$script_dir/nas/permissions.py" --write-test
