#!/bin/bash

set -euo pipefail

# QPJoy OpenVPN Oversea server.
#
# Installs an OpenVPN server whose purpose is reverse reachability, not egress:
# spokes dial out from inside a restricted network, receive a stable address
# from a client-config-dir entry, and the Oversea host can then reach back into
# them. Nothing is pushed to clients - no default gateway, no DNS, no routes -
# because the spoke side is explicitly not allowed to have its networking
# rearranged.
#
# Egress is still possible: the server keeps NAT for the tunnel subnet enabled
# so a spoke that opts in locally ('open egress on') can route through here.
# That decision belongs to the spoke, not to a server push.
#
# Two runtimes are supported and auto-detected:
#   docker  when this host already runs the qp-tunnel-cli managed
#           mx-oversea-hysteria2 stack, so both tunnels stay containerized
#   host    otherwise; a plain systemd service
#
# In docker mode the container uses network_mode: host. A bridge network would
# put the tun device inside the container's namespace, where neither the host
# nor a sibling container could reach the spoke addresses, which is the entire
# point of the deployment.

QP_OPENS_INSTANCE="${QP_OPENS_INSTANCE:-mx}"

_qp_opens_command="${1:-help}"
case "$_qp_opens_command" in
	preflight|install|create|reissue|list|revoke|up|down|restart|status|logs|reachable|uninstall)
		_qp_opens_filtered=()
		_qp_opens_instance_arg=""
		while [[ $# -gt 0 ]]; do
			case "$1" in
				--instance)
					[[ $# -ge 2 && -n "${2:-}" ]] || { echo "Error: Missing value for --instance." >&2; exit 1; }
					_qp_opens_instance_arg="$2"
					shift 2
				;;
				--instance=*)
					_qp_opens_instance_arg="${1#--instance=}"
					[[ -n "$_qp_opens_instance_arg" ]] || { echo "Error: Missing value for --instance." >&2; exit 1; }
					shift
				;;
				*)
					_qp_opens_filtered+=("$1")
					shift
				;;
			esac
		done
		[[ -n "$_qp_opens_instance_arg" ]] && QP_OPENS_INSTANCE="$_qp_opens_instance_arg"
		set -- "${_qp_opens_filtered[@]}"
	;;
esac

# Capped at 9 characters so `ovpns-<instance>` fits in IFNAMSIZ.
[[ "$QP_OPENS_INSTANCE" =~ ^[a-z][a-z0-9-]{0,8}$ ]] \
	|| { echo "Error: Instance must match [a-z][a-z0-9-]{0,8}." >&2; exit 1; }

QP_OPENS_HOME="/etc/qp-openvpn-server/$QP_OPENS_INSTANCE"
QP_OPENS_PKI="$QP_OPENS_HOME/pki"
QP_OPENS_CCD="$QP_OPENS_HOME/ccd"
QP_OPENS_CLIENTS="$QP_OPENS_HOME/clients"
QP_OPENS_CONFIG="$QP_OPENS_HOME/server.conf"
QP_OPENS_ENV="$QP_OPENS_HOME/server.env"
QP_OPENS_STATE="$QP_OPENS_HOME/state.json"
QP_OPENS_DEV="ovpns-$QP_OPENS_INSTANCE"
QP_OPENS_UNIT="qp-openvpn-server@$QP_OPENS_INSTANCE.service"
QP_OPENS_UNIT_TEMPLATE="/etc/systemd/system/qp-openvpn-server@.service"
QP_OPENS_FW_UNIT="qp-openvpn-firewall@$QP_OPENS_INSTANCE.service"
QP_OPENS_FW_TEMPLATE="/etc/systemd/system/qp-openvpn-firewall@.service"
# Lower-case on purpose: ${var^^} is bash 4 only, and macOS still ships 3.2.
QP_OPENS_CHAIN="QP-OPEN-$QP_OPENS_INSTANCE"
QP_OPENS_COMPOSE="$QP_OPENS_HOME/docker-compose.yml"
QP_OPENS_DOCKERFILE="$QP_OPENS_HOME/Dockerfile"
QP_OPENS_IMAGE="qp-openvpn:alpine"
QP_OPENS_CONTAINER="mx-oversea-openvpn-$QP_OPENS_INSTANCE"
QP_OPENS_STATUS_FILE="$QP_OPENS_HOME/openvpn-status.log"

# The hysteria2 stack this host may already run, per the Oversea site-slot.
QP_OPENS_HY2_CONTAINER="${QP_OPENS_HY2_CONTAINER:-mx-oversea-hysteria2}"

die() { echo "Error: $*" >&2; exit 1; }
warn() { echo "Warning: $*" >&2; }
info() { echo "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
require_root() { [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "This command needs root. Re-run with sudo."; }

require_linux() {
	[[ "$(uname -s)" == Linux ]] || die "The OpenVPN server targets Linux hosts. Run this on the Oversea server."
}

# ---------------------------------------------------------------------------
# CIDR helpers (shared shape with openvpn-client.sh)
# ---------------------------------------------------------------------------

validate_cidr() {
	local cidr="$1" ip prefix octet
	local -a octets
	[[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || return 1
	ip="${cidr%/*}"; prefix="${cidr#*/}"
	IFS='.' read -r -a octets <<< "$ip"
	[[ "${#octets[@]}" -eq 4 ]] || return 1
	for octet in "${octets[@]}"; do [[ "$octet" -ge 0 && "$octet" -le 255 ]] || return 1; done
	[[ "$prefix" -ge 0 && "$prefix" -le 32 ]] || return 1
}

validate_ipv4() {
	local ip="$1" octet
	local -a octets
	[[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
	IFS='.' read -r -a octets <<< "$ip"
	for octet in "${octets[@]}"; do [[ "$octet" -ge 0 && "$octet" -le 255 ]] || return 1; done
}

ip_to_int() { local -a o; IFS='.' read -r -a o <<< "$1"; echo $(( (o[0] << 24) + (o[1] << 16) + (o[2] << 8) + o[3] )); }

int_to_ip() {
	local value="$1"
	echo "$(( (value >> 24) & 255 )).$(( (value >> 16) & 255 )).$(( (value >> 8) & 255 )).$(( value & 255 ))"
}

cidr_to_netmask() {
	# See openvpn-client.sh: `prefix` must be assigned before the arithmetic
	# that reads it, or `set -u` reads the caller's scope instead.
	local prefix="$1"
	local full=$((prefix / 8))
	local partial=$((prefix % 8))
	local -a mask=(); local index value
	for index in 0 1 2 3; do
		if [[ "$index" -lt "$full" ]]; then value=255
		elif [[ "$index" -eq "$full" && "$partial" -gt 0 ]]; then value=$((256 - 2 ** (8 - partial)))
		else value=0; fi
		mask+=("$value")
	done
	local IFS='.'; echo "${mask[*]}"
}

cidr_network() {
	local cidr="$1" base size
	base=$(ip_to_int "${cidr%/*}")
	size=$(( 2 ** (32 - ${cidr#*/}) ))
	int_to_ip $(( base - (base % size) ))
}

cidr_range() {
	local cidr="$1" base size network
	base=$(ip_to_int "${cidr%/*}")
	size=$(( ${cidr#*/} == 0 ? 4294967296 : 2 ** (32 - ${cidr#*/}) ))
	network=$(( base - (base % size) ))
	echo "$network $(( network + size - 1 ))"
}

cidrs_overlap() {
	local a_start a_end b_start b_end
	read -r a_start a_end <<< "$(cidr_range "$1")"
	read -r b_start b_end <<< "$(cidr_range "$2")"
	[[ "$a_start" -le "$b_end" && "$b_start" -le "$a_end" ]]
}

local_claimed_cidrs() {
	if have ip; then
		ip route show table all 2>/dev/null | awk '{print $1}' \
			| grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$' \
			| sed -E 's#^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$#\1/32#'
	fi
	if have docker; then
		# `xargs -r` is GNU-only, so the empty case is handled here instead.
		local networks
		networks="$(docker network ls --quiet 2>/dev/null || true)"
		if [[ -n "$networks" ]]; then
			echo "$networks" \
				| xargs docker network inspect --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' 2>/dev/null \
				| grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$' || true
		fi
	fi
}

wan_interface() {
	ip route show default 2>/dev/null | awk '/^default/ {for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}'
}

detect_public_host() {
	local candidate
	candidate="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
	if [[ -n "$candidate" ]] && ! [[ "$candidate" =~ ^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.) ]]; then
		echo "$candidate"
		return 0
	fi
	# Behind NAT: ask an external echo service, but never fail the install on it.
	local public=""
	if have curl; then
		public="$(curl -fsS -m 8 -4 https://api.ipify.org 2>/dev/null || true)"
	elif have wget; then
		public="$(wget -qO- -T 8 -4 https://api.ipify.org 2>/dev/null || true)"
	fi
	validate_ipv4 "$public" && { echo "$public"; return 0; }
	echo "$candidate"
}

# ---------------------------------------------------------------------------
# env
# ---------------------------------------------------------------------------

load_env() {
	[[ -f "$QP_OPENS_ENV" ]] || die "Instance '$QP_OPENS_INSTANCE' is not installed. Run: qp-tunnel-cli open install --instance $QP_OPENS_INSTANCE"
	# shellcheck disable=SC1090
	source "$QP_OPENS_ENV"
}

save_env() {
	local tmp
	tmp="$(mktemp "$QP_OPENS_HOME/.server.env.XXXXXX")"
	cat > "$tmp" <<EOF
# Generated by qp-tunnel-cli open install. Do not edit by hand.
QP_OPEN_SUBNET='$QP_OPEN_SUBNET'
QP_OPEN_NETMASK='$QP_OPEN_NETMASK'
QP_OPEN_NETWORK='$QP_OPEN_NETWORK'
QP_OPEN_PORT='$QP_OPEN_PORT'
QP_OPEN_PROTO='$QP_OPEN_PROTO'
QP_OPEN_HOST='$QP_OPEN_HOST'
QP_OPEN_PORT_RANGE='$QP_OPEN_PORT_RANGE'
QP_OPEN_RUNTIME='$QP_OPEN_RUNTIME'
QP_OPEN_EGRESS_NAT='$QP_OPEN_EGRESS_NAT'
QP_OPEN_CLIENT_TO_CLIENT='$QP_OPEN_CLIENT_TO_CLIENT'
QP_OPEN_WAN_IF='$QP_OPEN_WAN_IF'
EOF
	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_OPENS_ENV"
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

preflight() {
	local subnet="100.127.0.0/24"
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--subnet) [[ $# -ge 2 ]] || die "Missing value for --subnet."; subnet="$2"; shift 2 ;;
			--subnet=*) subnet="${1#--subnet=}"; shift ;;
			--help|-h) info "Usage: qp-tunnel-cli open preflight --server [--subnet CIDR]"; return 0 ;;
			*) die "Unknown preflight option: $1" ;;
		esac
	done

	require_linux
	validate_cidr "$subnet" || die "Invalid --subnet value: $subnet"

	info "Oversea host: $(uname -n)"
	info "Candidate tunnel subnet: $subnet"
	info ""

	local conflicts=() cidr
	while IFS= read -r cidr; do
		[[ -n "$cidr" ]] || continue
		cidrs_overlap "$subnet" "$cidr" && conflicts+=("$cidr")
	done < <(local_claimed_cidrs | sort -u)

	if [[ "${#conflicts[@]}" -gt 0 ]]; then
		info "CONFLICT: $subnet overlaps existing networks on this host:"
		printf '  - %s\n' "${conflicts[@]}"
		info ""
		info "Pick another subnet with --subnet. Note that an AWS default VPC is"
		info "172.31.0.0/16, which is why 100.127.x is the recommended default."
		return 1
	fi
	info "OK: $subnet is free on this host."

	info ""
	if [[ -e /dev/net/tun ]]; then
		info "PASS  /dev/net/tun is present"
	else
		info "FAIL  /dev/net/tun is missing; OpenVPN cannot run here"
		return 1
	fi

	info "Runtime that would be selected: $(detect_runtime)"
	info "WAN interface: $(wan_interface || echo unknown)"
	info "Advertised host: $(detect_public_host || echo unknown)"

	if have openvpn; then
		info "openvpn: $(openvpn --version 2>/dev/null | head -1)"
	else
		info "openvpn: not installed (install will add it)"
	fi
	have openssl || info "openssl: not installed (required)"
	return 0
}

# ---------------------------------------------------------------------------
# runtime detection
# ---------------------------------------------------------------------------

detect_runtime() {
	have docker || { echo host; return 0; }

	# The container list is captured before matching: `grep -q` exits on the
	# first hit, and the resulting SIGPIPE would fail the pipeline under
	# `set -o pipefail`, misreporting a Docker host as a plain one.
	local containers
	containers="$(docker ps -a --format '{{.Names}}' 2>/dev/null || true)"

	if echo "$containers" | grep -qx "$QP_OPENS_HY2_CONTAINER"; then
		echo docker
	else
		echo host
	fi
}

compose_command() {
	if docker compose version >/dev/null 2>&1; then
		echo "docker compose"
	elif have docker-compose; then
		echo "docker-compose"
	else
		return 1
	fi
}

compose() {
	local cmd
	cmd="$(compose_command)" || die "Neither 'docker compose' nor 'docker-compose' is available."
	# shellcheck disable=SC2086
	$cmd -f "$QP_OPENS_COMPOSE" -p "qp-openvpn-$QP_OPENS_INSTANCE" "$@"
}

# ---------------------------------------------------------------------------
# install
# ---------------------------------------------------------------------------

install_server() {
	local subnet="100.127.0.0/24" port="1194" proto="udp" host="" runtime="auto"
	local port_range="" egress_nat="true" client_to_client="false" force=false

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--subnet) [[ $# -ge 2 ]] || die "Missing value for --subnet."; subnet="$2"; shift 2 ;;
			--subnet=*) subnet="${1#--subnet=}"; shift ;;
			--port) [[ $# -ge 2 ]] || die "Missing value for --port."; port="$2"; shift 2 ;;
			--port=*) port="${1#--port=}"; shift ;;
			--proto) [[ $# -ge 2 ]] || die "Missing value for --proto."; proto="$2"; shift 2 ;;
			--proto=*) proto="${1#--proto=}"; shift ;;
			--host) [[ $# -ge 2 ]] || die "Missing value for --host."; host="$2"; shift 2 ;;
			--host=*) host="${1#--host=}"; shift ;;
			--runtime) [[ $# -ge 2 ]] || die "Missing value for --runtime."; runtime="$2"; shift 2 ;;
			--runtime=*) runtime="${1#--runtime=}"; shift ;;
			--port-range) [[ $# -ge 2 ]] || die "Missing value for --port-range."; port_range="$2"; shift 2 ;;
			--port-range=*) port_range="${1#--port-range=}"; shift ;;
			--no-egress-nat) egress_nat="false"; shift ;;
			--client-to-client) client_to_client="true"; shift ;;
			--force) force=true; shift ;;
			--help|-h) install_help; return 0 ;;
			*) die "Unknown install option: $1" ;;
		esac
	done

	require_root
	require_linux

	validate_cidr "$subnet" || die "Invalid --subnet value: $subnet"
	[[ "$port" =~ ^[0-9]+$ && "$port" -ge 1 && "$port" -le 65535 ]] || die "Invalid --port value: $port"
	case "$proto" in udp|tcp) ;; *) die "--proto must be udp or tcp." ;; esac
	case "$runtime" in auto|docker|host) ;; *) die "--runtime must be auto, docker or host." ;; esac
	if [[ -n "$port_range" ]]; then
		[[ "$port_range" =~ ^([0-9]+)-([0-9]+)$ ]] || die "--port-range must look like 20000-20100."
		[[ "${BASH_REMATCH[1]}" -lt "${BASH_REMATCH[2]}" ]] || die "--port-range start must be lower than its end."
	fi

	[[ -e /dev/net/tun ]] || die "/dev/net/tun is missing. Enable TUN on this host first."

	if [[ -f "$QP_OPENS_ENV" && "$force" != true ]]; then
		die "Instance '$QP_OPENS_INSTANCE' is already installed at $QP_OPENS_HOME.
Use --force to reinstall, or pick another --instance."
	fi

	local cidr
	while IFS= read -r cidr; do
		[[ -n "$cidr" ]] || continue
		if cidrs_overlap "$subnet" "$cidr"; then
			[[ "$force" == true ]] \
				&& { warn "Subnet $subnet overlaps $cidr; continuing because --force was given."; break; } \
				|| die "Subnet $subnet overlaps the existing network $cidr on this host.
Run 'qp-tunnel-cli open preflight --server --subnet $subnet' for the full picture."
		fi
	done < <(local_claimed_cidrs | sort -u)

	[[ "$runtime" == auto ]] && runtime="$(detect_runtime)"
	[[ -z "$host" ]] && host="$(detect_public_host || true)"
	[[ -n "$host" ]] || die "Could not determine the public address. Pass --host <ip-or-domain>."

	QP_OPEN_SUBNET="$subnet"
	QP_OPEN_NETWORK="$(cidr_network "$subnet")"
	QP_OPEN_NETMASK="$(cidr_to_netmask "${subnet#*/}")"
	QP_OPEN_PORT="$port"
	QP_OPEN_PROTO="$proto"
	QP_OPEN_HOST="$host"
	QP_OPEN_PORT_RANGE="$port_range"
	QP_OPEN_RUNTIME="$runtime"
	QP_OPEN_EGRESS_NAT="$egress_nat"
	QP_OPEN_CLIENT_TO_CLIENT="$client_to_client"
	QP_OPEN_WAN_IF="$(wan_interface || true)"

	mkdir -p "$QP_OPENS_HOME" "$QP_OPENS_PKI" "$QP_OPENS_CCD" "$QP_OPENS_CLIENTS"
	# The instance directory has to be traversable, not private. OpenVPN drops to
	# `user nobody` at startup and then reads a client-config-dir entry on every
	# connection; with a 0700 parent that lookup fails silently and the client
	# gets a pool address instead of its fixed one. Secrets stay protected by the
	# two subdirectories that actually hold them.
	chmod 0755 "$QP_OPENS_HOME" "$QP_OPENS_CCD"
	chmod 0700 "$QP_OPENS_PKI" "$QP_OPENS_CLIENTS"

	info "Runtime : $runtime"
	info "Subnet  : $subnet (server $(server_gateway_ip))"
	info "Endpoint: $host:$port/$proto"
	[[ -n "$port_range" ]] && info "Range   : $port_range/$proto redirected to $port"
	info ""

	if [[ "$runtime" == host ]]; then
		ensure_host_packages
	else
		ensure_docker_image
	fi

	build_pki
	write_server_config
	save_env

	if [[ "$runtime" == host ]]; then
		install_server_unit
	else
		write_compose_file
	fi

	apply_firewall
	install_firewall_unit
	write_state

	up
	info ""
	info "Oversea OpenVPN server '$QP_OPENS_INSTANCE' is installed."
	info "Issue a spoke profile with:"
	info "  qp-tunnel-cli open create internal-01 --instance $QP_OPENS_INSTANCE"
}

install_help() {
	cat <<'EOF'
Usage:
  qp-tunnel-cli open install [options]

Options:
  --instance NAME       Instance namespace, default "mx".
  --subnet CIDR         Tunnel subnet, default 100.127.0.0/24. RFC 6598 space is
                        the default because Docker's address pools never reach
                        it and an AWS default VPC is 172.31.0.0/16.
  --port PORT           Listen port, default 1194.
  --proto udp|tcp       Transport, default udp.
  --host ADDR           Public IP or domain advertised in issued profiles.
                        Auto-detected when omitted.
  --port-range A-B      Additionally accept A-B and redirect them to --port, so
                        an issued profile can carry several remote lines and
                        fail over without any server-side coordination.
  --runtime MODE        auto (default) | docker | host. "auto" selects docker
                        when the qp-tunnel-cli managed mx-oversea-hysteria2
                        stack is present on this host, otherwise host.
  --no-egress-nat       Do not NAT the tunnel subnet. Spokes can still reach
                        this host, but 'open egress on' will not work for them.
  --client-to-client    Let spokes reach each other. Off by default.
  --force               Reinstall over an existing instance.

The server pushes nothing to clients: no routes, no gateway, no DNS. Spokes are
expected to run in route-nopull mode and decide their own routing.
EOF
}

ensure_host_packages() {
	if have openvpn && have openssl; then
		info "openvpn and openssl are already present."
		return 0
	fi

	info "Installing openvpn and openssl..."
	if have apt-get; then
		apt-get update -qq
		DEBIAN_FRONTEND=noninteractive apt-get install -y openvpn openssl iptables
	elif have dnf; then
		dnf install -y openvpn openssl iptables
	elif have yum; then
		yum install -y epel-release || true
		yum install -y openvpn openssl iptables
	elif have apk; then
		apk add --no-cache openvpn openssl iptables
	else
		die "No supported package manager found. Install openvpn and openssl manually, then re-run."
	fi

	have openvpn || die "openvpn is still missing after installation."
	have openssl || die "openssl is still missing after installation."
}

ensure_docker_image() {
	have docker || die "--runtime docker needs Docker, which is not installed."
	compose_command >/dev/null || die "Neither 'docker compose' nor 'docker-compose' is available."
	# The PKI is built on the host in both runtimes so `open create` works the
	# same way regardless of how the server itself is running.
	have openssl || die "openssl is required on the host to generate the PKI. Install it and re-run."

	cat > "$QP_OPENS_DOCKERFILE" <<'EOF'
# Generated by qp-tunnel-cli open install. Do not edit by hand.
# Built locally rather than pulled so the deployment does not depend on an
# unmaintained third-party OpenVPN image.
FROM alpine:3.20
RUN apk add --no-cache openvpn openssl iptables
ENTRYPOINT ["/usr/sbin/openvpn"]
EOF

	info "Building $QP_OPENS_IMAGE..."
	docker build -t "$QP_OPENS_IMAGE" -f "$QP_OPENS_DOCKERFILE" "$QP_OPENS_HOME" >/dev/null \
		|| die "Failed to build $QP_OPENS_IMAGE."
	info "Built $QP_OPENS_IMAGE"
}

# Runs the openvpn binary regardless of runtime, so PKI generation works the
# same way in both modes.
run_openvpn() {
	if [[ "${QP_OPEN_RUNTIME:-host}" == docker ]]; then
		docker run --rm -v "$QP_OPENS_PKI:/pki" -w /pki --entrypoint /usr/sbin/openvpn "$QP_OPENS_IMAGE" "$@"
	else
		openvpn "$@"
	fi
}

server_gateway_ip() {
	local network="${QP_OPEN_NETWORK:-$(cidr_network "${QP_OPEN_SUBNET}")}"
	int_to_ip $(( $(ip_to_int "$network") + 1 ))
}

# ---------------------------------------------------------------------------
# PKI
#
# Built directly on openssl with a small CA database rather than easy-rsa, so
# installation never has to reach GitHub and `revoke` can emit a real CRL.
# ---------------------------------------------------------------------------

pki_openssl_cnf() {
	cat > "$QP_OPENS_PKI/openssl.cnf" <<EOF
# Generated by qp-tunnel-cli open install. Do not edit by hand.
[ ca ]
default_ca = qp_ca

[ qp_ca ]
dir              = $QP_OPENS_PKI
database         = \$dir/index.txt
serial           = \$dir/serial
new_certs_dir    = \$dir/issued
certificate      = \$dir/ca.crt
private_key      = \$dir/ca.key
default_md       = sha256
default_days     = 3650
default_crl_days = 3650
policy           = qp_policy
email_in_dn      = no
unique_subject   = no
copy_extensions  = none
rand_serial      = no

[ qp_policy ]
commonName = supplied

[ req ]
distinguished_name = qp_dn
prompt             = no

[ qp_dn ]
CN = placeholder

[ server_ext ]
basicConstraints       = CA:FALSE
keyUsage               = digitalSignature, keyEncipherment
extendedKeyUsage       = serverAuth
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid,issuer

[ client_ext ]
basicConstraints       = CA:FALSE
keyUsage               = digitalSignature
extendedKeyUsage       = clientAuth
subjectKeyIdentifier   = hash
authorityKeyIdentifier = keyid,issuer
EOF
	chmod 0600 "$QP_OPENS_PKI/openssl.cnf"
}

generate_key() {
	# EC keys keep issuance fast and are supported by every OpenVPN that also
	# supports tls-crypt, which is already the baseline here.
	openssl ecparam -name prime256v1 -genkey -noout -out "$1"
	chmod 0600 "$1"
}

build_pki() {
	if [[ -f "$QP_OPENS_PKI/ca.crt" && -f "$QP_OPENS_PKI/server.crt" ]]; then
		info "Reusing the existing PKI at $QP_OPENS_PKI"
		return 0
	fi

	info "Generating PKI..."
	mkdir -p "$QP_OPENS_PKI/issued"
	: > "$QP_OPENS_PKI/index.txt"
	echo "01" > "$QP_OPENS_PKI/serial"
	echo "01" > "$QP_OPENS_PKI/crlnumber"
	pki_openssl_cnf

	generate_key "$QP_OPENS_PKI/ca.key"
	openssl req -x509 -new -key "$QP_OPENS_PKI/ca.key" -sha256 -days 3650 \
		-out "$QP_OPENS_PKI/ca.crt" -subj "/CN=qp-open-ca-$QP_OPENS_INSTANCE"
	chmod 0644 "$QP_OPENS_PKI/ca.crt"

	generate_key "$QP_OPENS_PKI/server.key"
	openssl req -new -key "$QP_OPENS_PKI/server.key" -out "$QP_OPENS_PKI/server.csr" -subj "/CN=qp-open-server"
	openssl ca -config "$QP_OPENS_PKI/openssl.cnf" -batch -notext \
		-extensions server_ext -in "$QP_OPENS_PKI/server.csr" -out "$QP_OPENS_PKI/server.crt"
	rm -f "$QP_OPENS_PKI/server.csr"

	generate_tls_crypt_key
	generate_crl

	info "PKI ready at $QP_OPENS_PKI"
}

generate_tls_crypt_key() {
	[[ -f "$QP_OPENS_PKI/tls-crypt.key" ]] && return 0
	# `--genkey secret <file>` is the 2.5+ form; 2.4 needs `--genkey --secret`.
	if ! run_openvpn --genkey secret "$QP_OPENS_PKI/tls-crypt.key" >/dev/null 2>&1; then
		run_openvpn --genkey --secret "$QP_OPENS_PKI/tls-crypt.key" >/dev/null 2>&1 \
			|| die "Could not generate the tls-crypt key."
	fi
	chmod 0600 "$QP_OPENS_PKI/tls-crypt.key"
}

generate_crl() {
	openssl ca -config "$QP_OPENS_PKI/openssl.cnf" -gencrl -out "$QP_OPENS_PKI/crl.pem" 2>/dev/null \
		|| { warn "Could not generate a CRL."; return 1; }
	# OpenVPN drops privileges, so the CRL has to stay world-readable.
	chmod 0644 "$QP_OPENS_PKI/crl.pem"
}

# ---------------------------------------------------------------------------
# server configuration
# ---------------------------------------------------------------------------

write_server_config() {
	local unprivileged_group=nogroup
	grep -q '^nogroup:' /etc/group 2>/dev/null || unprivileged_group=nobody

	local tmp
	tmp="$(mktemp "$QP_OPENS_HOME/.server.conf.XXXXXX")"
	cat > "$tmp" <<EOF
# Generated by qp-tunnel-cli open install. Do not edit by hand.
# Reverse-access server: spokes dial in and receive a stable address. Nothing
# is pushed, because the spoke side is not allowed to have its routing, its
# default gateway or its resolver rearranged from here.
port $QP_OPEN_PORT
proto $QP_OPEN_PROTO
dev $QP_OPENS_DEV
dev-type tun
topology subnet
server $QP_OPEN_NETWORK $QP_OPEN_NETMASK

# Stable addressing comes from client-config-dir entries written by
# 'open create'. The pool file only records what was handed out.
client-config-dir $QP_OPENS_CCD
ifconfig-pool-persist $QP_OPENS_HOME/ipp.txt

ca $QP_OPENS_PKI/ca.crt
cert $QP_OPENS_PKI/server.crt
key $QP_OPENS_PKI/server.key
tls-crypt $QP_OPENS_PKI/tls-crypt.key
# ECDHE is negotiated directly with EC certificates, so no dhparam file is
# needed and installation does not stall generating one.
dh none

$(render_server_ciphers)
auth SHA512
tls-version-min 1.2

keepalive 10 60
persist-key
persist-tun
user nobody
group $unprivileged_group
status $QP_OPENS_STATUS_FILE 10
verb 3
EOF

	if [[ -f "$QP_OPENS_PKI/crl.pem" ]]; then
		echo "crl-verify $QP_OPENS_PKI/crl.pem" >> "$tmp"
	fi
	if [[ "$QP_OPEN_CLIENT_TO_CLIENT" == true ]]; then
		echo "client-to-client" >> "$tmp"
	fi

	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_OPENS_CONFIG"
	info "Wrote $QP_OPENS_CONFIG"
}

# The server config cannot lean on ignore-unknown-option the way an issued
# profile does: it is parsed by whichever openvpn is installed here, and an
# unknown option is fatal. 2.5 replaced ncp-ciphers with data-ciphers, and RHEL
# 7 / Amazon Linux 2 still ship 2.4, where data-ciphers aborts startup.
render_server_ciphers() {
	if openvpn_at_least_2_5; then
		echo "data-ciphers AES-256-GCM:AES-128-GCM"
		echo "data-ciphers-fallback AES-256-GCM"
	else
		echo "cipher AES-256-GCM"
		echo "ncp-ciphers AES-256-GCM:AES-128-GCM"
	fi
}

openvpn_at_least_2_5() {
	# The docker runtime ships its own modern openvpn, so the host binary - which
	# may be missing entirely - says nothing about what will parse the config.
	[[ "${QP_OPEN_RUNTIME:-host}" == docker ]] && return 0

	local version major minor
	version="$(openvpn --version 2>/dev/null | awk 'NR==1 {print $2}')"
	[[ -n "$version" ]] || return 0

	major="${version%%.*}"
	minor="${version#*.}"
	minor="${minor%%.*}"
	[[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 0

	[[ "$major" -gt 2 ]] && return 0
	[[ "$major" -eq 2 && "$minor" -ge 5 ]]
}

install_server_unit() {
	have systemctl || die "systemd is required for --runtime host."

	if [[ -e "$QP_OPENS_UNIT_TEMPLATE" ]] && ! grep -q 'qp-tunnel-cli' "$QP_OPENS_UNIT_TEMPLATE"; then
		die "$QP_OPENS_UNIT_TEMPLATE exists and was not written by qp-tunnel-cli. Refusing to overwrite it."
	fi

	local type=simple
	openvpn --version 2>/dev/null | grep -q 'enable_systemd=yes' && type=notify

	cat > "$QP_OPENS_UNIT_TEMPLATE" <<EOF
# Generated by qp-tunnel-cli open install. Do not edit by hand.
# Separate from the distribution openvpn-server@ template on purpose: that unit
# may already run an unrelated OpenVPN server on this or another host.
[Unit]
Description=QPJoy Oversea OpenVPN server (%i)
After=network-online.target $QP_OPENS_FW_UNIT
Wants=network-online.target

[Service]
Type=$type
WorkingDirectory=/etc/qp-openvpn-server/%i
ExecStart=$(command -v openvpn) --config /etc/qp-openvpn-server/%i/server.conf --cd /etc/qp-openvpn-server/%i
Restart=on-failure
RestartSec=5
KillMode=process
LimitNPROC=100

[Install]
WantedBy=multi-user.target
EOF
	chmod 0644 "$QP_OPENS_UNIT_TEMPLATE"
	systemctl daemon-reload
	info "Installed $QP_OPENS_UNIT_TEMPLATE"
}

write_compose_file() {
	local published="$QP_OPEN_PORT"
	cat > "$QP_OPENS_COMPOSE" <<EOF
# Generated by qp-tunnel-cli open install. Do not edit by hand.
services:
  openvpn:
    image: $QP_OPENS_IMAGE
    container_name: $QP_OPENS_CONTAINER
    # network_mode: host is mandatory, not a convenience. On a bridge network
    # the tun device lives in the container namespace, so neither this host nor
    # a sibling container such as $QP_OPENS_HY2_CONTAINER could reach the spoke
    # addresses, which is the whole reason this server exists.
    network_mode: host
    cap_add:
      - NET_ADMIN
    devices:
      - "/dev/net/tun:/dev/net/tun"
    volumes:
      - $QP_OPENS_HOME:$QP_OPENS_HOME
    command: ["--config", "$QP_OPENS_CONFIG", "--cd", "$QP_OPENS_HOME"]
    restart: unless-stopped
EOF
	info "Wrote $QP_OPENS_COMPOSE (published port $published/$QP_OPEN_PROTO on the host namespace)"
}

# ---------------------------------------------------------------------------
# firewall
#
# Everything lives in one dedicated chain per instance so teardown is exact and
# nothing else in PREROUTING/POSTROUTING is touched.
# ---------------------------------------------------------------------------

apply_firewall() {
	have iptables || { warn "iptables is not available; skipping firewall setup."; return 0; }

	remove_firewall

	iptables -t nat -N "$QP_OPENS_CHAIN" 2>/dev/null || true
	iptables -t nat -C PREROUTING -j "$QP_OPENS_CHAIN" 2>/dev/null \
		|| iptables -t nat -I PREROUTING 1 -j "$QP_OPENS_CHAIN"

	if [[ -n "$QP_OPEN_PORT_RANGE" ]]; then
		local range="${QP_OPEN_PORT_RANGE/-/:}"
		iptables -t nat -A "$QP_OPENS_CHAIN" -p "$QP_OPEN_PROTO" --dport "$range" \
			-j REDIRECT --to-ports "$QP_OPEN_PORT"
		info "Redirecting $QP_OPEN_PROTO/$QP_OPEN_PORT_RANGE to $QP_OPEN_PORT"
	fi

	if [[ "$QP_OPEN_EGRESS_NAT" == true ]]; then
		[[ -n "$QP_OPEN_WAN_IF" ]] || QP_OPEN_WAN_IF="$(wan_interface || true)"
		if [[ -n "$QP_OPEN_WAN_IF" ]]; then
			iptables -t nat -N "${QP_OPENS_CHAIN}-NAT" 2>/dev/null || true
			iptables -t nat -C POSTROUTING -j "${QP_OPENS_CHAIN}-NAT" 2>/dev/null \
				|| iptables -t nat -A POSTROUTING -j "${QP_OPENS_CHAIN}-NAT"
			iptables -t nat -A "${QP_OPENS_CHAIN}-NAT" -s "$QP_OPEN_SUBNET" -o "$QP_OPEN_WAN_IF" -j MASQUERADE
			info "NAT enabled for $QP_OPEN_SUBNET via $QP_OPEN_WAN_IF"
		else
			warn "No WAN interface detected; skipping egress NAT."
		fi

		# Forwarding is written to a dedicated drop-in so removal is exact.
		mkdir -p /etc/sysctl.d
		echo "net.ipv4.ip_forward = 1" > "/etc/sysctl.d/99-qp-openvpn-$QP_OPENS_INSTANCE.conf"
		sysctl -q -w net.ipv4.ip_forward=1 || true
	fi
}

remove_firewall() {
	have iptables || return 0
	iptables -t nat -D PREROUTING -j "$QP_OPENS_CHAIN" 2>/dev/null || true
	iptables -t nat -F "$QP_OPENS_CHAIN" 2>/dev/null || true
	iptables -t nat -X "$QP_OPENS_CHAIN" 2>/dev/null || true
	iptables -t nat -D POSTROUTING -j "${QP_OPENS_CHAIN}-NAT" 2>/dev/null || true
	iptables -t nat -F "${QP_OPENS_CHAIN}-NAT" 2>/dev/null || true
	iptables -t nat -X "${QP_OPENS_CHAIN}-NAT" 2>/dev/null || true
}

install_firewall_unit() {
	have systemctl || return 0

	if [[ -e "$QP_OPENS_FW_TEMPLATE" ]] && ! grep -q 'qp-tunnel-cli' "$QP_OPENS_FW_TEMPLATE"; then
		warn "$QP_OPENS_FW_TEMPLATE exists and was not written by qp-tunnel-cli; leaving it alone."
		return 0
	fi

	# The unit runs at boot, long after the npm package that installed it may
	# have been upgraded or removed, so the script is copied into the instance
	# directory instead of being referenced where it happened to live.
	local owned_script="$QP_OPENS_HOME/openvpn-server.sh"
	cp -f "${BASH_SOURCE[0]}" "$owned_script"
	chmod 0700 "$owned_script"

	local script="$QP_OPENS_HOME/firewall.sh"
	cat > "$script" <<EOF
#!/bin/bash
# Generated by qp-tunnel-cli open install. Do not edit by hand.
set -euo pipefail
exec "$owned_script" "\$1" --instance '$QP_OPENS_INSTANCE'
EOF
	chmod 0700 "$script"

	cat > "$QP_OPENS_FW_TEMPLATE" <<EOF
# Generated by qp-tunnel-cli open install. Do not edit by hand.
[Unit]
Description=QPJoy Oversea OpenVPN firewall rules (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/etc/qp-openvpn-server/%i/firewall.sh firewall-up
ExecStop=/etc/qp-openvpn-server/%i/firewall.sh firewall-down

[Install]
WantedBy=multi-user.target
EOF
	chmod 0644 "$QP_OPENS_FW_TEMPLATE"
	systemctl daemon-reload
	systemctl enable "$QP_OPENS_FW_UNIT" >/dev/null 2>&1 || true
	info "Installed $QP_OPENS_FW_TEMPLATE"
}

# Records what this instance owns, for diagnostics and for uninstall to reason
# about. QP_OPENS_STATE was declared from the start but the writer was missing,
# which aborted install under `set -e` before the server was ever started.
write_state() {
	local tmp
	tmp="$(mktemp "$QP_OPENS_HOME/.state.json.XXXXXX")"
	cat > "$tmp" <<EOF
{
  "version": 1,
  "role": "server",
  "instance": "$QP_OPENS_INSTANCE",
  "runtime": "$QP_OPEN_RUNTIME",
  "interface": "$QP_OPENS_DEV",
  "host": "$QP_OPEN_HOST",
  "port": "$QP_OPEN_PORT",
  "proto": "$QP_OPEN_PROTO",
  "portRange": "$QP_OPEN_PORT_RANGE",
  "subnet": "$QP_OPEN_SUBNET",
  "gateway": "$(server_gateway_ip)",
  "unit": "$QP_OPENS_UNIT",
  "firewallChain": "$QP_OPENS_CHAIN",
  "egressNat": "$QP_OPEN_EGRESS_NAT",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_OPENS_STATE"
}

# ---------------------------------------------------------------------------
# create / list / revoke
# ---------------------------------------------------------------------------

create_client() {
	local name="" client_ip="" out="" egress="denied"

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--ip) [[ $# -ge 2 ]] || die "Missing value for --ip."; client_ip="$2"; shift 2 ;;
			--ip=*) client_ip="${1#--ip=}"; shift ;;
			--out) [[ $# -ge 2 ]] || die "Missing value for --out."; out="$2"; shift 2 ;;
			--out=*) out="${1#--out=}"; shift ;;
			--oversea) egress="allowed"; shift ;;
			--no-oversea) egress="denied"; shift ;;
			--help|-h) create_help; return 0 ;;
			-*) die "Unknown create option: $1" ;;
			*) [[ -z "$name" ]] || die "create takes exactly one client name."; name="$1"; shift ;;
		esac
	done

	[[ -n "$name" ]] || die "create requires a client name, for example: open create internal-01"
	[[ "$name" =~ ^[a-zA-Z0-9_-]{1,32}$ ]] || die "Client name must match [a-zA-Z0-9_-]{1,32}."

	require_root
	load_env

	[[ -f "$QP_OPENS_PKI/ca.crt" ]] || die "PKI is missing. Re-run 'open install'."

	if [[ -f "$QP_OPENS_PKI/issued-$name.crt" ]]; then
		die "Client '$name' already exists. Revoke it first: qp-tunnel-cli open revoke $name"
	fi

	if [[ -n "$client_ip" ]]; then
		validate_ipv4 "$client_ip" || die "Invalid --ip value: $client_ip"
		cidrs_overlap "$client_ip/32" "$QP_OPEN_SUBNET" \
			|| die "$client_ip is outside the tunnel subnet $QP_OPEN_SUBNET."
	else
		client_ip="$(next_free_client_ip)"
		[[ -n "$client_ip" ]] || die "No free address left in $QP_OPEN_SUBNET."
	fi

	local existing
	existing="$(grep -rl "ifconfig-push $client_ip " "$QP_OPENS_CCD" 2>/dev/null | head -1 || true)"
	[[ -n "$existing" ]] && die "$client_ip is already assigned to $(basename "$existing")."

	info "Issuing '$name' at $client_ip..."

	generate_key "$QP_OPENS_PKI/issued-$name.key"
	openssl req -new -key "$QP_OPENS_PKI/issued-$name.key" \
		-out "$QP_OPENS_PKI/issued-$name.csr" -subj "/CN=$name"
	openssl ca -config "$QP_OPENS_PKI/openssl.cnf" -batch -notext \
		-extensions client_ext -in "$QP_OPENS_PKI/issued-$name.csr" \
		-out "$QP_OPENS_PKI/issued-$name.crt"
	rm -f "$QP_OPENS_PKI/issued-$name.csr"

	# The client-config-dir entry is what makes the address stable. Without it
	# the server hands out pool addresses that move across reconnects, and the
	# Oversea side loses its fixed target.
	cat > "$QP_OPENS_CCD/$name" <<EOF
# Generated by qp-tunnel-cli open create. Do not edit by hand.
ifconfig-push $client_ip $QP_OPEN_NETMASK
EOF
	chmod 0644 "$QP_OPENS_CCD/$name"

	[[ -z "$out" ]] && out="$QP_OPENS_CLIENTS/$name.ovpn"
	render_profile "$name" "$client_ip" "$egress" openvpn2 > "$out"
	chmod 0600 "$out"

	# OpenVPN Connect and the mobile apps run the OpenVPN 3 core, which refuses
	# the whole profile over options 2.x takes for granted. Issuing both here
	# beats asking whoever imports the file to hand-edit it.
	local connect_out="${out%.ovpn}.connect.ovpn"
	render_profile "$name" "$client_ip" "$egress" openvpn3 > "$connect_out"
	chmod 0600 "$connect_out"

	info ""
	info "Wrote $out"
	info "      and $connect_out"
	info "  address : $client_ip"
	info "  egress  : $egress"
	info ""
	info "Copy the first one to the spoke and run there:"
	info "  sudo qp-tunnel-cli open enroll --file $(basename "$out")"
	info ""
	info "Import the .connect.ovpn one into OpenVPN Connect or a mobile app."
}

create_help() {
	cat <<'EOF'
Usage:
  qp-tunnel-cli open create <name> [--ip ADDR] [--out FILE] [--oversea]
  qp-tunnel-cli open reissue <name> [--out FILE]

Issues a spoke profile: an EC client certificate, a client-config-dir entry
that pins a stable address, and a .ovpn file carrying route-nopull so the spoke
cannot have its routing or DNS rearranged by this server.

  --ip ADDR    Fixed tunnel address. Allocated from the subnet when omitted.
  --out FILE   Output path. Defaults to <instance>/clients/<name>.ovpn.
  --oversea    Mark the profile as egress-allowed, so the spoke may later run
               'open egress on' to route internet traffic through this server.
               The profile still connects in spoke mode; egress stays off until
               the spoke enables it explicitly.
EOF
}

next_free_client_ip() {
	local start end candidate ip
	read -r start end <<< "$(cidr_range "$QP_OPEN_SUBNET")"
	# .1 is the server; start handing out from .10 to leave room for fixtures.
	candidate=$(( start + 10 ))
	while [[ "$candidate" -lt "$end" ]]; do
		ip="$(int_to_ip "$candidate")"
		if ! grep -rqs "ifconfig-push $ip " "$QP_OPENS_CCD" 2>/dev/null; then
			echo "$ip"
			return 0
		fi
		candidate=$(( candidate + 1 ))
	done
	return 1
}

render_profile() {
	local name="$1" client_ip="$2" egress="$3" variant="${4:-openvpn2}"

	cat <<EOF
# QPJoy OpenVPN spoke profile ($variant). Consume with:
#   sudo qp-tunnel-cli open enroll --file <this file>
#
# The headers below are read by the spoke tooling before it connects, so the
# tunnel subnet can be checked against the host's existing networks first.
# qp-open-profile-version: 1
# qp-open-variant: $variant
# qp-open-instance: $QP_OPENS_INSTANCE
# qp-open-server-host: $QP_OPEN_HOST
# qp-open-subnet: $QP_OPEN_SUBNET
# qp-open-client-ip: $client_ip
# qp-open-client-name: $name
# qp-open-egress: $egress
# qp-open-issued-at: $(date -u +%Y-%m-%dT%H:%M:%SZ)

client
dev tun
proto $QP_OPEN_PROTO
$(render_remotes)
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
auth SHA512
tls-version-min 1.2
connect-retry 3 30
verb 3
$(render_profile_variant_body "$variant")
<ca>
$(cat "$QP_OPENS_PKI/ca.crt")
</ca>
<cert>
$(openssl x509 -in "$QP_OPENS_PKI/issued-$name.crt" 2>/dev/null)
</cert>
<key>
$(cat "$QP_OPENS_PKI/issued-$name.key")
</key>
<tls-crypt>
$(cat "$QP_OPENS_PKI/tls-crypt.key")
</tls-crypt>
EOF
}

# The two client generations disagree about which options exist, so the parts
# that differ live here rather than being patched out of a single template.
#
# openvpn2  Stock OpenVPN 2.4.7+, Tunnelblick, the Windows community GUI, and
#           what `open enroll` feeds to the system openvpn.
# openvpn3  OpenVPN Connect and the mobile apps. Verified against a real
#           Connect log: it rejects the whole profile with
#           "UNKNOWN/UNSUPPORTED OPTIONS" and named `topology`, because
#           OpenVPN 3 implements subnet topology internally and never
#           accepted the directive. `pull-filter` and `script-security` are
#           absent for the same reason. The same log shows `data-ciphers` and
#           `connect-retry` parsing cleanly, so those stay.
render_profile_variant_body() {
	local variant="$1"

	if [[ "$variant" == openvpn3 ]]; then
		cat <<'EOF'

# Spoke mode. OpenVPN 3 has no topology directive and no pull-filter, so the
# containment here rests on route-nopull plus the fact that this server pushes
# nothing at all - no routes, no gateway, no DNS. The extra pull-filter layer
# in the openvpn2 profile guards against a mis-set server; it cannot be
# expressed here.
data-ciphers AES-256-GCM:AES-128-GCM
route-nopull
EOF
		return 0
	fi

	cat <<'EOF'

# Cipher negotiation is spelled two ways so the same file imports into a stock
# OpenVPN client of either 2.x generation. ignore-unknown-option has to precede
# the options it covers, because parsing is sequential. RHEL 7 still ships 2.4,
# which knows cipher but not data-ciphers; 2.5+ ignores cipher once
# data-ciphers is present. The floor is 2.4.7, where ignore-unknown-option
# itself was introduced.
# No backticks anywhere in this heredoc: it is unquoted so the shell would
# execute them while rendering the profile.
ignore-unknown-option data-ciphers data-ciphers-fallback block-outside-dns
cipher AES-256-GCM
data-ciphers AES-256-GCM:AES-128-GCM
data-ciphers-fallback AES-256-GCM

# Spoke mode: accept the assigned address and nothing else. topology has to be
# stated locally because route-nopull may discard the pushed one, which would
# drop a 2.x client back to net30 and mismatch the server.
topology subnet
route-nopull
pull-filter ignore "redirect-gateway"
pull-filter ignore "dhcp-option"
pull-filter ignore "route"
pull-filter ignore "route-ipv6"
pull-filter ignore "block-outside-dns"
pull-filter ignore "register-dns"
script-security 0
EOF
}

# Several remote lines let a spoke fail over on its own when one port is
# blocked, with no server-side coordination and no port drift protocol.
render_remotes() {
	echo "remote $QP_OPEN_HOST $QP_OPEN_PORT $QP_OPEN_PROTO"
	[[ -n "$QP_OPEN_PORT_RANGE" ]] || return 0

	local start="${QP_OPEN_PORT_RANGE%-*}" end="${QP_OPEN_PORT_RANGE#*-}"
	local span=$(( end - start )) step offset index
	step=$(( span / 4 ))
	[[ "$step" -lt 1 ]] && step=1
	for index in 0 1 2 3; do
		offset=$(( start + index * step ))
		[[ "$offset" -le "$end" ]] || break
		echo "remote $QP_OPEN_HOST $offset $QP_OPEN_PROTO"
	done
}

# Re-renders both profiles for a client that already exists, from the
# certificate it already holds. This is what you want after the endpoint moves:
# a changed port, host or --port-range leaves every issued profile pointing at
# the old one, and `create` refuses the name because the client is still valid.
reissue_client() {
	local name="" out="" egress=""

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--out) [[ $# -ge 2 ]] || die "Missing value for --out."; out="$2"; shift 2 ;;
			--out=*) out="${1#--out=}"; shift ;;
			--oversea) egress="allowed"; shift ;;
			--no-oversea) egress="denied"; shift ;;
			--help|-h) reissue_help; return 0 ;;
			-*) die "Unknown reissue option: $1" ;;
			*) [[ -z "$name" ]] || die "reissue takes exactly one client name."; name="$1"; shift ;;
		esac
	done

	[[ -n "$name" ]] || die "reissue requires a client name."
	require_root
	load_env

	[[ -f "$QP_OPENS_PKI/issued-$name.crt" ]] \
		|| die "Unknown client: $name. Issue it with: qp-tunnel-cli open create $name"

	local client_ip
	client_ip="$(awk '/^ifconfig-push/ {print $2; exit}' "$QP_OPENS_CCD/$name" 2>/dev/null)"
	[[ -n "$client_ip" ]] || die "Client '$name' has no client-config-dir entry, so it has no fixed address."

	[[ -z "$out" ]] && out="$QP_OPENS_CLIENTS/$name.ovpn"

	# Carry the previous egress marker forward unless it was overridden, so a
	# reissue neither widens nor narrows what the spoke may do by accident.
	if [[ -z "$egress" ]]; then
		egress="$(awk '/^# qp-open-egress:/ {print $3; exit}' "$out" 2>/dev/null)"
		[[ -n "$egress" ]] || egress="denied"
	fi

	local connect_out="${out%.ovpn}.connect.ovpn"
	render_profile "$name" "$client_ip" "$egress" openvpn2 > "$out"
	chmod 0600 "$out"
	render_profile "$name" "$client_ip" "$egress" openvpn3 > "$connect_out"
	chmod 0600 "$connect_out"

	info "Reissued '$name' against the current endpoint."
	info "  endpoint: $QP_OPEN_HOST:$QP_OPEN_PORT/$QP_OPEN_PROTO"
	info "  address : $client_ip (unchanged)"
	info "  egress  : $egress"
	info ""
	info "Wrote $out"
	info "      and $connect_out"
}

