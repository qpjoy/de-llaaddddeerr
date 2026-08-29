#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_DOCK_DIR="$(cd "${ROOT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/compose/docker-compose.yml"
SEARCH_COMPOSE_DIR="${ROOT_DIR}/deploy/compose/search"
SEARCH_COMPOSE_FILE="${SEARCH_COMPOSE_DIR}/docker-compose.yml"
K8S_DIR="${ROOT_DIR}/deploy/k8s/internal"
MX_COMMON_DIR="${ELECTRON_DOCK_DIR}/mx-common"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
# Retired local PostgreSQL. The Hub database now lives in the shared mx-common
# instance; these names exist only so `decommission-local-postgres` can find and
# remove what an earlier deploy left behind.
LEGACY_POSTGRES_PV_NAME="mx-insight-hub-postgres-local-pv"
LEGACY_POSTGRES_PVC_NAME="data-mx-insight-hub-postgres-0"
LEGACY_POSTGRES_HOST_PATH="/var/lib/mx-insight-hub/k8s/postgres"

DEPLOY_TMP_BASE=""
DEPLOY_TMP_DIR=""
DEPLOY_PORT_FORWARD_PID=""
DEPLOY_DOCKER_IMAGE=""
DEPLOY_DOCKER_IMAGE_ID=""
DEPLOY_PREVIOUS_DOCKER_IMAGE_ID=""
DEPLOY_PULLED_RUNTIME_IMAGE=""
DEPLOY_LOCK_DIR=""
DEPLOY_K8S_NODE_NAME=""

say() { printf '[mx-insight-hub] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

# Execute curl with one sensitive header without placing its value in process
# argv. The subshell owns a mode-0600 header file and always removes it when the
# request succeeds, fails, or is interrupted.
curl_with_protected_header() (
  local header_name="$1"
  local header_value="$2"
  shift 2
  case "${header_name}${header_value}" in
    *$'\r'*|*$'\n'*) return 64 ;;
  esac

  local header_file header_file_quoted
  umask 077
  header_file="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-curl-header.XXXXXX")" || return 1
  chmod 600 "$header_file" || {
    rm -f -- "$header_file"
    return 1
  }
  printf -v header_file_quoted '%q' "$header_file"
  # EXIT runs after function-local variables can be unwound by a signal, so
  # capture the non-secret path in the trap rather than dereferencing it later.
  trap "rm -f -- ${header_file_quoted}" EXIT
  trap 'exit 1' HUP INT TERM
  printf '%s: %s\n' "$header_name" "$header_value" >"$header_file"
  curl -H "@${header_file}" "$@"
)

API_KEY_ROTATION_WINDOW_DAYS=30

# Print: decision|key-id|reason|expires-at. The secret is used only to match the
# Admin API's safe prefix/last-four projection and is never written to output.
api_key_rotation_decision() {
  local key_list_json="$1"
  local secret="$2"
  local now_ms="${3:-}"
  MX_INSIGHT_KEY_SECRET="$secret" \
  MX_INSIGHT_KEY_NOW_MS="$now_ms" \
  MX_INSIGHT_KEY_ROTATION_DAYS="$API_KEY_ROTATION_WINDOW_DAYS" \
    node -e '
      let input = ""
      process.stdin.setEncoding("utf8")
      process.stdin.on("data", (chunk) => { input += chunk })
      process.stdin.on("end", () => {
        const payload = JSON.parse(input)
        const keys = Array.isArray(payload) ? payload : payload?.data
        if (!Array.isArray(keys)) throw new Error("Admin API key list is not an array")
        const secret = process.env.MX_INSIGHT_KEY_SECRET || ""
        const key = keys.find((candidate) => (
          candidate?.prefix
          && candidate?.lastFour
          && secret.startsWith(candidate.prefix)
          && secret.endsWith(candidate.lastFour)
        ))
        if (!key) {
          process.stdout.write("rotate||key_not_found|")
          return
        }
        const status = key.effectiveStatus || key.status
        if (key.status !== "active" || status !== "active") {
          process.stdout.write(`rotate|${key.id}|${status || "inactive"}|${key.expiresAt || ""}`)
          return
        }
        const expiresAtMs = Date.parse(key.expiresAt)
        if (!Number.isFinite(expiresAtMs)) {
          process.stdout.write(`rotate|${key.id}|missing_expiry|`)
          return
        }
        const configuredNow = Number(process.env.MX_INSIGHT_KEY_NOW_MS)
        const now = Number.isFinite(configuredNow) && process.env.MX_INSIGHT_KEY_NOW_MS
          ? configuredNow
          : Date.now()
        const windowMs = Number(process.env.MX_INSIGHT_KEY_ROTATION_DAYS) * 86_400_000
        if (expiresAtMs - now <= windowMs) {
          process.stdout.write(`rotate|${key.id}|rotation_window|${key.expiresAt}`)
          return
        }
        process.stdout.write(`reuse|${key.id}|valid|${key.expiresAt}`)
      })
    ' <<<"$key_list_json"
}

cleanup_deploy_runtime() {
  local status=$?
  local lock_owner=""
  trap - EXIT
  if [ -n "$DEPLOY_PORT_FORWARD_PID" ]; then
    kill "$DEPLOY_PORT_FORWARD_PID" >/dev/null 2>&1 || true
    wait "$DEPLOY_PORT_FORWARD_PID" 2>/dev/null || true
    DEPLOY_PORT_FORWARD_PID=""
  fi
  if [ -n "$DEPLOY_TMP_DIR" ]; then
    case "$DEPLOY_TMP_DIR" in
      "${DEPLOY_TMP_BASE}"/mx-insight-hub-deploy.*)
        rm -rf -- "$DEPLOY_TMP_DIR" || true
        ;;
      *)
        say "refuse to remove unexpected deploy temp path: $DEPLOY_TMP_DIR"
        ;;
    esac
    DEPLOY_TMP_DIR=""
  fi
  if command -v docker >/dev/null 2>&1; then
    if [ -n "$DEPLOY_DOCKER_IMAGE" ]; then
      docker image rm "$DEPLOY_DOCKER_IMAGE" >/dev/null 2>&1 || true
    fi
    if [ -n "$DEPLOY_PREVIOUS_DOCKER_IMAGE_ID" ] \
      && [ "$DEPLOY_PREVIOUS_DOCKER_IMAGE_ID" != "$DEPLOY_DOCKER_IMAGE_ID" ]; then
      docker image rm "$DEPLOY_PREVIOUS_DOCKER_IMAGE_ID" >/dev/null 2>&1 || true
    fi
    if [ -n "$DEPLOY_PULLED_RUNTIME_IMAGE" ]; then
      docker image rm "$DEPLOY_PULLED_RUNTIME_IMAGE" >/dev/null 2>&1 || true
    fi
  fi
  if [ -n "$DEPLOY_LOCK_DIR" ]; then
    if [ -r "${DEPLOY_LOCK_DIR}/pid" ]; then
      IFS= read -r lock_owner <"${DEPLOY_LOCK_DIR}/pid" || true
    fi
    case "$DEPLOY_LOCK_DIR" in
      "${RUNTIME_DIR}/internal-production-deploy.lock")
        if [ "$lock_owner" = "$$" ]; then
          rm -f -- "${DEPLOY_LOCK_DIR}/pid" || true
          rmdir -- "$DEPLOY_LOCK_DIR" 2>/dev/null || true
        fi
        ;;
      *)
        say "refuse to remove unexpected deploy lock path: $DEPLOY_LOCK_DIR"
        ;;
    esac
    DEPLOY_LOCK_DIR=""
  fi
  exit "$status"
}

init_deploy_runtime() {
  [ -z "$DEPLOY_TMP_DIR" ] || return 0
  DEPLOY_TMP_BASE="${TMPDIR:-/tmp}"
  DEPLOY_TMP_BASE="${DEPLOY_TMP_BASE%/}"
  DEPLOY_TMP_DIR="$(mktemp -d "${DEPLOY_TMP_BASE}/mx-insight-hub-deploy.XXXXXX")"
  trap cleanup_deploy_runtime EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

acquire_deploy_lock() {
  local lock="${RUNTIME_DIR}/internal-production-deploy.lock"
  local owner=""
  mkdir -p "$RUNTIME_DIR"
  if ! mkdir "$lock" 2>/dev/null; then
    if [ -r "${lock}/pid" ]; then
      IFS= read -r owner <"${lock}/pid" || true
    fi
    case "$owner" in
      ""|*[!0-9]*)
        die "deploy lock $lock is invalid; inspect it before retrying"
        ;;
      *)
        if kill -0 "$owner" 2>/dev/null; then
          die "another internal-production deployment is running (PID $owner)"
        fi
        ;;
    esac
    say "remove stale deploy lock left by PID $owner"
    rm -f -- "${lock}/pid"
    rmdir -- "$lock" 2>/dev/null \
      || die "could not remove stale deploy lock $lock"
    mkdir "$lock" 2>/dev/null \
      || die "another internal-production deployment acquired the lock"
  fi
  printf '%s\n' "$$" >"${lock}/pid" \
    || die "could not record deploy lock owner"
  DEPLOY_LOCK_DIR="$lock"
}

run_ctr() {
  if [ "$(id -u)" -eq 0 ]; then
    ctr -n k8s.io "$@"
  else
    need sudo
    sudo ctr -n k8s.io "$@"
  fi
}

require_single_k8s_node() {
  local nodes count
  nodes="$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')"
  count="$(printf '%s\n' "$nodes" | awk 'NF { count += 1 } END { print count + 0 }')"
  [ "$count" -eq 1 ] \
    || die "internal-production local images and hostPath storage require exactly one Kubernetes node; found $count"
  DEPLOY_K8S_NODE_NAME="$(printf '%s\n' "$nodes" | awk 'NF { print; exit }')"
  say "single-node Internal target: ${DEPLOY_K8S_NODE_NAME}"
}

usage() {
  cat <<'EOF'
MX Insight Hub lifecycle

Local Docker:
  bash scripts/manage.sh local up|rebuild|status|logs|smoke|data-smoke|bootstrap|down
  bash scripts/manage.sh up|rebuild|status|logs|smoke|down

Optional local search (independent from Hub startup):
  bash scripts/manage.sh search plan|up|status|logs|down

Internal Kubernetes:
  bash scripts/manage.sh deploy          # 全量幂等部署（= ops internal-production deploy）
  bash scripts/manage.sh verify          # 冒烟（= ops internal-production smoke）
  bash scripts/manage.sh reindex-search  # 用当前 HanLP/jieba 重建可再生搜索投影
  bash scripts/manage.sh verify-data-path [api-key]
                                         # 端到端：search -> PG -> outbox -> ES

  bash scripts/manage.sh ops internal-production plan|deploy|apply|status|smoke|logs|reindex-search|down
  bash scripts/manage.sh ops internal-production decommission-local-postgres

PostgreSQL, Elasticsearch and Redis live in the shared mx-common data plane;
`deploy` reconciles it first and provisions the Hub's own database inside it.

The production command loads .env.internal when present. Keep that file mode 0600.
`down` scales Hub workloads to zero and intentionally preserves PostgreSQL/PVC/Secrets.
EOF
}

