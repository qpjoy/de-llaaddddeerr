#!/usr/bin/env bash
set -Eeuo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_DIR="$(cd "$APP_DIR/.." && pwd)"
source "$BASE_DIR/scripts/gpu-common.sh"
if [ -f "$APP_DIR/.env" ]; then set -a; source "$APP_DIR/.env"; set +a; fi
gpu_config
export PROJECT=mx-ocr GPU_ID="$MX_BASE_OCR_GPU"
export BIND="${BIND:-127.0.0.1}" PORT="${PORT:-8710}" STRICT_PORT=1
export CPU_LIMIT="${CPU_LIMIT:-16}" MEM_LIMIT="${MEM_LIMIT:-16g}"
export UVICORN_WORKERS="${UVICORN_WORKERS:-2}" WORKERS_FAST="${WORKERS_FAST:-2}"
export OMP_THREADS="${OMP_THREADS:-4}" ORT_INTRA="${ORT_INTRA:-4}"
# Upstream throughput is not a measurement for this resource profile.
export RATED_RPS="${RATED_RPS:-0}" RATED_CONCURRENCY="${RATED_CONCURRENCY:-0}"
action="${1:-help}"; [ "$#" = 0 ] || shift
containers() {
  docker ps -a --filter label=com.mx-base.app=mx-ocr --format '{{.Names}}'
}
case "$action" in
  deploy|start|restart)
    gpu_admit mx-ocr
    export GPU_ID="$GPU_UUID"
    # Redeploy is explicit; ordinary start never pulls, builds or changes saved settings.
    if [ "$action" = deploy ]; then
      exec bash "$APP_DIR/scripts/upstream-manage.sh" deploy "$@"
    fi
    names=(); while IFS= read -r name; do [ -z "$name" ] || names+=("$name"); done < <(containers)
    [ "${#names[@]}" -gt 0 ] || { echo '尚未部署；请先 deploy mx-ocr' >&2; exit 1; }
    python3 "$BASE_DIR/scripts/check-saved-gpu.py" mx-ocr "$GPU_UUID" "${names[@]}"
    docker "$action" "${names[@]}"
    python3 "$BASE_DIR/scripts/wait-healthy.py" mx-ocr-api
    ;;
  stop|down)
    docker info >/dev/null
    names=(); while IFS= read -r name; do [ -z "$name" ] || names+=("$name"); done < <(containers)
    if [ "${#names[@]}" -gt 0 ]; then docker stop --time 40 "${names[@]}"; fi
    echo 'mx-ocr 已停止；容器、镜像、模型缓存保留。内存中的缓存/异步任务不持久化。'
    ;;
  status)
    if ! docker info >/dev/null 2>&1; then echo 'mx-ocr UNKNOWN：Docker 不可访问'; exit 0; fi
    output="$(docker ps -a --filter label=com.mx-base.app=mx-ocr --format '{{.Names}} {{.Status}} {{.Ports}}')" || exit 1
    echo "${output:-mx-ocr NOT DEPLOYED}"
    ;;
  doctor) python3 "$BASE_DIR/scripts/gpu-check.py" mx-ocr; bash "$APP_DIR/scripts/upstream-manage.sh" doctor;;
  logs|stats|disk|test|bench|compare) exec bash "$APP_DIR/scripts/upstream-manage.sh" "$action" "$@";;
  help|-h|--help) echo 'mx-ocr: deploy | start | stop | restart | status | doctor | logs [api|vllm] | stats | disk | test [file] | bench | compare';;
  *) echo "不支持的操作：$action" >&2; exit 1;;
esac
