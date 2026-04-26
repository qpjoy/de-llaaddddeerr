#!/bin/bash

set -euo pipefail

INPUT_DIR="${INPUT_DIR:-$PWD/docker/wg-mihomo-stack/data/wireguard}"
OUTPUT_DIR="${OUTPUT_DIR:-$PWD/docker/wg-mihomo-stack/data/subscriptions}"
BASE_URL="${BASE_URL:-}"
REMOTE_DNS_RESOLVE="${REMOTE_DNS_RESOLVE:-true}"
DEFAULT_DNS="${DEFAULT_DNS:-}"
DEFAULT_MTU="${DEFAULT_MTU:-}"
ROUTING_MODE="${ROUTING_MODE:-cn-direct}"

usage() {
	cat <<'EOF'
Usage:
  bash ./scripts/export-lsio-wireguard-mihomo.sh [options]

Options:
  --input-dir DIR      Directory containing standard WireGuard client .conf files.
                       Default: ./docker/wg-mihomo-stack/data/wireguard
  --output-dir DIR     Output directory for per-user Mihomo YAML files.
                       Default: ./docker/wg-mihomo-stack/data/subscriptions
  --base-url URL       Optional base URL used to write subscription links to clients.csv
  --dns LIST           Optional DNS override, comma-separated
  --mtu N              Optional MTU override
  --routing-mode MODE  One of: cn-direct, global. Default: cn-direct
  --help               Show this help

Supported input layout examples:
  /root/wireguard-clients/user01.conf
  /root/wireguard-clients/user02.conf
  <input-dir>/peer_<name>/<name>.conf
  <input-dir>/peer1/peer1.conf

Example:
  bash ./scripts/export-lsio-wireguard-mihomo.sh \
    --input-dir /root/wireguard-clients \
    --output-dir ./docker/wg-mihomo-stack/data/subscriptions \
    --base-url https://vpn.example.com
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--input-dir)
			INPUT_DIR="$2"
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
		--dns)
			DEFAULT_DNS="$2"
			shift 2
		;;
		--mtu)
			DEFAULT_MTU="$2"
			shift 2
		;;
		--routing-mode)
			ROUTING_MODE="$2"
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

parse_endpoint() {
	local endpoint="$1"

	if [[ "$endpoint" =~ ^\[(.+)\]:(.+)$ ]]; then
		ENDPOINT_HOST="${BASH_REMATCH[1]}"
		ENDPOINT_PORT="${BASH_REMATCH[2]}"
		return
	fi

	ENDPOINT_HOST="${endpoint%:*}"
	ENDPOINT_PORT="${endpoint##*:}"
}