load_env_file() {
  local file="$1"
  if [ -f "$file" ]; then
    # This is an operator-owned file, not untrusted input.
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$COMPOSE_FILE" "$@"
  else
    die "Docker Compose is unavailable"
  fi
}

search_compose() {
  (
    cd "$SEARCH_COMPOSE_DIR"
    if docker compose version >/dev/null 2>&1; then
      docker compose -f "$SEARCH_COMPOSE_FILE" "$@"
    elif command -v docker-compose >/dev/null 2>&1; then
      docker-compose -f "$SEARCH_COMPOSE_FILE" "$@"
    else
      die "Docker Compose is unavailable"
    fi
  )
}

wait_http() {
  local url="$1"
  local attempts="${2:-60}"
  local index
  for index in $(seq 1 "$attempts"); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  say "ERROR: Timed out waiting for ${url}" >&2
  return 1
}

local_action() {
  local action="${1:-}"
  load_env_file "${ROOT_DIR}/.env"
  mkdir -p "$RUNTIME_DIR"
  case "$action" in
    up|rebuild)
      need docker
      if [ "$action" = rebuild ]; then
        compose build --no-cache app
      fi
      compose up -d --build
      wait_http "http://127.0.0.1:18180/health/live"
      MX_INSIGHT_ADMIN_TOKEN="${MX_INSIGHT_ADMIN_TOKEN:-local-admin-change-me}" \
        node "${ROOT_DIR}/scripts/bootstrap.mjs"
      MX_INSIGHT_ADMIN_TOKEN="${MX_INSIGHT_ADMIN_TOKEN:-local-admin-change-me}" \
        node "${ROOT_DIR}/scripts/smoke.mjs"
      say "Local Admin: http://127.0.0.1:18180"
      ;;
    bootstrap)
      MX_INSIGHT_ADMIN_TOKEN="${MX_INSIGHT_ADMIN_TOKEN:-local-admin-change-me}" \
        node "${ROOT_DIR}/scripts/bootstrap.mjs"
      ;;
    status)
      compose ps
      ;;
    logs)
      compose logs --tail=250 app postgres
      ;;
    smoke)
      MX_INSIGHT_ADMIN_TOKEN="${MX_INSIGHT_ADMIN_TOKEN:-local-admin-change-me}" \
        node "${ROOT_DIR}/scripts/smoke.mjs"
      ;;
    data-smoke)
      MX_INSIGHT_ADMIN_TOKEN="${MX_INSIGHT_ADMIN_TOKEN:-local-admin-change-me}" \
      MX_SMOKE_DATA=1 \
        node "${ROOT_DIR}/scripts/smoke.mjs"
      ;;
    down)
      compose down
      say "Containers stopped; the PostgreSQL volume was preserved."
      ;;
    *) usage; exit 2 ;;
  esac
}

search_action() {
  local action="${1:-}"
  load_env_file "${SEARCH_COMPOSE_DIR}/.env"
  need docker
  case "$action" in
    plan)
      search_compose config
      ;;
    up)
      search_compose up -d
      search_compose ps
      say "Local Elasticsearch: http://127.0.0.1:${MX_INSIGHT_ELASTICSEARCH_PORT:-19200}"
      say "Local Kibana: http://127.0.0.1:${MX_INSIGHT_KIBANA_PORT:-15601}"
      ;;
    status)
      search_compose ps --all
      ;;
    logs)
      search_compose logs --tail=250 elasticsearch search-setup kibana
      ;;
    down)
      search_compose down
      say "Search containers stopped; Elasticsearch and snapshot volumes were preserved."
      ;;
    *) usage; exit 2 ;;
  esac
}

require_production_env() {
  load_env_file "${ROOT_DIR}/.env.internal"
  : "${MX_INSIGHT_ADMIN_TOKEN:?MX_INSIGHT_ADMIN_TOKEN is required in .env.internal or the environment}"
  : "${MX_INSIGHT_API_KEY_PEPPER:?MX_INSIGHT_API_KEY_PEPPER is required in .env.internal or the environment}"
  # MX_INSIGHT_POSTGRES_PASSWORD is optional: the database now lives in the
  # shared mx-common instance, which generates and stores the per-product
  # credential itself. Set it only to pin a specific password.
  # hostNetwork overlay: the API pods share the host netns, so the default reaches
  # host-local Night-All (127.0.0.1:13141) with no Night-All bind change required.
  NIGHT_ALL_BASE_URL="${NIGHT_ALL_BASE_URL:-http://127.0.0.1:13141}"
  # The Admin plane is now host-exposed; default the optional Launcher-integration
  # entrypoint to it (only consumed when MX_INSIGHT_SYNC_LAUNCHER=1).
  MX_INSIGHT_HUB_ADMIN_ENTRYPOINT="${MX_INSIGHT_HUB_ADMIN_ENTRYPOINT:-http://10.88.88.88:18151}"
  [ "${#MX_INSIGHT_ADMIN_TOKEN}" -ge 32 ] || die "MX_INSIGHT_ADMIN_TOKEN must be at least 32 characters"
  [ "${#MX_INSIGHT_API_KEY_PEPPER}" -ge 32 ] || die "MX_INSIGHT_API_KEY_PEPPER must be at least 32 characters"
  if [ -n "${MX_INSIGHT_POSTGRES_PASSWORD:-}" ]; then
    [ "${#MX_INSIGHT_POSTGRES_PASSWORD}" -ge 24 ] || die "MX_INSIGHT_POSTGRES_PASSWORD must be at least 24 characters"
  fi
  case "$MX_INSIGHT_ADMIN_TOKEN:$MX_INSIGHT_API_KEY_PEPPER:${MX_INSIGHT_POSTGRES_PASSWORD:-}" in
    *local-*-change-me*) die "Local example secrets cannot be used for internal-production" ;;
  esac
  case "$NIGHT_ALL_BASE_URL" in
    http://*|https://*) ;;
    *) die "NIGHT_ALL_BASE_URL must be an http(s) URL" ;;
  esac
  if [ -n "${NIGHT_ALL_SERVICE_TOKEN:-}" ] && [ "${#NIGHT_ALL_SERVICE_TOKEN}" -lt 32 ]; then
    die "NIGHT_ALL_SERVICE_TOKEN must be empty or at least 32 characters"
  fi
  # mx-common builds the DSN, so the password must survive URL userinfo and a
  # single-quoted SQL literal without escaping.
  case "${MX_INSIGHT_POSTGRES_PASSWORD:-x}" in
    *[!A-Za-z0-9]*) die "MX_INSIGHT_POSTGRES_PASSWORD must be alphanumeric (A-Z a-z 0-9)" ;;
  esac
}

render_file() {
  local file="$1"
  local image="${MX_INSIGHT_IMAGE:-mx-insight-hub:shadow}"
  case "$image" in
    *[!A-Za-z0-9./:_@-]*) die "MX_INSIGHT_IMAGE contains unsupported characters" ;;
  esac
  sed "s#mx-insight-hub:shadow#${image}#g" "$file"
}

encoded_secret_value() {
  printf '%s' "$1" | base64 | tr -d '\r\n'
}

# Snapshot the effective Docker daemon proxy without sourcing its systemd
# drop-ins or mutating/restarting the daemon. Agent workloads consume this
# namespaced value explicitly; generic HTTP_PROXY variables would also reroute
# Night-All, Elasticsearch and other unrelated Hub traffic.
docker_daemon_proxy_snapshot() {
  local docker_info='{}'
  local source_locations=''

  if command -v docker >/dev/null 2>&1; then
    docker_info="$(docker info --format '{{json .}}' 2>/dev/null)" || docker_info='{}'
  fi
  if command -v systemctl >/dev/null 2>&1; then
    source_locations="$(
      systemctl show docker.service --property=DropInPaths --value --no-pager 2>/dev/null
    )" || source_locations=''
  fi

  MX_INSIGHT_DOCKER_INFO_JSON="$docker_info" \
  MX_INSIGHT_DOCKER_PROXY_SOURCE_LOCATIONS="$source_locations" \
  MX_INSIGHT_DOCKER_PROXY_NODE_NAME="$DEPLOY_K8S_NODE_NAME" \
    node --input-type=module -e '
      let info = {}
      try {
        const candidate = JSON.parse(process.env.MX_INSIGHT_DOCKER_INFO_JSON || "{}")
        if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) info = candidate
      } catch {}
      const value = (...keys) => {
        for (const key of keys) {
          if (typeof info[key] === "string" && info[key].trim()) return info[key].trim()
        }
        return null
      }
      const httpProxy = value("HTTPProxy", "HttpProxy", "httpProxy")
      const httpsProxy = value("HTTPSProxy", "HttpsProxy", "httpsProxy")
      const noProxy = value("NoProxy", "NOProxy", "noProxy")
      const sourceLocations = (process.env.MX_INSIGHT_DOCKER_PROXY_SOURCE_LOCATIONS || "")
        .split(/\s+/)
        .map((entry) => entry.replace(/^["\x27]+|["\x27]+$/g, ""))
        .filter(Boolean)
      process.stdout.write(JSON.stringify({
        version: 1,
        configured: Boolean(httpProxy || httpsProxy),
        sourceKind: "docker-daemon-effective",
        runtimeKind: "kubernetes-host-network",
        httpProxy,
        httpsProxy,
        noProxy,
        sourceLocations,
        nodeName: process.env.MX_INSIGHT_DOCKER_PROXY_NODE_NAME || null,
        observedAt: new Date().toISOString(),
      }))
    '
}

require_existing_secret_match() {
  local namespace="$1"
  local key="$2"
  local desired="$3"
  local mismatch_message="$4"
  local existing desired_encoded
  existing="$(
    kubectl -n "$namespace" get secret mx-insight-hub-secrets \
      -o "jsonpath={.data['${key}']}"
  )"
  desired_encoded="$(encoded_secret_value "$desired")"
  [ -n "$existing" ] \
    || die "existing mx-insight-hub-secrets is missing required key $key"
  [ "$existing" = "$desired_encoded" ] || die "$mismatch_message"
}

validate_existing_runtime_secret() {
  local namespace="mx-insight-hub"
  local secret_name
  secret_name="$(
    kubectl -n "$namespace" get secret mx-insight-hub-secrets \
      --ignore-not-found -o name
  )"
  if [ -z "$secret_name" ]; then
    return 0
  fi
  need base64
  # The database credential is no longer checked here: mx-common owns it, stores
  # it in its own Secret, and re-provisioning reuses the stored value. What still
  # must not drift is the API-key pepper, because rotating it silently
  # invalidates every issued API key.
  require_existing_secret_match \
    "$namespace" \
    MX_INSIGHT_API_KEY_PEPPER \
    "$MX_INSIGHT_API_KEY_PEPPER" \
    "API-key pepper differs from the retained deployment; automatic rotation is blocked because existing API keys would stop validating. Restore the original .env.internal value or use an explicit key-rotation procedure."

}

