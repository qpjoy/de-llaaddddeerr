#!/usr/bin/env bash
# MX Rig lifecycle: docker compose on any machine, or Kubernetes on the
# Internal server. Both run the same image.
#
# This script only ever touches its own things: the compose project "mx-rig",
# or the Kubernetes namespace "mx-rig" and its two PersistentVolumes. It never
# reads or writes another product's namespace, Service, Secret, database or
# volume, and it does not look for Launcher — Rig accounts are its own.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ELECTRON_DOCK_DIR="$(cd "${ROOT_DIR}/.." && pwd)"
K8S_DIR="${ROOT_DIR}/deploy/k8s/internal"
COMPOSE_FILE="${ROOT_DIR}/deploy/compose.yaml"
RUNTIME_DIR="${ROOT_DIR}/.runtime"
COMPOSE_ENV="${MX_RIG_COMPOSE_ENV:-${RUNTIME_DIR}/compose.env}"
ENV_FILE="${MX_RIG_ENV_FILE:-${ROOT_DIR}/.env}"
NAMESPACE="mx-rig"
NODE_PORT=30891
IMAGE=""
SECRET_CHECKSUM=""
POLICY_CHECKSUM=""
CLUSTER_CONTEXT=""

say() { printf '[mx-rig] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
kube() { kubectl -n "$NAMESPACE" "$@"; }
rand_hex() { openssl rand -hex "$1" 2>/dev/null || od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
b64() { base64 -w0 2>/dev/null || base64 | tr -d '\n'; }

usage() {
  cat <<'EOF'
MX Rig

本机体验（不需要 Docker；macOS、Linux、Windows 的 Git Bash）
  bash scripts/manage.sh local init         装依赖、生成或询问配置、准备测试浏览器，然后启动
  bash scripts/manage.sh local up | desktop | status | logs [-f] | token | down | reset
                                            选项：--yes 全用默认值，--lan 允许局域网访问，--port <端口>

本机或任意一台服务器（docker compose，不需要 Kubernetes）
  scripts/manage.sh up [--lan] [--runner] [--station]
                                            构建并启动；首次运行生成密钥到 .runtime/compose.env
                                            --lan      监听 0.0.0.0，并用本机内网地址作为访问地址
                                            --runner   同时启动一台执行 Web 套件的 Playwright 执行机
                                            --station  同时启动一个重放试验规程回归的工位（浏览器在工位里，不在服务端）
  scripts/manage.sh down [--purge --yes]    停止；--purge 连数据卷一起删除（不可恢复）
  scripts/manage.sh ps | logs [服务] | token

Internal 服务器（Kubernetes，在节点上执行）
  scripts/manage.sh deploy                  构建镜像、导入 containerd、迁移、上线并验证
  scripts/manage.sh verify | status | logs [server|migrate|postgres] | admin-token
  scripts/manage.sh migrate                 只跑迁移
  scripts/manage.sh stop                    服务缩到 0；数据库、Secret 与数据目录保留

开发
  scripts/manage.sh dev | test | eval [参数]
  scripts/manage.sh desktop [--dir] [--server <地址>] [--private-http] [--no-browser]
                                            打包桌面端：自带测试浏览器；--server 写入登录页的服务地址

登录：账号 admin，密码是管理员令牌（token / admin-token 输出），之后在「成员」页开通个人账号。
可选覆盖写在 .env（或 MX_RIG_ENV_FILE）：MX_RIG_MODEL_API_KEY、MX_RIG_PUBLIC_URL、
MX_RIG_DATA_ROOT、MX_RIG_RUNNER_TARGET_CIDRS、MX_RIG_IMAGE 等，见 docs/03-operations.md。
EOF
}

load_env() {
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

# -- docker compose ------------------------------------------------------------

compose() {
  local -a profiles=()
  if [ "$(env_value MX_RIG_COMPOSE_RUNNER)" = "1" ]; then profiles+=(--profile runner); fi
  if [ "$(env_value MX_RIG_COMPOSE_STATION)" = "1" ]; then profiles+=(--profile station); fi
  docker compose -f "$COMPOSE_FILE" --env-file "$COMPOSE_ENV" "${profiles[@]}" "$@"
}

env_value() {
  [ -f "$COMPOSE_ENV" ] || return 0
  sed -n "s/^$1=//p" "$COMPOSE_ENV" | tail -n 1
}

set_env_value() {
  local name="$1" value="$2" temp
  case "$value" in *$'\n'* | *\'* | *\"*) die "${name} contains characters compose cannot read" ;; esac
  temp="$(mktemp "${COMPOSE_ENV}.XXXXXX")"
  { grep -v "^${name}=" "$COMPOSE_ENV" 2>/dev/null || true; printf '%s=%s\n' "$name" "$value"; } >"$temp"
  chmod 600 "$temp"
  mv -f "$temp" "$COMPOSE_ENV"
}

lan_address() {
  if [ -n "${MX_RIG_LAN_IP:-}" ]; then printf '%s' "$MX_RIG_LAN_IP"; return; fi
  if command -v ipconfig >/dev/null 2>&1 && ipconfig getifaddr en0 >/dev/null 2>&1; then
    ipconfig getifaddr en0
  else
    hostname -I 2>/dev/null | awk '{ print $1 }'
  fi
}

ensure_compose_env() {
  mkdir -p "$RUNTIME_DIR"
  chmod 700 "$RUNTIME_DIR"
  if [ ! -f "$COMPOSE_ENV" ]; then
    (umask 077 && : >"$COMPOSE_ENV")
    set_env_value MX_RIG_DB_PASSWORD "$(rand_hex 24)"
    set_env_value MX_RIG_ADMIN_TOKEN "$(rand_hex 32)"
    set_env_value MX_RIG_SECRET_KEY "$(rand_hex 32)"
    say "generated secrets in ${COMPOSE_ENV#"${ROOT_DIR}/"} (keep this file; the database needs it)"
  fi
  # Optional settings given now (shell or .env) are remembered for next time.
  local name
  for name in MX_RIG_MODEL_API_KEY MX_RIG_MODEL_API_KEY_2 MX_RIG_PUBLIC_URL MX_RIG_BIND \
    MX_RIG_HTTP_PORT MX_RIG_SESSION_TTL_HOURS MX_RIG_LAUNCHER_URL MX_RIG_RUNNER_PLAYWRIGHT_VERSION; do
    if [ -n "${!name:-}" ]; then set_env_value "$name" "${!name}"; fi
  done
}

wait_ready() {
  local url="$1" attempt=0
  until curl -fsS -o /dev/null "${url}/readyz" 2>/dev/null; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 90 ] || die "the server did not become ready at ${url}; see: scripts/manage.sh logs server"
    sleep 2
  done
}

# curl with a bearer token that never appears in process arguments.
curl_bearer() (
  local token="$1" header
  shift
  umask 077
  header="$(mktemp "${TMPDIR:-/tmp}/mx-rig-header.XXXXXX")"
  trap 'rm -f -- "$header"' EXIT
  printf 'authorization: Bearer %s\n' "$token" >"$header"
  curl -fsS -H "@${header}" "$@"
)

enroll_compose_runner() {
  local port="$1" code
  if compose run --rm --no-deps --entrypoint test runner -f /runner/config/runner.json 2>/dev/null; then
    say "the compose runner is already enrolled"
    return
  fi
  say "enrolling the compose runner with a one-shot code"
  code="$(curl_bearer "$(env_value MX_RIG_ADMIN_TOKEN)" -X POST "http://127.0.0.1:${port}/api/v1/runners:enroll" |
    sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
  [ -n "$code" ] || die "the server did not issue an enrollment code"
  MXT_CODE="$code" compose run --rm --no-deps -e MXT_CODE runner \
    node /opt/mxt/mxt-runner.mjs enroll --server http://server:8791 \
    --name "$(hostname -s 2>/dev/null || hostname)-compose" --kind server \
    --engines playwright --surfaces web
}

enroll_compose_station() {
  local port="$1" code
  if compose run --rm --no-deps --entrypoint test station -f /station/runner.json 2>/dev/null; then
    say "the compose station is already enrolled"
    return
  fi
  say "enrolling the compose station with a one-shot code"
  code="$(curl_bearer "$(env_value MX_RIG_ADMIN_TOKEN)" -X POST "http://127.0.0.1:${port}/api/v1/runners:enroll" |
    sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
  [ -n "$code" ] || die "the server did not issue an enrollment code"
  # The code travels in the environment, not in the process arguments.
  MX_RIG_STATION_ENROLL_CODE="$code" compose run --rm --no-deps -e MX_RIG_STATION_ENROLL_CODE station \
    node /opt/mx-rig/bin/mx-rig.mjs station enroll --server http://server:8791 \
    --name "$(hostname -s 2>/dev/null || hostname)-station" --kind server
}

cmd_up() {
  need docker
  need curl
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
  load_env
  local lan=0 runner=0 station=0 arg
  for arg in "$@"; do
    case "$arg" in
      --lan) lan=1 ;;
      --runner) runner=1 ;;
      --station) station=1 ;;
      *) die "unknown option for up: ${arg}" ;;
    esac
  done
  ensure_compose_env
  local port
  port="$(env_value MX_RIG_HTTP_PORT)"
  port="${port:-8791}"
  if [ "$lan" = 1 ]; then
    local ip
    ip="$(lan_address)"
    [ -n "$ip" ] || die "cannot find this machine's LAN address; set MX_RIG_LAN_IP"
    set_env_value MX_RIG_BIND 0.0.0.0
    [ -n "${MX_RIG_PUBLIC_URL:-}" ] || set_env_value MX_RIG_PUBLIC_URL "http://${ip}:${port}"
  elif [ -z "$(env_value MX_RIG_PUBLIC_URL)" ]; then
    set_env_value MX_RIG_PUBLIC_URL "http://127.0.0.1:${port}"
  fi
  if [ "$runner" = 1 ]; then set_env_value MX_RIG_COMPOSE_RUNNER 1; fi
  if [ "$station" = 1 ]; then set_env_value MX_RIG_COMPOSE_STATION 1; fi
  local with_runner with_station
  with_runner="$(env_value MX_RIG_COMPOSE_RUNNER)"
  with_station="$(env_value MX_RIG_COMPOSE_STATION)"

  say "building and starting (first build takes a few minutes)"
  if [ "$with_runner" = "1" ] || [ "$with_station" = "1" ]; then
    # A runner or station starts only after it holds credentials.
    compose up -d --build postgres migrate server
    if [ "$with_runner" = "1" ]; then compose build runner; fi
    if [ "$with_station" = "1" ]; then compose build station; fi
  else
    compose up -d --build
  fi
  wait_ready "http://127.0.0.1:${port}"
  if [ "$with_runner" = "1" ]; then
    enroll_compose_runner "$port"
    compose up -d runner
  fi
  if [ "$with_station" = "1" ]; then
    enroll_compose_station "$port"
    compose up -d station
  fi
  say "ready: $(env_value MX_RIG_PUBLIC_URL)"
  say "sign in as admin with the admin token: scripts/manage.sh token"
  if [ "$(env_value MX_RIG_BIND)" = "0.0.0.0" ]; then
    say "desktop: enter this address and tick 「内网测试服务器」 (plain HTTP on a private address)"
  fi
}

