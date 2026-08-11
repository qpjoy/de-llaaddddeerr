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
  say "single-node Internal target: $(printf '%s\n' "$nodes" | awk 'NF { print; exit }')"
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
  bash scripts/manage.sh verify-data-path [api-key]
                                         # 端到端：search -> PG -> outbox -> ES

  bash scripts/manage.sh ops internal-production plan|deploy|apply|status|smoke|logs|down
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
  local database_url="${MX_INSIGHT_DATABASE_URL:?ensure_shared_data_plane must run before create_runtime_config}"
  local -a secret_args=(
    --from-literal=DATABASE_URL="$database_url"
    --from-literal=MX_INSIGHT_ADMIN_TOKEN="$MX_INSIGHT_ADMIN_TOKEN"
    --from-literal=MX_INSIGHT_API_KEY_PEPPER="$MX_INSIGHT_API_KEY_PEPPER"
    --from-literal=NIGHT_ALL_SERVICE_TOKEN="${NIGHT_ALL_SERVICE_TOKEN:-}"
    --from-literal=NIGHT_ALL_EXPORT_TOKEN="${NIGHT_ALL_EXPORT_TOKEN:-}"
  )
  if [ -n "${MX_INSIGHT_TG_MONITOR_DATABASE_URL:-}" ]; then
    secret_args+=(--from-literal=MX_INSIGHT_TG_MONITOR_DATABASE_URL="$MX_INSIGHT_TG_MONITOR_DATABASE_URL")
  fi

  # Shared data-plane endpoints. Empty values are meaningful: an unset
  # Elasticsearch URL makes the Hub run search-free rather than fail to start,
  # which is what keeps the Night-All path independent of the search rollout.
  local elasticsearch_url="${MX_COMMON_ELASTICSEARCH_URL:-http://mx-common-elasticsearch.mx-common.svc.cluster.local:9200}"
  local redis_url="${MX_COMMON_REDIS_URL:-redis://mx-common-redis.mx-common.svc.cluster.local:6379}"
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
    --from-literal=MX_COMMON_QUEUE_DRIVER="${MX_COMMON_QUEUE_DRIVER:-postgres}" \
    --from-literal=MX_INSIGHT_EMBEDDING_MODEL="${MX_INSIGHT_EMBEDDING_MODEL:-}" \
    --from-literal=MX_INSIGHT_EMBEDDING_DIMENSIONS="${MX_INSIGHT_EMBEDDING_DIMENSIONS:-}" \
    --from-literal=MX_INSIGHT_LAUNCHER_URL="${MX_INSIGHT_LAUNCHER_URL:-}" \
    --from-literal=MX_INSIGHT_LAUNCHER_AUDIENCE="${MX_INSIGHT_LAUNCHER_AUDIENCE:-mx-insight-hub}" \
    --from-literal=MX_INSIGHT_LAUNCHER_ADMIN_SCOPES="${MX_INSIGHT_LAUNCHER_ADMIN_SCOPES:-}" \
    --from-literal=MX_INSIGHT_BACKFILL_PLATFORMS="${MX_INSIGHT_BACKFILL_PLATFORMS:-xiaohongshu,douyin,twitter}" \
    --from-literal=MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS="${MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS:-60000}" \
    --from-literal=MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE="${MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE:-1000}" \
    --from-literal=MX_INSIGHT_AGENT_PROVIDERS="${MX_INSIGHT_AGENT_PROVIDERS:-}" \
    --from-literal=MX_INSIGHT_EMBEDDING_PROVIDERS="${MX_INSIGHT_EMBEDDING_PROVIDERS:-}" \
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
    docker build \
      --rm \
      --force-rm \
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

  render_file "${K8S_DIR}/30-public-api.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/31-admin-api.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/32-projector.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/33-ingest.yaml" | kubectl apply -f -
  kubectl apply -f "${K8S_DIR}/40-network-policy.yaml"
  kubectl -n "$namespace" rollout restart deployment/mx-insight-hub-public deployment/mx-insight-hub-admin
  if ! kubectl -n "$namespace" rollout status \
    deployment/mx-insight-hub-public --timeout=300s \
    || ! kubectl -n "$namespace" rollout status \
      deployment/mx-insight-hub-admin --timeout=300s; then
    k8s_api_diagnostics
    die "Hub API workloads did not become ready"
  fi

  # The projector is scaled to match search availability rather than deployed
  # unconditionally: with no Elasticsearch URL it would exit(2) and crash-loop,
  # turning "search is not configured" into a permanently red workload. Outbox
  # events accumulate meanwhile and are drained once it is scaled back up --
  # that is exactly what the outbox is for.
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

ops_action() {
  local environment="${1:-}"
  local action="${2:-}"
  [ "$environment" = internal-production ] || die "Only ops internal-production is supported"
  need kubectl
  load_env_file "${ROOT_DIR}/.env.internal"
  case "$action" in
    plan)
      for file in 00-namespace.yaml 05-serviceaccount.yaml 20-migration-job.yaml 30-public-api.yaml 31-admin-api.yaml 32-projector.yaml 33-ingest.yaml 40-network-policy.yaml; do
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