# Locate the Launcher User Center in the cluster.
#
# The URL is discovered rather than configured because the parts an operator has
# to get exactly right by hand -- service name, namespace, port -- are all
# already recorded in the cluster, and getting any one of them wrong produces a
# Hub that silently accepts only the admin token. An explicit
# MX_INSIGHT_LAUNCHER_URL always wins, for clusters this heuristic cannot see.
discover_launcher_url() {
  if [ -n "${MX_INSIGHT_LAUNCHER_URL:-}" ]; then
    say "Launcher identity provider: ${MX_INSIGHT_LAUNCHER_URL} (explicitly configured)"
    return 0
  fi

  local found namespace name port
  # Match on the label rather than the name so a rename does not break this.
  found="$(kubectl get svc --all-namespaces \
    -l app.kubernetes.io/name=mx-launcher-internal \
    -o jsonpath='{range .items[0]}{.metadata.namespace}{" "}{.metadata.name}{" "}{.spec.ports[0].port}{end}' \
    2>/dev/null || true)"
  if [ -z "$found" ]; then
    say "no mx-launcher Service found in this cluster; Launcher sign-in stays disabled"
    say "  Only the admin token will work. Set MX_INSIGHT_LAUNCHER_URL to override."
    MX_INSIGHT_LAUNCHER_URL=""
    return 0
  fi

  read -r namespace name port <<EOF
$found
EOF
  MX_INSIGHT_LAUNCHER_URL="http://${name}.${namespace}.svc.cluster.local:${port}"
  say "discovered Launcher identity provider: ${MX_INSIGHT_LAUNCHER_URL}"

  # Reachability is verified now rather than at first sign-in. A wrong address
  # here surfaces as "your password is rejected" days later, at which point
  # nobody suspects a Service port.
  if kubectl -n "$namespace" get endpoints "$name" \
    -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null | grep -q .; then
    say "  endpoints are populated"
  else
    say "  WARNING: the Service has no ready endpoints; Launcher sign-in will return 503" >&2
  fi
}

# Use the in-cluster HanLP service only after its readiness probe has populated
# an Endpoint. An explicitly set URL (including an explicit empty value) is an
# operator decision and always wins over discovery.
discover_hanlp_url() {
  if [ "${MX_COMMON_HANLP_URL+x}" = x ]; then
    if [ -n "$MX_COMMON_HANLP_URL" ]; then
      say "HanLP tokenizer: ${MX_COMMON_HANLP_URL} (explicitly configured)"
      if [ -z "${MX_COMMON_SEGMENTER:-}" ]; then
        MX_COMMON_SEGMENTER="hanlp"
      fi
    else
      say "HanLP tokenizer auto-discovery explicitly disabled; using local jieba"
    fi
    export MX_COMMON_SEGMENTER
    export MX_COMMON_HANLP_URL
    return 0
  fi

  local ready_endpoint
  if ! ready_endpoint="$(
    kubectl -n mx-common get endpoints mx-common-hanlp \
      --ignore-not-found \
      -o jsonpath='{.subsets[*].addresses[*].ip}' 2>/dev/null
  )"; then
    die "could not inspect the HanLP Endpoint; refusing to change tokenizer configuration"
  fi
  if [ -n "$ready_endpoint" ]; then
    MX_COMMON_HANLP_URL="http://mx-common-hanlp.mx-common.svc.cluster.local:8000"
    say "discovered ready HanLP tokenizer: ${MX_COMMON_HANLP_URL}"
  else
    local previous
    if ! previous="$(
      kubectl -n mx-insight-hub get configmap mx-insight-hub-config \
        --ignore-not-found \
        -o jsonpath='{.data.MX_COMMON_HANLP_URL}' 2>/dev/null
    )"; then
      die "could not inspect the deployed HanLP configuration; refusing to change tokenizer configuration"
    fi
    if [ -n "$previous" ]; then
      say "ERROR: no ready HanLP Endpoint; the deployed Hub still requires ${previous}." >&2
      say "  The existing ConfigMap and workloads have not been replaced with jieba configuration." >&2
      say "  Restore HanLP before deploying:" >&2
      say "    kubectl -n mx-common rollout status deployment/mx-common-hanlp" >&2
      say "    kubectl -n mx-common describe pod -l app.kubernetes.io/name=mx-common-hanlp" >&2
      die "refusing to clear an existing HanLP URL while its Endpoint is temporarily unavailable"
    fi
    # With no retained configuration this is a first/unconfigured deployment.
    # An explicit empty MX_COMMON_HANLP_URL is handled above as an operator
    # decision; auto-discovery must never silently downgrade an existing Hub.
    MX_COMMON_HANLP_URL=""
    say "WARNING: no ready HanLP Endpoint and no retained HanLP URL; configuring local jieba." >&2
    say "         The nationwide province pipeline will remain activation-blocked until HanLP is configured." >&2
  fi
  if [ -n "${MX_COMMON_HANLP_URL:-}" ] && [ -z "${MX_COMMON_SEGMENTER:-}" ]; then
    MX_COMMON_SEGMENTER="hanlp"
  fi
  export MX_COMMON_SEGMENTER
  export MX_COMMON_HANLP_URL
}

# Probe from the production projector through HanLP Service DNS. The current
# single-node profile gives that worker hostNetwork so it can also reach a
# node-local LLM proxy; this smoke therefore verifies DNS and the HanLP handler,
# not namespaceSelector enforcement for ordinary pod-network traffic.
verify_hanlp_from_hub() {
  [ -n "${MX_COMMON_HANLP_URL:-}" ] || return 0
  if [ "${MX_INSIGHT_SEARCH_READY:-0}" != "1" ]; then
    say "HanLP cross-namespace smoke deferred because the projector is scaled down."
    return 0
  fi
  if ! kubectl -n mx-insight-hub exec deployment/mx-insight-hub-projector -- \
      node --input-type=module -e '
        let endpoint = "HanLP /tokenize"
        const fail = (message) => { throw new Error(message) }
        try {
          const base = (process.argv[1] || "").replace(/\/$/, "")
          if (!base) fail("HanLP base URL is empty")
          endpoint = `${base}/tokenize`
          const response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "吴恩达与人工智能", coarse: true }),
            signal: AbortSignal.timeout(10000),
          })
          const body = await response.text()
          if (!response.ok) {
            const compact = body.replace(/\s+/g, " ").trim()
            const truncated = compact.length > 2048
            const preview = compact.slice(0, 2048) || "<empty>"
            fail(`POST ${endpoint} returned HTTP ${response.status}; response body=${JSON.stringify(preview)}${truncated ? " [truncated]" : ""}`)
          }

          let payload
          try {
            payload = JSON.parse(body)
          } catch {
            fail(`POST ${endpoint} returned invalid JSON`)
          }
          const data = Array.isArray(payload) ? payload : payload?.tokens || payload?.data || []
          const flat = Array.isArray(data[0]) ? data.flat() : data
          const tokens = Array.isArray(flat)
            ? flat.filter((token) => typeof token === "string" && token.trim())
            : []
          if (!tokens.length) fail(`POST ${endpoint} response contains no non-empty token`)
        } catch (error) {
          console.error(`HanLP smoke failed: ${error instanceof Error ? error.message : String(error)}`)
          process.exitCode = 1
        }
      ' "$MX_COMMON_HANLP_URL"; then
    say "WARNING: HanLP /tokenize contract failed from the projector; strict index writers will not use local jieba fallback. Diagnose the configured backend before reindexing." >&2
    return 1
  fi
  say "HanLP tokenizer verified from the Hub namespace."
}

