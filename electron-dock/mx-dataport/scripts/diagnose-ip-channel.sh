#!/usr/bin/env bash
# Run on the Hub Kubernetes host. Reads retained evidence only; no HTTP calls.
set -euo pipefail
diagnostic_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
kubectl --request-timeout=15s -n "${HUB_NAMESPACE:-mx-insight-hub}" exec -i \
  "${HUB_TARGET:-deployment/mx-insight-hub-public}" \
  -c "${HUB_CONTAINER:-api}" -- node --input-type=module - "$@" \
  < "$diagnostic_dir/ip-channel-diagnostics.mjs"
