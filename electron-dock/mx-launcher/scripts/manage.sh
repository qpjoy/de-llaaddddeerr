#!/usr/bin/env bash
# MX Launcher solution management helper.
#
# This starts as a local control surface for the unified mx-launcher project.
# Future deploy/admin actions should call the same underlying operations so the
# CLI and admin console stay consistent.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

cmd="${1:-help}"
shift || true

say() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  bash scripts/manage.sh help
  bash scripts/manage.sh doctor [--role internal|domestic|oversea]
  bash scripts/manage.sh check
  bash scripts/manage.sh desktop-check
  bash scripts/manage.sh desktop-typecheck
  bash scripts/manage.sh server-typecheck
  bash scripts/manage.sh profile internal|domestic|oversea|h-endpoint-dev
  bash scripts/manage.sh smoke platform-kernel
  bash scripts/manage.sh smoke server-http [base-url]
  bash scripts/manage.sh shadow build|up|smoke|logs|down
  bash scripts/manage.sh ops guide
  bash scripts/manage.sh ops doctor
  bash scripts/manage.sh ops local-shadow plan|cycle|build|up|status|smoke|logs|down
  bash scripts/manage.sh ops k8s-shadow plan|dry-run|cycle|apply|status|smoke|logs|db-summary|down
  bash scripts/manage.sh k8s plan internal-shadow
  bash scripts/manage.sh k8s explain internal-shadow
  bash scripts/manage.sh k8s render internal-shadow
  bash scripts/manage.sh k8s dry-run internal-shadow
  bash scripts/manage.sh k8s apply internal-shadow
  bash scripts/manage.sh k8s status internal-shadow
  bash scripts/manage.sh k8s logs internal-shadow
  bash scripts/manage.sh k8s db-summary internal-shadow
  bash scripts/manage.sh k8s smoke internal-shadow [local-port]
  bash scripts/manage.sh k8s down internal-shadow

Planned:
  bash scripts/manage.sh internal up
  bash scripts/manage.sh domestic up
  bash scripts/manage.sh oversea up --site oversea-sg-1
  bash scripts/manage.sh client build --platform win32-x64
  bash scripts/manage.sh migrate export-domestic
  bash scripts/manage.sh test e2e --suite hdo-shadow-e2e --topology h-d-i-o-shadow
  bash scripts/manage.sh kit export --target /Volumes/MX-SALES
EOF
}

role_modules() {
  case "$1" in
    internal)
      echo "iam,app-center,config-center,deploy-center,release-center,artifact-center,runner-controller,test-center,audit-center,observability,sdk-gateway,launcher-network-control,hdo-compat,dns-control,edge-sync"
      ;;
    domestic)
      echo "edge-api,relay-facade,h2i-proxy,snapshot-cache,observability-forwarder"
      ;;
    oversea)
      echo "access-node,site-agent,runner-worker,observability-forwarder"
      ;;
    h-endpoint-dev)
      echo "launcher-dev-api,observability-forwarder"
      ;;
    *)
      die "Unknown profile role: $1"
      ;;
  esac
}

tsc_bin() {
  if [ -x "$ROOT/node_modules/.bin/tsc" ]; then
    echo "$ROOT/node_modules/.bin/tsc"
    return
  fi
  if [ -x "$ROOT/desktop/node_modules/.bin/tsc" ]; then
    echo "$ROOT/desktop/node_modules/.bin/tsc"
    return
  fi
  if [ -x "$ROOT/server/node_modules/.bin/tsc" ]; then
    echo "$ROOT/server/node_modules/.bin/tsc"
    return
  fi
  if [ -x "$ROOT/../../electron-server/node_modules/.bin/tsc" ]; then
    echo "$ROOT/../../electron-server/node_modules/.bin/tsc"
    return
  fi
  return 1
}

run_tsc() {
  local tsc
  if ! tsc="$(tsc_bin)"; then
    die "typescript is not installed. Run pnpm install in $ROOT first."
  fi
  "$tsc" "$@"
}