# Build the Secret holding model API keys, derived from the provider chains.
#
# The previous version wired a hardcoded OPENAI_API_KEY / DEEPSEEK_API_KEY /
# MX_INSIGHT_MODEL_API_KEY into the manifests. That silently breaks the moment
# anyone adds a provider with a different `apiKeyEnv` -- the key never reaches
# the pod, the chain skips that provider, and the only evidence is a log line.
# Reading the names out of the configuration means any provider works without
# touching YAML.
create_model_key_secret() {
  local namespace="mx-insight-hub"
  local names=""

  if command -v node >/dev/null 2>&1; then
    names="$(
      MX_INSIGHT_AGENT_PROVIDERS="${MX_INSIGHT_AGENT_PROVIDERS:-}" \
      MX_INSIGHT_EMBEDDING_PROVIDERS="${MX_INSIGHT_EMBEDDING_PROVIDERS:-}" \
      node -e '
        const names = new Set()
        for (const raw of [process.env.MX_INSIGHT_AGENT_PROVIDERS, process.env.MX_INSIGHT_EMBEDDING_PROVIDERS]) {
          if (!raw) continue
          try {
            for (const provider of JSON.parse(raw)) {
              if (provider?.apiKeyEnv) names.add(provider.apiKeyEnv)
            }
          } catch {
            // A malformed chain is reported by the server at startup with a far
            // better message than anything this script could produce.
          }
        }
        process.stdout.write([...names].join(" "))
      ' 2>/dev/null || true
    )"
  fi

  if [ -z "$names" ]; then
    kubectl -n "$namespace" delete secret mx-insight-hub-model-keys --ignore-not-found >/dev/null 2>&1 || true
    say "no model providers configured; the agent stays disabled"
    return 0
  fi

  local args=() name value missing="" wired=""
  for name in $names; do
    value="$(printenv "$name" || true)"
    if [ -z "$value" ]; then
      missing="${missing} ${name}"
      continue
    fi
    args+=("--from-literal=${name}=${value}")
    wired="${wired} ${name}"
  done

  if [ -n "$missing" ]; then
    # Named explicitly. A provider whose key is absent is skipped at runtime,
    # which looks identical to that provider being down.
    say "WARNING: provider chain references unset variable(s):${missing}" >&2
    say "         those providers will be skipped; set them in .env.internal" >&2
  fi
  if [ ${#args[@]} -eq 0 ]; then
    kubectl -n "$namespace" delete secret mx-insight-hub-model-keys --ignore-not-found >/dev/null 2>&1 || true
    return 0
  fi

  kubectl -n "$namespace" create secret generic mx-insight-hub-model-keys \
    "${args[@]}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  # Report only what was actually wired; listing a key that was skipped is how
  # an operator concludes the chain is complete when it is not.
  say "model keys wired:${wired}"
}

create_runtime_config() {
  local namespace="mx-insight-hub"
  need node
  local database_url="${MX_INSIGHT_DATABASE_URL:?ensure_shared_data_plane must run before create_runtime_config}"
  local docker_proxy_snapshot
  docker_proxy_snapshot="$(docker_daemon_proxy_snapshot)"
  local -a secret_args=(
    --from-literal=DATABASE_URL="$database_url"
    --from-literal=MX_INSIGHT_ADMIN_TOKEN="$MX_INSIGHT_ADMIN_TOKEN"
    --from-literal=MX_INSIGHT_API_KEY_PEPPER="$MX_INSIGHT_API_KEY_PEPPER"
    --from-literal=NIGHT_ALL_SERVICE_TOKEN="${NIGHT_ALL_SERVICE_TOKEN:-}"
    --from-literal=NIGHT_ALL_EXPORT_TOKEN="${NIGHT_ALL_EXPORT_TOKEN:-}"
    --from-literal=MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT="$docker_proxy_snapshot"
  )
  if [ -n "${MX_INSIGHT_TG_MONITOR_DATABASE_URL:-}" ]; then
    secret_args+=(--from-literal=MX_INSIGHT_TG_MONITOR_DATABASE_URL="$MX_INSIGHT_TG_MONITOR_DATABASE_URL")
  fi

  # Shared data-plane endpoints. An explicit URL remains authoritative. When a
  # transiently unhealthy search rollout leaves this value empty, Hub Pods in
  # Kubernetes can still resolve the owned mx-common Service through cluster
  # DNS after it recovers; non-Kubernetes runtimes keep requiring an explicit
  # URL. Deploy-time health still controls whether the projector is started.
  local elasticsearch_url="${MX_COMMON_ELASTICSEARCH_URL:-http://mx-common-elasticsearch.mx-common.svc.cluster.local:9200}"
  local redis_url="${MX_COMMON_REDIS_URL:-redis://mx-common-redis.mx-common.svc.cluster.local:6379}"
  # Keep the JSON default outside `${VAR:-word}`. A `}` inside `word` closes
  # that parameter expansion early, so an explicitly configured JSON object
  # previously acquired one trailing `}` and crashed the Admin listener.
  local server_file_roots='{"shared-dir":"/shared_dir"}'
  if [ -n "${MX_INSIGHT_SERVER_FILE_ROOTS:-}" ]; then
    server_file_roots="$MX_INSIGHT_SERVER_FILE_ROOTS"
  fi
  if ! MX_INSIGHT_SERVER_FILE_ROOTS_VALUE="$server_file_roots" \
    node --input-type=module -e '
      const { parseServerFileRoots } = await import(process.argv[1])
      parseServerFileRoots(process.env.MX_INSIGHT_SERVER_FILE_ROOTS_VALUE)
    ' "${ROOT_DIR}/server/ingest/external/server-files.mjs" >/dev/null 2>&1; then
    die "MX_INSIGHT_SERVER_FILE_ROOTS must be a valid server-file root JSON object"
  fi
  local telegram_sqlite_page_delay_ms="${MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS:-1000}"
  if ! MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS_VALUE="$telegram_sqlite_page_delay_ms" \
    node -e '
      const value = Number(process.env.MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS_VALUE)
      if (!Number.isInteger(value) || value < 0 || value > 60_000) process.exit(1)
    '; then
    die "MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS must be an integer from 0 to 60000"
  fi
  local province_page_delay_ms="${MX_INSIGHT_PROVINCE_PAGE_DELAY_MS:-2000}"
  if ! MX_INSIGHT_PROVINCE_PAGE_DELAY_MS_VALUE="$province_page_delay_ms" \
    node -e '
      const value = Number(process.env.MX_INSIGHT_PROVINCE_PAGE_DELAY_MS_VALUE)
      if (!Number.isInteger(value) || value < 0 || value > 60_000) process.exit(1)
    '; then
    die "MX_INSIGHT_PROVINCE_PAGE_DELAY_MS must be an integer from 0 to 60000"
  fi
  if [ "${MX_INSIGHT_SEARCH_READY:-0}" != "1" ] && [ -z "${MX_COMMON_ELASTICSEARCH_URL:-}" ]; then
    say "shared search is not ready; deploying with MX_COMMON_ELASTICSEARCH_URL unset (search degraded)"
    elasticsearch_url=""
  fi

  kubectl -n "$namespace" create configmap mx-insight-hub-config \
    --from-literal=MX_INSIGHT_HOST=0.0.0.0 \
    --from-literal=MX_INSIGHT_STORE=postgres \
    --from-literal=NIGHT_ALL_BASE_URL="$NIGHT_ALL_BASE_URL" \
    --from-literal=NIGHT_ALL_TIMEOUT_MS="${NIGHT_ALL_TIMEOUT_MS:-30000}" \
    --from-literal=NIGHT_ALL_READY_MODE="${NIGHT_ALL_READY_MODE:-ready_only}" \
    --from-literal=MX_COMMON_ELASTICSEARCH_URL="$elasticsearch_url" \
    --from-literal=MX_COMMON_REDIS_URL="$redis_url" \
    --from-literal=MX_COMMON_HANLP_URL="${MX_COMMON_HANLP_URL:-}" \
    --from-literal=MX_COMMON_SEGMENTER="${MX_COMMON_SEGMENTER:-}" \
    --from-literal=MX_COMMON_QUEUE_DRIVER="${MX_COMMON_QUEUE_DRIVER:-postgres}" \
    --from-literal=MX_INSIGHT_SERVER_FILE_ROOTS="$server_file_roots" \
    --from-literal=MX_INSIGHT_EMBEDDING_MODEL="${MX_INSIGHT_EMBEDDING_MODEL:-}" \
    --from-literal=MX_INSIGHT_EMBEDDING_DIMENSIONS="${MX_INSIGHT_EMBEDDING_DIMENSIONS:-}" \
    --from-literal=MX_INSIGHT_LAUNCHER_URL="${MX_INSIGHT_LAUNCHER_URL:-}" \
    --from-literal=MX_INSIGHT_LAUNCHER_AUDIENCE="${MX_INSIGHT_LAUNCHER_AUDIENCE:-mx-insight-hub}" \
    --from-literal=MX_INSIGHT_LAUNCHER_ADMIN_SCOPES="${MX_INSIGHT_LAUNCHER_ADMIN_SCOPES:-}" \
    --from-literal=MX_INSIGHT_BACKFILL_PLATFORMS="${MX_INSIGHT_BACKFILL_PLATFORMS:-xiaohongshu,douyin,twitter}" \
    --from-literal=MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS="${MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS:-60000}" \
    --from-literal=MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE="${MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE:-1000}" \
    --from-literal=MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS="$telegram_sqlite_page_delay_ms" \
    --from-literal=MX_INSIGHT_PROVINCE_PAGE_DELAY_MS="$province_page_delay_ms" \
    --from-literal=MX_INSIGHT_AGENT_PROVIDERS="${MX_INSIGHT_AGENT_PROVIDERS:-}" \
    --from-literal=MX_INSIGHT_EMBEDDING_PROVIDERS="${MX_INSIGHT_EMBEDDING_PROVIDERS:-}" \
    --from-literal=MX_INSIGHT_AGENT_AUTO_MIGRATE="${MX_INSIGHT_AGENT_AUTO_MIGRATE:-1}" \
    --dry-run=client -o yaml | kubectl apply -f -

  kubectl -n "$namespace" create secret generic mx-insight-hub-secrets \
    "${secret_args[@]}" \
    --dry-run=client -o yaml | kubectl apply -f -
}

sync_launcher_secret() {
  local launcher_namespace="${MX_LAUNCHER_K8S_NAMESPACE:-mx-internal-shadow}"
  if [ "${MX_INSIGHT_SYNC_LAUNCHER:-0}" != "1" ]; then
    say "Independent deploy: Launcher token synchronization is disabled."
    return 0
  fi
  if kubectl get namespace "$launcher_namespace" >/dev/null 2>&1; then
    kubectl -n "$launcher_namespace" create secret generic mx-insight-hub-admin \
      --from-literal=token="$MX_INSIGHT_ADMIN_TOKEN" \
      --dry-run=client -o yaml | kubectl apply -f -
    if [ -n "${MX_INSIGHT_HUB_ADMIN_ENTRYPOINT:-}" ]; then
      case "$MX_INSIGHT_HUB_ADMIN_ENTRYPOINT" in
        http://*|https://*) ;;
        *) die "MX_INSIGHT_HUB_ADMIN_ENTRYPOINT must be an http(s) URL" ;;
      esac
      case "$MX_INSIGHT_HUB_ADMIN_ENTRYPOINT" in
        *[!A-Za-z0-9:/._~-]*) die "MX_INSIGHT_HUB_ADMIN_ENTRYPOINT contains unsupported characters" ;;
      esac
      if kubectl -n "$launcher_namespace" get configmap mx-launcher-internal-config >/dev/null 2>&1; then
        kubectl -n "$launcher_namespace" patch configmap mx-launcher-internal-config \
          --type merge \
          -p "{\"data\":{\"MX_INSIGHT_HUB_ADMIN_ENTRYPOINT\":\"${MX_INSIGHT_HUB_ADMIN_ENTRYPOINT}\"}}"
      fi
    fi
    say "Synchronized the Hub admin workload token to ${launcher_namespace}/mx-insight-hub-admin."
  else
    say "Launcher namespace ${launcher_namespace} is absent; skipping optional token synchronization."
  fi
}

refresh_launcher_workload() {
  local launcher_namespace="${MX_LAUNCHER_K8S_NAMESPACE:-mx-internal-shadow}"
  if [ "${MX_INSIGHT_SYNC_LAUNCHER:-0}" != "1" ]; then return 0; fi
  if kubectl -n "$launcher_namespace" get deployment mx-launcher-internal >/dev/null 2>&1; then
    kubectl -n "$launcher_namespace" rollout restart deployment/mx-launcher-internal
    kubectl -n "$launcher_namespace" rollout status deployment/mx-launcher-internal --timeout=240s
    say "Launcher reloaded the synchronized Hub token and optional Admin entrypoint."
  fi
}

