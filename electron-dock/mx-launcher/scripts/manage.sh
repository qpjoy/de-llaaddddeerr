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

cmd="${1:-menu}"
shift || true

say() { printf '▸ %s\n' "$*"; }
die() { printf '✗ %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage:
  bash scripts/manage.sh
  bash scripts/manage.sh menu
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
  bash scripts/manage.sh ops config feature-list [feature-key]
  bash scripts/manage.sh ops config feature-set <feature-key> <true|false> [plan-only|readonly-execute|remote-execute|disabled] [global|site|profile] [scope-id]
  bash scripts/manage.sh ops admin dashboard
  bash scripts/manage.sh ops admin actions [token]
  bash scripts/manage.sh ops admin site-slot-pipelines [plan-id]
  bash scripts/manage.sh ops site-slot domestic-plan <domestic-host|-> [oversea-host]
  bash scripts/manage.sh ops site-slot oversea-plan <oversea-host|->
  bash scripts/manage.sh ops site-slot materialize [oversea|domestic|all]
  bash scripts/manage.sh ops site-slot domestic-wg-secret-upsert <site-id> <endpoint>
  bash scripts/manage.sh ops site-slot materialize-domestic-ready <site-id>
  bash scripts/manage.sh ops site-slot refresh-tunnel-cli [version|--from-local DIR]
  bash scripts/manage.sh ops site-slot ssh-profiles
  bash scripts/manage.sh ops site-slot ssh-profile-upsert <site-id> <domestic|oversea> [host]
  bash scripts/manage.sh ops site-slot ssh-profile-readiness <profile-id> [plan-only|execute]
  bash scripts/manage.sh ops site-slot oversea-readonly-test <site-id> <host>
  bash scripts/manage.sh ops site-slot oversea-remote-test <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute]
  bash scripts/manage.sh ops site-slot preflight <plan-id> [dry-run|manual|ssh]
  bash scripts/manage.sh ops site-slot apply <plan-id> [manual|dry-run|ssh]
  bash scripts/manage.sh ops site-slot executions [plan-id]
  bash scripts/manage.sh ops site-slot runner-start <run-id> [simulate|remote-ssh|awx-shadow]
  bash scripts/manage.sh ops site-slot runner-sessions [run-id]
  bash scripts/manage.sh ops site-slot worker-job <session-id>
  bash scripts/manage.sh ops site-slot worker-gate <job-id> [confirm]
  bash scripts/manage.sh ops site-slot worker-handoff <job-id> [confirm]
  bash scripts/manage.sh ops site-slot domestic-relay-append-ssh-prepare <apply-run-id> [confirm]
  bash scripts/manage.sh ops site-slot worker-run <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec]
  bash scripts/manage.sh ops site-slot worker-report <job-id> [running|passed|failed|blocked]
  bash scripts/manage.sh ops site-slot rollback-start <report-id> [simulate|manual]
  bash scripts/manage.sh ops site-slot rollback-report <rollback-execution-id> [running|passed|failed|blocked]
  bash scripts/manage.sh ops local-shadow plan|cycle|build|up|status|smoke|logs|down
  bash scripts/manage.sh ops internal-local plan|dry-run|cycle|build|apply|status|port-forward [local-port]|gate|gate-manual|manual-evidence|smoke|logs|db-summary|reset-data|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down
  bash scripts/manage.sh ops k8s-shadow plan|dry-run|cycle|build|apply|status|gate|gate-manual|manual-evidence|smoke|logs|db-summary|reset-data|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down
  bash scripts/manage.sh ops awx-shadow plan|dry-run|install|status|port-forward [local-port]|logs|password|down
  bash scripts/manage.sh ops awx-provider list|upsert [provider-id] [base-url]|check <provider-id>
  bash scripts/manage.sh ops local-platform plan|dry-run|cycle [local-port]|status|down
  bash scripts/manage.sh k8s plan internal-shadow
  bash scripts/manage.sh k8s explain internal-shadow
  bash scripts/manage.sh k8s render internal-shadow
  bash scripts/manage.sh k8s dry-run internal-shadow
  bash scripts/manage.sh k8s apply internal-shadow
  bash scripts/manage.sh k8s status internal-shadow
  bash scripts/manage.sh k8s port-forward internal-local [local-port]
  bash scripts/manage.sh k8s logs internal-shadow
  bash scripts/manage.sh k8s db-summary internal-shadow
  MX_K8S_SHADOW_CONFIRM_RESET=1 bash scripts/manage.sh k8s reset-data internal-shadow
  bash scripts/manage.sh k8s remote-runner internal-shadow enable|disable
  bash scripts/manage.sh k8s readonly-probe internal-shadow enable|disable
  bash scripts/manage.sh k8s ssh-bootstrap internal-shadow enable|disable
  bash scripts/manage.sh k8s gate internal-shadow [local-port]
  bash scripts/manage.sh k8s gate-manual internal-shadow <evidence-json> [local-port]
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
    internal-local|internal-shadow)
      echo "mx-internal-shadow"
      ;;
    *)
      die "Unknown k8s target: $1"
      ;;
  esac
}

k8s_manifest_dir() {
  case "$1" in
    internal-local|internal-shadow)
      echo "$ROOT/deploy/k8s/internal-shadow"
      ;;
    *)
      die "Unknown k8s target: $1"
      ;;
  esac
}

shadow_image_artifacts() {
  say "materialize site-slot artifacts for shadow image"
  node server/scripts/site-slot-artifact-materializer.mjs all --out-dir server/artifacts/site-slots
}

shadow_image_build() {
  shadow_image_artifacts
  (cd server && docker compose -f docker-compose.shadow.yml build internal)
}

wait_http_ready() {
  local url="$1"
  local attempts="${2:-60}"
  local i
  for i in $(seq 1 "$attempts"); do
    if node -e "fetch(process.argv[1]).then((r)=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))" "$url"; then
      return 0
    fi
    sleep 1
  done
  die "HTTP endpoint did not become ready: $url"
}

port_available() {
  node -e '
    const net = require("node:net");
    const port = Number(process.argv[1]);
    const server = net.createServer();
    server.once("error", () => process.exit(1));
    server.listen(port, "127.0.0.1", () => server.close(() => process.exit(0)));
  ' "$1"
}

k8s_smoke_port() {
  local requested="$1"
  local candidate
  if port_available "$requested"; then
    echo "$requested"
    return
  fi
  say "local port $requested is busy; trying fallback smoke ports" >&2
  for candidate in 18190 18191 18192 18193; do
    if port_available "$candidate"; then
      echo "$candidate"
      return
    fi
  done
  die "No local port is available for k8s smoke"
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
  2. Apply Internal API ServiceAccount.
  3. Apply non-secret config ConfigMap.
  4. Apply DNS control target namespace and baseline CoreDNS ConfigMap.
  5. Create or update DB Secret from local env:
     PG_USER, PG_PASSWORD, PG_DB, DATABASE_URL.
  6. Apply PostgreSQL Service + StatefulSet.
  7. Apply CoreDNS ConfigMap writer RBAC.
  8. Wait for PostgreSQL rollout.
  9. Delete any previous migration Job, apply a fresh TypeORM migration Job,
     and wait for completion.
  10. Apply Internal API Deployment + Service.
  11. Wait for Internal API rollout.
  12. Run HTTP smoke through a temporary kubectl port-forward.

Data policy:
  k8s down keeps the PostgreSQL PVC by default. Delete PVCs only with a
  deliberate future purge action.
  k8s reset-data truncates mx_platform_records only. It keeps schema
  migrations, the database, and the PVC, then restarts Internal API so
  built-in App Center/DNS records are seeded again.
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
  cat "$dir"/05-serviceaccount.yaml
  printf '\n---\n'
  cat "$dir"/10-configmap.yaml
  printf '\n---\n'
  cat "$dir"/15-dns-control-target.yaml
  printf '\n---\n'
  cat "$dir"/20-postgres.yaml
  printf '\n---\n'
  cat "$dir"/25-coredns-rbac.yaml
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
  say "dry-run serviceaccount"
  kubectl apply --dry-run=client --validate=false -f "$dir/05-serviceaccount.yaml"
  say "dry-run configmap"
  kubectl apply --dry-run=client --validate=false -f "$dir/10-configmap.yaml"
  say "dry-run dns control target"
  kubectl apply --dry-run=client --validate=false -f "$dir/15-dns-control-target.yaml"
  say "dry-run generated db secret"
  k8s_secret_dry_run "$ns"
  say "dry-run postgres service/statefulset"
  kubectl apply --dry-run=client --validate=false -f "$dir/20-postgres.yaml"
  say "dry-run coredns writer rbac"
  kubectl apply --dry-run=client --validate=false -f "$dir/25-coredns-rbac.yaml"
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
  say "apply serviceaccount"
  kubectl apply -f "$dir/05-serviceaccount.yaml"
  say "apply configmap"
  kubectl apply -f "$dir/10-configmap.yaml"
  say "apply dns control target"
  kubectl apply -f "$dir/15-dns-control-target.yaml"
  say "create/update db secret from local env"
  k8s_apply_db_secret "$ns"
  say "apply postgres service/statefulset"
  kubectl apply -f "$dir/20-postgres.yaml"
  say "apply coredns writer rbac"
  kubectl apply -f "$dir/25-coredns-rbac.yaml"
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

k8s_remote_runner() {
  local target="$1"
  local state="$2"
  local ns value
  ns="$(k8s_namespace "$target")"
  case "$state" in
    enable|enabled|on|1)
      value="1"
      ;;
    disable|disabled|off|0)
      value="0"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-local remote-runner enable|disable"
      ;;
  esac
  need_kubectl
  say "set remote runner gates=$value on Internal API deployment"
  kubectl -n "$ns" set env deployment/mx-launcher-internal \
    "SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED=$value" \
    "SITE_SLOT_WORKER_REMOTE_SSH=$value" \
    "SITE_SLOT_CONFIRM_REMOTE_EXECUTION=$value"
  kubectl -n "$ns" rollout status deployment/mx-launcher-internal --timeout=180s
}

k8s_ssh_bootstrap() {
  local target="$1"
  local state="$2"
  local ns value
  ns="$(k8s_namespace "$target")"
  case "$state" in
    enable|enabled|on|1)
      value="1"
      ;;
    disable|disabled|off|0)
      value="0"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-local ssh-bootstrap enable|disable"
      ;;
  esac
  need_kubectl
  say "set SITE_SLOT_SSH_PASSWORD_BOOTSTRAP_ENABLED=$value on Internal API deployment"
  kubectl -n "$ns" set env deployment/mx-launcher-internal "SITE_SLOT_SSH_PASSWORD_BOOTSTRAP_ENABLED=$value"
  kubectl -n "$ns" rollout status deployment/mx-launcher-internal --timeout=180s
}

k8s_readonly_probe() {
  local target="$1"
  local state="$2"
  local ns value
  ns="$(k8s_namespace "$target")"
  case "$state" in
    enable|enabled|on|1)
      value="1"
      ;;
    disable|disabled|off|0)
      value="0"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-local readonly-probe enable|disable"
      ;;
  esac
  need_kubectl
  say "set SITE_SLOT_SSH_READONLY_PROBE_EXECUTE=$value on Internal API deployment"
  kubectl -n "$ns" set env deployment/mx-launcher-internal "SITE_SLOT_SSH_READONLY_PROBE_EXECUTE=$value"
  kubectl -n "$ns" rollout status deployment/mx-launcher-internal --timeout=180s
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

