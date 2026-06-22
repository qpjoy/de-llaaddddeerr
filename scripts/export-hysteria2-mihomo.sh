#!/bin/bash

set -euo pipefail

USERS_FILE="${USERS_FILE:-$PWD/docker/hysteria2-mihomo-stack/data/hysteria/users.csv}"
OUTPUT_DIR="${OUTPUT_DIR:-$PWD/docker/hysteria2-mihomo-stack/data/subscriptions}"
BASE_URL="${BASE_URL:-}"
SERVER_HOST="${SERVER_HOST:-}"
SERVER_PORTS="${SERVER_PORTS:-}"
PEER_DNS="${PEER_DNS:-}"
ROUTING_MODE="${ROUTING_MODE:-cn-direct}"
HOP_INTERVAL="${HOP_INTERVAL:-30}"
TLS_SNI="${TLS_SNI:-}"
SKIP_CERT_VERIFY="${SKIP_CERT_VERIFY:-true}"
TLS_FINGERPRINT="${TLS_FINGERPRINT:-}"
OBFS_PASSWORD="${OBFS_PASSWORD:-}"
DEFAULT_DOWN="${DEFAULT_DOWN:-}"
DEFAULT_UP="${DEFAULT_UP:-}"

usage() {
	cat <<'EOF'
Usage:
  bash ./scripts/export-hysteria2-mihomo.sh [options]

Options:
  --users-file PATH       User registry CSV. Default: ./docker/hysteria2-mihomo-stack/data/hysteria/users.csv
  --output-dir DIR        Output directory for Mihomo YAML files
  --base-url URL          Optional base URL used to write subscription links to clients.csv
  --server-host HOST      Public host/IP clients connect to
  --server-ports SPEC     Port or port range, e.g. 52120 or 52120-52159
  --dns LIST              Optional DNS override, comma-separated
  --routing-mode MODE     One of: cn-direct, global. Default: cn-direct
  --hop-interval SEC      Port hop interval in seconds. Default: 30
  --tls-sni NAME          TLS SNI value to use in client config
  --skip-cert-verify BOOL true/false. Default: true
  --tls-fingerprint FP    Optional TLS certificate fingerprint
  --obfs-password PASS    Optional Salamander obfuscation password
  --default-down RATE     Default per-user down value when CSV leaves it empty
  --default-up RATE       Default per-user up value when CSV leaves it empty
  --help                  Show this help
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--users-file)
			USERS_FILE="$2"
			shift 2
		;;
		--output-dir)
			OUTPUT_DIR="$2"
			shift 2
		;;
		--base-url)
			BASE_URL="$2"
			shift 2
		;;
		--server-host)
			SERVER_HOST="$2"
			shift 2
		;;
		--server-ports)
			SERVER_PORTS="$2"
			shift 2
		;;
		--dns)
			PEER_DNS="$2"
			shift 2
		;;
		--routing-mode)
			ROUTING_MODE="$2"
			shift 2
		;;
		--hop-interval)
			HOP_INTERVAL="$2"
			shift 2
		;;
		--tls-sni)
			TLS_SNI="$2"
			shift 2
		;;
		--skip-cert-verify)
			SKIP_CERT_VERIFY="$2"
			shift 2
		;;
		--tls-fingerprint)
			TLS_FINGERPRINT="$2"
			shift 2
		;;
		--obfs-password)
			OBFS_PASSWORD="$2"
			shift 2
		;;
		--default-down)
			DEFAULT_DOWN="$2"
			shift 2
		;;
		--default-up)
			DEFAULT_UP="$2"
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

trim_spaces() {
	sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<< "$1"
}

validate_routing_mode() {
	case "$ROUTING_MODE" in
		cn-direct|global) ;;
		*)
			echo "Unsupported routing mode: $ROUTING_MODE" >&2
			exit 1
		;;
	esac
}

