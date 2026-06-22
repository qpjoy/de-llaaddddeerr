#!/bin/bash

set -euo pipefail

WG_CONF="${WG_CONF:-/etc/wireguard/wg0.conf}"
COUNT=10
PREFIX="wg"
START_INDEX=1
OUTPUT_DIR="${OUTPUT_DIR:-$PWD/wireguard-clients}"
DNS_OVERRIDE="${DNS_OVERRIDE:-}"
KEEPALIVE="${KEEPALIVE:-25}"
MTU="${MTU:-}"
REMOTE_DNS_RESOLVE="${REMOTE_DNS_RESOLVE:-true}"
BASE_URL="${BASE_URL:-}"

usage() {
	cat <<'EOF'
Usage:
  sudo bash ./scripts/wg-batch-clients.sh [options]

Options:
  --count N           Number of clients to generate. Default: 10
  --prefix NAME       Client name prefix. Default: wg
  --start-index N     First numeric suffix. Default: 1
  --output-dir DIR    Directory for generated client files.
  --base-url URL      Optional public base URL for generated import links.
  --dns LIST          Comma-separated DNS servers for clients.
  --keepalive N       Persistent keepalive value. Default: 25
  --mtu N             Optional MTU for Mihomo profile output.
  --wg-conf PATH      WireGuard server config path. Default: /etc/wireguard/wg0.conf
  --help              Show this help.

Example:
  sudo bash ./scripts/wg-batch-clients.sh \
    --count 10 \
    --prefix mobile \
    --output-dir /root/wireguard-clients
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		--count)
			COUNT="$2"
			shift 2
		;;
		--prefix)
			PREFIX="$2"
			shift 2
		;;
		--start-index)
			START_INDEX="$2"
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
			DNS_OVERRIDE="$2"
			shift 2
		;;
		--keepalive)
			KEEPALIVE="$2"
			shift 2
		;;
		--mtu)
			MTU="$2"
			shift 2
		;;
		--wg-conf)
			WG_CONF="$2"
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

if [[ "$EUID" -ne 0 ]]; then
	echo "This script needs to run as root." >&2
	exit 1
fi

if [[ ! -f "$WG_CONF" ]]; then
	echo "WireGuard config not found: $WG_CONF" >&2
	exit 1
fi

if ! hash wg 2>/dev/null; then
	echo "wg command is required." >&2
	exit 1
fi

if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [[ "$COUNT" -lt 1 ]]; then
	echo "--count must be a positive integer." >&2
	exit 1
fi

if ! [[ "$START_INDEX" =~ ^[0-9]+$ ]] || [[ "$START_INDEX" -lt 1 ]]; then
	echo "--start-index must be a positive integer." >&2
	exit 1
fi

if ! [[ "$KEEPALIVE" =~ ^[0-9]+$ ]] || [[ "$KEEPALIVE" -lt 0 ]]; then
	echo "--keepalive must be a non-negative integer." >&2
	exit 1
fi

if [[ -n "$MTU" ]] && { ! [[ "$MTU" =~ ^[0-9]+$ ]] || [[ "$MTU" -lt 576 ]]; }; then
	echo "--mtu must be empty or an integer >= 576." >&2
	exit 1
fi

default_dns_servers() {
	local resolv_conf dns_servers

	if grep '^nameserver' /etc/resolv.conf 2>/dev/null | grep -qv '127.0.0.53'; then
		resolv_conf="/etc/resolv.conf"
	else
		resolv_conf="/run/systemd/resolve/resolv.conf"
	fi

	dns_servers=$(grep -v '^#\|^;' "$resolv_conf" 2>/dev/null | grep '^nameserver' | grep -v '127.0.0.53' | awk '{print $2}' | paste -sd',' -)
	if [[ -n "$dns_servers" ]]; then
		echo "$dns_servers"
	else
		echo "1.1.1.1,8.8.8.8"
	fi
}

trim_spaces() {
	sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<< "$1"
}

sanitize_name() {
	local raw_name="$1"
	sed 's/[^0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-]/_/g' <<< "$raw_name" | cut -c-15
}