cmd_down() {
  need docker
  [ -f "$COMPOSE_ENV" ] || die "nothing to stop: ${COMPOSE_ENV} does not exist"
  local purge=0 yes=0 arg
  for arg in "$@"; do
    case "$arg" in
      --purge) purge=1 ;;
      --yes) yes=1 ;;
      *) die "unknown option for down: ${arg}" ;;
    esac
  done
  if [ "$purge" = 1 ]; then
    [ "$yes" = 1 ] || die "--purge deletes the database, artifacts, runner and station volumes; add --yes to confirm"
    compose --profile runner --profile station down -v
    say "stopped and removed all mx-rig volumes; ${COMPOSE_ENV#"${ROOT_DIR}/"} is kept"
  else
    compose --profile runner --profile station down
    say "stopped; volumes are kept"
  fi
}

cmd_ps() { need docker; compose ps; }
cmd_compose_logs() { need docker; compose logs -f --tail=200 "$@"; }
cmd_token() {
  local token
  token="$(env_value MX_RIG_ADMIN_TOKEN)"
  [ -n "$token" ] || die "no compose deployment here; run scripts/manage.sh up first"
  printf '%s\n' "$token"
}

# -- Kubernetes ----------------------------------------------------------------

read_secret() {
  local name="$1" encoded decoded
  if ! encoded="$(kube get secret mx-rig-secrets --ignore-not-found \
      -o "jsonpath={.data.${name}}")"; then
    die "cannot read ${name} from ${NAMESPACE}/mx-rig-secrets"
  fi
  [ -n "$encoded" ] || return 0
  decoded="$(printf '%s' "$encoded" | base64 -d 2>/dev/null)" || \
    die "${name} in ${NAMESPACE}/mx-rig-secrets is not valid base64"
  printf '%s' "$decoded"
}

