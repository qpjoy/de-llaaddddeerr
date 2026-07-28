#!/usr/bin/env bash

set -euo pipefail

command -v curl >/dev/null 2>&1 || {
  printf 'curl is required\n' >&2
  exit 1
}
command -v jq >/dev/null 2>&1 || {
  printf 'jq is required\n' >&2
  exit 1
}

response_file="$(mktemp "${TMPDIR:-/tmp}/mx-feishu-tenant.XXXXXX")"
trap 'rm -f -- "$response_file"' EXIT

feishu_error() {
  local label="$1"
  local http_status="$2"
  local code msg
  code="$(jq -r '.code // .error // "unknown"' "$response_file" 2>/dev/null || printf 'unknown')"
  msg="$(jq -r '.msg // .error_description // "unknown error"' "$response_file" 2>/dev/null || printf 'non-JSON response')"
  printf '%s failed: HTTP %s, Feishu code=%s, msg=%s\n' \
    "$label" "$http_status" "$code" "$msg" >&2
  exit 1
}

IFS= read -r -p 'App ID (raw value, without quotes): ' app_id
IFS= read -r -s -p 'App Secret (raw value, without quotes): ' app_secret
printf '\n'
[ -n "$app_id" ] || {
  printf 'App ID must not be empty\n' >&2
  exit 1
}
[ -n "$app_secret" ] || {
  printf 'App Secret must not be empty\n' >&2
  exit 1
}

if ! http_status="$(
  jq -n \
    --arg app_id "$app_id" \
    --arg app_secret "$app_secret" \
    '{app_id:$app_id,app_secret:$app_secret}' |
  curl -sS \
    -o "$response_file" \
    -w '%{http_code}' \
    -H 'Content-Type: application/json; charset=utf-8' \
    --data-binary @- \
    https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/
)"; then
  printf 'requesting tenant_access_token failed at the transport layer\n' >&2
  exit 1
fi

tenant_access_token="$(
  jq -er '.tenant_access_token | select(type == "string" and length > 0)' \
    "$response_file" 2>/dev/null
)" || feishu_error 'tenant_access_token request' "$http_status"

if ! http_status="$(
  curl -sS \
    -o "$response_file" \
    -w '%{http_code}' \
    -H "Authorization: Bearer $tenant_access_token" \
    https://open.feishu.cn/open-apis/tenant/v2/tenant/query
)"; then
  printf 'requesting tenant information failed at the transport layer\n' >&2
  exit 1
fi

tenant_key="$(
  jq -er '.data.tenant.tenant_key | select(type == "string" and length > 0)' \
    "$response_file" 2>/dev/null
)" || feishu_error 'tenant information request' "$http_status"

printf '%s\n' "$tenant_key"
unset app_id app_secret tenant_access_token tenant_key http_status
