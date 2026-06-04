#!/usr/bin/env bash
# QPJoy marketplace — docker compose helper.
#
# All operations route through Docker Compose against
# electron-server/docker-compose.yml. Run without arguments for an
# interactive menu, or pass a subcommand directly:
#
#   scripts/manage.sh up
#   scripts/manage.sh redeploy
#   scripts/manage.sh deploy
#   scripts/manage.sh sync
#   scripts/manage.sh bootstrap-admin --username root --password 'change-me'
#
# Configuration via env vars (defaults shown in docker-compose.yml):
#   MARKET_PORT, HDO_SERVER_URL, HDO_GATEWAY_SERVER_URL, PG_PORT, PG_USER,
#   PG_PASSWORD, PG_DB, JWT_SECRET, NPM_SCOPE, NPM_PREFIX,
#   REQUIRE_VERIFICATION, LOG_LEVEL.

set -Eeuo pipefail

# ── Locate compose root ────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$ROOT/.." && pwd)"
MARKET_ROOT="$REPO_ROOT/electron-market"
ADMIN_UI_DIST="$ROOT/../electron-market/packages/admin-ui/dist"
SPA_TARGET="$ROOT/data/spa-dist"
ADMIN_UI_PKG="@qpjoy/electron-market-admin-ui"

cd "$ROOT"
DC=()

dotenv_value() {
  local key="$1" file="$ROOT/.env" line value
  [ -f "$file" ] || return 1
  line="$(
    awk -v key="$key" '
      $0 ~ "^[[:space:]]*" key "=" {
        sub(/^[[:space:]]*/, "", $0)
        print
      }
    ' "$file" | tail -n 1
  )"
  [ -n "$line" ] || return 1
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

dotenv_or_empty() {
  dotenv_value "$1" 2>/dev/null || true
}

MARKET_PORT="${MARKET_PORT:-$(dotenv_or_empty MARKET_PORT)}"
HDO_SERVER_URL="${HDO_SERVER_URL:-$(dotenv_or_empty HDO_SERVER_URL)}"
HDO_GATEWAY_SERVER_URL="${HDO_GATEWAY_SERVER_URL:-$(dotenv_or_empty HDO_GATEWAY_SERVER_URL)}"
HDO_GATEWAY_RUNNER_PORT="${HDO_GATEWAY_RUNNER_PORT:-$(dotenv_or_empty HDO_GATEWAY_RUNNER_PORT)}"
HDO_GATEWAY_RUNNER_HOST="${HDO_GATEWAY_RUNNER_HOST:-$(dotenv_or_empty HDO_GATEWAY_RUNNER_HOST)}"

export MARKET_PORT="${MARKET_PORT:-8080}"
export HDO_HOST_REPO_ROOT="${HDO_HOST_REPO_ROOT:-$REPO_ROOT}"
export HDO_GATEWAY_SCRIPT="${HDO_GATEWAY_SCRIPT:-$REPO_ROOT/docker/hdo-gateway-stack/manage.sh}"
export HDO_SERVER_URL="${HDO_SERVER_URL:-http://127.0.0.1:${MARKET_PORT}}"
export HDO_GATEWAY_SERVER_URL="${HDO_GATEWAY_SERVER_URL:-$HDO_SERVER_URL}"
export HDO_GATEWAY_RUNNER_PORT="${HDO_GATEWAY_RUNNER_PORT:-18081}"
export HDO_GATEWAY_RUNNER_HOST="${HDO_GATEWAY_RUNNER_HOST:-0.0.0.0}"
export HDO_GATEWAY_RUNNER_URL="${HDO_GATEWAY_RUNNER_URL:-http://host.docker.internal:${HDO_GATEWAY_RUNNER_PORT}}"
HDO_GATEWAY_RUNNER_SCRIPT="${HDO_GATEWAY_RUNNER_SCRIPT:-$REPO_ROOT/docker/hdo-gateway-stack/runner.mjs}"
HDO_GATEWAY_RUNNER_TOKEN_FILE="${HDO_GATEWAY_RUNNER_TOKEN_FILE:-$ROOT/data/hdo-gateway-runner.token}"
HDO_GATEWAY_RUNNER_PID_FILE="${HDO_GATEWAY_RUNNER_PID_FILE:-$ROOT/data/hdo-gateway-runner.pid}"
HDO_GATEWAY_RUNNER_LOG="${HDO_GATEWAY_RUNNER_LOG:-$ROOT/data/hdo-gateway-runner.log}"

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

