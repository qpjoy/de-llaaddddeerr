#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf '[justone-apicall] ERROR: %s\n' "$*" >&2
  exit 1
}

for dependency in curl jq uuidgen; do
  command -v "$dependency" >/dev/null 2>&1 \
    || fail "Missing command: ${dependency}"
done

[ -n "${HUB_PUBLIC_URL:-}" ] \
  || fail "HUB_PUBLIC_URL is empty. Run: export HUB_PUBLIC_URL='https://hub.minsight-ai.com'"
case "$HUB_PUBLIC_URL" in
  http://*|https://*) ;;
  *) fail "HUB_PUBLIC_URL must start with http:// or https://" ;;
esac
HUB_PUBLIC_URL="${HUB_PUBLIC_URL%/}"

if [ -z "${HUB_API_KEY:-}" ]; then
  if ! printf 'MX Insight API Key: ' 2>/dev/null >/dev/tty; then
    fail "HUB_API_KEY is empty and no interactive terminal is available."
  fi
  if ! IFS= read -r -s HUB_API_KEY </dev/tty; then
    printf '\n' >/dev/tty
    fail "Could not read the Hub consumer API key from the terminal."
  fi
  printf '\n' >/dev/tty
fi
case "$HUB_API_KEY" in
  *$'\r'*|*$'\n'*) fail "HUB_API_KEY must not contain a line break." ;;
esac
[[ "$HUB_API_KEY" =~ [^[:space:]] ]] \
  || fail "HUB_API_KEY must not be empty or whitespace."
# Keep the secret in a non-exported shell variable, then remove the inherited
# environment copy before starting curl, jq, uuidgen or other child processes.
HUB_API_KEY_VALUE="$HUB_API_KEY"
export -n HUB_API_KEY_VALUE
unset HUB_API_KEY

(
umask 077

AUTH_HEADER="$(mktemp /tmp/mxih-auth.XXXXXX)"
LIVE_HEADERS="$(mktemp /tmp/mxih-live-headers.XXXXXX)"
LIVE_BODY="$(mktemp /tmp/mxih-live-body.XXXXXX)"
REPLAY_HEADERS="$(mktemp /tmp/mxih-replay-headers.XXXXXX)"
REPLAY_BODY="$(mktemp /tmp/mxih-replay-body.XXXXXX)"
trap 'rm -f "$AUTH_HEADER" "$LIVE_HEADERS" "$LIVE_BODY" "$REPLAY_HEADERS" "$REPLAY_BODY"' EXIT

printf 'Authorization: Bearer %s\n' "$HUB_API_KEY_VALUE" >"$AUTH_HEADER"
unset HUB_API_KEY_VALUE

LIVE_KEY="external-live-$(uuidgen)"
UNIQUE_QUERY="蓝牙耳机付费检查-$(date +%Y%m%d%H%M%S)-${LIVE_KEY##*-}"
REQUEST_BODY="$(jq -nc --arg query "$UNIQUE_QUERY" \
  '{marketplace:"jd",query:$query}')"

# 第一次：允许一次 JustOne 上游调用
if ! LIVE_HTTP_STATUS=$(curl -sS \
  -D "$LIVE_HEADERS" \
  -o "$LIVE_BODY" \
  -w '%{http_code}' \
  -H "@$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $LIVE_KEY" \
  -d "$REQUEST_BODY" \
  "$HUB_PUBLIC_URL/api/v1/data/ecommerce/products/search"); then
  fail "The live request could not reach Hub; the replay check was not sent."
fi

printf 'Live HTTP status: %s\n' "$LIVE_HTTP_STATUS"
jq '{requestId, sourceMode:.meta.sourceMode, page:.data.page, error}' "$LIVE_BODY"
sed -n '/^x-mx-insight-/Ip;/^idempotent-replay:/Ip' "$LIVE_HEADERS"

case "$LIVE_HTTP_STATUS" in
  2??) ;;
  *) fail "The first request was not successful; no second request was sent." ;;
esac
if ! LIVE_SOURCE_MODE=$(jq -er '.meta.sourceMode' "$LIVE_BODY" 2>/dev/null); then
  fail "The first response has no valid meta.sourceMode; no second request was sent."
fi
[ "$LIVE_SOURCE_MODE" = live ] \
  || fail "The first response used ${LIVE_SOURCE_MODE}, not live; no second request was sent."

# 第二次：相同查询、相同幂等键，只验证 Hub replay，不允许第二次上游调用。
if ! REPLAY_HTTP_STATUS=$(curl -sS \
  -D "$REPLAY_HEADERS" \
  -o "$REPLAY_BODY" \
  -w '%{http_code}' \
  -H "@$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $LIVE_KEY" \
  -d "$REQUEST_BODY" \
  "$HUB_PUBLIC_URL/api/v1/data/ecommerce/products/search"); then
  fail "The replay check could not reach Hub; do not retry it with another key."
fi

printf 'Replay HTTP status: %s\n' "$REPLAY_HTTP_STATUS"
jq '{requestId, sourceMode:.meta.sourceMode, page:.data.page, error}' "$REPLAY_BODY"
sed -n '/^x-mx-insight-/Ip;/^idempotent-replay:/Ip' "$REPLAY_HEADERS"

case "$REPLAY_HTTP_STATUS" in
  2??) ;;
  *) fail "The replay check failed; do not retry it with another key." ;;
esac
if ! REPLAY_SOURCE_MODE=$(jq -er '.meta.sourceMode' "$REPLAY_BODY" 2>/dev/null); then
  fail "The replay response has no valid meta.sourceMode."
fi
[ "$REPLAY_SOURCE_MODE" = idempotent_replay ] \
  || fail "Expected idempotent_replay but received ${REPLAY_SOURCE_MODE}; do not retry with another key."
)
