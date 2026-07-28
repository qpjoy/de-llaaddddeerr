kubectl apply -f deploy/k8s/internal-shadow/00-namespace.yaml

umask 077
secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/mx-feishu-oauth.XXXXXX")"
trap 'rm -rf -- "$secret_dir"' EXIT

IFS= read -r -p 'Feishu App ID: ' feishu_app_id
IFS= read -r -s -p 'Feishu App Secret: ' feishu_app_secret
printf '\n'
IFS= read -r -p 'Allowed tenant key(s), comma separated: ' feishu_tenant_keys

printf '%s' "$feishu_app_id" >"$secret_dir/app-id"
printf '%s' "$feishu_app_secret" >"$secret_dir/app-secret"
printf '%s' "$feishu_tenant_keys" >"$secret_dir/tenant-keys"
unset feishu_app_id feishu_app_secret feishu_tenant_keys

kubectl -n mx-internal-shadow create secret generic mx-feishu-oauth \
  --from-file=app-id="$secret_dir/app-id" \
  --from-file=app-secret="$secret_dir/app-secret" \
  --from-file=tenant-keys="$secret_dir/tenant-keys" \
  --dry-run=client -o yaml |
  kubectl apply -f -