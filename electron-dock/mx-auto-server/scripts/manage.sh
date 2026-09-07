#!/usr/bin/env bash
# Independent lifecycle for mx-auto-server. This script never reads or writes
# an MX-H2I namespace, deployment, Secret, database or PVC.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_DOCK_DIR="$(cd "${ROOT_DIR}/.." && pwd)"
K8S_DIR="${ROOT_DIR}/deploy/k8s/internal"
NAMESPACE="mx-auto"
IMAGE=""
SECRET_CHECKSUM=""
RESOURCE_POLICY_CHECKSUM=""
CLUSTER_CONTEXT=""
ENV_FILE="${MX_AUTO_ENV_FILE:-${ROOT_DIR}/.env}"

say() { printf '[mx-auto] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
kube() { kubectl -n "$NAMESPACE" "$@"; }

usage() {
  cat <<'EOF'
mx-auto-server lifecycle

  bash scripts/manage.sh dev
  bash scripts/manage.sh test
  bash scripts/manage.sh migrate
  bash scripts/manage.sh deploy
  bash scripts/manage.sh verify
  bash scripts/manage.sh status
  bash scripts/manage.sh logs [server|migrate|postgres]
  bash scripts/manage.sh down

Configuration is read from .env (or MX_AUTO_ENV_FILE). Kubernetes requires
MX_AUTO_ADMIN_TOKEN. The deploy owns an independent PostgreSQL instance and
preserves its password, encryption key, Secret and PVC across redeploys.
EOF
}

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
  export MX_AUTO_LAUNCHER_AUDIENCE="${MX_AUTO_LAUNCHER_AUDIENCE:-mx-sdk}"
  export MX_AUTO_LAUNCHER_NEGATIVE_CACHE_TTL_MS="${MX_AUTO_LAUNCHER_NEGATIVE_CACHE_TTL_MS:-3000}"
  export MX_AUTO_LAUNCHER_INTROSPECTION_WINDOW_MS="${MX_AUTO_LAUNCHER_INTROSPECTION_WINDOW_MS:-10000}"
  export MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS="${MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS:-30}"
  export MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT="${MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT:-8}"
  export MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE="${MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE:-6}"
  export MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE="${MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE:-2}"
  export MX_AUTO_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS="${MX_AUTO_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS:-10000}"
  export MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS="${MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS:-10}"
  export MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT="${MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT:-4}"
  export MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE="${MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE:-3}"
  export MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE="${MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE:-1}"
}

require_admin_token() {
  [ -n "${MX_AUTO_ADMIN_TOKEN:-}" ] || die "MX_AUTO_ADMIN_TOKEN is required in ${ENV_FILE}"
}

b64() { base64 -w0 2>/dev/null || base64; }

read_secret() {
  kube get secret mx-auto-secrets \
    -o "jsonpath={.data.$1}" 2>/dev/null | base64 -d 2>/dev/null || true
}

resolve_preserved_secret() {
  local name="$1" label="$2" bytes="$3" configured existing
  configured="${!name-}"
  existing="$(read_secret "$name")"
  if [ -n "$existing" ]; then
    if [ -n "$configured" ] && [ "$configured" != "$existing" ]; then
      die "${label} already exists; ordinary deploy cannot rotate ${name}"
    fi
    printf -v "$name" '%s' "$existing"
    export "$name"
    return
  fi
  if kube get pvc mx-auto-postgres-data >/dev/null 2>&1; then
    die "${label} is missing while the database PVC exists; restore the original Secret before deploy"
  fi
  if [ -z "$configured" ]; then
    configured="$(openssl rand -hex "$bytes")"
    say "generated ${label}"
  fi
  printf -v "$name" '%s' "$configured"
  export "$name"
}

apply_namespace() {
  kubectl apply -f "${K8S_DIR}/00-namespace.yaml" >/dev/null
}

resolve_database() {
  resolve_preserved_secret MX_AUTO_POSTGRES_PASSWORD "the bundled PostgreSQL password" 24
  [[ "$MX_AUTO_POSTGRES_PASSWORD" =~ ^[A-Za-z0-9._~-]+$ ]] || \
    die "MX_AUTO_POSTGRES_PASSWORD must contain only URL-safe characters"
  export MX_AUTO_DATABASE_URL="postgres://mx_auto:${MX_AUTO_POSTGRES_PASSWORD}@mx-auto-postgres:5432/mx_auto"
}