pvc_exists() {
  [ -n "$(kube get pvc "$1" --ignore-not-found -o 'jsonpath={.metadata.name}')" ]
}

# Generated once, then never rotated by an ordinary deploy: the database and
# every encrypted credential depend on them.
resolve_preserved_secret() {
  local name="$1" label="$2" bytes="$3" configured existing
  configured="${!name-}"
  existing="$(read_secret "$name")"
  if [ -n "$existing" ]; then
    if [ -n "$configured" ] && [ "$configured" != "$existing" ]; then
      die "${label} already exists; an ordinary deploy cannot rotate ${name}"
    fi
    printf -v "$name" '%s' "$existing"
  else
    if pvc_exists mx-rig-postgres-data; then
      die "${label} is missing while the database PVC exists; restore the original Secret before deploying"
    fi
    if [ -z "$configured" ]; then
      configured="$(rand_hex "$bytes")"
      say "generated ${label}"
    fi
    printf -v "$name" '%s' "$configured"
  fi
  export "${name?}"
}

# Optional settings: a value given now wins, otherwise the last deploy's stays.
resolve_sticky() {
  local name="$1"
  if [ -z "${!name:-}" ]; then printf -v "$name" '%s' "$(read_secret "$name")"; fi
  export "${name?}"
}

resolve_public_url() {
  resolve_sticky MX_RIG_PUBLIC_URL
  [ -z "$MX_RIG_PUBLIC_URL" ] || return 0
  local node_ip
  case "$(kubectl config current-context 2>/dev/null)" in
    # Desktop clusters publish NodePorts on the host's loopback.
    docker-desktop | rancher-desktop) MX_RIG_PUBLIC_URL="http://127.0.0.1:${NODE_PORT}" ;;
    *)
      node_ip="$(kubectl get nodes \
        -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}' 2>/dev/null || true)"
      MX_RIG_PUBLIC_URL="${node_ip:+http://${node_ip}:${NODE_PORT}}"
      ;;
  esac
  export MX_RIG_PUBLIC_URL
}

