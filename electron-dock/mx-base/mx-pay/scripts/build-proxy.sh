#!/usr/bin/env bash
# Pay-only BuildKit and client proxy; never change Docker/containerd daemon config.
pay_with_build_proxy() (
  export MX_PAY_BUILD_PROXY
  export MX_PAY_BUILDKIT_IMAGE="${MX_PAY_BUILDKIT_IMAGE:-moby/buildkit:buildx-stable-1}"
  export NO_PROXY="${MX_PAY_BUILD_NO_PROXY:-localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.cluster.local}"
  MX_PAY_PROXY_BUILDER="$(node --input-type=module -e '
import { createHash } from "node:crypto";
const proxy=process.env.MX_PAY_BUILD_PROXY;
try { const u=new URL(proxy); if(!["http:","https:"].includes(u.protocol) || !u.hostname || u.search || u.hash || u.pathname!=="/" || /[\s,"\x27]/.test(proxy))throw new Error(); }
catch { console.error("MX_PAY_BUILD_PROXY must be an HTTP(S) proxy URL (values hidden)"); process.exit(1); }
console.log("mx-pay-proxy-"+createHash("sha256").update(JSON.stringify([proxy,process.env.NO_PROXY,process.env.MX_PAY_BUILDKIT_IMAGE])).digest("hex").slice(0,16));
')"
  export HTTP_PROXY="$MX_PAY_BUILD_PROXY" HTTPS_PROXY="$MX_PAY_BUILD_PROXY" ALL_PROXY="$MX_PAY_BUILD_PROXY"
  export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY" all_proxy="$ALL_PROXY" no_proxy="$NO_PROXY"
  "$@"
)

pay_image_reference() {
  node --input-type=module -e '
let ref=process.argv[1];
if(!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$/.test(ref))throw new Error("Invalid image reference");
const parts=ref.split("/");
if(parts.length===1)ref="docker.io/library/"+ref;
else if(!/[.:]/.test(parts[0]) && parts[0]!=="localhost")ref="docker.io/"+ref;
if(!ref.includes("@") && !ref.split("/").at(-1).includes(":"))ref+=":latest";
console.log(ref);
' "$1"
}

pay_proxy_ctr_pull() {
  local namespace="$1" platform="$2" ref="$3" help
  need ctr
  help="$(ctr --namespace "$namespace" images pull --help)"
  set -- --platform "$platform" "$ref"
  # containerd 2.x otherwise downloads in the daemon, outside this proxy scope.
  if [[ "$help" == *--local* ]]; then set -- --local "$@"; fi
  ctr --namespace "$namespace" --timeout 10m images pull "$@"
}

pay_proxy_bootstrap_image() (
  local ref
  ref="$(pay_image_reference "$MX_PAY_BUILDKIT_IMAGE")"
  pay_proxy_work="$(mktemp -d "${TMPDIR:-/tmp}/mx-pay-buildkit.XXXXXXXX")"
  trap 'rm -f -- "$pay_proxy_work/image.tar"; rmdir -- "$pay_proxy_work"' EXIT
  pay_proxy_ctr_pull mx-pay-build-proxy "$MX_PAY_PROXY_PLATFORM" "$ref"
  ctr --namespace mx-pay-build-proxy --timeout 10m images export --platform "$MX_PAY_PROXY_PLATFORM" "$pay_proxy_work/image.tar" "$ref"
  docker load --input "$pay_proxy_work/image.tar"
  docker image inspect "$MX_PAY_BUILDKIT_IMAGE" >/dev/null
)

pay_ensure_proxy_builder() {
  local endpoint identity driver running
  [ "$(uname -s)" = Linux ] || die 'MX_PAY_BUILD_PROXY requires the Linux deployment host'
  if [ -n "${DOCKER_CONTEXT:-}" ]; then endpoint="$(docker context inspect "$DOCKER_CONTEXT" --format '{{(index .Endpoints "docker").Host}}')"
  elif [ -n "${DOCKER_HOST:-}" ]; then endpoint="$DOCKER_HOST"
  else endpoint="$(docker context inspect --format '{{(index .Endpoints "docker").Host}}')"; fi
  case "$endpoint" in unix://*) ;; *) die 'MX_PAY_BUILD_PROXY requires a local Docker Unix socket for the host proxy';; esac
  MX_PAY_PROXY_PLATFORM="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
  case "$MX_PAY_PROXY_PLATFORM" in linux/amd64|linux/arm64) ;; *) die 'A local Linux Docker Engine is required';; esac
  docker buildx version >/dev/null
  if identity="$(docker container inspect "$MX_PAY_PROXY_BUILDER" --format '{{index .Config.Labels "dev.qpjoy.mx-pay.proxy-builder"}}|{{.Config.Image}}|{{.HostConfig.NetworkMode}}|{{.HostConfig.Privileged}}' 2>/dev/null)"; then
    [ "$identity" = "$MX_PAY_PROXY_BUILDER|$MX_PAY_BUILDKIT_IMAGE|host|true" ] || die 'Pay BuildKit ownership/configuration differs; container left unchanged'
  else
    if ! docker image inspect "$MX_PAY_BUILDKIT_IMAGE" >/dev/null 2>&1; then pay_proxy_bootstrap_image; fi
    docker create --name "$MX_PAY_PROXY_BUILDER" --pull=never --init --privileged --network host --restart unless-stopped \
      --label "dev.qpjoy.mx-pay.proxy-builder=$MX_PAY_PROXY_BUILDER" --volume "$MX_PAY_PROXY_BUILDER-state:/var/lib/buildkit" \
      --env HTTP_PROXY --env HTTPS_PROXY --env ALL_PROXY --env NO_PROXY \
      --env http_proxy --env https_proxy --env all_proxy --env no_proxy \
      "$MX_PAY_BUILDKIT_IMAGE" --allow-insecure-entitlement network.host >/dev/null
  fi
  running="$(docker container inspect "$MX_PAY_PROXY_BUILDER" --format '{{.State.Running}}')"
  [ "$running" = true ] || docker start "$MX_PAY_PROXY_BUILDER" >/dev/null
  endpoint="docker-container://$MX_PAY_PROXY_BUILDER"
  if driver="$(docker buildx inspect "$MX_PAY_PROXY_BUILDER" 2>/dev/null)"; then
    printf '%s\n' "$driver" | grep -Eq '^Driver:[[:space:]]+remote$' || die 'Pay builder driver differs; builder left unchanged'
    printf '%s\n' "$driver" | grep -Eq "^Endpoint:[[:space:]]+$endpoint[[:space:]]*$" || die 'Pay builder endpoint differs; builder left unchanged'
  else
    docker buildx create --name "$MX_PAY_PROXY_BUILDER" --driver remote "$endpoint" >/dev/null
  fi
  docker buildx inspect "$MX_PAY_PROXY_BUILDER" --bootstrap >/dev/null
}

pay_build_with_proxy() {
  pay_ensure_proxy_builder
  say 'Building Pay through its scoped proxy builder (proxy credentials hidden)'
  docker buildx build --builder "$MX_PAY_PROXY_BUILDER" --network host --allow network.host \
    --build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg ALL_PROXY --build-arg NO_PROXY \
    --build-arg http_proxy --build-arg https_proxy --build-arg all_proxy --build-arg no_proxy "$@"
}

pay_buildx() {
  if [ -n "${MX_PAY_BUILD_PROXY:-}" ]; then pay_with_build_proxy pay_build_with_proxy "$@"
  else docker buildx build "$@"; fi
}

pay_proxy_postgres_image() {
  local ref architecture
  node "$ROOT/scripts/runtime.mjs" local-single-node "$ROOT"
  ref="$(node "$ROOT/scripts/runtime.mjs" postgres-image "$ROOT")"
  ref="$(pay_image_reference "$ref")"
  need ctr
  if ctr --namespace k8s.io images list -q | grep -Fxq "$ref"; then return; fi
  case "$(uname -m)" in x86_64) architecture=amd64;; aarch64|arm64) architecture=arm64;; *) die 'Unsupported local PostgreSQL image architecture';; esac
  say 'Preloading PostgreSQL through the build proxy on the retained single node'
  pay_proxy_ctr_pull k8s.io "linux/$architecture" "$ref"
}