need_kubectl() {
  command -v kubectl >/dev/null 2>&1 || die "kubectl is required for k8s actions"
}

k8s_namespace() {
  case "$1" in
    internal-shadow)
      echo "mx-internal-shadow"
      ;;
    *)
      die "Unknown k8s target: $1"
      ;;
  esac
}

k8s_manifest_dir() {
  case "$1" in
    internal-shadow)
      echo "$ROOT/deploy/k8s/internal-shadow"
      ;;
    *)
      die "Unknown k8s target: $1"
      ;;
  esac
}

k8s_plan() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  cat <<EOF
MX Launcher K8s deployment plan: $target

Namespace: $ns

Order:
  1. Apply namespace.
  2. Apply non-secret config ConfigMap.
  3. Create or update DB Secret from local env:
     PG_USER, PG_PASSWORD, PG_DB, DATABASE_URL.
  4. Apply PostgreSQL Service + StatefulSet.
  5. Wait for PostgreSQL rollout.
  6. Delete any previous migration Job, apply a fresh TypeORM migration Job,
     and wait for completion.
  7. Apply Internal API Deployment + Service.
  8. Wait for Internal API rollout.
  9. Run HTTP smoke through a temporary kubectl port-forward.

Data policy:
  k8s down keeps the PostgreSQL PVC by default. Delete PVCs only with a
  deliberate future purge action.
EOF
}

k8s_explain() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  cat <<EOF
K8s concepts for $target, mapped from Docker Compose:

Compose service -> K8s Deployment or StatefulSet
  - The Compose "internal" service becomes a Deployment because it is a
    stateless HTTP API. K8s can roll it out, restart it, and scale replicas.
  - The Compose "postgres" service becomes a StatefulSet because it owns stable
    storage and identity. Its data lives in a PersistentVolumeClaim.

Compose ports -> K8s Service
  - Compose maps 18090 to your host.
  - K8s creates a ClusterIP Service named mx-launcher-internal. For local smoke,
    manage.sh uses kubectl port-forward to temporarily expose it.

Compose environment -> ConfigMap + Secret
  - Non-secret values such as MX_ENVIRONMENT and MX_SITE_ROLE live in ConfigMap.
  - DATABASE_URL and PG_PASSWORD live in Secret. The script creates the Secret
    from your shell env so credentials do not live in git.

Docker healthcheck -> K8s probes
  - livenessProbe calls /healthz: is the process alive.
  - readinessProbe calls /readyz: is the API ready to receive traffic.

Deployment order
  - K8s can reconcile resources continuously, but dependencies still matter.
    We explicitly wait for PostgreSQL before running the migration Job, and wait
    for migration completion before rolling the API.

Current namespace: $ns
EOF
}

k8s_render() {
  local target="$1"
  local dir
  dir="$(k8s_manifest_dir "$target")"
  [ -d "$dir" ] || die "missing k8s manifest directory: $dir"
  cat "$dir"/00-namespace.yaml
  printf '\n---\n'
  cat "$dir"/10-configmap.yaml
  printf '\n---\n'
  cat "$dir"/20-postgres.yaml
  printf '\n---\n'
  cat "$dir"/30-migration-job.yaml
  printf '\n---\n'
  cat "$dir"/40-internal-api.yaml
}

k8s_apply_db_secret() {
  local ns="$1"
  local pg_user="${PG_USER:-mx_internal}"
  local pg_password="${PG_PASSWORD:-mx_internal}"
  local pg_db="${PG_DB:-mx_internal_shadow}"
  local database_url="${DATABASE_URL:-postgres://${pg_user}:${pg_password}@mx-internal-postgres:5432/${pg_db}}"
  kubectl -n "$ns" create secret generic mx-launcher-db \
    --from-literal=PG_USER="$pg_user" \
    --from-literal=PG_PASSWORD="$pg_password" \
    --from-literal=PG_DB="$pg_db" \
    --from-literal=DATABASE_URL="$database_url" \
    --dry-run=client -o yaml | kubectl apply -f -
}

