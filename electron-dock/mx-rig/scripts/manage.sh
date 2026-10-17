#!/usr/bin/env bash
# MX Rig lifecycle: docker compose on any machine, or Kubernetes on the
# Internal server. Both run the same image.
#
# This script only ever touches its own things: the compose project "mx-rig",
# its dedicated proxy builder/cache, or the Kubernetes namespace "mx-rig" and
# its two PersistentVolumes. It never writes another product's namespace,
# Service, Secret, database or volume. Of Launcher it reads only where its
# Service is (for unified sign-in and the desktop's Launcher mode), and it
# writes to Launcher only through Launcher's own API, with an ops token the
# operator passes in (launcher apply).
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
SSO_CHECKSUM="none"
POLICY_CHECKSUM=""
CLUSTER_CONTEXT=""

say() { printf '[mx-rig] %s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }
kube() { kubectl -n "$NAMESPACE" "$@"; }
rand_hex() { openssl rand -hex "$1" 2>/dev/null || od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
b64() { base64 -w0 2>/dev/null || base64 | tr -d '\n'; }
# shellcheck source=build-proxy.sh
source "${ROOT_DIR}/scripts/build-proxy.sh"

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
  PROXY=http://127.0.0.1:7788 bash scripts/manage.sh deploy
                                            Linux 节点：仅本次构建/下载走代理，不改系统或 Docker 代理
  scripts/manage.sh verify | status | logs [server|migrate|postgres] | admin-token
  scripts/manage.sh migrate                 只跑迁移
  scripts/manage.sh stop                    服务缩到 0；数据库、Secret 与数据目录保留
  scripts/manage.sh launcher plan | apply   桌面端 Launcher 模式要在 Launcher 登记的内容（docs/25）：
                                            plan 只读；apply 写入产品网络、AppCenter 条目和两个发版账号（需要 MX_LAUNCHER_OPS_TOKEN），
                                            发版凭据只存进 mx-rig/mx-rig-release，不打印；并列出只能在 Launcher Admin 里做的步骤
  scripts/manage.sh release status | publish <安装包> --install-id <ID> | approve <plan> --smoke passed | reject <plan> | promote <plan>
                                            经 Release Center 发布桌面端新版本（docs/25 P2）：先定向、手动验证后批准，再推给所有人

开发
  scripts/manage.sh dev | test | eval [参数]
  scripts/manage.sh desktop [--dir] [--server <地址>] [--private-http] [--no-browser] [--launcher]
                                            打包桌面端：自带测试浏览器；--server 写入登录页的服务地址；
                                            --launcher 打成 Launcher 独立端（自己的产品网络，带 WireGuard 引擎）

登录：账号 admin，密码是管理员令牌（token / admin-token 输出），之后在「成员」页开通个人账号。
可选覆盖写在 .env（或 MX_RIG_ENV_FILE）：MX_RIG_MODEL_API_KEY、MX_RIG_PUBLIC_URL、
MX_RIG_DATA_ROOT、MX_RIG_RUNNER_TARGET_CIDRS、MX_RIG_IMAGE 等，见 docs/03-operations.md。
EOF
}

load_env() {
  local build_proxy_set="${MX_RIG_BUILD_PROXY+x}" build_proxy="${MX_RIG_BUILD_PROXY-}"
  local proxy_set="${PROXY+x}" proxy="${PROXY-}"
  local launcher_url_set="${MX_LAUNCHER_URL+x}" launcher_url="${MX_LAUNCHER_URL-}"
  local launcher_ops_set="${MX_LAUNCHER_OPS_TOKEN+x}" launcher_ops="${MX_LAUNCHER_OPS_TOKEN-}"
  local allowed_origins_set="${MX_RIG_ALLOWED_ORIGINS+x}" allowed_origins="${MX_RIG_ALLOWED_ORIGINS-}"
  if [ -f "$ENV_FILE" ]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
  # Explicit administrative credentials/endpoint override the saved file,
  # including an empty token when the caller intentionally disables writes.
  if [ "$launcher_url_set" = x ]; then export MX_LAUNCHER_URL="$launcher_url"; fi
  if [ "$launcher_ops_set" = x ]; then export MX_LAUNCHER_OPS_TOKEN="$launcher_ops"; fi
  # Empty explicitly clears the extra browser origins, even if .env has a value.
  if [ "$allowed_origins_set" = x ]; then export MX_RIG_ALLOWED_ORIGINS="$allowed_origins"; fi
  # Explicit shell values (including empty to disable) win over .env.
  if [ "$build_proxy_set" = x ]; then
    MX_RIG_BUILD_PROXY="$build_proxy"
  elif [ "$proxy_set" = x ]; then
    MX_RIG_BUILD_PROXY="$proxy"
  else
    MX_RIG_BUILD_PROXY="${MX_RIG_BUILD_PROXY-${PROXY:-}}"
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
  if [ "${MX_RIG_ALLOWED_ORIGINS+x}" = x ]; then
    set_env_value MX_RIG_ALLOWED_ORIGINS "$MX_RIG_ALLOWED_ORIGINS"
  fi
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
  local token="$1"
  shift
  umask 077
  # Bash 3 unwinds function locals before an EXIT trap on failure.
  rig_bearer_header="$(mktemp "${TMPDIR:-/tmp}/mx-rig-header.XXXXXX")"
  trap 'rm -f -- "$rig_bearer_header"' EXIT
  printf 'authorization: Bearer %s\n' "$token" >"$rig_bearer_header"
  curl -fsS -H "@${rig_bearer_header}" "$@"
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

# Launcher Internal in the same cluster answers sign-in with the platform's
# unified accounts (docs/25 §3.4). Found here so nobody types it: an explicit
# MX_RIG_LAUNCHER_URL wins and is remembered; MX_RIG_LAUNCHER_DISCOVER=0 leaves
# it off.
resolve_launcher_url() {
  resolve_sticky MX_RIG_LAUNCHER_URL
  [ -z "$MX_RIG_LAUNCHER_URL" ] || return 0
  [ "${MX_RIG_LAUNCHER_DISCOVER:-1}" != 0 ] || return 0
  local port
  port="$(kubectl -n mx-internal-shadow get service mx-launcher-internal \
    -o 'jsonpath={.spec.ports[?(@.name=="http")].port}' 2>/dev/null || true)"
  [ -n "$port" ] || return 0
  MX_RIG_LAUNCHER_URL="http://mx-launcher-internal.mx-internal-shadow.svc.cluster.local:${port}"
  export MX_RIG_LAUNCHER_URL
  say "unified accounts: signing in through Launcher Internal at ${MX_RIG_LAUNCHER_URL}"
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
  MX_RIG_PUBLIC_URL MX_RIG_ALLOWED_ORIGINS MX_RIG_INSECURE_COOKIES MX_RIG_MODEL_API_KEY MX_RIG_MODEL_API_KEY_2
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
  say "building the server image"
  if [ -n "${MX_RIG_BUILD_PROXY:-}" ]; then
    rig_with_build_proxy rig_build_with_proxy "${args[@]}" "$ELECTRON_DOCK_DIR"
  else
    if [ "$network" = host ]; then args+=(--network host); fi
    docker build "${args[@]}" "$ELECTRON_DOCK_DIR"
  fi
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
          if [ -n "${MX_RIG_BUILD_PROXY:-}" ]; then
            rig_with_build_proxy rig_proxy_postgres_image
          fi
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
  awk -v image="$IMAGE" -v secret="$SECRET_CHECKSUM" -v policy="$POLICY_CHECKSUM" -v sso="$SSO_CHECKSUM" \
    -v root="$MX_RIG_DATA_ROOT" -v rules="$rules" '
    /# __MX_RIG_RUNNER_TARGET_EGRESS__/ { printf "%s", rules; next }
    {
      gsub(/mx-rig\.invalid\/mx-rig-server:managed-image-required/, image)
      gsub(/__MX_RIG_SECRET_CHECKSUM__/, secret)
      gsub(/__MX_RIG_POLICY_CHECKSUM__/, policy)
      gsub(/__MX_RIG_SSO_CHECKSUM__/, sso)
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
  for name in MX_RIG_INSECURE_COOKIES MX_RIG_MODEL_API_KEY MX_RIG_MODEL_API_KEY_2 MX_RIG_GIT_TOKEN; do
    resolve_sticky "$name"
  done
  # Unlike other sticky settings, an explicitly empty list removes old origins.
  if [ "${MX_RIG_ALLOWED_ORIGINS+x}" != x ]; then
    MX_RIG_ALLOWED_ORIGINS="$(read_secret MX_RIG_ALLOWED_ORIGINS)"
  fi
  export MX_RIG_ALLOWED_ORIGINS
  resolve_launcher_url
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

# Browser SSO (docs/25 P4). Launcher Internal → 平台设置 → 统一认证 → 接入应用
# writes the mx-rig profile on this host; deploy keeps it in the Secret
# mx-rig/mx-rig-sso, which the server reads at /etc/mx-rig/sso/profile.json.
# MX_RIG_SSO_SOURCE names the file; MX_RIG_SSO_AUTO_DISCOVER=0 stops looking.
# The profile holds the client secret and session key: never printed.
resolve_sso_profile() {
  local source="${MX_RIG_SSO_SOURCE:-}" dir="${MX_RIG_LAUNCHER_IDENTITY_DIR:-/var/lib/mx-launcher/identity/applications}"
  local candidate existing origin="" found=()
  if [ -z "$source" ] && [ "${MX_RIG_SSO_AUTO_DISCOVER:-1}" != 0 ]; then
    for candidate in "${dir}/public/mx-rig.json" "${dir}/private/mx-rig.json"; do
      [ ! -e "$candidate" ] || found+=("$candidate")
    done
    [ "${#found[@]}" -le 1 ] || die "both ${found[*]} exist; choose one with MX_RIG_SSO_SOURCE"
    source="${found[0]-}"
  fi
  if [ -z "$source" ]; then
    existing="$(kube get secret mx-rig-sso --ignore-not-found -o 'jsonpath={.data.profile\.json}' 2>/dev/null || true)"
    if [ -n "$existing" ]; then
      SSO_CHECKSUM="$(printf '%s' "$existing" | openssl dgst -sha256 | awk '{ print $NF }')"
      say "browser SSO: on, with the profile already in ${NAMESPACE}/mx-rig-sso"
    else
      say "browser SSO: off (no mx-rig profile yet: Launcher Internal → 平台设置 → 统一认证 → 接入应用, docs/25 §11)"
    fi
    return 0
  fi
  [ -r "$source" ] || die "cannot read the SSO profile ${source}; run deploy as its owner or set MX_RIG_SSO_SOURCE"
  # Checked here with the server's own reader, so a bad file stops the deploy
  # instead of the server.
  if command -v node >/dev/null 2>&1; then
    origin="$(node --input-type=module -e "
      const { readApplicationSsoProfile } = await import(process.argv[1])
      const profile = readApplicationSsoProfile(process.argv[2])
      if (profile.appId !== 'mx-rig') throw new Error('the profile is for ' + profile.appId + ', not mx-rig')
      process.stdout.write(profile.origin)" "${ELECTRON_DOCK_DIR}/mx-common/src/identity/profile.mjs" "$source")" ||
      die "the SSO profile ${source} is not usable"
  fi
  kubectl create secret generic mx-rig-sso -n "$NAMESPACE" --from-file=profile.json="$source" --dry-run=client -o yaml |
    kubectl apply -f - >/dev/null
  SSO_CHECKSUM="$(b64 <"$source" | openssl dgst -sha256 | awk '{ print $NF }')"
  say "browser SSO: on${origin:+ at ${origin}}; the profile from ${source} is kept in ${NAMESPACE}/mx-rig-sso"
}

cmd_deploy() {
  prepare_kubernetes
  run_migration
  resolve_sso_profile
  # The server is applied only after migrations completed.
  apply_files 30-server.yaml 35-nodeport.yaml
  # `apply` keeps a live scale-to-zero from `stop`; coming back is explicit.
  kube scale deployment/mx-rig-server --replicas=1 >/dev/null
  say "waiting for the server"
  kube rollout status deployment/mx-rig-server --timeout=180s
  cmd_verify
  say "deployed: ${MX_RIG_PUBLIC_URL:-kubectl -n ${NAMESPACE} port-forward service/mx-rig-server 8791:80}"
  say "sign in as admin with: scripts/manage.sh admin-token"
  # The desktop reaches this server through its own product VIP (docs/25 §3.2):
  # one reverse-proxy route in Launcher Admin, registered once.
  if [ -n "${MX_RIG_PUBLIC_URL:-}" ]; then
    say "desktop (Launcher mode): in Launcher Admin add the reverse-proxy route  host <mx-rig service VIP>  ->  ${MX_RIG_PUBLIC_URL}"
  fi
}

cmd_migrate() {
  prepare_kubernetes
  run_migration
  say "migrations complete; the server was not changed"
}

cmd_verify() (
  need kubectl
  need curl
  local token port="" attempt=0 restarts=0 ready=0 deadline=$((SECONDS + 45))
  token="$(read_secret MX_RIG_ADMIN_TOKEN)"
  [ -n "$token" ] || die "no admin token in ${NAMESPACE}/mx-rig-secrets; deploy first"
  umask 077
  # These live only in this subshell, but must survive Bash 3's local unwind.
  rig_verify_forward=""
  rig_verify_work="$(mktemp -d "${TMPDIR:-/tmp}/mx-rig-verify.XXXXXX")"
  trap 'if [ -n "$rig_verify_forward" ]; then kill "$rig_verify_forward" 2>/dev/null || true; wait "$rig_verify_forward" 2>/dev/null || true; fi; rm -f -- "$rig_verify_work/forward.log" "$rig_verify_work/curl.log"; rmdir -- "$rig_verify_work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  verify_failed() {
    if [ -s "$rig_verify_work/forward.log" ]; then
      say "port-forward diagnostic:" >&2
      tail -n 12 "$rig_verify_work/forward.log" >&2
    fi
    if [ -s "$rig_verify_work/curl.log" ]; then
      say "HTTP diagnostic:" >&2
      tail -n 4 "$rig_verify_work/curl.log" >&2
    fi
    say "inspect: kubectl -n ${NAMESPACE} get pods -o wide" >&2
    say "inspect: kubectl -n ${NAMESPACE} logs deployment/mx-rig-server --tail=80" >&2
    die "$*; local verification failed, retry scripts/manage.sh verify without rebuilding"
  }

  # Let kubectl allocate an unused loopback port by default. Never probe an
  # existing listener (or send it credentials) before our own forward is ready.
  while [ "$attempt" -lt 45 ] && [ "$SECONDS" -lt "$deadline" ]; do
    if [ -z "$rig_verify_forward" ] || ! kill -0 "$rig_verify_forward" 2>/dev/null; then
      [ -z "$rig_verify_forward" ] || wait "$rig_verify_forward" 2>/dev/null || true
      [ "$restarts" -lt 5 ] || verify_failed "port-forward keeps exiting"
      restarts=$((restarts + 1))
      port=""
      : >"$rig_verify_work/forward.log"
      # Start kubectl directly: killing a background shell function can leave
      # its kubectl child behind, holding the listening port open.
      kubectl -n "$NAMESPACE" port-forward --address 127.0.0.1 \
        service/mx-rig-server "${MX_RIG_VERIFY_PORT:-}:80" >"$rig_verify_work/forward.log" 2>&1 &
      rig_verify_forward=$!
    fi
    port="$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9][0-9]*\) -> .*/\1/p' "$rig_verify_work/forward.log" | head -n 1)"
    if [ -n "$port" ] && kill -0 "$rig_verify_forward" 2>/dev/null &&
      curl -fsS --noproxy '*' --connect-timeout 3 --max-time 5 \
        -o /dev/null "http://127.0.0.1:${port}/readyz" 2>"$rig_verify_work/curl.log"; then
      ready=1
      break
    fi
    attempt=$((attempt + 1))
    sleep 1
  done
  [ "$ready" = 1 ] || verify_failed "no ready response through this verification's port-forward"
  curl_bearer "$token" --noproxy '*' --connect-timeout 3 --max-time 5 \
    -o /dev/null "http://127.0.0.1:${port}/api/rig/v1/me" 2>"$rig_verify_work/curl.log" || verify_failed "admin sign-in check failed"
  curl_bearer "$token" --noproxy '*' --connect-timeout 3 --max-time 5 \
    -o /dev/null "http://127.0.0.1:${port}/api/v1/runners" 2>"$rig_verify_work/curl.log" || verify_failed "test kernel check failed"
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

# Launcher Internal as this node reaches it: an explicit MX_LAUNCHER_URL, or
# its Service's ClusterIP.
launcher_internal_url() {
  local found
  if [ -n "${MX_LAUNCHER_URL:-}" ]; then printf '%s' "$MX_LAUNCHER_URL"; return 0; fi
  need kubectl
  found="$(kubectl -n mx-internal-shadow get service mx-launcher-internal \
    -o 'jsonpath={.spec.clusterIP}:{.spec.ports[?(@.name=="http")].port}' 2>/dev/null || true)"
  [ -n "$found" ] && [ "$found" != ":" ] || die "Launcher Internal is not in this cluster; set MX_LAUNCHER_URL"
  printf 'http://%s' "$found"
}

# Rig's release credentials (docs/25 P2) live in their own Secret, apart from
# the server's: the server never needs them.
RELEASE_SECRET=mx-rig-release
read_release_secret() {
  local encoded
  encoded="$(kube get secret "$RELEASE_SECRET" --ignore-not-found -o "jsonpath={.data.$1}" 2>/dev/null || true)"
  [ -z "$encoded" ] || printf '%s' "$encoded" | base64 -d
}
# Which of the two this cluster keeps: "publisher,approver", a part, or "".
release_kept() {
  local kept=()
  [ -z "$(read_release_secret MX_RIG_RELEASE_CLIENT_SECRET)" ] || kept+=(publisher)
  [ -z "$(read_release_secret MX_RIG_RELEASE_APPROVER_CLIENT_SECRET)" ] || kept+=(approver)
  local IFS=,
  printf '%s' "${kept[*]+"${kept[*]}"}"
}
# A credential Launcher issued is shown once: merged into the Secret, and the
# file it came in is removed only once it is stored.
keep_release_secret() {
  local file="$1"
  [ -s "$file" ] || { rm -f "$file"; return 0; }
  if kubectl apply -f "${K8S_DIR}/00-namespace.yaml" >/dev/null 2>&1 &&
    { kube get secret "$RELEASE_SECRET" >/dev/null 2>&1 || kube create secret generic "$RELEASE_SECRET" >/dev/null; } &&
    kube patch secret "$RELEASE_SECRET" --type merge --patch-file "$file" >/dev/null; then
    rm -f "$file"
    say "release credentials kept in ${NAMESPACE}/${RELEASE_SECRET}"
  else
    say "WARNING: could not store the release credentials; they are in ${file} (mode 600). Store them with:"
    say "  kubectl -n ${NAMESPACE} patch secret ${RELEASE_SECRET} --type merge --patch-file ${file}"
    return 1
  fi
}

# What the desktop's Launcher mode needs registered in Launcher (docs/25 §3.4).
# Run on the Internal node: both services are found in the cluster.
cmd_launcher() {
  need node
  local action="${1:-plan}"
  shift || true
  case "$action" in plan | apply) ;; *) die "usage: scripts/manage.sh launcher plan|apply" ;; esac
  load_env
  if [ "$action" = apply ] && [ -z "${MX_LAUNCHER_OPS_TOKEN:-}" ]; then
    die "launcher apply needs MX_LAUNCHER_OPS_TOKEN in the environment or mx-rig/.env (the existing Launcher's MX_INTERNAL_OPS_TOKEN, not the Rig admin token)"
  fi
  local url status=0 out
  url="$(launcher_internal_url)"
  # The Rig service the VIP route points at: what deploy published.
  if [ -z "${MX_RIG_PUBLIC_URL:-}" ] && command -v kubectl >/dev/null 2>&1; then
    resolve_public_url 2>/dev/null || true
  fi
  # Known only with the cluster at hand; unknown means nothing is rotated.
  if command -v kubectl >/dev/null 2>&1 && kubectl version --request-timeout=5s >/dev/null 2>&1; then
    MX_RIG_RELEASE_HAVE="$(release_kept)"
    export MX_RIG_RELEASE_HAVE
    [ -z "$(kube get secret mx-rig-sso --ignore-not-found -o name 2>/dev/null)" ] || MX_RIG_SSO_PROFILE_FOUND="Secret mx-rig/mx-rig-sso"
  fi
  # The browser SSO registration's profile on this host (docs/25 P4).
  local sso_dir="${MX_RIG_LAUNCHER_IDENTITY_DIR:-/var/lib/mx-launcher/identity/applications}" sso_file
  for sso_file in "${MX_RIG_SSO_SOURCE:-}" "${sso_dir}/public/mx-rig.json" "${sso_dir}/private/mx-rig.json"; do
    if [ -n "$sso_file" ] && [ -e "$sso_file" ]; then MX_RIG_SSO_PROFILE_FOUND="$sso_file"; break; fi
  done
  [ -z "${MX_RIG_SSO_PROFILE_FOUND:-}" ] || export MX_RIG_SSO_PROFILE_FOUND
  if [ "$action" = plan ]; then
    node "${ROOT_DIR}/scripts/launcher-register.mjs" plan --url "$url" ${MX_RIG_PUBLIC_URL:+--rig-url "$MX_RIG_PUBLIC_URL"}
    return
  fi
  out="$(umask 077 && mktemp "${TMPDIR:-/tmp}/mx-rig-release.XXXXXX")"
  node "${ROOT_DIR}/scripts/launcher-register.mjs" apply --url "$url" --secret-out "$out" \
    ${MX_RIG_PUBLIC_URL:+--rig-url "$MX_RIG_PUBLIC_URL"} || status=$?
  # Whatever was issued before a failure is kept too.
  keep_release_secret "$out" || status=1
  return "$status"
}

# Publishing a desktop build (docs/25 P2), on the Internal node with the
# installer and its .json manifest copied here. The credentials go to the
# command through its environment, never its arguments.
cmd_release() {
  need node
  [ $# -gt 0 ] || die "usage: scripts/manage.sh release status | publish <installer> --install-id <id> | approve <plan> --smoke passed | reject <plan> | promote <plan>"
  load_env
  local key value
  MX_LAUNCHER_URL="$(launcher_internal_url)"
  export MX_LAUNCHER_URL
  if command -v kubectl >/dev/null 2>&1; then
    for key in MX_RIG_RELEASE_CLIENT_ID MX_RIG_RELEASE_CLIENT_SECRET MX_RIG_RELEASE_APPROVER_CLIENT_ID MX_RIG_RELEASE_APPROVER_CLIENT_SECRET; do
      [ -z "${!key:-}" ] || continue
      value="$(read_release_secret "$key")"
      [ -z "$value" ] || export "${key}=${value}"
    done
  fi
  node "${ROOT_DIR}/scripts/release-publish.mjs" "$@"
}

cmd_desktop() {
  need npm
  local args=("$@") public
  # The server this machine runs (compose up) is the one the build points at,
  # unless --server says otherwise.
  public="$(env_value MX_RIG_PUBLIC_URL)"
  # A Launcher-mode build reaches the service through its product VIP instead.
  if [ -n "$public" ] && ! printf '%s\n' "${args[@]+"${args[@]}"}" | grep -qx -e '--server' -e '--launcher'; then
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
    launcher) cmd_launcher "$@" ;;
    release) cmd_release "$@" ;;
    local) cmd_local "$@" ;;
    help | -h | --help) usage ;;
    *) usage; exit 1 ;;
  esac
fi
