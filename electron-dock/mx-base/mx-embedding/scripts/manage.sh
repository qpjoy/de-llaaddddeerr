#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_DIR="$(cd "$APP_DIR/.." && pwd)"
source "$BASE_DIR/scripts/gpu-common.sh"
source "$BASE_DIR/scripts/deploy-confirm.sh"
# Keep explicitly supplied download settings, even an empty proxy to request direct access.
download_overrides=()
for key in MX_EMBEDDING_PROXY MX_EMBEDDING_PIP_INDEX; do
  if [[ ${!key+x} ]]; then download_overrides+=("$key=${!key}"); fi
done
if [ -f "$APP_DIR/.env" ]; then set -a; source "$APP_DIR/.env"; set +a; fi
if [ -f "$APP_DIR/.env.download" ]; then set -a; source "$APP_DIR/.env.download"; set +a; fi
for setting in ${download_overrides[@]+"${download_overrides[@]}"}; do export "$setting"; done
gpu_config
compose() { docker compose --project-directory "$APP_DIR" -f "$APP_DIR/compose.yml" "$@"; }
init() {
  local path="${MX_EMBEDDING_MODELS_PATH:-/srv/mx-embedding/models}"
  [[ "$path" = /* && "$path" != / ]] || { echo '模型缓存需要专用绝对目录' >&2; exit 1; }
  install -d -m 0750 "$path"
  install -d -m 0700 "$APP_DIR/secrets"
  if [ ! -f "$APP_DIR/secrets/api-key" ]; then
    (umask 077; set -o noclobber; openssl rand -hex 32 > "$APP_DIR/secrets/api-key")
  fi
  echo '模型缓存和 API Key 已准备，保留现有凭据。'
}
status() {
  if ! docker info >/dev/null 2>&1; then echo 'mx-embedding UNKNOWN：Docker 不可访问'; return; fi
  local output
  output="$(docker ps -a --filter label=com.mx-base.app=mx-embedding --format '{{.Names}} {{.Status}} {{.Ports}}')" || return 1
  echo "${output:-mx-embedding NOT DEPLOYED}"
}
action="${1:-help}"
[ "$#" = 0 ] || shift
while [ "$#" -gt 0 ]; do
  [ "$action" = deploy ] || { echo '下载参数仅用于 deploy' >&2; exit 1; }
  case "$1" in
    --proxy|--pip-index)
      [ "$#" -ge 2 ] && [ -n "$2" ] || { echo "$1 需要一个 URL" >&2; exit 1; }
      if [ "$1" = --proxy ]; then export MX_EMBEDDING_PROXY="$2"; else export MX_EMBEDDING_PIP_INDEX="$2"; fi
      shift 2;;
    --direct) export MX_EMBEDDING_PROXY=; shift;;
    *) echo '未知部署参数；支持 --proxy URL / --direct / --pip-index URL' >&2; exit 1;;
  esac
done
validate_download() {
  python3 - <<'PYTHON'
import os
import ipaddress
from urllib.parse import urlsplit
proxy = os.environ.get('MX_EMBEDDING_PROXY', '')
if proxy:
    try:
        url = urlsplit(proxy)
        host = url.hostname
        port = url.port
        if url.scheme not in ('http', 'https') or not host:
            raise ValueError()
    except ValueError:
        raise SystemExit('代理需要有效的 http:// 或 https:// URL')
    try:
        loopback = ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = host.lower().rstrip('.') == 'localhost'
    if loopback or host in ('0.0.0.0', '::'):
        raise SystemExit('代理地址指向容器自身或通配地址。请用 --proxy http://<宿主机可达IP>:7788；代理须监听该地址并允许容器访问。')
PYTHON
}
save_download() {
  local temporary
  temporary="$(mktemp "$APP_DIR/.env.download.XXXXXX")"
  chmod 600 "$temporary"
  {
    printf '# Managed by deploy; use --proxy, --direct or --pip-index to update.\n'
    printf 'MX_EMBEDDING_PROXY=%q\n' "${MX_EMBEDDING_PROXY:-}"
    printf 'MX_EMBEDDING_PIP_INDEX=%q\n' "${MX_EMBEDDING_PIP_INDEX:-https://pypi.org/simple}"
  } > "$temporary"
  mv -f "$temporary" "$APP_DIR/.env.download"
  echo '下载设置已保存；后续 deploy 自动复用（不代表代理连通性已验证）。'
}
case "$action" in
  deploy)
    validate_download
    confirm_deploy mx-embedding
    gpu_admit mx-embedding
    init
    compose config --quiet
    save_download
    compose up -d --build --wait --wait-timeout 1800
    status
    ;;
  start|restart)
    gpu_admit mx-embedding
    python3 "$BASE_DIR/scripts/check-saved-gpu.py" mx-embedding "$GPU_UUID" mx-embedding-api
    docker "$action" mx-embedding-api
    python3 "$BASE_DIR/scripts/wait-healthy.py" mx-embedding-api
    ;;
  stop|down)
    # No Compose interpolation and no GPU/model availability needed to release resources.
    docker info >/dev/null
    ids="$(docker ps -q --filter label=com.mx-base.app=mx-embedding)"
    if [ -n "$ids" ]; then docker stop --time 40 $ids; fi
    echo 'mx-embedding 已停止；模型缓存、配置、API Key 保留。'
    ;;
  status) status;;
  doctor)
    python3 "$BASE_DIR/scripts/gpu-check.py" mx-embedding
    status
    ;;
  logs) docker logs --tail 200 --follow mx-embedding-api;;
  stats) docker stats --no-stream mx-embedding-api; nvidia-smi;;
  test) docker exec -i mx-embedding-api python - < "$APP_DIR/scripts/smoke.py";;
  help|-h|--help) echo 'deploy 可用 --proxy URL / --direct / --pip-index URL，确认后自动保存下载设置'; echo 'mx-embedding: deploy | start | stop | restart | status | doctor | logs | stats | test';;
  *) echo "不支持的操作：$action" >&2; exit 1;;
esac