normalize_hdo_gateway_runner_bind() {
  case "$HDO_GATEWAY_RUNNER_URL" in
    http://host.docker.internal|http://host.docker.internal:*|https://host.docker.internal|https://host.docker.internal:*)
      case "$HDO_GATEWAY_RUNNER_HOST" in
        127.*|localhost|::1)
          warn "HDO_GATEWAY_RUNNER_HOST=$HDO_GATEWAY_RUNNER_HOST is loopback-only; Docker cannot reach it via host.docker.internal. Using 0.0.0.0."
          export HDO_GATEWAY_RUNNER_HOST="0.0.0.0"
          ;;
      esac
      ;;
  esac
}

normalize_hdo_gateway_runner_bind

# ── Preconditions ──────────────────────────────────────────────────────
detect_docker_compose() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    DC=(docker compose -f "$ROOT/docker-compose.yml")
    return 0
  fi

  if command -v docker-compose >/dev/null 2>&1 && docker-compose version >/dev/null 2>&1; then
    DC=(docker-compose -f "$ROOT/docker-compose.yml")
    return 0
  fi

  return 1
}

check_docker() {
  detect_docker_compose && return
  die "Docker Compose is required. Install either the 'docker compose' plugin or the legacy 'docker-compose' command."
}

ensure_admin_ui_deps() {
  if [ ! -d "$MARKET_ROOT" ] || [ ! -f "$MARKET_ROOT/pnpm-workspace.yaml" ]; then
    warn "electron-market workspace not found at $MARKET_ROOT"
    return 1
  fi

  if [ ! -x "$MARKET_ROOT/packages/admin-ui/node_modules/.bin/vue-tsc" ] \
    || [ ! -x "$MARKET_ROOT/packages/admin-ui/node_modules/.bin/vite" ]; then
    say "installing electron-market dependencies"
    pnpm --dir "$MARKET_ROOT" install --frozen-lockfile=false
  fi
}

build_admin_ui() {
  command -v pnpm >/dev/null 2>&1 || {
    warn "pnpm not found; cannot build admin-ui."
    return 1
  }
  ensure_admin_ui_deps || return 1
  pnpm --dir "$MARKET_ROOT" --filter "$ADMIN_UI_PKG" build
}

ensure_spa() {
  # If admin-ui was built, copy its dist into data/spa-dist (we copy rather
  # than symlink so the Docker build context picks it up — symlinks across
  # the build boundary are unreliable). If not built, leave an empty dir so
  # the Dockerfile's COPY doesn't fail; the server logs a warning and
  # skips the /admin/* mount.
  if [ ! -f "$ADMIN_UI_DIST/index.html" ] && command -v pnpm >/dev/null 2>&1; then
    say "admin-ui dist missing; building electron-market admin-ui"
    build_admin_ui || warn "admin-ui build failed; server API will still deploy, but /admin/ will stay unavailable."
  fi

  if [ -d "$ADMIN_UI_DIST" ]; then
    say "syncing admin-ui dist → data/spa-dist"
    rm -rf "$SPA_TARGET"
    mkdir -p "$SPA_TARGET"
    cp -R "$ADMIN_UI_DIST/." "$SPA_TARGET/"
  else
    if [ ! -d "$SPA_TARGET" ]; then
      warn "admin-ui dist not built — creating empty placeholder."
      warn "Build it with: pnpm --dir ../electron-market --filter @qpjoy/electron-market-admin-ui build"
      mkdir -p "$SPA_TARGET"
    fi
  fi
}

ensure_hdo_gateway_runner_token() {
  mkdir -p "$ROOT/data"
  if [ ! -s "$HDO_GATEWAY_RUNNER_TOKEN_FILE" ]; then
    say "creating HDO host runner token"
    if command -v openssl >/dev/null 2>&1; then
      openssl rand -hex 32 >"$HDO_GATEWAY_RUNNER_TOKEN_FILE"
    elif command -v node >/dev/null 2>&1; then
      node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" >"$HDO_GATEWAY_RUNNER_TOKEN_FILE"
    else
      die "openssl or node is required to generate HDO gateway runner token"
    fi
    chmod 600 "$HDO_GATEWAY_RUNNER_TOKEN_FILE" 2>/dev/null || true
  fi
  export HDO_GATEWAY_RUNNER_TOKEN
  HDO_GATEWAY_RUNNER_TOKEN="$(tr -d '\r\n' <"$HDO_GATEWAY_RUNNER_TOKEN_FILE")"
}