# Where the two hostPath volumes live. Decided at the first deploy — a
# mounted /data beats the root disk — and read back from the live PV after.
resolve_data_root() {
  local existing
  existing="$(kubectl get pv mx-rig-postgres-pv --ignore-not-found -o 'jsonpath={.spec.hostPath.path}')"
  existing="${existing%/postgres}"
  if [ -n "$existing" ]; then
    if [ -n "${MX_RIG_DATA_ROOT:-}" ] && [ "${MX_RIG_DATA_ROOT%/}" != "$existing" ]; then
      die "data already lives in ${existing}; MX_RIG_DATA_ROOT cannot move it (PersistentVolume paths are immutable)"
    fi
    MX_RIG_DATA_ROOT="$existing"
  elif [ -z "${MX_RIG_DATA_ROOT:-}" ]; then
    if [ -d /data ] && [ "$(stat -c %d /data 2>/dev/null)" != "$(stat -c %d / 2>/dev/null)" ]; then
      MX_RIG_DATA_ROOT=/data/mx-rig
    else
      MX_RIG_DATA_ROOT=/var/lib/mx-rig
    fi
  fi
  MX_RIG_DATA_ROOT="${MX_RIG_DATA_ROOT%/}"
  [[ "$MX_RIG_DATA_ROOT" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "MX_RIG_DATA_ROOT must be an absolute path"
  export MX_RIG_DATA_ROOT
  # On a desktop cluster the directory lives inside its VM; this host's disk
  # says nothing about it.
  case "$CLUSTER_CONTEXT" in
    docker-desktop | rancher-desktop | kind-*)
      say "data directory: ${MX_RIG_DATA_ROOT} (inside the ${CLUSTER_CONTEXT} VM)"
      return
      ;;
  esac
  local parent="$MX_RIG_DATA_ROOT" used
  while [ ! -d "$parent" ]; do parent="$(dirname "$parent")"; done
  used="$(df -P "$parent" 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }')"
  say "data directory: ${MX_RIG_DATA_ROOT} (filesystem ${used:-?}% used)"
  if [ -n "$used" ] && [ "$used" -ge 90 ]; then
    say "WARNING: that filesystem is ${used}% full; set MX_RIG_DATA_ROOT on a larger disk before the first deploy"
  fi
}

resolve_runner_cidrs() {
  resolve_sticky MX_RIG_RUNNER_TARGET_CIDRS
  local cidr
  for cidr in ${MX_RIG_RUNNER_TARGET_CIDRS//,/ }; do
    [[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]] || die "not an IPv4 CIDR: ${cidr}"
  done
}

SECRET_KEYS=(MX_RIG_DATABASE_URL MX_RIG_POSTGRES_PASSWORD MX_RIG_ADMIN_TOKEN MX_RIG_SECRET_KEY
  MX_RIG_PUBLIC_URL MX_RIG_INSECURE_COOKIES MX_RIG_MODEL_API_KEY MX_RIG_MODEL_API_KEY_2
  MX_RIG_GIT_TOKEN MX_RIG_LAUNCHER_URL MX_RIG_RUNNER_TARGET_CIDRS)

apply_secret() {
  local name
  {
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: mx-rig-secrets\n  namespace: %s\ntype: Opaque\ndata:\n' "$NAMESPACE"
    for name in "${SECRET_KEYS[@]}"; do
      printf '  %s: "%s"\n' "$name" "$(printf '%s' "${!name-}" | b64)"
    done
  } | kubectl apply -f - >/dev/null
  SECRET_CHECKSUM="$(for name in "${SECRET_KEYS[@]}"; do printf '%s=%s\0' "$name" "${!name-}"; done |
    openssl dgst -sha256 | awk '{ print $NF }')"
  POLICY_CHECKSUM="$(openssl dgst -sha256 "${K8S_DIR}/08-resource-policy.yaml" | awk '{ print $NF }')"
  say "Secret reconciled"
}

single_node() {
  local nodes
  nodes="$(kubectl get nodes -o name | awk 'NF { n += 1 } END { print n + 0 }')"
  [ "$nodes" -eq 1 ] || die "the hostPath profile needs exactly one Kubernetes node; found ${nodes}"
}

run_ctr() {
  if [ "$(id -u)" -eq 0 ]; then ctr -n k8s.io "$@"; else sudo -n ctr -n k8s.io "$@"; fi
}

build_local_image() {
  local network="${1:-}" tag="mx-rig-server:build-$$" id
  local -a args=(-f "${ROOT_DIR}/deploy/Dockerfile" -t "$tag")
  need docker
  if [ "$network" = host ]; then args+=(--network host); fi
  say "building the server image"
  docker build "${args[@]}" "$ELECTRON_DOCK_DIR"
  id="$(docker image inspect "$tag" --format '{{.Id}}')"
  [[ "${id#sha256:}" =~ ^[0-9a-f]{64}$ ]] || die "docker returned an invalid image id: ${id}"
  IMAGE="mx-rig.local/mx-rig-server:local-sha256-${id#sha256:}"
  docker tag "$tag" "$IMAGE"
  docker image rm "$tag" >/dev/null 2>&1 || true
}

import_containerd_image() (
  local archive
  need ctr
  run_ctr images ls -q >/dev/null 2>&1 || \
    die "cannot reach containerd's k8s.io namespace; run deploy as root (or with passwordless sudo), or set MX_RIG_IMAGE to a registry digest"
  archive="$(mktemp "${TMPDIR:-/tmp}/mx-rig-image.XXXXXX")"
  trap 'rm -f -- "$archive"' EXIT
  say "importing ${IMAGE} into containerd (k8s.io)"
  docker image save -o "$archive" "$IMAGE"
  run_ctr images import "$archive" >/dev/null
  run_ctr images ls -q | grep -Fqx -- "$IMAGE" || die "containerd import finished but ${IMAGE} is missing"
)

resolve_image() {
  CLUSTER_CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
  [ -n "$CLUSTER_CONTEXT" ] || die "kubectl has no current context"
  if [ -n "${MX_RIG_IMAGE:-}" ]; then
    [[ "$MX_RIG_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]] || die "MX_RIG_IMAGE must be repository@sha256:<digest>"
    IMAGE="$MX_RIG_IMAGE"
    return
  fi
  case "$CLUSTER_CONTEXT" in
    docker-desktop | rancher-desktop) build_local_image ;;
    kind-*)
      build_local_image
      need kind
      kind load docker-image "$IMAGE" --name "${CLUSTER_CONTEXT#kind-}"
      ;;
    *)
      local runtime
      runtime="$(kubectl get nodes -o 'jsonpath={.items[0].status.nodeInfo.containerRuntimeVersion}' 2>/dev/null || true)"
      case "$runtime" in
        containerd://*)
          # The image is imported on this host, so this host must be the node.
          local node_ips
          node_ips="$(kubectl get nodes -o 'jsonpath={.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
          hostname -I 2>/dev/null | tr ' ' '\n' | grep -Fqx -- "$node_ips" || \
            die "this host is not the Kubernetes node (${node_ips}); run deploy there, or set MX_RIG_IMAGE"
          # Host networking for the build: a node that reaches registries
          # through a tunnel can stall npm on the bridge network's MTU.
          build_local_image host
          import_containerd_image
          ;;
        *) die "cannot import a local image into ${runtime:-an unknown runtime}; set MX_RIG_IMAGE to a registry digest" ;;
      esac
      ;;
  esac
}

