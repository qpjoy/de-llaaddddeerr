#!/usr/bin/env bash
# Run on the production kubectl host; source is streamed into the existing Pod.
set -euo pipefail
if (( $# > 1 )) || [[ ${1:---inspect} != --inspect && ${1:---inspect} != --execute ]]; then
  echo 'Usage: bash probe-instagram-account-54156c46.sh [--inspect|--execute]' >&2
  exit 2
fi
mode=${1:---inspect}
ops_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
probe_file="$ops_dir/probe-instagram-account-54156c46.mjs"
if [[ ! -f "$probe_file" ]]; then
  echo 'Sync the companion .mjs file first; no request was sent.' >&2
  exit 2
fi

if [[ "$mode" == --execute ]]; then
  # This host-side claim survives Pod replacement. An interrupted run remains
  # claimed even when there is no visible Hub receipt yet. Never remove it to retry.
  state_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/mx-insight-hub/instagram-account-54156c46"
  umask 077
  mkdir -p -- "$state_dir"
  if ! mkdir -- "$state_dir/execute-claimed" 2>/dev/null; then
    echo 'This incident batch was already claimed. Use --inspect; do not delete the marker or change hosts to retry.' >&2
    exit 2
  fi
  sync -f "$state_dir/execute-claimed"
  sync -f "$state_dir"
fi

exec kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  sh -c 'cd /app && export MX_IG_PROBE_RUN_DIR=/tmp/mx-ig-account-54156c46 && exec node --input-type=module - "$1"' sh "$mode" < "$probe_file"
