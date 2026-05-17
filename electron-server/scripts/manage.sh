#!/usr/bin/env bash
# QPJoy marketplace — docker compose helper.
#
# All operations route through Docker Compose against
# electron-server/docker-compose.yml. Run without arguments for an
# interactive menu, or pass a subcommand directly:
#
#   scripts/manage.sh up
#   scripts/manage.sh redeploy
#   scripts/manage.sh sync
#   scripts/manage.sh bootstrap-admin --username root --password 'change-me'
#
# Configuration via env vars (defaults shown in docker-compose.yml):
#   MARKET_PORT, PG_PORT, PG_USER, PG_PASSWORD, PG_DB, JWT_SECRET,
#   NPM_SCOPE, NPM_PREFIX, REQUIRE_VERIFICATION, LOG_LEVEL.

set -Eeuo pipefail

# ── Locate compose root ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ADMIN_UI_DIST="$ROOT/../electron-market/packages/admin-ui/dist"
SPA_TARGET="$ROOT/data/spa-dist"

cd "$ROOT"
DC=()

# ── Pretty printing ────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'
  C_BLUE=$'\033[1;34m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_RED=; C_GREEN=; C_YELLOW=; C_BLUE=; C_DIM=; C_RESET=
fi
say()  { printf '%s▸%s %s\n' "$C_BLUE" "$C_RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# ── Preconditions ──────────────────────────────────────────────────────
check_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DC=(docker compose -f "$ROOT/docker-compose.yml")
    return
  fi

  if command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
    DC=(docker-compose -f "$ROOT/docker-compose.yml")
    return
  fi

  die "Docker Compose is required. Install either the 'docker compose' plugin or the legacy 'docker-compose' command."
}

ensure_spa() {
  # If admin-ui was built, copy its dist into data/spa-dist (we copy rather
  # than symlink so the Docker build context picks it up — symlinks across
  # the build boundary are unreliable). If not built, leave an empty dir so
  # the Dockerfile's COPY doesn't fail; the server logs a warning and
  # skips the /admin/* mount.
  if [ -d "$ADMIN_UI_DIST" ]; then
    say "syncing admin-ui dist → data/spa-dist"
    rm -rf "$SPA_TARGET"
    mkdir -p "$SPA_TARGET"
    cp -R "$ADMIN_UI_DIST/." "$SPA_TARGET/"
  else
    if [ ! -d "$SPA_TARGET" ]; then
      warn "admin-ui dist not built — creating empty placeholder."
      warn "Build it with: (cd ../electron-market && pnpm --filter @qpjoy/electron-market-admin-ui build)"
      mkdir -p "$SPA_TARGET"
    fi
  fi
}

# ── Commands ───────────────────────────────────────────────────────────

cmd_up() {
  check_docker
  ensure_spa
  say "starting postgres + market"
  "${DC[@]}" up -d
  ok "stack is up. Try: $0 status"
}

cmd_down() {
  check_docker
  say "stopping stack (volumes preserved)"
  "${DC[@]}" down
  ok "stopped"
}

cmd_restart() {
  check_docker
  local svc="${1:-market}"
  say "restarting $svc"
  "${DC[@]}" restart "$svc"
  ok "restarted $svc"
}

cmd_status() {
  check_docker
  "${DC[@]}" ps
}

cmd_logs() {
  check_docker
  local svc="${1:-market}"
  "${DC[@]}" logs -f --tail=200 "$svc"
}

cmd_build() {
  check_docker
  ensure_spa
  say "building market image"
  "${DC[@]}" build market
  ok "image built (qpjoy/market-server:dev)"
}

cmd_redeploy() {
  check_docker
  ensure_spa
  say "rebuilding + restarting market (postgres untouched)"
  "${DC[@]}" build market
  "${DC[@]}" up -d market
  ok "redeployed. Tail logs with: $0 logs"
}

cmd_migrate() {
  check_docker
  say "migrations run automatically on server boot."
  say "current state:"
  "${DC[@]}" exec -T postgres psql -U "${PG_USER:-qpjoy}" -d "${PG_DB:-qpjoy_market}" -c \
    "SELECT version, name, applied_at FROM schema_migrations ORDER BY version;" || \
    warn "postgres not reachable — start it with: $0 up"
}

cmd_sync() {
  check_docker
  say "triggering an immediate sync inside the market container"
  # The Fastify process has its own scheduler — running the CLI in parallel
  # would race against it on the data files. Use the scheduler's own
  # runNow() via the internal admin API or, if no admin token is handy,
  # fall through to the CLI which is fine for one-offs.
  "${DC[@]}" exec market node dist/src/jobs/sync-npm.js \
    || warn "if you get 'no such file', the image needs rebuilding: $0 redeploy"
  ok "sync complete"
}

cmd_sync_status() {
  check_docker
  local port="${MARKET_PORT:-8080}"
  curl -sS "http://127.0.0.1:${port}/healthz" >/dev/null || die "market not reachable on :${port}"
  echo "scheduler status (anonymous read — admin-only POST not invoked):"
  echo "  the server logs '[scheduler] sync done: ...' lines on every run; see:"
  echo "  $0 logs market"
  echo
  say "recent sync audit entries:"
  "${DC[@]}" exec -T postgres psql -U "${PG_USER:-qpjoy}" -d "${PG_DB:-qpjoy_market}" -c \
    "SELECT created_at, action, target_id, meta FROM audit_logs WHERE action LIKE 'system.sync%' OR action LIKE 'admin.sync%' ORDER BY id DESC LIMIT 10;" \
    2>/dev/null || warn "postgres not reachable — start it with: $0 up"
}