read_conf_value() {
	local section="$1"
	local key="$2"
	local conf_path="$3"

	awk -v want_section="$section" -v want_key="$key" '
		$0 == "[" want_section "]" { section = 1; next }
		/^\[/ { section = 0 }
		section == 1 && $0 ~ "^" want_key " = " {
			sub("^" want_key " = ", "", $0)
			print
			exit
		}
	' "$conf_path"
}

write_mihomo_profile() {
	local output_path="$1"
	local profile_name="$2"
	local ipv4="$3"
	local ipv6="$4"
	local private_key="$5"
	local public_key="$6"
	local preshared_key="$7"
	local allowed_ips="$8"
	local endpoint_host="$9"
	local endpoint_port="${10}"
	local dns_csv="${11}"
	local mtu="${12}"
	local keepalive="${13}"
	local dns_yaml allowed_yaml

	dns_yaml=$(csv_to_yaml_list "$dns_csv")
	allowed_yaml=$(csv_to_yaml_list "$allowed_ips")

	{
		echo "mixed-port: 7890"
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
		echo "    type: wireguard"
		echo "    server: $endpoint_host"
		echo "    port: $endpoint_port"
		echo "    ip: $ipv4"
		if [[ -n "$ipv6" ]]; then
			echo "    ipv6: $ipv6"
		fi
		echo "    private-key: $private_key"
		echo "    public-key: $public_key"
		if [[ -n "$preshared_key" ]]; then
			echo "    pre-shared-key: $preshared_key"
		fi
		echo "    allowed-ips: $allowed_yaml"
		echo "    udp: true"
		if [[ -n "$keepalive" ]]; then
			echo "    persistent-keepalive: $keepalive"
		fi
		if [[ -n "$mtu" ]]; then
			echo "    mtu: $mtu"
		fi
		if [[ "$REMOTE_DNS_RESOLVE" == "true" && -n "$dns_csv" ]]; then
			echo "    remote-dns-resolve: true"
			echo "    dns: $dns_yaml"
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

if [[ ! -d "$INPUT_DIR" ]]; then
	echo "Input directory not found: $INPUT_DIR" >&2
	exit 1
fi

validate_routing_mode

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

if [[ -n "$BASE_URL" ]]; then
	BASE_URL="${BASE_URL%/}"
fi

SUMMARY_FILE="$OUTPUT_DIR/clients.csv"
echo "name,ipv4,source_conf,mihomo_yaml,subscription_url" > "$SUMMARY_FILE"

peer_confs=()
while IFS= read -r conf_path; do
	peer_confs+=("$conf_path")
done < <(find "$INPUT_DIR" -type f -name '*.conf' ! -path '*/wg_confs/*' ! -path '*/templates/*' ! -path '*/server/*' | sort)

if [[ "${#peer_confs[@]}" -eq 0 ]]; then
	echo "No peer .conf files found under: $INPUT_DIR" >&2
	exit 1
fi

for conf_path in "${peer_confs[@]}"; do
	name=$(basename "$conf_path" .conf)
	addresses=$(read_conf_value "Interface" "Address" "$conf_path")
	dns_csv="${DEFAULT_DNS:-$(read_conf_value "Interface" "DNS" "$conf_path")}"
	private_key=$(read_conf_value "Interface" "PrivateKey" "$conf_path")
	mtu="${DEFAULT_MTU:-$(read_conf_value "Interface" "MTU" "$conf_path")}"
	public_key=$(read_conf_value "Peer" "PublicKey" "$conf_path")
	preshared_key=$(read_conf_value "Peer" "PresharedKey" "$conf_path")
	allowed_ips=$(read_conf_value "Peer" "AllowedIPs" "$conf_path")
	endpoint=$(read_conf_value "Peer" "Endpoint" "$conf_path")
	keepalive=$(read_conf_value "Peer" "PersistentKeepalive" "$conf_path")

	ipv4=""
	ipv6=""
	IFS=',' read -r -a address_values <<< "$addresses"
	for address in "${address_values[@]}"; do
		address=$(trim_spaces "$address")
		address="${address%%/*}"
		if [[ "$address" == *:* ]]; then
			ipv6="$address"
		elif [[ -n "$address" ]]; then
			ipv4="$address"
		fi
	done

	if [[ -z "$ipv4" || -z "$private_key" || -z "$public_key" || -z "$allowed_ips" || -z "$endpoint" ]]; then
		echo "Incomplete peer config, cannot translate: $conf_path" >&2
		exit 1
	fi

	parse_endpoint "$endpoint"

	output_path="$OUTPUT_DIR/${name}.mihomo.yaml"
	write_mihomo_profile "$output_path" "$name" "$ipv4" "$ipv6" "$private_key" "$public_key" "$preshared_key" "$allowed_ips" "$ENDPOINT_HOST" "$ENDPOINT_PORT" "$dns_csv" "$mtu" "$keepalive"
	chmod 600 "$output_path"

	subscription_url=""
	if [[ -n "$BASE_URL" ]]; then
		subscription_url="$BASE_URL/$(basename "$output_path")"
	fi

	echo "$name,$ipv4,$conf_path,$output_path,$subscription_url" >> "$SUMMARY_FILE"
	echo "Generated $output_path"
done

echo
echo "Finished. Summary written to: $SUMMARY_FILE"
echo "Subscriptions are in: $OUTPUT_DIR"
