#!/usr/bin/env bash
set -euo pipefail
case "${1:-help}" in help|-h|--help)
  cat <<'HELP'
Usage: sudo bash scripts/nas-cutover-prepare.sh po_infra_media_data --prepare
Prepare Part 1 only. No full-media SHA256 pass and no production stop/recreation.
Checks existing copy/deployment; creates or validates the exact new Docker NFS
volume; runs one isolated probe with the existing image, no network/image pull.
The probe writes/reads/removes only its own new 4 KiB file in the NAS target.
Saves private configuration and candidate overrides under /var/lib/mx-static/.
Never deletes original media or changes the pre-copy marker. Stop the full
verification first; its existing lock must be released, never deleted.
HELP
  exit 0 ;;
esac
[[ $# == 2 && "$1" == po_infra_media_data && "$2" == --prepare ]] || { echo 'Use --help for the registered Part 1 operation.' >&2; exit 2; }
[[ "$(uname -s)" == Linux && "$EUID" == 0 ]] || { echo 'Run as root on the Linux Docker host.' >&2; exit 2; }
for cmd in python3 docker findmnt; do command -v "$cmd" >/dev/null || { echo "Missing $cmd" >&2; exit 2; }; done
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -B "$script_dir/nas/cutover_prepare.py" "$@"
