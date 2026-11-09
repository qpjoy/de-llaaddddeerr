#!/usr/bin/env bash
# Adapter for the unified entry (electron-dock/scripts/manage.sh deploy runner):
# `deploy` is a full rollout (deploy.sh all); every other subcommand is passed
# through to deploy.sh unchanged. PROXY / MX_INSIGHT_BUILD_PROXY arrive already
# normalized by the unified entry.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "${1:-}" in
  deploy) shift; exec bash "$here/deploy.sh" all "$@" ;;
  status) shift; exec bash "$here/deploy.sh" health "$@" ;;
  *) exec bash "$here/deploy.sh" "$@" ;;
esac
