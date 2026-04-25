#!/bin/bash

set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$PWD}"
STACK_DIR="${STACK_DIR:-$ROOT_DIR/docker/wg-mihomo-stack}"
ENV_FILE="${ENV_FILE:-$STACK_DIR/.env}"

WG_PORT="${WG_PORT:-}"
OPENVPN_PORT="${OPENVPN_PORT:-334}"
EXPORT_HTTP_PORT="${EXPORT_HTTP_PORT:-}"
EXPORT_HTTPS_PORT="${EXPORT_HTTPS_PORT:-}"
EXPORT_FALLBACK_PORT="${EXPORT_FALLBACK_PORT:-}"

usage() {
	cat <<'EOF'
Usage:
  bash ./scripts/check-vpn-stack.sh [options]

Options:
  --stack-dir DIR            Stack directory. Default: ./docker/wg-mihomo-stack
  --env-file PATH            Env file to source. Default: <stack-dir>/.env
  --wg-port PORT             WireGuard UDP port to inspect
  --openvpn-port PORT        OpenVPN UDP port to inspect. Default: 334
  --http-port PORT           Subscription HTTP port to inspect
  --https-port PORT          Subscription HTTPS port to inspect
  --fallback-port PORT       Subscription fallback HTTP port to inspect
  --help                     Show this help

This script is read-only. It prints:
  - current IP / route / policy route state
  - docker / wg / openvpn service status
  - relevant listening ports
  - docker container status
  - iptables/nftables rules related to docker, wireguard, openvpn

Recommended use on the server:
  1. Run once before starting Docker WG
  2. Start only subscriptions, run again
  3. Start Docker WG, run again
  4. Compare the outputs
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
		--wg-port)
			WG_PORT="$2"
			shift 2
		;;
		--openvpn-port)
			OPENVPN_PORT="$2"
			shift 2
		;;
		--http-port)
			EXPORT_HTTP_PORT="$2"
			shift 2
		;;
		--https-port)
			EXPORT_HTTPS_PORT="$2"
			shift 2
		;;
		--fallback-port)
			EXPORT_FALLBACK_PORT="$2"
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

WG_PORT="${WG_PORT:-${WG_SERVER_PORT:-52080}}"
EXPORT_HTTP_PORT="${EXPORT_HTTP_PORT:-${WG_EXPORT_HTTP_PORT:-}}"
EXPORT_HTTPS_PORT="${EXPORT_HTTPS_PORT:-${WG_EXPORT_HTTPS_PORT:-}}"
EXPORT_FALLBACK_PORT="${EXPORT_FALLBACK_PORT:-${WG_EXPORT_FALLBACK_PORT:-3434}}"
WG_STACK_SUBNET="${WG_STACK_SUBNET:-unknown}"
WG_STACK_GATEWAY="${WG_STACK_GATEWAY:-unknown}"
OPENVPN_PROTOCOL="${OPENVPN_PROTOCOL:-unknown}"
OPENVPN_SUBNET="${OPENVPN_SUBNET:-unknown}"

if [[ -f /etc/openvpn/server/server.conf ]]; then
	if [[ -z "${OPENVPN_PORT:-}" || "${OPENVPN_PORT:-334}" == "334" ]]; then
		detected_openvpn_port="$(awk '/^port / { print $2; exit }' /etc/openvpn/server/server.conf)"
		[[ -n "$detected_openvpn_port" ]] && OPENVPN_PORT="$detected_openvpn_port"
	fi

	detected_openvpn_protocol="$(awk '/^proto / { print $2; exit }' /etc/openvpn/server/server.conf)"
	[[ -n "$detected_openvpn_protocol" ]] && OPENVPN_PROTOCOL="$detected_openvpn_protocol"

	detected_openvpn_subnet="$(awk '/^server / { print $2 " " $3; exit }' /etc/openvpn/server/server.conf)"
	[[ -n "$detected_openvpn_subnet" ]] && OPENVPN_SUBNET="$detected_openvpn_subnet"
fi

print_section() {
	printf "\n== %s ==\n" "$1"
}

run_or_skip() {
	local label="$1"
	shift
	if "$@" >/dev/null 2>&1; then
		echo "$label: yes"
	else
		echo "$label: no"
	fi
}

show_service_state() {
	local service="$1"
	if command -v systemctl >/dev/null 2>&1; then
		if systemctl list-unit-files "$service" >/dev/null 2>&1; then
			printf "%-22s %s\n" "$service" "$(systemctl is-active "$service" 2>/dev/null || echo inactive)"
		else
			printf "%-22s %s\n" "$service" "not-installed"
		fi
	else
		printf "%-22s %s\n" "$service" "systemctl-unavailable"
	fi
}

