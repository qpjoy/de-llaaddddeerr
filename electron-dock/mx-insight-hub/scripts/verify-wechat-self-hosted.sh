#!/usr/bin/env bash
# Verifies the WeChat self-hosted engine API end to end
# (docs/architecture/spider_man/03-self-hosted-engines.md).
#
# Submits ONE real search job (a real Sogou crawl through Night-All), polls it
# with Retry-After, reads the result and checks idempotent replay. A batch of
# two more jobs runs only with VERIFY_BATCH=1. Admin checks run only when
# ADMIN_TOKEN is set and are read-only (state + health probe).
#
#   HUB_API_KEY=… bash scripts/verify-wechat-self-hosted.sh
#   HUB_URL=http://10.88.88.88:18150 ADMIN_URL=http://10.88.88.88:18151 ADMIN_TOKEN=… HUB_API_KEY=… bash scripts/verify-wechat-self-hosted.sh
set -euo pipefail
HUB_URL=${HUB_URL:-http://127.0.0.1:18150}
ADMIN_URL=${ADMIN_URL:-http://127.0.0.1:18151}
QUERY=${VERIFY_QUERY:-人工智能}
: "${HUB_API_KEY:?HUB_API_KEY is required}"
P=/api/v1/data/wechat/self-hosted
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
json() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
# Empty (not a failure) when the header is absent, e.g. Retry-After on a finished job.
header() { { grep -i "^$1:" "$2" || true; } | head -1 | cut -d' ' -f2- | tr -d '\r'; }
api() { curl -sS --noproxy '*' -D "$WORK/h" -o "$WORK/b" -H "Authorization: Bearer $HUB_API_KEY" "$@"; }

if [ -n "${ADMIN_TOKEN:-}" ]; then
  echo '== Admin: engine state'
  curl -sS --noproxy '*' "$ADMIN_URL/internal/v1/admin/wechat-self-hosted" -H "Authorization: Bearer $ADMIN_TOKEN" | json \
    "'baseUrl=%s enabled=%s billing=%s quarantine=%s queued=%s' % (d['data']['engine']['baseUrl'], d['data']['engine']['enabled'], d['data']['engine']['billingEnabled'], d['data']['engine']['quarantineReason'], d['data']['queue']['queued'])"
  echo '== Admin: read-only probe of Night-All /api/v1/health'
  curl -sS --noproxy '*' -X POST "$ADMIN_URL/internal/v1/admin/wechat-self-hosted/engine/probe" -H "Authorization: Bearer $ADMIN_TOKEN" | json \
    "'reachable=%s http=%s healthy=%s ms=%s' % (d['data']['reachable'], d['data']['httpStatus'], d['data']['healthy'], d['data']['durationMs'])"
fi

echo '== Submit one job'
KEY="verify-wsh-$(date +%s)"
BODY=$(python3 -c "import json,sys;print(json.dumps({'query':sys.argv[1],'limit':3},ensure_ascii=False))" "$QUERY")
api -X POST "$HUB_URL$P/jobs" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" --data "$BODY"
echo "http=$(head -1 "$WORK/h" | cut -d' ' -f2) location=$(header location "$WORK/h") retry-after=$(header retry-after "$WORK/h")"
JOB=$(json "d['data']['jobId']" < "$WORK/b")
json "'job=%s status=%s queue=%s' % (d['data']['jobId'], d['data']['status'], d['data']['queue'])" < "$WORK/b"

echo '== Poll with Retry-After (up to ~30 min)'
for i in $(seq 1 120); do
  api "$HUB_URL$P/jobs/$JOB"
  STATUS=$(json "d['data']['status']" < "$WORK/b")
  WAIT=$(header retry-after "$WORK/h")
  echo "poll $i: $STATUS${WAIT:+ (retry-after ${WAIT}s)}"
  case $STATUS in queued|running) sleep "${WAIT:-5}" ;; *) break ;; esac
done
json "'status=%s source=%s billing=%s items=%s durationMs=%s error=%s' % (d['data']['status'], d['data']['delivery']['sourceMode'], d['data']['billing']['status'], d['data']['delivery']['itemCount'], d['data']['timing']['durationMs'], d['data']['error'])" < "$WORK/b"

echo '== Result (read-only, never re-crawls or re-bills)'
api "$HUB_URL$P/jobs/$JOB/result"
if [ "$(head -1 "$WORK/h" | cut -d' ' -f2)" = 200 ]; then
  json "'items=%s first=%s notice=%s' % (len(d['data']['items']), (d['data']['items'][0].get('title') if d['data']['items'] else None), d['data']['notice'])" < "$WORK/b"
else
  json "'result unavailable: %s' % d['error']['code']" < "$WORK/b"
fi

echo '== Same Idempotency-Key and body -> original job'
api -X POST "$HUB_URL$P/jobs" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" --data "$BODY"
echo "idempotent-replay=$(header idempotent-replay "$WORK/h") same-job=$([ "$(json "d['data']['jobId']" < "$WORK/b")" = "$JOB" ] && echo yes || echo no)"

if [ "${VERIFY_BATCH:-0}" = 1 ]; then
  echo '== Batch of two (two more real crawls)'
  api -X POST "$HUB_URL$P/batches" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY-batch" \
    --data '{"items":[{"clientRef":"a","query":"新能源"},{"clientRef":"b","query":"机器人"}]}'
  BATCH=$(json "d['data']['batchId']" < "$WORK/b")
  for i in $(seq 1 120); do
    api "$HUB_URL$P/batches/$BATCH"
    DONE=$(json "d['data']['complete']" < "$WORK/b")
    json "'batch poll %s: %s' % ($i, d['data']['counts'])" < "$WORK/b"
    [ "$DONE" = True ] && break
    WAIT=$(header retry-after "$WORK/h")
    sleep "${WAIT:-10}"
  done
  api "$HUB_URL$P/batches/$BATCH/result"
  json "[(r['clientRef'], r['status'], len(r['items'] or [])) for r in d['data']['items']]" < "$WORK/b"
fi
