#!/usr/bin/env bash
set -euo pipefail

elasticsearch_url="${ELASTICSEARCH_URL:-http://elasticsearch:9200}"

until curl -fsS "${elasticsearch_url}/_cluster/health" >/dev/null; do
  sleep 2
done

curl -fsS -X PUT "${elasticsearch_url}/_ilm/policy/mx-insight-logs-policy" \
  -H 'content-type: application/json' \
  --data-binary @/assets/logs-ilm-policy.json >/dev/null

curl -fsS -X PUT "${elasticsearch_url}/_index_template/mx-insight-content-v1" \
  -H 'content-type: application/json' \
  --data-binary @/assets/content-index-template.json >/dev/null

curl -fsS -X PUT "${elasticsearch_url}/_index_template/mx-insight-logs" \
  -H 'content-type: application/json' \
  --data-binary @/assets/logs-index-template.json >/dev/null

curl -fsS -X PUT "${elasticsearch_url}/_snapshot/mx_insight_local_fs" \
  -H 'content-type: application/json' \
  --data-binary @/assets/snapshot-repository.json >/dev/null

printf '%s\n' '[mx-insight-search] templates, ILM policy, and local snapshot repository are ready'