render() {
  local rules="" cidr
  for cidr in ${MX_RIG_RUNNER_TARGET_CIDRS//,/ }; do
    rules+="    - to:\n        - ipBlock:\n            cidr: ${cidr}\n"
  done
  awk -v image="$IMAGE" -v secret="$SECRET_CHECKSUM" -v policy="$POLICY_CHECKSUM" \
    -v root="$MX_RIG_DATA_ROOT" -v rules="$rules" '
    /# __MX_RIG_RUNNER_TARGET_EGRESS__/ { printf "%s", rules; next }
    {
      gsub(/mx-rig\.invalid\/mx-rig-server:managed-image-required/, image)
      gsub(/__MX_RIG_SECRET_CHECKSUM__/, secret)
      gsub(/__MX_RIG_POLICY_CHECKSUM__/, policy)
      gsub(/__MX_RIG_DATA_ROOT__/, root)
      print
    }'
}

# File by file rather than through kustomize: kustomize drops comments, and
# one of them marks where the runner's test-environment rules go.
apply_files() {
  local file
  for file in "$@"; do
    render <"${K8S_DIR}/${file}" | kubectl apply -f - >/dev/null
  done
}

prepare_kubernetes() {
  need kubectl
  need openssl
  load_env
  single_node
  resolve_image
  kubectl apply -f "${K8S_DIR}/00-namespace.yaml" >/dev/null
  resolve_preserved_secret MX_RIG_ADMIN_TOKEN "the service admin token" 32
  resolve_preserved_secret MX_RIG_POSTGRES_PASSWORD "the PostgreSQL password" 24
  resolve_preserved_secret MX_RIG_SECRET_KEY "the credential-encryption key" 32
  export MX_RIG_DATABASE_URL="postgres://mx_rig:${MX_RIG_POSTGRES_PASSWORD}@mx-rig-postgres:5432/mx_rig"
  local name
  for name in MX_RIG_INSECURE_COOKIES MX_RIG_MODEL_API_KEY MX_RIG_MODEL_API_KEY_2 MX_RIG_GIT_TOKEN MX_RIG_LAUNCHER_URL; do
    resolve_sticky "$name"
  done
  resolve_public_url
  resolve_data_root
  resolve_runner_cidrs
  apply_secret
  apply_files 05-serviceaccount.yaml 08-resource-policy.yaml 10-artifacts-pvc.yaml 15-postgres.yaml \
    40-network-policy.yaml
  say "waiting for PostgreSQL"
  if ! kube rollout status statefulset/mx-rig-postgres --timeout=180s >/dev/null; then
    kube logs statefulset/mx-rig-postgres --tail=80 || true
    die "PostgreSQL did not become ready"
  fi
}

run_migration() {
  kube delete job mx-rig-migrate --ignore-not-found >/dev/null 2>&1 || true
  apply_files 20-migration-job.yaml
  say "running migrations"
  if ! kube wait --for=condition=complete job/mx-rig-migrate --timeout=180s >/dev/null; then
    kube logs job/mx-rig-migrate --tail=100 || true
    die "migration failed"
  fi
}

cmd_deploy() {
  prepare_kubernetes
  run_migration
  # The server is applied only after migrations completed.
  apply_files 30-server.yaml 35-nodeport.yaml
  # `apply` keeps a live scale-to-zero from `stop`; coming back is explicit.
  kube scale deployment/mx-rig-server --replicas=1 >/dev/null
  say "waiting for the server"
  kube rollout status deployment/mx-rig-server --timeout=180s
  cmd_verify
  say "deployed: ${MX_RIG_PUBLIC_URL:-kubectl -n ${NAMESPACE} port-forward service/mx-rig-server 8791:80}"
  say "sign in as admin with: scripts/manage.sh admin-token"
}

cmd_migrate() {
  prepare_kubernetes
  run_migration
  say "migrations complete; the server was not changed"
}

cmd_verify() (
  need kubectl
  need curl
  local token port="${MX_RIG_VERIFY_PORT:-18891}"
  token="$(read_secret MX_RIG_ADMIN_TOKEN)"
  [ -n "$token" ] || die "no admin token in ${NAMESPACE}/mx-rig-secrets; deploy first"
  local forward="" attempt=0 restarts=0
  trap 'kill "$forward" 2>/dev/null || true' EXIT
  # Right after a rollout the forward can land on the Pod being replaced and
  # end with it; start it again rather than calling the deploy failed.
  until curl -fsS -o /dev/null "http://127.0.0.1:${port}/readyz" 2>/dev/null; do
    if [ -z "$forward" ] || ! kill -0 "$forward" 2>/dev/null; then
      [ "$restarts" -lt 5 ] || die "port-forward keeps exiting; see: scripts/manage.sh status"
      restarts=$((restarts + 1))
      kube port-forward service/mx-rig-server "${port}:80" >/dev/null 2>&1 &
      forward=$!
    fi
    attempt=$((attempt + 1))
    [ "$attempt" -lt 45 ] || die "the server is not ready behind port-forward"
    sleep 1
  done
  curl_bearer "$token" -o /dev/null "http://127.0.0.1:${port}/api/rig/v1/me" || die "admin sign-in check failed"
  curl_bearer "$token" -o /dev/null "http://127.0.0.1:${port}/api/v1/runners" || die "test kernel check failed"
  say "verified: ready, admin sign-in and test kernel respond"
)

cmd_admin_token() {
  need kubectl
  local token
  token="$(read_secret MX_RIG_ADMIN_TOKEN)"
  [ -n "$token" ] || die "no admin token yet; deploy first"
  printf '%s\n' "$token"
}

cmd_status() {
  need kubectl
  kube get deployment,statefulset,pod,pvc,service,job,networkpolicy -o wide || true
}

cmd_k8s_logs() {
  need kubectl
  case "${1:-server}" in
    server) kube logs deployment/mx-rig-server --tail=200 -f ;;
    migrate) kube logs job/mx-rig-migrate --tail=200 ;;
    postgres) kube logs statefulset/mx-rig-postgres --tail=200 -f ;;
    *) die "logs target must be server, migrate or postgres" ;;
  esac
}