resolve_secret_key() {
  resolve_preserved_secret MX_AUTO_SECRET_KEY "the credential-encryption key" 32
}

resolve_public_url() {
  [ -z "${MX_AUTO_PUBLIC_URL:-}" ] || return 0
  local context node_ip
  context="$(kubectl config current-context 2>/dev/null || true)"
  case "$context" in
    docker-desktop | rancher-desktop)
      MX_AUTO_PUBLIC_URL="http://127.0.0.1:30880"
      ;;
    kind-*)
      # A kind NodePort is not exposed to the host unless the cluster was
      # created with an explicit extraPortMapping. Do not print a dead URL.
      MX_AUTO_PUBLIC_URL=""
      ;;
    *)
      node_ip="$(kubectl get nodes \
        -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"
      MX_AUTO_PUBLIC_URL="${node_ip:+http://${node_ip}:30880}"
      ;;
  esac
  export MX_AUTO_PUBLIC_URL
}

apply_secret() {
  local name value
  {
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: mx-auto-secrets\n  namespace: %s\ntype: Opaque\ndata:\n' "$NAMESPACE"
    for name in MX_AUTO_DATABASE_URL MX_AUTO_ADMIN_TOKEN MX_AUTO_LAUNCHER_URL \
      MX_AUTO_LAUNCHER_AUDIENCE MX_AUTO_LAUNCHER_NEGATIVE_CACHE_TTL_MS \
      MX_AUTO_LAUNCHER_INTROSPECTION_WINDOW_MS MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS \
      MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE \
      MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE MX_AUTO_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS \
      MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT \
      MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE \
      MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE \
      MX_AUTO_POSTGRES_PASSWORD MX_AUTO_GIT_TOKEN \
      MX_AUTO_PUBLIC_URL MX_AUTO_SECRET_KEY; do
      value="${!name-}"
      printf '  %s: "%s"\n' "$name" "$(printf '%s' "$value" | b64)"
    done
  } | kubectl apply -f - >/dev/null
  say "Secret reconciled with MX_AUTO_* keys"
}

compute_secret_checksum() {
  local name
  SECRET_CHECKSUM="$({
    for name in MX_AUTO_DATABASE_URL MX_AUTO_ADMIN_TOKEN MX_AUTO_LAUNCHER_URL \
      MX_AUTO_LAUNCHER_AUDIENCE MX_AUTO_LAUNCHER_NEGATIVE_CACHE_TTL_MS \
      MX_AUTO_LAUNCHER_INTROSPECTION_WINDOW_MS MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS \
      MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT MX_AUTO_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE \
      MX_AUTO_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE MX_AUTO_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS \
      MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT \
      MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE \
      MX_AUTO_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE \
      MX_AUTO_POSTGRES_PASSWORD MX_AUTO_GIT_TOKEN \
      MX_AUTO_PUBLIC_URL MX_AUTO_SECRET_KEY; do
      printf '%s=%s\0' "$name" "${!name-}"
    done
  } | openssl dgst -sha256 | awk '{ print $NF }')"
  [ -n "$SECRET_CHECKSUM" ] || die "could not compute the Secret checksum"
}

compute_resource_policy_checksum() {
  RESOURCE_POLICY_CHECKSUM="$(openssl dgst -sha256 "${K8S_DIR}/08-resource-policy.yaml" | awk '{ print $NF }')"
  [[ "$RESOURCE_POLICY_CHECKSUM" =~ ^[0-9a-f]{64}$ ]] || \
    die "could not compute the resource policy checksum"
}

preflight_hostpath_cluster() {
  local node_count
  node_count="$(kubectl get nodes -o name | awk 'NF { count += 1 } END { print count + 0 }')"
  [ "$node_count" -eq 1 ] || \
    die "the bundled hostPath profile requires exactly one Kubernetes node; found ${node_count}"
}

validate_explicit_image() {
  [[ "$1" =~ @sha256:[0-9a-fA-F]{64}$ ]] || \
    die "MX_AUTO_IMAGE must be an immutable registry digest (repository@sha256:<64 hex>)"
}

