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
case "${1:-help}" in
  deploy)
    confirm_deploy mx-embedding
    gpu_admit mx-embedding
    init
    compose config --quiet
    compose up -d --build --wait --wait-timeout 1800
    status
    ;;
  start|restart)
    gpu_admit mx-embedding
    python3 "$BASE_DIR/scripts/check-saved-gpu.py" mx-embedding "$GPU_UUID" mx-embedding-api
    docker "$1" mx-embedding-api
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
  help|-h|--help) echo 'mx-embedding: deploy | start | stop | restart | status | doctor | logs | stats | test';;
  *) echo "不支持的操作：$1" >&2; exit 1;;
esac
