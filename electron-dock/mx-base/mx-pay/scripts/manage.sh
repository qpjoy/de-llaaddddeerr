#!/usr/bin/env bash
# Stable per-product deployment contract for the future Internal Admin executor.
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ACTION="${1:-help}"
say() { printf '[mx-pay] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }
usage() {
  cat <<'HELP'
mx-pay: deploy | migrate | status | doctor | discover | backup | logs | start | stop | restart
  bash scripts/manage.sh deploy   # discover, provision dedicated PG, migrate, rollout
  bash scripts/manage.sh discover # read-only JSON capabilities for a future global manage.sh
  bash scripts/manage.sh backup   # verified PG archive + private recovery metadata
  bash scripts/manage.sh status   # read-only, current deployment target
Configuration is discovered at runtime; .env is optional overrides (see .env.example).
Default Kubernetes; MX_PAY_DEPLOY_DRIVER=compose is development/transition only.
deploy does NOT move Hub orders/wallets, enable live collection, or restart other systems.
No delete-data/down/all command. Noninteractive deployment needs no extra prompt.
HELP
}
case "$ACTION" in help|-h|--help) usage; exit 0;; deploy|migrate|status|doctor|discover|backup|logs|start|stop|restart) ;; *) die "Unsupported action: $ACTION";; esac
[ "$#" -le 1 ] || die 'Unexpected arguments'
if [ -f "$ROOT/.env" ]; then set -a; source "$ROOT/.env"; set +a; fi
export MX_PAY_DEPLOY_DRIVER="${MX_PAY_DEPLOY_DRIVER:-k8s}"
export MX_PAY_ACTION="$ACTION"
export MX_PAY_NAMESPACE="${MX_PAY_NAMESPACE:-mx-pay}"
export MX_PAY_REPLICAS="${MX_PAY_REPLICAS:-2}"
export MX_PAY_MIN_READY_WORKERS="${MX_PAY_MIN_READY_WORKERS:-2}"
[[ "$MX_PAY_NAMESPACE" =~ ^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$ ]] || die 'Invalid namespace'
[[ "$MX_PAY_REPLICAS" =~ ^([2-9]|1[0-9]|20)$ ]] || die 'MX_PAY_REPLICAS must be 2–20'
absolute() { case "$1" in /*) printf '%s' "$1";; *) printf '%s/%s' "$ROOT" "$1";; esac; }
export MX_PAY_RUNTIME_ENV_FILE="$(absolute "${MX_PAY_RUNTIME_ENV_FILE:-secrets/runtime.env}")"
# Preserve previously configured single-role installs; a fresh managed database
# gets a distinct owner credential that is never mounted in the API Pod.
if [ -z "${MX_PAY_MIGRATION_ENV_FILE:-}" ]; then
  if [ -f "$ROOT/secrets/migration.env" ]; then MX_PAY_MIGRATION_ENV_FILE=secrets/migration.env
  elif [ -f "$MX_PAY_RUNTIME_ENV_FILE" ]; then MX_PAY_MIGRATION_ENV_FILE="$MX_PAY_RUNTIME_ENV_FILE"
  else MX_PAY_MIGRATION_ENV_FILE=secrets/migration.env; fi
fi
export MX_PAY_MIGRATION_ENV_FILE="$(absolute "$MX_PAY_MIGRATION_ENV_FILE")"
export MX_PAY_CREDENTIALS_SOURCE="$(absolute "${MX_PAY_CREDENTIALS_SOURCE:-secrets/credentials.json}")"
export MX_PAY_CHANNELS_SOURCE="$(absolute "${MX_PAY_CHANNELS_SOURCE:-secrets/channels.json}")"
export MX_PAY_SSO_SOURCE_EXPLICIT="${MX_PAY_SSO_SOURCE:+1}"
export MX_PAY_SSO_SOURCE="$(absolute "${MX_PAY_SSO_SOURCE:-secrets/console/profile.json}")"
export MX_PAY_CONSOLE_ACCESS_SOURCE="$(absolute "${MX_PAY_CONSOLE_ACCESS_SOURCE:-secrets/console/access.json}")"
export MX_PAY_UID="${MX_PAY_UID:-$(id -u)}" MX_PAY_GID="${MX_PAY_GID:-$(id -g)}"
TMP='' LOCK_UID='' JOB_RUNNING=0 LOCAL_LOCK=0 PHASE=preflight
mkdir -p "$ROOT/.deploy"
kube() { kubectl --context "$MX_PAY_KUBE_CONTEXT" --request-timeout=15s -n "$MX_PAY_NAMESPACE" "$@"; }
compose() {
  if [ -f "$MX_PAY_SSO_SOURCE" ]; then
    docker compose --project-directory "$ROOT" -f "$ROOT/deploy/compose.yml" -f "$ROOT/deploy/console.compose.yml" "$@"
  else
    docker compose --project-directory "$ROOT" -f "$ROOT/deploy/compose.yml" "$@"
  fi
}
cleanup() {
  local result=$?
  trap - EXIT INT TERM
  if [ "$PHASE" = database ] && [ "$result" != 0 ] && [ -n "$LOCK_UID" ]; then
    # Initialization has its own bounded Job. Never unlock while its termination
    # or completion is unknown, including a lost kubectl connection.
    if ! kube get job mx-pay-postgres-init --ignore-not-found -o json | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{if(s.trim()&&!JSON.parse(s).status?.succeeded)process.exit(1)})'; then
      say 'Database initialization unresolved; retained mx-pay-deploy-lock. Inspect mx-pay-postgres-init before recovery.' >&2
      LOCK_UID=''
    fi
  fi
  if [ "$JOB_RUNNING" = 1 ]; then
    # A timeout must not release the deploy lock while the DDL Job is still alive.
    if ! kube delete job "$MX_PAY_JOB_NAME" --ignore-not-found --wait=true --timeout=90s --request-timeout=100s; then
      say 'Migration termination unconfirmed; retained mx-pay-deploy-lock. Inspect the Job before recovering.' >&2
      LOCK_UID=''; result=1
    fi
  fi
  if [ -n "$LOCK_UID" ]; then
    printf '{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"%s"}}' "$LOCK_UID" > "$TMP/unlock.json"
    kube delete --raw "/api/v1/namespaces/$MX_PAY_NAMESPACE/configmaps/mx-pay-deploy-lock" -f "$TMP/unlock.json" >/dev/null || result=1
  fi
  if [ "$LOCAL_LOCK" = 1 ]; then rmdir "$ROOT/.deploy/lock" || result=1; fi
  if [ "$ACTION" = deploy ] || [ "$ACTION" = migrate ]; then
    printf '{"action":"%s","phase":"%s","exitCode":%s}\n' "$ACTION" "$PHASE" "$result" > "$ROOT/.deploy/last-result.json"
  fi
  [ -z "$TMP" ] || rm -rf "$TMP"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
case "$MX_PAY_DEPLOY_DRIVER" in
  k8s)
    need kubectl; need node
    MX_PAY_KUBE_CONTEXT="$(node "$ROOT/scripts/runtime.mjs" target "$ROOT")" || exit 1
    export MX_PAY_KUBE_CONTEXT
    [ "$ACTION" = discover ] || say "target=k8s context=$MX_PAY_KUBE_CONTEXT namespace=$MX_PAY_NAMESPACE"
    case "$ACTION" in
      discover) node "$ROOT/scripts/runtime.mjs" discover "$ROOT"; exit;;
      status) kube get deployment,statefulset,service,pdb,job,pvc -l app.kubernetes.io/part-of=mx-pay -o wide; exit;;
      logs)
        kube logs deployment/mx-pay --all-pods=true --prefix=true --tail=100
        console_workload="$(kube get deployment mx-pay-console --ignore-not-found -o name)"
        if [ -n "$console_workload" ]; then kube logs deployment/mx-pay-console --all-pods=true --prefix=true --tail=100; fi
        exit;;
      doctor) node "$ROOT/scripts/runtime.mjs" discover "$ROOT"; kube get nodes -o wide; kube get deployment,pods,job,pdb,pvc -l app.kubernetes.io/part-of=mx-pay -o wide; exit;;
    esac
    ;;
  compose)
    need docker
    say "target=compose context=$(docker context show) (no rolling availability guarantee)"
    if [ -f "$ROOT/.deploy/image" ]; then export MX_PAY_IMAGE="${MX_PAY_IMAGE:-$(cat "$ROOT/.deploy/image")}"; fi
    case "$ACTION" in
      discover|backup) die "$ACTION currently requires Kubernetes; Compose uses an externally managed database";;
      status|doctor) export MX_PAY_IMAGE="${MX_PAY_IMAGE:-mx-pay:not-deployed}"; compose ps --all; exit;;
      logs)
        if [ -f "$MX_PAY_SSO_SOURCE" ]; then compose logs --tail=100 api console; else compose logs --tail=100 api; fi
        exit;;
    esac
    ;;
  *) die 'MX_PAY_DEPLOY_DRIVER must be k8s or compose';;
esac
need node
TMP="$(mktemp -d "${TMPDIR:-/tmp}/mx-pay-deploy.XXXXXXXX")"
if [ "$MX_PAY_DEPLOY_DRIVER" = k8s ]; then
  if [ "$ACTION" = deploy ] || [ "$ACTION" = migrate ]; then
    kube get nodes -o json | node "$ROOT/scripts/render.mjs" workers
    kube create namespace "$MX_PAY_NAMESPACE" --dry-run=client -o json | kube apply -f - >/dev/null
  fi
  # A cluster-wide lock protects migrations AND rollout across operator hosts.
  LOCK_UID="$(kube create configmap mx-pay-deploy-lock --from-literal=action="$ACTION" -o jsonpath='{.metadata.uid}')" \
    || die 'Another mx-pay operation holds the deploy lock; inspect it rather than deleting it blindly'
  [ -n "$LOCK_UID" ] || die 'Deployment lock has no UID'
else
  mkdir "$ROOT/.deploy/lock" 2>/dev/null || die 'Another local mx-pay operation is running; inspect before recovering its lock'
  LOCAL_LOCK=1
fi
if [ "$ACTION" = backup ]; then
  PHASE=backup
  node "$ROOT/scripts/postgres.mjs" backup "$ROOT"
  exit
fi
case "$ACTION" in
  stop|start|restart)
    if [ "$MX_PAY_DEPLOY_DRIVER" = k8s ]; then
      [ "$ACTION" = stop ] || node "$ROOT/scripts/postgres.mjs" check "$ROOT"
      case "$ACTION" in
        stop) kube scale deployment/mx-pay --replicas=0;;
        start) kube scale deployment/mx-pay --replicas="$MX_PAY_REPLICAS";;
        restart) kube rollout restart deployment/mx-pay;;
      esac
      [ "$ACTION" = stop ] || kube rollout status deployment/mx-pay --timeout=300s --request-timeout=320s
    else compose "$ACTION" api; fi
    say 'Operation complete; database and credentials retained'; exit;;
esac
if [ "$MX_PAY_DEPLOY_DRIVER" = k8s ]; then
  PHASE=discovery
  node "$ROOT/scripts/runtime.mjs" prepare "$ROOT"
  source "$ROOT/.deploy/discovered.env"
else
  PHASE=discovery
  node "$ROOT/scripts/runtime.mjs" prepare-console "$ROOT"
  if [ ! -f "$MX_PAY_CHANNELS_SOURCE" ]; then
    mkdir -p "$(dirname "$MX_PAY_CHANNELS_SOURCE")"
    printf '[]\n' > "$MX_PAY_CHANNELS_SOURCE"
  fi
  node "$ROOT/scripts/render.mjs" validate
fi
PHASE=image
if [ "${MX_PAY_BUILD:-1}" = 1 ]; then
  need docker
  tag="$(date -u +%Y%m%d%H%M%S)-$(node -e 'console.log(require("crypto").randomBytes(4).toString("hex"))')"
  if [ "$MX_PAY_DEPLOY_DRIVER" = k8s ]; then
    if [ "$MX_PAY_IMAGE_DELIVERY" = registry ]; then
      [ -n "$MX_PAY_IMAGE_REPOSITORY" ] || die 'Discovered registry has no imageRepository'
      platform="$(node "$ROOT/scripts/runtime.mjs" image-platforms "$ROOT")"
      docker buildx build --platform "$platform" --build-context "mx_common=$ROOT/../../mx-common" --metadata-file "$TMP/build.json" \
        --tag "$MX_PAY_IMAGE_REPOSITORY:$tag" --push "$ROOT"
      digest="$(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1]))["containerimage.digest"];if(!/^sha256:[a-f0-9]{64}$/.test(d))process.exit(1);console.log(d)' "$TMP/build.json")"
      export MX_PAY_IMAGE="$MX_PAY_IMAGE_REPOSITORY@$digest"
    else
      say 'No registry configured; verifying existing local/trusted SSH containerd access to every worker'
      platform="$(node "$ROOT/scripts/runtime.mjs" image-plan "$ROOT")"
      docker buildx build --platform "$platform" --build-context "mx_common=$ROOT/../../mx-common" --tag "local.mx/mx-pay:$tag" --load "$ROOT"
      content_id="$(docker image inspect --format '{{.Id}}' "local.mx/mx-pay:$tag")"
      [[ "$content_id" =~ ^sha256:[a-f0-9]{64}$ ]] || die 'Invalid built image identity'
      export MX_PAY_IMAGE="local.mx/mx-pay:${content_id#sha256:}"
      docker image tag "local.mx/mx-pay:$tag" "$MX_PAY_IMAGE"
      docker image save --output "$TMP/image.tar" "$MX_PAY_IMAGE"
      node "$ROOT/scripts/runtime.mjs" import-image "$ROOT" "$TMP/image.tar" "$MX_PAY_IMAGE"
      export MX_PAY_IMAGE_NODES_FILE="$ROOT/.deploy/image-nodes.json"
    fi
  else
    export MX_PAY_IMAGE="mx-pay:$tag"
    docker buildx build --build-context "mx_common=$ROOT/../../mx-common" --tag "$MX_PAY_IMAGE" --load "$ROOT"
  fi
elif [ "${MX_PAY_BUILD:-1}" != 0 ]; then die 'MX_PAY_BUILD must be 0 or 1'; fi
[ -n "${MX_PAY_IMAGE:-}" ] || die 'MX_PAY_IMAGE is required with MX_PAY_BUILD=0'
if [ "$MX_PAY_DEPLOY_DRIVER" = k8s ]; then
  PHASE=database
  say 'Checking dedicated PostgreSQL and retained storage identity'
  node "$ROOT/scripts/postgres.mjs" provision "$ROOT"
  node "$ROOT/scripts/render.mjs" validate
fi
PHASE=migration
if [ "$MX_PAY_DEPLOY_DRIVER" = k8s ]; then
  export MX_PAY_JOB_NAME="mx-pay-migrate-$(date -u +%s)-$(node -e 'console.log(require("crypto").randomBytes(3).toString("hex"))')"
  node "$ROOT/scripts/render.mjs" "$TMP"
  kube get configmap mx-pay-installation --ignore-not-found -o json | node "$ROOT/scripts/render.mjs" check-installation
  # Immutable per-generation secrets keep old pods on their old configuration.
  kube apply -f "$TMP/secrets.json" >/dev/null
  # Pin database identity even if first rollout fails, to prevent silent retargeting on retry.
  kube apply -f "$TMP/installation.json" >/dev/null
  JOB_RUNNING=1
  kube create -f "$TMP/job.json"
  if ! kube wait --for=condition=complete "job/$MX_PAY_JOB_NAME" --timeout=260s --request-timeout=280s; then
    kube logs "job/$MX_PAY_JOB_NAME" --tail=100 >&2 || true
    die 'Migration failed/timed out; API workload was not updated'
  fi
  JOB_RUNNING=0
  if [ "$ACTION" = deploy ]; then
    PHASE=rollout
    # A new channel protocol must not issue orders while old pods may still read
    # them. First replace every replica with receipt/query-capable new code and
    # checkout disabled, then restore the intended immutable channel settings.
    # Always repeat this barrier on retry: template metadata is not rollout proof.
    drain_checkout="$(kube get deployment mx-pay --ignore-not-found -o json | node "$ROOT/scripts/render.mjs" needs-checkout-drain)"
    if [ "$drain_checkout" = yes ]; then
      say 'Upgrading channel readers with new checkout paused; existing receipts and queries remain available'
      mkdir -p "$TMP/channel-upgrade"
      node "$ROOT/scripts/render.mjs" "$TMP/channel-upgrade" pause-checkout
      kube apply -f "$TMP/channel-upgrade/secrets.json" >/dev/null
      kube apply -f "$TMP/channel-upgrade/workload.json"
      kube rollout status deployment/mx-pay --timeout=320s --request-timeout=340s || die 'Channel compatibility rollout failed; new checkout was not re-enabled. Retry deploy after diagnosis'
    fi
    kube apply -f "$TMP/workload.json"
    kube rollout status deployment/mx-pay --timeout=320s --request-timeout=340s || die 'Rollout failed; inspect old/new replicas. No automatic database rollback was attempted'
    if [ -f "$MX_PAY_SSO_SOURCE" ]; then
      PHASE=console-rollout
      kube apply -f "$TMP/console.json"
      kube rollout status deployment/mx-pay-console --timeout=320s --request-timeout=340s || die 'Payment API ready; optional SSO console rollout failed. Inspect console without rolling back payment facts'
    fi
  fi
else
  compose config --quiet
  compose run --rm --no-deps -T migrate
  if [ "$ACTION" = deploy ]; then
    PHASE=rollout
    compose up -d --no-deps --wait --wait-timeout 120 api
    if [ -f "$MX_PAY_SSO_SOURCE" ]; then compose up -d --no-deps --wait --wait-timeout 120 console; fi
    printf '%s\n' "$MX_PAY_IMAGE" > "$ROOT/.deploy/image"
  fi
fi
PHASE=complete
if [ "$ACTION" = deploy ]; then say 'deploy completed; migrations verified and API ready'; else say 'migrations completed; API workload unchanged'; fi
