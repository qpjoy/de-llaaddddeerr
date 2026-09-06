#!/bin/bash
#
# https://github.com/Nyr/wireguard-install
#
# Copyright (c) 2020 Nyr. Released under the MIT License.

# The original no-argument installer remains below. qp-tunnel-cli calls the
# command mode in this section so managed WireGuard instances do not take over
# an existing wg0 installation.

QP_WG_DEFAULT_SUBNET="100.127.50.0/24"
QP_WG_DEFAULT_DNS="1.1.1.1, 8.8.8.8"
QP_WG_INSTANCE="${QP_WG_INSTANCE:-mx}"

qp_wg_die () { echo "Error: $*" >&2; exit 1; }
qp_wg_warn () { echo "Warning: $*" >&2; }
qp_wg_info () { echo "$*"; }
qp_wg_have () { command -v "$1" >/dev/null 2>&1; }

qp_wg_validate_ipv4 () {
	local value="$1" octet
	local -a octets
	[[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
	IFS='.' read -r -a octets <<< "$value"
	for octet in "${octets[@]}"; do
		[[ "$octet" -ge 0 && "$octet" -le 255 ]] || return 1
	done
}

qp_wg_validate_endpoint () {
	local value="$1"
	if [[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
		qp_wg_validate_ipv4 "$value"
	else
		[[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]
	fi
}

qp_wg_validate_dns () {
	local value="$1" entry trimmed count=0
	local -a entries
	[[ -n "$value" && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || return 1
	IFS=',' read -r -a entries <<< "$value"
	for entry in "${entries[@]}"; do
		trimmed="${entry#"${entry%%[![:space:]]*}"}"
		trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
		qp_wg_validate_ipv4 "$trimmed" || return 1
		count=$(( count + 1 ))
	done
	[[ "$count" -gt 0 ]]
}

qp_wg_validate_cidr () {
	local cidr="$1" ip prefix
	[[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || return 1
	ip="${cidr%/*}"
	prefix="${cidr#*/}"
	qp_wg_validate_ipv4 "$ip" || return 1
	[[ "$(qp_wg_cidr_network "$cidr")" == "$ip" ]]
}

qp_wg_ip_to_int () {
	local -a octets
	IFS='.' read -r -a octets <<< "$1"
	echo $(( (octets[0] << 24) + (octets[1] << 16) + (octets[2] << 8) + octets[3] ))
}

qp_wg_int_to_ip () {
	local value="$1"
	echo "$(( (value >> 24) & 255 )).$(( (value >> 16) & 255 )).$(( (value >> 8) & 255 )).$(( value & 255 ))"
}

qp_wg_cidr_network () {
	local cidr="$1" base size
	base=$(qp_wg_ip_to_int "${cidr%/*}")
	size=$(( 2 ** (32 - ${cidr#*/}) ))
	qp_wg_int_to_ip $(( base - (base % size) ))
}

qp_wg_cidr_range () {
	local cidr="$1" base size network
	base=$(qp_wg_ip_to_int "${cidr%/*}")
	size=$(( 2 ** (32 - ${cidr#*/}) ))
	network=$(( base - (base % size) ))
	echo "$network $(( network + size - 1 ))"
}

qp_wg_cidrs_overlap () {
	local a_start a_end b_start b_end
	read -r a_start a_end <<< "$(qp_wg_cidr_range "$1")"
	read -r b_start b_end <<< "$(qp_wg_cidr_range "$2")"
	[[ "$a_start" -le "$b_end" && "$b_start" -le "$a_end" ]]
}

qp_wg_validate_subnet () {
	local cidr="$1" ip prefix first second
	qp_wg_validate_cidr "$cidr" || return 1
	ip="${cidr%/*}"
	prefix="${cidr#*/}"
	[[ "$prefix" -ge 16 && "$prefix" -le 30 ]] || return 1
	IFS='.' read -r first second _ <<< "$ip"
	# 100.128/16 is public space. Within 100/8, only RFC 6598's
	# 100.64.0.0/10 is suitable for an overlay.
	if [[ "$first" -eq 100 && ( "$second" -lt 64 || "$second" -gt 127 ) ]]; then
		return 2
	fi
}

qp_wg_validate_port () {
	[[ "$1" =~ ^[0-9]+$ && "$1" -ge 1 && "$1" -le 65535 ]]
}

qp_wg_validate_port_range () {
	local value="$1" start end
	[[ "$value" =~ ^([0-9]+)-([0-9]+)$ ]] || return 1
	start="${BASH_REMATCH[1]}"
	end="${BASH_REMATCH[2]}"
	qp_wg_validate_port "$start" && qp_wg_validate_port "$end" && [[ "$start" -lt "$end" ]]
}

qp_wg_set_paths () {
	[[ "$QP_WG_INSTANCE" =~ ^[a-z][a-z0-9-]{0,8}$ ]] \
		|| qp_wg_die "Instance must match [a-z][a-z0-9-]{0,8}."
	QP_WG_SERVER_HOME="/etc/qp-wireguard/server/$QP_WG_INSTANCE"
	QP_WG_CLIENT_HOME="/etc/qp-wireguard/client/$QP_WG_INSTANCE"
	QP_WG_SERVER_ENV="$QP_WG_SERVER_HOME/server.env"
	QP_WG_CLIENT_ENV="$QP_WG_CLIENT_HOME/client.env"
	QP_WG_SERVER_CLIENTS="$QP_WG_SERVER_HOME/clients"
	QP_WG_SERVER_DEV="qpwgs-$QP_WG_INSTANCE"
	QP_WG_CLIENT_DEV="qpwgc-$QP_WG_INSTANCE"
	QP_WG_SERVER_CONFIG="/etc/wireguard/$QP_WG_SERVER_DEV.conf"
	QP_WG_CLIENT_CONFIG="/etc/wireguard/$QP_WG_CLIENT_DEV.conf"
	QP_WG_SERVER_UNIT="wg-quick@$QP_WG_SERVER_DEV.service"
	QP_WG_CLIENT_UNIT="wg-quick@$QP_WG_CLIENT_DEV.service"
	QP_WG_SYSCTL="/etc/sysctl.d/99-qp-wireguard-$QP_WG_INSTANCE.conf"
}

qp_wg_require_linux () {
	[[ "$(uname -s)" == Linux ]] || qp_wg_die "Managed WireGuard commands target Linux hosts."
}

qp_wg_require_root () {
	[[ "${EUID:-$(id -u)}" -eq 0 ]] || qp_wg_die "This command needs root. Re-run with sudo."
}

qp_wg_detect_public_ipv4 () {
	local token candidate=""
	if qp_wg_have curl; then
		token=$(curl --noproxy '*' -m 2 -fsS -X PUT \
			-H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
			'http://169.254.169.254/latest/api/token' 2>/dev/null || true)
		if [[ -n "$token" ]]; then
			candidate=$(curl --noproxy '*' -m 2 -fsS \
				-H "X-aws-ec2-metadata-token: $token" \
				'http://169.254.169.254/latest/meta-data/public-ipv4' 2>/dev/null || true)
		fi
	fi
	if ! qp_wg_validate_ipv4 "$candidate"; then
		if qp_wg_have curl; then
			candidate=$(curl -m 8 -4fsS https://api.ipify.org 2>/dev/null || true)
		elif qp_wg_have wget; then
			candidate=$(wget -qO- -T 8 -4 https://api.ipify.org 2>/dev/null || true)
		fi
	fi
	qp_wg_validate_ipv4 "$candidate" && echo "$candidate"
}

qp_wg_claimed_cidrs () {
	local env_file value
	if qp_wg_have ip; then
		ip -4 route show table all 2>/dev/null \
			| awk '{print $1}' \
			| grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' || true
	fi
	for env_file in /etc/qp-openvpn-server/*/server.env /etc/qp-wireguard/server/*/server.env; do
		[[ -f "$env_file" ]] || continue
		value=$(sed -n \
			-e "s/^QP_OPEN_SUBNET='\([^']*\)'$/\1/p" \
			-e "s/^QP_WG_SUBNET='\([^']*\)'$/\1/p" \
			"$env_file" | head -1)
		[[ -n "$value" ]] && echo "$value"
	done
}

qp_wg_subnet_conflict () {
	local subnet="$1" ignored_env="${2:-}" cidr env_file value
	while IFS= read -r cidr; do
		[[ -n "$cidr" ]] || continue
		qp_wg_validate_cidr "$cidr" >/dev/null 2>&1 || continue
		if qp_wg_cidrs_overlap "$subnet" "$cidr"; then
			echo "$cidr"
			return 0
		fi
	done < <(
		if qp_wg_have ip; then
			ip -4 route show table all 2>/dev/null \
				| awk '{print $1}' \
				| grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' || true
		fi
		for env_file in /etc/qp-openvpn-server/*/server.env /etc/qp-wireguard/server/*/server.env; do
			[[ -f "$env_file" && "$env_file" != "$ignored_env" ]] || continue
			value=$(sed -n \
				-e "s/^QP_OPEN_SUBNET='\([^']*\)'$/\1/p" \
				-e "s/^QP_WG_SUBNET='\([^']*\)'$/\1/p" \
				"$env_file" | head -1)
			[[ -n "$value" ]] && echo "$value"
		done
	)
	return 1
}

qp_wg_preflight_quiet () {
	local subnet="$1" ignored_env="${2:-}" conflict
	conflict=$(qp_wg_subnet_conflict "$subnet" "$ignored_env" || true)
	[[ -z "$conflict" ]]
}

qp_wg_preflight () {
	local subnet="$QP_WG_DEFAULT_SUBNET" conflict candidate validation=0
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--subnet) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --subnet."; subnet="$2"; shift 2 ;;
			--subnet=*) subnet="${1#--subnet=}"; shift ;;
			*) qp_wg_die "Unknown preflight option: $1" ;;
		esac
	done
	qp_wg_validate_subnet "$subnet" || validation=$?
	case "$validation" in
		0) ;;
		2) qp_wg_die "$subnet is public 100/8 space. Use RFC 6598 space no higher than 100.127.255.255." ;;
		*) qp_wg_die "Invalid --subnet value: $subnet. Use a canonical IPv4 /16 through /30." ;;
	esac
	qp_wg_info "Candidate WireGuard subnet: $subnet"
	conflict=$(qp_wg_subnet_conflict "$subnet" || true)
	if [[ -n "$conflict" ]]; then
		qp_wg_info "CONFLICT: $subnet overlaps $conflict"
		qp_wg_info "Recommended starting blocks to check:"
		for candidate in 100.127.50.0/24 100.127.100.0/24 100.127.101.0/24; do
			qp_wg_preflight_quiet "$candidate" && qp_wg_info "  - $candidate"
		done
		return 1
	fi
	qp_wg_info "OK: $subnet does not overlap active routes or managed OpenVPN/WireGuard subnets."
	qp_wg_info "Note: 100.128.0.0/16 is public address space and must not be used."
}

qp_wg_install_tools () {
	qp_wg_have wg && qp_wg_have wg-quick && qp_wg_have ip && return 0
	if qp_wg_have apt-get; then
		apt-get update
		DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools iptables iproute2
	elif qp_wg_have dnf; then
		dnf install -y wireguard-tools iptables iproute
	elif qp_wg_have yum; then
		yum install -y epel-release
		yum install -y wireguard-tools iptables iproute
	else
		qp_wg_die "Could not install WireGuard tools on this distribution."
	fi
	qp_wg_have wg && qp_wg_have wg-quick && qp_wg_have ip \
		|| qp_wg_die "WireGuard or IP routing tools are still unavailable after installation."
}

qp_wg_install_dns_helper () {
	qp_wg_have resolvconf && return 0
	if qp_wg_have apt-get; then
		apt-get update
		DEBIAN_FRONTEND=noninteractive apt-get install -y resolvconf
	elif qp_wg_have dnf; then
		dnf install -y openresolv
	elif qp_wg_have yum; then
		yum install -y epel-release
		yum install -y openresolv
	else
		qp_wg_die "The DNS setting requires resolvconf on this distribution."
	fi
	qp_wg_have resolvconf || qp_wg_die "resolvconf is required to apply the WireGuard DNS setting."
}

qp_wg_wan_interface () {
	ip -4 route get 1.1.1.1 2>/dev/null \
		| awk '{for (i=1; i<=NF; i++) if ($i == "dev") {print $(i+1); exit}}'
}

qp_wg_firewall_mode () {
	if qp_wg_have firewall-cmd && systemctl is-active --quiet firewalld.service; then
		echo firewalld
	else
		qp_wg_have iptables || qp_wg_die "iptables is required when firewalld is not active."
		echo iptables
	fi
}

qp_wg_port_in_use () {
	local port="$1"
	qp_wg_have ss && ss -H -lun 2>/dev/null | awk '{print $5}' | grep -qE "(^|:)$port$"
}

qp_wg_choose_port () {
	local range="$1" current="${2:-}" start end port count
	qp_wg_validate_port_range "$range" || qp_wg_die "Invalid port range: $range"
	start="${range%-*}"
	end="${range#*-}"
	port="$start"
	if [[ -n "$current" && "$current" -ge "$start" && "$current" -le "$end" ]]; then
		port=$(( current + 1 ))
		[[ "$port" -le "$end" ]] || port="$start"
	fi
	count=$(( end - start + 1 ))
	while [[ "$count" -gt 0 ]]; do
		if [[ "$port" != "$current" ]] && ! qp_wg_port_in_use "$port"; then
			echo "$port"
			return 0
		fi
		port=$(( port + 1 ))
		[[ "$port" -le "$end" ]] || port="$start"
		count=$(( count - 1 ))
	done
	qp_wg_die "No free UDP port is available in $range."
}

qp_wg_next_port () {
	local current="$1" range="${2:-}" next
	if [[ -n "$range" ]]; then
		qp_wg_choose_port "$range" "$current"
		return
	fi
	[[ "$current" -lt 65535 ]] \
		|| qp_wg_die "UDP $current cannot be incremented. Pass --port with the next desired port."
	next=$(( current + 1 ))
	qp_wg_port_in_use "$next" && qp_wg_die "UDP port $next is already in use. Pass --port with another port."
	echo "$next"
}

qp_wg_save_server_env () {
	local tmp
	tmp=$(mktemp "$QP_WG_SERVER_HOME/.server.env.XXXXXX")
	cat > "$tmp" <<EOF
# Generated by qp-tunnel-cli wg install. Do not edit by hand.
QP_WG_SUBNET='$QP_WG_SUBNET'
QP_WG_HOST='$QP_WG_HOST'
QP_WG_PORT='$QP_WG_PORT'
QP_WG_PORT_RANGE='$QP_WG_PORT_RANGE'
QP_WG_FIREWALL='$QP_WG_FIREWALL'
QP_WG_WAN_IF='$QP_WG_WAN_IF'
QP_WG_DNS='$QP_WG_DNS'
EOF
	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_WG_SERVER_ENV"
}

qp_wg_load_server_env () {
	[[ -f "$QP_WG_SERVER_ENV" ]] || qp_wg_die "Server instance '$QP_WG_INSTANCE' is not installed."
	# shellcheck disable=SC1090
	source "$QP_WG_SERVER_ENV"
	QP_WG_WAN_IF="${QP_WG_WAN_IF:-$(qp_wg_wan_interface)}"
	[[ -n "$QP_WG_WAN_IF" ]] || qp_wg_die "Could not determine the outbound interface."
	QP_WG_DNS="${QP_WG_DNS:-$QP_WG_DEFAULT_DNS}"
	qp_wg_validate_dns "$QP_WG_DNS" || qp_wg_die "Server state carries an invalid DNS list: $QP_WG_DNS"
}

qp_wg_server_gateway () {
	local start end
	read -r start end <<< "$(qp_wg_cidr_range "$QP_WG_SUBNET")"
	qp_wg_int_to_ip $(( start + 1 ))
}

qp_wg_write_server_config () {
	local private_key="$1" gateway prefix tmp
	gateway=$(qp_wg_server_gateway)
	prefix="${QP_WG_SUBNET#*/}"
	tmp=$(mktemp "/etc/wireguard/.$QP_WG_SERVER_DEV.conf.XXXXXX")
	cat > "$tmp" <<EOF
# Managed by qp-tunnel-cli wg. Instance: $QP_WG_INSTANCE
[Interface]
Address = $gateway/$prefix
PrivateKey = $private_key
ListenPort = $QP_WG_PORT
EOF
	if [[ "$QP_WG_FIREWALL" == firewalld ]]; then
		cat >> "$tmp" <<EOF
PostUp = firewall-cmd --add-port=$QP_WG_PORT/udp; firewall-cmd --direct --add-rule ipv4 filter FORWARD 0 -i $QP_WG_SERVER_DEV -j ACCEPT; firewall-cmd --direct --add-rule ipv4 filter FORWARD 0 -o $QP_WG_SERVER_DEV -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; firewall-cmd --direct --add-rule ipv4 nat POSTROUTING 0 -s $QP_WG_SUBNET -o $QP_WG_WAN_IF -j MASQUERADE
PostDown = firewall-cmd --remove-port=$QP_WG_PORT/udp || true; firewall-cmd --direct --remove-rule ipv4 filter FORWARD 0 -i $QP_WG_SERVER_DEV -j ACCEPT || true; firewall-cmd --direct --remove-rule ipv4 filter FORWARD 0 -o $QP_WG_SERVER_DEV -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT || true; firewall-cmd --direct --remove-rule ipv4 nat POSTROUTING 0 -s $QP_WG_SUBNET -o $QP_WG_WAN_IF -j MASQUERADE || true
EOF
	else
		cat >> "$tmp" <<EOF
PostUp = iptables -C INPUT -p udp --dport $QP_WG_PORT -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT || iptables -I INPUT -p udp --dport $QP_WG_PORT -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT; iptables -C FORWARD -i $QP_WG_SERVER_DEV -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT || iptables -I FORWARD -i $QP_WG_SERVER_DEV -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT; iptables -C FORWARD -o $QP_WG_SERVER_DEV -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT || iptables -I FORWARD -o $QP_WG_SERVER_DEV -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT; iptables -t nat -C POSTROUTING -s $QP_WG_SUBNET -o $QP_WG_WAN_IF -m comment --comment qp-wg-$QP_WG_INSTANCE -j MASQUERADE || iptables -t nat -A POSTROUTING -s $QP_WG_SUBNET -o $QP_WG_WAN_IF -m comment --comment qp-wg-$QP_WG_INSTANCE -j MASQUERADE
PostDown = iptables -D INPUT -p udp --dport $QP_WG_PORT -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT || true; iptables -D FORWARD -i $QP_WG_SERVER_DEV -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT || true; iptables -D FORWARD -o $QP_WG_SERVER_DEV -m conntrack --ctstate RELATED,ESTABLISHED -m comment --comment qp-wg-$QP_WG_INSTANCE -j ACCEPT || true; iptables -t nat -D POSTROUTING -s $QP_WG_SUBNET -o $QP_WG_WAN_IF -m comment --comment qp-wg-$QP_WG_INSTANCE -j MASQUERADE || true
EOF
	fi
	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_WG_SERVER_CONFIG"
}

qp_wg_install_server () {
	local subnet="$QP_WG_DEFAULT_SUBNET" dns="$QP_WG_DEFAULT_DNS" host="" port="" port_range="" private_key conflict validation=0
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--subnet) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --subnet."; subnet="$2"; shift 2 ;;
			--subnet=*) subnet="${1#--subnet=}"; shift ;;
			--host) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --host."; host="$2"; shift 2 ;;
			--host=*) host="${1#--host=}"; shift ;;
			--dns) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --dns."; dns="$2"; shift 2 ;;
			--dns=*) dns="${1#--dns=}"; shift ;;
			--port) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --port."; port="$2"; shift 2 ;;
			--port=*) port="${1#--port=}"; shift ;;
			--port-range) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --port-range."; port_range="$2"; shift 2 ;;
			--port-range=*) port_range="${1#--port-range=}"; shift ;;
			*) qp_wg_die "Unknown install option: $1" ;;
		esac
	done
	qp_wg_require_linux
	qp_wg_require_root
	[[ ! -e "$QP_WG_SERVER_ENV" && ! -e "$QP_WG_SERVER_CONFIG" ]] \
		|| qp_wg_die "Server instance '$QP_WG_INSTANCE' already exists. Use rotate-port or choose another --instance."
	qp_wg_validate_subnet "$subnet" || validation=$?
	case "$validation" in
		0) ;;
		2) qp_wg_die "$subnet is public address space. Use 100.127.50.0/24 or another private block." ;;
		*) qp_wg_die "Invalid --subnet value: $subnet. Use a canonical IPv4 /16 through /30." ;;
	esac
	conflict=$(qp_wg_subnet_conflict "$subnet" || true)
	[[ -z "$conflict" ]] || qp_wg_die "$subnet overlaps existing network $conflict. Run 'qp-tunnel-cli wg preflight --subnet $subnet'."
	if [[ -n "$port_range" ]]; then
		qp_wg_validate_port_range "$port_range" || qp_wg_die "--port-range must look like 20000-20100."
	fi
	if [[ -n "$port" ]]; then
		qp_wg_validate_port "$port" || qp_wg_die "Invalid --port value: $port"
		if [[ -n "$port_range" ]]; then
			[[ "$port" -ge "${port_range%-*}" && "$port" -le "${port_range#*-}" ]] \
				|| qp_wg_die "--port $port is outside --port-range $port_range."
		fi
	elif [[ -n "$port_range" ]]; then
		port=$(qp_wg_choose_port "$port_range")
	else
		port=51820
	fi
	qp_wg_port_in_use "$port" && qp_wg_die "UDP port $port is already in use. Pass --port or --port-range."
	[[ -n "$host" ]] || host=$(qp_wg_detect_public_ipv4 || true)
	[[ -n "$host" ]] || qp_wg_die "Could not detect a public endpoint. On AWS pass the Elastic IP with --host <EIP>."
	qp_wg_validate_endpoint "$host" || qp_wg_die "Invalid --host endpoint: $host"
	qp_wg_validate_dns "$dns" || qp_wg_die "--dns must be a comma-separated list of IPv4 DNS servers."
	qp_wg_install_tools
	mkdir -p /etc/wireguard "$QP_WG_SERVER_HOME" "$QP_WG_SERVER_CLIENTS"
	chmod 0700 /etc/wireguard "$QP_WG_SERVER_HOME" "$QP_WG_SERVER_CLIENTS"
	QP_WG_SUBNET="$subnet"
	QP_WG_HOST="$host"
	QP_WG_PORT="$port"
	QP_WG_PORT_RANGE="$port_range"
	QP_WG_DNS="$dns"
	QP_WG_FIREWALL=$(qp_wg_firewall_mode)
	QP_WG_WAN_IF=$(qp_wg_wan_interface)
	[[ -n "$QP_WG_WAN_IF" ]] || qp_wg_die "Could not determine the outbound interface."
	printf 'net.ipv4.ip_forward=1\n' > "$QP_WG_SYSCTL"
	sysctl -w net.ipv4.ip_forward=1 >/dev/null
	private_key=$(wg genkey)
	qp_wg_write_server_config "$private_key"
	qp_wg_save_server_env
	systemctl enable --now "$QP_WG_SERVER_UNIT"
	qp_wg_info "WireGuard server '$QP_WG_INSTANCE' is ready."
	qp_wg_info "Subnet : $QP_WG_SUBNET (server $(qp_wg_server_gateway))"
	qp_wg_info "Endpoint: $QP_WG_HOST:$QP_WG_PORT/udp"
	qp_wg_info "DNS     : $QP_WG_DNS"
	qp_wg_info "Egress  : full IPv4 via $QP_WG_WAN_IF"
	if [[ -n "$QP_WG_PORT_RANGE" ]]; then
		qp_wg_info "AWS security group: allow UDP $QP_WG_PORT_RANGE before rotating ports."
	else
		qp_wg_info "AWS security group: allow UDP $QP_WG_PORT."
	fi
	qp_wg_info "Create a profile with: qp-tunnel-cli wg create <name>"
}