k8s_reset_data() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  if [ "${MX_K8S_SHADOW_CONFIRM_RESET:-}" != "1" ]; then
    die "Refusing to reset shadow data. Re-run with MX_K8S_SHADOW_CONFIRM_RESET=1 to truncate mx_platform_records."
  fi
  need_kubectl
  say "before reset"
  k8s_db_summary "$target"
  say "truncate mx_platform_records in namespace $ns"
  kubectl -n "$ns" exec statefulset/mx-internal-postgres -- \
    psql -v ON_ERROR_STOP=1 -U "${PG_USER:-mx_internal}" -d "${PG_DB:-mx_internal_shadow}" \
    -c "truncate table mx_platform_records;"
  say "restart Internal API so built-in records are seeded again"
  k8s_restart_internal_api "$target"
  say "after reset"
  k8s_db_summary "$target"
}

k8s_smoke() {
  local target="$1"
  local requested_port="${2:-18090}"
  local port
  local ns pf_pid
  ns="$(k8s_namespace "$target")"
  port="$(k8s_smoke_port "$requested_port")"
  need_kubectl
  say "port-forward mx-launcher-internal on 127.0.0.1:${port}"
  kubectl -n "$ns" port-forward svc/mx-launcher-internal "$port:18090" >/tmp/mx-launcher-k8s-port-forward.log 2>&1 &
  pf_pid="$!"
  sleep 2
  if ! (cd server && MX_SMOKE_EXPECT_K8S_APPLY=1 pnpm run smoke:http -- "http://127.0.0.1:${port}"); then
    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
    die "k8s smoke failed; see /tmp/mx-launcher-k8s-port-forward.log"
  fi
  kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true
}

k8s_port_forward() {
  local target="$1"
  local local_port="${2:-18090}"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  say "keep Internal API exposed on http://127.0.0.1:${local_port}"
  say "target namespace: $ns"
  say "press Ctrl+C in this terminal when you are done"
  kubectl -n "$ns" port-forward svc/mx-launcher-internal "${local_port}:18090"
}

k8s_internal_shadow_gate() {
  local target="$1"
  local requested_port="${2:-18090}"
  local ns port pf_pid gate_dir status_file db_file
  ns="$(k8s_namespace "$target")"
  port="$(k8s_smoke_port "$requested_port")"
  gate_dir="$ROOT/server/artifacts/internal-shadow-gates/$(date -u +%Y%m%dT%H%M%SZ)"
  status_file="$gate_dir/k8s-status.txt"
  db_file="$gate_dir/db-summary.txt"
  need_kubectl
  mkdir -p "$gate_dir"
  say "capture k8s rollout snapshot"
  kubectl -n "$ns" get deploy,statefulset,pod,svc,job,pvc -o wide >"$status_file"
  say "capture db summary"
  k8s_db_summary "$target" >"$db_file"
  say "port-forward mx-launcher-internal on 127.0.0.1:${port}"
  kubectl -n "$ns" port-forward svc/mx-launcher-internal "$port:18090" >/tmp/mx-launcher-k8s-port-forward.log 2>&1 &
  pf_pid="$!"
  sleep 2
  if ! (
    cd server
    MX_INTERNAL_SHADOW_GATE_OUTPUT_DIR="$gate_dir" \
      MX_INTERNAL_SHADOW_GATE_K8S_STATUS_FILE="$status_file" \
      MX_INTERNAL_SHADOW_GATE_DB_SUMMARY_FILE="$db_file" \
      MX_INTERNAL_SHADOW_GATE_REQUIRE_K8S_FILES=1 \
      MX_INTERNAL_SHADOW_GATE_EXPECT_K8S_APPLY=1 \
      node scripts/internal-shadow-gate.mjs "http://127.0.0.1:${port}"
  ); then
    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
    die "internal shadow gate failed; see $gate_dir and /tmp/mx-launcher-k8s-port-forward.log"
  fi
  kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true
  say "internal shadow gate OK; evidence: $gate_dir"
}

