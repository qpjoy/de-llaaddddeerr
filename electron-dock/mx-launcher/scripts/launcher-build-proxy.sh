#!/usr/bin/env bash
# Sourced by manage.sh. Proxy settings are confined to build/pull subprocesses.

launcher_with_build_proxy() (
  if [ -n "${MX_LAUNCHER_BUILD_PROXY:-}" ]; then
    launcher_build_proxy_environment
  fi
  "$@"
)

launcher_build_proxy_environment() {
  export MX_LAUNCHER_BUILD_PROXY
  export MX_LAUNCHER_BUILDKIT_IMAGE="${MX_LAUNCHER_BUILDKIT_IMAGE:-moby/buildkit:buildx-stable-1}"
  export NO_PROXY="${MX_LAUNCHER_BUILD_NO_PROXY:-localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.cluster.local}"
  local builder
  builder="$(node --input-type=module -e '
import { createHash } from "node:crypto";
const proxy = process.env.MX_LAUNCHER_BUILD_PROXY;
try {
  const url = new URL(proxy);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.search || url.hash ||
      url.pathname !== "/" || /[\s,"\x27]/.test(proxy)) throw new Error();
} catch {
  console.error("MX_LAUNCHER_BUILD_PROXY must be an HTTP(S) proxy URL; percent-encode special characters in credentials");
  process.exit(1);
}
const config = [proxy, process.env.NO_PROXY, process.env.MX_LAUNCHER_BUILDKIT_IMAGE];
console.log("mx-launcher-proxy-" + createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 16));
')"
  MX_LAUNCHER_PROXY_BUILDER="$builder"
  export HTTP_PROXY="$MX_LAUNCHER_BUILD_PROXY" HTTPS_PROXY="$MX_LAUNCHER_BUILD_PROXY" ALL_PROXY="$MX_LAUNCHER_BUILD_PROXY"
  export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"
  export npm_config_proxy="$HTTP_PROXY" npm_config_https_proxy="$HTTPS_PROXY" npm_config_noproxy="$NO_PROXY"
  export NPM_CONFIG_PROXY="$HTTP_PROXY" NPM_CONFIG_HTTPS_PROXY="$HTTPS_PROXY" NPM_CONFIG_NOPROXY="$NO_PROXY"
}

