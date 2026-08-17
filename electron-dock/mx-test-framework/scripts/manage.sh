#!/usr/bin/env bash
# MX Test Framework lifecycle.
#
# One entry point for local development and for the Internal Kubernetes
# deployment. `deploy` is idempotent: running it again reconciles.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_DOCK_DIR="$(cd "${ROOT_DIR}/.." && pwd)"
K8S_DIR="${ROOT_DIR}/deploy/k8s/internal"
COMPOSE_FILE="${ROOT_DIR}/deploy/compose/docker-compose.yml"
NAMESPACE="mx-test-framework"
IMAGE="${MXT_IMAGE:-mx-test-framework:latest}"

say() { printf '[mx-test-framework] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

usage() {
  cat <<'EOF'
MX Test Framework lifecycle

Local:
  bash scripts/manage.sh local up|down|logs      # docker compose: server + postgres
  bash scripts/manage.sh dev                     # in-memory server, no database
  bash scripts/manage.sh test                    # unit + API tests

Internal Kubernetes:
  bash scripts/manage.sh deploy                  # image -> migrate -> server -> smoke
  bash scripts/manage.sh migrate                 # run migrations only
  bash scripts/manage.sh verify                  # end-to-end smoke against the deployment
  bash scripts/manage.sh seed                    # 灌入示例数据，让新装的平台不是空的
  bash scripts/manage.sh status
  bash scripts/manage.sh logs [server|migrate]
  bash scripts/manage.sh clean                   # expired artifacts + finished runner Jobs
  bash scripts/manage.sh down                    # scale to zero; keeps PVC, Secret, database

Configuration is read from .env.internal when present (keep it mode 0600).
Required there: MXT_DATABASE_URL, MXT_ADMIN_TOKEN.
Optional: MXT_LAUNCHER_URL —— 设了才能用 mx-launcher 账号登录；不设时只能用
admin token 当密码登录。

`down` never deletes the PVC, the Secret or the database. Removing data is a
separate, explicit act.
EOF
}

load_env() {
  local file="${ROOT_DIR}/.env.internal"
  if [ -f "$file" ]; then
    # Operator-owned file, not untrusted input.
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

compose() {
  need docker
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    need docker-compose
    docker-compose -f "$COMPOSE_FILE" "$@"
  fi
}

kube() { kubectl -n "$NAMESPACE" "$@"; }

require_secrets() {
  [ -n "${MXT_DATABASE_URL:-}" ] || die "MXT_DATABASE_URL is required (set it in .env.internal)"
  [ -n "${MXT_ADMIN_TOKEN:-}" ] || die "MXT_ADMIN_TOKEN is required (set it in .env.internal)"
}

build_image() {
  need docker
  say "building ${IMAGE}"
  # Build context is electron-dock/ so the image can pull in ../mx-common.
  docker build -f "${ROOT_DIR}/Dockerfile" -t "$IMAGE" "$ELECTRON_DOCK_DIR"
}

apply_secret() {
  # Passed on stdin rather than as arguments: kubectl's argv is visible to every
  # other process on the host.
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  kubectl create secret generic mx-test-framework-secrets \
    --namespace "$NAMESPACE" \
    --from-env-file=/dev/stdin \
    --dry-run=client -o yaml <<EOF | kubectl apply -f - >/dev/null
MXT_DATABASE_URL=${MXT_DATABASE_URL}
MXT_ADMIN_TOKEN=${MXT_ADMIN_TOKEN}
MXT_LAUNCHER_URL=${MXT_LAUNCHER_URL:-}
EOF
  say "secret reconciled"
}

wait_for_migration() {
  say "waiting for migrations"
  if ! kube wait --for=condition=complete job/mx-test-framework-migrate --timeout=180s >/dev/null; then
    kube logs job/mx-test-framework-migrate --tail=50 || true
    die "migration job did not complete"
  fi
  say "migrations applied"
}

cmd_deploy() {
  need kubectl
  load_env
  require_secrets
  build_image
  apply_secret

  # The migration Job is immutable once created; delete it so a redeploy runs
  # the new image instead of silently reusing the previous run's result.
  kube delete job mx-test-framework-migrate --ignore-not-found >/dev/null 2>&1 || true

  say "applying manifests"
  kubectl apply -k "$K8S_DIR" >/dev/null
  wait_for_migration

  say "waiting for the server"
  kube rollout status deployment/mx-test-framework --timeout=180s
  cmd_verify
}

cmd_migrate() {
  need kubectl
  load_env
  require_secrets
  apply_secret
  kube delete job mx-test-framework-migrate --ignore-not-found >/dev/null 2>&1 || true
  kubectl apply -f "${K8S_DIR}/20-migration-job.yaml" >/dev/null
  wait_for_migration
}

# End-to-end smoke: register an app, a suite and a catalog, create a task, run
# it, claim it as a runner, submit a summary, and read the result back. This is
# the P0 exit criterion, executed against the real deployment.
cmd_verify() {
  need kubectl
  need curl
  load_env
  require_secrets

  local port="${MXT_VERIFY_PORT:-18790}"
  kube port-forward service/mx-test-framework "${port}:80" >/dev/null 2>&1 &
  local forward_pid=$!
  trap 'kill "$forward_pid" 2>/dev/null || true' RETURN
  sleep 3

  local base="http://127.0.0.1:${port}"
  local suffix
  suffix="$(date +%s)"

  MXT_BASE_URL="$base" MXT_ADMIN_TOKEN="$MXT_ADMIN_TOKEN" MXT_VERIFY_SUFFIX="$suffix" \
    node "${ROOT_DIR}/scripts/verify.mjs"
}

cmd_seed() {
  need node
  load_env
  require_secrets
  local port="${MXT_VERIFY_PORT:-18790}"
  kube port-forward service/mx-test-framework "${port}:80" >/dev/null 2>&1 &
  local forward_pid=$!
  trap 'kill "$forward_pid" 2>/dev/null || true' RETURN
  sleep 3
  MXT_BASE_URL="http://127.0.0.1:${port}" MXT_ADMIN_TOKEN="$MXT_ADMIN_TOKEN" \
    node "${ROOT_DIR}/scripts/seed.mjs"
}

cmd_clean() {
  need kubectl
  load_env
  local days="${MXT_ARTIFACT_RETAIN_DAYS:-30}"
  say "removing artifact directories older than ${days} days"
  kube exec deployment/mx-test-framework -- \
    sh -c "find /data/artifacts/runs -mindepth 1 -maxdepth 1 -type d -mtime +${days} -exec rm -rf {} + 2>/dev/null; true"
  say "removing finished runner Jobs"
  kube delete jobs -l app.kubernetes.io/component=runner \
    --field-selector status.successful=1 --ignore-not-found >/dev/null 2>&1 || true
  say "clean complete (run records are kept; only bytes were removed)"
}

cmd_status() {
  need kubectl
  kube get deployment,pod,pvc,job -o wide || true
}

cmd_logs() {
  need kubectl
  case "${1:-server}" in
    migrate) kube logs job/mx-test-framework-migrate --tail=200 ;;
    *) kube logs deployment/mx-test-framework --tail=200 -f ;;
  esac
}

