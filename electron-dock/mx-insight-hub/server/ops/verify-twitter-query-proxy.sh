#!/usr/bin/env bash
# Run on the kubectl host, not through Node. At most two potentially billed calls.
# The diagnostic alone uses http://127.0.0.1:7788 inside the selected host-network Pod.
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo 'This entry accepts no arguments; it only executes the fixed host-proxy comparison.' >&2
  exit 2
fi

ops_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
probe_file="$ops_dir/verify-twitter-query-param.mjs"
if [[ ! -f "$probe_file" ]] || ! grep -Fqx "export const REVISION = 'twitter-query-param-check.v8'" "$probe_file"; then
  echo 'Sync verify-twitter-query-param.mjs revision v8 beside this script; no cluster request was sent.' >&2
  exit 2
fi

if ! pod_rows="$(kubectl -n mx-insight-hub get pods -l app.kubernetes.io/name=mx-insight-hub-admin \
  --field-selector=status.phase=Running \
  -o 'jsonpath={range .items[*]}{"name="}{.metadata.name}{"\tphase="}{.status.phase}{"\tdeleting="}{.metadata.deletionTimestamp}{"\tready="}{.status.conditions[?(@.type=="Ready")].status}{"\tadmin="}{.status.containerStatuses[?(@.name=="admin")].ready}{"\thostNetwork="}{.spec.hostNetwork}{"\n"}{end}')"; then
  echo 'Could not inspect Admin Pods; no diagnostic process was started.' >&2
  exit 2
fi

pod_count=0
selected_pod=''
selected_ready=''
selected_admin=''
selected_network=''
while IFS=$'\t' read -r name_field phase_field deletion_field ready_field admin_field network_field; do
  [[ -z "$name_field" ]] && continue
  if [[ "$name_field" != name=* || "$phase_field" != phase=* || "$deletion_field" != deleting=* \
    || "$ready_field" != ready=* || "$admin_field" != admin=* || "$network_field" != hostNetwork=* ]]; then
    echo 'Unexpected Admin Pod inspection output; no diagnostic process was started.' >&2
    exit 2
  fi
  [[ "$phase_field" != phase=Running || "$deletion_field" != deleting= ]] && continue
  selected_pod="${name_field#name=}"
  if [[ ! "$selected_pod" =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ || ${#selected_pod} -gt 253 ]]; then
    echo 'Invalid Admin Pod identity; no diagnostic process was started.' >&2
    exit 2
  fi
  pod_count=$((pod_count + 1))
  selected_ready="$ready_field"
  selected_admin="$admin_field"
  selected_network="$network_field"
done <<< "$pod_rows"

if [[ "$pod_count" -ne 1 || "$selected_ready" != ready=True || "$selected_admin" != admin=true \
  || "$selected_network" != hostNetwork=true ]]; then
  echo 'Require exactly one non-terminating Running Admin Pod with Ready=True, a ready admin container and hostNetwork=true; no diagnostic process was started.' >&2
  exit 2
fi

# Pin the inspected Pod. Resolving the Deployment again could select another node.
exec kubectl -n mx-insight-hub exec -i "pod/$selected_pod" -c admin -- \
  env MX_TWITTER_QUERY_PARAM_VERIFY=0 node --input-type=module - --case=host-proxy --execute < "$probe_file"