maybe_grep() {
	local pattern="$1"
	if grep -E "$pattern" >/dev/null 2>&1; then
		grep -E "$pattern"
	else
		echo "(no matching lines)"
	fi
}

build_port_pattern() {
	local -a ports=("$@")
	local port pattern=""

	for port in "${ports[@]}"; do
		[[ -z "$port" ]] && continue
		if [[ -n "$pattern" ]]; then
			pattern+="|"
		fi
		pattern+=":$port"
	done

	echo "$pattern"
}

print_section "Host"
echo "time: $(date '+%F %T %Z')"
echo "hostname: $(hostname)"
echo "kernel: $(uname -srmo)"

print_section "Ports Of Interest"
echo "wireguard_udp: $WG_PORT"
echo "openvpn_port: $OPENVPN_PORT"
echo "openvpn_proto: $OPENVPN_PROTOCOL"
echo "openvpn_subnet: $OPENVPN_SUBNET"
echo "subscription_http: ${EXPORT_HTTP_PORT:-disabled}"
echo "subscription_https: ${EXPORT_HTTPS_PORT:-disabled}"
echo "subscription_fallback: $EXPORT_FALLBACK_PORT"
echo "docker_stack_subnet: $WG_STACK_SUBNET"
echo "docker_stack_gateway: $WG_STACK_GATEWAY"

print_section "IP Address"
ip -brief addr

print_section "Routes"
ip route show

print_section "Policy Routes"
ip rule show

print_section "Forwarding"
sysctl net.ipv4.ip_forward 2>/dev/null || true
sysctl net.ipv6.conf.all.forwarding 2>/dev/null || true

print_section "Services"
show_service_state docker
show_service_state wg-quick@wg0
show_service_state wg-iptables
show_service_state openvpn-server@server
show_service_state openvpn

print_section "Docker"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
	docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
else
	echo "docker unavailable or daemon not running"
fi

print_section "Docker Networks"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
	docker network ls
	docker network inspect bridge >/dev/null 2>&1 && docker network inspect bridge --format '{{json .IPAM.Config}}' || true
else
	echo "docker unavailable or daemon not running"
fi

print_section "UDP Listeners"
ss -lunp | maybe_grep "(:$WG_PORT|:$OPENVPN_PORT)\\b"

print_section "TCP Listeners"
tcp_port_pattern="$(build_port_pattern "$EXPORT_HTTP_PORT" "$EXPORT_HTTPS_PORT" "$EXPORT_FALLBACK_PORT")"
if [[ -n "$tcp_port_pattern" ]]; then
	ss -ltnp | maybe_grep "($tcp_port_pattern)\\b"
else
	echo "(no tcp ports configured)"
fi

print_section "Relevant iptables Filter Rules"
if command -v iptables >/dev/null 2>&1; then
	iptables -S | maybe_grep "DOCKER|wg|openvpn|tun|FORWARD|INPUT|:$WG_PORT|:$OPENVPN_PORT|10\\.7\\.0\\.0|10\\.13\\.13\\.0"
else
	echo "iptables unavailable"
fi

print_section "Relevant iptables NAT Rules"
if command -v iptables >/dev/null 2>&1; then
	iptables -t nat -S | maybe_grep "DOCKER|MASQUERADE|SNAT|DNAT|:$WG_PORT|:$OPENVPN_PORT|10\\.7\\.0\\.0|10\\.13\\.13\\.0"
else
	echo "iptables unavailable"
fi

print_section "Relevant nftables Rules"
if command -v nft >/dev/null 2>&1; then
	nft list ruleset | maybe_grep "docker|wg|openvpn|tun|$WG_PORT|$OPENVPN_PORT|10\\.7\\.0\\.0|10\\.13\\.13\\.0"
else
	echo "nft unavailable"
fi

print_section "Quick Hints"
echo "- 7890/7897 are Mihomo client-side local ports, not the server's public WG port."
echo "- If only 'subscriptions' is started, it should not touch host routing or wg forwarding."
echo "- If host wg0 is already stable, prefer 'host WireGuard + subscriptions container' on Ubuntu."
echo "- If Docker WG and host WG both run, use different UDP ports and compare iptables before/after."
echo "- Keep Docker bridge subnet, OpenVPN subnet, and WireGuard client subnet all different."