cmd_bootstrap_admin() {
  check_docker
  local USERNAME="" PASSWORD="" EMAIL=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --username) USERNAME="$2"; shift 2 ;;
      --password) PASSWORD="$2"; shift 2 ;;
      --email)    EMAIL="$2"; shift 2 ;;
      *) die "unknown arg: $1" ;;
    esac
  done
  if [ -z "$USERNAME" ]; then read -rp "Admin username: " USERNAME; fi
  if [ -z "$PASSWORD" ]; then read -rsp "Admin password: " PASSWORD; echo; fi
  [ -n "$USERNAME" ] || die "username required"
  [ -n "$PASSWORD" ] || die "password required"
  say "creating admin user $USERNAME"
  local args=(--username "$USERNAME" --password "$PASSWORD")
  if [ -n "$EMAIL" ]; then args+=(--email "$EMAIL"); fi
  "${DC[@]}" exec market node dist/scripts/bootstrap-admin.js -- "${args[@]}"
  ok "admin user $USERNAME created"
}

cmd_psql() {
  check_docker
  say "opening psql shell (Ctrl+D to exit)"
  "${DC[@]}" exec postgres psql -U "${PG_USER:-qpjoy}" -d "${PG_DB:-qpjoy_market}"
}

cmd_shell() {
  check_docker
  local svc="${1:-market}"
  "${DC[@]}" exec "$svc" sh
}

cmd_nuke() {
  check_docker
  warn "this will delete the postgres volume AND market data volume."
  read -rp "Type 'YES' to confirm: " confirm
  [ "$confirm" = "YES" ] || die "aborted"
  "${DC[@]}" down -v
  ok "wiped. Re-run \`$0 up\` for a clean start."
}

cmd_help() {
  cat <<EOF
QPJoy marketplace manager

Usage:
  $0 <command> [args]

Commands:
  up                          start postgres + market (background)
  down                        stop everything (volumes kept)
  status                      compose ps
  logs [service]              tail logs (default: market)
  restart [service]           restart all or one (postgres|market)
  build                       (re)build the market image
  redeploy                    rebuild market image and restart only market
  migrate                     show current migration head
  sync                        run npm sync once inside the market container
  sync-status                 show recent sync history from audit_logs
  bootstrap-admin             create the first admin user (prompts for username/password)
  psql                        open psql shell
  shell [service]             open a shell in a container
  nuke                        delete all volumes (asks for confirmation)
  menu                        interactive menu (default when no args given)
  help                        show this message

Environment variables:
  MARKET_PORT (default 8080), PG_PORT (5433), PG_USER (qpjoy),
  PG_PASSWORD (qpjoy), PG_DB (qpjoy_market), JWT_SECRET,
  NPM_SCOPE (@qpjoy), NPM_PREFIX (electron-), LOG_LEVEL (info)

Files:
  docker-compose.yml          stack definition
  Dockerfile                  market image
  data/spa-dist               admin SPA (symlinked from electron-market)
EOF
}

# ── Interactive menu ───────────────────────────────────────────────────
cmd_menu() {
  local options=(
    "up         启动 postgres + market"
    "redeploy   重新构建并重启 market"
    "logs       查看 market 日志"
    "status     查看服务状态"
    "migrate    查看 migration 状态"
    "sync       立即同步 npm 插件"
    "bootstrap  创建首位 admin"
    "psql       打开 psql"
    "shell      进入 market 容器"
    "down       停止服务"
    "nuke       清空所有数据（危险）"
    "help       帮助"
    "quit       退出"
  )
  echo "${C_BLUE}QPJoy Marketplace Manager${C_RESET}"
  echo
  PS3=$'\n选择操作 > '
  select opt in "${options[@]}"; do
    [ -z "$opt" ] && continue
    local cmd="${opt%% *}"
    case "$cmd" in
      up)        cmd_up ;;
      redeploy)  cmd_redeploy ;;
      logs)      cmd_logs ;;
      status)    cmd_status ;;
      migrate)   cmd_migrate ;;
      sync)      cmd_sync ;;
      bootstrap) cmd_bootstrap_admin ;;
      psql)      cmd_psql ;;
      shell)     cmd_shell ;;
      down)      cmd_down ;;
      nuke)      cmd_nuke ;;
      help)      cmd_help ;;
      quit|exit) break ;;
      *)         warn "unknown option" ;;
    esac
    echo
  done
}

# ── Dispatch ───────────────────────────────────────────────────────────
sub="${1:-menu}"
shift || true
case "$sub" in
  up)               cmd_up "$@" ;;
  down)             cmd_down "$@" ;;
  restart)          cmd_restart "$@" ;;
  status|ps)        cmd_status "$@" ;;
  logs|log|tail)    cmd_logs "$@" ;;
  build)            cmd_build "$@" ;;
  redeploy|deploy)  cmd_redeploy "$@" ;;
  migrate|migrations) cmd_migrate "$@" ;;
  sync|sync-npm)    cmd_sync "$@" ;;
  sync-status|sync-log) cmd_sync_status "$@" ;;
  bootstrap-admin|bootstrap|admin) cmd_bootstrap_admin "$@" ;;
  psql)             cmd_psql "$@" ;;
  shell|sh)         cmd_shell "$@" ;;
  nuke|wipe)        cmd_nuke "$@" ;;
  menu)             cmd_menu ;;
  help|-h|--help)   cmd_help ;;
  *) die "unknown command: $sub (try $0 help)" ;;
esac