hdo_gateway_runner_health_url() {
  local probe_host="$HDO_GATEWAY_RUNNER_HOST"
  [ "$probe_host" = "0.0.0.0" ] && probe_host="127.0.0.1"
  printf 'http://%s:%s/healthz' "$probe_host" "$HDO_GATEWAY_RUNNER_PORT"
}

hdo_gateway_runner_health_json() {
  [ -n "${HDO_GATEWAY_RUNNER_TOKEN:-}" ] || [ -s "$HDO_GATEWAY_RUNNER_TOKEN_FILE" ] || return 1
  if [ -z "${HDO_GATEWAY_RUNNER_TOKEN:-}" ]; then
    HDO_GATEWAY_RUNNER_TOKEN="$(tr -d '\r\n' <"$HDO_GATEWAY_RUNNER_TOKEN_FILE")"
    export HDO_GATEWAY_RUNNER_TOKEN
  fi
  command -v curl >/dev/null 2>&1 || return 1
  curl -fsS -H "Authorization: Bearer ${HDO_GATEWAY_RUNNER_TOKEN}" \
    "$(hdo_gateway_runner_health_url)" 2>/dev/null
}

hdo_gateway_runner_alive() {
  hdo_gateway_runner_health_json >/dev/null
}

hdo_gateway_runner_container_health_json() {
  detect_docker_compose || return 1
  "${DC[@]}" exec -T market node -e '
const url = process.env.HDO_GATEWAY_RUNNER_URL;
const token = process.env.HDO_GATEWAY_RUNNER_TOKEN;
if (!url || !token) {
  console.error("HDO_GATEWAY_RUNNER_URL/TOKEN is missing inside market container");
  process.exit(2);
}
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 1500);
try {
  const response = await fetch(new URL("/healthz", url), {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal
  });
  const text = await response.text();
  if (!response.ok) {
    console.error(text || `HTTP ${response.status}`);
    process.exit(1);
  }
  console.log(text);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
} finally {
  clearTimeout(timer);
}
'
}

hdo_gateway_runner_port_status() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp "sport = :${HDO_GATEWAY_RUNNER_PORT}" 2>/dev/null | sed '1d'
    return 0
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v port=":${HDO_GATEWAY_RUNNER_PORT}" '$4 ~ port "$"'
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${HDO_GATEWAY_RUNNER_PORT}" -sTCP:LISTEN 2>/dev/null
    return 0
  fi
  return 1
}

hdo_gateway_runner_matches_config() {
  local json
  json="$(hdo_gateway_runner_health_json 2>/dev/null || true)"
  [ -n "$json" ] || return 1
  case "$json" in
    *"\"host\":\"${HDO_GATEWAY_RUNNER_HOST}\""*"\"port\":${HDO_GATEWAY_RUNNER_PORT}"*) return 0 ;;
    *) return 1 ;;
  esac
}

launch_hdo_gateway_runner() {
  say "starting HDO host runner on $(hdo_gateway_runner_health_url)"
  mkdir -p "$(dirname "$HDO_GATEWAY_RUNNER_LOG")"
  nohup env \
    HDO_GATEWAY_RUNNER_HOST="$HDO_GATEWAY_RUNNER_HOST" \
    HDO_GATEWAY_RUNNER_PORT="$HDO_GATEWAY_RUNNER_PORT" \
    HDO_GATEWAY_RUNNER_TOKEN="$HDO_GATEWAY_RUNNER_TOKEN" \
    HDO_GATEWAY_SCRIPT="$HDO_GATEWAY_SCRIPT" \
    HDO_GATEWAY_CWD="$REPO_ROOT" \
    HDO_SERVER_URL="$HDO_SERVER_URL" \
    HDO_GATEWAY_SERVER_URL="$HDO_GATEWAY_SERVER_URL" \
    node "$HDO_GATEWAY_RUNNER_SCRIPT" >>"$HDO_GATEWAY_RUNNER_LOG" 2>&1 &
  printf '%s\n' "$!" >"$HDO_GATEWAY_RUNNER_PID_FILE"
  sleep 0.5
  hdo_gateway_runner_alive
}

