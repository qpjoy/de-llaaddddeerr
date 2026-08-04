#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_DOCK_DIR="$(cd "${ROOT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/compose/docker-compose.yml"
SEARCH_COMPOSE_DIR="${ROOT_DIR}/deploy/compose/search"
SEARCH_COMPOSE_FILE="${SEARCH_COMPOSE_DIR}/docker-compose.yml"
K8S_DIR="${ROOT_DIR}/deploy/k8s/internal"
RUNTIME_DIR="${ROOT_DIR}/.runtime"

say() { printf '[mx-insight-hub] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

usage() {
  cat <<'EOF'
MX Insight Hub lifecycle

Local Docker:
  bash scripts/manage.sh local up|rebuild|status|logs|smoke|data-smoke|bootstrap|down
  bash scripts/manage.sh up|rebuild|status|logs|smoke|down

Optional local search (independent from Hub startup):
  bash scripts/manage.sh search plan|up|status|logs|down

Internal Kubernetes:
  bash scripts/manage.sh ops internal-production plan|deploy|apply|status|smoke|logs|down

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
  die "Timed out waiting for ${url}"
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
  : "${MX_INSIGHT_POSTGRES_PASSWORD:?MX_INSIGHT_POSTGRES_PASSWORD is required in .env.internal or the environment}"
  : "${NIGHT_ALL_BASE_URL:?NIGHT_ALL_BASE_URL is required in .env.internal or the environment}"
  [ "${#MX_INSIGHT_ADMIN_TOKEN}" -ge 32 ] || die "MX_INSIGHT_ADMIN_TOKEN must be at least 32 characters"
  [ "${#MX_INSIGHT_API_KEY_PEPPER}" -ge 32 ] || die "MX_INSIGHT_API_KEY_PEPPER must be at least 32 characters"
  [ "${#MX_INSIGHT_POSTGRES_PASSWORD}" -ge 24 ] || die "MX_INSIGHT_POSTGRES_PASSWORD must be at least 24 characters"
  case "$MX_INSIGHT_ADMIN_TOKEN:$MX_INSIGHT_API_KEY_PEPPER:$MX_INSIGHT_POSTGRES_PASSWORD" in
    *local-*-change-me*) die "Local example secrets cannot be used for internal-production" ;;
  esac
  case "$NIGHT_ALL_BASE_URL" in
    http://*|https://*) ;;
    *) die "NIGHT_ALL_BASE_URL must be an http(s) URL" ;;
  esac
  if [ -n "${NIGHT_ALL_SERVICE_TOKEN:-}" ] && [ "${#NIGHT_ALL_SERVICE_TOKEN}" -lt 32 ]; then
    die "NIGHT_ALL_SERVICE_TOKEN must be empty or at least 32 characters"
  fi
  case "$MX_INSIGHT_POSTGRES_PASSWORD" in
    *[!A-Za-z0-9._~-]*) die "MX_INSIGHT_POSTGRES_PASSWORD must be URL-safe (A-Z a-z 0-9 . _ ~ -)" ;;
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