load_kind_image() {
  local cluster_name="${CLUSTER_CONTEXT#kind-}"
  need kind
  say "loading ${IMAGE} into kind cluster ${cluster_name}"
  kind load docker-image "$IMAGE" --name "$cluster_name"
}

build_local_image() {
  local build_tag="mx-auto-server:build" image_id image_hash
  need docker
  say "building a content-addressed local image"
  docker build -f "${ROOT_DIR}/Dockerfile" -t "$build_tag" "$ELECTRON_DOCK_DIR"
  image_id="$(docker image inspect "$build_tag" --format '{{.Id}}')"
  image_hash="${image_id#sha256:}"
  [[ "$image_hash" =~ ^[0-9a-fA-F]{64}$ ]] || die "docker returned an invalid image id: ${image_id}"
  IMAGE="mx-auto-server:local-${image_hash:0:16}"
  docker tag "$build_tag" "$IMAGE"
  [ "${CLUSTER_CONTEXT#kind-}" = "$CLUSTER_CONTEXT" ] || load_kind_image
}

resolve_image() {
  CLUSTER_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
  [ -n "$CLUSTER_CONTEXT" ] || die "kubectl has no current context"

  if [ -n "${MX_AUTO_IMAGE:-}" ]; then
    validate_explicit_image "$MX_AUTO_IMAGE"
    IMAGE="$MX_AUTO_IMAGE"
    say "using configured immutable image ${IMAGE}"
    return
  fi

  case "$CLUSTER_CONTEXT" in
    docker-desktop | rancher-desktop | kind-*) build_local_image ;;
    *)
      die "context ${CLUSTER_CONTEXT} cannot consume a local Docker image; set MX_AUTO_IMAGE to a pullable digest"
      ;;
  esac
}

render_stream() {
  [ -n "$IMAGE" ] || die "image was not resolved before manifest rendering"
  [[ "$SECRET_CHECKSUM" =~ ^[0-9a-f]{64}$ ]] || die "Secret checksum was not resolved before manifest rendering"
  [[ "$RESOURCE_POLICY_CHECKSUM" =~ ^[0-9a-f]{64}$ ]] || die "resource policy checksum was not resolved before manifest rendering"
  awk -v image="$IMAGE" -v checksum="$SECRET_CHECKSUM" -v policy="$RESOURCE_POLICY_CHECKSUM" '
    {
      sub(/mx-auto.invalid\/mx-auto-server:managed-image-required/, image)
      sub(/__MX_AUTO_SECRET_CHECKSUM__/, checksum)
      sub(/__MX_AUTO_RESOURCE_POLICY_CHECKSUM__/, policy)
      print
    }
  '
}

render_file() {
  render_stream < "$1"
}

render_kustomization() {
  kubectl kustomize "$K8S_DIR" | render_stream
}

apply_foundation() {
  kubectl apply -f "${K8S_DIR}/05-serviceaccount.yaml" >/dev/null
  kubectl apply -f "${K8S_DIR}/08-resource-policy.yaml" >/dev/null
  kubectl apply -f "${K8S_DIR}/10-artifacts-pvc.yaml" >/dev/null
  kubectl apply -f "${K8S_DIR}/15-postgres.yaml" >/dev/null
  kubectl apply -f "${K8S_DIR}/40-network-policy.yaml" >/dev/null
  say "waiting for the independent PostgreSQL instance"
  if ! kube rollout status statefulset/mx-auto-postgres --timeout=180s >/dev/null; then
    kube logs statefulset/mx-auto-postgres --tail=80 || true
    die "PostgreSQL did not become ready"
  fi
}

run_migration() {
  kube delete job mx-auto-migrate --ignore-not-found >/dev/null 2>&1 || true
  render_file "${K8S_DIR}/20-migration-job.yaml" | kubectl apply -f - >/dev/null
  say "waiting for migrations"
  if ! kube wait --for=condition=complete job/mx-auto-migrate --timeout=180s >/dev/null; then
    kube logs job/mx-auto-migrate --tail=100 || true
    die "migration failed"
  fi
}

prepare_kubernetes() {
  need kubectl
  need openssl
  load_env
  require_admin_token
  preflight_hostpath_cluster
  resolve_image
  apply_namespace
  resolve_database
  resolve_secret_key
  resolve_public_url
  compute_secret_checksum
  compute_resource_policy_checksum
  apply_secret
  apply_foundation
}