start_hdo_gateway_runner() {
  [ -f "$HDO_GATEWAY_RUNNER_SCRIPT" ] || {
    warn "HDO host runner script not found: $HDO_GATEWAY_RUNNER_SCRIPT"
    return 0
  }
  [ -f "$HDO_GATEWAY_SCRIPT" ] || {
    warn "HDO gateway script not found: $HDO_GATEWAY_SCRIPT"
    return 0
  }
  command -v node >/dev/null 2>&1 || {
    warn "node is not available; HDO host runner will not start."
    return 0
  }

  ensure_hdo_gateway_runner_token
  if hdo_gateway_runner_alive; then
    if hdo_gateway_runner_matches_config; then
      ok "HDO host runner is listening on $(hdo_gateway_runner_health_url)"
      return 0
    fi
    warn "HDO host runner is using an old bind address; restarting it."
    stop_hdo_gateway_runner || true
  fi

  if [ -s "$HDO_GATEWAY_RUNNER_PID_FILE" ]; then
    local old_pid
    old_pid="$(cat "$HDO_GATEWAY_RUNNER_PID_FILE" 2>/dev/null || true)"
    if [ -n "$old_pid" ] && ! kill -0 "$old_pid" 2>/dev/null; then
      rm -f "$HDO_GATEWAY_RUNNER_PID_FILE"
    fi
  fi

  if [ "$(id -u)" != "0" ]; then
    warn "starting HDO host runner without root; WireGuard install/route repair may still require sudo/root."
  fi

  if launch_hdo_gateway_runner; then
    ok "HDO host runner started"
  else
    warn "HDO host runner did not become healthy; stopping stale runners and retrying once."
    stop_hdo_gateway_runner >/dev/null 2>&1 || true
    sleep 0.3
    if launch_hdo_gateway_runner; then
      ok "HDO host runner started"
      return 0
    fi
    warn "HDO host runner did not become healthy; check $HDO_GATEWAY_RUNNER_LOG"
    return 1
  fi
}

stop_hdo_gateway_runner() {
  local pid stopped=0
  pid="$(cat "$HDO_GATEWAY_RUNNER_PID_FILE" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    say "stopping HDO host runner pid $pid"
    kill "$pid" >/dev/null 2>&1 || true
    stopped=1
  fi
  if command -v pgrep >/dev/null 2>&1; then
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      if kill -0 "$pid" 2>/dev/null; then
        say "stopping stale HDO host runner pid $pid"
        kill "$pid" >/dev/null 2>&1 || true
        stopped=1
      fi
    done < <(pgrep -f "$HDO_GATEWAY_RUNNER_SCRIPT" 2>/dev/null || true)
  fi
  rm -f "$HDO_GATEWAY_RUNNER_PID_FILE"
  if [ "$stopped" -eq 1 ]; then
    ok "HDO host runner stopped"
  else
    warn "HDO host runner was not running."
  fi
}

restart_hdo_gateway_runner() {
  stop_hdo_gateway_runner || true
  start_hdo_gateway_runner "$@"
}

cmd_gateway_runner_status() {
  if [ -s "$HDO_GATEWAY_RUNNER_TOKEN_FILE" ]; then
    HDO_GATEWAY_RUNNER_TOKEN="$(tr -d '\r\n' <"$HDO_GATEWAY_RUNNER_TOKEN_FILE")"
    export HDO_GATEWAY_RUNNER_TOKEN
  fi
  normalize_hdo_gateway_runner_bind
  echo "runner url from container: $HDO_GATEWAY_RUNNER_URL"
  echo "runner bind address:       $HDO_GATEWAY_RUNNER_HOST:$HDO_GATEWAY_RUNNER_PORT"
  echo "runner health url:        $(hdo_gateway_runner_health_url)"
  echo "runner pid file:          $HDO_GATEWAY_RUNNER_PID_FILE"
  echo "runner log:               $HDO_GATEWAY_RUNNER_LOG"

  if [ ! -s "$HDO_GATEWAY_RUNNER_TOKEN_FILE" ]; then
    warn "HDO host runner token is missing. Start it with: $0 gateway-runner-start"
  fi

  if [ -s "$HDO_GATEWAY_RUNNER_PID_FILE" ]; then
    local pid
    pid="$(cat "$HDO_GATEWAY_RUNNER_PID_FILE" 2>/dev/null || true)"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      ok "HDO host runner pid $pid exists"
    else
      warn "HDO host runner pid file is stale: ${pid:-empty}"
    fi
  else
    warn "HDO host runner pid file is missing."
  fi

  local listeners
  listeners="$(hdo_gateway_runner_port_status 2>/dev/null || true)"
  if [ -n "$listeners" ]; then
    ok "port ${HDO_GATEWAY_RUNNER_PORT} has a listener"
    printf '%s\n' "$listeners"
  else
    warn "no process is listening on port ${HDO_GATEWAY_RUNNER_PORT}."
  fi

  if hdo_gateway_runner_alive; then
    ok "HDO host runner is healthy"
    hdo_gateway_runner_health_json || true
    echo
  else
    warn "HDO host runner is not reachable."
  fi

  if json="$(hdo_gateway_runner_container_health_json 2>&1)"; then
    ok "HDO host runner is reachable from the market container"
    printf '%s\n' "$json"
  else
    warn "HDO host runner is not reachable from the market container."
    [ -n "$json" ] && printf '%s\n' "$json" >&2
    warn "Do not open this port in the cloud security group; bind the runner to 0.0.0.0 or the Docker bridge and keep port 18081 private to the host."
  fi

  if ! hdo_gateway_runner_alive && [ -f "$HDO_GATEWAY_RUNNER_LOG" ]; then
    say "recent HDO host runner log"
    tail -n 40 "$HDO_GATEWAY_RUNNER_LOG" 2>/dev/null || true
  fi
}