create_runtime_config() {
  local namespace="mx-insight-hub"
  local database_url="postgres://mx_insight:${MX_INSIGHT_POSTGRES_PASSWORD}@mx-insight-hub-postgres.${namespace}.svc.cluster.local:5432/mx_insight_hub"

  kubectl -n "$namespace" create configmap mx-insight-hub-config \
    --from-literal=MX_INSIGHT_HOST=0.0.0.0 \
    --from-literal=MX_INSIGHT_STORE=postgres \
    --from-literal=NIGHT_ALL_BASE_URL="$NIGHT_ALL_BASE_URL" \
    --from-literal=NIGHT_ALL_TIMEOUT_MS="${NIGHT_ALL_TIMEOUT_MS:-30000}" \
    --from-literal=NIGHT_ALL_READY_MODE="${NIGHT_ALL_READY_MODE:-ready_only}" \
    --dry-run=client -o yaml | kubectl apply -f -

  kubectl -n "$namespace" create secret generic mx-insight-hub-secrets \
    --from-literal=postgres-password="$MX_INSIGHT_POSTGRES_PASSWORD" \
    --from-literal=DATABASE_URL="$database_url" \
    --from-literal=MX_INSIGHT_ADMIN_TOKEN="$MX_INSIGHT_ADMIN_TOKEN" \
    --from-literal=MX_INSIGHT_API_KEY_PEPPER="$MX_INSIGHT_API_KEY_PEPPER" \
    --from-literal=NIGHT_ALL_SERVICE_TOKEN="${NIGHT_ALL_SERVICE_TOKEN:-}" \
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

build_and_import_image() {
  local image="${MX_INSIGHT_IMAGE:-mx-insight-hub:shadow}"
  local tmp_dir
  need docker
  docker build \
    --build-context "ui_design=${ELECTRON_DOCK_DIR}/mx-launcher/ui-design" \
    -t "$image" \
    -f "${ROOT_DIR}/Dockerfile" \
    "$ROOT_DIR"
  if command -v ctr >/dev/null 2>&1; then
    tmp_dir="$(mktemp -d)"
    trap 'rm -rf -- "${tmp_dir:-}"' RETURN
    docker image save -o "${tmp_dir}/mx-insight-hub.tar" "$image"
    if [ "$(id -u)" -eq 0 ]; then
      ctr -n k8s.io images import "${tmp_dir}/mx-insight-hub.tar"
    else
      sudo ctr -n k8s.io images import "${tmp_dir}/mx-insight-hub.tar"
    fi
    rm -rf -- "$tmp_dir"
    trap - RETURN
  else
    say "ctr is unavailable; assuming the Kubernetes runtime can use local image ${image}."
  fi
}

apply_k8s() {
  local namespace="mx-insight-hub"
  kubectl apply -f "${K8S_DIR}/00-namespace.yaml"
  kubectl apply -f "${K8S_DIR}/05-serviceaccount.yaml"
  create_runtime_config
  sync_launcher_secret
  kubectl apply -f "${K8S_DIR}/10-postgres.yaml"
  kubectl -n "$namespace" rollout status statefulset/mx-insight-hub-postgres --timeout=180s

  kubectl -n "$namespace" delete job mx-insight-hub-migrate --ignore-not-found
  render_file "${K8S_DIR}/20-migration-job.yaml" | kubectl apply -f -
  kubectl -n "$namespace" wait --for=condition=complete job/mx-insight-hub-migrate --timeout=180s

  render_file "${K8S_DIR}/30-public-api.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/31-admin-api.yaml" | kubectl apply -f -
  kubectl apply -f "${K8S_DIR}/40-network-policy.yaml"
  kubectl -n "$namespace" rollout restart deployment/mx-insight-hub-public deployment/mx-insight-hub-admin
  kubectl -n "$namespace" rollout status deployment/mx-insight-hub-public --timeout=240s
  kubectl -n "$namespace" rollout status deployment/mx-insight-hub-admin --timeout=240s
  refresh_launcher_workload
}

k8s_smoke() {
  local namespace="mx-insight-hub"
  local port="${MX_INSIGHT_SMOKE_PORT:-28151}"
  kubectl -n "$namespace" port-forward service/mx-insight-hub-admin "${port}:18151" >/tmp/mx-insight-hub-port-forward.log 2>&1 &
  local forward_pid=$!
  trap 'kill "${forward_pid}" >/dev/null 2>&1 || true' RETURN
  wait_http "http://127.0.0.1:${port}/health/live" 30
  MX_SMOKE_BASE_URL="http://127.0.0.1:${port}" \
  MX_INSIGHT_ADMIN_TOKEN="$MX_INSIGHT_ADMIN_TOKEN" \
    node "${ROOT_DIR}/scripts/smoke.mjs"
  kill "$forward_pid" >/dev/null 2>&1 || true
  wait "$forward_pid" 2>/dev/null || true
  trap - RETURN
}

ops_action() {
  local environment="${1:-}"
  local action="${2:-}"
  [ "$environment" = internal-production ] || die "Only ops internal-production is supported"
  need kubectl
  load_env_file "${ROOT_DIR}/.env.internal"
  case "$action" in
    plan)
      for file in 00-namespace.yaml 05-serviceaccount.yaml 10-postgres.yaml 20-migration-job.yaml 30-public-api.yaml 31-admin-api.yaml 40-network-policy.yaml; do
        render_file "${K8S_DIR}/${file}"
      done
      ;;
    deploy)
      require_production_env
      build_and_import_image
      apply_k8s
      k8s_smoke
      say "Internal production deploy OK. Public and Admin Services remain separate."
      ;;
    apply)
      require_production_env
      apply_k8s
      k8s_smoke
      ;;
    status)
      kubectl -n mx-insight-hub get pods,services,pvc,jobs
      ;;
    smoke)
      : "${MX_INSIGHT_ADMIN_TOKEN:?MX_INSIGHT_ADMIN_TOKEN is required for smoke}"
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

case "${1:-}" in
  local)
    shift
    local_action "${1:-}"
    ;;
  ops)
    shift
    ops_action "${1:-}" "${2:-}"
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
