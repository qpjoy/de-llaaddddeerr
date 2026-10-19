#!/usr/bin/env bash
# Host-side dispatcher. Product scripts remain responsible for deployment.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec python3 -I "$SCRIPT_DIR/manage.py" "$@"
