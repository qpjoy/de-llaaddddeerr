#!/usr/bin/env bash
# Run on the kubectl host, not through Node. At most two potentially billed calls.
# Compare the English topic/event groups, each with the original exclusions.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo 'This entry accepts no arguments; it only executes the two fixed English groups.' >&2
  exit 2
fi

ops_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
probe_file="$ops_dir/verify-twitter-query-param.mjs"
if [[ ! -f "$probe_file" ]] || ! grep -Fqx "export const REVISION = 'twitter-query-param-check.v4'" "$probe_file"; then
  echo 'Sync verify-twitter-query-param.mjs revision v4 beside this script; no cluster request was sent.' >&2
  exit 2
fi

exec kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  env MX_TWITTER_QUERY_PARAM_VERIFY=0 node --input-type=module - --case=english-groups --execute < "$probe_file"
