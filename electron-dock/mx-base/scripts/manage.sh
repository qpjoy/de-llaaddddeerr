#!/usr/bin/env bash
# Explicit application dispatch. Never implicitly deploy/stop every base app.
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATIC_DIR="$ROOT_DIR/mx-static"
say() { printf '[mx-base] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }
load_env() {
  local file
  for file in "$ROOT_DIR/.env.internal" "$STATIC_DIR/.env"; do
    if [ -f "$file" ]; then set -a; source "$file"; set +a; fi
  done
}
compose() { docker compose --project-directory "$STATIC_DIR" -f "$STATIC_DIR/compose.yml" "$@"; }
usage() {
  cat <<'HELP'
mx-base — 独立基础设施应用管理（在目标 Internal 主机执行）
  bash scripts/manage.sh                  # 交互式应用/操作选择（非终端显示帮助）
  bash scripts/manage.sh status           # 所有应用的实际状态和当前上下文
  bash scripts/manage.sh deploy           # 交互选择一个应用；不会默认全量部署
  bash scripts/manage.sh deploy mx-static # 准备目录/密钥，构建并等待健康
  bash scripts/manage.sh deploy jenkins   # 显式启用可选构建基础设施
  bash scripts/manage.sh <操作> <应用>

应用：mx-static (Docker Compose)、jenkins (Kubernetes mx-base namespace)
通用操作：status / deploy / start / stop / restart / logs / doctor
mx-static：init / jobs / storage / attach / detach（项目任务计数；失败任务通过 API 查询/重试）
jenkins：password / agent-cmd
stop/down 保留数据、队列、凭据；没有一键删除数据或全停命令。

配置：mx-base/.env.internal；mx-static 的存储/Compose 配置可放 mx-static/.env。
检查输出中的 Docker/Kubernetes context。本机状态不等于生产状态；不可访问显示 UNKNOWN。
HELP
}
choose_app() {
  [ -t 0 ] || die '非交互调用必须指定应用：deploy mx-static 或 deploy jenkins'
  printf '\n1) mx-static — 多媒体存储/缓存\n2) jenkins — 可选构建服务\n0) 取消\n' >&2
  local answer
  read -r -p '选择应用: ' answer
  case "$answer" in 1) APP=mx-static;; 2) APP=jenkins;; 0|'') exit 0;; *) die '无效选择';; esac
}
contexts() {
  say "执行主机：$(hostname)"
  if command -v docker >/dev/null; then say "Docker context: $(docker context show 2>/dev/null || printf UNKNOWN)"; fi
  if command -v kubectl >/dev/null; then say "Kubernetes context: $(kubectl config current-context 2>/dev/null || printf UNKNOWN)"; fi
}
status_app() {
  local app="$1" output
  case "$app" in
    mx-static)
      say 'mx-static [Compose]'
      if ! command -v docker >/dev/null || ! docker info >/dev/null 2>&1; then say 'UNKNOWN：Docker 不可访问'; return; fi
      if ! output="$(compose ps --all 2>&1)"; then say "UNKNOWN：$output"; return; fi
      printf '%s\n' "$output"
      if [ -z "$(compose ps --all --quiet)" ]; then say 'NOT DEPLOYED：此 Docker context 无 mx-static 容器'; fi
      ;;
    jenkins)
      say 'jenkins [Kubernetes / mx-base]'
      if ! command -v kubectl >/dev/null; then say 'UNKNOWN：缺少 kubectl'; return; fi
      if ! output="$(kubectl --request-timeout=5s -n mx-base get deployment mx-base-jenkins --ignore-not-found -o wide 2>&1)"; then say "UNKNOWN：$output"; return; fi
      if [ -z "$output" ]; then say 'NOT DEPLOYED：当前集群无 Jenkins deployment'; else printf '%s\n' "$output"; fi
      ;;
  esac
}
nas_compose() { docker compose --project-directory "$STATIC_DIR" -f "$STATIC_DIR/compose.yml" -f "$STATIC_DIR/compose.nas.yml" --profile nas "$@"; }
storage_control() { compose exec -T writer node mx-base/mx-static/src/archive-control.mjs "$@"; }
attach_nas() {
  need timeout; need findmnt
  [ -n "${MX_STATIC_NAS_PATH:-}" ] && [ -n "${MX_STATIC_NAS_VOLUME_ID:-}" ] || die '请配置 NAS_PATH 与 NAS_VOLUME_ID，并在 NAS 创建同值 .mx-static-volume-id'
  local filesystem
  filesystem="$(timeout -k 1 5 findmnt -n -o FSTYPE -T "$MX_STATIC_NAS_PATH")" || die 'NAS 挂载查询失败/超时；主服务未操作'
  case "$filesystem" in nfs|nfs4) ;; *) die 'NAS_PATH 不是已挂载 NFS；拒绝写入空挂载目录';; esac
  storage_control attach "$MX_STATIC_NAS_VOLUME_ID"
  if ! timeout -k 1 30 docker compose --project-directory "$STATIC_DIR" -f "$STATIC_DIR/compose.yml" -f "$STATIC_DIR/compose.nas.yml" --profile nas up -d --no-deps --force-recreate archive; then
    storage_control detach
    die '归档容器接入失败/超时，已逻辑脱离；writer/reader 未重启'
  fi
  say 'NAS 组件已启动，storage 查看身份验证/补传状态；writer/reader 未重启'
}
detach_nas() {
  storage_control detach
  if [ -n "${MX_STATIC_NAS_PATH:-}" ] && [ -n "${MX_STATIC_NAS_VOLUME_ID:-}" ]; then
    need timeout
    if ! timeout -k 1 10 docker compose --project-directory "$STATIC_DIR" -f "$STATIC_DIR/compose.yml" -f "$STATIC_DIR/compose.nas.yml" --profile nas stop --timeout 2 archive; then
      say 'NAS 已逻辑脱离；归档容器停止超时，可能有内核 NFS 等待。不要反复创建替代进程；检查 NFS 恢复情况。'
    fi
  fi
}
init_static() {
  need openssl
  local data="${MX_STATIC_DATA_PATH:-/srv/mx-static/data}" state="${MX_STATIC_STATE_PATH:-/srv/mx-static/state}"
  local secret_dir="${MX_STATIC_SECRETS_PATH:-$STATIC_DIR/secrets}"
  [[ "$secret_dir" = /* ]] || secret_dir="$STATIC_DIR/$secret_dir"
  local uid="${MX_STATIC_UID:-1000}" gid="${MX_STATIC_GID:-1000}"
  [[ "$data" = /* && "$state" = /* && "$data" != / && "$state" != / && "$data" != "$state" ]] || die 'DATA_PATH / STATE_PATH 必须是两个不同的绝对专用目录'
  install -d -m 0750 "$data" "$state"
  install -d -m 0700 "$secret_dir"
  # Noclobber prevents accidental replacement/rotation on repeated deployment.
  if [ ! -f "$secret_dir/projects.json" ]; then
    (umask 077; set -o noclobber; printf '{"mx-insight-hub":{"read":"%s","write":"%s"}}\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$secret_dir/projects.json")
  fi
  if [ ! -f "$secret_dir/signing-key" ]; then
    (umask 077; set -o noclobber; openssl rand -hex 32 > "$secret_dir/signing-key")
  fi
  if [ "$(id -u)" = 0 ]; then chown "$uid:$gid" "$data" "$state" "$secret_dir/projects.json" "$secret_dir/signing-key"; fi
  chmod 0440 "$secret_dir/projects.json" "$secret_dir/signing-key"
  say "已准备 data=$data state=$state；保留现有凭据。容器 UID/GID=$uid:$gid"
}
static_jobs() {
  need docker
  compose exec -T writer node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const projects = JSON.parse(readFileSync(process.env.MX_STATIC_PROJECTS_FILE, "utf8"));
    for (const [project, keys] of Object.entries(projects)) {
      const r = await fetch(`http://127.0.0.1:18200/static/v1/projects/${project}/jobs`, {headers:{authorization:`Bearer ${keys.read}`}});
      if (!r.ok) throw new Error(`Queue status HTTP ${r.status}`);
      const data = await r.json(); console.log(JSON.stringify({project, counts:data.counts, cache:data.cache}));
    }
  '
}
run_app() {
  local action="$1" app="$2"
  case "$app" in mx-static|jenkins) ;; *) die "未知应用：$app";; esac
  case "$action" in status) status_app "$app"; return;; doctor) contexts; status_app "$app"; if [ "$app" = mx-static ]; then compose config --quiet; fi; return;; esac
  if [ "$app" = jenkins ]; then
    case "$action" in
      start) kubectl --request-timeout=10s -n mx-base scale deployment/mx-base-jenkins --replicas=1;;
      restart) kubectl --request-timeout=10s -n mx-base rollout restart deployment/mx-base-jenkins;;
      stop|down) bash "$ROOT_DIR/scripts/apps/jenkins.sh" down;;
      deploy|logs|password|agent-cmd) bash "$ROOT_DIR/scripts/apps/jenkins.sh" "$action";;
      *) die "jenkins 不支持 $action";;
    esac
    return
  fi
  need docker
  case "$action" in
    init) init_static;;
    deploy) init_static; compose config --quiet; compose up -d --build --wait --wait-timeout 120 writer reader; status_app mx-static;;
    start) compose start writer reader;;
    stop|down) detach_nas || true; compose stop --timeout 40 writer reader; say '已停止 mx-static，所有容器、数据与队列保留';;
    restart) compose restart --timeout 40 writer reader;;
    logs) compose logs --tail 200 --follow;;
    jobs) static_jobs;;
    storage) storage_control status;;
    attach) attach_nas;;
    detach) detach_nas;;
    *) die "mx-static 不支持 $action";;
  esac
}
load_env
ACTION="${1:-}"; APP="${2:-}"
case "$ACTION" in -h|--help|help) usage; exit 0;; esac
if [ -z "$ACTION" ]; then
  if [ ! -t 0 ]; then usage; exit 0; fi
  contexts; status_app mx-static; status_app jenkins; choose_app
  printf '\n1) status  2) deploy  3) start  4) stop  5) restart  6) logs  7) doctor  8) jobs  9) storage  10) attach NAS  11) detach NAS (mx-static)\n'
  read -r -p '选择操作（回车取消）: ' answer
  case "$answer" in 1) ACTION=status;; 2) ACTION=deploy;; 3) ACTION=start;; 4) ACTION=stop;; 5) ACTION=restart;; 6) ACTION=logs;; 7) ACTION=doctor;; 8) ACTION=jobs;; 9) ACTION=storage;; 10) ACTION=attach;; 11) ACTION=detach;; '') exit 0;; *) die '无效操作';; esac
fi
case "$ACTION" in status|list|apps)
  contexts
  if [ -n "$APP" ]; then run_app status "$APP"; else status_app mx-static; status_app jenkins; fi
  exit 0;;
esac
[ -n "$APP" ] || choose_app
run_app "$ACTION" "$APP"
