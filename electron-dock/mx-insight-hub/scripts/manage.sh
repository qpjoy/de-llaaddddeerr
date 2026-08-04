#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_DOCK_DIR="$(cd "${ROOT_DIR}/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/compose/docker-compose.yml"
SEARCH_COMPOSE_DIR="${ROOT_DIR}/deploy/compose/search"
SEARCH_COMPOSE_FILE="${SEARCH_COMPOSE_DIR}/docker-compose.yml"
K8S_DIR="${ROOT_DIR}/deploy/k8s/internal"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
POSTGRES_RUNTIME_IMAGE="postgres:16-bookworm"
POSTGRES_PV_NAME="mx-insight-hub-postgres-local-pv"
POSTGRES_PVC_NAME="data-mx-insight-hub-postgres-0"
POSTGRES_POD_NAME="mx-insight-hub-postgres-0"
POSTGRES_HOST_PATH="/var/lib/mx-insight-hub/k8s/postgres"

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
  local secret_name pvc_phase pv_phase
  secret_name="$(
    kubectl -n "$namespace" get secret mx-insight-hub-secrets \
      --ignore-not-found -o name
  )"
  if [ -z "$secret_name" ]; then
    pvc_phase="$(
      kubectl -n "$namespace" get pvc "$POSTGRES_PVC_NAME" \
        -o jsonpath='{.status.phase}' --ignore-not-found
    )"
    pv_phase="$(
      kubectl get pv "$POSTGRES_PV_NAME" \
        -o jsonpath='{.status.phase}' --ignore-not-found
    )"
    if [ "$pvc_phase" = Bound ] || [ -n "$pv_phase" ] \
      || [ -e "${POSTGRES_HOST_PATH}/PG_VERSION" ]; then
      die "mx-insight-hub-secrets is missing while retained PostgreSQL storage exists. Restore the original Secret/.env.internal values before deploying; automatic credential reconstruction is unsafe."
    fi
    return 0
  fi
  need base64
  require_existing_secret_match \
    "$namespace" \
    postgres-password \
    "$MX_INSIGHT_POSTGRES_PASSWORD" \
    "PostgreSQL password differs from the retained deployment; automatic rotation is blocked to protect existing PGDATA. Restore the original .env.internal value or use an explicit database password-rotation procedure."
  require_existing_secret_match \
    "$namespace" \
    MX_INSIGHT_API_KEY_PEPPER \
    "$MX_INSIGHT_API_KEY_PEPPER" \
    "API-key pepper differs from the retained deployment; automatic rotation is blocked because existing API keys would stop validating. Restore the original .env.internal value or use an explicit key-rotation procedure."
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

ensure_k8s_runtime_image() {
  local image="$1"
  local canonical
  canonical="$(canonical_image_ref "$image")"
  if containerd_image_ref_present "$canonical"; then
    say "containerd runtime image already present: $canonical"
    return 0
  fi
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    say "pull runtime image through Docker: $image"
    docker pull "$image"
    DEPLOY_PULLED_RUNTIME_IMAGE="$image"
  fi
  containerd_import_docker_image "$image"
}

build_and_import_image() {
  local image="${MX_INSIGHT_IMAGE:-mx-insight-hub:shadow}"
  need docker
  need ctr
  DEPLOY_PREVIOUS_DOCKER_IMAGE_ID="$(
    docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true
  )"
  docker build \
    --rm \
    --force-rm \
    --label dev.qpjoy.mx-insight-hub.project=mx-insight-hub \
    --label dev.qpjoy.mx-insight-hub.image=internal \
    --build-context "ui_design=${ELECTRON_DOCK_DIR}/mx-launcher/ui-design" \
    -t "$image" \
    -f "${ROOT_DIR}/Dockerfile" \
    "$ROOT_DIR"
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

prepare_postgres_host_path() {
  if [ "$(id -u)" -eq 0 ]; then
    install -d -o 999 -g 999 -m 0700 "$POSTGRES_HOST_PATH"
  else
    need sudo
    sudo install -d -o 999 -g 999 -m 0700 "$POSTGRES_HOST_PATH"
  fi
}