qp_wg_next_client_ip () {
	local start end value candidate
	read -r start end <<< "$(qp_wg_cidr_range "$QP_WG_SUBNET")"
	value=$(( start + 2 ))
	while [[ "$value" -lt "$end" ]]; do
		candidate=$(qp_wg_int_to_ip "$value")
		if ! grep -qE "^AllowedIPs = $candidate/32$" "$QP_WG_SERVER_CONFIG"; then
			echo "$candidate"
			return 0
		fi
		value=$(( value + 1 ))
	done
	qp_wg_die "No free client address remains in $QP_WG_SUBNET."
}

qp_wg_create_client () {
	local name="${1:-}" client_ip="" output="" dns="" private_key public_key psk server_public profile tmp_psk prefix
	local start end client_value
	[[ -n "$name" ]] || qp_wg_die "Usage: qp-tunnel-cli wg create <name> [--ip ADDRESS] [--output FILE]"
	shift
	[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$ ]] || qp_wg_die "Client name may contain letters, digits, _ and - (32 characters max)."
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--ip) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --ip."; client_ip="$2"; shift 2 ;;
			--ip=*) client_ip="${1#--ip=}"; shift ;;
			--output) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --output."; output="$2"; shift 2 ;;
			--output=*) output="${1#--output=}"; shift ;;
			--dns) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --dns."; dns="$2"; shift 2 ;;
			--dns=*) dns="${1#--dns=}"; shift ;;
			*) qp_wg_die "Unknown create option: $1" ;;
		esac
	done
	qp_wg_require_root
	qp_wg_load_server_env
	[[ -n "$dns" ]] || dns="$QP_WG_DNS"
	qp_wg_validate_dns "$dns" || qp_wg_die "--dns must be a comma-separated list of IPv4 DNS servers."
	[[ ! -e "$QP_WG_SERVER_CLIENTS/$name.conf" ]] || qp_wg_die "Client '$name' already exists."
	[[ -n "$client_ip" ]] || client_ip=$(qp_wg_next_client_ip)
	qp_wg_validate_ipv4 "$client_ip" || qp_wg_die "Invalid --ip value: $client_ip"
	qp_wg_cidrs_overlap "$client_ip/32" "$QP_WG_SUBNET" || qp_wg_die "$client_ip is outside $QP_WG_SUBNET."
	read -r start end <<< "$(qp_wg_cidr_range "$QP_WG_SUBNET")"
	client_value=$(qp_wg_ip_to_int "$client_ip")
	[[ "$client_value" -gt $(( start + 1 )) && "$client_value" -lt "$end" ]] \
		|| qp_wg_die "$client_ip is reserved by the subnet, server or broadcast address."
	grep -qE "^AllowedIPs = $client_ip/32$" "$QP_WG_SERVER_CONFIG" \
		&& qp_wg_die "$client_ip is already assigned."
	private_key=$(wg genkey)
	public_key=$(wg pubkey <<< "$private_key")
	psk=$(wg genpsk)
	server_public=$(grep -m1 '^PrivateKey = ' "$QP_WG_SERVER_CONFIG" | cut -d ' ' -f 3 | wg pubkey)
	cat >> "$QP_WG_SERVER_CONFIG" <<EOF