k8s_secret_dry_run() {
  local ns="$1"
  local pg_user="${PG_USER:-mx_internal}"
  local pg_password="${PG_PASSWORD:-mx_internal}"
  local pg_db="${PG_DB:-mx_internal_shadow}"
  local database_url="${DATABASE_URL:-postgres://${pg_user}:${pg_password}@mx-internal-postgres:5432/${pg_db}}"
  kubectl -n "$ns" create secret generic mx-launcher-db \
    --from-literal=PG_USER="$pg_user" \
    --from-literal=PG_PASSWORD="$pg_password" \
    --from-literal=PG_DB="$pg_db" \
    --from-literal=DATABASE_URL="$database_url" \
    --dry-run=client -o yaml >/dev/null
}

k8s_dry_run() {
  local target="$1"
  local ns dir
  ns="$(k8s_namespace "$target")"
  dir="$(k8s_manifest_dir "$target")"
  need_kubectl
  [ -d "$dir" ] || die "missing k8s manifest directory: $dir"
  say "dry-run namespace"
  kubectl apply --dry-run=client --validate=false -f "$dir/00-namespace.yaml"
  say "dry-run configmap"
  kubectl apply --dry-run=client --validate=false -f "$dir/10-configmap.yaml"
  say "dry-run generated db secret"
  k8s_secret_dry_run "$ns"
  say "dry-run postgres service/statefulset"
  kubectl apply --dry-run=client --validate=false -f "$dir/20-postgres.yaml"
  say "dry-run migration job"
  kubectl apply --dry-run=client --validate=false -f "$dir/30-migration-job.yaml"
  say "dry-run internal api service/deployment"
  kubectl apply --dry-run=client --validate=false -f "$dir/40-internal-api.yaml"
  say "k8s dry-run OK"
}

k8s_apply() {
  local target="$1"
  local ns dir
  ns="$(k8s_namespace "$target")"
  dir="$(k8s_manifest_dir "$target")"
  need_kubectl
  [ -d "$dir" ] || die "missing k8s manifest directory: $dir"

  say "apply namespace"
  kubectl apply -f "$dir/00-namespace.yaml"
  say "apply configmap"
  kubectl apply -f "$dir/10-configmap.yaml"
  say "create/update db secret from local env"
  k8s_apply_db_secret "$ns"
  say "apply postgres service/statefulset"
  kubectl apply -f "$dir/20-postgres.yaml"
  say "wait postgres rollout"
  kubectl -n "$ns" rollout status statefulset/mx-internal-postgres --timeout=180s

  say "run migration job"
  kubectl -n "$ns" delete job mx-launcher-migrate --ignore-not-found
  kubectl apply -f "$dir/30-migration-job.yaml"
  kubectl -n "$ns" wait --for=condition=complete job/mx-launcher-migrate --timeout=180s

  say "apply internal api"
  kubectl apply -f "$dir/40-internal-api.yaml"
  say "wait internal api rollout"
  kubectl -n "$ns" rollout status deployment/mx-launcher-internal --timeout=180s
  say "k8s apply OK"
}

k8s_status() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  kubectl -n "$ns" get pods,svc,deploy,statefulset,job,pvc
}

k8s_logs() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  kubectl -n "$ns" logs deploy/mx-launcher-internal --tail=120
}

k8s_db_summary() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  say "schema migrations"
  kubectl -n "$ns" exec statefulset/mx-internal-postgres -- \
    psql -U "${PG_USER:-mx_internal}" -d "${PG_DB:-mx_internal_shadow}" \
    -c "select count(*) as migration_rows from mx_schema_migrations;"
  say "platform records by kind"
  kubectl -n "$ns" exec statefulset/mx-internal-postgres -- \
    psql -U "${PG_USER:-mx_internal}" -d "${PG_DB:-mx_internal_shadow}" \
    -c "select kind, environment, count(*) from mx_platform_records group by kind, environment order by kind, environment;"
}

