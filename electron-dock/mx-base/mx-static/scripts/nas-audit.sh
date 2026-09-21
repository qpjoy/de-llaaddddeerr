#!/usr/bin/env bash
# Read-only diagnostics for the documented mx-internal-server migration.
set -euo pipefail

usage() {
  cat <<'HELP'
Usage: bash scripts/nas-audit.sh <layout|deployment|media>
  layout      Inspect /data and a few fixed NAS paths; no recursive NAS scan.
              Refuse NAS inspection unless /mnt/nas is the expected NFS export.
  deployment  Docker consumers, versions, source hashes, UID/GID and K8s paths.
              Does not print full environment variables or Secret contents.
  media       Low-priority metadata scan of the two known local media volumes.
              Report temp files and largest files; no file-content reads.

Run on the Linux Docker host. Requires Python 3.6+; deployment/media need Docker.
No mode mounts, copies, deletes, changes permissions or restarts services.
layout reads NFS metadata: hard-NFS I/O can still block when the NAS is offline.
See nas_docs/README.md. Reports belong in the git-ignored reports/ directory.
HELP
}

case "${1:-help}" in
  -h|--help|help) usage; exit 0 ;;
  layout|deployment|media) mode=$1 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# == 1 ]] || { usage >&2; exit 2; }
[[ "$(uname -s)" == Linux ]] || { echo 'Run on the Linux Docker host.' >&2; exit 2; }
command -v python3 >/dev/null || { echo 'Python 3.6+ is required.' >&2; exit 2; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 6) else 2)'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ "$mode" == media ]]; then
  if command -v ionice >/dev/null 2>&1; then
    exec ionice -c 3 nice -n 19 python3 "$script_dir/nas/media.py"
  fi
  exec nice -n 19 python3 "$script_dir/nas/media.py"
fi
exec python3 "$script_dir/nas/$mode.py"