# BEGIN_QP_WG_PEER $name
[Peer]
PublicKey = $public_key
PresharedKey = $psk
AllowedIPs = $client_ip/32
# END_QP_WG_PEER $name
EOF
	prefix="${QP_WG_SUBNET#*/}"
	profile="$QP_WG_SERVER_CLIENTS/$name.conf"
	cat > "$profile" <<EOF
# qp-wg-profile-version: 1
# qp-wg-instance: $QP_WG_INSTANCE
# qp-wg-server-host: $QP_WG_HOST
# qp-wg-subnet: $QP_WG_SUBNET
# qp-wg-client-ip: $client_ip
# qp-wg-client-name: $name

[Interface]
Address = $client_ip/$prefix
PrivateKey = $private_key
DNS = $dns

[Peer]
PublicKey = $server_public
PresharedKey = $psk
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = $QP_WG_HOST:$QP_WG_PORT
PersistentKeepalive = 25
EOF
	chmod 0600 "$profile" "$QP_WG_SERVER_CONFIG"
	if wg show "$QP_WG_SERVER_DEV" >/dev/null 2>&1; then
		tmp_psk=$(mktemp "$QP_WG_SERVER_HOME/.psk.XXXXXX")
		chmod 0600 "$tmp_psk"
		printf '%s\n' "$psk" > "$tmp_psk"
		wg set "$QP_WG_SERVER_DEV" peer "$public_key" preshared-key "$tmp_psk" allowed-ips "$client_ip/32"
		rm -f "$tmp_psk"
	fi
	[[ -n "$output" ]] || output="$PWD/$name.conf"
	cp "$profile" "$output"
	chmod 0600 "$output"
	qp_wg_info "Created $name at $client_ip."
	qp_wg_info "Profile: $output"
	qp_wg_info "Enroll the spoke with: sudo qp-tunnel-cli wg enroll --file '$output'"
}

qp_wg_profile_meta () {
	local profile="$1" field="$2"
	sed -n "s/^# qp-wg-$field: //p" "$profile" | head -1
}

qp_wg_enroll_client () {
	local profile="" force=false no_start=false profile_instance subnet client_ip host port tmp prefix
	local address private_key dns server_public psk allowed_ips keepalive
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--file) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --file."; profile="$2"; shift 2 ;;
			--file=*) profile="${1#--file=}"; shift ;;
			--force) force=true; shift ;;
			--no-start) no_start=true; shift ;;
			*) qp_wg_die "Unknown enroll option: $1" ;;
		esac
	done
	qp_wg_require_linux
	qp_wg_require_root
	[[ -r "$profile" ]] || qp_wg_die "WireGuard profile is not readable: $profile"
	grep -q '^# qp-wg-profile-version: 1$' "$profile" || qp_wg_die "Profile was not issued by qp-tunnel-cli wg."
	grep -q '^\[Interface\]$' "$profile" || qp_wg_die "Profile has no [Interface] block."
	grep -q '^\[Peer\]$' "$profile" || qp_wg_die "Profile has no [Peer] block."
	profile_instance=$(qp_wg_profile_meta "$profile" instance)
	if [[ "${QP_WG_INSTANCE_EXPLICIT:-false}" != true && -n "$profile_instance" ]]; then
		QP_WG_INSTANCE="$profile_instance"
		qp_wg_set_paths
	elif [[ -n "$profile_instance" && "$profile_instance" != "$QP_WG_INSTANCE" ]]; then
		qp_wg_die "Profile belongs to instance '$profile_instance'; pass --instance $profile_instance or omit --instance."
	fi
	subnet=$(qp_wg_profile_meta "$profile" subnet)
	client_ip=$(qp_wg_profile_meta "$profile" client-ip)
	host=$(qp_wg_profile_meta "$profile" server-host)
	qp_wg_validate_subnet "$subnet" >/dev/null || qp_wg_die "Profile carries an invalid subnet: $subnet"
	qp_wg_validate_ipv4 "$client_ip" || qp_wg_die "Profile carries an invalid client address: $client_ip"
	qp_wg_validate_endpoint "$host" || qp_wg_die "Profile carries an invalid server endpoint: $host"
	port=$(sed -n 's/^Endpoint = .*:\([0-9][0-9]*\)$/\1/p' "$profile" | head -1)
	qp_wg_validate_port "$port" || qp_wg_die "Profile carries an invalid Endpoint port."
	prefix="${subnet#*/}"
	address=$(grep -m1 '^Address = ' "$profile" | cut -d ' ' -f 3)
	private_key=$(grep -m1 '^PrivateKey = ' "$profile" | cut -d ' ' -f 3)
	dns=$(grep -m1 '^DNS = ' "$profile" | cut -d ' ' -f 3- || true)
	[[ -n "$dns" ]] || dns="$QP_WG_DEFAULT_DNS"
	server_public=$(grep -m1 '^PublicKey = ' "$profile" | cut -d ' ' -f 3)
	psk=$(grep -m1 '^PresharedKey = ' "$profile" | cut -d ' ' -f 3)
	allowed_ips=$(grep -m1 '^AllowedIPs = ' "$profile" | cut -d ' ' -f 3-)
	keepalive=$(grep -m1 '^PersistentKeepalive = ' "$profile" | cut -d ' ' -f 3)
	[[ "$address" == "$client_ip/$prefix" ]] || qp_wg_die "Profile Address does not match its client metadata."
	[[ "$private_key" =~ ^[A-Za-z0-9+/]{43}=$ ]] || qp_wg_die "Profile carries an invalid private key."
	qp_wg_validate_dns "$dns" || qp_wg_die "Profile carries an invalid DNS list."
	[[ "$server_public" =~ ^[A-Za-z0-9+/]{43}=$ ]] || qp_wg_die "Profile carries an invalid server public key."
	[[ "$psk" =~ ^[A-Za-z0-9+/]{43}=$ ]] || qp_wg_die "Profile carries an invalid preshared key."
	case "$allowed_ips" in
		"0.0.0.0/0") allowed_ips="0.0.0.0/0, ::/0" ;;
		"0.0.0.0/0, ::/0") ;;
		*) qp_wg_die "Profile must route IPv4 and block untunneled IPv6 through WireGuard." ;;
	esac
	[[ "$keepalive" == 25 ]] || qp_wg_die "Profile PersistentKeepalive must be 25."
	if [[ -e "$QP_WG_CLIENT_CONFIG" && "$force" != true ]]; then
		qp_wg_die "Client instance '$QP_WG_INSTANCE' already exists. Pass --force to replace its profile."
	fi
	if ! qp_wg_preflight_quiet "$subnet"; then
		if [[ "$force" == true ]]; then
			qp_wg_warn "$subnet overlaps an existing route; continuing because --force was given."
		else
			qp_wg_die "$subnet overlaps an existing route or managed tunnel. Choose another server subnet or pass --force after checking it."
		fi
	fi
	qp_wg_install_tools
	qp_wg_install_dns_helper
	if [[ -e "$QP_WG_CLIENT_CONFIG" ]]; then
		systemctl disable --now "$QP_WG_CLIENT_UNIT" >/dev/null 2>&1 || true
	fi
	mkdir -p /etc/wireguard "$QP_WG_CLIENT_HOME"
	chmod 0700 /etc/wireguard "$QP_WG_CLIENT_HOME"
	tmp=$(mktemp "/etc/wireguard/.$QP_WG_CLIENT_DEV.conf.XXXXXX")
	cat > "$tmp" <<EOF
