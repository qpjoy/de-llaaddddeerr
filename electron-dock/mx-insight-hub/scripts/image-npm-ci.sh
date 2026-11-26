#!/bin/sh
# Used by the Hub Dockerfile for both the frontend and runtime dependencies.
set -eu

install_from() {
  registry=$1
  shift
  npm ci --registry="$registry" --prefer-offline --no-audit --no-fund \
    --fetch-retries=1 --fetch-retry-mintimeout=2000 --fetch-timeout=60000 "$@"
}

if [ -n "${NPM_REGISTRY:-}" ]; then
  install_from "$NPM_REGISTRY" "$@"
elif ! install_from https://registry.npmmirror.com "$@"; then
  echo "Hub image: npm ci failed using npmmirror; retrying the lockfile with registry.npmjs.org." >&2
  install_from https://registry.npmjs.org "$@"
fi
