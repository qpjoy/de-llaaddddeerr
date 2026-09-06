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
    fail "Could not read the Hub Public API key from the terminal."
  fi
  printf '\n' >/dev/tty
fi
case "$HUB_API_KEY" in
  *$'\r'*|*$'\n'*) fail "HUB_API_KEY must not contain a line break." ;;
esac
[[ "$HUB_API_KEY" =~ [^[:space:]] ]] \
  || fail "HUB_API_KEY must not be empty or whitespace."
case "$HUB_API_KEY" in
  mih_test_*) fail "mih_test_ is compatibility metadata, not a no-cost sandbox; external ecommerce acquisition accepts only mih_live_ Hub Public API keys." ;;
  mih_live_*) ;;
  *) fail "HUB_API_KEY must be the complete mih_live_ Hub Public API secret shown at issuance." ;;
esac
# Keep the secret in a non-exported shell variable, then remove the inherited
# environment copy before starting curl, jq, uuidgen or other child processes.
HUB_API_KEY_VALUE="$HUB_API_KEY"
export -n HUB_API_KEY_VALUE
unset HUB_API_KEY

(
umask 077

AUTH_HEADER="$(mktemp /tmp/mxih-auth.XXXXXX)"
PREFLIGHT_BODY="$(mktemp /tmp/mxih-preflight-body.XXXXXX)"
LIVE_HEADERS="$(mktemp /tmp/mxih-live-headers.XXXXXX)"
LIVE_BODY="$(mktemp /tmp/mxih-live-body.XXXXXX)"
REPLAY_HEADERS="$(mktemp /tmp/mxih-replay-headers.XXXXXX)"
REPLAY_BODY="$(mktemp /tmp/mxih-replay-body.XXXXXX)"
trap 'rm -f "$AUTH_HEADER" "$PREFLIGHT_BODY" "$LIVE_HEADERS" "$LIVE_BODY" "$REPLAY_HEADERS" "$REPLAY_BODY"' EXIT

printf 'Authorization: Bearer %s\n' "$HUB_API_KEY_VALUE" >"$AUTH_HEADER"
unset HUB_API_KEY_VALUE

# Zero-cost gate: authenticate the key against the same Public origin and
# require the ecommerce route to be granted and ready before minting a live
# request identity. This endpoint creates no usage reservation and cannot
# dispatch JustOne.
if ! PREFLIGHT_HTTP_STATUS=$(curl -sS \
  -o "$PREFLIGHT_BODY" \
  -w '%{http_code}' \
  -H "@$AUTH_HEADER" \
  -H 'Accept: application/json' \
  "$HUB_PUBLIC_URL/api/v1/data/capabilities"); then
  fail "The zero-cost Hub key preflight could not reach the Public API; no live request was sent."
fi
printf 'Preflight HTTP status: %s\n' "$PREFLIGHT_HTTP_STATUS"
case "$PREFLIGHT_HTTP_STATUS" in
  2??) ;;
  *)
    jq '{error, requestId}' "$PREFLIGHT_BODY"
    fail "The Hub Public API key is not valid on this Public API origin; no live request was sent."
    ;;
esac
if ! jq -e '
  any(.data.platforms[]?;
    ((if type == "string" then . else .platform end) == "ecommerce")
    and (type == "object" and .ready == true)
  )
' "$PREFLIGHT_BODY" >/dev/null; then
  jq '{ecommerce: [.data.platforms[]? | select((.platform? // .) == "ecommerce")]}' "$PREFLIGHT_BODY"
  fail "The key is valid, but ecommerce is not granted and ready; no live request was sent."
fi
printf 'Preflight: Hub key valid; ecommerce granted and ready; provider product-search dispatches: 0\n'

LIVE_KEY="${HUB_IDEMPOTENCY_KEY:-}"
[ -n "$LIVE_KEY" ] || LIVE_KEY="external-live-$(uuidgen)"
case "$LIVE_KEY" in
  *$'\r'*|*$'\n'*) fail "HUB_IDEMPOTENCY_KEY must not contain a line break." ;;
