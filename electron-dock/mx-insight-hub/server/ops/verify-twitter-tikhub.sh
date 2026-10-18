#!/usr/bin/env bash
# Run on the kubectl host. Readiness first, at most one potentially billed page.
set -euo pipefail
if [[ $# -ne 0 ]]; then
  echo 'This entry accepts no arguments; it checks the fixed full Twitter query through TikHub.' >&2
  exit 2
fi
ops_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
probe_file="$ops_dir/verify-twitter-tikhub.mjs"
if [[ ! -f "$probe_file" ]] || ! grep -Fqx "export const REVISION = 'twitter-tikhub-check.v3'" "$probe_file"; then
  echo 'Sync verify-twitter-tikhub.mjs revision v3 beside this script; no cluster request was sent.' >&2
  exit 2
fi
exec kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - --execute < "$probe_file"
