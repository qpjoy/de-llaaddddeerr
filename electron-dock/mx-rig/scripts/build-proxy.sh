#!/usr/bin/env bash
# Sourced by manage.sh. Proxy settings never escape build/pull subprocesses.
# Like Launcher/Pay, own the BuildKit bootstrap instead of changing dockerd.

rig_with_build_proxy() (
  local pattern='^https?://([^/@?#[:space:]]+@)?(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(:[0-9]{1,5})?/?$'
  local port signature
  case "$MX_RIG_BUILD_PROXY" in
    *[\'\"\,\\]*) die 'MX_RIG_BUILD_PROXY / PROXY must be an HTTP(S) proxy URL (value hidden)' ;;
  esac
  [[ "$MX_RIG_BUILD_PROXY" =~ $pattern ]] || die 'MX_RIG_BUILD_PROXY / PROXY must be an HTTP(S) proxy URL (value hidden)'
  port="${BASH_REMATCH[4]#:}"
  if [ -n "$port" ] && { [ "$((10#$port))" -lt 1 ] || [ "$((10#$port))" -gt 65535 ]; }; then
    die 'MX_RIG_BUILD_PROXY / PROXY has an invalid port (value hidden)'
  fi
  need openssl
  MX_RIG_BUILDKIT_IMAGE="${MX_RIG_BUILDKIT_IMAGE:-moby/buildkit:buildx-stable-1}"
  export NO_PROXY="${MX_RIG_BUILD_NO_PROXY:-localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.cluster.local}"
  signature="$(printf '%s\0' "$MX_RIG_BUILD_PROXY" "$NO_PROXY" "$MX_RIG_BUILDKIT_IMAGE" |
    openssl dgst -sha256 | awk '{ print substr($NF, 1, 16) }')"
  MX_RIG_PROXY_BUILDER="mx-rig-proxy-${signature}"
  export HTTP_PROXY="$MX_RIG_BUILD_PROXY" HTTPS_PROXY="$MX_RIG_BUILD_PROXY" ALL_PROXY="$MX_RIG_BUILD_PROXY"
  export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"
  "$@"
)

rig_require_local_docker() {
  local endpoint
  [ "$(uname -s)" = Linux ] || die 'PROXY builds require the Linux deployment host'
  if [ -n "${DOCKER_CONTEXT:-}" ]; then
    endpoint="$(docker context inspect "$DOCKER_CONTEXT" --format '{{(index .Endpoints "docker").Host}}')"
  elif [ -n "${DOCKER_HOST:-}" ]; then
    endpoint="$DOCKER_HOST"
  else
    endpoint="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')"
  fi
  case "$endpoint" in unix://*) ;; *) die 'PROXY builds require a local Docker Unix socket for the host proxy' ;; esac
  MX_RIG_PROXY_PLATFORM="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
  case "$MX_RIG_PROXY_PLATFORM" in linux/amd64|linux/arm64) ;; *) die 'PROXY builds require a local Linux Docker Engine (amd64/arm64)' ;; esac
}