yaml_dns_list() {
	local dns_csv="$1"
	local dns trimmed
	local -a entries=()

	IFS=',' read -r -a dns_values <<< "$dns_csv"
	for dns in "${dns_values[@]}"; do
		trimmed=$(trim_spaces "$dns")
		[[ -n "$trimmed" ]] && entries+=("$trimmed")
	done

	if [[ "${#entries[@]}" -eq 0 ]]; then
		echo "[]"
		return
	fi

	printf "["
	for ((i=0; i<${#entries[@]}; i++)); do
		if [[ "$i" -gt 0 ]]; then
			printf ", "
		fi
		printf "\"%s\"" "${entries[$i]}"
	done
	printf "]"
}

yaml_allowed_ips_list() {
	local allowed_yaml="['0.0.0.0/0'"

	if [[ "$HAS_IPV6" == "true" ]]; then
		allowed_yaml+=", '::/0'"
	fi

	allowed_yaml+="]"
	echo "$allowed_yaml"
}

collect_server_metadata() {
	local address_line v4_cidr v6_cidr

	WG_INTERFACE=$(basename "$WG_CONF")
	WG_INTERFACE="${WG_INTERFACE%.conf}"
	ENDPOINT=$(grep '^# ENDPOINT ' "$WG_CONF" | awk '{print $3}' | head -1)
	LISTEN_PORT=$(grep '^ListenPort = ' "$WG_CONF" | awk '{print $3}' | head -1)
	SERVER_PRIVATE_KEY=$(grep '^PrivateKey = ' "$WG_CONF" | awk '{print $3}' | head -1)
	address_line=$(grep '^Address = ' "$WG_CONF" | head -1)
	v4_cidr=$(sed -E 's/^Address = ([^, ]+).*/\1/' <<< "$address_line")
	v6_cidr=$(sed -nE 's/^Address = [^,]+, *([^ ]+).*$/\1/p' <<< "$address_line")

	if [[ -z "$ENDPOINT" || -z "$LISTEN_PORT" || -z "$SERVER_PRIVATE_KEY" || -z "$v4_cidr" ]]; then
		echo "Could not extract endpoint, port, private key, or IPv4 address from $WG_CONF" >&2
		exit 1
	fi

	if ! wg show "$WG_INTERFACE" >/dev/null 2>&1; then
		echo "WireGuard interface is not running: $WG_INTERFACE" >&2
		echo "Bring it up first, for example: wg-quick up $WG_INTERFACE" >&2
		exit 1
	fi

	SERVER_PUBLIC_KEY=$(wg pubkey <<< "$SERVER_PRIVATE_KEY")
	IPV4_PREFIX=$(awk -F'[./]' '{print $1 "." $2 "." $3}' <<< "$v4_cidr")
	IPV4_SERVER_CIDR="$v4_cidr"
	IPV4_CLIENT_MASK="${v4_cidr#*/}"

	if [[ -n "$v6_cidr" ]]; then
		IPV6_SERVER_CIDR="$v6_cidr"
		IPV6_BASE="${v6_cidr%%/*}"
		IPV6_CLIENT_BASE="${IPV6_BASE%::1}"
		HAS_IPV6="true"
	else
		HAS_IPV6="false"
	fi
}

next_free_octet() {
	local octet=2
	while grep -Eq "AllowedIPs = ${IPV4_PREFIX//./\\.}\.$octet/32([,[:space:]]|$)" "$WG_CONF"; do
		(( octet++ ))
	done

	if [[ "$octet" -ge 255 ]]; then
		echo "No free IPv4 addresses left in ${IPV4_PREFIX}.0/24" >&2
		exit 1
	fi

	echo "$octet"
}

append_peer_block() {
	local peer_block="$1"
	printf '%s\n' "$peer_block" >> "$WG_CONF"
	wg addconf "$WG_INTERFACE" <(printf '%s\n' "$peer_block")
}

build_peer_block() {
	local name="$1"
	local public_key="$2"
	local preshared_key="$3"
	local octet="$4"
	local allowed_ips="${IPV4_PREFIX}.${octet}/32"

	if [[ "$HAS_IPV6" == "true" ]]; then
		allowed_ips+=", ${IPV6_CLIENT_BASE}::${octet}/128"
	fi

	cat <<EOF
# BEGIN_PEER $name
[Peer]
PublicKey = $public_key
PresharedKey = $preshared_key
AllowedIPs = $allowed_ips
# END_PEER $name
EOF
}

write_standard_conf() {
	local path="$1"
	local private_key="$2"
	local preshared_key="$3"
	local octet="$4"
	local dns_csv="$5"
	local address="${IPV4_PREFIX}.${octet}/${IPV4_CLIENT_MASK}"
	local allowed_ips="0.0.0.0/0"

	if [[ "$HAS_IPV6" == "true" ]]; then
		address+=", ${IPV6_CLIENT_BASE}::${octet}/64"
		allowed_ips+=", ::/0"
	fi

	cat > "$path" <<EOF
[Interface]
Address = $address
DNS = $dns_csv
PrivateKey = $private_key

[Peer]
PublicKey = $SERVER_PUBLIC_KEY
PresharedKey = $preshared_key
AllowedIPs = $allowed_ips
Endpoint = $ENDPOINT:$LISTEN_PORT
PersistentKeepalive = $KEEPALIVE
EOF
}

write_mihomo_provider() {
	local path="$1"
	local name="$2"
	local private_key="$3"
	local preshared_key="$4"
	local octet="$5"
	local dns_csv="$6"
	local dns_yaml allowed_yaml

	dns_yaml=$(yaml_dns_list "$dns_csv")
	allowed_yaml=$(yaml_allowed_ips_list)

	{
		echo "proxies:"
		echo "  - name: \"$name\""
		echo "    type: wireguard"
		echo "    server: $ENDPOINT"
		echo "    port: $LISTEN_PORT"
		echo "    ip: ${IPV4_PREFIX}.${octet}"
		if [[ "$HAS_IPV6" == "true" ]]; then
			echo "    ipv6: ${IPV6_CLIENT_BASE}::${octet}"
		fi
		echo "    private-key: $private_key"
		echo "    public-key: $SERVER_PUBLIC_KEY"
		echo "    pre-shared-key: $preshared_key"
		echo "    allowed-ips: $allowed_yaml"
		echo "    udp: true"
		echo "    persistent-keepalive: $KEEPALIVE"
		if [[ -n "$MTU" ]]; then
			echo "    mtu: $MTU"
		fi
		if [[ "$REMOTE_DNS_RESOLVE" == "true" ]]; then
			echo "    remote-dns-resolve: true"
			echo "    dns: $dns_yaml"
		fi
	} > "$path"
}

write_mihomo_profile() {
	local path="$1"
	local name="$2"
	local private_key="$3"
	local preshared_key="$4"
	local octet="$5"
	local dns_csv="$6"
	local dns_yaml allowed_yaml

	dns_yaml=$(yaml_dns_list "$dns_csv")
	allowed_yaml=$(yaml_allowed_ips_list)

	{
		echo "mixed-port: ${MIHOMO_MIXED_PORT:-7788}"
		echo "allow-lan: false"
		echo "mode: rule"
		echo "log-level: info"
		echo
		echo "proxies:"
		echo "  - name: \"$name\""
		echo "    type: wireguard"
		echo "    server: $ENDPOINT"
		echo "    port: $LISTEN_PORT"
		echo "    ip: ${IPV4_PREFIX}.${octet}"
		if [[ "$HAS_IPV6" == "true" ]]; then
			echo "    ipv6: ${IPV6_CLIENT_BASE}::${octet}"
		fi
		echo "    private-key: $private_key"
		echo "    public-key: $SERVER_PUBLIC_KEY"
		echo "    pre-shared-key: $preshared_key"
		echo "    allowed-ips: $allowed_yaml"
		echo "    udp: true"
		echo "    persistent-keepalive: $KEEPALIVE"
		if [[ -n "$MTU" ]]; then
			echo "    mtu: $MTU"
		fi
		if [[ "$REMOTE_DNS_RESOLVE" == "true" ]]; then
			echo "    remote-dns-resolve: true"
			echo "    dns: $dns_yaml"
		fi
		echo
		echo "proxy-groups:"
		echo "  - name: PROXY"
		echo "    type: select"
		echo "    proxies:"
		echo "      - \"$name\""
		echo "      - DIRECT"
		echo
		echo "rules:"
		echo "  - MATCH,PROXY"
	} > "$path"
}

DNS_CSV="${DNS_OVERRIDE:-$(default_dns_servers)}"
collect_server_metadata

mkdir -p "$OUTPUT_DIR"
chmod 700 "$OUTPUT_DIR"

SUMMARY_FILE="$OUTPUT_DIR/clients.csv"
if [[ -n "$BASE_URL" ]]; then
	BASE_URL="${BASE_URL%/}"
fi

echo "name,ipv4,conf,mihomo_provider,mihomo_profile,conf_url,mihomo_provider_url,mihomo_profile_url" > "$SUMMARY_FILE"

width=${#COUNT}
if [[ "$width" -lt 2 ]]; then
	width=2
fi

for ((n=0; n<COUNT; n++)); do
	index=$((START_INDEX + n))
	suffix=$(printf "%0${width}d" "$index")
	name=$(sanitize_name "${PREFIX}${suffix}")

	if grep -q "^# BEGIN_PEER $name$" "$WG_CONF"; then
		echo "Client name already exists in $WG_CONF: $name" >&2
		exit 1
	fi

	octet=$(next_free_octet)
	private_key=$(wg genkey)
	public_key=$(wg pubkey <<< "$private_key")
	preshared_key=$(wg genpsk)
	peer_block=$(build_peer_block "$name" "$public_key" "$preshared_key" "$octet")

	append_peer_block "$peer_block"

	conf_path="$OUTPUT_DIR/${name}.conf"
	provider_path="$OUTPUT_DIR/${name}.mihomo-provider.yaml"
	profile_path="$OUTPUT_DIR/${name}.mihomo.yaml"

	write_standard_conf "$conf_path" "$private_key" "$preshared_key" "$octet" "$DNS_CSV"
	write_mihomo_provider "$provider_path" "$name" "$private_key" "$preshared_key" "$octet" "$DNS_CSV"
	write_mihomo_profile "$profile_path" "$name" "$private_key" "$preshared_key" "$octet" "$DNS_CSV"

	chmod 600 "$conf_path" "$provider_path" "$profile_path"
	conf_url=""
	provider_url=""
	profile_url=""
	if [[ -n "$BASE_URL" ]]; then
		conf_url="$BASE_URL/$(basename "$conf_path")"
		provider_url="$BASE_URL/$(basename "$provider_path")"
		profile_url="$BASE_URL/$(basename "$profile_path")"
	fi

	echo "$name,${IPV4_PREFIX}.${octet},$conf_path,$provider_path,$profile_path,$conf_url,$provider_url,$profile_url" >> "$SUMMARY_FILE"
	echo "Generated $name -> ${IPV4_PREFIX}.${octet}"
done

echo
echo "Finished. Summary written to: $SUMMARY_FILE"
echo "Files are in: $OUTPUT_DIR"
