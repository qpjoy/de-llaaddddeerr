#!/usr/bin/env bash
# Run on the kubectl host, not through Node. At most one new potentially billed call.
# Read the saved topic response; only the event group may make a new request.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo 'This entry accepts no arguments; it only resumes the fixed English event-group check.' >&2
  exit 2
fi

ops_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
probe_file="$ops_dir/verify-twitter-query-param.mjs"
if [[ ! -f "$probe_file" ]] || ! grep -Fqx "export const REVISION = 'twitter-query-param-check.v5'" "$probe_file"; then
  echo 'Sync verify-twitter-query-param.mjs revision v5 beside this script; no cluster request was sent.' >&2
  exit 2
fi

exec kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  env MX_TWITTER_QUERY_PARAM_VERIFY=0 node --input-type=module - --case=english-groups --execute < "$probe_file"