# Managed by qp-tunnel-cli wg enroll. Instance: $QP_WG_INSTANCE
[Interface]
Address = $address
PrivateKey = $private_key
DNS = $dns

[Peer]
PublicKey = $server_public
PresharedKey = $psk
AllowedIPs = $allowed_ips
Endpoint = $host:$port
PersistentKeepalive = 25
EOF
	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_WG_CLIENT_CONFIG"
	cat > "$QP_WG_CLIENT_ENV" <<EOF
# Generated by qp-tunnel-cli wg enroll. Do not edit by hand.
QP_WG_SUBNET='$subnet'
QP_WG_CLIENT_IP='$client_ip'
QP_WG_HOST='$host'
QP_WG_PORT='$port'
QP_WG_DNS='$dns'
EOF
	chmod 0600 "$QP_WG_CLIENT_ENV"
	if [[ "$no_start" != true ]]; then
		systemctl enable --now "$QP_WG_CLIENT_UNIT"
	fi
	qp_wg_info "Enrolled WireGuard client '$QP_WG_INSTANCE' at $client_ip."
	qp_wg_info "All IPv4 traffic and DNS use WireGuard; ::/0 prevents native IPv6 bypass."
}

qp_wg_replace_port_in_file () {
	local file="$1" old_port="$2" new_port="$3" tmp
	[[ -f "$file" ]] || return 0
	tmp=$(mktemp "${file}.XXXXXX")
	sed \
		-e "s/^ListenPort = $old_port$/ListenPort = $new_port/" \
		-e "s/--add-port=$old_port\/udp/--add-port=$new_port\/udp/g" \
		-e "s/--remove-port=$old_port\/udp/--remove-port=$new_port\/udp/g" \
		-e "s/--dport $old_port /--dport $new_port /g" \
		-e "s/^Endpoint = \(.*\):$old_port$/Endpoint = \1:$new_port/" \
		"$file" > "$tmp"
	chmod --reference="$file" "$tmp"
	mv -f "$tmp" "$file"
}

