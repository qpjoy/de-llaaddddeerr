#!/usr/bin/env bash
# Single-host experimental deployment; never installs/restarts Docker or mobile-agent.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
ACTION="${1:-help}"
say() { printf '[mx-device] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
case "$ACTION" in
  help|-h|--help)
    say '用法: bash scripts/manage.sh {deploy|init|status|logs|token|test-token|stop}'
    say 'TMPDIR=/data/tmp MX_DEVICE_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh deploy'
    exit ;;
  up) ACTION=deploy ;;
  deploy|init|status|logs|token|test-token|stop) ;;
  *) die "未知操作: $ACTION" ;;
esac
[[ $# -le 1 ]] || die '不接受额外参数'
command -v docker >/dev/null || die '需要已安装的 Docker；本脚本不会安装 Docker'
docker compose version >/dev/null || die '需要 Docker Compose v2（支持 up --wait）'
# Explicit project/file/env avoid accidentally selecting another Compose stack or .env.
compose() { docker compose --project-directory "$ROOT" --env-file /dev/null -p mx-device -f "$ROOT/compose.yaml" "$@"; }
bootstrap() {
  docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
    -v "$ROOT/scripts:/bootstrap:ro" -v "$ROOT/.runtime:/app/.runtime" -w /app \
    --entrypoint node "$1" /bootstrap/setup.mjs
}
case "$ACTION" in
  status) compose ps --all; exit ;;
  logs) compose logs --tail=100; exit ;;
  token|test-token)
    [[ -f .runtime/config.json ]] || die '尚无配置，请先 deploy'
    kind=admin; [[ "$ACTION" != test-token ]] || kind=test
    token_image=node:22-alpine
    if docker image inspect mx-device:experimental >/dev/null 2>&1; then token_image=mx-device:experimental; fi
    docker run --rm --network none --read-only --user "$(id -u):$(id -g)" \
      -v "$ROOT/scripts:/bootstrap:ro" -v "$ROOT/.runtime:/app/.runtime:ro" -w /app \
      --entrypoint node "$token_image" /bootstrap/token.mjs "$kind"
    exit ;;