validate_postgres_local_pv() {
  local path reclaim claim_namespace claim_name storage_class
  path="$(kubectl get pv "$POSTGRES_PV_NAME" -o jsonpath='{.spec.hostPath.path}')"
  reclaim="$(kubectl get pv "$POSTGRES_PV_NAME" -o jsonpath='{.spec.persistentVolumeReclaimPolicy}')"
  claim_namespace="$(kubectl get pv "$POSTGRES_PV_NAME" -o jsonpath='{.spec.claimRef.namespace}')"
  claim_name="$(kubectl get pv "$POSTGRES_PV_NAME" -o jsonpath='{.spec.claimRef.name}')"
  storage_class="$(kubectl get pv "$POSTGRES_PV_NAME" -o jsonpath='{.spec.storageClassName}')"
  [ "$path" = "$POSTGRES_HOST_PATH" ] \
    || die "$POSTGRES_PV_NAME points to unexpected hostPath $path"
  [ "$reclaim" = Retain ] \
    || die "$POSTGRES_PV_NAME must use Retain, found $reclaim"
  [ "$claim_namespace" = mx-insight-hub ] && [ "$claim_name" = "$POSTGRES_PVC_NAME" ] \
    || die "$POSTGRES_PV_NAME has an unexpected claimRef ${claim_namespace}/${claim_name}"
  [ -z "$storage_class" ] \
    || die "$POSTGRES_PV_NAME must not use a StorageClass, found $storage_class"
}

ensure_postgres_local_pv() {
  local phase
  prepare_postgres_host_path
  phase="$(
    kubectl get pv "$POSTGRES_PV_NAME" \
      -o jsonpath='{.status.phase}' --ignore-not-found
  )"
  if [ -n "$phase" ]; then
    validate_postgres_local_pv
  fi
  case "$phase" in
    Released|Failed)
      say "repair $phase local PV metadata; retained data stays at $POSTGRES_HOST_PATH"
      kubectl delete pv "$POSTGRES_PV_NAME" --wait=false
      kubectl wait --for=delete "pv/${POSTGRES_PV_NAME}" --timeout=60s
      ;;
    Available|Bound)
      say "reuse local PostgreSQL PV $POSTGRES_PV_NAME ($phase)"
      return 0
      ;;
    "")
      ;;
    *)
      die "$POSTGRES_PV_NAME is in unsupported phase $phase"
      ;;
  esac
  kubectl apply -f "${K8S_DIR}/08-postgres-local-pv.yaml"
}

ensure_postgres_storage() {
  local pvc_phase pvc_class pvc_volume default_class pv_phase
  pvc_phase="$(
    kubectl -n mx-insight-hub get pvc "$POSTGRES_PVC_NAME" \
      -o jsonpath='{.status.phase}' --ignore-not-found
  )"
  pvc_class="$(
    kubectl -n mx-insight-hub get pvc "$POSTGRES_PVC_NAME" \
      -o jsonpath='{.spec.storageClassName}' --ignore-not-found
  )"
  pvc_volume="$(
    kubectl -n mx-insight-hub get pvc "$POSTGRES_PVC_NAME" \
      -o jsonpath='{.spec.volumeName}' --ignore-not-found
  )"
  pv_phase="$(
    kubectl get pv "$POSTGRES_PV_NAME" \
      -o jsonpath='{.status.phase}' --ignore-not-found
  )"

  if [ "$pvc_phase" = Bound ]; then
    if [ "$pvc_volume" = "$POSTGRES_PV_NAME" ]; then
      validate_postgres_local_pv
      prepare_postgres_host_path
      say "reuse bound PostgreSQL PVC ${pvc_volume}"
    else
      say "reuse bound PostgreSQL PVC backed by ${pvc_volume:-an external provisioner}"
    fi
    return 0
  fi
  if [ -n "$pvc_volume" ] && [ "$pvc_volume" != "$POSTGRES_PV_NAME" ]; then
    die "$POSTGRES_PVC_NAME requests unexpected PV $pvc_volume"
  fi
  if [ -n "$pv_phase" ]; then
    ensure_postgres_local_pv
    return 0
  fi
  if [ -n "$pvc_class" ]; then
    [ -z "$pvc_phase" ] || [ "$pvc_phase" = Pending ] \
      || die "$POSTGRES_PVC_NAME is in unsupported phase $pvc_phase"
    say "PostgreSQL PVC uses StorageClass $pvc_class; wait for its provisioner"
    return 0
  fi
  if [ "$pvc_phase" = Pending ]; then
    say "existing classless PostgreSQL PVC is immutable; bind a retained local PV in place"
    ensure_postgres_local_pv
    return 0
  fi
  default_class="$(k8s_default_storage_class)"
  if [ -n "$default_class" ]; then
    [ -z "$pvc_phase" ] \
      || die "$POSTGRES_PVC_NAME is in unsupported phase $pvc_phase"
    say "use default StorageClass $default_class for PostgreSQL"
    return 0
  fi
  [ -z "$pvc_phase" ] || [ "$pvc_phase" = Pending ] \
    || die "$POSTGRES_PVC_NAME is in unsupported phase $pvc_phase"
  say "no usable StorageClass detected; prepare retained single-node PostgreSQL PV"
  ensure_postgres_local_pv
}