rig_image_reference() {
  local ref="$1" first
  [[ "$ref" =~ ^[A-Za-z0-9][A-Za-z0-9._:/@-]*$ ]] || die 'invalid build image reference'
  if [[ "$ref" != */* ]]; then
    ref="docker.io/library/$ref"
  else
    first="${ref%%/*}"
    case "$first" in *.*|*:*|localhost) ;; *) ref="docker.io/$ref" ;; esac
  fi
  if [[ "$ref" != *@* ]] && [[ "${ref##*/}" != *:* ]]; then ref="${ref}:latest"; fi
  printf '%s\n' "$ref"
}

rig_proxy_ctr() {
  need ctr
  if [ "$(id -u)" -eq 0 ]; then
    ctr "$@"
  else
    # sudo normally drops the client proxy; retain only these named variables.
    sudo -n --preserve-env=HTTP_PROXY,HTTPS_PROXY,ALL_PROXY,NO_PROXY,http_proxy,https_proxy,all_proxy,no_proxy ctr "$@"
  fi
}

rig_managed_runtime_value() {
  if [ "$(id -u)" -eq 0 ]; then
    python3 /usr/local/lib/mx-k8s-runtime/resolve.py "$1" 2>/dev/null || { printf '%s\n' 'Managed Kubernetes runtime verification failed; refusing the legacy containerd endpoint.' >&2; return 1; }
  else
    sudo -n python3 /usr/local/lib/mx-k8s-runtime/resolve.py "$1" 2>/dev/null || { printf '%s\n' 'Managed Kubernetes runtime verification failed; refusing the legacy containerd endpoint.' >&2; return 1; }
  fi
}

rig_proxy_namespace_ctr() {
  local namespace="$1" address
  shift
  if [ "$namespace" = k8s.io ] && { [ -e /etc/mx-k8s-runtime/active.json ] || [ -L /etc/mx-k8s-runtime/active.json ]; }; then
    address="$(rig_managed_runtime_value address)" || return 1
    [ -n "$address" ] || return 1
    rig_proxy_ctr --address "$address" --namespace "$namespace" "$@"
  else
    rig_proxy_ctr --namespace "$namespace" "$@"
  fi
}

rig_proxy_ctr_pull() {
  local namespace="$1" ref="$2" help
  help="$(rig_proxy_namespace_ctr "$namespace" images pull --help)" || return 1
  set -- --platform "$MX_RIG_PROXY_PLATFORM" "$ref"
  # containerd 2.x otherwise delegates downloads to the unconfigured daemon.
  if [[ "$help" == *--local* ]]; then set -- --local "$@"; fi
  rig_proxy_namespace_ctr "$namespace" --timeout 10m images pull "$@"
}

rig_proxy_bootstrap_image() (
  local ref
  ref="$(rig_image_reference "$MX_RIG_BUILDKIT_IMAGE")"
  # Not local: Bash 3 unwinds function locals before the EXIT trap on failure.
  rig_proxy_work="$(mktemp -d "${TMPDIR:-/tmp}/mx-rig-buildkit.XXXXXX")"
  trap 'rig_pull_status=$?; rm -f -- "$rig_proxy_work/image.tar"; rmdir -- "$rig_proxy_work" 2>/dev/null || true; exit "$rig_pull_status"' EXIT
  say 'fetching BuildKit through the selected proxy'
  rig_proxy_ctr_pull mx-rig-build-proxy "$ref"
  rig_proxy_ctr --namespace mx-rig-build-proxy --timeout 10m images export \
    --platform "$MX_RIG_PROXY_PLATFORM" "$rig_proxy_work/image.tar" "$ref"
  docker load --input "$rig_proxy_work/image.tar"
  docker image inspect "$MX_RIG_BUILDKIT_IMAGE" >/dev/null
)

rig_ensure_proxy_builder() {
  local identity running endpoint driver
  rig_require_local_docker
  docker buildx version >/dev/null 2>&1 || die 'PROXY builds require the Docker buildx plugin'
  if identity="$(docker container inspect "$MX_RIG_PROXY_BUILDER" --format '{{index .Config.Labels "dev.qpjoy.mx-rig.proxy-builder"}}|{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Privileged}}' 2>/dev/null)"; then
    [ "$identity" = "$MX_RIG_PROXY_BUILDER|$MX_RIG_BUILDKIT_IMAGE|host|true" ] || die 'Rig BuildKit ownership/configuration differs; container left unchanged'
  else
    if ! docker image inspect "$MX_RIG_BUILDKIT_IMAGE" >/dev/null 2>&1; then rig_proxy_bootstrap_image; fi
    # --pull=never avoids dockerd's unproxied registry lookup even after preload.
    # Host networking makes this node's 127.0.0.1 proxy reachable by BuildKit.
    docker create --name "$MX_RIG_PROXY_BUILDER" --pull=never --init --privileged --network host --restart unless-stopped \
      --label "dev.qpjoy.mx-rig.proxy-builder=$MX_RIG_PROXY_BUILDER" --volume "$MX_RIG_PROXY_BUILDER-state:/var/lib/buildkit" \
      --env HTTP_PROXY --env HTTPS_PROXY --env ALL_PROXY --env NO_PROXY \
      --env http_proxy --env https_proxy --env all_proxy --env no_proxy \
      "$MX_RIG_BUILDKIT_IMAGE" --allow-insecure-entitlement network.host >/dev/null
  fi
  running="$(docker container inspect "$MX_RIG_PROXY_BUILDER" --format '{{.State.Running}}')"
  [ "$running" = true ] || docker start "$MX_RIG_PROXY_BUILDER" >/dev/null
  endpoint="docker-container://$MX_RIG_PROXY_BUILDER"
  if driver="$(docker buildx inspect "$MX_RIG_PROXY_BUILDER" 2>/dev/null)"; then
    printf '%s\n' "$driver" | grep -Eq '^Driver:[[:space:]]+remote$' || die 'Rig builder driver differs; builder left unchanged'
    printf '%s\n' "$driver" | grep -Eq "^Endpoint:[[:space:]]+$endpoint[[:space:]]*$" || die 'Rig builder endpoint differs; builder left unchanged'
  else
    docker buildx create --name "$MX_RIG_PROXY_BUILDER" --driver remote "$endpoint" >/dev/null
  fi
  docker buildx inspect "$MX_RIG_PROXY_BUILDER" --bootstrap >/dev/null
}

rig_build_with_proxy() {
  rig_ensure_proxy_builder
  say 'building through the Rig proxy builder (proxy value hidden)'
  # The client fetches registry tokens; BuildKit pulls layers; RUN downloads npm.
  # Predefined proxy args need no Dockerfile ARG/ENV and stay out of image config.
  docker buildx build --builder "$MX_RIG_PROXY_BUILDER" --load --network host --allow network.host \
    --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg ALL_PROXY --build-arg NO_PROXY \
    --build-arg http_proxy --build-arg https_proxy --build-arg all_proxy --build-arg no_proxy "$@"
}

# Called only after resolve_image verified that this host is the single node.
rig_proxy_postgres_image() {
  local ref images
  rig_require_local_docker
  ref="$(awk '$1 == "image:" { print $2; exit }' "${K8S_DIR}/15-postgres.yaml")"
  ref="$(rig_image_reference "$ref")"
  images="$(rig_proxy_namespace_ctr k8s.io images list -q)" || return 1
  if printf '%s\n' "$images" | grep -Fxq -- "$ref"; then return; fi
  say 'preloading PostgreSQL through the selected proxy on the Rig node'
  rig_proxy_ctr_pull k8s.io "$ref"
}