cmd_down() {
  need kubectl
  say "scaling to zero; PVC, Secret and database are preserved"
  kube scale deployment/mx-test-framework --replicas=0
}

cmd_dev() {
  need node
  # The design system ships its CSS from a generated dist/, which is absent in a
  # fresh checkout; without this the UI renders unstyled with no error anywhere.
  node "${ELECTRON_DOCK_DIR}/mx-launcher/ui-design/scripts/build.mjs" >/dev/null
  say "starting in-memory server on :${MXT_PORT:-8790} (no database, no persistence)"
  say "登录：账号随便填，密码用 MXT_ADMIN_TOKEN（默认 local-admin-change-me）"
  MXT_STORE=memory \
  MXT_PORT="${MXT_PORT:-8790}" \
  MXT_ADMIN_TOKEN="${MXT_ADMIN_TOKEN:-local-admin-change-me}" \
  MXT_INSECURE_COOKIES=true \
  MXT_ARTIFACTS_DIR="${ROOT_DIR}/.runtime/artifacts" \
    node "${ROOT_DIR}/server/index.mjs"
}

cmd_test() {
  need node
  cd "$ROOT_DIR"
  node --test tests/*.test.mjs
}

cmd="${1:-help}"
shift || true
case "$cmd" in
  deploy) cmd_deploy "$@" ;;
  migrate) cmd_migrate "$@" ;;
  verify) cmd_verify "$@" ;;
  seed) cmd_seed "$@" ;;
  clean) cmd_clean "$@" ;;
  status) cmd_status "$@" ;;
  logs) cmd_logs "$@" ;;
  down) cmd_down "$@" ;;
  dev) cmd_dev "$@" ;;
  test) cmd_test "$@" ;;
  local)
    case "${1:-up}" in
      up) compose up -d --build ;;
      down) compose down ;;
      logs) compose logs -f ;;
      *) usage; exit 1 ;;
    esac
    ;;
  help | -h | --help) usage ;;
  *) usage; exit 1 ;;
esac