launcher_require_local_docker() {
  local endpoint platform
  if [ -n "${DOCKER_CONTEXT:-}" ]; then
    endpoint="$(docker context inspect "$DOCKER_CONTEXT" --format '{{(index .Endpoints "docker").Host}}')"
  elif [ -n "${DOCKER_HOST:-}" ]; then
    endpoint="$DOCKER_HOST"
  else
    endpoint="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')"
  fi
  case "$endpoint" in
    unix://*) ;;
    *) die "MX_LAUNCHER_BUILD_PROXY requires a local Docker Unix socket so host networking uses this machine's proxy" ;;
  esac
  platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
  case "$platform" in
    linux/*) ;;
    *) die "MX_LAUNCHER_BUILD_PROXY requires a Linux Docker Engine" ;;
  esac
  [ "$(uname -s)" = Linux ] || die "run MX_LAUNCHER_BUILD_PROXY on the Linux deployment host"
  MX_LAUNCHER_PROXY_PLATFORM="$platform"
}

# Docker pull uses dockerd's proxy, not the caller's HTTP_PROXY. Fetch public
# bootstrap/runtime images in the ctr client, then load them into Docker. Never
# change daemon settings or touch existing Kubernetes image references here.
launcher_proxy_pull_image() (
  local image="$1" canonical pull_help
  launcher_require_local_docker
  command -v ctr >/dev/null 2>&1 || die "ctr is required to preload uncached images through MX_LAUNCHER_BUILD_PROXY"
  canonical="$(containerd_image_ref_aliases "$image" | tail -n 1)"
  # Keep the trap path in this subshell, outside function-local scope: Bash 3
  # unwinds locals before running EXIT on an errexit failure.
  mx_proxy_pull_work="$(mktemp -d "${TMPDIR:-/tmp}/mx-launcher-proxy-image.XXXXXX")"
  trap 'mx_pull_status=$?; rm -f -- "$mx_proxy_pull_work/image.tar"; rmdir -- "$mx_proxy_pull_work" 2>/dev/null || true; exit "$mx_pull_status"' EXIT
  pull_help="$(ctr --namespace mx-launcher-build-proxy images pull --help)"
  set -- --platform "$MX_LAUNCHER_PROXY_PLATFORM" "$canonical"
  if [[ "$pull_help" == *--local* ]]; then
    # containerd 2.x otherwise delegates the download to its transfer service.
    set -- --local "$@"
  fi
  say "fetch image through the selected build proxy: $canonical"
  ctr --namespace mx-launcher-build-proxy --timeout 10m images pull \
    "$@"
  ctr --namespace mx-launcher-build-proxy --timeout 10m images export \
    --platform "$MX_LAUNCHER_PROXY_PLATFORM" "$mx_proxy_pull_work/image.tar" "$canonical"
  docker load --input "$mx_proxy_pull_work/image.tar"
  docker image inspect "$image" >/dev/null
)

launcher_ensure_proxy_builder() {
  local driver no_proxy_option
  launcher_require_local_docker
  docker buildx version >/dev/null 2>&1 || die "MX_LAUNCHER_BUILD_PROXY requires the Docker buildx plugin"
  if driver="$(docker buildx inspect "$MX_LAUNCHER_PROXY_BUILDER" 2>/dev/null)"; then
    printf '%s\n' "$driver" | grep -Eq '^Driver:[[:space:]]+docker-container$' \
      || die "the MX Launcher proxy builder has an unexpected driver"
    return 0
  fi
  if ! docker image inspect "$MX_LAUNCHER_BUILDKIT_IMAGE" >/dev/null 2>&1; then
    launcher_proxy_pull_image "$MX_LAUNCHER_BUILDKIT_IMAGE"
  fi
  # buildx driver options are CSV. Quote the complete NO_PROXY entry, including
  # its comma list, so bypass rules are passed as one environment variable.
  no_proxy_option="${NO_PROXY//\"/\"\"}"
  say "create scoped proxy builder: $MX_LAUNCHER_PROXY_BUILDER"
  docker buildx create --name "$MX_LAUNCHER_PROXY_BUILDER" \
    --driver docker-container --driver-opt network=host \
    --driver-opt "image=$MX_LAUNCHER_BUILDKIT_IMAGE" \
    --driver-opt "env.HTTP_PROXY=$HTTP_PROXY" --driver-opt "env.HTTPS_PROXY=$HTTPS_PROXY" \
    --driver-opt "env.http_proxy=$http_proxy" --driver-opt "env.https_proxy=$https_proxy" \
    --driver-opt "env.ALL_PROXY=$ALL_PROXY" --driver-opt "env.all_proxy=$all_proxy" \
    --driver-opt "\"env.NO_PROXY=$no_proxy_option\"" --driver-opt "\"env.no_proxy=$no_proxy_option\"" \
    --buildkitd-flags '--allow-insecure-entitlement network.host' >/dev/null
}

launcher_build_internal_with_proxy() {
  local registry
  # Preserve Compose's existing server/.env + process-env registry precedence.
  # The full rendered configuration can contain credentials; only extract the
  # registry into a variable, never print the configuration.
  registry="$(cd "$ROOT/server" && docker compose -f docker-compose.shadow.yml config --format json | node -e '
    const fs = require("node:fs");
    try {
      const value = JSON.parse(fs.readFileSync(0, "utf8")).services.internal.build.args.MX_SHADOW_NPM_REGISTRY;
      if (typeof value !== "string" || !value) throw new Error();
      process.stdout.write(value);
    } catch { console.error("cannot resolve the Internal build registry from Compose configuration"); process.exit(1); }
  ')"
  say "build Internal with scoped proxy builder: $MX_LAUNCHER_PROXY_BUILDER"
  MX_SHADOW_NPM_REGISTRY="$registry" docker buildx build \
    --builder "$MX_LAUNCHER_PROXY_BUILDER" --network host --allow network.host \
    --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg ALL_PROXY --build-arg NO_PROXY \
    --build-arg http_proxy --build-arg https_proxy --build-arg all_proxy --build-arg no_proxy \
    --build-arg MX_SHADOW_NPM_REGISTRY \
    --add-host host.docker.internal:host-gateway \
    --tag qpjoy/mx-launcher-server:shadow --file "$ROOT/server/Dockerfile" --load "$ROOT/server"
}

launcher_prune_proxy_builder() {
  local help storage_flag
  help="$(docker buildx prune --help)"
  if [[ "$help" == *--max-used-space* ]]; then
    storage_flag=--max-used-space
  else
    storage_flag=--keep-storage
  fi
  docker buildx prune --builder "$MX_LAUNCHER_PROXY_BUILDER" -f \
    --filter "until=${MX_SHADOW_BUILDKIT_PRUNE_UNTIL:-168h}" \
    "$storage_flag" "${MX_SHADOW_BUILDKIT_KEEP_STORAGE:-8GB}" >/dev/null
}