qp_wg_rotate_port () {
	local new_port="" new_range="" old_port profile active=false
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--port) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --port."; new_port="$2"; shift 2 ;;
			--port=*) new_port="${1#--port=}"; shift ;;
			--port-range) [[ $# -ge 2 ]] || qp_wg_die "Missing value for --port-range."; new_range="$2"; shift 2 ;;
			--port-range=*) new_range="${1#--port-range=}"; shift ;;
			*) qp_wg_die "Unknown rotate-port option: $1" ;;
		esac
	done
	qp_wg_require_root
	qp_wg_load_server_env
	old_port="$QP_WG_PORT"
	if [[ -n "$new_range" ]]; then
		qp_wg_validate_port_range "$new_range" || qp_wg_die "--port-range must look like 20000-20100."
		QP_WG_PORT_RANGE="$new_range"
	fi
	if [[ -n "$new_port" ]]; then
		qp_wg_validate_port "$new_port" || qp_wg_die "Invalid --port value: $new_port"
	else
		new_port=$(qp_wg_next_port "$old_port" "$QP_WG_PORT_RANGE")
	fi
	if [[ -n "$QP_WG_PORT_RANGE" ]]; then
		[[ "$new_port" -ge "${QP_WG_PORT_RANGE%-*}" && "$new_port" -le "${QP_WG_PORT_RANGE#*-}" ]] \
			|| qp_wg_die "Port $new_port is outside rotation range $QP_WG_PORT_RANGE."
	fi
	[[ "$new_port" != "$old_port" ]] || qp_wg_die "WireGuard already listens on UDP $old_port."
	wg show "$QP_WG_SERVER_DEV" >/dev/null 2>&1 && active=true
	if [[ "$active" == true ]]; then
		if [[ "$QP_WG_FIREWALL" == firewalld ]]; then
			firewall-cmd --add-port="$new_port"/udp
			wg set "$QP_WG_SERVER_DEV" listen-port "$new_port"
			firewall-cmd --remove-port="$old_port"/udp
		else
			iptables -C INPUT -p udp --dport "$new_port" -m comment --comment "qp-wg-$QP_WG_INSTANCE" -j ACCEPT 2>/dev/null \
				|| iptables -I INPUT -p udp --dport "$new_port" -m comment --comment "qp-wg-$QP_WG_INSTANCE" -j ACCEPT
			wg set "$QP_WG_SERVER_DEV" listen-port "$new_port"
			iptables -D INPUT -p udp --dport "$old_port" -m comment --comment "qp-wg-$QP_WG_INSTANCE" -j ACCEPT 2>/dev/null || true
		fi
	fi
	qp_wg_replace_port_in_file "$QP_WG_SERVER_CONFIG" "$old_port" "$new_port"
	for profile in "$QP_WG_SERVER_CLIENTS"/*.conf; do
		[[ -f "$profile" ]] || continue
		qp_wg_replace_port_in_file "$profile" "$old_port" "$new_port"
	done
	QP_WG_PORT="$new_port"
	qp_wg_save_server_env
	qp_wg_info "Rotated '$QP_WG_INSTANCE' from UDP $old_port to UDP $new_port."
	qp_wg_info "WireGuard keys were not changed."
	[[ -n "$QP_WG_PORT_RANGE" ]] && qp_wg_info "AWS security group must allow UDP $QP_WG_PORT_RANGE."
	qp_wg_info "Clients must update their Endpoint port and restart, or re-enroll an updated profile from $QP_WG_SERVER_CLIENTS."
}

qp_wg_list_clients () {
	local profile name ip endpoint
	qp_wg_load_server_env
	printf '%-24s %-16s %s\n' NAME ADDRESS ENDPOINT
	for profile in "$QP_WG_SERVER_CLIENTS"/*.conf; do
		[[ -f "$profile" ]] || continue
		name=$(qp_wg_profile_meta "$profile" client-name)
		ip=$(qp_wg_profile_meta "$profile" client-ip)
		endpoint=$(grep -m1 '^Endpoint = ' "$profile" | cut -d ' ' -f 3)
		printf '%-24s %-16s %s\n' "$name" "$ip" "$endpoint"
	done
}

qp_wg_revoke_client () {
	local name="${1:-}" public_key
	[[ -n "$name" ]] || qp_wg_die "Usage: qp-tunnel-cli wg revoke <name>"
	qp_wg_require_root
	qp_wg_load_server_env
	[[ -f "$QP_WG_SERVER_CLIENTS/$name.conf" ]] || qp_wg_die "Unknown client: $name"
	public_key=$(sed -n "/^# BEGIN_QP_WG_PEER $name$/,/^# END_QP_WG_PEER $name$/p" "$QP_WG_SERVER_CONFIG" \
		| grep -m1 '^PublicKey = ' | cut -d ' ' -f 3)
	wg show "$QP_WG_SERVER_DEV" >/dev/null 2>&1 \
		&& wg set "$QP_WG_SERVER_DEV" peer "$public_key" remove || true
	sed -i "/^# BEGIN_QP_WG_PEER $name$/,/^# END_QP_WG_PEER $name$/d" "$QP_WG_SERVER_CONFIG"
	rm -f "$QP_WG_SERVER_CLIENTS/$name.conf"
	qp_wg_info "Revoked WireGuard client '$name'."
}

qp_wg_detect_role () {
	local explicit="${QP_WG_ROLE:-}"
	if [[ -n "$explicit" ]]; then echo "$explicit"; return; fi
	if [[ -f "$QP_WG_SERVER_ENV" && -f "$QP_WG_CLIENT_ENV" ]]; then
		qp_wg_die "Both roles exist for '$QP_WG_INSTANCE'; pass --server or --client."
	elif [[ -f "$QP_WG_SERVER_ENV" ]]; then echo server
	elif [[ -f "$QP_WG_CLIENT_ENV" ]]; then echo client
	else qp_wg_die "No managed WireGuard instance '$QP_WG_INSTANCE' is installed."
	fi
}

qp_wg_lifecycle () {
	local command="$1" role unit dev env_file
	shift
	role=$(qp_wg_detect_role)
	if [[ "$role" == server ]]; then
		unit="$QP_WG_SERVER_UNIT"; dev="$QP_WG_SERVER_DEV"; env_file="$QP_WG_SERVER_ENV"
	else
		unit="$QP_WG_CLIENT_UNIT"; dev="$QP_WG_CLIENT_DEV"; env_file="$QP_WG_CLIENT_ENV"
	fi
	case "$command" in
		up|start) qp_wg_require_root; systemctl enable --now "$unit" ;;
		down|stop) qp_wg_require_root; systemctl disable --now "$unit" ;;
		restart) qp_wg_require_root; systemctl restart "$unit" ;;
		status)
			qp_wg_info "Role     : $role"
			qp_wg_info "Instance : $QP_WG_INSTANCE"
			qp_wg_info "State    : $env_file"
			systemctl --no-pager --full status "$unit" || true
			wg show "$dev" 2>/dev/null || true
		;;
		logs) journalctl --no-pager -u "$unit" "$@" ;;
	esac
}

qp_wg_uninstall () {
	local role unit config home
	qp_wg_require_root
	role=$(qp_wg_detect_role)
	if [[ "$role" == server ]]; then
		unit="$QP_WG_SERVER_UNIT"; config="$QP_WG_SERVER_CONFIG"; home="$QP_WG_SERVER_HOME"
	else
		unit="$QP_WG_CLIENT_UNIT"; config="$QP_WG_CLIENT_CONFIG"; home="$QP_WG_CLIENT_HOME"
	fi
	systemctl disable --now "$unit" >/dev/null 2>&1 || true
	rm -f "$config"
	[[ "$role" != server ]] || rm -f "$QP_WG_SYSCTL"
	rm -rf "$home"
	qp_wg_info "Removed managed WireGuard $role instance '$QP_WG_INSTANCE'. WireGuard packages were retained."
}

qp_wg_help () {
	cat <<'EOF'
QPJoy managed WireGuard global VPN

Server:
  qp-tunnel-cli wg preflight --server [--subnet 100.127.50.0/24]
  qp-tunnel-cli wg install --host <AWS-EIP> [--subnet CIDR] [--dns DNS-LIST]
                           [--port PORT]
                           [--port-range 20000-20100] [--instance mx]
  qp-tunnel-cli wg create internal-01 [--ip 100.127.50.10] [--dns DNS-LIST]
  qp-tunnel-cli wg list | revoke internal-01
  qp-tunnel-cli wg rotate-port [--port PORT | --port-range 20000-20100]

Spoke:
  qp-tunnel-cli wg enroll --file internal-01.conf [--force]

Both:
  qp-tunnel-cli wg up | down | restart | status | logs | uninstall
  --server/--client selects the role when both exist on one host.

The default subnet is 100.127.50.0/24. 100.127.100.0/24 is another suggested
starting point. Do not use 100.128.0.0/16: it is public address space, outside
RFC 6598's 100.64.0.0/10 shared range.

Enrollment routes all IPv4 traffic and DNS through the WireGuard server.
AllowedIPs also contains ::/0 to prevent native IPv6 bypass; managed servers
currently provide IPv4 egress only, so IPv6 is blocked rather than forwarded.

Without a configured range, rotate-port increments the current UDP port by one.
With --port-range it selects the next free port in the range; --port selects an
exact port. Keys are never changed. Clients update Endpoint and restart, or
re-enroll an updated profile.
EOF
}

qp_wg_cli_main () {
	set -euo pipefail
	local command="${1:-help}" role="${QP_WG_ROLE:-}" instance_explicit=false
	local -a filtered=()
	[[ $# -gt 0 ]] && shift
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--instance)
				[[ $# -ge 2 ]] || qp_wg_die "Missing value for --instance."
				QP_WG_INSTANCE="$2"; instance_explicit=true; shift 2
			;;
			--instance=*) QP_WG_INSTANCE="${1#--instance=}"; instance_explicit=true; shift ;;
			--server) [[ -z "$role" || "$role" == server ]] || qp_wg_die "Pass either --server or --client."; role=server; shift ;;
			--client|--spoke) [[ -z "$role" || "$role" == client ]] || qp_wg_die "Pass either --server or --client."; role=client; shift ;;
			*) filtered+=("$1"); shift ;;
		esac
	done
	QP_WG_ROLE="$role"
	QP_WG_INSTANCE_EXPLICIT="$instance_explicit"
	qp_wg_set_paths
	case "$command" in
		help|--help|-h) qp_wg_help ;;
		preflight) [[ -z "$role" || "$role" == server ]] || qp_wg_die "wg preflight is a server command."; qp_wg_preflight "${filtered[@]}" ;;
		install) [[ -z "$role" || "$role" == server ]] || qp_wg_die "wg install is a server command."; qp_wg_install_server "${filtered[@]}" ;;
		create) [[ -z "$role" || "$role" == server ]] || qp_wg_die "wg create is a server command."; qp_wg_create_client "${filtered[@]}" ;;
		list) [[ -z "$role" || "$role" == server ]] || qp_wg_die "wg list is a server command."; qp_wg_list_clients ;;
		revoke) [[ -z "$role" || "$role" == server ]] || qp_wg_die "wg revoke is a server command."; qp_wg_revoke_client "${filtered[@]}" ;;
		rotate-port) [[ -z "$role" || "$role" == server ]] || qp_wg_die "wg rotate-port is a server command."; qp_wg_rotate_port "${filtered[@]}" ;;
		enroll) [[ -z "$role" || "$role" == client ]] || qp_wg_die "wg enroll is a spoke command."; qp_wg_enroll_client "${filtered[@]}" ;;
		up|start|down|stop|restart|status|logs) qp_wg_lifecycle "$command" "${filtered[@]}" ;;
		uninstall) qp_wg_uninstall ;;
		*) qp_wg_die "Unknown wg command: $command" ;;
	esac
}

if [[ "${QP_WG_LIBRARY_ONLY:-0}" == 1 ]]; then
	return 0 2>/dev/null || exit 0
fi

case "${1:-}" in
	help|--help|-h|preflight|install|create|list|revoke|rotate-port|enroll|up|start|down|stop|restart|status|logs|uninstall)
		qp_wg_cli_main "$@"
		exit $?
	;;
esac

mkdir -p /etc/wireguard/

# Detect Debian users running the script with "sh" instead of bash
if readlink /proc/$$/exe | grep -q "dash"; then
	echo 'This installer needs to be run with "bash", not "sh".'
	exit
fi

# Discard stdin. Needed when running from an one-liner which includes a newline
read -N 999999 -t 0.001

# Detect OpenVZ 6
if [[ $(uname -r | cut -d "." -f 1) -eq 2 ]]; then
	echo "The system is running an old kernel, which is incompatible with this installer."
	exit
fi

# Detect OS
# $os_version variables aren't always in use, but are kept here for convenience
if grep -qs "ubuntu" /etc/os-release; then
	os="ubuntu"
	os_version=$(grep 'VERSION_ID' /etc/os-release | cut -d '"' -f 2 | tr -d '.')
elif [[ -e /etc/debian_version ]]; then
	os="debian"
	os_version=$(grep -oE '[0-9]+' /etc/debian_version | head -1)
elif [[ -e /etc/almalinux-release || -e /etc/rocky-release || -e /etc/centos-release ]]; then
	os="centos"
	os_version=$(grep -shoE '[0-9]+' /etc/almalinux-release /etc/rocky-release /etc/centos-release | head -1)
elif [[ -e /etc/fedora-release ]]; then
	os="fedora"
	os_version=$(grep -oE '[0-9]+' /etc/fedora-release | head -1)
else
	echo "This installer seems to be running on an unsupported distribution.
Supported distros are Ubuntu, Debian, AlmaLinux, Rocky Linux, CentOS and Fedora."
	exit
fi

if [[ "$os" == "ubuntu" && "$os_version" -lt 1804 ]]; then
	echo "Ubuntu 18.04 or higher is required to use this installer.
This version of Ubuntu is too old and unsupported."
	exit
fi

if [[ "$os" == "debian" ]]; then
	if grep -q '/sid' /etc/debian_version; then
		echo "Debian Testing and Debian Unstable are unsupported by this installer."
		exit
	fi
	if [[ "$os_version" -lt 10 ]]; then
		echo "Debian 10 or higher is required to use this installer.
This version of Debian is too old and unsupported."
		exit
	fi
fi

if [[ "$os" == "centos" && "$os_version" -lt 7 ]]; then
	echo "CentOS 7 or higher is required to use this installer.
This version of CentOS is too old and unsupported."
	exit
fi

# Detect environments where $PATH does not include the sbin directories
if ! grep -q sbin <<< "$PATH"; then
	echo '$PATH does not include sbin. Try using "su -" instead of "su".'
	exit
fi

systemd-detect-virt -cq
is_container="$?"

if [[ "$os" == "fedora" && "$os_version" -eq 31 && $(uname -r | cut -d "." -f 2) -lt 6 && ! "$is_container" -eq 0 ]]; then
	echo 'Fedora 31 is supported, but the kernel is outdated.
Upgrade the kernel using "dnf upgrade kernel" and restart.'
	exit
fi

if [[ "$EUID" -ne 0 ]]; then
	echo "This installer needs to be run with superuser privileges."
	exit
fi

if [[ "$is_container" -eq 0 ]]; then
	if [ "$(uname -m)" != "x86_64" ]; then
		echo "In containerized systems, this installer supports only the x86_64 architecture.
The system runs on $(uname -m) and is unsupported."
		exit
	fi
	# TUN device is required to use BoringTun if running inside a container
	if [[ ! -e /dev/net/tun ]] || ! ( exec 7<>/dev/net/tun ) 2>/dev/null; then
		echo "The system does not have the TUN device available.
TUN needs to be enabled before running this installer."
		exit
	fi
fi

new_client_dns () {
	echo "Select a DNS server for the client:"
	echo "   1) Current system resolvers"
	echo "   2) Google"
	echo "   3) 1.1.1.1"
	echo "   4) OpenDNS"
	echo "   5) Quad9"
	echo "   6) AdGuard"
	read -p "DNS server [1]: " dns
	until [[ -z "$dns" || "$dns" =~ ^[1-6]$ ]]; do
		echo "$dns: invalid selection."
		read -p "DNS server [1]: " dns
	done
		# DNS
	case "$dns" in
		1|"")
			# Locate the proper resolv.conf
			# Needed for systems running systemd-resolved
			if grep '^nameserver' "/etc/resolv.conf" | grep -qv '127.0.0.53' ; then
				resolv_conf="/etc/resolv.conf"
			else
				resolv_conf="/run/systemd/resolve/resolv.conf"
			fi
			# Extract nameservers and provide them in the required format
			dns=$(grep -v '^#\|^;' "$resolv_conf" | grep '^nameserver' | grep -v '127.0.0.53' | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | xargs | sed -e 's/ /, /g')
		;;
		2)
			dns="8.8.8.8, 8.8.4.4"
		;;
		3)
			dns="1.1.1.1, 1.0.0.1"
		;;
		4)
			dns="208.67.222.222, 208.67.220.220"
		;;
		5)
			dns="9.9.9.9, 149.112.112.112"
		;;
		6)
			dns="94.140.14.14, 94.140.15.15"
		;;
	esac
}

new_client_setup () {
	# Given a list of the assigned internal IPv4 addresses, obtain the lowest still
	# available octet. Important to start looking at 2, because 1 is our gateway.
	octet=2
	while grep AllowedIPs /etc/wireguard/wg0.conf | cut -d "." -f 4 | cut -d "/" -f 1 | grep -q "$octet"; do
		(( octet++ ))
	done
	# Don't break the WireGuard configuration in case the address space is full
	if [[ "$octet" -eq 255 ]]; then
		echo "253 clients are already configured. The WireGuard internal subnet is full!"
		exit
	fi
	key=$(wg genkey)
	psk=$(wg genpsk)
	# Configure client in the server
	cat << EOF >> /etc/wireguard/wg0.conf
# BEGIN_PEER $client
[Peer]
PublicKey = $(wg pubkey <<< $key)
PresharedKey = $psk
AllowedIPs = $wg_network_prefix.$octet/32$(grep -q 'fddd:2c4:2c4:2c4::1' /etc/wireguard/wg0.conf && echo ", fddd:2c4:2c4:2c4::$octet/128")
# END_PEER $client
EOF
	# Create client configuration
	cat << EOF > ~/"$client".conf
[Interface]
Address = $wg_network_prefix.$octet/24$(grep -q 'fddd:2c4:2c4:2c4::1' /etc/wireguard/wg0.conf && echo ", fddd:2c4:2c4:2c4::$octet/64")
DNS = $dns
PrivateKey = $key

[Peer]
PublicKey = $(grep PrivateKey /etc/wireguard/wg0.conf | cut -d " " -f 3 | wg pubkey)
PresharedKey = $psk
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = $(grep '^# ENDPOINT' /etc/wireguard/wg0.conf | cut -d " " -f 3):$(grep ListenPort /etc/wireguard/wg0.conf | cut -d " " -f 3)
PersistentKeepalive = 25
EOF
}

get_public_ipv4 () {
	local aws_token detected_ip

	# AWS public IPv4 addresses are NAT mappings and do not appear on the instance
	# interface. Prefer IMDSv2 so EC2 instances with IMDSv1 disabled are supported.
	if command -v curl >/dev/null 2>&1; then
		aws_token=$(curl --noproxy '*' -m 2 -fsS -X PUT \
			-H 'X-aws-ec2-metadata-token-ttl-seconds: 60' \
			'http://169.254.169.254/latest/api/token' 2>/dev/null)
		if [[ -n "$aws_token" ]]; then
			detected_ip=$(curl --noproxy '*' -m 2 -fsS \
				-H "X-aws-ec2-metadata-token: $aws_token" \
				'http://169.254.169.254/latest/meta-data/public-ipv4' 2>/dev/null)
		fi
	fi

	if ! grep -qxE '[0-9]{1,3}(\.[0-9]{1,3}){3}' <<< "$detected_ip"; then
		detected_ip=$(wget -T 10 -t 1 -4qO- 'http://ip1.dynupdate.no-ip.com/' 2>/dev/null \
			|| curl -m 10 -4Ls 'http://ip1.dynupdate.no-ip.com/' 2>/dev/null)
	fi

	grep -m 1 -oE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' <<< "$detected_ip"
}

# New installs default away from the OpenVPN allocation at 100.127.0.0/24.
# Existing wg0 installations derive their original /24, so adding/removing
# clients remains backwards compatible with the historical 10.7.0.0/24 setup.
wg_subnet="$QP_WG_DEFAULT_SUBNET"
if [[ -e /etc/wireguard/wg0.conf ]]; then
	wg_server_cidr=$(grep -m1 '^Address = ' /etc/wireguard/wg0.conf | cut -d ' ' -f 3 | cut -d ',' -f 1)
	if [[ "$wg_server_cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/24$ ]]; then
		wg_subnet="$(qp_wg_cidr_network "$wg_server_cidr")/24"
	fi
fi
wg_network_prefix="${wg_subnet%.*}"

if [[ ! -e /etc/wireguard/wg0.conf ]]; then
	# Detect some Debian minimal setups where neither wget nor curl are installed
	if ! hash wget 2>/dev/null && ! hash curl 2>/dev/null; then
		echo "Wget is required to use this installer."
		read -n1 -r -p "Press any key to install Wget and continue..."
		apt-get update
		apt-get install -y wget
	fi
	clear
	echo 'Welcome to this WireGuard road warrior installer!'
	# If system has a single IPv4, it is selected automatically. Else, ask the user
	if [[ $(ip -4 addr | grep inet | grep -vEc '127(\.[0-9]{1,3}){3}') -eq 1 ]]; then
		ip=$(ip -4 addr | grep inet | grep -vE '127(\.[0-9]{1,3}){3}' | cut -d '/' -f 1 | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}')
	else
		number_of_ip=$(ip -4 addr | grep inet | grep -vEc '127(\.[0-9]{1,3}){3}')
		echo
		echo "Which local IPv4 address should be used for outbound traffic?"
		ip -4 addr | grep inet | grep -vE '127(\.[0-9]{1,3}){3}' | cut -d '/' -f 1 | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | nl -s ') '
		echo "Enter a selection number, or enter the fixed public endpoint directly (for example, an AWS Elastic IP)."
		while true; do
			read -p "Local IPv4 selection or public endpoint [1]: " ip_number
			if [[ -z "$ip_number" ]]; then
				ip_number="1"
				break
			elif [[ "$ip_number" =~ ^[0-9]+$ && "$ip_number" -ge 1 && "$ip_number" -le "$number_of_ip" ]]; then
				break
			elif qp_wg_validate_endpoint "$ip_number"; then
				public_ip="$ip_number"
				default_local_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')
				ip_number=$(ip -4 addr | grep inet | grep -vE '127(\.[0-9]{1,3}){3}' | cut -d '/' -f 1 \
					| grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | nl -ba \
					| awk -v wanted="$default_local_ip" '$2 == wanted {print $1; exit}')
				[[ -n "$ip_number" ]] || ip_number="1"
				echo "Using $public_ip as the client endpoint and local address $ip_number for outbound traffic."
				break
			else
				echo "$ip_number: invalid selection or endpoint."
			fi
		done
		ip=$(ip -4 addr | grep inet | grep -vE '127(\.[0-9]{1,3}){3}' | cut -d '/' -f 1 | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}' | sed -n "$ip_number"p)
	fi
	# If $ip is a private IP address, the server must be behind NAT
	if echo "$ip" | grep -qE '^(10\.|172\.1[6789]\.|172\.2[0-9]\.|172\.3[01]\.|192\.168)' && [[ -z "$public_ip" ]]; then
		echo
		echo "This server is behind NAT. What is the public IPv4 address or hostname?"
		# Detect AWS through IMDSv2 first, then fall back to an external check.
		get_public_ip=$(get_public_ipv4)
		read -p "Public IPv4 address / hostname [$get_public_ip]: " public_ip
		# If the checkip service is unavailable and user didn't provide input, ask again
		until [[ -n "$get_public_ip" || -n "$public_ip" ]]; do
			echo "Invalid input."
			read -p "Public IPv4 address / hostname: " public_ip
		done
		[[ -z "$public_ip" ]] && public_ip="$get_public_ip"
	fi
	# If system has a single IPv6, it is selected automatically
	if [[ $(ip -6 addr | grep -c 'inet6 [23]') -eq 1 ]]; then
		ip6=$(ip -6 addr | grep 'inet6 [23]' | cut -d '/' -f 1 | grep -oE '([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}')
	fi
	# If system has multiple IPv6, ask the user to select one
	if [[ $(ip -6 addr | grep -c 'inet6 [23]') -gt 1 ]]; then
		number_of_ip6=$(ip -6 addr | grep -c 'inet6 [23]')
		echo
		echo "Which IPv6 address should be used?"
		ip -6 addr | grep 'inet6 [23]' | cut -d '/' -f 1 | grep -oE '([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}' | nl -s ') '
		read -p "IPv6 address [1]: " ip6_number
		until [[ -z "$ip6_number" || "$ip6_number" =~ ^[0-9]+$ && "$ip6_number" -le "$number_of_ip6" ]]; do
			echo "$ip6_number: invalid selection."
			read -p "IPv6 address [1]: " ip6_number
		done
		[[ -z "$ip6_number" ]] && ip6_number="1"
		ip6=$(ip -6 addr | grep 'inet6 [23]' | cut -d '/' -f 1 | grep -oE '([0-9a-fA-F]{0,4}:){1,7}[0-9a-fA-F]{0,4}' | sed -n "$ip6_number"p)
	fi
	echo
	echo "What port should WireGuard listen to?"
	read -p "Port [51820]: " port
	until [[ -z "$port" || "$port" =~ ^[0-9]+$ && "$port" -le 65535 ]]; do
		echo "$port: invalid port."
		read -p "Port [51820]: " port
	done
	[[ -z "$port" ]] && port="51820"
	echo
	echo "What IPv4 /24 subnet should WireGuard use?"
	echo "Use a free block such as 100.127.50.0/24 or 100.127.100.0/24. Do not use 100.128.x.x (public space)."
	read -p "Subnet [$QP_WG_DEFAULT_SUBNET]: " requested_wg_subnet
	[[ -z "$requested_wg_subnet" ]] && requested_wg_subnet="$QP_WG_DEFAULT_SUBNET"
	while ! qp_wg_validate_subnet "$requested_wg_subnet" || [[ "${requested_wg_subnet#*/}" != 24 ]]; do
		echo "$requested_wg_subnet: invalid /24 tunnel subnet."
		read -p "Subnet [$QP_WG_DEFAULT_SUBNET]: " requested_wg_subnet
		[[ -z "$requested_wg_subnet" ]] && requested_wg_subnet="$QP_WG_DEFAULT_SUBNET"
	done
	wg_conflict=$(qp_wg_subnet_conflict "$requested_wg_subnet" || true)
	while [[ -n "$wg_conflict" ]]; do
		echo "$requested_wg_subnet overlaps existing network $wg_conflict. Choose another /24."
		read -p "Subnet [$QP_WG_DEFAULT_SUBNET]: " requested_wg_subnet
		[[ -z "$requested_wg_subnet" ]] && requested_wg_subnet="$QP_WG_DEFAULT_SUBNET"
		if qp_wg_validate_subnet "$requested_wg_subnet" && [[ "${requested_wg_subnet#*/}" == 24 ]]; then
			wg_conflict=$(qp_wg_subnet_conflict "$requested_wg_subnet" || true)
		else
			wg_conflict="invalid"
		fi
	done
	wg_subnet="$requested_wg_subnet"
	wg_network_prefix="${wg_subnet%.*}"
	echo
	echo "Enter a name for the first client:"
	read -p "Name [client]: " unsanitized_client
	# Allow a limited lenght and set of characters to avoid conflicts
	client=$(sed 's/[^0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-]/_/g' <<< "$unsanitized_client" | cut -c-15)
	[[ -z "$client" ]] && client="client"
	echo
	new_client_dns
	# Set up automatic updates for BoringTun if the user is fine with that
	if [[ "$is_container" -eq 0 ]]; then
		echo
		echo "BoringTun will be installed to set up WireGuard in the system."
		read -p "Should automatic updates be enabled for it? [Y/n]: " boringtun_updates
		until [[ "$boringtun_updates" =~ ^[yYnN]*$ ]]; do
			echo "$remove: invalid selection."
			read -p "Should automatic updates be enabled for it? [Y/n]: " boringtun_updates
		done
		[[ -z "$boringtun_updates" ]] && boringtun_updates="y"
		if [[ "$boringtun_updates" =~ ^[yY]$ ]]; then
			if [[ "$os" == "centos" || "$os" == "fedora" ]]; then
				cron="cronie"
			elif [[ "$os" == "debian" || "$os" == "ubuntu" ]]; then
				cron="cron"
			fi
		fi
	fi
	echo
	echo "WireGuard installation is ready to begin."
	# Install a firewall if firewalld or iptables are not already available
	if ! systemctl is-active --quiet firewalld.service && ! hash iptables 2>/dev/null; then
		if [[ "$os" == "centos" || "$os" == "fedora" ]]; then
			firewall="firewalld"
			# We don't want to silently enable firewalld, so we give a subtle warning
			# If the user continues, firewalld will be installed and enabled during setup
			echo "firewalld, which is required to manage routing tables, will also be installed."
		elif [[ "$os" == "debian" || "$os" == "ubuntu" ]]; then
			# iptables is way less invasive than firewalld so no warning is given
			firewall="iptables"
		fi
	fi
	read -n1 -r -p "Press any key to continue..."
	# Install WireGuard
	# If not running inside a container, set up the WireGuard kernel module
	if [[ ! "$is_container" -eq 0 ]]; then
		if [[ "$os" == "ubuntu" ]]; then
			# Ubuntu
			apt-get update
			apt-get install -y wireguard qrencode $firewall
		elif [[ "$os" == "debian" && "$os_version" -ge 11 ]]; then
			# Debian 11 or higher
			apt-get update
			apt-get install -y wireguard qrencode $firewall
		elif [[ "$os" == "debian" && "$os_version" -eq 10 ]]; then
			# Debian 10
			if ! grep -qs '^deb .* buster-backports main' /etc/apt/sources.list /etc/apt/sources.list.d/*.list; then
				echo "deb http://deb.debian.org/debian buster-backports main" >> /etc/apt/sources.list
			fi
			apt-get update
			# Try to install kernel headers for the running kernel and avoid a reboot. This
			# can fail, so it's important to run separately from the other apt-get command.
			apt-get install -y linux-headers-"$(uname -r)"
			# There are cleaner ways to find out the $architecture, but we require an
			# specific format for the package name and this approach provides what we need.
			architecture=$(dpkg --get-selections 'linux-image-*-*' | cut -f 1 | grep -oE '[^-]*$' -m 1)
			# linux-headers-$architecture points to the latest headers. We install it
			# because if the system has an outdated kernel, there is no guarantee that old
			# headers were still downloadable and to provide suitable headers for future
			# kernel updates.
			apt-get install -y linux-headers-"$architecture"
			apt-get install -y wireguard qrencode $firewall
		elif [[ "$os" == "centos" && "$os_version" -ge 9 ]]; then
			# CentOS 9 or higher
			dnf install -y epel-release
			dnf install -y wireguard-tools qrencode $firewall
		elif [[ "$os" == "centos" && "$os_version" -eq 8 ]]; then
			# CentOS 8
			dnf install -y epel-release elrepo-release
			dnf install -y kmod-wireguard wireguard-tools qrencode $firewall
			mkdir -p /etc/wireguard/
		elif [[ "$os" == "centos" && "$os_version" -eq 7 ]]; then
			# CentOS 7
			yum install -y epel-release https://www.elrepo.org/elrepo-release-7.el7.elrepo.noarch.rpm
			yum install -y yum-plugin-elrepo
			yum install -y kmod-wireguard wireguard-tools qrencode $firewall
			mkdir -p /etc/wireguard/
		elif [[ "$os" == "fedora" ]]; then
			# Fedora
			dnf install -y wireguard-tools qrencode $firewall
			mkdir -p /etc/wireguard/
		fi
	# Else, we are inside a container and BoringTun needs to be used
	else
		# Install required packages
		if [[ "$os" == "ubuntu" ]]; then
			# Ubuntu
			apt-get update
			apt-get install -y qrencode ca-certificates $cron $firewall
			apt-get install -y wireguard-tools --no-install-recommends
		elif [[ "$os" == "debian" && "$os_version" -ge 11 ]]; then
			# Debian 11 or higher
			apt-get update
			apt-get install -y qrencode ca-certificates $cron $firewall
			apt-get install -y wireguard-tools --no-install-recommends
		elif [[ "$os" == "debian" && "$os_version" -eq 10 ]]; then
			# Debian 10
			if ! grep -qs '^deb .* buster-backports main' /etc/apt/sources.list /etc/apt/sources.list.d/*.list; then
				echo "deb http://deb.debian.org/debian buster-backports main" >> /etc/apt/sources.list
			fi
			apt-get update
			apt-get install -y qrencode ca-certificates $cron $firewall
			apt-get install -y wireguard-tools --no-install-recommends
		elif [[ "$os" == "centos" && "$os_version" -ge 9 ]]; then
			# CentOS 9 or higher
			dnf install -y epel-release
			dnf install -y wireguard-tools qrencode ca-certificates tar $cron $firewall
		elif [[ "$os" == "centos" && "$os_version" -eq 8 ]]; then
			# CentOS 8
			dnf install -y epel-release
			dnf install -y wireguard-tools qrencode ca-certificates tar $cron $firewall
			mkdir -p /etc/wireguard/
		elif [[ "$os" == "centos" && "$os_version" -eq 7 ]]; then
			# CentOS 7
			yum install -y epel-release
			yum install -y wireguard-tools qrencode ca-certificates tar $cron $firewall
			mkdir -p /etc/wireguard/
		elif [[ "$os" == "fedora" ]]; then
			# Fedora
			dnf install -y wireguard-tools qrencode ca-certificates tar $cron $firewall
			mkdir -p /etc/wireguard/
		fi
		# Grab the BoringTun binary using wget or curl and extract into the right place.
		# Don't use this service elsewhere without permission! Contact me before you do!
		{ wget -qO- https://wg.nyr.be/1/latest/download 2>/dev/null || curl -sL https://wg.nyr.be/1/latest/download ; } | tar xz -C /usr/local/sbin/ --wildcards 'boringtun-*/boringtun' --strip-components 1
		# Configure wg-quick to use BoringTun
		mkdir /etc/systemd/system/wg-quick@wg0.service.d/ 2>/dev/null
		echo "[Service]