esac
[[ "$(uname -s)" == Linux ]] || die '部署要求 Linux 本机 Docker；macOS 本地演示请使用 README 的 npm 启动步骤'
# A loopback PoC and bind-mounted credentials must refer to THIS host, not an SSH/TCP context.
endpoint="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
if [[ -z "${DOCKER_CONTEXT:-}" && -n "${DOCKER_HOST:-}" ]]; then endpoint="$DOCKER_HOST"; fi
[[ "$endpoint" == unix://* ]] || die '只支持本机 Unix socket Docker，不允许远程 context/DOCKER_HOST'
docker info >/dev/null || die 'Docker daemon 不可用；不会自动启动或重启它'
command -v flock >/dev/null || die '需要 flock（Linux util-linux），用于防止本目录并发部署'
mkdir -p .runtime
exec 9>.runtime/deploy.lock
flock -n 9 || die '本目录另一个部署/停止操作正在进行'
case "$ACTION" in
  stop) compose stop worker api postgres; say '仅本中心已停止；配置、凭证和数据卷保留'; exit ;;
esac
# A retained database without its original credentials must never receive a new password.
volumes="$(docker volume ls --format '{{.Name}}')"
if [[ ! -f .runtime/postgres-password ]] && [[ $'\n'"$volumes"$'\n' == *$'\nmx-device_data\n'* ]]; then
  die '发现保留的 mx-device_data 卷但缺少原密码；请恢复 .runtime 备份，不会重置数据库'
fi
if [[ "$ACTION" == init ]]; then bootstrap node:22-alpine; exit; fi
up_help="$(docker compose up --help)"
[[ "$up_help" == *--wait-timeout* ]] || die 'Compose 版本过旧：需要支持 up --wait-timeout'
docker buildx version >/dev/null || die '需要现有 Docker Buildx 插件'
# Unlike docker inspect, buildx inspect does not have a portable --format flag.
# Read its standard Driver field without bootstrapping or changing the builder.
builder_info="$(LC_ALL=C docker buildx inspect default)" || die '无法读取本机 default builder；未开始构建或停止服务'
builder_driver=''
while IFS= read -r line; do
  if [[ "$line" =~ ^Driver:[[:space:]]+([^[:space:]]+)[[:space:]]*$ ]]; then
    builder_driver="${BASH_REMATCH[1]}"
    break
  fi
done <<< "$builder_info"
[[ "$builder_driver" == docker ]] || die '仅使用本机 default Docker builder，不创建/改动 builder'
proxy="${MX_DEVICE_BUILD_PROXY:-}"
[[ -z "$proxy" || "$proxy" =~ ^https?://[^[:space:]]+$ ]] || die 'MX_DEVICE_BUILD_PROXY 必须为 HTTP(S) 代理地址（不会输出其内容）'
mkdir -p "${TMPDIR:-/tmp}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mx-device-deploy.XXXXXXXX")"
PHASE=build
cleanup() {
  local code=$?
  trap - EXIT
  # Remove only our own known temporary output. No data/volume/image pruning.
  rm -f "$TMP/image-id"
  rmdir "$TMP" || true
  if [[ "$code" != 0 ]]; then
    say "部署失败，阶段=$PHASE；未删除数据或自动回滚。请查看 status / logs 后重试 deploy。" >&2
    if [[ "$PHASE" == drain || "$PHASE" == migration || "$PHASE" == rollout ]]; then
      say 'Worker 可能已停止；不要绕过中心重发未知真机任务。' >&2
    fi
  fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
say '1/6 构建 mx-device（构建失败不会停止现有服务）'
(
  # Predefined build proxy args are not Dockerfile ENV and never enter service config.
  export HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" http_proxy="$proxy" https_proxy="$proxy"
  export NO_PROXY=localhost,127.0.0.1,::1 no_proxy=localhost,127.0.0.1,::1
  export ALL_PROXY= all_proxy=
  network=default
  if [[ -n "$proxy" ]]; then network=host; say '启用仅构建期代理，使用本机 host 构建网络'; fi
  docker buildx build --builder default --load --network "$network" \
    --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg http_proxy --build-arg https_proxy \
    --build-arg NO_PROXY --build-arg no_proxy --build-arg ALL_PROXY --build-arg all_proxy \
    --iidfile "$TMP/image-id" --tag mx-device:experimental "$ROOT"
)
PHASE=configuration
say '2/6 初始化或校验本中心配置（保留原密码与凭证）'
bootstrap mx-device:experimental
compose config --quiet
PHASE=database
say '3/6 准备独立 PostgreSQL；已有容器不重建、数据卷保留'
compose up -d --no-recreate --wait --wait-timeout 120 postgres
PHASE=drain
say '4/6 等待本中心 Worker 收尾（最多 140 秒）；不停止手机/mobile-agent'
compose stop --timeout 140 worker
worker_id="$(compose ps --all --quiet worker)"
if [[ -n "$worker_id" ]]; then
  worker_exit="$(docker inspect --format '{{.State.ExitCode}}' "$worker_id")"
  [[ "$worker_exit" == 0 ]] || die '旧 Worker 非正常退出；需先核查在途任务，未继续发布'
fi
PHASE=migration
say '5/6 执行版本化数据库迁移（失败不启动新版服务）'
compose run --rm --no-deps -T migrate
PHASE=rollout
say '6/6 更新 API / Worker，等待 API 就绪与本次 Worker 心跳'
# Deliberately exclude Postgres from recreation and never use down/-v/restart Docker.
compose up -d --no-build --no-deps --force-recreate --wait --wait-timeout 120 api worker
PHASE=complete
compose ps
say '部署完成：http://127.0.0.1:18891；凭证：bash scripts/manage.sh token'
say '重复 deploy 保留数据与配置。此次为单机更新，有短暂不可用窗口，不是零停机滚动发布。'
