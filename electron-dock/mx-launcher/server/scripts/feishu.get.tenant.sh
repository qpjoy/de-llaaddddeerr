IFS= read -r -p 'App ID: ' app_id
IFS= read -r -s -p 'App Secret: ' app_secret
printf '\n'

access_json="$(
  jq -n \
    --arg app_id "$app_id" \
    --arg app_secret "$app_secret" \
    '{app_id:$app_id,app_secret:$app_secret}' |
  curl -fsS \
    -H 'Content-Type: application/json; charset=utf-8' \
    --data-binary @- \
    https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal/
)"

tenant_access_token="$(
  printf '%s' "$access_json" |
  jq -er '.tenant_access_token'
)"

curl -fsS \
  -H "Authorization: Bearer $tenant_access_token" \
  https://open.feishu.cn/open-apis/tenant/v2/tenant/query |
  jq -er '.data.tenant.tenant_key'

unset app_id app_secret access_json tenant_access_token