Environment=WG_QUICK_USERSPACE_IMPLEMENTATION=boringtun
Environment=WG_SUDO=1" > /etc/systemd/system/wg-quick@wg0.service.d/boringtun.conf
		if [[ -n "$cron" ]] && [[ "$os" == "centos" || "$os" == "fedora" ]]; then
			systemctl enable --now crond.service
		fi
	fi
	# If firewalld was just installed, enable it
	if [[ "$firewall" == "firewalld" ]]; then
		systemctl enable --now firewalld.service
	fi
	# Generate wg0.conf
	cat << EOF > /etc/wireguard/wg0.conf
# Do not alter the commented lines
# They are used by wireguard-install
# ENDPOINT $([[ -n "$public_ip" ]] && echo "$public_ip" || echo "$ip")

[Interface]
Address = $wg_network_prefix.1/24$([[ -n "$ip6" ]] && echo ", fddd:2c4:2c4:2c4::1/64")
PrivateKey = $(wg genkey)
ListenPort = $port

EOF
	chmod 600 /etc/wireguard/wg0.conf
	# Enable net.ipv4.ip_forward for the system
	echo 'net.ipv4.ip_forward=1' > /etc/sysctl.d/99-wireguard-forward.conf
	# Enable without waiting for a reboot or service restart
	echo 1 > /proc/sys/net/ipv4/ip_forward
	if [[ -n "$ip6" ]]; then
		# Enable net.ipv6.conf.all.forwarding for the system
		echo "net.ipv6.conf.all.forwarding=1" >> /etc/sysctl.d/99-wireguard-forward.conf
		# Enable without waiting for a reboot or service restart
		echo 1 > /proc/sys/net/ipv6/conf/all/forwarding
	fi
	if systemctl is-active --quiet firewalld.service; then
		# Using both permanent and not permanent rules to avoid a firewalld
		# reload.
		firewall-cmd --add-port="$port"/udp
		firewall-cmd --zone=trusted --add-source="$wg_subnet"
		firewall-cmd --permanent --add-port="$port"/udp
		firewall-cmd --permanent --zone=trusted --add-source="$wg_subnet"
		# Set NAT for the VPN subnet
		firewall-cmd --direct --add-rule ipv4 nat POSTROUTING 0 -s "$wg_subnet" ! -d "$wg_subnet" -j SNAT --to "$ip"
		firewall-cmd --permanent --direct --add-rule ipv4 nat POSTROUTING 0 -s "$wg_subnet" ! -d "$wg_subnet" -j SNAT --to "$ip"
		if [[ -n "$ip6" ]]; then
			firewall-cmd --zone=trusted --add-source=fddd:2c4:2c4:2c4::/64
			firewall-cmd --permanent --zone=trusted --add-source=fddd:2c4:2c4:2c4::/64
			firewall-cmd --direct --add-rule ipv6 nat POSTROUTING 0 -s fddd:2c4:2c4:2c4::/64 ! -d fddd:2c4:2c4:2c4::/64 -j SNAT --to "$ip6"
			firewall-cmd --permanent --direct --add-rule ipv6 nat POSTROUTING 0 -s fddd:2c4:2c4:2c4::/64 ! -d fddd:2c4:2c4:2c4::/64 -j SNAT --to "$ip6"
		fi
	else
		# Create a service to set up persistent iptables rules
		iptables_path=$(command -v iptables)
		ip6tables_path=$(command -v ip6tables)
		# nf_tables is not available as standard in OVZ kernels. So use iptables-legacy
		# if we are in OVZ, with a nf_tables backend and iptables-legacy is available.
		if [[ $(systemd-detect-virt) == "openvz" ]] && readlink -f "$(command -v iptables)" | grep -q "nft" && hash iptables-legacy 2>/dev/null; then
			iptables_path=$(command -v iptables-legacy)
			ip6tables_path=$(command -v ip6tables-legacy)
		fi
		echo "[Unit]