# ── Commands ───────────────────────────────────────────────────────────

cmd_up() {
  check_docker
  ensure_spa
  start_hdo_gateway_runner
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
  echo
  cmd_gateway_runner_status
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
  start_hdo_gateway_runner
  say "rebuilding + restarting market (postgres untouched)"
  "${DC[@]}" build market
  # docker-compose v1.29.x can crash with KeyError: 'ContainerConfig' while
  # recreating a container in-place. Removing the service container first keeps
  # named volumes intact and forces a clean create path on both v1 and v2.
  say "removing old market container (volumes preserved)"
  "${DC[@]}" rm -f -s market >/dev/null 2>&1 || true
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
  if ! "${DC[@]}" exec market node dist/src/jobs/sync-npm.js; then
    warn "sync failed. If you get 'no such file', the image needs rebuilding: $0 redeploy"
    return 1
  fi
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

psql_market() {
  check_docker
  "${DC[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U "${PG_USER:-qpjoy}" -d "${PG_DB:-qpjoy_market}" "$@"
}

cmd_hdo_device_conflicts() {
  say "checking duplicate HDO overlay IPs"
  psql_market <<'SQL'
SELECT
  overlay_ip,
  count(*) AS count,
  array_agg(id ORDER BY updated_at DESC) AS devices
FROM hdo_devices
WHERE overlay_ip IS NOT NULL
GROUP BY overlay_ip
HAVING count(*) > 1
ORDER BY overlay_ip;
SQL
}

cmd_hdo_reset_devices() {
  local keep_ip="${HDO_KEEP_INTERNAL_IP:-100.89.0.12}" assume_yes=0 sync_domestic=1 confirm
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --keep-ip|--keep-overlay-ip)
        keep_ip="${2:-}"
        [ -n "$keep_ip" ] || die "$1 requires an IP"
        shift 2
        ;;
      --yes|-y)
        assume_yes=1
        shift
        ;;
      --no-sync-domestic)
        sync_domestic=0
        shift
        ;;
      -h|--help)
        cat <<EOF
Usage:
  $0 hdo-reset-devices [--keep-ip 100.89.0.12] [--yes] [--no-sync-domestic]

Deletes every HDO device except the device using --keep-ip, then bumps
hdo_control_state.generation so manifests refresh. Server configuration tables
such as hdo_nodes, hdo_services, hdo_profiles, mesh memberships, and users are
left untouched. By default it also runs HDO domestic peer sync/repair so live
hdo-home peers stop carrying stale /32 entries.

Related:
  $0 hdo-device-conflicts