cmd_stop() {
  need kubectl
  say "scaling the server to zero; PostgreSQL, the Secret and the data directory are kept"
  kube scale deployment/mx-rig-server --replicas=0
}

# -- development -----------------------------------------------------------------

cmd_desktop() {
  need npm
  local args=("$@") public
  # The server this machine runs (compose up) is the one the build points at,
  # unless --server says otherwise.
  public="$(env_value MX_RIG_PUBLIC_URL)"
  if [ -n "$public" ] && ! printf '%s\n' "${args[@]+"${args[@]}"}" | grep -qx -- '--server'; then
    args+=(--server "$public")
    case "$public" in http://10.* | http://192.168.* | http://172.*) args+=(--private-http) ;; esac
    say "login page will start with ${public} (pass --server to change)"
  fi
  say "building the desktop app for $(uname -s) (macOS builds need a Mac, Windows builds need Windows)"
  npm --prefix "$ROOT_DIR" run package -- "${args[@]+"${args[@]}"}"
  say "output: ${ROOT_DIR}/dist"
}

# 本机体验: everything is done by scripts/local.mjs, so macOS, Linux and Git
# Bash share one implementation. Git Bash runs the Windows Node: it gets a
# Windows path, and a real console through winpty when mintty cannot give it
# one (otherwise a password would be echoed while typed).
cmd_local() {
  command -v node >/dev/null 2>&1 ||
    die "需要 Node.js 22 或更新的版本：https://nodejs.org（Windows 上装好后重新打开 Git Bash）"
  local script="${ROOT_DIR}/scripts/local.mjs"
  if [ -n "${MSYSTEM:-}" ]; then
    if command -v cygpath >/dev/null 2>&1; then script="$(cygpath -w "$script")"; fi
    if [ -t 0 ] && [ -t 1 ] && command -v winpty >/dev/null 2>&1 &&
      ! node -e "process.exit(process.stdin.isTTY ? 0 : 1)" 2>/dev/null; then
      exec winpty node "$script" "$@"
    fi
  fi
  exec node "$script" "$@"
}

if [ "${MX_RIG_MANAGE_SOURCE_ONLY:-0}" != "1" ]; then
  command_name="${1:-help}"
  shift || true
  case "$command_name" in
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    ps) cmd_ps ;;
    token) cmd_token ;;
    logs)
      # Compose when this machine runs the compose project, Kubernetes otherwise.
      if [ -f "$COMPOSE_ENV" ] && command -v docker >/dev/null 2>&1 &&
        [ -n "$(compose ps -q 2>/dev/null)" ]; then
        cmd_compose_logs "$@"
      else
        cmd_k8s_logs "$@"
      fi
      ;;
    deploy) cmd_deploy ;;
    migrate) cmd_migrate ;;
    verify) cmd_verify ;;
    status) cmd_status ;;
    admin-token) cmd_admin_token ;;
    stop) cmd_stop ;;
    dev) need npm; npm --prefix "$ROOT_DIR" run dev ;;
    test) need npm; npm --prefix "$ROOT_DIR" test ;;
    eval) need npm; npm --prefix "$ROOT_DIR" run eval -- "$@" ;;
    desktop) cmd_desktop "$@" ;;
    local) cmd_local "$@" ;;
    help | -h | --help) usage ;;
    *) usage; exit 1 ;;
  esac
fi