csv_to_yaml_list() {
	local raw_csv="$1"
	local value trimmed
	local -a values=()

	IFS=',' read -r -a raw_values <<< "$raw_csv"
	for value in "${raw_values[@]}"; do
		trimmed=$(trim_spaces "$value")
		[[ -n "$trimmed" ]] && values+=("$trimmed")
	done

	if [[ "${#values[@]}" -eq 0 ]]; then
		echo "[]"
		return
	fi

	printf "["
	for ((i=0; i<${#values[@]}; i++)); do
		if [[ "$i" -gt 0 ]]; then
			printf ", "
		fi
		printf "\"%s\"" "${values[$i]}"
	done
	printf "]"
}

first_port_from_spec() {
	local spec="$1"
	local first="${spec%%,*}"
	first="${first%%-*}"
	echo "$first"
}

write_profile() {
	local output_path="$1"
	local profile_name="$2"
	local auth_token="$3"
	local down_rate="$4"
	local up_rate="$5"
	local dns_yaml first_port

	dns_yaml="$(csv_to_yaml_list "$PEER_DNS")"
	first_port="$(first_port_from_spec "$SERVER_PORTS")"

	{
		echo "mixed-port: ${MIHOMO_MIXED_PORT:-7788}"
		echo "allow-lan: false"
		echo "mode: rule"
		echo "log-level: info"
		if [[ "$ROUTING_MODE" == "cn-direct" ]]; then
			echo "geodata-mode: true"
			echo "geo-auto-update: true"
			echo "geo-update-interval: 24"
		fi
		echo
		echo "proxies:"
		echo "  - name: \"$profile_name\""
		echo "    type: hysteria2"
		echo "    server: $SERVER_HOST"
		echo "    port: $first_port"
		if [[ "$SERVER_PORTS" == *-* || "$SERVER_PORTS" == *,* ]]; then
			echo "    ports: \"$SERVER_PORTS\""
			echo "    hop-interval: $HOP_INTERVAL"
		fi
		echo "    password: \"$auth_token\""
		if [[ -n "$down_rate" ]]; then
			echo "    down: \"$down_rate\""
		fi
		if [[ -n "$up_rate" ]]; then
			echo "    up: \"$up_rate\""
		fi
		if [[ -n "$TLS_SNI" ]]; then
			echo "    sni: \"$TLS_SNI\""
		fi
		echo "    skip-cert-verify: $SKIP_CERT_VERIFY"
		if [[ -n "$TLS_FINGERPRINT" ]]; then
			echo "    fingerprint: \"$TLS_FINGERPRINT\""
		fi
		echo "    alpn:"
		echo "      - h3"
		if [[ -n "$PEER_DNS" ]]; then
			echo "    dns: $dns_yaml"
		fi
		if [[ -n "$OBFS_PASSWORD" ]]; then
			echo "    obfs: salamander"
			echo "    obfs-password: \"$OBFS_PASSWORD\""
		fi
		echo
		echo "proxy-groups:"
		echo "  - name: PROXY"
		echo "    type: select"
		echo "    proxies:"
		echo "      - \"$profile_name\""
		echo "      - DIRECT"
		echo
		echo "rules:"
		if [[ "$ROUTING_MODE" == "cn-direct" ]]; then
			echo "  - DOMAIN-SUFFIX,local,DIRECT"
			echo "  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve"
			echo "  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve"
			echo "  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve"
			echo "  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve"
			echo "  - IP-CIDR,169.254.0.0/16,DIRECT,no-resolve"
			echo "  - IP-CIDR6,::1/128,DIRECT,no-resolve"
			echo "  - IP-CIDR6,fc00::/7,DIRECT,no-resolve"
			echo "  - IP-CIDR6,fe80::/10,DIRECT,no-resolve"
			echo "  - GEOSITE,CN,DIRECT"
			echo "  - GEOIP,CN,DIRECT"
		fi
		echo "  - MATCH,PROXY"
	} > "$output_path"
}

[[ -f "$USERS_FILE" ]] || {
	echo "Users file not found: $USERS_FILE" >&2
	exit 1
}

[[ -n "$SERVER_HOST" ]] || {
	echo "server host is required" >&2
	exit 1
}

[[ -n "$SERVER_PORTS" ]] || {
	echo "server ports are required" >&2
	exit 1
}

validate_routing_mode
mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

if [[ -n "$BASE_URL" ]]; then
	BASE_URL="${BASE_URL%/}"
fi

SUMMARY_FILE="$OUTPUT_DIR/clients.csv"
echo "name,ipv4,source_conf,mihomo_yaml,subscription_url" > "$SUMMARY_FILE"

found_rows=0
while IFS=',' read -r raw_name raw_auth raw_up raw_down; do
	name="$(trim_spaces "$raw_name")"
	auth_token="$(trim_spaces "$raw_auth")"
	down_rate="$(trim_spaces "${raw_down:-}")"
	up_rate="$(trim_spaces "${raw_up:-}")"

	[[ -z "$name" || "$name" == "name" || "$name" == \#* ]] && continue
	[[ -n "$auth_token" ]] || continue

	found_rows=1
	[[ -n "$down_rate" ]] || down_rate="$DEFAULT_DOWN"
	[[ -n "$up_rate" ]] || up_rate="$DEFAULT_UP"

	peer_name="peer_${name}"
	output_path="$OUTPUT_DIR/${peer_name}.mihomo.yaml"
	write_profile "$output_path" "$peer_name" "$auth_token" "$down_rate" "$up_rate"

	subscription_url=""
	if [[ -n "$BASE_URL" ]]; then
		subscription_url="$BASE_URL/$(basename "$output_path")"
	fi

	echo "$peer_name,,,$output_path,$subscription_url" >> "$SUMMARY_FILE"
done < "$USERS_FILE"

if [[ "$found_rows" == "0" ]]; then
	echo "No valid users found in $USERS_FILE" >&2
	exit 1
fi