EOF
        return 0
        ;;
      *) die "unknown hdo-reset-devices option: $1" ;;
    esac
  done

  [[ "$keep_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "invalid --keep-ip: $keep_ip"
  warn "this will delete HDO devices except overlay_ip=$keep_ip."
  warn "subscription artifacts, device mesh states, plugin states and device tasks will be cascade-deleted."
  warn "hdo_nodes, hdo_services, hdo_profiles, mesh memberships and users are preserved."

  say "current rows for keep IP"
  psql_market -v keep_ip="$keep_ip" <<'SQL'
SELECT id, label, platform, public_key, overlay_ip, status, updated_at
FROM hdo_devices
WHERE overlay_ip = :'keep_ip'::inet
ORDER BY updated_at DESC;
SQL

  say "reset preview"
  psql_market -v keep_ip="$keep_ip" <<'SQL'
SELECT count(*) AS devices_to_delete
FROM hdo_devices
WHERE overlay_ip IS DISTINCT FROM :'keep_ip'::inet;

SELECT overlay_ip, count(*) AS duplicate_count, array_agg(id ORDER BY updated_at DESC) AS devices
FROM hdo_devices
WHERE overlay_ip IS NOT NULL
GROUP BY overlay_ip
HAVING count(*) > 1
ORDER BY overlay_ip;
SQL

  if [ "$assume_yes" -ne 1 ]; then
    read -r -p "Type 'HDO-RESET-DEVICES' to confirm: " confirm
    [ "$confirm" = "HDO-RESET-DEVICES" ] || die "aborted"
  fi

  say "deleting HDO devices except $keep_ip and bumping generation"
  psql_market -v keep_ip="$keep_ip" <<'SQL'
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM hdo_devices WHERE overlay_ip = :'keep_ip'::inet)
  THEN 'true'
  ELSE 'false'
END AS keep_exists
\gset

\if :keep_exists
\else
\echo No hdo_devices row found for keep IP :keep_ip
\quit 1
\endif

BEGIN;

WITH deleted AS (
  DELETE FROM hdo_devices
  WHERE overlay_ip IS DISTINCT FROM :'keep_ip'::inet
  RETURNING id
)
SELECT count(*) AS deleted_devices FROM deleted;

UPDATE hdo_control_state
SET generation = generation + 1,
    updated_at = now()
WHERE id = 1
RETURNING generation, updated_at;

COMMIT;
SQL
  ok "HDO devices reset."
  if [ "$sync_domestic" -eq 1 ]; then
    if [ -f "$HDO_GATEWAY_SCRIPT" ]; then
      ensure_hdo_gateway_runner_token
      say "syncing Domestic hdo-home peers after reset"
      if bash "$HDO_GATEWAY_SCRIPT" sync-and-repair-domestic --server-url "$HDO_GATEWAY_SERVER_URL"; then
        ok "Domestic hdo-home peers synced."
      else
        warn "Domestic sync failed. Run manually after fixing HDO runner/token:"
        warn "  HDO_GATEWAY_RUNNER_TOKEN=<token> $HDO_GATEWAY_SCRIPT sync-and-repair-domestic --server-url '$HDO_GATEWAY_SERVER_URL'"
      fi
    else
      warn "HDO gateway script not found, skipped Domestic peer sync: $HDO_GATEWAY_SCRIPT"
    fi
  fi
  ok "Refresh/re-enroll Internal and clients to rebuild clean peers."
}

cmd_shell() {
  check_docker
  local svc="${1:-market}"
  "${DC[@]}" exec "$svc" sh
}

run_hdo_manage() {
  local hdo_script="$REPO_ROOT/docker/hdo-gateway-stack/manage.sh"
  [ -f "$hdo_script" ] || die "HDO manage script not found: $hdo_script"
  "$hdo_script" "$@"
}

cmd_deploy() {
  local sub="${1:-}"
  if [ -n "$sub" ]; then
    shift || true
    case "$sub" in
      server|market|electron-server)
        cmd_redeploy "$@"
        ;;
      hdo|domestic|hdo-domestic)
        run_hdo_manage deploy-domestic "$@"
        ;;
      hdo-home|home-peer)
        run_hdo_manage add-home "$@"
        ;;
      hdo-wg|wireguard|wg)
        run_hdo_manage menu
        ;;
      *)
        die "unknown deploy target: $sub"
        ;;
    esac
    return
  fi

  local options=(
    "server     部署/重启 electron-server"
    "hdo        部署 HDO domestic + WireGuard"
    "hdo-home   生成 Home WireGuard peer"
    "hdo-wg     进入 HDO WireGuard 菜单"
    "status     查看服务状态"
    "quit       返回"
  )
  echo "${C_BLUE}QPJoy Deploy Manager${C_RESET}"
  echo
  PS3=$'\n选择部署项 > '
  select opt in "${options[@]}"; do
    [ -z "$opt" ] && continue
    local cmd="${opt%% *}"
    case "$cmd" in
      server)   cmd_redeploy ;;
      hdo)      run_hdo_manage deploy-domestic ;;
      hdo-home) run_hdo_manage add-home ;;
      hdo-wg)   run_hdo_manage menu ;;
      status)   cmd_status ;;
      quit|exit) break ;;
      *)        warn "unknown option" ;;
    esac
    echo
  done
}

