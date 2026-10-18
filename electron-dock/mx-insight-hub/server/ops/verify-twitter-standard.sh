#!/usr/bin/env bash
set -euo pipefail
if (( $# )); then
  echo 'This acceptance command accepts no arguments.' >&2
  exit 2
fi
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
probe_file="$script_dir/verify-twitter-standard.mjs"
if [[ ! -f "$probe_file" ]] || ! grep -Fxq "export const REVISION = 'twitter-standard-check.v1'" "$probe_file"; then
  echo 'Missing or outdated acceptance source; no cluster request was sent.' >&2
  exit 2
fi
# Uses the deployed Public wiring, existing caller and at most two persisted
# supplier attempts across executions. Never starts a second HTTP listener.
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-public -c api -- \
  node --input-type=module - --execute < "$probe_file"