k8s_internal_shadow_gate_manual() {
  local target="$1"
  local evidence_path="$2"
  local port="${3:-18090}"
  [ -n "$evidence_path" ] || die "Usage: bash scripts/manage.sh k8s gate-manual internal-shadow <evidence-json> [local-port]"
  case "$evidence_path" in
    /*)
      ;;
    *)
      evidence_path="$ROOT/$evidence_path"
      ;;
  esac
  MX_INTERNAL_SHADOW_MANUAL_EVIDENCE_PATH="$evidence_path" \
    MX_INTERNAL_SHADOW_REQUIRE_MANUAL_EVIDENCE=1 \
    k8s_internal_shadow_gate "$target" "$port"
}

internal_shadow_manual_evidence() {
  local status="${1:-passed}"
  shift || true
  (cd server && node scripts/internal-shadow-manual-evidence.mjs "$status" "$@")
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
  say "delete coredns writer rbac"
  kubectl delete -f "$dir/25-coredns-rbac.yaml" --ignore-not-found
  say "delete postgres workload and service; PVC is kept"
  kubectl delete -f "$dir/20-postgres.yaml" --ignore-not-found
  say "delete dns control target"
  kubectl delete -f "$dir/15-dns-control-target.yaml" --ignore-not-found
  say "delete configmap and generated secret"
  kubectl delete -f "$dir/10-configmap.yaml" --ignore-not-found
  kubectl delete -f "$dir/05-serviceaccount.yaml" --ignore-not-found
  kubectl -n "$ns" delete secret mx-launcher-db --ignore-not-found
  say "namespace and PVC are kept for safe restart"
}

awx_shadow_namespace() {
  echo "mx-awx"
}

awx_shadow_name() {
  echo "mx-awx"
}

awx_shadow_manifest_dir() {
  echo "$ROOT/deploy/k8s/awx-shadow"
}

awx_shadow_operator_ref() {
  echo "${MX_AWX_OPERATOR_REF:-2.19.1}"
}

awx_shadow_kustomize_dir() {
  local dir ref safe_ref tmp
  dir="$(awx_shadow_manifest_dir)"
  ref="$(awx_shadow_operator_ref)"
  [ -d "$dir" ] || die "missing AWX shadow manifest directory: $dir"
  if [ "$ref" = "2.19.1" ]; then
    echo "$dir"
    return
  fi
  safe_ref="${ref//[^A-Za-z0-9._-]/_}"
  tmp="${TMPDIR:-/tmp}/mx-awx-shadow-kustomize-$safe_ref"
  rm -rf "$tmp"
  mkdir -p "$tmp"
  sed "s|ref=2.19.1|ref=$ref|g; s|newTag: 2.19.1|newTag: $ref|g" "$dir/kustomization.yaml" >"$tmp/kustomization.yaml"
  echo "$tmp"
}

awx_shadow_plan() {
  local ns name ref
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  ref="$(awx_shadow_operator_ref)"
  cat <<EOF
MX Launcher AWX shadow plan

Namespace: $ns
AWX name:  $name
Operator:  ansible/awx-operator $ref

Order:
  1. Apply namespace.
  2. Apply pinned AWX Operator manifests through Kustomize.
  3. Wait for AWX CRD to become Established.
  4. Create AWX custom resource $name.
  5. Wait for awx-operator-controller-manager rollout.
  6. Watch AWX web/task/postgres pods until the instance is ready.
  7. Read admin password from secret ${name}-admin-password.
  8. Port-forward service ${name}-service when local browser/API access is needed.
  9. Upsert an Internal awx-provider that points to:
     http://${name}-service.${ns}.svc.cluster.local

Boundary:
  AWX is an execution provider. Internal remains the source of truth for
  plans, worker jobs, evidence, audit, RBAC, rollback, and release gates.

Resource note:
  Docker Desktop Kubernetes should usually have about 6-8GB RAM, 4 CPUs,
  and 20-40GB free disk for comfortable local AWX testing.
EOF
}

awx_shadow_dry_run() {
  local dir kdir
  dir="$(awx_shadow_manifest_dir)"
  kdir="$(awx_shadow_kustomize_dir)"
  need_kubectl
  say "dry-run AWX Operator manifests"
  kubectl apply --dry-run=client --validate=false -k "$kdir"
  if kubectl get crd awxs.awx.ansible.com >/dev/null 2>&1; then
    say "dry-run mx-awx AWX custom resource"
    kubectl apply --dry-run=client --validate=false -f "$dir/10-awx.yaml"
  else
    say "skip mx-awx AWX custom resource dry-run because awxs.awx.ansible.com CRD is not installed yet"
  fi
}

awx_shadow_install() {
  local ns name dir kdir operator_timeout awx_timeout i
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  dir="$(awx_shadow_manifest_dir)"
  kdir="$(awx_shadow_kustomize_dir)"
  operator_timeout="${MX_AWX_OPERATOR_TIMEOUT:-180s}"
  awx_timeout="${MX_AWX_READY_TIMEOUT_SECONDS:-900}"
  need_kubectl
  say "apply AWX Operator manifests"
  kubectl apply -k "$kdir"
  say "wait AWX CRD"
  kubectl wait --for=condition=Established crd/awxs.awx.ansible.com --timeout="$operator_timeout"
  say "apply mx-awx AWX custom resource"
  kubectl apply -f "$dir/10-awx.yaml"
  say "wait AWX Operator rollout"
  kubectl -n "$ns" rollout status deployment/awx-operator-controller-manager --timeout="$operator_timeout"
  say "wait for AWX workloads to appear"
  for i in $(seq 1 "$awx_timeout"); do
    if kubectl -n "$ns" get deployment "$name-web" >/dev/null 2>&1 \
      && kubectl -n "$ns" get deployment "$name-task" >/dev/null 2>&1 \
      && kubectl -n "$ns" get statefulset "$name-postgres-15" >/dev/null 2>&1; then
      say "wait AWX web rollout"
      kubectl -n "$ns" rollout status deployment/"$name-web" --timeout=900s
      say "wait AWX task rollout"
      kubectl -n "$ns" rollout status deployment/"$name-task" --timeout=900s
      say "wait AWX postgres rollout"
      kubectl -n "$ns" rollout status statefulset/"$name-postgres-15" --timeout=900s
      awx_shadow_status
      say "AWX shadow install OK"
      return
    fi
    sleep 1
  done
  awx_shadow_status
  die "AWX web/task/postgres workloads did not appear before timeout; inspect operator logs with ops awx-shadow logs"
}

awx_shadow_status() {
  local ns
  ns="$(awx_shadow_namespace)"
  need_kubectl
  kubectl -n "$ns" get awx,deploy,statefulset,pod,svc,pvc 2>/dev/null || kubectl -n "$ns" get all
}

awx_shadow_logs() {
  local ns
  ns="$(awx_shadow_namespace)"
  need_kubectl
  kubectl -n "$ns" logs deployment/awx-operator-controller-manager -c awx-manager --tail=200
}

awx_shadow_port_forward() {
  local ns name local_port
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  local_port="${1:-18080}"
  need_kubectl
  say "keep AWX exposed on http://127.0.0.1:${local_port}"
  say "target service: ${name}-service.${ns}.svc.cluster.local:80"
  say "press Ctrl+C in this terminal when you are done"
  kubectl -n "$ns" port-forward svc/"$name-service" "${local_port}:80"
}

awx_shadow_password() {
  local ns name encoded
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  need_kubectl
  encoded="$(kubectl -n "$ns" get secret "$name-admin-password" -o jsonpath='{.data.password}')"
  [ -n "$encoded" ] || die "AWX admin password secret is empty or not ready: $name-admin-password"
  node -e 'console.log(Buffer.from(process.argv[1], "base64").toString("utf8"))' "$encoded"
}

awx_shadow_down() {
  local ns name
  ns="$(awx_shadow_namespace)"
  name="$(awx_shadow_name)"
  need_kubectl
  say "scale AWX workloads to zero; namespace, CR, Secret, and PVC are kept"
  kubectl -n "$ns" scale deployment/"$name" --replicas=0 2>/dev/null || true
  kubectl -n "$ns" scale statefulset/"$name-postgres" --replicas=0 2>/dev/null || true
  kubectl -n "$ns" scale deployment/awx-operator-controller-manager --replicas=0 2>/dev/null || true
  say "AWX shadow stopped. Re-run 'bash scripts/manage.sh ops awx-shadow install' to reconcile it again."
}

ops_awx_shadow() {
  local action="$1"
  shift || true
  case "$action" in
    plan)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow plan"
      awx_shadow_plan
      ;;
    dry-run)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow dry-run"
      awx_shadow_dry_run
      ;;
    install|apply|up)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow install"
      awx_shadow_install
      ;;
    status)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow status"
      awx_shadow_status
      ;;
    port-forward|forward)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops awx-shadow port-forward [local-port]"
      awx_shadow_port_forward "${1:-18080}"
      ;;
    logs)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow logs"
      awx_shadow_logs
      ;;
    password)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow password"
      awx_shadow_password
      ;;
    down)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-shadow down"
      awx_shadow_down
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops awx-shadow plan|dry-run|install|status|port-forward [local-port]|logs|password|down"
      ;;
  esac
}

ops_awx_provider() {
  local action="$1"
  shift || true
  local base="${MX_INTERNAL_BASE_URL:-http://127.0.0.1:18090}"
  case "$action" in
    list)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-provider list"
      node -e '
        const [base] = process.argv.slice(1);
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/awx-providers`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            providers: payload.providers.map((provider) => ({
              providerId: provider.providerId,
              name: provider.name,
              baseUrl: provider.baseUrl,
              organization: provider.organization,
              project: provider.project,
              defaultKind: provider.defaultKind,
              status: provider.status,
              inventoryPrefix: provider.inventoryPrefix,
              credentialPrefix: provider.credentialPrefix,
              jobTemplatePrefix: provider.jobTemplatePrefix,
              updatedAt: provider.updatedAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base"
      ;;
    upsert)
      [ "$#" -le 2 ] || die "Usage: bash scripts/manage.sh ops awx-provider upsert [provider-id] [base-url]"
      node -e '
        const [base, providerId = "", baseUrl = ""] = process.argv.slice(1);
        const body = {
          providerId: providerId || process.env.SITE_SLOT_AWX_PROVIDER_ID || "awxprov_oversea",
          name: process.env.SITE_SLOT_AWX_PROVIDER_NAME || "MX AWX Oversea",
          baseUrl: baseUrl || process.env.AWX_BASE_URL || "http://mx-awx-service.mx-awx.svc.cluster.local",
          organization: process.env.AWX_ORGANIZATION || "MX Internal",
          project: process.env.AWX_PROJECT || "mx-launcher-site-slots",
          inventoryPrefix: process.env.AWX_INVENTORY_PREFIX || "mx",
          credentialPrefix: process.env.AWX_CREDENTIAL_PREFIX || "mx",
          jobTemplatePrefix: process.env.AWX_JOB_TEMPLATE_PREFIX || "mx-site-slot",
          defaultKind: process.env.AWX_DEFAULT_KIND || "oversea",
          status: process.env.AWX_PROVIDER_STATUS || "active",
          verifyTls: process.env.AWX_VERIFY_TLS === "0" ? false : true,
          requestTimeoutSeconds: Number(process.env.AWX_REQUEST_TIMEOUT_SECONDS || "30"),
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-awx-provider-upsert"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/awx-providers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({ provider: payload.provider }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}" "${2:-}"
      ;;
    check)
      [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh ops awx-provider check <provider-id>"
      node -e '
        const [base, providerId] = process.argv.slice(1);
        const body = {
          token: process.env.SITE_SLOT_AWX_TOKEN || process.env.AWX_TOKEN || "",
          kind: process.env.AWX_CHECK_KIND || "oversea",
          requestTimeoutSeconds: Number(process.env.AWX_REQUEST_TIMEOUT_SECONDS || "30"),
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-awx-provider-check"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/awx-providers/${encodeURIComponent(providerId)}/check`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({ check: payload.check }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1"
      ;;
    mock-smoke)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops awx-provider mock-smoke"
      MX_INTERNAL_BASE_URL="$base" node server/scripts/awx-api-mock-smoke.mjs
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops awx-provider list|upsert [provider-id] [base-url]|check <provider-id>|mock-smoke"
      ;;
  esac
}

ops_local_platform_plan() {
  cat <<'EOF'
MX Launcher local-platform plan

This is the explicit one-command path for a full local platform stack.
It keeps the lightweight Internal cycle separate from the heavier AWX install.

Order:
  1. Install or reconcile AWX shadow in namespace mx-awx.
  2. Build and apply Internal K8s shadow in namespace mx-internal-shadow.
  3. Run Internal HTTP smoke and DB summary.
  4. Temporarily port-forward Internal API.
  5. Upsert Config Center awx-provider awxprov_oversea:
     http://mx-awx-service.mx-awx.svc.cluster.local

Commands:
  bash scripts/manage.sh ops local-platform dry-run
  bash scripts/manage.sh ops local-platform cycle
  bash scripts/manage.sh ops local-platform status
  bash scripts/manage.sh ops local-platform down

Notes:
  - ops k8s-shadow cycle remains Internal-only and does not install AWX.
  - Set MX_LOCAL_PLATFORM_CHECK_AWX=1 and SITE_SLOT_AWX_TOKEN or AWX_TOKEN to
    run the readonly awx-provider check after provider upsert.
EOF
}

local_platform_upsert_awx_provider() {
  local requested_port="${1:-18090}"
  local ns port pf_pid previous_base had_previous_base
  ns="$(k8s_namespace internal-shadow)"
  port="$(k8s_smoke_port "$requested_port")"
  need_kubectl
  say "port-forward Internal API on 127.0.0.1:${port} for provider upsert"
  kubectl -n "$ns" port-forward svc/mx-launcher-internal "$port:18090" >/tmp/mx-launcher-local-platform-port-forward.log 2>&1 &
  pf_pid="$!"
  sleep 2

  had_previous_base=0
  previous_base=""
  if [ "${MX_INTERNAL_BASE_URL+x}" = "x" ]; then
    had_previous_base=1
    previous_base="$MX_INTERNAL_BASE_URL"
  fi
  export MX_INTERNAL_BASE_URL="http://127.0.0.1:${port}"
  if ! ops_awx_provider upsert awxprov_oversea; then
    kill "$pf_pid" 2>/dev/null || true
    wait "$pf_pid" 2>/dev/null || true
    [ "$had_previous_base" -eq 1 ] && export MX_INTERNAL_BASE_URL="$previous_base" || unset MX_INTERNAL_BASE_URL
    die "local-platform failed while upserting awx-provider; see /tmp/mx-launcher-local-platform-port-forward.log"
  fi

  if [ "${MX_LOCAL_PLATFORM_CHECK_AWX:-0}" = "1" ]; then
    if [ -n "${SITE_SLOT_AWX_TOKEN:-${AWX_TOKEN:-}}" ]; then
      say "run readonly AWX provider check"
      if ! ops_awx_provider check awxprov_oversea; then
        kill "$pf_pid" 2>/dev/null || true
        wait "$pf_pid" 2>/dev/null || true
        [ "$had_previous_base" -eq 1 ] && export MX_INTERNAL_BASE_URL="$previous_base" || unset MX_INTERNAL_BASE_URL
        die "local-platform AWX provider check failed"
      fi
    else
      say "skip AWX provider check: SITE_SLOT_AWX_TOKEN or AWX_TOKEN is required"
    fi
  else
    say "skip AWX provider check; set MX_LOCAL_PLATFORM_CHECK_AWX=1 when AWX org/project/inventory/template are ready"
  fi

  kill "$pf_pid" 2>/dev/null || true
  wait "$pf_pid" 2>/dev/null || true
  [ "$had_previous_base" -eq 1 ] && export MX_INTERNAL_BASE_URL="$previous_base" || unset MX_INTERNAL_BASE_URL
}

ops_local_platform() {
  local action="$1"
  shift || true
  case "$action" in
    plan)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops local-platform plan"
      ops_local_platform_plan
      ;;
    dry-run)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops local-platform dry-run"
      say "dry-run AWX shadow"
      awx_shadow_dry_run
      say "dry-run Internal K8s shadow"
      k8s_dry_run internal-shadow
      ;;
    cycle)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops local-platform cycle [local-port]"
      ops_local_platform_plan
      say "install/reconcile AWX shadow"
      awx_shadow_install
      say "cycle Internal K8s shadow"
      ops_k8s_shadow cycle "${1:-18090}"
      say "upsert Internal AWX provider"
      local_platform_upsert_awx_provider "${1:-18090}"
      say "local-platform cycle OK. Use 'bash scripts/manage.sh ops local-platform status' to inspect it."
      ;;
    status)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops local-platform status"
      say "AWX shadow status"
      awx_shadow_status
      say "Internal K8s shadow status"
      k8s_status internal-shadow
      ;;
    down)
      [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh ops local-platform down"
      say "stop Internal K8s shadow"
      k8s_down internal-shadow
      say "stop AWX shadow"
      awx_shadow_down
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops local-platform plan|dry-run|cycle [local-port]|status|down"
      ;;
  esac
}

ops_guide() {
  cat <<'EOF'
MX Launcher local operator guide

Start here:
  cd electron-dock/mx-launcher
  bash scripts/manage.sh
  bash scripts/manage.sh ops doctor

Interactive local K8s/Internal test path:
  1. status            confirm node/pnpm/docker/kubectl and current namespace state
  3. k8s-plan          review the local Internal K8s rollout order
  4. k8s-dry-run       validate manifests and generated DB Secret
  7. k8s-cycle         build image, apply K8s, restart API, smoke, DB summary
  8. k8s-gate          run Internal Local Gate and record Test Center evidence
  9. k8s-smoke         rerun HTTP smoke through a temporary port-forward
  10. k8s-db           inspect seeded Internal state
  11. k8s-logs         inspect Internal API logs
  12. browser          print the persistent port-forward + browser manual test steps
  13. manual-evidence  write browser/Evidence Drawer evidence JSON after hand testing
  17. reset-data       clear local Internal business records for a fresh manual test
  18. remote-runner    temporarily enable/disable remote runner for true-host readonly tests
      readonly-probe   temporarily enable/disable real readonly SSH probe execution
      ssh-bootstrap    temporarily enable/disable one-time SSH password key bootstrap
  21. oversea-readonly run a true Oversea read-only SSH probe and record worker evidence
  22. oversea-remote   run a true Oversea gated pipeline or remote install
  23. down             stop workloads while keeping the PostgreSQL PVC

Path A: Docker Compose shadow, no K8s knowledge required.
  bash scripts/manage.sh ops local-shadow plan
  bash scripts/manage.sh ops local-shadow cycle

Path B: K8s learning path, safe dry-run first.
  bash scripts/manage.sh ops internal-local plan
  bash scripts/manage.sh ops internal-local dry-run

Path C: K8s deploy on Docker Desktop or a prepared Internal cluster.
  # Internal-only; does not install or restart AWX.
  bash scripts/manage.sh ops internal-local cycle
  bash scripts/manage.sh ops internal-local apply
  bash scripts/manage.sh ops internal-local status
  bash scripts/manage.sh ops internal-local port-forward
  bash scripts/manage.sh ops internal-local gate
  bash scripts/manage.sh ops internal-local manual-evidence passed "browser manual path passed"
  bash scripts/manage.sh ops internal-local gate-manual server/artifacts/internal-shadow-gates/manual/manual-browser-evidence-xxx.json
  bash scripts/manage.sh ops internal-local smoke
  bash scripts/manage.sh ops internal-local db-summary
  MX_K8S_SHADOW_CONFIRM_RESET=1 bash scripts/manage.sh ops internal-local reset-data
  bash scripts/manage.sh ops internal-local remote-runner enable
  bash scripts/manage.sh ops internal-local readonly-probe enable
  bash scripts/manage.sh ops internal-local ssh-bootstrap enable
  bash scripts/manage.sh ops internal-local logs
  bash scripts/manage.sh ops internal-local down

Path D: AWX shadow execution provider.
  bash scripts/manage.sh ops awx-shadow plan
  bash scripts/manage.sh ops awx-shadow dry-run
  bash scripts/manage.sh ops awx-shadow install
  bash scripts/manage.sh ops awx-shadow status
  bash scripts/manage.sh ops awx-shadow password
  bash scripts/manage.sh ops awx-shadow port-forward 18080
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops awx-provider upsert awxprov_oversea
  SITE_SLOT_AWX_TOKEN="$AWX_TOKEN" MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops awx-provider check awxprov_oversea
  bash scripts/manage.sh ops awx-shadow down

Path E: full local platform stack, explicit one-command path.
  bash scripts/manage.sh ops local-platform plan
  bash scripts/manage.sh ops local-platform cycle
  bash scripts/manage.sh ops local-platform status
  bash scripts/manage.sh ops local-platform down

Path F: Internal-owned site slot planning.
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot ssh-profile-upsert oversea-main oversea oversea.example.com
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops config feature-set site-slot.ssh-readonly-probe.execute true readonly-execute profile sshprof_oversea-main
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot ssh-profile-readiness sshprof_oversea-main plan-only
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519 \
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts \
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot oversea-readonly-test oversea-main oversea.example.com
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519 \
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts \
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot oversea-remote-test oversea-main oversea.example.com pipeline
  SITE_SLOT_CONFIRM_OVERSEA_EXECUTE=1 \
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519 \
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts \
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot oversea-remote-test oversea-main oversea.example.com execute
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot oversea-plan oversea.example.com
  bash scripts/manage.sh ops site-slot materialize oversea
  bash scripts/manage.sh ops site-slot refresh-tunnel-cli latest
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot domestic-plan domestic.example.com oversea.example.com
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot preflight slotplan_xxx
  SITE_SLOT_CONFIRM_APPLY=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot apply slotplan_xxx
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot runner-start slotexec_xxx
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot worker-job slotrunner_xxx
  SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot worker-gate slotjob_xxx confirm
  SITE_SLOT_CONFIRM_REMOTE_EXECUTION=1 SITE_SLOT_CONFIRM_WORKER_HANDOFF=1 MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops site-slot worker-handoff slotjob_xxx confirm

Path G: Admin management snapshots.
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops admin dashboard
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops admin actions
  MX_INTERNAL_BASE_URL=http://127.0.0.1:18090 \
    bash scripts/manage.sh ops admin site-slot-pipelines slotplan_xxx

Mental model:
  Compose "service"      -> K8s Deployment/StatefulSet
  Compose "environment"  -> K8s ConfigMap/Secret
  Compose "volume"       -> K8s PersistentVolumeClaim
  Compose "healthcheck"  -> K8s liveness/readiness probes
  One-time migration     -> K8s Job

Safe cleanup:
  local-shadow down stops Compose containers and keeps the PG Docker volume.
  internal-local down removes workloads and keeps the K8s PVC.
  internal-local reset-data truncates mx_platform_records, keeps migrations/PVC,
  and restarts Internal API to re-seed built-in records.
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
  [ -d deploy/k8s/awx-shadow ] && say "k8s awx-shadow manifests: OK" || say "k8s awx-shadow manifests: missing"
  say "doctor finished. If docker/kubectl checks are missing, start Docker Desktop and enable Kubernetes before K8s apply."
}

ops_config() {
  local action="$1"
  shift || true
  local base="${MX_INTERNAL_BASE_URL:-http://127.0.0.1:18090}"
  case "$action" in
    feature-list)
      node -e '
        const [base, featureKey = ""] = process.argv.slice(1);
        const query = featureKey ? `?featureKey=${encodeURIComponent(featureKey)}` : "";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/runtime-feature-policies${query}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            policies: payload.policies.map((policy) => ({
              policyId: policy.policyId,
              featureKey: policy.featureKey,
              scopeKind: policy.scopeKind,
              scopeId: policy.scopeId,
              enabled: policy.enabled,
              mode: policy.mode,
              expiresAt: policy.expiresAt,
              requiresApproval: policy.requiresApproval,
              updatedBy: policy.updatedBy,
              updatedAt: policy.updatedAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    feature-set)
      [ "$#" -ge 2 ] || die "Usage: bash scripts/manage.sh ops config feature-set <feature-key> <true|false> [plan-only|readonly-execute|remote-execute|disabled] [global|site|profile] [scope-id]"
      node -e '
        const [base, featureKey, enabledRaw, mode = "plan-only", scopeKind = "global", scopeId = ""] = process.argv.slice(1);
        const body = {
          featureKey,
          enabled: enabledRaw === "true" || enabledRaw === "1" || enabledRaw === "yes",
          mode,
          scopeKind,
          scopeId: scopeKind === "global" ? null : scopeId || null,
          requiresApproval: true,
          reason: process.env.MX_RUNTIME_FEATURE_REASON || "manage.sh feature-set",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-config-feature-set"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/runtime-feature-policies`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({ policy: payload.policy }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "$2" "${3:-plan-only}" "${4:-global}" "${5:-}"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops config feature-list [feature-key] | feature-set <feature-key> <true|false> [plan-only|readonly-execute|remote-execute|disabled] [global|site|profile] [scope-id]"
      ;;
  esac
}

ops_admin() {
  local action="$1"
  shift || true
  local base="${MX_INTERNAL_BASE_URL:-http://127.0.0.1:18090}"
  case "$action" in
    dashboard)
      node -e '
        const [base] = process.argv.slice(1);
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/admin/dashboard`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            generatedAt: payload.generatedAt,
            overview: {
              environment: payload.overview.environment,
              siteId: payload.overview.siteId,
              storeDriver: payload.overview.storeDriver,
              siteSlotPlans: payload.overview.siteSlotPlans,
              siteSlotRollbackExecutions: payload.overview.siteSlotRollbackExecutions,
              releaseManagementPlans: payload.overview.releaseManagementPlans,
              testRuns: payload.overview.testRuns
            },
            actionPolicy: {
              principal: payload.actionPolicy.principal,
              warnings: payload.actionPolicy.warnings,
              allowedActions: payload.actionPolicy.actions
                .filter((action) => action.allowed)
                .map((action) => action.actionId)
            },
            latestReleasePlans: payload.latestReleasePlans.map((plan) => ({
              planId: plan.planId,
              releaseId: plan.releaseId,
              readyToPromote: plan.decisions.readyToPromote,
              gate: plan.test.gate.verdict,
              createdAt: plan.createdAt
            })),
            siteSlotPipelines: payload.siteSlotPipelines.map((pipeline) => ({
              planId: pipeline.planId,
              siteId: pipeline.siteId,
              kind: pipeline.kind,
              health: pipeline.health,
              currentStage: pipeline.currentStage,
              latestStatus: pipeline.latestStatus,
              counts: pipeline.counts,
              latestUpdatedAt: pipeline.latestUpdatedAt
            })),
            nextActions: payload.nextActions
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base"
      ;;
    actions)
      node -e '
        const [base, token = ""] = process.argv.slice(1);
        const query = token ? `?token=${encodeURIComponent(token)}` : "";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/admin/actions${query}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            principal: payload.actionPolicy.principal,
            warnings: payload.actionPolicy.warnings,
            actions: payload.actionPolicy.actions.map((action) => ({
              actionId: action.actionId,
              label: action.label,
              category: action.category,
              gate: action.gate,
              risk: action.risk,
              allowed: action.allowed,
              reason: action.reason,
              requiredScopes: action.requiredScopes
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    site-slot-pipelines)
      node -e '
        const [base, planId = ""] = process.argv.slice(1);
        const path = planId
          ? `/internal/v1/admin/site-slots/pipelines/${encodeURIComponent(planId)}`
          : "/internal/v1/admin/site-slots/pipelines";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}${path}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          if (payload.pipeline) {
            const pipeline = payload.pipeline;
            console.log(JSON.stringify({
              summary: pipeline.summary,
              executions: pipeline.executions.map((execution) => ({
                runId: execution.runId,
                action: execution.action,
                mode: execution.mode,
                status: execution.status,
                createdAt: execution.createdAt
              })),
              runnerSessions: pipeline.runnerSessions.map((session) => ({
                sessionId: session.sessionId,
                runId: session.runId,
                mode: session.mode,
                status: session.status,
                startedAt: session.startedAt,
                finishedAt: session.finishedAt
              })),
              workerJobs: pipeline.workerJobs.map((job) => ({
                jobId: job.jobId,
                sessionId: job.sessionId,
                worker: job.worker,
                status: job.status,
                currentReportId: job.currentReportId
              })),
              workerReports: pipeline.workerReports.map((report) => ({
                reportId: report.reportId,
                jobId: report.jobId,
                status: report.status,
                rollbackPlanId: report.rollbackPlan?.rollbackPlanId || null
              })),
              rollbackExecutions: pipeline.rollbackExecutions.map((execution) => ({
                rollbackExecutionId: execution.rollbackExecutionId,
                sourceReportId: execution.sourceReportId,
                status: execution.status,
                currentRollbackReportId: execution.currentRollbackReportId
              })),
              rollbackReports: pipeline.rollbackReports.map((report) => ({
                rollbackReportId: report.rollbackReportId,
                rollbackExecutionId: report.rollbackExecutionId,
                status: report.status
              })),
              timeline: pipeline.timeline
            }, null, 2));
            return;
          }
          console.log(JSON.stringify({
            pipelines: payload.pipelines.map((pipeline) => ({
              summary: pipeline.summary,
              lastTimelineEntry: pipeline.timeline[pipeline.timeline.length - 1] || null
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops admin dashboard | actions [token] | site-slot-pipelines [plan-id]"
      ;;
  esac
}

ops_site_slot() {
  local action="$1"
  shift || true
  local base="${MX_INTERNAL_BASE_URL:-http://127.0.0.1:18090}"
  case "$action" in
    materialize)
      [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh ops site-slot materialize [oversea|domestic|all]"
      node server/scripts/site-slot-artifact-materializer.mjs "${1:-all}"
      ;;
    domestic-wg-secret-upsert)
      [ "$#" -ge 2 ] || die "Usage: MX_DOMESTIC_RELAY_PRIVATE_KEY=... MX_DOMESTIC_RELAY_PUBLIC_KEY=... MX_INTERNAL_SERVICE_PRIVATE_KEY=... MX_INTERNAL_SERVICE_PUBLIC_KEY=... bash scripts/manage.sh ops site-slot domestic-wg-secret-upsert <site-id> <endpoint>"
      node -e '
        const [base, siteId, endpoint] = process.argv.slice(1);
        const body = {
          siteId,
          publicEndpoint: endpoint,
          listenPort: Number(process.env.MX_WG_LISTEN_PORT || "51820"),
          domesticGatewayIp: process.env.MX_DOMESTIC_GATEWAY_IP || "10.88.0.1",
          domesticGatewayCidr: process.env.MX_DOMESTIC_GATEWAY_CIDR || "10.88.0.0/16",
          userRelayCidr: process.env.MX_USER_RELAY_CIDR || "10.89.0.0/16",
          internalServiceIp: process.env.MX_INTERNAL_SERVICE_IP || "10.90.0.10",
          internalServiceCidr: process.env.MX_INTERNAL_SERVICE_CIDR || "10.90.0.0/16",
          guestRelayCidr: process.env.MX_GUEST_RELAY_CIDR || "10.91.0.0/16",
          domesticRelayPrivateKey: process.env.MX_DOMESTIC_RELAY_PRIVATE_KEY || null,
          domesticRelayPublicKey: process.env.MX_DOMESTIC_RELAY_PUBLIC_KEY || null,
          internalServicePrivateKey: process.env.MX_INTERNAL_SERVICE_PRIVATE_KEY || null,
          internalServicePublicKey: process.env.MX_INTERNAL_SERVICE_PUBLIC_KEY || null,
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-domestic-wg-secret-upsert"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/domestic-wg-secrets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify(payload, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "$2"
      ;;
    materialize-domestic-ready)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot materialize-domestic-ready <site-id>"
      node -e '
        const { spawnSync } = require("node:child_process");
        const [base, siteId] = process.argv.slice(1);
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/domestic-wg-secrets/${encodeURIComponent(siteId)}/materializer-env`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              confirmSecretExport: true,
              requestedBy: process.env.USER || "manage.sh",
              requestId: "manage-materialize-domestic-ready"
            })
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          if (payload.export?.status !== "ready") throw new Error(JSON.stringify(payload, null, 2));
          const child = spawnSync(process.execPath, ["server/scripts/site-slot-artifact-materializer.mjs", "domestic"], {
            stdio: "inherit",
            env: { ...process.env, ...payload.export.env }
          });
          process.exit(child.status ?? 1);
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1"
      ;;
    refresh-tunnel-cli)
      node server/scripts/site-slot-refresh-tunnel-cli.mjs "$@"
      ;;
    ssh-profiles)
      node -e '
        const [base] = process.argv.slice(1);
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/site-slot-ssh-profiles`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            profiles: payload.profiles.map((profile) => ({
              profileId: profile.profileId,
              siteId: profile.siteId,
              kind: profile.kind,
              host: profile.host,
              sshUser: profile.sshUser,
              sshPort: profile.sshPort,
              identityFile: profile.identityFile,
              knownHostsFile: profile.knownHostsFile,
              hostKeyAlias: profile.hostKeyAlias,
              strictHostKeyChecking: profile.strictHostKeyChecking,
              connectTimeoutSeconds: profile.connectTimeoutSeconds,
              batchMode: profile.batchMode,
              status: profile.status,
              warnings: profile.warnings,
              updatedAt: profile.updatedAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base"
      ;;
    ssh-profile-upsert)
      [ "$#" -ge 2 ] || die "Usage: bash scripts/manage.sh ops site-slot ssh-profile-upsert <site-id> <domestic|oversea> [host]"
      node -e '
        const [base, siteId, kind, host = ""] = process.argv.slice(1);
        const body = {
          profileId: process.env.SITE_SLOT_SSH_PROFILE_ID || `sshprof_${siteId.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
          siteId,
          kind,
          host: host || process.env.SITE_SLOT_HOST || null,
          sshUser: process.env.SLOT_SSH_USER || "root",
          sshPort: Number(process.env.SLOT_SSH_PORT || "22"),
          identityFile: process.env.SITE_SLOT_SSH_IDENTITY_FILE || null,
          knownHostsFile: process.env.SITE_SLOT_SSH_KNOWN_HOSTS_FILE || null,
          hostKeyAlias: process.env.SITE_SLOT_SSH_HOST_KEY_ALIAS || siteId,
          strictHostKeyChecking: process.env.SITE_SLOT_SSH_STRICT_HOST_KEY_CHECKING || "yes",
          connectTimeoutSeconds: Number(process.env.SITE_SLOT_SSH_CONNECT_TIMEOUT_SECONDS || "10"),
          batchMode: process.env.SITE_SLOT_SSH_BATCH_MODE || "yes",
          status: process.env.SITE_SLOT_SSH_PROFILE_STATUS || "active",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-ssh-profile-upsert"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/site-slot-ssh-profiles`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const profile = payload.profile;
          console.log(JSON.stringify({
            profileId: profile.profileId,
            siteId: profile.siteId,
            kind: profile.kind,
            host: profile.host,
            sshUser: profile.sshUser,
            sshPort: profile.sshPort,
            identityFile: profile.identityFile,
            knownHostsFile: profile.knownHostsFile,
            hostKeyAlias: profile.hostKeyAlias,
            strictHostKeyChecking: profile.strictHostKeyChecking,
            connectTimeoutSeconds: profile.connectTimeoutSeconds,
            batchMode: profile.batchMode,
            status: profile.status,
            warnings: profile.warnings,
            updatedAt: profile.updatedAt
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "$2" "${3:-}"
      ;;
    ssh-profile-readiness)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot ssh-profile-readiness <profile-id> [plan-only|execute]"
      node -e '
        const [base, profileId, mode = "plan-only"] = process.argv.slice(1);
        const body = {
          confirmReadOnlyProbe: true,
          executeReadOnlyProbe: mode === "execute",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-ssh-profile-readiness"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/config-center/site-slot-ssh-profiles/${encodeURIComponent(profileId)}/readiness-probe`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const readiness = payload.readiness;
          console.log(JSON.stringify({
            probeId: readiness.probeId,
            profileId: readiness.profileId,
            siteId: readiness.siteId,
            kind: readiness.kind,
            status: readiness.status,
            verdict: readiness.verdict,
            mode: readiness.mode,
            execution: readiness.execution,
            boundary: readiness.boundary,
            sshProfile: readiness.sshProfile,
            command: readiness.command,
            env: readiness.env,
            gates: readiness.gates,
            gateFailures: readiness.gateFailures,
            executionFailures: readiness.executionFailures,
            executionResult: readiness.executionResult,
            nextActions: readiness.nextActions
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-plan-only}"
      ;;
    oversea-readonly-test)
      [ "$#" -ge 2 ] || die "Usage: SITE_SLOT_SSH_IDENTITY_FILE=/path/key SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/known_hosts bash scripts/manage.sh ops site-slot oversea-readonly-test <site-id> <host>"
      node server/scripts/site-slot-oversea-readonly-test.mjs "$base" "$1" "$2"
      ;;
    oversea-remote-test)
      [ "$#" -ge 2 ] || die "Usage: SITE_SLOT_SSH_IDENTITY_FILE=/path/key SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/known_hosts bash scripts/manage.sh ops site-slot oversea-remote-test <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute]"
      node server/scripts/site-slot-oversea-remote-test.mjs "$base" "$1" "$2" "${3:-pipeline}"
      ;;
    domestic-plan)
      [ "$#" -ge 1 ] || [ -n "${SITE_SLOT_SSH_PROFILE_ID:-}" ] || die "Usage: bash scripts/manage.sh ops site-slot domestic-plan <domestic-host|-> [oversea-host]"
      local domestic_host="${1:-}"
      local oversea_host="${2:-}"
      [ "$domestic_host" = "-" ] && domestic_host=""
      node -e '
        const [base, host = "", overseaHost = ""] = process.argv.slice(1);
        const body = {
          kind: "domestic",
          siteId: process.env.SLOT_SITE_ID || "domestic-main",
          sshProfileId: process.env.SITE_SLOT_SSH_PROFILE_ID || null,
          host: host || null,
          sshUser: process.env.SLOT_SSH_USER || "root",
          sshPort: Number(process.env.SLOT_SSH_PORT || "22"),
          rootAccess: process.env.SLOT_ROOT_ACCESS !== "0",
          hasDocker: process.env.SLOT_HAS_DOCKER !== "0",
          hasOutboundInternet: process.env.DOMESTIC_HAS_OUTBOUND === "1",
          overseaSiteId: process.env.OVERSEA_SITE_ID || (overseaHost ? "oversea-main" : null),
          overseaHost: overseaHost || null,
          internalBaseUrl: base.replace(/\/+$/, ""),
          createdBy: process.env.USER || "manage.sh",
          requestId: "manage-domestic-slot-plan"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/plans`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const plan = payload.plan;
          console.log(JSON.stringify({
            planId: plan.planId,
            siteId: plan.siteId,
            kind: plan.kind,
            status: plan.status,
            ssh: plan.ssh,
            networkMode: plan.network.mode,
            qpTunnelCliMode: plan.network.qpTunnelCliMode,
            hostServices: plan.services.hostServices,
            dockerStacks: plan.services.dockerStacks,
            warnings: plan.warnings,
            nextActions: plan.nextActions,
            preflightChecks: plan.preflightChecks.map((row) => ({ checkId: row.checkId, severity: row.severity, command: row.command })),
            deploymentPhases: plan.deploymentPhases.map((row) => ({ phaseId: row.phaseId, mode: row.mode, target: row.target }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$domestic_host" "$oversea_host"
      ;;
    oversea-plan)
      [ "$#" -ge 1 ] || [ -n "${SITE_SLOT_SSH_PROFILE_ID:-}" ] || die "Usage: bash scripts/manage.sh ops site-slot oversea-plan <oversea-host|->"
      local oversea_host="${1:-}"
      [ "$oversea_host" = "-" ] && oversea_host=""
      node -e '
        const [base, host = ""] = process.argv.slice(1);
        const body = {
          kind: "oversea",
          siteId: process.env.SLOT_SITE_ID || process.env.OVERSEA_SITE_ID || "oversea-main",
          sshProfileId: process.env.SITE_SLOT_SSH_PROFILE_ID || null,
          host: host || null,
          sshUser: process.env.SLOT_SSH_USER || "root",
          sshPort: Number(process.env.SLOT_SSH_PORT || "22"),
          rootAccess: process.env.SLOT_ROOT_ACCESS !== "0",
          hasDocker: process.env.SLOT_HAS_DOCKER !== "0",
          hasOutboundInternet: true,
          internalBaseUrl: base.replace(/\/+$/, ""),
          createdBy: process.env.USER || "manage.sh",
          requestId: "manage-oversea-slot-plan"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/plans`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const plan = payload.plan;
          console.log(JSON.stringify({
            planId: plan.planId,
            siteId: plan.siteId,
            kind: plan.kind,
            status: plan.status,
            ssh: plan.ssh,
            qpTunnelCliMode: plan.network.qpTunnelCliMode,
            dockerStacks: plan.services.dockerStacks,
            warnings: plan.warnings,
            nextActions: plan.nextActions,
            preflightChecks: plan.preflightChecks.map((row) => ({ checkId: row.checkId, severity: row.severity, command: row.command })),
            deploymentPhases: plan.deploymentPhases.map((row) => ({ phaseId: row.phaseId, mode: row.mode, target: row.target }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$oversea_host"
      ;;
    preflight)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot preflight <plan-id> [dry-run|manual|ssh]"
      node -e '
        const [base, planId, mode = "dry-run"] = process.argv.slice(1);
        const body = {
          mode,
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-preflight"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/plans/${encodeURIComponent(planId)}/preflight`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const run = payload.execution;
          console.log(JSON.stringify({
            runId: run.runId,
            planId: run.planId,
            siteId: run.siteId,
            kind: run.kind,
            action: run.action,
            mode: run.mode,
            status: run.status,
            dryRun: run.dryRun,
            remoteExecution: run.remoteExecution,
            warnings: run.warnings,
            nextActions: run.nextActions,
            steps: run.steps.map((step) => ({
              order: step.order,
              sourceId: step.sourceId,
              target: step.target,
              requiresRoot: step.requiresRoot,
              command: step.command,
              expected: step.expected
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-dry-run}"
      ;;
    apply)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot apply <plan-id> [manual|dry-run|ssh]"
      node -e '
        const [base, planId, mode = "manual"] = process.argv.slice(1);
        const body = {
          mode,
          confirmApply: process.env.SITE_SLOT_CONFIRM_APPLY === "1",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-apply"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/plans/${encodeURIComponent(planId)}/apply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const run = payload.execution;
          console.log(JSON.stringify({
            runId: run.runId,
            planId: run.planId,
            siteId: run.siteId,
            kind: run.kind,
            action: run.action,
            mode: run.mode,
            status: run.status,
            dryRun: run.dryRun,
            confirmApply: run.confirmApply,
            remoteExecution: run.remoteExecution,
            gates: run.gates,
            warnings: run.warnings,
            nextActions: run.nextActions,
            steps: run.steps.map((step) => ({
              order: step.order,
              sourceId: step.sourceId,
              target: step.target,
              requiresRoot: step.requiresRoot,
              command: step.command,
              expected: step.expected
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-manual}"
      ;;
    executions)
      node -e '
        const [base, planId = ""] = process.argv.slice(1);
        const query = planId ? `?planId=${encodeURIComponent(planId)}` : "";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/executions${query}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            executions: payload.executions.map((run) => ({
              runId: run.runId,
              planId: run.planId,
              siteId: run.siteId,
              kind: run.kind,
              action: run.action,
              mode: run.mode,
              status: run.status,
              stepCount: run.steps.length,
              createdAt: run.createdAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    runner-start)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot runner-start <run-id> [simulate|remote-ssh|awx-shadow]"
      node -e '
        const [base, runId, mode = "simulate"] = process.argv.slice(1);
        const body = {
          mode,
          confirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === "1",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-runner-start"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/executions/${encodeURIComponent(runId)}/runner-sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const session = payload.session;
          console.log(JSON.stringify({
            sessionId: session.sessionId,
            runId: session.runId,
            planId: session.planId,
            siteId: session.siteId,
            kind: session.kind,
            mode: session.mode,
            status: session.status,
            dryRun: session.dryRun,
            confirmRemoteExecution: session.confirmRemoteExecution,
            gates: session.gates,
            warnings: session.warnings,
            nextActions: session.nextActions,
            stepResults: session.stepResults.map((step) => ({
              order: step.order,
              sourceId: step.sourceId,
              target: step.target,
              status: step.status,
              exitCode: step.exitCode,
              command: step.command,
              output: step.output,
              error: step.error
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-simulate}"
      ;;
    runner-sessions)
      node -e '
        const [base, runId = ""] = process.argv.slice(1);
        const query = runId ? `?runId=${encodeURIComponent(runId)}` : "";
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/runner-sessions${query}`);
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            sessions: payload.sessions.map((session) => ({
              sessionId: session.sessionId,
              runId: session.runId,
              planId: session.planId,
              siteId: session.siteId,
              kind: session.kind,
              mode: session.mode,
              status: session.status,
              stepCount: session.stepResults.length,
              startedAt: session.startedAt,
              finishedAt: session.finishedAt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "${1:-}"
      ;;
    worker-job)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-job <session-id>"
      node -e '
        const [base, sessionId] = process.argv.slice(1);
        const body = {
          workerId: process.env.SITE_SLOT_WORKER_ID || "worker-manage-shadow",
          workerKind: process.env.SITE_SLOT_WORKER_KIND || "internal-runner",
          approvalId: process.env.SITE_SLOT_APPROVAL_ID || null,
          changeWindowStart: process.env.SITE_SLOT_CHANGE_WINDOW_START || null,
          changeWindowEnd: process.env.SITE_SLOT_CHANGE_WINDOW_END || null,
          retryLimit: Number(process.env.SITE_SLOT_RETRY_LIMIT || "1"),
          rollbackStrategy: process.env.SITE_SLOT_ROLLBACK_STRATEGY || "no-op-simulated-rollback",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-worker-job"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/runner-sessions/${encodeURIComponent(sessionId)}/worker-jobs`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const job = payload.job;
          console.log(JSON.stringify({
            jobId: job.jobId,
            contractVersion: job.contractVersion,
            sessionId: job.sessionId,
            runId: job.runId,
            planId: job.planId,
            siteId: job.siteId,
            kind: job.kind,
            mode: job.mode,
            status: job.status,
            dryRun: job.dryRun,
            worker: job.worker,
            approval: job.approval,
            changeWindow: job.changeWindow,
            retryPolicy: job.retryPolicy,
            rollbackPolicy: job.rollbackPolicy,
            warnings: job.warnings,
            nextActions: job.nextActions,
            steps: job.steps.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              sourceId: step.sourceId,
              target: step.target,
              requiresRoot: step.requiresRoot,
              timeoutSeconds: step.timeoutSeconds,
              stopOnFailure: step.stopOnFailure,
              redactOutput: step.redactOutput,
              command: step.command
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1"
      ;;
    worker-gate)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-gate <job-id> [confirm]"
      node -e '
        const [base, jobId, confirm = ""] = process.argv.slice(1);
        const body = {
          confirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === "1" || confirm === "confirm" || confirm === "true",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-worker-gate"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}/remote-ssh-gate`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const gate = payload.gate;
          console.log(JSON.stringify({
            gateId: gate.gateId,
            jobId: gate.jobId,
            planId: gate.planId,
            siteId: gate.siteId,
            kind: gate.kind,
            status: gate.status,
            verdict: gate.verdict,
            execution: gate.execution,
            boundary: gate.boundary,
            confirmRemoteExecution: gate.confirmRemoteExecution,
            environmentGates: gate.environmentGates,
            sshProfile: gate.sshProfile,
            summary: gate.summary,
            jobGateFailures: gate.jobGateFailures,
            gateFailures: gate.gateFailures,
            nextActions: gate.nextActions,
            stepGates: gate.stepGates.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              sourceId: step.sourceId,
              target: step.target,
              commandKind: step.commandKind,
              execution: step.execution,
              status: step.status,
              transport: step.transport,
              artifactReferences: step.artifactReferences,
              gateFailures: step.gateFailures
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-}"
      ;;
    worker-handoff)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-handoff <job-id> [confirm]"
      node -e '
        const [base, jobId, confirm = ""] = process.argv.slice(1);
        const confirmed = confirm === "confirm" || confirm === "true";
        const body = {
          confirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === "1" || confirmed,
          confirmWorkerHandoff: process.env.SITE_SLOT_CONFIRM_WORKER_HANDOFF === "1" || confirmed,
          internalBaseUrl: process.env.MX_INTERNAL_BASE_URL || base.replace(/\/+$/, ""),
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-worker-handoff"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}/run-artifact-push-remote-ssh`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const gate = payload.gate;
          const handoff = payload.workerHandoff;
          console.log(JSON.stringify({
            gate: {
              gateId: gate.gateId,
              status: gate.status,
              verdict: gate.verdict,
              gateFailures: gate.gateFailures,
              summary: gate.summary,
              sshProfile: gate.sshProfile
            },
            workerHandoff: handoff
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-}"
      ;;
    domestic-relay-append-ssh-prepare)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot domestic-relay-append-ssh-prepare <apply-run-id> [confirm]"
      node -e '
        const [base, runId, confirm = ""] = process.argv.slice(1);
        const confirmed = confirm === "confirm" || confirm === "true";
        const now = new Date();
        const body = {
          actionId: "site-slot.domestic-relay-peer-append-ssh.prepare",
          path: `/internal/v1/site-slots/executions/${encodeURIComponent(runId)}/prepare-domestic-relay-peer-append-ssh`,
          body: {
            confirmRemoteExecution: process.env.SITE_SLOT_CONFIRM_REMOTE_EXECUTION === "1" || confirmed,
            confirmRelayPeerAppendSshPrepare: process.env.SITE_SLOT_CONFIRM_RELAY_PEER_APPEND_SSH_PREPARE === "1" || confirmed,
            approvalId: process.env.SITE_SLOT_APPROVAL_ID || `approval-domestic-relay-peer-append-${runId}`,
            changeWindowStart: process.env.SITE_SLOT_CHANGE_WINDOW_START || now.toISOString(),
            changeWindowEnd: process.env.SITE_SLOT_CHANGE_WINDOW_END || new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
            workerId: process.env.SITE_SLOT_WORKER_ID || "worker-domestic-relay",
            workerKind: process.env.SITE_SLOT_WORKER_KIND || "domestic-runner",
            retryLimit: Number(process.env.SITE_SLOT_WORKER_RETRY_LIMIT || "1"),
            rollbackStrategy: process.env.SITE_SLOT_ROLLBACK_STRATEGY || "restore-domestic-wg-peer-before-append",
            requestedBy: process.env.USER || "manage.sh",
            requestId: "manage-domestic-relay-peer-append-ssh-prepare"
          }
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/admin/actions/execute`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          console.log(JSON.stringify({
            prepare: payload.relayPeerAppendSshPrepare,
            session: payload.session ? {
              sessionId: payload.session.sessionId,
              runId: payload.session.runId,
              mode: payload.session.mode,
              status: payload.session.status,
              gates: payload.session.gates,
              warnings: payload.session.warnings
            } : null,
            job: payload.job ? {
              jobId: payload.job.jobId,
              sessionId: payload.job.sessionId,
              runId: payload.job.runId,
              mode: payload.job.mode,
              status: payload.job.status,
              worker: payload.job.worker,
              approval: payload.job.approval,
              changeWindow: payload.job.changeWindow,
              nextActions: payload.job.nextActions
            } : null
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-}"
      ;;
    worker-run)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-run <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec]"
      node server/scripts/site-slot-worker-run.mjs "$base" "$1" "${2:-simulate}"
      ;;
    worker-report)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot worker-report <job-id> [running|passed|failed|blocked]"
      node -e '
        const [base, jobId, status = "passed"] = process.argv.slice(1);
        const body = {
          workerId: process.env.SITE_SLOT_WORKER_ID || "worker-manage-shadow",
          status,
          message: process.env.SITE_SLOT_WORKER_MESSAGE || `manage.sh worker report ${status}`,
          stepReports: process.env.SITE_SLOT_WORKER_STEP_ID ? [{
            stepId: process.env.SITE_SLOT_WORKER_STEP_ID,
            status,
            exitCode: status === "passed" ? 0 : null,
            stdout: process.env.SITE_SLOT_WORKER_STDOUT || null,
            stderr: process.env.SITE_SLOT_WORKER_STDERR || null,
            attempt: Number(process.env.SITE_SLOT_WORKER_ATTEMPT || "1")
          }] : [],
          requestId: "manage-site-slot-worker-report"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/worker-jobs/${encodeURIComponent(jobId)}/reports`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const report = payload.report;
          console.log(JSON.stringify({
            reportId: report.reportId,
            jobId: report.jobId,
            sessionId: report.sessionId,
            runId: report.runId,
            planId: report.planId,
            siteId: report.siteId,
            workerId: report.workerId,
            status: report.status,
            message: report.message,
            rollbackPlan: report.rollbackPlan,
            nextActions: report.nextActions,
            stepReports: report.stepReports.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              sourceId: step.sourceId,
              status: step.status,
              exitCode: step.exitCode,
              stdout: step.stdout,
              stderr: step.stderr,
              attempt: step.attempt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-passed}"
      ;;
    rollback-start)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot rollback-start <report-id> [simulate|manual]"
      node -e '
        const [base, reportId, mode = "simulate"] = process.argv.slice(1);
        const body = {
          mode,
          confirmRollback: process.env.SITE_SLOT_CONFIRM_ROLLBACK === "1",
          requestedBy: process.env.USER || "manage.sh",
          requestId: "manage-site-slot-rollback-start"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/worker-reports/${encodeURIComponent(reportId)}/rollback-executions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const execution = payload.rollbackExecution;
          console.log(JSON.stringify({
            rollbackExecutionId: execution.rollbackExecutionId,
            contractVersion: execution.contractVersion,
            rollbackPlanId: execution.rollbackPlanId,
            sourceReportId: execution.sourceReportId,
            jobId: execution.jobId,
            sessionId: execution.sessionId,
            runId: execution.runId,
            planId: execution.planId,
            siteId: execution.siteId,
            mode: execution.mode,
            status: execution.status,
            dryRun: execution.dryRun,
            confirmRollback: execution.confirmRollback,
            gates: execution.gates,
            warnings: execution.warnings,
            rollbackPlan: execution.rollbackPlan,
            nextActions: execution.nextActions,
            stepResults: execution.stepResults.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              target: step.target,
              status: step.status,
              exitCode: step.exitCode,
              command: step.command,
              output: step.output,
              error: step.error
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-simulate}"
      ;;
    rollback-report)
      [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot rollback-report <rollback-execution-id> [running|passed|failed|blocked]"
      node -e '
        const [base, rollbackExecutionId, status = "passed"] = process.argv.slice(1);
        const body = {
          workerId: process.env.SITE_SLOT_ROLLBACK_WORKER_ID || process.env.SITE_SLOT_WORKER_ID || "worker-manage-shadow",
          status,
          message: process.env.SITE_SLOT_ROLLBACK_MESSAGE || `manage.sh rollback report ${status}`,
          stepReports: process.env.SITE_SLOT_ROLLBACK_STEP_ID ? [{
            stepId: process.env.SITE_SLOT_ROLLBACK_STEP_ID,
            status,
            exitCode: status === "passed" ? 0 : null,
            stdout: process.env.SITE_SLOT_ROLLBACK_STDOUT || null,
            stderr: process.env.SITE_SLOT_ROLLBACK_STDERR || null,
            attempt: Number(process.env.SITE_SLOT_ROLLBACK_ATTEMPT || "1")
          }] : [],
          requestId: "manage-site-slot-rollback-report"
        };
        (async () => {
          const res = await fetch(`${base.replace(/\/+$/, "")}/internal/v1/site-slots/rollback-executions/${encodeURIComponent(rollbackExecutionId)}/reports`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body)
          });
          const payload = await res.json();
          if (!res.ok) throw new Error(JSON.stringify(payload));
          const report = payload.rollbackReport;
          console.log(JSON.stringify({
            rollbackReportId: report.rollbackReportId,
            rollbackExecutionId: report.rollbackExecutionId,
            rollbackPlanId: report.rollbackPlanId,
            sourceReportId: report.sourceReportId,
            jobId: report.jobId,
            sessionId: report.sessionId,
            runId: report.runId,
            planId: report.planId,
            siteId: report.siteId,
            workerId: report.workerId,
            status: report.status,
            message: report.message,
            nextActions: report.nextActions,
            stepReports: report.stepReports.map((step) => ({
              order: step.order,
              stepId: step.stepId,
              target: step.target,
              status: step.status,
              exitCode: step.exitCode,
              stdout: step.stdout,
              stderr: step.stderr,
              attempt: step.attempt
            }))
          }, null, 2));
        })().catch((error) => {
          console.error(error.message);
          process.exit(1);
        });
      ' "$base" "$1" "${2:-passed}"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops site-slot materialize [oversea|domestic|all] | refresh-tunnel-cli [version|--from-local DIR] | ssh-profiles | ssh-profile-upsert <site-id> <domestic|oversea> [host] | ssh-profile-readiness <profile-id> [plan-only|execute] | oversea-readonly-test <site-id> <host> | oversea-remote-test <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute] | domestic-plan <domestic-host|-> [oversea-host] | oversea-plan <oversea-host|-> | preflight <plan-id> [dry-run|manual|ssh] | apply <plan-id> [manual|dry-run|ssh] | executions [plan-id] | runner-start <run-id> [simulate|remote-ssh|awx-shadow] | runner-sessions [run-id] | worker-job <session-id> | worker-gate <job-id> [confirm] | worker-handoff <job-id> [confirm] | domestic-relay-append-ssh-prepare <apply-run-id> [confirm] | worker-run <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec] | worker-report <job-id> [running|passed|failed|blocked] | rollback-start <report-id> [simulate|manual] | rollback-report <rollback-execution-id> [running|passed|failed|blocked]"
      ;;
  esac
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
      shadow_image_build
      ;;
    up)
      (cd server && docker compose -f docker-compose.shadow.yml up -d)
      wait_http_ready "http://127.0.0.1:18090/readyz" 60
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
  local target="${1:-internal-shadow}"
  local ops_area="${2:-k8s-shadow}"
  k8s_plan "$target"
  printf '\n'
  k8s_explain "$target"
  cat <<EOF

Local Internal image flow
  - ops $ops_area cycle builds qpjoy/mx-launcher-server:shadow before apply.
  - The local image tag is reused, so cycle restarts the Internal API
    Deployment after apply. A new Pod then resolves the rebuilt local image.
EOF
}

k8s_restart_internal_api() {
  local target="$1"
  local ns
  ns="$(k8s_namespace "$target")"
  need_kubectl
  kubectl -n "$ns" rollout restart deployment/mx-launcher-internal
  kubectl -n "$ns" rollout status deployment/mx-launcher-internal --timeout=180s
}

ops_k8s_shadow() {
  local action="$1"
  local target="${OPS_K8S_TARGET:-internal-shadow}"
  local ops_area="${OPS_K8S_AREA:-k8s-shadow}"
  case "$action" in
    plan)
      ops_k8s_shadow_plan "$target" "$ops_area"
      ;;
    dry-run)
      k8s_dry_run "$target"
      ;;
    build)
      shadow_image_build
      ;;
    cycle)
      ops_k8s_shadow_plan "$target" "$ops_area"
      say "build image"
      shadow_image_build
      say "apply"
      k8s_apply "$target"
      say "restart internal api for rebuilt local image"
      k8s_restart_internal_api "$target"
      say "status"
      k8s_status "$target"
      say "smoke"
      k8s_smoke "$target" "${2:-18090}"
      say "db summary"
      k8s_db_summary "$target"
      say "$ops_area cycle OK. Run 'bash scripts/manage.sh ops $ops_area down' when done."
      ;;
    apply)
      k8s_apply "$target"
      ;;
    status)
      k8s_status "$target"
      ;;
    port-forward|forward)
      k8s_port_forward "$target" "${2:-18090}"
      ;;
    smoke)
      k8s_smoke "$target" "${2:-18090}"
      ;;
    gate)
      k8s_internal_shadow_gate "$target" "${2:-18090}"
      ;;
    gate-manual)
      [ "$#" -ge 2 ] && [ "$#" -le 3 ] || die "Usage: bash scripts/manage.sh ops $ops_area gate-manual <evidence-json> [local-port]"
      k8s_internal_shadow_gate_manual "$target" "$2" "${3:-18090}"
      ;;
    manual-evidence)
      shift || true
      internal_shadow_manual_evidence "$@"
      ;;
    logs)
      k8s_logs "$target"
      ;;
    db-summary)
      k8s_db_summary "$target"
      ;;
    reset-data)
      k8s_reset_data "$target"
      ;;
    remote-runner)
      shift || true
      [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh ops $ops_area remote-runner enable|disable"
      k8s_remote_runner "$target" "$1"
      ;;
    readonly-probe)
      shift || true
      [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh ops $ops_area readonly-probe enable|disable"
      k8s_readonly_probe "$target" "$1"
      ;;
    ssh-bootstrap)
      shift || true
      [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh ops $ops_area ssh-bootstrap enable|disable"
      k8s_ssh_bootstrap "$target" "$1"
      ;;
    down)
      k8s_down "$target"
      ;;
    *)
      die "Usage: bash scripts/manage.sh ops internal-local plan|dry-run|cycle|build|apply|status|port-forward [local-port]|gate|gate-manual|manual-evidence|smoke|logs|db-summary|reset-data|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down"
      ;;
  esac
}

menu_status() {
  ops_doctor || true
  printf '\n'

  if command -v kubectl >/dev/null 2>&1; then
    local ns
    ns="$(k8s_namespace internal-local)"
    say "k8s namespace: $ns"
    kubectl -n "$ns" get deploy,statefulset,pod,svc,job,pvc 2>/dev/null || say "local Internal K8s is not running yet"
  else
    say "kubectl is missing; start Docker Desktop Kubernetes or install kubectl before K8s tests"
  fi
}

menu_browser_plan() {
  cat <<'EOF'
Browser manual test path for local K8s Internal:

Terminal 1: keep the Internal API exposed while you test.
  cd electron-dock/mx-launcher
  bash scripts/manage.sh ops internal-local port-forward

Terminal 2: serve the browser-friendly Launcher UI shell.
  cd electron-dock/mx-launcher
  python3 -m http.server 18110 --directory desktop

Browser:
  http://127.0.0.1:18110/index.html

Manual checks:
  1. Server URL is http://127.0.0.1:18090.
  2. App Center loads HDO without console errors.
  3. Switch to Admin and click Refresh.
  4. Confirm dashboard metrics, topology, action list, and site-slot pipelines render.
  5. Create or reuse an SSH Profile, then create a plan from it.
  6. Run Preflight, Apply, Runner, Worker Job, and plan-only/dry-run worker actions.
  7. Open Evidence Drawer and verify execution, runner, worker job, and report details.

Record manual evidence after checks:
  bash scripts/manage.sh ops internal-local manual-evidence passed "browser manual path passed"

Run gate with manual evidence required:
  bash scripts/manage.sh ops internal-local gate-manual server/artifacts/internal-shadow-gates/manual/manual-browser-evidence-xxx.json

Non-interactive equivalents:
  bash scripts/manage.sh ops internal-local cycle
  bash scripts/manage.sh ops internal-local gate
  bash scripts/manage.sh ops internal-local manual-evidence passed "browser manual path passed"
  bash scripts/manage.sh ops internal-local smoke
  bash scripts/manage.sh ops internal-local db-summary
  MX_K8S_SHADOW_CONFIRM_RESET=1 bash scripts/manage.sh ops internal-local reset-data
  bash scripts/manage.sh ops internal-local logs
EOF
}

menu_reset_data() {
  cat <<'EOF'
This will clear local K8s shadow business records:
  table: mx_platform_records

It keeps:
  - mx_schema_migrations
  - the PostgreSQL database and PVC
  - K8s namespace/workloads

After truncating records, Internal API is restarted so built-in App Center/DNS
records are seeded again.
EOF
  printf '\nType reset to continue> '
  local confirm
  IFS= read -r confirm || return 0
  if [ "$confirm" != "reset" ]; then
    say "reset-data cancelled"
    return 0
  fi
  MX_K8S_SHADOW_CONFIRM_RESET=1 k8s_reset_data internal-shadow
}

menu_manual_evidence() {
  printf 'Manual evidence status [passed/failed/blocked] (default passed)> '
  local status
  IFS= read -r status || return 0
  status="${status:-passed}"
  case "$status" in
    passed|failed|blocked)
      ;;
    *)
      say "manual-evidence cancelled: invalid status $status"
      return 0
      ;;
  esac
  printf 'Notes (optional)> '
  local notes
  IFS= read -r notes || notes=""
  internal_shadow_manual_evidence "$status" "$notes"
}

menu_oversea_readonly_test() {
  cat <<'EOF'
Oversea readonly true-host test requires local SSH files:
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts

For K8s shadow, run option remote-runner enable before this test.
Run option readonly-probe enable before executing the true read-only SSH probe.
EOF
  printf 'Oversea site id (default oversea-main)> '
  local site_id
  IFS= read -r site_id || return 0
  site_id="${site_id:-oversea-main}"
  printf 'Oversea host/IP> '
  local host
  IFS= read -r host || return 0
  if [ -z "$host" ]; then
    say "oversea-readonly-test cancelled: host is required"
    return 0
  fi
  ops_site_slot oversea-readonly-test "$site_id" "$host"
}

menu_oversea_remote_test() {
  cat <<'EOF'
Oversea remote test uses the same gated worker path as Admin:
  pipeline  = materialize + artifact dry-run + remote command plan + readonly SSH probe
  execute   = real SSH/rsync/scp execution; requires SITE_SLOT_CONFIRM_OVERSEA_EXECUTE=1

Required local SSH files:
  SITE_SLOT_SSH_IDENTITY_FILE=/path/to/oversea_ed25519
  SITE_SLOT_SSH_KNOWN_HOSTS_FILE=/path/to/known_hosts

For K8s shadow, run option remote-runner enable before this test.
Run option readonly-probe enable before executing the true read-only SSH probe.
EOF
  printf 'Oversea site id (default oversea-main)> '
  local site_id
  IFS= read -r site_id || return 0
  site_id="${site_id:-oversea-main}"
  printf 'Oversea host/IP> '
  local host
  IFS= read -r host || return 0
  if [ -z "$host" ]; then
    say "oversea-remote-test cancelled: host is required"
    return 0
  fi
  printf 'Mode [pipeline/dry-run/plan-only/readonly/execute] (default pipeline)> '
  local mode
  IFS= read -r mode || return 0
  mode="${mode:-pipeline}"
  ops_site_slot oversea-remote-test "$site_id" "$host" "$mode"
}

menu_remote_runner() {
  printf 'Remote runner [enable/disable] (default enable)> '
  local state
  IFS= read -r state || return 0
  state="${state:-enable}"
  ops_k8s_shadow remote-runner "$state"
}

menu_readonly_probe() {
  printf 'Readonly probe execution [enable/disable] (default enable)> '
  local state
  IFS= read -r state || return 0
  state="${state:-enable}"
  ops_k8s_shadow readonly-probe "$state"
}

menu_ssh_bootstrap() {
  printf 'SSH password bootstrap [enable/disable] (default enable)> '
  local state
  IFS= read -r state || return 0
  state="${state:-enable}"
  ops_k8s_shadow ssh-bootstrap "$state"
}

menu_show() {
  printf '\n'
  if [ -t 1 ]; then
    printf '\033[36mQPJoy MX Launcher Manager\033[0m\n'
  else
    printf 'QPJoy MX Launcher Manager\n'
  fi
  cat <<'EOF'

 1) status            本机 Internal/K8s 状态
 2) doctor            检查 Node / pnpm / Docker / kubectl
 3) k8s-plan          查看本机 Internal K8s 部署计划
 4) k8s-dry-run       K8s manifests + Secret dry-run
 5) k8s-build         构建本机 Internal API 镜像
 6) k8s-apply         启动/更新本机 K8s Internal
 7) k8s-cycle         build + apply + smoke + DB summary
 8) k8s-gate          Internal Local Gate + Test Center evidence
 9) k8s-smoke         port-forward 后跑 HTTP smoke
10) k8s-db            查看 K8s PostgreSQL 数据摘要
11) k8s-logs          查看 Internal API 日志
12) browser           浏览器手测步骤
13) manual-evidence   生成浏览器手测 evidence JSON
14) desktop-check     检查桌面 Admin/Evidence UI 脚本
15) server-typecheck  检查服务端 TypeScript
16) artifacts         生成 Domestic/Oversea slot artifacts
17) reset-data        清空本机 Internal 业务数据（保留 PVC/迁移记录）
18) remote-runner     为真机只读测试临时启/停 remote runner
19) readonly-probe    为真机只读 Probe 临时启/停执行闸门
20) ssh-bootstrap     为初次空 Ubuntu 临时启/停密码换 key
21) oversea-readonly  跑 Oversea 真机只读 Probe 并写 worker evidence
22) oversea-remote    跑 Oversea 真机 pipeline / gated 安装
23) down              停掉 K8s workloads（保留 PVC）
24) awx-plan          查看 AWX shadow 部署计划
25) awx-install       部署/恢复本机 K8s AWX shadow
26) awx-status        查看 AWX shadow 状态
27) awx-password      输出 AWX admin 密码
28) platform-cycle    一键 AWX + Internal + provider
29) guide             查看本机测试方案
30) help              查看 CLI 帮助
31) quit              退出
EOF
}

menu_pause() {
  printf '\n按 Enter 返回菜单...'
  IFS= read -r _ || true
}

menu_run() {
  local choice="$1"
  case "$choice" in
    1|status)
      menu_status
      ;;
    2|doctor)
      ops_doctor
      ;;
    3|k8s-plan|plan)
      ops_k8s_shadow plan
      ;;
    4|k8s-dry-run|dry-run)
      ops_k8s_shadow dry-run
      ;;
    5|k8s-build|build)
      ops_k8s_shadow build
      ;;
    6|k8s-apply|apply)
      ops_k8s_shadow apply
      ;;
    7|k8s-cycle|cycle)
      ops_k8s_shadow cycle
      ;;
    8|k8s-gate|gate)
      ops_k8s_shadow gate
      ;;
    9|k8s-smoke|smoke)
      ops_k8s_shadow smoke
      ;;
    10|k8s-db|db|db-summary)
      ops_k8s_shadow db-summary
      ;;
    11|k8s-logs|logs)
      ops_k8s_shadow logs
      ;;
    12|browser|manual)
      menu_browser_plan
      ;;
    13|manual-evidence)
      menu_manual_evidence
      ;;
    14|desktop-check)
      (cd desktop && pnpm run check)
      ;;
    15|server-typecheck)
      run_tsc -p server/tsconfig.json --noEmit
      ;;
    16|artifacts|materialize)
      ops_site_slot materialize all
      ;;
    17|reset-data|reset)
      menu_reset_data
      ;;
    18|remote-runner)
      menu_remote_runner
      ;;
    19|readonly-probe)
      menu_readonly_probe
      ;;
    20|ssh-bootstrap|bootstrap)
      menu_ssh_bootstrap
      ;;
    21|oversea-readonly|oversea-readonly-test)
      menu_oversea_readonly_test
      ;;
    22|oversea-remote|oversea-remote-test)
      menu_oversea_remote_test
      ;;
    23|down)
      ops_k8s_shadow down
      ;;
    24|awx-plan)
      ops_awx_shadow plan
      ;;
    25|awx-install)
      ops_awx_shadow install
      ;;
    26|awx-status)
      ops_awx_shadow status
      ;;
    27|awx-password)
      ops_awx_shadow password
      ;;
    28|platform-cycle|local-platform)
      ops_local_platform cycle
      ;;
    29|guide)
      ops_guide
      ;;
    30|help)
      usage
      ;;
    31|quit|q|exit)
      MENU_QUIT=1
      return 0
      ;;
    *)
      say "Unknown option: $choice"
      ;;
  esac
}

menu() {
  while true; do
    menu_show
    printf '\n选择> '
    IFS= read -r choice || return 0
    MENU_QUIT=0
    menu_run "$choice"
    [ "${MENU_QUIT:-0}" -eq 1 ] && return 0
    menu_pause
  done
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
  menu)
    [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh menu"
    menu
    ;;
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
      shadow_image_build
      ;;
      up)
        (cd server && docker compose -f docker-compose.shadow.yml up -d)
        wait_http_ready "http://127.0.0.1:18090/readyz" 60
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
    [ "$#" -ge 2 ] || die "Usage: bash scripts/manage.sh k8s plan|explain|render|dry-run|apply|status|port-forward|logs|db-summary|reset-data|remote-runner|readonly-probe|ssh-bootstrap|gate|gate-manual|smoke|down internal-local"
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
      port-forward|forward)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh k8s port-forward internal-local [local-port]"
        k8s_port_forward "$target" "${1:-18090}"
        ;;
      logs)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s logs internal-shadow"
        k8s_logs "$target"
        ;;
      db-summary)
        [ "$#" -eq 0 ] || die "Usage: bash scripts/manage.sh k8s db-summary internal-shadow"
        k8s_db_summary "$target"
        ;;
      reset-data)
        [ "$#" -eq 0 ] || die "Usage: MX_K8S_SHADOW_CONFIRM_RESET=1 bash scripts/manage.sh k8s reset-data internal-shadow"
        k8s_reset_data "$target"
        ;;
      remote-runner)
        [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh k8s remote-runner internal-shadow enable|disable"
        k8s_remote_runner "$target" "$1"
        ;;
      readonly-probe)
        [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh k8s readonly-probe internal-shadow enable|disable"
        k8s_readonly_probe "$target" "$1"
        ;;
      ssh-bootstrap)
        [ "$#" -eq 1 ] || die "Usage: bash scripts/manage.sh k8s ssh-bootstrap internal-shadow enable|disable"
        k8s_ssh_bootstrap "$target" "$1"
        ;;
      gate)
        [ "$#" -le 1 ] || die "Usage: bash scripts/manage.sh k8s gate internal-shadow [local-port]"
        k8s_internal_shadow_gate "$target" "${1:-18090}"
        ;;
      gate-manual)
        [ "$#" -ge 1 ] && [ "$#" -le 2 ] || die "Usage: bash scripts/manage.sh k8s gate-manual internal-shadow <evidence-json> [local-port]"
        k8s_internal_shadow_gate_manual "$target" "$1" "${2:-18090}"
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
    [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops guide|doctor|config|admin|site-slot|local-shadow|k8s-shadow|awx-shadow|awx-provider|local-platform"
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
      config)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops config feature-list [feature-key] | feature-set <feature-key> <true|false> [plan-only|readonly-execute|remote-execute|disabled] [global|site|profile] [scope-id]"
        ops_config "$@"
        ;;
      admin)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops admin dashboard | actions [token] | site-slot-pipelines [plan-id]"
        ops_admin "$@"
        ;;
      site-slot)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops site-slot materialize [oversea|domestic|all] | refresh-tunnel-cli [version|--from-local DIR] | ssh-profiles | ssh-profile-upsert <site-id> <domestic|oversea> [host] | ssh-profile-readiness <profile-id> [plan-only|execute] | oversea-readonly-test <site-id> <host> | oversea-remote-test <site-id> <host> [pipeline|dry-run|plan-only|readonly|execute] | domestic-plan <domestic-host|-> [oversea-host] | oversea-plan <oversea-host|-> | preflight <plan-id> [dry-run|manual|ssh] | apply <plan-id> [manual|dry-run|ssh] | executions [plan-id] | runner-start <run-id> [simulate|remote-ssh|awx-shadow] | runner-sessions [run-id] | worker-job <session-id> | worker-gate <job-id> [confirm] | worker-handoff <job-id> [confirm] | domestic-relay-append-ssh-prepare <apply-run-id> [confirm] | worker-run <job-id> [simulate|artifact-push-dry-run|artifact-push-remote-ssh-plan|remote-readonly-probe|artifact-push-remote-ssh|artifact-push-fake-transport|awx-shadow|awx-credential-sync|awx-object-sync|awx-launch|local-exec] | worker-report <job-id> [running|passed|failed|blocked] | rollback-start <report-id> [simulate|manual] | rollback-report <rollback-execution-id> [running|passed|failed|blocked]"
        ops_site_slot "$@"
        ;;
      local-shadow)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops local-shadow plan|cycle|build|up|status|smoke|logs|down"
        ops_local_shadow "$@"
        ;;
      internal-local)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops internal-local plan|dry-run|cycle|build|apply|status|port-forward [local-port]|gate|gate-manual|manual-evidence|smoke|logs|db-summary|reset-data|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down"
        OPS_K8S_TARGET=internal-local OPS_K8S_AREA=internal-local ops_k8s_shadow "$@"
        ;;
      k8s-shadow)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops k8s-shadow plan|dry-run|cycle|build|apply|status|gate|gate-manual|manual-evidence|smoke|logs|db-summary|reset-data|remote-runner enable|disable|readonly-probe enable|disable|ssh-bootstrap enable|disable|down"
        ops_k8s_shadow "$@"
        ;;
      awx-shadow)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops awx-shadow plan|dry-run|install|status|port-forward [local-port]|logs|password|down"
        ops_awx_shadow "$@"
        ;;
      awx-provider)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops awx-provider list|upsert [provider-id] [base-url]|check <provider-id>"
        ops_awx_provider "$@"
        ;;
      local-platform)
        [ "$#" -ge 1 ] || die "Usage: bash scripts/manage.sh ops local-platform plan|dry-run|cycle [local-port]|status|down"
        ops_local_platform "$@"
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