cmd_nuke() {
  check_docker
  local assume_yes=0 include_hdo=1 include_host_wg=0 include_stacks=0 wipe_env=0 make_backup=1 confirm

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes|-y) assume_yes=1; shift ;;
      --all) include_hdo=1; include_host_wg=1; include_stacks=1; shift ;;
      --server-only|--no-hdo) include_hdo=0; include_host_wg=0; include_stacks=0; shift ;;
      --hdo|--include-hdo) include_hdo=1; shift ;;
      --host-wg|--include-host-wg) include_hdo=1; include_host_wg=1; shift ;;
      --stacks|--include-stacks) include_hdo=1; include_stacks=1; shift ;;
      --wipe-env) wipe_env=1; shift ;;
      --no-backup) make_backup=0; shift ;;
      -h|--help)
        cat <<EOF
Usage:
  $0 nuke [--yes] [--all] [--server-only] [--wipe-env] [--no-backup]

By default this wipes electron-server Docker volumes, local data, and generated
HDO gateway state under docker/hdo-gateway-stack. It does not remove the live
host WireGuard interface unless --all or --host-wg is passed.

Options:
  --all            also remove host wg-quick@hdo-home and side stack data
  --server-only    only wipe electron-server compose volumes and ./data
  --host-wg        remove live hdo-home WireGuard config/routes/rules
  --stacks         wipe domestic/oversea Docker gateway side stacks
  --wipe-env       remove electron-server/.env as well
  --yes            skip confirmation
  --no-backup      do not create a tar.gz backup before wiping local state
EOF
        return 0
        ;;
      *) die "unknown nuke option: $1" ;;
    esac
  done

  warn "this will delete electron-server postgres/market volumes and local ./data."
  if [ "$include_hdo" -eq 1 ]; then
    warn "this will also wipe generated HDO gateway state under docker/hdo-gateway-stack."
  fi
  if [ "$include_host_wg" -eq 1 ]; then
    warn "this will also disable/remove live wg-quick@hdo-home, host routes and HDO forwarding rules."
  fi
  if [ "$include_stacks" -eq 1 ]; then
    warn "this will also destroy generated domestic/oversea side stack state."
  fi
  if [ "$wipe_env" -eq 1 ]; then
    warn "this will remove electron-server/.env."
  fi
  if [ "$assume_yes" -ne 1 ]; then
    read -r -p "Type 'SERVER-NUKE' to confirm: " confirm
    [ "$confirm" = "SERVER-NUKE" ] || die "aborted"
  fi

  if [ "$make_backup" -eq 1 ]; then
    local backup_dir backup_file stamp
    backup_dir="$ROOT/backups"
    stamp="$(date '+%Y%m%d-%H%M%S')"
    backup_file="$backup_dir/electron-server-$stamp.tar.gz"
    mkdir -p "$backup_dir"
    tar -czf "$backup_file" \
      -C "$ROOT" \
      --ignore-failed-read \
      .env \
      data >/dev/null 2>&1 || true
    ok "backup created: $backup_file"
  fi

  stop_hdo_gateway_runner >/dev/null 2>&1 || true
  if command -v pgrep >/dev/null 2>&1; then
    while IFS= read -r pid; do
      [ -n "$pid" ] || continue
      kill "$pid" >/dev/null 2>&1 || true
    done < <(pgrep -f "$HDO_GATEWAY_RUNNER_SCRIPT" 2>/dev/null || true)
  fi

  say "stopping compose stack and removing named volumes"
  "${DC[@]}" down -v --remove-orphans
  docker rm -f qpjoy-market qpjoy-postgres >/dev/null 2>&1 || true
  docker volume rm qpjoy_pgdata qpjoy_market_data >/dev/null 2>&1 || true

  rm -rf "$ROOT/data"
  mkdir -p "$ROOT/data"
  if [ "$wipe_env" -eq 1 ]; then
    rm -f "$ROOT/.env"
  fi

  if [ "$include_hdo" -eq 1 ]; then
    local hdo_args=(nuke --yes)
    [ "$include_host_wg" -eq 1 ] && hdo_args+=(--host-wg)
    [ "$include_stacks" -eq 1 ] && hdo_args+=(--stacks)
    [ "$make_backup" -eq 0 ] && hdo_args+=(--no-backup)
    if [ -f "$HDO_GATEWAY_SCRIPT" ]; then
      bash "$HDO_GATEWAY_SCRIPT" "${hdo_args[@]}"
    else
      warn "HDO gateway script not found, skipped: $HDO_GATEWAY_SCRIPT"
    fi
  fi

  ok "server wiped. Re-run \`$0 up\` for a clean start."
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
  deploy [target]             deploy menu; targets: server, hdo, hdo-home, hdo-wg
  migrate                     show current migration head
  sync                        run npm sync once inside the market container
  sync-status                 show recent sync history from audit_logs
  gateway-runner-start        start the host HDO gateway runner
  gateway-runner-status       show host HDO gateway runner health
  gateway-runner-stop         stop the host HDO gateway runner
  gateway-runner-restart      restart the host HDO gateway runner
  hdo-device-conflicts        show duplicated HDO overlay IPs
  hdo-reset-devices           delete all HDO devices except --keep-ip (default 100.89.0.12)
  bootstrap-admin             create the first admin user (prompts for username/password)
  psql                        open psql shell
  shell [service]             open a shell in a container
  nuke [--all]                delete server volumes/data and HDO generated state
  menu                        interactive menu (default when no args given)
  help                        show this message