canonical_image_ref() {
  local image="$1"
  local first
  if [[ "$image" != */* ]]; then
    printf 'docker.io/library/%s\n' "$image"
    return 0
  fi
  first="${image%%/*}"
  if [[ "$first" == *.* || "$first" == *:* || "$first" == localhost ]]; then
    printf '%s\n' "$image"
  else
    printf 'docker.io/%s\n' "$image"
  fi
}

containerd_image_ref_present() {
  local ref="$1"
  run_ctr images ls -q | grep -Fx -- "$ref" >/dev/null 2>&1
}

containerd_import_docker_image() {
  local image="$1"
  local canonical safe archive
  [ -n "$DEPLOY_TMP_DIR" ] || die "deploy runtime is not initialized"
  canonical="$(canonical_image_ref "$image")"
  safe="${image//\//_}"
  safe="${safe//:/_}"
  archive="${DEPLOY_TMP_DIR}/${safe}.tar"
  rm -f -- "$archive"
  say "import $image into containerd namespace k8s.io"
  docker image save -o "$archive" "$image"
  run_ctr images import "$archive"
  rm -f -- "$archive"
  containerd_image_ref_present "$canonical" \
    || die "containerd import did not create required image ref $canonical"
}

# Opt-in: create (once) a scoped buildx builder that routes image pulls AND RUN
# steps through MX_INSIGHT_BUILD_PROXY, WITHOUT touching the Docker daemon's own
# proxy. Host network lets it reach a 127.0.0.1 proxy; the network.host
# entitlement lets RUN steps reach it too. Idempotent.
ensure_build_proxy_builder() {
  local proxy="$1"
  local name="${MX_INSIGHT_BUILDX_BUILDER:-mx-insight-buildproxy}"
  docker buildx version >/dev/null 2>&1 \
    || die "MX_INSIGHT_BUILD_PROXY requires 'docker buildx' (Docker with the buildx plugin)."
  if ! docker buildx inspect "$name" >/dev/null 2>&1; then
    say "Creating one-off buildx builder '$name' routed via ${proxy} (Docker daemon proxy left untouched)."
    # No NO_PROXY on buildkitd: it only pulls external registries (docker.io), which
    # must all traverse the proxy. Comma-lists in --driver-opt trip buildx's CSV
    # parser; internal/RUN bypass is handled by the NO_PROXY build-arg instead.
    docker buildx create --name "$name" \
      --driver docker-container \
      --driver-opt network=host \
      --driver-opt "env.HTTP_PROXY=${proxy}" \
      --driver-opt "env.HTTPS_PROXY=${proxy}" \
      --buildkitd-flags '--allow-insecure-entitlement network.host' >/dev/null
  fi
}

# Reconcile the shared mx-common data plane (Elasticsearch, Redis) before the
# Hub rolls out.
#
# Failure here is deliberately NOT fatal. Elasticsearch is a rebuildable
# projection, not a source of truth: the Hub's Night-All path, PostgreSQL
# ingestion and billing all work without it, and aborting a Hub deploy because
# search is unhealthy would convert a degraded feature into an outage. Set
# MX_INSIGHT_REQUIRE_SEARCH=1 to invert that for environments where search is
# considered part of the product's minimum viable surface.
ensure_shared_data_plane() {
  local manage="${MX_COMMON_DIR}/scripts/manage.sh"
  if [ ! -x "$manage" ] && [ ! -f "$manage" ]; then
    say "mx-common is not present at ${MX_COMMON_DIR}; skipping shared data plane"
    MX_INSIGHT_SEARCH_READY=0
    return 0
  fi

  say "reconciling shared data plane (mx-common)"
  # Hub's namespace must carry the client label before its pods can reach the
  # shared stores; mx-common applies it from this list.
  if MX_COMMON_CLIENT_NAMESPACES="mx-insight-hub ${MX_COMMON_EXTRA_CLIENT_NAMESPACES:-}" \
     bash "$manage" ensure; then
    MX_INSIGHT_SEARCH_READY=1
    say "shared data plane is healthy"
  else
    MX_INSIGHT_SEARCH_READY=0
    if [ "${MX_INSIGHT_REQUIRE_SEARCH:-0}" = "1" ]; then
      die "shared data plane is unhealthy and MX_INSIGHT_REQUIRE_SEARCH=1"
    fi
    say "WARNING: shared data plane is degraded; continuing with search degraded." >&2
    say "         Night-All dispatch and billing are unaffected." >&2
    say "         Diagnose with: bash ${manage#"${ELECTRON_DOCK_DIR}/"} status" >&2
  fi

  # The database is not optional, so this runs even on a degraded data plane and
  # a failure here IS fatal: without it the Hub has nowhere to record requests,
  # usage or ingested content.
  ensure_hub_database "$manage"
  discover_launcher_url
}

# Obtain the Hub's dedicated database inside the shared instance.
#
# mx-common owns the credential: it generates one on first provision and stores
# it in its own Secret, so re-running deploy reuses the same password instead of
# rotating it out from under running pods. Setting MX_INSIGHT_POSTGRES_PASSWORD
# pins a specific value instead.
ensure_hub_database() {
  local manage="$1" provision_log status=0
  say "provisioning database mx_insight_hub in the shared instance"

  # provision writes the DSN to stdout and everything else to stderr, so stderr
  # is captured separately rather than discarded. Swallowing it turns any
  # failure into "could not provision", which is exactly as useless as it
  # sounds — it is how a SIGPIPE in a password generator looked like a database
  # problem.
  provision_log="$(mktemp)"
  MX_INSIGHT_DATABASE_URL="$(
    bash "$manage" provision mx-insight-hub "${MX_INSIGHT_POSTGRES_PASSWORD:-}" 2>"$provision_log"
  )" || status=$?

  if [ "$status" -ne 0 ] || [ -z "${MX_INSIGHT_DATABASE_URL:-}" ]; then
    say "ERROR: could not provision the Hub database in mx-common (exit ${status})" >&2
    if [ -s "$provision_log" ]; then
      sed -n '1,20p' "$provision_log" >&2
    else
      say "  provision produced no output at all." >&2
      say "  Reproduce it directly:  bash ${manage} provision mx-insight-hub" >&2
    fi
    rm -f -- "$provision_log"
    exit 1
  fi
  rm -f -- "$provision_log"

  case "$MX_INSIGHT_DATABASE_URL" in
    postgres://*) : ;;
    *) die "mx-common returned an unexpected connection string" ;;
  esac
  say "database ready: mx-common-postgres.mx-common.svc.cluster.local/mx_insight_hub"
}

build_and_import_image() {
  local image="${MX_INSIGHT_IMAGE:-mx-insight-hub:shadow}"
  need docker
  need ctr
  DEPLOY_PREVIOUS_DOCKER_IMAGE_ID="$(
    docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true
  )"
  if [ -n "${MX_INSIGHT_BUILD_PROXY:-}" ]; then
    # Special case: force THIS build through the given proxy (e.g. Mihomo 7788),
    # leaving the server's global Docker proxy untouched.
    ensure_build_proxy_builder "$MX_INSIGHT_BUILD_PROXY"
    docker buildx build \
      --builder "${MX_INSIGHT_BUILDX_BUILDER:-mx-insight-buildproxy}" \
      --network host \
      --allow network.host \
      --build-arg "HTTP_PROXY=$MX_INSIGHT_BUILD_PROXY" \
      --build-arg "HTTPS_PROXY=$MX_INSIGHT_BUILD_PROXY" \
      --build-arg "NO_PROXY=${MX_INSIGHT_BUILD_NO_PROXY:-localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.cluster.local}" \
      --label dev.qpjoy.mx-insight-hub.project=mx-insight-hub \
      --label dev.qpjoy.mx-insight-hub.image=internal \
      --build-context "ui_design=${ELECTRON_DOCK_DIR}/mx-launcher/ui-design" \
      --build-context "mx_common=${MX_COMMON_DIR}" \
      -t "$image" \
      -f "${ROOT_DIR}/Dockerfile" \
      --load \
      "$ROOT_DIR"
  else
    # BuildKit's default bridge is a different network than the host, and on a
    # node whose egress crosses a tunnel it is a *worse* one: the bridge keeps a
    # 1500-byte MTU, so registry metadata succeeds while package tarballs stall
    # until npm times out -- surfacing as npm's own "Exit handler never called"
    # rather than as a network error. Host networking sidesteps it without
    # requiring the proxy the other branch exists for.
    local build_network=""
    case "${MX_INSIGHT_BUILD_NETWORK:-}" in
      '') ;;
      host) build_network="host" ;;
      *) die "MX_INSIGHT_BUILD_NETWORK only accepts 'host'" ;;
    esac
    docker build \
      --rm \
      --force-rm \
      ${build_network:+--network "$build_network"} \
      --label dev.qpjoy.mx-insight-hub.project=mx-insight-hub \
      --label dev.qpjoy.mx-insight-hub.image=internal \
      --build-context "ui_design=${ELECTRON_DOCK_DIR}/mx-launcher/ui-design" \
      --build-context "mx_common=${MX_COMMON_DIR}" \
      -t "$image" \
      -f "${ROOT_DIR}/Dockerfile" \
      "$ROOT_DIR"
  fi
  DEPLOY_DOCKER_IMAGE="$image"
  DEPLOY_DOCKER_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$image")"
  containerd_import_docker_image "$image"
}

k8s_default_storage_class() {
  kubectl get storageclass \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.annotations.storageclass\.kubernetes\.io/is-default-class}{"\t"}{.metadata.annotations.storageclass\.beta\.kubernetes\.io/is-default-class}{"\n"}{end}' \
    2>/dev/null \
    | awk '$2 == "true" || $3 == "true" { print $1; exit }'
}

k8s_migration_diagnostics() {
  say "migration diagnostics"
  kubectl -n mx-insight-hub get job,pod -l app.kubernetes.io/name=mx-insight-hub-migrate -o wide || true
  kubectl -n mx-insight-hub describe job mx-insight-hub-migrate || true
  kubectl -n mx-insight-hub logs job/mx-insight-hub-migrate --all-containers --tail=200 || true
  kubectl -n mx-insight-hub get events --sort-by=.lastTimestamp | tail -n 80 || true
}

k8s_api_diagnostics() {
  say "API rollout diagnostics"
  kubectl -n mx-insight-hub get deployment,pod,service -o wide || true
  kubectl -n mx-insight-hub describe deployment mx-insight-hub-public || true
  kubectl -n mx-insight-hub describe deployment mx-insight-hub-admin || true
  kubectl -n mx-insight-hub logs deployment/mx-insight-hub-public --all-containers --tail=200 || true
  kubectl -n mx-insight-hub logs deployment/mx-insight-hub-admin --all-containers --tail=200 || true
  kubectl -n mx-insight-hub get events --sort-by=.lastTimestamp | tail -n 80 || true
}

k8s_projector_diagnostics() {
  say "projector diagnostics"
  kubectl -n mx-insight-hub get deployment,pod \
    -l app.kubernetes.io/name=mx-insight-hub-projector -o wide || true
  kubectl -n mx-insight-hub describe deployment mx-insight-hub-projector || true
  kubectl -n mx-insight-hub logs deployment/mx-insight-hub-projector \
    --all-containers --tail=200 || true
  # CrashLoopBackOff commonly leaves the useful startup failure only in the
  # previous container.  Keep this bounded and best-effort because there may be
  # no previous container yet (for example while an image is still pulling).
  kubectl -n mx-insight-hub logs deployment/mx-insight-hub-projector \
    --all-containers --previous --tail=200 || true
  kubectl -n mx-insight-hub get events --sort-by=.lastTimestamp | tail -n 80 || true
}

# A local PostgreSQL left over from a previous release keeps running and keeps
# holding its PVC. Removing it automatically here would delete a database during
# a routine deploy, so this only reports it.
warn_local_postgres_present() {
  kubectl -n mx-insight-hub get statefulset mx-insight-hub-postgres \
    >/dev/null 2>&1 || return 0
  say "NOTE: a local PostgreSQL StatefulSet from a previous release is still running." >&2
  say "      The Hub now uses mx-common; this workload is unused but not removed." >&2
  say "      Remove it deliberately with:" >&2
  say "        bash scripts/manage.sh ops internal-production decommission-local-postgres" >&2
}

# Reconcile the Hub-local PostgreSQL indexes for the curated province feed and
# the all-ingested region feed. The legacy pair gates source activation; the
# region pair independently gates the broader public endpoint. The SQL is deliberately streamed from the
# operator checkout into the shared PostgreSQL Pod: the runtime image neither
# ships psql nor needs permission to perform DDL. The script is idempotent and
# uses CREATE/DROP INDEX CONCURRENTLY, so it must remain outside the migration
# transaction and before workload rollout reports the deploy as successful.
ensure_province_opinion_serving_indexes() {
  local sql_file="${ROOT_DIR}/scripts/province-opinion-serving-indexes.sql"
  [ -r "$sql_file" ] || die "province-opinion serving-index SQL is missing: ${sql_file}"
  say "reconciling province-opinion serving indexes"
  if ! kubectl -n mx-common exec -i statefulset/mx-common-postgres -- \
    psql -X -U mx_common -d mx_insight_hub -v ON_ERROR_STOP=1 <"$sql_file"; then
    die "province-opinion serving indexes could not be reconciled"
  fi
}

# Reconcile the Hub-local indexes used by canonical Telegram context. This is
# kept separate from transactional migrations because production datasets are
# already populated and CREATE/DROP INDEX CONCURRENTLY cannot run in a
# transaction. The SQL validates the full catalog contract, repairs an invalid
# or drifted same-name index, and fails the deploy before any API rollout if the
# two serving indexes are not ready.
ensure_canonical_context_serving_indexes() {
  local sql_file="${ROOT_DIR}/scripts/canonical-context-serving-indexes.sql"
  [ -r "$sql_file" ] || die "canonical context serving-index SQL is missing: ${sql_file}"
  say "reconciling canonical context serving indexes"
  if ! kubectl -n mx-common exec -i statefulset/mx-common-postgres -- \
    psql -X -U mx_common -d mx_insight_hub -v ON_ERROR_STOP=1 <"$sql_file"; then
    die "canonical context serving indexes could not be reconciled"
  fi
}

# Explicit, irreversible removal of the retired local PostgreSQL.
#
# Separate command, never part of deploy, and it names what it will destroy
# before doing it. `MX_INSIGHT_CONFIRM_DESTROY=mx-insight-hub` is required
# because there is no undo: the PV is Retain, but the host directory is removed.
decommission_local_postgres() {
  local namespace="mx-insight-hub"
  if [ "${MX_INSIGHT_CONFIRM_DESTROY:-}" != "mx-insight-hub" ]; then
    say "This permanently deletes the retired local PostgreSQL and its data:" >&2
    say "  statefulset/mx-insight-hub-postgres" >&2
    say "  pvc/${LEGACY_POSTGRES_PVC_NAME}" >&2
    say "  pv/${LEGACY_POSTGRES_PV_NAME}" >&2
    say "  host path ${LEGACY_POSTGRES_HOST_PATH}" >&2
    die "Re-run with MX_INSIGHT_CONFIRM_DESTROY=mx-insight-hub to proceed"
  fi
  kubectl -n "$namespace" delete statefulset mx-insight-hub-postgres --ignore-not-found
  kubectl -n "$namespace" delete service mx-insight-hub-postgres --ignore-not-found
  kubectl -n "$namespace" delete pvc "$LEGACY_POSTGRES_PVC_NAME" --ignore-not-found
  kubectl delete pv "$LEGACY_POSTGRES_PV_NAME" --ignore-not-found
  if [ -d "$LEGACY_POSTGRES_HOST_PATH" ]; then
    rm -rf -- "$LEGACY_POSTGRES_HOST_PATH" 2>/dev/null \
      || sudo -n rm -rf -- "$LEGACY_POSTGRES_HOST_PATH" 2>/dev/null \
      || say "could not remove ${LEGACY_POSTGRES_HOST_PATH}; remove it as root" >&2
  fi
  say "retired local PostgreSQL removed."
}

apply_k8s() {
  local namespace="mx-insight-hub"
  kubectl apply -f "${K8S_DIR}/00-namespace.yaml"
  kubectl apply -f "${K8S_DIR}/05-serviceaccount.yaml"
  validate_existing_runtime_secret
  discover_hanlp_url
  create_runtime_config
  create_model_key_secret
  sync_launcher_secret
  # PostgreSQL is no longer a Hub workload. The database lives in the shared
  # mx-common instance and was provisioned by ensure_shared_data_plane; a
  # previously deployed local StatefulSet is left untouched here and removed
  # only by the explicit `decommission-local-postgres` action.
  warn_local_postgres_present

  kubectl -n "$namespace" delete job mx-insight-hub-migrate --ignore-not-found
  render_file "${K8S_DIR}/20-migration-job.yaml" | kubectl apply -f -
  if ! kubectl -n "$namespace" wait \
    --for=condition=complete job/mx-insight-hub-migrate --timeout=300s; then
    k8s_migration_diagnostics
    die "migration did not complete"
  fi

  ensure_province_opinion_serving_indexes
  ensure_canonical_context_serving_indexes

  render_file "${K8S_DIR}/30-public-api.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/31-admin-api.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/32-projector.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/33-ingest.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/34-classifier.yaml" | kubectl apply -f -
  kubectl apply -f "${K8S_DIR}/40-network-policy.yaml"
  kubectl -n "$namespace" rollout restart deployment/mx-insight-hub-public deployment/mx-insight-hub-admin
  if ! kubectl -n "$namespace" rollout status \
    deployment/mx-insight-hub-public --timeout=300s \
    || ! kubectl -n "$namespace" rollout status \
      deployment/mx-insight-hub-admin --timeout=300s; then
    k8s_api_diagnostics
    die "Hub API workloads did not become ready"
  fi

  # The projector is scaled to match deploy-time search availability rather
  # than starting a strict reconcile against a cluster already known to be
  # unhealthy. API/Admin Pods retain the trusted Kubernetes DNS fallback for a
  # later recovery; outbox events accumulate while the projector is scaled down
  # and drain once it is scaled back up.
  if [ "${MX_INSIGHT_SEARCH_READY:-0}" = "1" ]; then
    kubectl -n "$namespace" rollout restart deployment/mx-insight-hub-projector
    if ! kubectl -n "$namespace" rollout status \
      deployment/mx-insight-hub-projector --timeout=180s; then
      kubectl -n "$namespace" logs deployment/mx-insight-hub-projector --tail=60 >&2 || true
      say "WARNING: projector did not become ready; search will lag until it recovers." >&2
    fi
  else
    kubectl -n "$namespace" scale deployment/mx-insight-hub-projector --replicas=0 >/dev/null 2>&1 || true
    say "projector scaled to zero (search not available). Outbox events are retained."
  fi
  # The ingest worker only needs PostgreSQL and Night-All, so it rolls out
  # regardless of search availability. It is the workload that must not stop: a
  # missed ingest is a permanent hole, a missed projection is a reindex.
  kubectl -n "$namespace" rollout restart deployment/mx-insight-hub-ingest
  if ! kubectl -n "$namespace" rollout status \
    deployment/mx-insight-hub-ingest --timeout=180s; then
    kubectl -n "$namespace" logs deployment/mx-insight-hub-ingest --tail=60 >&2 || true
    die "ingest worker did not become ready"
  fi
  # Classification is a post-commit derived plane. Its failure must never roll
  # back an API/login deployment or stop source ingestion; the durable backlog
  # remains visible in the Agent center and drains after recovery.
  kubectl -n "$namespace" rollout restart deployment/mx-insight-hub-classifier
  if ! kubectl -n "$namespace" rollout status \
    deployment/mx-insight-hub-classifier --timeout=180s; then
    kubectl -n "$namespace" logs deployment/mx-insight-hub-classifier --tail=60 >&2 || true
    say "WARNING: Agent classifier did not become ready; classification backlog is retained." >&2
  fi
  verify_hanlp_from_hub || true
  refresh_launcher_workload
}

k8s_smoke() {
  # The Admin and Public planes are host-exposed via hostNetwork, and deploy runs
  # on the Internal host, so reach them directly on loopback (no port-forward).
  local admin_base="http://127.0.0.1:18151"
  local public_base="http://127.0.0.1:18150"
  wait_http "${admin_base}/health/live" 90 \
    || die "Admin API not reachable on the host at ${admin_base} (hostNetwork bind failed?)"
  wait_http "${public_base}/health/live" 90 \
    || die "Public API not reachable on the host at ${public_base} (hostNetwork bind failed?)"
  MX_SMOKE_BASE_URL="$admin_base" \
  MX_INSIGHT_ADMIN_TOKEN="$MX_INSIGHT_ADMIN_TOKEN" \
    node "${ROOT_DIR}/scripts/smoke.mjs"
}

# A retained bootstrap key keeps the grants of its consumer. Operators may add
# newly approved platforms through MX_INSIGHT_BOOTSTRAP_PLATFORMS without
# rotating that key, but an empty setting must never expand its permissions from
# upstream or Hub-local capability discovery.
reconcile_reused_bootstrap_platforms() {
  local namespace="$1"
  local admin_base="$2"
  [ -n "${MX_INSIGHT_BOOTSTRAP_PLATFORMS:-}" ] || return 0

  local tenant_id consumer_id grant_body
  tenant_id="$(
    kubectl -n "$namespace" get secret mx-insight-hub-bootstrap \
      -o jsonpath='{.data.MX_INSIGHT_TENANT_ID}' --ignore-not-found 2>/dev/null \
      | base64 -d 2>/dev/null || true
  )"
  consumer_id="$(
    kubectl -n "$namespace" get secret mx-insight-hub-bootstrap \
      -o jsonpath='{.data.MX_INSIGHT_CONSUMER_ID}' --ignore-not-found 2>/dev/null \
      | base64 -d 2>/dev/null || true
  )"
  if [ -z "$tenant_id" ] || [ -z "$consumer_id" ]; then
    say "WARNING: explicit bootstrap platforms were not reconciled because the stored tenant/consumer IDs are missing."
    return 0
  fi

  grant_body="$(
    MX_INSIGHT_BOOTSTRAP_TENANT_ID="$tenant_id" \
    MX_INSIGHT_BOOTSTRAP_CONSUMER_ID="$consumer_id" \
      node -e 'process.stdout.write(JSON.stringify({
        tenantId: process.env.MX_INSIGHT_BOOTSTRAP_TENANT_ID,
        consumerId: process.env.MX_INSIGHT_BOOTSTRAP_CONSUMER_ID,
        enabled: true,
      }))'
  )"

  local platform encoded_platform reconciled=""
  while IFS= read -r platform; do
    [ -n "$platform" ] || continue
    encoded_platform="$(
      MX_INSIGHT_BOOTSTRAP_PLATFORM="$platform" \
        node -e 'process.stdout.write(encodeURIComponent(process.env.MX_INSIGHT_BOOTSTRAP_PLATFORM))'
    )"
    if curl_with_protected_header \
      'x-mx-insight-admin-token' "$MX_INSIGHT_ADMIN_TOKEN" \
      -fsS -X PUT \
      -H 'content-type: application/json' \
      --data "$grant_body" \
      "${admin_base}/internal/v1/admin/platforms/${encoded_platform}" >/dev/null; then
      reconciled="${reconciled}${reconciled:+, }${platform}"
    else
      say "WARNING: could not reconcile explicit bootstrap platform ${platform}."
    fi
  done < <(
    MX_INSIGHT_BOOTSTRAP_PLATFORMS="$MX_INSIGHT_BOOTSTRAP_PLATFORMS" \
      node -e '
        const seen = new Set()
        for (const entry of (process.env.MX_INSIGHT_BOOTSTRAP_PLATFORMS || "").split(",")) {
          const platform = entry.trim().toLowerCase()
          if (!platform || seen.has(platform)) continue
          seen.add(platform)
          process.stdout.write(`${platform}\n`)
        }
      '
  )
  if [ -n "$reconciled" ]; then
    say "Reconciled explicit bootstrap platform grants: ${reconciled}."
  fi
}

# Idempotently guarantee a usable public API key after deploy. The plaintext key
# is stored in the mx-insight-hub-bootstrap Secret and reused on later deploys, so
# no manual admin call is needed to start pulling platform data. Best-effort: a
# provisioning failure warns but never fails the deploy.
ensure_default_api_key() {
  local namespace="mx-insight-hub"
  local admin_base="http://127.0.0.1:18151"
  need base64
  need curl
  need node
  local previous_key_id=""
  BOOTSTRAP_API_KEY="$(
    kubectl -n "$namespace" get secret mx-insight-hub-bootstrap \
      -o jsonpath='{.data.MX_INSIGHT_API_KEY}' --ignore-not-found 2>/dev/null \
      | base64 -d 2>/dev/null || true
  )"
  if [ -n "$BOOTSTRAP_API_KEY" ]; then
    local key_list_json decision action reason expires_at
    if key_list_json="$(curl_with_protected_header \
      'x-mx-insight-admin-token' "$MX_INSIGHT_ADMIN_TOKEN" \
      -fsS \
      "${admin_base}/internal/v1/admin/api-keys")"; then
      decision="$(api_key_rotation_decision "$key_list_json" "$BOOTSTRAP_API_KEY")" \
        || die "could not evaluate the stored bootstrap API key"
      IFS='|' read -r action previous_key_id reason expires_at <<<"$decision"
      if [ "$action" = "reuse" ]; then
        say "Reusing stored bootstrap API key; valid beyond the ${API_KEY_ROTATION_WINDOW_DAYS}-day rotation window (${expires_at})."
        reconcile_reused_bootstrap_platforms "$namespace" "$admin_base"
        return 0
      fi
      say "Rotating stored bootstrap API key (${reason}); the old key remains valid until the replacement is persisted."
      BOOTSTRAP_API_KEY=""
    else
      # Do not replace a credential merely because the Admin API is temporarily
      # unavailable: minting may fail for the same reason and must not disturb
      # the last recoverable plaintext key.
      say "WARNING: could not inspect bootstrap API-key expiry; retaining the stored key for this deploy."
      return 0
    fi
  fi
  say "Provisioning a bootstrap tenant/consumer/API key via the Admin API."
  local provision_out
  if ! provision_out="$(
    MX_INSIGHT_ADMIN_BASE_URL="$admin_base" \
    MX_INSIGHT_ADMIN_TOKEN="$MX_INSIGHT_ADMIN_TOKEN" \
    NIGHT_ALL_BASE_URL="$NIGHT_ALL_BASE_URL" \
    NIGHT_ALL_SERVICE_TOKEN="${NIGHT_ALL_SERVICE_TOKEN:-}" \
    MX_INSIGHT_BOOTSTRAP_PLATFORMS="${MX_INSIGHT_BOOTSTRAP_PLATFORMS:-}" \
      node "${ROOT_DIR}/scripts/provision.mjs"
  )"; then
    say "WARNING: bootstrap API-key provisioning failed. The Hub is up; create a key via the Admin API when Night-All access is needed."
    BOOTSTRAP_API_KEY=""
    return 0
  fi
  BOOTSTRAP_API_KEY="$(printf '%s\n' "$provision_out" | sed -n '1p')"
  local tenant_id consumer_id
  tenant_id="$(printf '%s\n' "$provision_out" | sed -n '2p')"
  consumer_id="$(printf '%s\n' "$provision_out" | sed -n '3p')"
  kubectl -n "$namespace" create secret generic mx-insight-hub-bootstrap \
    --from-literal=MX_INSIGHT_API_KEY="$BOOTSTRAP_API_KEY" \
    --from-literal=MX_INSIGHT_TENANT_ID="$tenant_id" \
    --from-literal=MX_INSIGHT_CONSUMER_ID="$consumer_id" \
    --dry-run=client -o yaml | kubectl apply -f -
  say "Stored bootstrap API key in Secret mx-insight-hub-bootstrap."
  if [ -n "$previous_key_id" ]; then
    if curl_with_protected_header \
      'x-mx-insight-admin-token' "$MX_INSIGHT_ADMIN_TOKEN" \
      -fsS -X POST \
      "${admin_base}/internal/v1/admin/api-keys/${previous_key_id}/revoke" >/dev/null; then
      say "Revoked the replaced bootstrap API key after persisting its replacement."
    else
      say "WARNING: replacement is stored, but the previous bootstrap API key could not be revoked; revoke key ${previous_key_id} from the Admin UI."
    fi
  fi
}

print_deploy_summary() {
  local host_ip="${MX_INSIGHT_HOST_IP:-10.88.88.88}"
  say "==================== MX Insight Hub is live ===================="
  say "Admin  : http://${host_ip}:18151/            (SPA + /internal/v1/admin/*; header x-mx-insight-admin-token)"
  say "Public : http://${host_ip}:18150/api/v1/...  (Authorization: Bearer <API key>)"
  say "Night-All upstream: ${NIGHT_ALL_BASE_URL} (reached via the hostNetwork overlay)"
  if [ -n "${BOOTSTRAP_API_KEY:-}" ]; then
    say "Bootstrap API key : stored in Secret mx-insight-hub-bootstrap (plaintext withheld)"
    say "Quick check       : bash scripts/manage.sh verify-data-path"
    # capabilities calls Night-All and validates the key; a 200 proves the whole
    # public → Hub → Night-All path works (independent of per-platform grants).
    if curl_with_protected_header \
         'authorization' "Bearer ${BOOTSTRAP_API_KEY}" -fsS \
         "http://127.0.0.1:18150/api/v1/data/capabilities" >/dev/null 2>&1; then
      say "Night-All data path: OK (capabilities returned through the Hub)."
    else
      say "Night-All data path: NOT verified (Hub is up; Night-All at ${NIGHT_ALL_BASE_URL} may be down)."
    fi
  fi
  say "SECURITY: hostNetwork binds :18150/:18151 on all host interfaces. Firewall them to the internal net until the public Nginx front is in place."
  say "==============================================================="
}

# End-to-end check of the data path, stage by stage.
#
# A single curl only proves the first hop. What actually needs verifying is that
# one billed request lands in PostgreSQL, produces an outbox event, and reaches
# Elasticsearch -- four systems, each of which can fail while the one before it
# reports success. Each stage is reported separately so a failure names itself.
verify_data_path() {
  local api_key="${1:-}"
  local platform="${MX_INSIGHT_VERIFY_PLATFORM:-xiaohongshu}"
  local query="${MX_INSIGHT_VERIFY_QUERY:-AI Agent}"
  local public_url="${MX_INSIGHT_PUBLIC_URL:-http://127.0.0.1:18150}"
  need kubectl
  need curl

  if [ -z "$api_key" ]; then
    api_key="$(kubectl -n mx-insight-hub get secret mx-insight-hub-bootstrap \
      -o jsonpath='{.data.MX_INSIGHT_API_KEY}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  fi
  [ -n "$api_key" ] || die "no API key given and none stored; pass one: manage.sh verify-data-path <key>"

  # --- 1. capabilities: authentication and platform grants -----------------
  say "1/5 capabilities"
  local capabilities
  capabilities="$(curl_with_protected_header \
    'authorization' "Bearer ${api_key}" -fsS \
    "${public_url}/api/v1/data/capabilities" 2>/dev/null || true)"
  if [ -z "$capabilities" ]; then
    die "capabilities failed: the API key is invalid, revoked, or the public plane is down"
  fi
  if ! printf '%s' "$capabilities" | grep -q "\"${platform}\""; then
    say "  ERROR: ${platform} is not granted to this key's consumer." >&2
    say "  Grant it in the console under 平台能力, or:" >&2
    say "    curl -X PUT \"\$ADMIN/internal/v1/admin/platforms/${platform}\" \\" >&2
    say "      -H \"x-mx-insight-admin-token: \$TOKEN\" -H 'content-type: application/json' \\" >&2
    say "      -d '{\"tenantId\":\"<id>\",\"consumerId\":\"<id>\"}'" >&2
    return 1
  fi
  say "  ${platform} is granted"

  # --- 2. the billed upstream call -----------------------------------------
  say "2/5 search (this calls Night-All and is billed)"
  local before response items
  before="$(pg_count "SELECT count(*) FROM core.canonical_records WHERE platform = '${platform}'")"
  response="$(curl_with_protected_header \
    'authorization' "Bearer ${api_key}" \
    -fsS -X POST "${public_url}/api/v1/data/search" \
    -H 'content-type: application/json' \
    -H "idempotency-key: verify-$(date +%s)-$$" \
    -d "{\"platform\":\"${platform}\",\"query\":\"${query}\",\"pageSize\":5}" 2>/dev/null || true)"
  if [ -z "$response" ]; then
    die "search failed; check Night-All at ${NIGHT_ALL_BASE_URL:-http://127.0.0.1:13141}"
  fi
  items="$(printf '%s' "$response" | grep -o '"externalId"' | wc -l | tr -d ' ')"
  [ "$items" -gt 0 ] || die "search returned no items; nothing downstream can be verified"
  say "  ${items} item(s) returned"

  # --- 3. asynchronous ingest into PostgreSQL ------------------------------
  say "3/5 ingest -> PostgreSQL (asynchronous; the response does not wait for it)"
  local waited=0 after="$before"
  while [ "$waited" -lt 60 ]; do
    after="$(pg_count "SELECT count(*) FROM core.canonical_records WHERE platform = '${platform}'")"
    [ "$after" -gt "$before" ] && break
    sleep 3
    waited=$((waited + 3))
  done
  if [ "$after" -le "$before" ]; then
    say "  ERROR: no new canonical records after ${waited}s" >&2
    say "  The ingest worker is the thing to look at:" >&2
    say "    kubectl -n mx-insight-hub logs deployment/mx-insight-hub-ingest --tail=40" >&2
    return 1
  fi
  say "  canonical records: ${before} -> ${after}"

  # --- 4. outbox drain ------------------------------------------------------
  say "4/5 outbox -> projector"
  local pending=1
  waited=0
  while [ "$waited" -lt 60 ]; do
    pending="$(pg_count "SELECT count(*) FROM outbox.projection_events WHERE status IN ('pending','claimed')")"
    [ "$pending" -eq 0 ] && break
    sleep 3
    waited=$((waited + 3))
  done
  if [ "$pending" -ne 0 ]; then
    say "  WARNING: ${pending} event(s) still queued after ${waited}s" >&2
    say "    kubectl -n mx-insight-hub logs deployment/mx-insight-hub-projector --tail=40" >&2
    say "    dead letters: SELECT count(*) FROM outbox.projection_events WHERE status='dead'" >&2
  else
    say "  outbox drained"
  fi

  # --- 5. Elasticsearch -----------------------------------------------------
  say "5/5 Elasticsearch"
  local es_count
  es_count="$(kubectl -n mx-common exec statefulset/mx-common-elasticsearch -c elasticsearch -- \
    curl -fsS 'http://127.0.0.1:9200/mx-insight-hub-content/_count' 2>/dev/null \
    | sed -n 's/.*"count":\([0-9]*\).*/\1/p' || true)"
  if [ -z "$es_count" ] || [ "$es_count" -eq 0 ] 2>/dev/null; then
    say "  WARNING: the content index is empty or unreachable" >&2
    say "  Search is degraded; PostgreSQL still serves exact queries." >&2
  else
    say "  indexed documents: ${es_count}"
  fi

  say "data path verified end to end."
}

# Run a scalar query against the Hub database as the shared instance superuser.
pg_count() {
  kubectl -n mx-common exec statefulset/mx-common-postgres -- \
    psql -U mx_common -d mx_insight_hub -tAc "$1" 2>/dev/null | tr -d ' \n' || printf '0'
}

# Re-run the PostgreSQL -> Elasticsearch reconciliation as a second process in
# the Ready Admin Pod. Admin carries the same DB/ES/HanLP configuration as the
# projector but does not share its strict-startup CrashLoop failure mode. The
# one-shot process is fail-closed and its PostgreSQL advisory lock provides
# single-flight. No API, Launcher, ingest, login, or worker is restarted.
reindex_search() {
  local namespace="mx-insight-hub"
  local projector_deployment="mx-insight-hub-projector"
  local executor_deployment="mx-insight-hub-admin"
  local projector_replicas projector_ready admin_ready elasticsearch_url
  local projector_unready=0
  need kubectl

  elasticsearch_url="$(
    kubectl -n "$namespace" get configmap mx-insight-hub-config \
      -o jsonpath='{.data.MX_COMMON_ELASTICSEARCH_URL}' 2>/dev/null || true
  )"
  if [ -z "$elasticsearch_url" ]; then
    say "WARNING: MX_COMMON_ELASTICSEARCH_URL is empty in mx-insight-hub-config; continuing so the Admin runtime can resolve Elasticsearch and run the strict connectivity check." >&2
  fi

  admin_ready="$(
    kubectl -n "$namespace" get deployment "$executor_deployment" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true
  )"
  case "$admin_ready" in
    ''|*[!0-9]*|0)
      k8s_api_diagnostics
      die "$executor_deployment must have at least one Ready replica to host the reindex process (ready=${admin_ready:-0}); the projector is not used as the executor"
      ;;
  esac

  projector_replicas="$(
    kubectl -n "$namespace" get deployment "$projector_deployment" \
      -o jsonpath='{.spec.replicas}' 2>/dev/null || true
  )"
  projector_ready="$(
    kubectl -n "$namespace" get deployment "$projector_deployment" \
      -o jsonpath='{.status.readyReplicas}' 2>/dev/null || true
  )"
  case "$projector_ready" in
    ''|*[!0-9]*|0)
      projector_unready=1
      say "WARNING: ${projector_deployment} is not Ready (desired=${projector_replicas:-unknown}, ready=${projector_ready:-0}); reindex will run independently in ${executor_deployment}." >&2
      k8s_projector_diagnostics
      ;;
  esac

  # A rebuild writes a whole second copy of the projection before the aliases
  # move. Past the high watermark Elasticsearch will not allocate the new
  # index's shard at all, and the failure surfaces as an unrelated-looking
  # connectivity error hours later. Check before spending the tokenizer time.
  local disk_percent
  disk_percent="$(
    kubectl -n mx-common exec statefulset/mx-common-elasticsearch -c elasticsearch -- \
      curl -fsS 'http://127.0.0.1:9200/_cat/allocation?h=disk.percent' 2>/dev/null \
      | tr -d ' ' | grep -E '^[0-9]+$' | sort -rn | head -1 || true
  )"
  case "$disk_percent" in
    ''|*[!0-9]*) say "WARNING: could not read Elasticsearch disk usage; continuing" >&2 ;;
    *)
      if [ "$disk_percent" -ge 90 ]; then
        say "Elasticsearch data node is ${disk_percent}% full." >&2
        say "  Past cluster.routing.allocation.disk.watermark.high, new shards will not be" >&2
        say "  allocated and this rebuild cannot finish. Free disk or relocate the volume:" >&2
        say "    bash ../mx-common/scripts/manage.sh migrate-storage /data/k8s/mx-runtime/mx-common/k8s" >&2
        die "refusing to start a multi-hour rebuild that cannot be allocated"
      fi
      [ "$disk_percent" -ge 85 ] \
        && say "WARNING: Elasticsearch data node is ${disk_percent}% full; the rebuild needs room for a second copy" >&2
      ;;
  esac

  say "running one-shot reconciliation in ${executor_deployment}; configured tokenizer fallback is forbidden"
  if ! kubectl -n "$namespace" exec "deployment/${executor_deployment}" -- \
    node server/scripts/reindex-search.mjs; then
    die "search reindex failed tokenizer integrity or projection checks; no fallback-token batch was accepted"
  fi
  say "search reindex completed with verified configured-tokenizer output"
  if [ "$projector_unready" = 1 ]; then
    say "Projector recovery is asynchronous; verify with: kubectl -n ${namespace} rollout status deployment/${projector_deployment} --timeout=180s"
  fi
}