cmd_deploy() {
  prepare_kubernetes
  run_migration

  # Deployment is deliberately created only after migrations complete. The
  # full kustomization is safe now and also reconciles Service/NetworkPolicy.
  render_kustomization | kubectl apply -f - >/dev/null
  # `kubectl apply` preserves a live scale-to-zero when the last-applied and
  # desired values are both one, so recovery from `down` must be explicit.
  kube scale deployment/mx-auto-server --replicas=1 >/dev/null
  say "waiting for mx-auto-server"
  kube rollout status deployment/mx-auto-server --timeout=180s
  cmd_verify
  say "deployed: ${MX_AUTO_PUBLIC_URL:-use kubectl port-forward service/mx-auto-server 8790:80}"
}

cmd_migrate() {
  prepare_kubernetes
  run_migration
  say "migrations complete; server deployment was not changed"
}

cmd_verify() (
  need kubectl
  need node
  need curl
  load_env
  require_admin_token
  local port="${MX_AUTO_VERIFY_PORT:-18880}"
  kube port-forward service/mx-auto-server "${port}:80" >/dev/null 2>&1 &
  local forward_pid=$!
  trap 'kill "$forward_pid" 2>/dev/null || true' EXIT

  local attempt=0
  until curl -fsS -o /dev/null "http://127.0.0.1:${port}/readyz" 2>/dev/null; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || die "port-forward did not become ready"
    kill -0 "$forward_pid" 2>/dev/null || die "port-forward exited early"
    sleep 1
  done

  MX_AUTO_BASE_URL="http://127.0.0.1:${port}" \
  MX_AUTO_ADMIN_TOKEN="$MX_AUTO_ADMIN_TOKEN" \
    node "${ROOT_DIR}/scripts/verify.mjs"
)

cmd_status() {
  need kubectl
  kube get deployment,statefulset,pod,pvc,service,job,networkpolicy,resourcequota,limitrange -o wide || true
}

cmd_logs() {
  need kubectl
  case "${1:-server}" in
    migrate) kube logs job/mx-auto-migrate --tail=200 ;;
    postgres) kube logs statefulset/mx-auto-postgres --tail=200 -f ;;
    server) kube logs deployment/mx-auto-server --tail=200 -f ;;
    *) die "logs target must be server, migrate or postgres" ;;
  esac
}

cmd_down() {
  need kubectl
  say "scaling the service to zero; PostgreSQL, Secret and PVCs are preserved"
  kube scale deployment/mx-auto-server --replicas=0
}

cmd_dev() {
  need node
  load_env
  if [ ! -e "${ELECTRON_DOCK_DIR}/mx-test-framework/node_modules/fast-xml-parser" ]; then
    die "V0 kernel dependencies are missing; run: npm --prefix ../mx-test-framework install"
  fi
  export MX_AUTO_STORE="${MX_AUTO_STORE:-memory}"
  export MX_AUTO_PORT="${MX_AUTO_PORT:-8790}"
  export MX_AUTO_ADMIN_TOKEN="${MX_AUTO_ADMIN_TOKEN:-local-admin-change-me}"
  export MX_AUTO_INSECURE_COOKIES="${MX_AUTO_INSECURE_COOKIES:-true}"
  export MX_AUTO_ARTIFACTS_DIR="${MX_AUTO_ARTIFACTS_DIR:-${ROOT_DIR}/.runtime/artifacts}"
  say "starting the V0 wrapper at http://127.0.0.1:${MX_AUTO_PORT}"
  node "${ROOT_DIR}/server/index.mjs"
}

cmd_test() {
  need npm
  npm --prefix "$ROOT_DIR" test
}

if [ "${MX_AUTO_MANAGE_SOURCE_ONLY:-0}" != "1" ]; then
  command_name="${1:-help}"
  shift || true
  case "$command_name" in
    dev) cmd_dev "$@" ;;
    test) cmd_test "$@" ;;
    migrate) cmd_migrate "$@" ;;
    deploy) cmd_deploy "$@" ;;
    verify) cmd_verify "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    down) cmd_down "$@" ;;
    help | -h | --help) usage ;;
    *) usage; exit 1 ;;
  esac
fi