k8s_smoke() {
  local target="$1"
  local port="${2:-18090}"
  local ns pf_pid
  ns="$(k8s_namespace "$target")"
  need_kubectl
  kubectl -n "$ns" port-forward svc/mx-launcher-internal "$port:18090" >/tmp/mx-launcher-k8s-port-forward.log 2>&1 &
  pf_pid="$!"
  sleep 2
  if ! (cd server && pnpm run smoke:http -- "http://127.0.0.1:${port}"); then
    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
    die "k8s smoke failed; see /tmp/mx-launcher-k8s-port-forward.log"
  fi
  kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true
}

k8s_down() {
  local target="$1"
  local ns dir
  ns="$(k8s_namespace "$target")"
  dir="$(k8s_manifest_dir "$target")"
  need_kubectl
  [ -d "$dir" ] || die "missing k8s manifest directory: $dir"
  say "delete internal api"
  kubectl delete -f "$dir/40-internal-api.yaml" --ignore-not-found
  say "delete migration job"
  kubectl -n "$ns" delete job mx-launcher-migrate --ignore-not-found
  say "delete postgres workload and service; PVC is kept"
  kubectl delete -f "$dir/20-postgres.yaml" --ignore-not-found
  say "delete configmap and generated secret"
  kubectl delete -f "$dir/10-configmap.yaml" --ignore-not-found
  kubectl -n "$ns" delete secret mx-launcher-db --ignore-not-found
  say "namespace and PVC are kept for safe restart"
}

ops_guide() {
  cat <<'EOF'
MX Launcher local operator guide

Start here:
  bash scripts/manage.sh ops doctor

Path A: Docker Compose shadow, no K8s knowledge required.
  bash scripts/manage.sh ops local-shadow plan
  bash scripts/manage.sh ops local-shadow cycle

Path B: K8s learning path, safe dry-run first.
  bash scripts/manage.sh ops k8s-shadow plan
  bash scripts/manage.sh ops k8s-shadow dry-run

Path C: K8s deploy on Docker Desktop or a prepared Internal cluster.
  bash scripts/manage.sh ops k8s-shadow cycle
  bash scripts/manage.sh ops k8s-shadow apply
  bash scripts/manage.sh ops k8s-shadow status
  bash scripts/manage.sh ops k8s-shadow smoke
  bash scripts/manage.sh ops k8s-shadow db-summary
  bash scripts/manage.sh ops k8s-shadow logs
  bash scripts/manage.sh ops k8s-shadow down

Mental model:
  Compose "service"      -> K8s Deployment/StatefulSet
  Compose "environment"  -> K8s ConfigMap/Secret
  Compose "volume"       -> K8s PersistentVolumeClaim
  Compose "healthcheck"  -> K8s liveness/readiness probes
  One-time migration     -> K8s Job

Safe cleanup:
  local-shadow down stops Compose containers and keeps the PG Docker volume.
  k8s-shadow down removes workloads and keeps the K8s PVC.
EOF
}

ops_doctor() {
  say "MX Launcher root: $ROOT"
  command -v node >/dev/null 2>&1 && say "node: $(node --version)" || say "node: missing"
  command -v pnpm >/dev/null 2>&1 && say "pnpm: $(pnpm --version)" || say "pnpm: missing"
  command -v docker >/dev/null 2>&1 && say "docker: $(docker --version)" || say "docker: missing"
  command -v kubectl >/dev/null 2>&1 && say "kubectl: $(kubectl version --client 2>/dev/null | head -n 1)" || say "kubectl: missing"
  [ -f server/package.json ] && say "server package: OK" || say "server package: missing"
  [ -f server/docker-compose.shadow.yml ] && say "shadow compose: OK" || say "shadow compose: missing"
  [ -d deploy/k8s/internal-shadow ] && say "k8s internal-shadow manifests: OK" || say "k8s internal-shadow manifests: missing"
  say "doctor finished. If docker/kubectl checks are missing, start Docker Desktop and enable Kubernetes before K8s apply."
}