ops_action() {
  local environment="${1:-}"
  local action="${2:-}"
  local sync_launcher_override_set=0
  local sync_launcher_override=""
  [ "$environment" = internal-production ] || die "Only ops internal-production is supported"
  need kubectl
  if [ "${MX_INSIGHT_SYNC_LAUNCHER+x}" = x ]; then
    sync_launcher_override_set=1
    sync_launcher_override="$MX_INSIGHT_SYNC_LAUNCHER"
  fi
  load_env_file "${ROOT_DIR}/.env.internal"
  # A one-shot safety choice on the command line must beat the persisted env
  # file. The Launcher delegator explicitly passes 1; an independent Hub deploy
  # explicitly passes 0 so it cannot unexpectedly roll the login control plane.
  if [ "$sync_launcher_override_set" = 1 ]; then
    MX_INSIGHT_SYNC_LAUNCHER="$sync_launcher_override"
    export MX_INSIGHT_SYNC_LAUNCHER
  fi
  case "$action" in
    plan)
      for file in 00-namespace.yaml 05-serviceaccount.yaml 20-migration-job.yaml 30-public-api.yaml 31-admin-api.yaml 32-projector.yaml 33-ingest.yaml 34-classifier.yaml 40-network-policy.yaml; do
        render_file "${K8S_DIR}/${file}"
      done
      ;;
    deploy)
      require_production_env
      need docker
      need ctr
      require_single_k8s_node
      init_deploy_runtime
      acquire_deploy_lock
      ensure_shared_data_plane
      build_and_import_image
      apply_k8s
      k8s_smoke
      ensure_default_api_key
      print_deploy_summary
      say "Internal production deploy OK."
      ;;
    apply)
      require_production_env
      need docker
      need ctr
      require_single_k8s_node
      init_deploy_runtime
      acquire_deploy_lock
      ensure_shared_data_plane
      apply_k8s
      k8s_smoke
      ensure_default_api_key
      print_deploy_summary
      ;;
    decommission-local-postgres)
      need kubectl
      decommission_local_postgres
      ;;
    status)
      kubectl -n mx-insight-hub get pods,services,pvc,jobs
      kubectl get pv "$LEGACY_POSTGRES_PV_NAME" -o wide 2>/dev/null || true
      ;;
    smoke)
      : "${MX_INSIGHT_ADMIN_TOKEN:?MX_INSIGHT_ADMIN_TOKEN is required for smoke}"
      init_deploy_runtime
      k8s_smoke
      ;;
    logs)
      kubectl -n mx-insight-hub logs deployment/mx-insight-hub-admin --tail=250
      kubectl -n mx-insight-hub logs deployment/mx-insight-hub-public --tail=250
      ;;
    reindex-search)
      reindex_search
      ;;
    down)
      kubectl -n mx-insight-hub scale \
        deployment/mx-insight-hub-admin deployment/mx-insight-hub-public --replicas=0
      say "Hub API workloads scaled to zero. PostgreSQL, PVC, namespace, and Secrets were preserved."
      ;;
    *) usage; exit 2 ;;
  esac
}

main() {
  case "${1:-}" in
    local)
      shift
      local_action "${1:-}"
      ;;
    ops)
      shift
      ops_action "${1:-}" "${2:-}"
      ;;
    # Full idempotent production deploy in one word. Everything it runs is
    # already idempotent -- shared data plane, database provisioning, image
    # build, migrations, workload rollout, smoke -- so re-running it after a
    # partial failure resumes rather than restarts.
    deploy|redeploy)
      ops_action internal-production deploy
      ;;
    verify)
      ops_action internal-production smoke
      ;;
    verify-data-path)
      shift
      load_env_file "${ROOT_DIR}/.env.internal"
      verify_data_path "${1:-}"
      ;;
    reindex-search)
      ops_action internal-production reindex-search
      ;;
    search)
      shift
      search_action "${1:-}"
      ;;
    up|rebuild|status|logs|smoke|data-smoke|bootstrap|down)
      local_action "$1"
      ;;
    *) usage; exit 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