esac
UNIQUE_QUERY="${HUB_ECOMMERCE_QUERY:-蓝牙耳机受控实时检查-${LIVE_KEY##*-}}"
REQUEST_BODY="$(jq -nc --arg query "$UNIQUE_QUERY" \
  '{marketplace:"jd",query:$query}')"

# These values contain no credential. Print them before dispatch so an
# interrupted or ambiguous response can be recovered with the exact same
# logical request instead of accidentally minting another provider call.
printf 'Recovery Idempotency-Key: %s\n' "$LIVE_KEY"
printf 'Recovery request body: %s\n' "$REQUEST_BODY"
printf 'If the outcome is ambiguous, rerun with the same HUB_IDEMPOTENCY_KEY and HUB_ECOMMERCE_QUERY; never mint a new Idempotency-Key.\n'

# 第一次：允许一次可能产生内部采购成本的 JustOne 实时派发。
if ! LIVE_HTTP_STATUS=$(curl -sS \
  -D "$LIVE_HEADERS" \
  -o "$LIVE_BODY" \
  -w '%{http_code}' \
  -H "@$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $LIVE_KEY" \
  -d "$REQUEST_BODY" \
  "$HUB_PUBLIC_URL/api/v1/data/ecommerce/products/search"); then
  fail "The live request transport failed after dispatch may have started. Recover only with the same Idempotency-Key and identical body shown above; never mint a new Idempotency-Key."
fi

printf 'Live HTTP status: %s\n' "$LIVE_HTTP_STATUS"
jq '{requestId, sourceMode:.meta.sourceMode, page:.data.page, error}' "$LIVE_BODY"
sed -n '/^x-mx-insight-/Ip;/^idempotent-replay:/Ip' "$LIVE_HEADERS"

case "$LIVE_HTTP_STATUS" in
  2??) ;;
  *)
    LIVE_ERROR_CODE="$(jq -r '.error.code // empty' "$LIVE_BODY" 2>/dev/null || true)"
    case "$LIVE_ERROR_CODE" in
      external_platform_outcome_unknown|external_platform_response_unusable|request_outcome_unknown|request_in_progress)
        fail "The live outcome is ambiguous (${LIVE_ERROR_CODE}). Recover only with the same Idempotency-Key and identical body shown above; never mint a new Idempotency-Key."
        ;;
      *) fail "The first live request was rejected (${LIVE_ERROR_CODE:-unknown_error}); no replay check was sent." ;;
    esac
    ;;
esac
if ! LIVE_SOURCE_MODE=$(jq -er '.meta.sourceMode' "$LIVE_BODY" 2>/dev/null); then
  fail "The first response has no valid meta.sourceMode; no second request was sent."
fi
case "$LIVE_SOURCE_MODE" in
  live) ;;
  idempotent_replay)
    printf 'Recovery replay confirmed: the original request completed; this run created no new Hub usage or provider dispatch.\n'
    exit 0
    ;;
  *) fail "The first response used ${LIVE_SOURCE_MODE}, so a new live provider dispatch was not proven; no replay check was sent." ;;
esac

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
  fail "The replay check could not reach Hub; do not retry it with another Idempotency-Key."
fi

printf 'Replay HTTP status: %s\n' "$REPLAY_HTTP_STATUS"
jq '{requestId, sourceMode:.meta.sourceMode, page:.data.page, error}' "$REPLAY_BODY"
sed -n '/^x-mx-insight-/Ip;/^idempotent-replay:/Ip' "$REPLAY_HEADERS"

case "$REPLAY_HTTP_STATUS" in
  2??) ;;
  *) fail "The replay check failed; do not retry it with another Idempotency-Key." ;;
esac
if ! REPLAY_SOURCE_MODE=$(jq -er '.meta.sourceMode' "$REPLAY_BODY" 2>/dev/null); then
  fail "The replay response has no valid meta.sourceMode."
fi
[ "$REPLAY_SOURCE_MODE" = idempotent_replay ] \
  || fail "Expected idempotent_replay but received ${REPLAY_SOURCE_MODE}; do not retry with another Idempotency-Key."
)
