#!/usr/bin/env bash
set -Eeuo pipefail

cat >&2 <<'EOF'
This manual Feishu Secret writer is deprecated and intentionally does not mutate Kubernetes.

Put MX_FEISHU_APP_ID, MX_FEISHU_APP_SECRET, and
MX_FEISHU_ALLOWED_TENANT_KEYS in server/.env, run chmod 600 server/.env, then use:

  bash scripts/manage.sh ops internal-production deploy

The normal deploy validates and ensures mx-feishu-oauth and triggers the required rollout.
EOF
exit 2