reissue_help() {
	cat <<'EOF'
Usage:
  qp-tunnel-cli open reissue <name> [--out FILE] [--oversea|--no-oversea]

Re-renders both profiles for an existing client using its current certificate
and its client-config-dir address. Use it after the endpoint changes: a new
--port, --host or --port-range leaves every previously issued profile pointing
at the old one.

Nothing about the PKI or the address reservation changes, so the client keeps
its identity. The egress marker carries over from the previous profile unless
--oversea or --no-oversea overrides it.
EOF
}

list_clients() {
	load_env
	local ccd name ip
	info "Instance '$QP_OPENS_INSTANCE' - subnet $QP_OPEN_SUBNET, server $(server_gateway_ip)"
	info ""
	printf '%-24s %-16s %s\n' NAME ADDRESS STATE
	shopt -s nullglob
	for ccd in "$QP_OPENS_CCD"/*; do
		name="$(basename "$ccd")"
		ip="$(awk '/^ifconfig-push/ {print $2; exit}' "$ccd")"
		if grep -q '^disable' "$ccd" 2>/dev/null; then
			printf '%-24s %-16s %s\n' "$name" "$ip" revoked
		elif [[ -f "$QP_OPENS_STATUS_FILE" ]] && grep -q "^CLIENT_LIST,$name," "$QP_OPENS_STATUS_FILE" 2>/dev/null; then
			printf '%-24s %-16s %s\n' "$name" "$ip" connected
		else
			printf '%-24s %-16s %s\n' "$name" "$ip" offline
		fi
	done
	shopt -u nullglob
}

revoke_client() {
	local name="${1:-}"
	[[ -n "$name" ]] || die "revoke requires a client name."
	require_root
	load_env

	[[ -f "$QP_OPENS_PKI/issued-$name.crt" ]] || die "Unknown client: $name"

	local client_address
	client_address="$(awk '/^ifconfig-push/ {print $2; exit}' "$QP_OPENS_CCD/$name" 2>/dev/null)"
	[[ -n "$client_address" ]] || client_address="(none)"

	local enforced=false
	if openssl ca -config "$QP_OPENS_PKI/openssl.cnf" -batch \
		-revoke "$QP_OPENS_PKI/issued-$name.crt" 2>/dev/null && generate_crl; then
		enforced=true
	fi

	rm -f "$QP_OPENS_CLIENTS/$name.ovpn" "$QP_OPENS_CLIENTS/$name.connect.ovpn"

	if [[ "$enforced" != true ]]; then
		# Degraded mode: the CRL is not carrying the revocation, so the
		# client-config-dir entry has to. Keeping it means the name and address
		# stay held, which is the safe direction.
		warn "The CRL could not be updated, so revocation rests on a client-config-dir disable."
		warn "The name and address stay reserved until that is resolved."
		if [[ -f "$QP_OPENS_CCD/$name" ]] && ! grep -q '^disable$' "$QP_OPENS_CCD/$name"; then
			echo "disable" >> "$QP_OPENS_CCD/$name"
		fi
		info "Restart the server to apply: qp-tunnel-cli open restart --instance $QP_OPENS_INSTANCE"
		return 0
	fi

	# The CRL is what actually rejects the old certificate, so the issued files
	# and the address reservation can be released. Leaving them behind made
	# revoke a dead end: `create` refused the name because the certificate was
	# still on disk, and the address because the ccd entry still claimed it.
	mkdir -p "$QP_OPENS_PKI/revoked"
	chmod 0700 "$QP_OPENS_PKI/revoked"
	local stamp
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	mv -f "$QP_OPENS_PKI/issued-$name.crt" "$QP_OPENS_PKI/revoked/$name-$stamp.crt" 2>/dev/null || true
	mv -f "$QP_OPENS_PKI/issued-$name.key" "$QP_OPENS_PKI/revoked/$name-$stamp.key" 2>/dev/null || true
	rm -f "$QP_OPENS_CCD/$name"

	info "Revoked '$name'. The certificate is rejected by the CRL and archived under"
	info "  $QP_OPENS_PKI/revoked/$name-$stamp.crt"
	info "The name and address $client_address are free to reuse."
	info "Restart the server to load the new CRL:"
	info "  qp-tunnel-cli open restart --instance $QP_OPENS_INSTANCE"
}

# ---------------------------------------------------------------------------
# lifecycle
# ---------------------------------------------------------------------------

up() {
	require_root
	load_env
	if [[ "$QP_OPEN_RUNTIME" == docker ]]; then
		compose up -d
		info "Started container $QP_OPENS_CONTAINER"
	else
		systemctl enable "$QP_OPENS_UNIT" >/dev/null 2>&1 || true
		systemctl restart "$QP_OPENS_UNIT"
		info "Started $QP_OPENS_UNIT"
	fi

	assert_server_running
}

server_is_running() {
	if [[ "$QP_OPEN_RUNTIME" == docker ]]; then
		[[ -n "$(docker ps --quiet --filter "name=^${QP_OPENS_CONTAINER}\$" 2>/dev/null)" ]]
	else
		systemctl is-active --quiet "$QP_OPENS_UNIT"
	fi
}

# A dead server has to fail the command that started it.
#
# `systemctl restart` on a Type=simple unit returns success as soon as it forks,
# so an openvpn that exits a moment later still looks like a clean start. That
# turned a broken install into one that printed a warning and carried on, and
# the failure only surfaced later as a client stuck in EVENT: WAIT.
assert_server_running() {
	local attempt=0

	while [[ "$attempt" -lt 10 ]]; do
		if server_is_running && ip -4 -o addr show dev "$QP_OPENS_DEV" >/dev/null 2>&1; then
			info "Server address: $(ip -4 -o addr show dev "$QP_OPENS_DEV" | awk '{print $4}' | cut -d/ -f1)"
			info "Listening on $QP_OPEN_PORT/$QP_OPEN_PROTO"
			return 0
		fi
		attempt=$((attempt + 1))
		sleep 1
	done

	echo "" >&2
	echo "The OpenVPN server did not come up." >&2
	if ! server_is_running; then
		echo "The service is not running. Last log lines:" >&2
	else
		echo "The service is running but $QP_OPENS_DEV never appeared. Last log lines:" >&2
	fi
	echo "" >&2
	server_recent_logs 30 >&2 || true
	echo "" >&2
	die "Server start failed. Full log: qp-tunnel-cli open logs --instance $QP_OPENS_INSTANCE"
}

server_recent_logs() {
	local lines="${1:-100}"
	if [[ "$QP_OPEN_RUNTIME" == docker ]]; then
		docker logs --tail "$lines" "$QP_OPENS_CONTAINER" 2>&1
	else
		journalctl -u "$QP_OPENS_UNIT" -n "$lines" --no-pager 2>&1
	fi
}

down() {
	require_root
	load_env
	if [[ "$QP_OPEN_RUNTIME" == docker ]]; then
		compose down 2>/dev/null || true
		info "Stopped container $QP_OPENS_CONTAINER"
	else
		systemctl stop "$QP_OPENS_UNIT" 2>/dev/null || true
		info "Stopped $QP_OPENS_UNIT"
	fi
}

restart() { down; up; }

status() {
	load_env
	info "Instance : $QP_OPENS_INSTANCE"
	info "Runtime  : $QP_OPEN_RUNTIME"
	info "Endpoint : $QP_OPEN_HOST:$QP_OPEN_PORT/$QP_OPEN_PROTO"
	[[ -n "$QP_OPEN_PORT_RANGE" ]] && info "Range    : $QP_OPEN_PORT_RANGE -> $QP_OPEN_PORT"
	info "Subnet   : $QP_OPEN_SUBNET (server $(server_gateway_ip))"
	info "Interface: $QP_OPENS_DEV"
	info "Egress   : NAT=$QP_OPEN_EGRESS_NAT via ${QP_OPEN_WAN_IF:-unknown}"
	info ""

	if [[ "$QP_OPEN_RUNTIME" == docker ]]; then
		docker ps --filter "name=^${QP_OPENS_CONTAINER}\$" --format 'Container: {{.Names}} {{.Status}}' 2>/dev/null \
			|| info "Container: not running"
	else
		systemctl is-active "$QP_OPENS_UNIT" >/dev/null 2>&1 \
			&& info "Service  : active" || info "Service  : inactive"
	fi

	info ""
	list_clients
}

logs() {
	load_env
	server_recent_logs "${1:-100}"
}

# Verifies the deployment's actual purpose: this host can reach the spokes.
reachable() {
	load_env
	local ccd name ip failures=0

	shopt -s nullglob
	for ccd in "$QP_OPENS_CCD"/*; do
		name="$(basename "$ccd")"
		grep -q '^disable' "$ccd" 2>/dev/null && continue
		ip="$(awk '/^ifconfig-push/ {print $2; exit}' "$ccd")"
		[[ -n "$ip" ]] || continue
		if ping -c 2 -W 3 "$ip" >/dev/null 2>&1; then
			info "PASS  $name  $ip"
		else
			info "FAIL  $name  $ip  (not reachable from this host)"
			failures=$((failures + 1))
		fi
	done
	shopt -u nullglob

	info ""
	if [[ "$failures" -eq 0 ]]; then
		info "All configured spokes are reachable from the Oversea host."
		return 0
	fi
	info "$failures spoke(s) unreachable. An offline spoke is expected; a connected"
	info "but unreachable spoke usually means the container is not on network_mode: host."
	return 1
}

uninstall() {
	local purge=false
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--purge) purge=true; shift ;;
			*) die "Unknown uninstall option: $1" ;;
		esac
	done

	require_root
	[[ -f "$QP_OPENS_ENV" ]] && load_env || true

	down 2>/dev/null || true
	remove_firewall
	rm -f "/etc/sysctl.d/99-qp-openvpn-$QP_OPENS_INSTANCE.conf"

	if have systemctl; then
		systemctl disable "$QP_OPENS_UNIT" >/dev/null 2>&1 || true
		systemctl disable "$QP_OPENS_FW_UNIT" >/dev/null 2>&1 || true
		if [[ -z "$(ls -A /etc/qp-openvpn-server 2>/dev/null | grep -v "^$QP_OPENS_INSTANCE\$")" ]]; then
			rm -f "$QP_OPENS_UNIT_TEMPLATE" "$QP_OPENS_FW_TEMPLATE"
			info "Removed the shared unit templates (last instance)"
		fi
		systemctl daemon-reload 2>/dev/null || true
	fi

	if [[ "$purge" == true ]]; then
		rm -rf "$QP_OPENS_HOME"
		info "Purged $QP_OPENS_HOME (PKI and issued profiles are gone)"
	else
		info "Kept $QP_OPENS_HOME so the PKI and issued profiles survive. Use --purge to remove them."
	fi
	info "Uninstalled server instance '$QP_OPENS_INSTANCE'."
}

usage() {
	cat <<'EOF'
QPJoy Oversea OpenVPN server

Usage:
  qp-tunnel-cli open preflight --server [--subnet CIDR]
  qp-tunnel-cli open install [--subnet CIDR] [--port PORT] [--proto udp|tcp]
                             [--host ADDR] [--port-range A-B]
                             [--runtime auto|docker|host]
                             [--no-egress-nat] [--client-to-client] [--force]
  qp-tunnel-cli open create <name> [--ip ADDR] [--out FILE] [--oversea]
  qp-tunnel-cli open reissue <name> [--out FILE]
  qp-tunnel-cli open list | revoke <name>
  qp-tunnel-cli open up | down | restart | status | reachable
  qp-tunnel-cli open logs [LINES]
  qp-tunnel-cli open uninstall [--purge]

Global option:
  --instance NAME   Instance namespace, default "mx". One per server subnet.

The server never pushes routes, a gateway or DNS. Spokes connect with
route-nopull, receive a stable address from their client-config-dir entry, and
choose their own routing. Egress NAT stays available so a spoke can opt in
locally, but that is the spoke's decision, not a server push.
EOF
}

main() {
	local command="${1:-help}"
	shift || true

	case "$command" in
		preflight) preflight "$@" ;;
		install) install_server "$@" ;;
		create) create_client "$@" ;;
		reissue) reissue_client "$@" ;;
		list) list_clients ;;
		revoke) revoke_client "$@" ;;
		up|start) up ;;
		down|stop) down ;;
		restart) restart ;;
		status) status ;;
		logs) logs "$@" ;;
		reachable) reachable ;;
		uninstall) uninstall "$@" ;;
		firewall-up) require_root; load_env; apply_firewall ;;
		firewall-down) require_root; remove_firewall ;;
		help|--help|-h) usage ;;
		*) echo "Unknown command: $command" >&2; usage; exit 1 ;;
	esac
}

main "$@"
