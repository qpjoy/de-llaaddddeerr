#!/usr/bin/env bash
# Run on the kubectl host, not through Node. At most two potentially billed calls.
# Verify the fixed event OR permutation, then the full equivalent query if accepted.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo 'This entry accepts no arguments; it only executes the fixed OR-order comparison.' >&2
  exit 2
fi

ops_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
probe_file="$ops_dir/verify-twitter-query-param.mjs"
if [[ ! -f "$probe_file" ]] || ! grep -Fqx "export const REVISION = 'twitter-query-param-check.v7'" "$probe_file"; then
  echo 'Sync verify-twitter-query-param.mjs revision v7 beside this script; no cluster request was sent.' >&2
  exit 2
fi

exec kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  env MX_TWITTER_QUERY_PARAM_VERIFY=0 node --input-type=module - --case=event-order --execute < "$probe_file"
