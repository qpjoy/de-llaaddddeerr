#!/bin/bash

set -euo pipefail

STACK_DIR="${STACK_DIR:-$PWD/docker/hysteria2-mihomo-stack}"
ENV_FILE="${ENV_FILE:-$STACK_DIR/.env}"
USERS_FILE="${USERS_FILE:-$STACK_DIR/data/hysteria/users.csv}"
OUTPUT_DIR="${OUTPUT_DIR:-$STACK_DIR/data/subscriptions}"

usage() {
	cat <<'EOF'
Usage:
  bash ./scripts/export-hysteria2-mihomo-stack.sh [options]

Options:
  --stack-dir DIR    Stack directory. Default: ./docker/hysteria2-mihomo-stack
  --env-file PATH    Env file to source. Default: <stack-dir>/.env
  --users-file PATH  User registry CSV override
  --output-dir DIR   Override output directory
  --help             Show this help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--stack-dir)
			STACK_DIR="$2"
			shift 2
		;;
		--env-file)
			ENV_FILE="$2"
			shift 2
		;;
		--users-file)
			USERS_FILE="$2"
			shift 2
		;;
		--output-dir)
			OUTPUT_DIR="$2"
			shift 2
		;;
		--help|-h)
			usage
			exit 0
		;;
		*)
			echo "Unknown option: $1" >&2
			usage >&2
			exit 1
		;;
	esac
done

if [[ -f "$ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
fi

cmd=(
	bash "$PWD/scripts/export-hysteria2-mihomo.sh"
	--users-file "$USERS_FILE"
	--output-dir "$OUTPUT_DIR"
	--server-host "${HY2_SERVER_HOST:-}"
	--server-ports "${HY2_SERVER_PORTS:-}"
	--routing-mode "${HY2_MIHOMO_ROUTING_MODE:-cn-direct}"
	--hop-interval "${HY2_HOP_INTERVAL_SECONDS:-30}"
	--skip-cert-verify "${HY2_TLS_SKIP_CERT_VERIFY:-true}"
	--default-down "${HY2_DEFAULT_DOWN:-}"
	--default-up "${HY2_DEFAULT_UP:-}"
)

if [[ -n "${HY2_EXPORT_BASE_URL:-}" ]]; then
	cmd+=(--base-url "$HY2_EXPORT_BASE_URL")
fi

if [[ -n "${HY2_PEER_DNS:-}" ]]; then
	cmd+=(--dns "$HY2_PEER_DNS")
fi

if [[ -n "${HY2_TLS_SERVER_NAME:-}" ]]; then
	cmd+=(--tls-sni "$HY2_TLS_SERVER_NAME")
fi

if [[ -n "${HY2_TLS_FINGERPRINT:-}" ]]; then
	cmd+=(--tls-fingerprint "$HY2_TLS_FINGERPRINT")
fi

if [[ -n "${HY2_OBFS_PASSWORD:-}" ]]; then
	cmd+=(--obfs-password "$HY2_OBFS_PASSWORD")
fi

"${cmd[@]}"