Before=network.target
[Service]
Type=oneshot
ExecStart=$iptables_path -t nat -A POSTROUTING -s $wg_subnet ! -d $wg_subnet -j SNAT --to $ip
ExecStart=$iptables_path -I INPUT -p udp --dport $port -j ACCEPT
ExecStart=$iptables_path -I FORWARD -s $wg_subnet -j ACCEPT
ExecStart=$iptables_path -I FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT
ExecStop=$iptables_path -t nat -D POSTROUTING -s $wg_subnet ! -d $wg_subnet -j SNAT --to $ip
ExecStop=$iptables_path -D INPUT -p udp --dport $port -j ACCEPT
ExecStop=$iptables_path -D FORWARD -s $wg_subnet -j ACCEPT
ExecStop=$iptables_path -D FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT" > /etc/systemd/system/wg-iptables.service
		if [[ -n "$ip6" ]]; then
			echo "ExecStart=$ip6tables_path -t nat -A POSTROUTING -s fddd:2c4:2c4:2c4::/64 ! -d fddd:2c4:2c4:2c4::/64 -j SNAT --to $ip6
ExecStart=$ip6tables_path -I FORWARD -s fddd:2c4:2c4:2c4::/64 -j ACCEPT
ExecStart=$ip6tables_path -I FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT
ExecStop=$ip6tables_path -t nat -D POSTROUTING -s fddd:2c4:2c4:2c4::/64 ! -d fddd:2c4:2c4:2c4::/64 -j SNAT --to $ip6
ExecStop=$ip6tables_path -D FORWARD -s fddd:2c4:2c4:2c4::/64 -j ACCEPT
ExecStop=$ip6tables_path -D FORWARD -m state --state RELATED,ESTABLISHED -j ACCEPT" >> /etc/systemd/system/wg-iptables.service
		fi
		echo "RemainAfterExit=yes
[Install]
WantedBy=multi-user.target" >> /etc/systemd/system/wg-iptables.service
		systemctl enable --now wg-iptables.service
	fi
	# Generates the custom client.conf
	new_client_setup
	# Enable and start the wg-quick service
	systemctl enable --now wg-quick@wg0.service
	# Set up automatic updates for BoringTun if the user wanted to
	if [[ "$boringtun_updates" =~ ^[yY]$ ]]; then
		# Deploy upgrade script
		cat << 'EOF' > /usr/local/sbin/boringtun-upgrade
