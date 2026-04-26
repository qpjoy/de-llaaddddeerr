#!/bin/bash

set -euo pipefail

STACK_DIR="${STACK_DIR:-$PWD/docker/wg-mihomo-stack}"
ENV_FILE="${ENV_FILE:-$STACK_DIR/.env}"
INPUT_DIR="${INPUT_DIR:-$STACK_DIR/data/wireguard}"
OUTPUT_DIR="${OUTPUT_DIR:-$STACK_DIR/data/subscriptions}"

usage() {
	cat <<'EOF'
Usage:
  bash ./scripts/export-wg-mihomo-stack.sh [options]

Options:
  --stack-dir DIR   Stack directory. Default: ./docker/wg-mihomo-stack
  --env-file PATH   Env file to source. Default: <stack-dir>/.env
  --input-dir DIR   Override input directory
  --output-dir DIR  Override output directory
  --help            Show this help

This wrapper reads WG_EXPORT_BASE_URL from the stack .env file and then calls:
  scripts/export-lsio-wireguard-mihomo.sh
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
		--input-dir)
			INPUT_DIR="$2"
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
	bash "$PWD/scripts/export-lsio-wireguard-mihomo.sh"
	--input-dir "$INPUT_DIR"
	--output-dir "$OUTPUT_DIR"
)

if [[ -n "${WG_EXPORT_BASE_URL:-}" ]]; then
	cmd+=(--base-url "$WG_EXPORT_BASE_URL")
fi

if [[ -n "${WG_PEER_DNS:-}" ]]; then
	cmd+=(--dns "$WG_PEER_DNS")
fi

if [[ -n "${WG_MIHOMO_ROUTING_MODE:-}" ]]; then
	cmd+=(--routing-mode "$WG_MIHOMO_ROUTING_MODE")
fi

"${cmd[@]}"