Environment variables:
  MARKET_PORT (default 8080), HDO_SERVER_URL, HDO_GATEWAY_SERVER_URL,
  PG_PORT (5433), PG_USER (qpjoy), PG_PASSWORD (qpjoy),
  PG_DB (qpjoy_market), JWT_SECRET,
  NPM_SCOPE (@qpjoy), NPM_PREFIX (electron-), LOG_LEVEL (info)

Files:
  docker-compose.yml          stack definition
  Dockerfile                  market image
  data/spa-dist               admin SPA (symlinked from electron-market)
  data/hdo-gateway-runner.*   host runner token, pid and log

Nuke examples:
  $0 nuke                     clean electron-server and HDO generated state
  sudo $0 nuke --all --yes    full reset including host hdo-home and side stacks
  $0 nuke --server-only       only clean postgres/market volumes and server data
  $0 hdo-device-conflicts
  $0 hdo-reset-devices --keep-ip 100.89.0.12
EOF
}

# ── Interactive menu ───────────────────────────────────────────────────
cmd_menu() {
  local options=(
    "up         启动 postgres + market"
    "redeploy   重新构建并重启 market"
    "deploy     部署 server / HDO / WireGuard"
    "logs       查看 market 日志"
    "status     查看服务状态"
    "migrate    查看 migration 状态"
    "sync       立即同步 npm 插件"
    "gateway    查看 HDO 宿主机 runner"
    "gateway-restart 重启 HDO 宿主机 runner"
    "hdo-ip     查看 HDO IP 冲突"
    "hdo-reset  清 HDO 设备态（保留 Internal）"
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
      deploy)    cmd_deploy ;;
      logs)      cmd_logs ;;
      status)    cmd_status ;;
      migrate)   cmd_migrate ;;
      sync)      cmd_sync ;;
      gateway)   cmd_gateway_runner_status ;;
      gateway-restart) restart_hdo_gateway_runner ;;
      hdo-ip)    cmd_hdo_device_conflicts ;;
      hdo-reset) cmd_hdo_reset_devices ;;
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
  redeploy)         cmd_redeploy "$@" ;;
  deploy|deployment) cmd_deploy "$@" ;;
  migrate|migrations) cmd_migrate "$@" ;;
  sync|sync-npm)    cmd_sync "$@" ;;
  sync-status|sync-log) cmd_sync_status "$@" ;;
  gateway-runner-start|hdo-runner-start) start_hdo_gateway_runner "$@" ;;
  gateway-runner-status|hdo-runner-status) cmd_gateway_runner_status "$@" ;;
  gateway-runner-stop|hdo-runner-stop) stop_hdo_gateway_runner "$@" ;;
  gateway-runner-restart|hdo-runner-restart) restart_hdo_gateway_runner "$@" ;;
  hdo-device-conflicts|hdo-conflicts|hdo-ip-conflicts) cmd_hdo_device_conflicts "$@" ;;
  hdo-reset-devices|hdo-clean-devices|hdo-device-reset) cmd_hdo_reset_devices "$@" ;;
  bootstrap-admin|bootstrap|admin) cmd_bootstrap_admin "$@" ;;
  psql)             cmd_psql "$@" ;;
  shell|sh)         cmd_shell "$@" ;;
  nuke|wipe)        cmd_nuke "$@" ;;
  menu)             cmd_menu ;;
  help|-h|--help)   cmd_help ;;
  *) die "unknown command: $sub (try $0 help)" ;;
esac
