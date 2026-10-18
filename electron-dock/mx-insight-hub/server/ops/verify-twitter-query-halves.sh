#!/usr/bin/env bash
# Explicit live diagnostic: at most two supplier requests, potentially billed.
# The Node probe retains receipts and never repeats an already recorded case.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo 'This entry accepts no arguments; it only executes the two fixed halves.' >&2
  exit 2
fi

ops_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
probe_file="$ops_dir/verify-twitter-query-param.mjs"
if [[ ! -f "$probe_file" ]] || ! grep -Fqx "export const REVISION = 'twitter-query-param-check.v6'" "$probe_file"; then
  echo 'Sync verify-twitter-query-param.mjs revision v6 beside this script; no cluster request was sent.' >&2
  exit 2
fi

exec kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  env MX_TWITTER_QUERY_PARAM_VERIFY=0 node --input-type=module - --case=halves --execute < "$probe_file"