ops_local_shadow_plan() {
  cat <<'EOF'
Docker Compose local-shadow order:
  1. Build the internal API image.
  2. Start postgres and internal API.
  3. Run HTTP smoke against http://127.0.0.1:18090.
  4. Inspect logs/status if smoke fails.
  5. Down stops containers but keeps the PostgreSQL Docker volume.

Commands:
  bash scripts/manage.sh ops local-shadow build
  bash scripts/manage.sh ops local-shadow up
  bash scripts/manage.sh ops local-shadow smoke
  bash scripts/manage.sh ops local-shadow logs
  bash scripts/manage.sh ops local-shadow down
EOF
}

ops_local_shadow() {
  local action="$1"
  case "$action" in
    plan)
      ops_local_shadow_plan
      ;;
    build)
      (cd server && docker compose -f docker-compose.shadow.yml build internal)
      ;;
    up)
      (cd server && docker compose -f docker-compose.shadow.yml up -d)
      ;;
    status)
      docker ps --filter name=mx- --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
      ;;
    smoke)
      (cd server && pnpm run smoke:http -- "http://127.0.0.1:18090")
      ;;
    logs)
      (cd server && docker compose -f docker-compose.shadow.yml logs --tail=120)
      ;;
    down)
      (cd server && docker compose -f docker-compose.shadow.yml down)
      ;;
    cycle)
      ops_local_shadow_plan
      say "build"
      ops_local_shadow build
      say "up"
      ops_local_shadow up
      say "smoke"
      ops_local_shadow smoke
      say "status"
      ops_local_shadow status
      say "local-shadow cycle OK. Run 'bash scripts/manage.sh ops local-shadow down' when done."
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops local-shadow plan|cycle|build|up|status|smoke|logs|down"
      ;;
  esac
}

ops_k8s_shadow_plan() {
  k8s_plan internal-shadow
  printf '\n'
  k8s_explain internal-shadow
}

ops_k8s_shadow() {
  local action="$1"
  case "$action" in
    plan)
      ops_k8s_shadow_plan
      ;;
    dry-run)
      k8s_dry_run internal-shadow
      ;;
    cycle)
      ops_k8s_shadow_plan
      say "apply"
      k8s_apply internal-shadow
      say "status"
      k8s_status internal-shadow
      say "smoke"
      k8s_smoke internal-shadow "${2:-18090}"
      say "db summary"
      k8s_db_summary internal-shadow
      say "k8s-shadow cycle OK. Run 'bash scripts/manage.sh ops k8s-shadow down' when done."
      ;;
    apply)
      k8s_apply internal-shadow
      ;;
    status)
      k8s_status internal-shadow
      ;;
    smoke)
      k8s_smoke internal-shadow "${2:-18090}"
      ;;
    logs)
      k8s_logs internal-shadow
      ;;
    db-summary)
      k8s_db_summary internal-shadow
      ;;
    down)
      k8s_down internal-shadow
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops k8s-shadow plan|dry-run|cycle|apply|status|smoke|logs|db-summary|down"
      ;;
  esac
}

doctor() {
  local role="internal"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --role)
        role="${2:-}"
        shift 2
        ;;
      *)
        die "Unknown doctor option: $1"
        ;;
    esac
  done

  say "MX Launcher root: $ROOT"
  say "role: $role"
  say "modules: $(role_modules "$role")"

  command -v node >/dev/null 2>&1 || die "node is required"
  command -v pnpm >/dev/null 2>&1 || say "pnpm not found; package scripts will need pnpm"

  [ -f desktop/package.json ] || die "missing desktop/package.json"
  [ -f server/package.json ] || die "missing server/package.json"
  [ -f desktop/electron-builder.yml ] || die "missing desktop/electron-builder.yml"
  [ -d desktop/products/hdo ] || die "missing desktop/products/hdo/"

  say "doctor OK"
}