reconcile_postgres_pod_security_context() {
  local namespace="mx-insight-hub"
  local desired_user="999"
  local template_pod_user template_container_user template_user
  local pod_ref pod_pod_user pod_container_user pod_user

  template_pod_user="$(
    kubectl -n "$namespace" get statefulset mx-insight-hub-postgres \
      -o jsonpath='{.spec.template.spec.securityContext.runAsUser}'
  )"
  template_container_user="$(
    kubectl -n "$namespace" get statefulset mx-insight-hub-postgres \
      -o 'jsonpath={.spec.template.spec.containers[?(@.name=="postgres")].securityContext.runAsUser}'
  )"
  template_user="${template_container_user:-$template_pod_user}"
  [ "$template_user" = "$desired_user" ] \
    || die "PostgreSQL StatefulSet must run as UID $desired_user; found ${template_user:-root/default}"

  pod_ref="$(
    kubectl -n "$namespace" get pod "$POSTGRES_POD_NAME" \
      --ignore-not-found -o name
  )"
  [ -n "$pod_ref" ] || return 0
  pod_pod_user="$(
    kubectl -n "$namespace" get pod "$POSTGRES_POD_NAME" \
      --ignore-not-found -o jsonpath='{.spec.securityContext.runAsUser}'
  )"
  pod_container_user="$(
    kubectl -n "$namespace" get pod "$POSTGRES_POD_NAME" \
      --ignore-not-found \
      -o 'jsonpath={.spec.containers[?(@.name=="postgres")].securityContext.runAsUser}'
  )"
  pod_user="${pod_container_user:-$pod_pod_user}"
  if [ "$pod_user" != "$desired_user" ]; then
    say "replace legacy PostgreSQL Pod running as ${pod_user:-root/default}; PVC and PGDATA stay attached"
    kubectl -n "$namespace" delete pod "$POSTGRES_POD_NAME" \
      --ignore-not-found --wait=false
  fi
}

