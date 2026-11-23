#!/usr/bin/env bash
# Run on the production kubectl host; source is streamed into the existing Pod.
set -euo pipefail
if (( $# > 1 )) || [[ ${1:---inspect} != --inspect && ${1:---inspect} != --execute && ${1:---inspect} != --resume-unstarted ]]; then
  echo 'Usage: bash probe-instagram-account-54156c46.sh [--inspect|--execute|--resume-unstarted]' >&2
  exit 2
fi
mode=${1:---inspect}
ops_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
probe_file="$ops_dir/probe-instagram-account-54156c46.mjs"
if [[ ! -f "$probe_file" ]] || ! grep -Fq "export const REVISION = 'instagram-account-54156c46.v2'" "$probe_file"; then
  echo 'Sync the v2 companion .mjs file first; no request was sent.' >&2
  exit 2
fi

if [[ "$mode" != --inspect ]]; then
  # This host-side claim survives Pod replacement. An interrupted run remains
  # claimed even when there is no visible Hub receipt yet. Never remove it to retry.
  state_dir="${XDG_STATE_HOME:-${HOME}/.local/state}/mx-insight-hub/instagram-account-54156c46"
  claim=execute-claimed
  if [[ "$mode" == --resume-unstarted ]]; then
    # Recovery of the reported v1 failure before dispatch, not a fresh budget.
    # The Pod additionally refuses recovery if any fixed receipt or marker exists.
    if [[ ! -d "$state_dir/execute-claimed" || -L "$state_dir/execute-claimed" ]]; then
      echo 'The original host claim is required for recovery. Keep the same host and state directory.' >&2
      exit 2
    fi
    claim=resume-unstarted-claimed
  fi
  umask 077
  mkdir -p -- "$state_dir"
  if ! mkdir -- "$state_dir/$claim" 2>/dev/null; then
    echo 'This incident batch was already claimed. Use --inspect; do not delete the marker or change hosts to retry.' >&2
    exit 2
  fi
  sync -f "$state_dir/$claim"
  sync -f "$state_dir"
fi

exec kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  sh -c 'cd /app && export MX_IG_PROBE_RUN_DIR=/dev/shm/mx-ig-account-54156c46 && if [ "$1" = --resume-unstarted ]; then export MX_IG_PROBE_RECOVERY_CLAIM=54156c46-247b-4783-ba5a-24a070be6b88; fi; exec node --input-type=module - "$1"' sh "$mode" < "$probe_file"