case "$cmd" in
  help|-h|--help)
    usage
    ;;
  doctor)
    doctor "$@"
    ;;
  check)
    (cd desktop && pnpm run check)
    run_tsc -p desktop/tsconfig.json --noEmit
    run_tsc -p server/tsconfig.json --noEmit
    ;;
  desktop-check)
    (cd desktop && pnpm run check)
    ;;
  desktop-typecheck|typecheck)
    run_tsc -p desktop/tsconfig.json --noEmit
    ;;
  server-typecheck)
    run_tsc -p server/tsconfig.json --noEmit
    ;;
  profile)
    [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh profile internal|domestic|oversea|h-endpoint-dev"
    role_modules "$1"
    ;;
  smoke)
    [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh smoke platform-kernel|server-http [base-url]"
    target="$1"
    shift || true
    case "$target" in
      platform-kernel)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh smoke platform-kernel"
        (cd server && pnpm run smoke:platform-kernel)
        ;;
      server-http)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh smoke server-http [base-url]"
        (cd server && pnpm run smoke:http -- "${1:-http://127.0.0.1:18090}")
        ;;
      *)
        die "Unknown smoke target: $target"
        ;;
    esac
    ;;
  shadow)
    [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh shadow build|up|smoke|logs|down"
    action="$1"
    shift || true
    case "$action" in
      build)
        (cd server && docker compose -f docker-compose.shadow.yml build internal)
        ;;
      up)
        (cd server && docker compose -f docker-compose.shadow.yml up -d)
        ;;
      smoke)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh shadow smoke [base-url]"
        (cd server && pnpm run smoke:http -- "${1:-http://127.0.0.1:18090}")
        ;;
      logs)
        (cd server && docker compose -f docker-compose.shadow.yml logs --tail=120)
        ;;
      down)
        (cd server && docker compose -f docker-compose.shadow.yml down)
        ;;
      *)
        die "Unknown shadow action: $action"
        ;;
    esac
    ;;
  k8s)
    [ "$#" -ge 2 ] || die "Usage: bash scripts/manage.sh k8s plan|explain|render|dry-run|apply|status|logs|db-summary|smoke|down internal-shadow"
    action="$1"
    target="$2"
    shift 2 || true
    case "$action" in
      plan)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s plan internal-shadow"
        k8s_plan "$target"
        ;;
      explain)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s explain internal-shadow"
        k8s_explain "$target"
        ;;
      render)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s render internal-shadow"
        k8s_render "$target"
        ;;
      dry-run)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s dry-run internal-shadow"
        k8s_dry_run "$target"
        ;;
      apply)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s apply internal-shadow"
        k8s_apply "$target"
        ;;
      status)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s status internal-shadow"
        k8s_status "$target"
        ;;
      logs)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s logs internal-shadow"
        k8s_logs "$target"
        ;;
      db-summary)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s db-summary internal-shadow"
        k8s_db_summary "$target"
        ;;
      smoke)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh k8s smoke internal-shadow [local-port]"
        k8s_smoke "$target" "${1:-18090}"
        ;;
      down)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s down internal-shadow"
        k8s_down "$target"
        ;;
      *)
        die "Unknown k8s action: $action"
        ;;
    esac
    ;;
  ops)
    [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops guide|doctor|local-shadow|k8s-shadow"
    area="$1"
    shift || true
    case "$area" in
      guide)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops guide"
        ops_guide
        ;;
      doctor)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops doctor"
        ops_doctor
        ;;
      local-shadow)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops local-shadow plan|cycle|build|up|status|smoke|logs|down"
        ops_local_shadow "$@"
        ;;
      k8s-shadow)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops k8s-shadow plan|dry-run|apply|status|smoke|logs|down"
        ops_k8s_shadow "$@"
        ;;
      *)
        die "Unknown ops area: $area"
        ;;
    esac
    ;;
  *)
    usage
    die "Unknown command: $cmd"
    ;;
esac
