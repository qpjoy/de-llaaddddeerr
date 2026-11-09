#!/usr/bin/env bash
# Build, import and roll out mx-crawler-runner on the Internal Hub node.
#
#   scripts/deploy.sh build     docker build (verifies packages, runs offline tests on Linux)
#   scripts/deploy.sh import    docker save | ctr -n k8s.io images import
#   scripts/deploy.sh token     create the token Secret once (never printed)
#   scripts/deploy.sh apply     kubectl apply + rollout status
#   scripts/deploy.sh health    GET /v1/health with the Secret's token
#   scripts/deploy.sh all       build, import, token, apply, health
#
# Build network: PROXY=127.0.0.1:7788 as for the unified Hub deploy (or
# MX_INSIGHT_BUILD_PROXY) reuses the Hub's proxy-scoped buildx builder;
# without a proxy, MX_INSIGHT_BUILD_NETWORK=host builds on the host network.
# Run from a root shell on the Hub node (ctr needs root or sudo).
#
# The same token goes into Hub as credential collect-runner:
#   (cd ../../mx-insight-hub && node scripts/collect-acceptance.mjs runner-token)
# Read it on the node with:
#   kubectl -n mx-insight-hub get secret mx-crawler-runner-token -o jsonpath='{.data.token}' | base64 -d
set -euo pipefail
cd "$(dirname "$0")/.."
IMAGE=mx-crawler-runner:shadow
NAMESPACE=mx-insight-hub
SECRET=mx-crawler-runner-token
say() { printf '[mx-crawler-runner] %s\n' "$*" >&2; }
die() { say "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing command: $1"; }

# Same containerd resolution as mx-insight-hub/scripts/manage.sh run_ctr: the
# managed runtime descriptor is authoritative when present.
run_ctr() {
  local address
  if [ -e /etc/mx-k8s-runtime/active.json ] || [ -L /etc/mx-k8s-runtime/active.json ]; then
    if [ "$(id -u)" -eq 0 ]; then
      address="$(python3 /usr/local/lib/mx-k8s-runtime/resolve.py address 2>/dev/null)" || die 'Managed Kubernetes runtime verification failed; refusing the legacy containerd endpoint.'
      ctr --address "$address" -n k8s.io "$@"
    else
      need sudo
      address="$(sudo -n python3 /usr/local/lib/mx-k8s-runtime/resolve.py address 2>/dev/null)" || die 'Managed Kubernetes runtime verification failed; refusing the legacy containerd endpoint.'
      sudo -n ctr --address "$address" -n k8s.io "$@"
    fi
  elif [ "$(id -u)" -eq 0 ]; then
    ctr -n k8s.io "$@"
  else
    need sudo
    sudo ctr -n k8s.io "$@"
  fi
}

# Same build-network choices as the Hub deploy (mx-insight-hub/scripts/manage.sh):
#  - MX_INSIGHT_BUILD_PROXY: pull base images through that proxy with the
#    proxy-scoped buildx builder the Hub deploy creates (same name), leaving
#    the Docker daemon untouched. The package mirrors stay direct (NO_PROXY).
#  - MX_INSIGHT_BUILD_NETWORK=host: build on the host network (MTU issues).
# PROXY works like the unified entry (electron-dock/scripts/manage.sh): an
# explicit PROXY wins (empty = no build proxy), host:port means http://host:port.
# Otherwise MX_INSIGHT_BUILD_PROXY. The normalized value must equal the one the
# Hub deploy used, because the builder name is derived from it.
build_proxy() {
  local value
  if [ "${PROXY+set}" = set ]; then value="$PROXY"; else value="${MX_INSIGHT_BUILD_PROXY:-}"; fi
  [ -z "$value" ] && return 0
  case "$value" in *://*) ;; *) value="http://$value" ;; esac
  printf '%s' "${value%/}"
}

build() {
  need docker
  need node
  node scripts/lock-packages.mjs >/dev/null || die 'package trees differ from packages.json'
  local args=(--label dev.qpjoy.mx-crawler-runner.project=mx-crawler-runner -t "$IMAGE")
  [ -n "${PIP_INDEX_URL:-}" ] && args+=(--build-arg "PIP_INDEX_URL=$PIP_INDEX_URL")
  [ -n "${NPM_REGISTRY:-}" ] && args+=(--build-arg "NPM_REGISTRY=$NPM_REGISTRY")
  local proxy
  proxy="$(build_proxy)"
  if [ -n "$proxy" ]; then
    local builder no_proxy
    builder="mx-insight-buildproxy-$(MX_PROXY="$proxy" node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.MX_PROXY).digest("hex").slice(0, 16))')"
    docker buildx inspect "$builder" >/dev/null 2>&1 \
      || die "buildx builder $builder not found; deploy Hub first with the same PROXY (it creates the builder)"
    no_proxy="localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.svc,.cluster.local,mirrors.aliyun.com,registry.npmmirror.com"
    say "docker buildx build $IMAGE through the build proxy (value hidden)"
    HTTP_PROXY="$proxy" HTTPS_PROXY="$proxy" NO_PROXY="$no_proxy" \
    http_proxy="$proxy" https_proxy="$proxy" no_proxy="$no_proxy" \
    docker buildx build --builder "$builder" --network host --allow network.host --load \
      --build-arg "HTTP_PROXY=$proxy" --build-arg "HTTPS_PROXY=$proxy" \
      --build-arg "http_proxy=$proxy" --build-arg "https_proxy=$proxy" \
      --build-arg "NO_PROXY=$no_proxy" --build-arg "no_proxy=$no_proxy" \
      "${args[@]}" .
  else
    case "${MX_INSIGHT_BUILD_NETWORK:-}" in
      '') ;;
      host) args+=(--network host) ;;
      *) die "MX_INSIGHT_BUILD_NETWORK only accepts 'host'" ;;
    esac
    say "docker build $IMAGE"
    docker build --rm --force-rm "${args[@]}" .
  fi
}

import_image() {
  need docker
  local archive
  archive="$(mktemp -t mx-crawler-runner.XXXXXX.tar)"
  trap 'rm -f -- "$archive"' RETURN
  say "import $IMAGE into containerd namespace k8s.io"
  docker image save -o "$archive" "$IMAGE"
  run_ctr images import "$archive" >/dev/null
}

token() {
  need kubectl
  if kubectl -n "$NAMESPACE" get secret "$SECRET" >/dev/null 2>&1; then
    say "secret $SECRET exists; leaving it unchanged"
    return
  fi
  need openssl
  say "creating secret $SECRET (value not printed)"
  kubectl -n "$NAMESPACE" create secret generic "$SECRET" --from-literal=token="$(openssl rand -hex 32)" >/dev/null
  say 'enter the same token on the Hub engine page (credential key collect-runner)'
}

apply() {
  need kubectl
  kubectl apply -f deploy/k8s/mx-crawler-runner.yaml
  kubectl -n "$NAMESPACE" rollout restart deployment/mx-crawler-runner >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" rollout status deployment/mx-crawler-runner --timeout=180s
}

health() {
  need kubectl; need curl
  local value
  value="$(kubectl -n "$NAMESPACE" get secret "$SECRET" -o jsonpath='{.data.token}' | base64 -d)"
  curl -fsS --max-time 5 -H "authorization: Bearer ${value}" http://127.0.0.1:18190/v1/health
  printf '\n'
}

case "${1:-}" in
  build) build ;;
  import) import_image ;;
  token) token ;;
  apply) apply ;;
  health) health ;;
  all) build; import_image; token; apply; health ;;
  *) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 2 ;;
esac