#!/bin/bash
latest=$(wget -qO- https://wg.nyr.be/1/latest 2>/dev/null || curl -sL https://wg.nyr.be/1/latest 2>/dev/null)
# If server did not provide an appropriate response, exit
if ! head -1 <<< "$latest" | grep -qiE "^boringtun.+[0-9]+\.[0-9]+.*$"; then
	echo "Update server unavailable"
	exit
fi
current=$(/usr/local/sbin/boringtun -V)
if [[ "$current" != "$latest" ]]; then
	download="https://wg.nyr.be/1/latest/download"
	xdir=$(mktemp -d)
	# If download and extraction are successful, upgrade the boringtun binary
	if { wget -qO- "$download" 2>/dev/null || curl -sL "$download" ; } | tar xz -C "$xdir" --wildcards "boringtun-*/boringtun" --strip-components 1; then
		systemctl stop wg-quick@wg0.service
		rm -f /usr/local/sbin/boringtun
		mv "$xdir"/boringtun /usr/local/sbin/boringtun
		systemctl start wg-quick@wg0.service
		echo "Succesfully updated to $(/usr/local/sbin/boringtun -V)"
	else
		echo "boringtun update failed"
	fi
	rm -rf "$xdir"
else
	echo "$current is up to date"
fi
EOF
		chmod +x /usr/local/sbin/boringtun-upgrade
		# Add cron job to run the updater daily at a random time between 3:00 and 5:59
		{ crontab -l 2>/dev/null; echo "$(( $RANDOM % 60 )) $(( $RANDOM % 3 + 3 )) * * * /usr/local/sbin/boringtun-upgrade &>/dev/null" ; } | crontab -
	fi
	echo
	qrencode -t UTF8 < ~/"$client.conf"
	echo -e '\xE2\x86\x91 That is a QR code containing the client configuration.'
	echo
	# If the kernel module didn't load, system probably had an outdated kernel
	# We'll try to help, but will not force a kernel upgrade upon the user
	if [[ ! "$is_container" -eq 0 ]] && ! modprobe -nq wireguard; then
		echo "Warning!"
		echo "Installation was finished, but the WireGuard kernel module could not load."
		if [[ "$os" == "ubuntu" && "$os_version" -eq 1804 ]]; then
			echo 'Upgrade the kernel and headers with "apt-get install linux-generic" and restart.'
		elif [[ "$os" == "debian" && "$os_version" -eq 10 ]]; then
			echo "Upgrade the kernel with \"apt-get install linux-image-$architecture\" and restart."
		elif [[ "$os" == "centos" && "$os_version" -le 8 ]]; then
			echo "Reboot the system to load the most recent kernel."
		fi
	else
		echo "Finished!"
	fi
	echo
	echo "The client configuration is available in:" ~/"$client.conf"
	echo "New clients can be added by running this script again."
else
	clear
	echo "WireGuard is already installed."
	echo
	echo "Select an option:"
	echo "   1) Add a new client"
	echo "   2) Remove an existing client"
	echo "   3) Remove WireGuard"
	echo "   4) Exit"
	read -p "Option: " option
	until [[ "$option" =~ ^[1-4]$ ]]; do
		echo "$option: invalid selection."
		read -p "Option: " option
	done
	case "$option" in
		1)
			echo
			echo "Provide a name for the client:"
			read -p "Name: " unsanitized_client
			# Allow a limited lenght and set of characters to avoid conflicts
			client=$(sed 's/[^0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-]/_/g' <<< "$unsanitized_client" | cut -c-15)
			while [[ -z "$client" ]] || grep -q "^# BEGIN_PEER $client$" /etc/wireguard/wg0.conf; do
				echo "$client: invalid name."
				read -p "Name: " unsanitized_client
				client=$(sed 's/[^0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_-]/_/g' <<< "$unsanitized_client" | cut -c-15)
			done
			echo
			new_client_dns
			new_client_setup
			# Append new client configuration to the WireGuard interface
			wg addconf wg0 <(sed -n "/^# BEGIN_PEER $client/,/^# END_PEER $client/p" /etc/wireguard/wg0.conf)
			echo
			qrencode -t UTF8 < ~/"$client.conf"
			echo -e '\xE2\x86\x91 That is a QR code containing your client configuration.'
			echo
			echo "$client added. Configuration available in:" ~/"$client.conf"
			exit
		;;
		2)
			# This option could be documented a bit better and maybe even be simplified
			# ...but what can I say, I want some sleep too
			number_of_clients=$(grep -c '^# BEGIN_PEER' /etc/wireguard/wg0.conf)
			if [[ "$number_of_clients" = 0 ]]; then
				echo
				echo "There are no existing clients!"
				exit
			fi
			echo
			echo "Select the client to remove:"
			grep '^# BEGIN_PEER' /etc/wireguard/wg0.conf | cut -d ' ' -f 3 | nl -s ') '
			read -p "Client: " client_number
			until [[ "$client_number" =~ ^[0-9]+$ && "$client_number" -le "$number_of_clients" ]]; do
				echo "$client_number: invalid selection."
				read -p "Client: " client_number
			done
			client=$(grep '^# BEGIN_PEER' /etc/wireguard/wg0.conf | cut -d ' ' -f 3 | sed -n "$client_number"p)
			echo
			read -p "Confirm $client removal? [y/N]: " remove
			until [[ "$remove" =~ ^[yYnN]*$ ]]; do
				echo "$remove: invalid selection."
				read -p "Confirm $client removal? [y/N]: " remove
			done
			if [[ "$remove" =~ ^[yY]$ ]]; then
				# The following is the right way to avoid disrupting other active connections:
				# Remove from the live interface
				wg set wg0 peer "$(sed -n "/^# BEGIN_PEER $client$/,\$p" /etc/wireguard/wg0.conf | grep -m 1 PublicKey | cut -d " " -f 3)" remove
				# Remove from the configuration file
				sed -i "/^# BEGIN_PEER $client$/,/^# END_PEER $client$/d" /etc/wireguard/wg0.conf
				echo
				echo "$client removed!"
			else
				echo
				echo "$client removal aborted!"
			fi
			exit
		;;
		3)
			echo
			read -p "Confirm WireGuard removal? [y/N]: " remove
			until [[ "$remove" =~ ^[yYnN]*$ ]]; do
				echo "$remove: invalid selection."
				read -p "Confirm WireGuard removal? [y/N]: " remove
			done
			if [[ "$remove" =~ ^[yY]$ ]]; then
				port=$(grep '^ListenPort' /etc/wireguard/wg0.conf | cut -d " " -f 3)
				if systemctl is-active --quiet firewalld.service; then
					ip=$(firewall-cmd --direct --get-rules ipv4 nat POSTROUTING | grep -F -- "-s $wg_subnet ! -d $wg_subnet" | grep -oE '[^ ]+$')
					# Using both permanent and not permanent rules to avoid a firewalld reload.
					firewall-cmd --remove-port="$port"/udp
					firewall-cmd --zone=trusted --remove-source="$wg_subnet"
					firewall-cmd --permanent --remove-port="$port"/udp
					firewall-cmd --permanent --zone=trusted --remove-source="$wg_subnet"
					firewall-cmd --direct --remove-rule ipv4 nat POSTROUTING 0 -s "$wg_subnet" ! -d "$wg_subnet" -j SNAT --to "$ip"
					firewall-cmd --permanent --direct --remove-rule ipv4 nat POSTROUTING 0 -s "$wg_subnet" ! -d "$wg_subnet" -j SNAT --to "$ip"
					if grep -qs 'fddd:2c4:2c4:2c4::1/64' /etc/wireguard/wg0.conf; then
						ip6=$(firewall-cmd --direct --get-rules ipv6 nat POSTROUTING | grep '\-s fddd:2c4:2c4:2c4::/64 '"'"'!'"'"' -d fddd:2c4:2c4:2c4::/64' | grep -oE '[^ ]+$')
						firewall-cmd --zone=trusted --remove-source=fddd:2c4:2c4:2c4::/64
						firewall-cmd --permanent --zone=trusted --remove-source=fddd:2c4:2c4:2c4::/64
						firewall-cmd --direct --remove-rule ipv6 nat POSTROUTING 0 -s fddd:2c4:2c4:2c4::/64 ! -d fddd:2c4:2c4:2c4::/64 -j SNAT --to "$ip6"
						firewall-cmd --permanent --direct --remove-rule ipv6 nat POSTROUTING 0 -s fddd:2c4:2c4:2c4::/64 ! -d fddd:2c4:2c4:2c4::/64 -j SNAT --to "$ip6"
					fi
				else
					systemctl disable --now wg-iptables.service
					rm -f /etc/systemd/system/wg-iptables.service
				fi
				systemctl disable --now wg-quick@wg0.service
				rm -f /etc/systemd/system/wg-quick@wg0.service.d/boringtun.conf
				rm -f /etc/sysctl.d/99-wireguard-forward.conf
				# Different packages were installed if the system was containerized or not
				if [[ ! "$is_container" -eq 0 ]]; then
					if [[ "$os" == "ubuntu" ]]; then
						# Ubuntu
						rm -rf /etc/wireguard/
						apt-get remove --purge -y wireguard wireguard-tools
					elif [[ "$os" == "debian" && "$os_version" -ge 11 ]]; then
						# Debian 11 or higher
						rm -rf /etc/wireguard/
						apt-get remove --purge -y wireguard wireguard-tools
					elif [[ "$os" == "debian" && "$os_version" -eq 10 ]]; then
						# Debian 10
						rm -rf /etc/wireguard/
						apt-get remove --purge -y wireguard wireguard-dkms wireguard-tools
					elif [[ "$os" == "centos" && "$os_version" -ge 9 ]]; then
						# CentOS 9 or higher
						dnf remove -y wireguard-tools
						rm -rf /etc/wireguard/
					elif [[ "$os" == "centos" && "$os_version" -eq 8 ]]; then
						# CentOS 8
						dnf remove -y kmod-wireguard wireguard-tools
						rm -rf /etc/wireguard/
					elif [[ "$os" == "centos" && "$os_version" -eq 7 ]]; then
						# CentOS 7
						yum remove -y kmod-wireguard wireguard-tools
						rm -rf /etc/wireguard/
					elif [[ "$os" == "fedora" ]]; then
						# Fedora
						dnf remove -y wireguard-tools
						rm -rf /etc/wireguard/
					fi
				else
					{ crontab -l 2>/dev/null | grep -v '/usr/local/sbin/boringtun-upgrade' ; } | crontab -
					if [[ "$os" == "ubuntu" ]]; then
						# Ubuntu
						rm -rf /etc/wireguard/
						apt-get remove --purge -y wireguard-tools
					elif [[ "$os" == "debian" && "$os_version" -ge 11 ]]; then
						# Debian 11 or higher
						rm -rf /etc/wireguard/
						apt-get remove --purge -y wireguard-tools
					elif [[ "$os" == "debian" && "$os_version" -eq 10 ]]; then
						# Debian 10
						rm -rf /etc/wireguard/
						apt-get remove --purge -y wireguard-tools
					elif [[ "$os" == "centos" && "$os_version" -ge 9 ]]; then
						# CentOS 9 or higher
						dnf remove -y wireguard-tools
						rm -rf /etc/wireguard/
					elif [[ "$os" == "centos" && "$os_version" -eq 8 ]]; then
						# CentOS 8
						dnf remove -y wireguard-tools
						rm -rf /etc/wireguard/
					elif [[ "$os" == "centos" && "$os_version" -eq 7 ]]; then
						# CentOS 7
						yum remove -y wireguard-tools
						rm -rf /etc/wireguard/
					elif [[ "$os" == "fedora" ]]; then
						# Fedora
						dnf remove -y wireguard-tools
						rm -rf /etc/wireguard/
					fi
					rm -f /usr/local/sbin/boringtun /usr/local/sbin/boringtun-upgrade
				fi
				echo
				echo "WireGuard removed!"
			else
				echo
				echo "WireGuard removal aborted!"
			fi
			exit
		;;
		4)
			exit
		;;
	esac
fi