k8s_postgres_diagnostics() {
  say "PostgreSQL readiness diagnostics"
  kubectl -n mx-insight-hub get statefulset mx-insight-hub-postgres \
    -o jsonpath='StatefulSet runAsUser={.spec.template.spec.securityContext.runAsUser}{" image="}{.spec.template.spec.containers[?(@.name=="postgres")].image}{"\n"}' || true
  kubectl -n mx-insight-hub get pod "$POSTGRES_POD_NAME" \
    -o jsonpath='Pod runAsUser={.spec.securityContext.runAsUser}{" imageID="}{.status.containerStatuses[?(@.name=="postgres")].imageID}{"\n"}' || true
  kubectl -n mx-insight-hub get statefulset,pod,pvc -o wide || true
  kubectl get pv "$POSTGRES_PV_NAME" -o wide || true
  kubectl get storageclass || true
  kubectl -n mx-insight-hub describe pvc "$POSTGRES_PVC_NAME" || true
  kubectl -n mx-insight-hub describe pod mx-insight-hub-postgres-0 || true
  kubectl -n mx-insight-hub logs mx-insight-hub-postgres-0 -c postgres --tail=200 || true
  kubectl -n mx-insight-hub logs mx-insight-hub-postgres-0 -c postgres --previous --tail=200 || true
  kubectl -n mx-insight-hub get events --sort-by=.lastTimestamp | tail -n 80 || true
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

apply_k8s() {
  local namespace="mx-insight-hub"
  ensure_k8s_runtime_image "$POSTGRES_RUNTIME_IMAGE"
  kubectl apply -f "${K8S_DIR}/00-namespace.yaml"
  kubectl apply -f "${K8S_DIR}/05-serviceaccount.yaml"
  validate_existing_runtime_secret
  create_runtime_config
  sync_launcher_secret
  ensure_postgres_storage
  kubectl apply -f "${K8S_DIR}/10-postgres.yaml"
  reconcile_postgres_pod_security_context
  if ! kubectl -n "$namespace" rollout status \
    statefulset/mx-insight-hub-postgres --timeout=300s; then
    k8s_postgres_diagnostics
    die "PostgreSQL did not become ready"
  fi

  kubectl -n "$namespace" delete job mx-insight-hub-migrate --ignore-not-found
  render_file "${K8S_DIR}/20-migration-job.yaml" | kubectl apply -f -
  if ! kubectl -n "$namespace" wait \
    --for=condition=complete job/mx-insight-hub-migrate --timeout=300s; then
    k8s_migration_diagnostics
    die "migration did not complete"
  fi

  render_file "${K8S_DIR}/30-public-api.yaml" | kubectl apply -f -
  render_file "${K8S_DIR}/31-admin-api.yaml" | kubectl apply -f -
  kubectl apply -f "${K8S_DIR}/40-network-policy.yaml"
  kubectl -n "$namespace" rollout restart deployment/mx-insight-hub-public deployment/mx-insight-hub-admin
  if ! kubectl -n "$namespace" rollout status \
    deployment/mx-insight-hub-public --timeout=300s \
    || ! kubectl -n "$namespace" rollout status \
      deployment/mx-insight-hub-admin --timeout=300s; then
    k8s_api_diagnostics
    die "Hub API workloads did not become ready"
  fi
  refresh_launcher_workload
}

k8s_smoke() {
  local namespace="mx-insight-hub"
  local port="${MX_INSIGHT_SMOKE_PORT:-28151}"
  local log_path="${DEPLOY_TMP_DIR}/port-forward.log"
  kubectl -n "$namespace" port-forward service/mx-insight-hub-admin "${port}:18151" >"$log_path" 2>&1 &
  DEPLOY_PORT_FORWARD_PID=$!
  if ! wait_http "http://127.0.0.1:${port}/health/live" 30; then
    sed -n '1,120p' "$log_path" >&2 || true
    die "Admin port-forward did not become ready"
  fi
  MX_SMOKE_BASE_URL="http://127.0.0.1:${port}" \
  MX_INSIGHT_ADMIN_TOKEN="$MX_INSIGHT_ADMIN_TOKEN" \
    node "${ROOT_DIR}/scripts/smoke.mjs"
  kill "$DEPLOY_PORT_FORWARD_PID" >/dev/null 2>&1 || true
  wait "$DEPLOY_PORT_FORWARD_PID" 2>/dev/null || true
  DEPLOY_PORT_FORWARD_PID=""
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
      need docker
      need ctr
      require_single_k8s_node
      init_deploy_runtime
      acquire_deploy_lock
      build_and_import_image
      apply_k8s
      k8s_smoke
      say "Internal production deploy OK. Public and Admin Services remain separate."
      ;;
    apply)
      require_production_env
      need docker
      need ctr
      require_single_k8s_node
      init_deploy_runtime
      acquire_deploy_lock
      apply_k8s
      k8s_smoke
      ;;
    status)
      kubectl -n mx-insight-hub get pods,services,pvc,jobs
      kubectl get pv "$POSTGRES_PV_NAME" -o wide 2>/dev/null || true
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
