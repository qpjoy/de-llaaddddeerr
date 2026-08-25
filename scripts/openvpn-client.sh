#!/bin/bash

set -euo pipefail

# QPJoy OpenVPN spoke client.
#
# This script joins the current host to an Oversea OpenVPN server as a spoke:
# the host receives one stable tunnel address so the server can reach back into
# it, and nothing else about the local network changes.  It is deliberately not
# a general purpose VPN client.
#
# Non-negotiable behaviour, because this runs on production servers that
# already own WireGuard interfaces, a Mihomo egress, Docker bridges, a k8s CNI
# and, on at least one host, an unrelated OpenVPN *server* on tun0:
#
#   - never writes /etc/resolv.conf, systemd-resolved config or any resolver
#   - never changes the default route unless `egress on` is called explicitly
#   - never reuses the distribution `openvpn-client@.service` /
#     `openvpn-server@.service` units, which may already belong to someone else
#   - never picks its own interface name; the interface is derived from the
#     instance so it can never collide with tun0/tun1
#   - records every mutation in state.json so `down`/`uninstall` restore exactly
#
# Egress (routing internet traffic through the Oversea server) is a separate,
# opt-in, reversible command.  Enrollment never enables it.

QP_OPEN_INSTANCE="${QP_OPEN_INSTANCE:-mx}"

_qp_open_launcher_name="${0##*/}"
if [[ "$_qp_open_launcher_name" =~ ^qp-openvpn-client-([a-z][a-z0-9-]{0,9})$ ]]; then
	QP_OPEN_INSTANCE="${BASH_REMATCH[1]}"
fi

# `--instance` is a management option, not part of any subcommand's own
# argument list.  Strip it before the per-command parsers run.
_qp_open_command="${1:-help}"
case "$_qp_open_command" in
	preflight|enroll|up|down|restart|status|logs|doctor|routes|egress|uninstall)
		_qp_open_filtered=()
		_qp_open_instance_arg=""
		while [[ $# -gt 0 ]]; do
			case "$1" in
				--instance)
					[[ $# -ge 2 && -n "${2:-}" ]] || { echo "Error: Missing value for --instance." >&2; exit 1; }
					[[ -z "$_qp_open_instance_arg" ]] || { echo "Error: --instance may only be provided once." >&2; exit 1; }
					_qp_open_instance_arg="$2"
					shift 2
				;;
				--instance=*)
					[[ -z "$_qp_open_instance_arg" ]] || { echo "Error: --instance may only be provided once." >&2; exit 1; }
					_qp_open_instance_arg="${1#--instance=}"
					[[ -n "$_qp_open_instance_arg" ]] || { echo "Error: Missing value for --instance." >&2; exit 1; }
					shift
				;;
				*)
					_qp_open_filtered+=("$1")
					shift
				;;
			esac
		done
		[[ -n "$_qp_open_instance_arg" ]] && QP_OPEN_INSTANCE="$_qp_open_instance_arg"
		set -- "${_qp_open_filtered[@]}"
	;;
esac

# The instance is capped at 10 characters so `ovpn-<instance>` still fits in
# IFNAMSIZ (15 usable characters).
[[ "$QP_OPEN_INSTANCE" =~ ^[a-z][a-z0-9-]{0,9}$ ]] \
	|| { echo "Error: Instance must match [a-z][a-z0-9-]{0,9}." >&2; exit 1; }

QP_OPEN_HOME="/etc/qp-openvpn/$QP_OPEN_INSTANCE"
QP_OPEN_CONFIG="$QP_OPEN_HOME/client.conf"
QP_OPEN_PROFILE="$QP_OPEN_HOME/profile.ovpn"
QP_OPEN_STATE="$QP_OPEN_HOME/state.json"
QP_OPEN_SNAPSHOT="$QP_OPEN_HOME/snapshot-before.txt"
QP_OPEN_EGRESS_CONF="$QP_OPEN_HOME/egress.conf"
QP_OPEN_DEV="ovpn-$QP_OPEN_INSTANCE"
QP_OPEN_UNIT="qp-openvpn-client@$QP_OPEN_INSTANCE.service"
QP_OPEN_UNIT_TEMPLATE="/etc/systemd/system/qp-openvpn-client@.service"
QP_OPEN_PLIST_LABEL="com.qpjoy.openvpn.client.$QP_OPEN_INSTANCE"
QP_OPEN_PLIST="/Library/LaunchDaemons/$QP_OPEN_PLIST_LABEL.plist"
QP_OPEN_LOG="/var/log/qp-openvpn-$QP_OPEN_INSTANCE.log"
QP_OPEN_STATUS_FILE="/var/run/qp-openvpn-$QP_OPEN_INSTANCE.status"

QP_OPEN_CN_ROUTES_FILE="${QP_OPEN_CN_ROUTES_FILE:-}"

die() {
	echo "Error: $*" >&2
	exit 1
}

warn() {
	echo "Warning: $*" >&2
}

info() {
	echo "$*"
}

require_root() {
	[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "This command needs root. Re-run with sudo."
}

os_kind() {
	case "$(uname -s)" in
		Linux) echo linux ;;
		Darwin) echo darwin ;;
		*) echo unsupported ;;
	esac
}

have() {
	command -v "$1" >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# CIDR helpers
# ---------------------------------------------------------------------------

validate_cidr() {
	local cidr="$1" ip prefix octet
	local -a octets

	[[ "$cidr" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]] || return 1
	ip="${cidr%/*}"
	prefix="${cidr#*/}"
	IFS='.' read -r -a octets <<< "$ip"
	[[ "${#octets[@]}" -eq 4 ]] || return 1
	for octet in "${octets[@]}"; do
		[[ "$octet" -ge 0 && "$octet" -le 255 ]] || return 1
	done
	[[ "$prefix" -ge 0 && "$prefix" -le 32 ]] || return 1
	return 0
}

validate_ipv4() {
	local ip="$1" octet
	local -a octets
	[[ "$ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
	IFS='.' read -r -a octets <<< "$ip"
	for octet in "${octets[@]}"; do
		[[ "$octet" -ge 0 && "$octet" -le 255 ]] || return 1
	done
	return 0
}

ip_to_int() {
	local ip="$1"
	local -a o
	IFS='.' read -r -a o <<< "$ip"
	echo $(( (o[0] << 24) + (o[1] << 16) + (o[2] << 8) + o[3] ))
}

cidr_to_netmask() {
	# Declared separately: naming and using `prefix` in one `local` statement
	# leaves it unset while the arithmetic runs, which under `set -u` either
	# aborts or silently reads a same-named variable from the caller's scope.
	local prefix="$1"
	local full=$((prefix / 8))
	local partial=$((prefix % 8))
	local -a mask=()
	local index value
	for index in 0 1 2 3; do
		if [[ "$index" -lt "$full" ]]; then
			value=255
		elif [[ "$index" -eq "$full" && "$partial" -gt 0 ]]; then
			value=$((256 - 2 ** (8 - partial)))
		else
			value=0
		fi
		mask+=("$value")
	done
	local IFS='.'
	echo "${mask[*]}"
}

# Prints "<network-int> <broadcast-int>" for a CIDR.
cidr_range() {
	local cidr="$1"
	local ip="${cidr%/*}" prefix="${cidr#*/}"
	local base size
	base=$(ip_to_int "$ip")
	size=$(( prefix == 0 ? 4294967296 : 2 ** (32 - prefix) ))
	local network=$(( base - (base % size) ))
	echo "$network $(( network + size - 1 ))"
}

cidrs_overlap() {
	local a="$1" b="$2"
	local a_start a_end b_start b_end
	read -r a_start a_end <<< "$(cidr_range "$a")"
	read -r b_start b_end <<< "$(cidr_range "$b")"
	[[ "$a_start" -le "$b_end" && "$b_start" -le "$a_end" ]]
}

# ---------------------------------------------------------------------------
# Local network discovery
#
# Everything here is read-only.  It exists so the tool can *prove* a subnet is
# free rather than relying on a hard-coded exclusion list, which is exactly the
# assumption that breaks on a host with a customized CNI or 15 Docker bridges.
# ---------------------------------------------------------------------------

# Emits one CIDR per line for every network this host already routes.
local_claimed_cidrs() {
	case "$(os_kind)" in
		linux)
			if have ip; then
				ip route show table all 2>/dev/null \
					| awk '{print $1}' \
					| grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}(/[0-9]{1,2})?$' \
					| sed -E 's#^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$#\1/32#'
			fi
			;;
		darwin)
			if have netstat; then
				netstat -rn -f inet 2>/dev/null \
					| awk 'NR>3 && $1 ~ /^[0-9]+\./ {print $1}' \
					| sed -E 's#^([0-9]+\.[0-9]+\.[0-9]+)$#\1.0/24#; s#^([0-9]+\.[0-9]+)$#\1.0.0/16#; s#^([0-9]+)$#\1.0.0.0/8#' \
					| sed -E 's#^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$#\1/32#'
			fi
			;;
	esac

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

# Private/local destinations that must always stay off the tunnel when egress
# is enabled.  Derived from the live routing table, not from a static list.
local_direct_cidrs() {
	local cidr
	while IFS= read -r cidr; do
		[[ -n "$cidr" ]] || continue
		[[ "$cidr" == "0.0.0.0/0" ]] && continue
		[[ "$cidr" == default ]] && continue
		echo "$cidr"
	done < <(local_claimed_cidrs) | sort -u
}

default_route_dev() {
	case "$(os_kind)" in
		linux)
			ip route show default 2>/dev/null | awk '/^default/ {for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}'
			;;
		darwin)
			route -n get default 2>/dev/null | awk '/interface:/ {print $2; exit}'
			;;
	esac
}

default_route_gateway() {
	case "$(os_kind)" in
		linux)
			ip route show default 2>/dev/null | awk '/^default/ {for (i=1;i<=NF;i++) if ($i=="via") {print $(i+1); exit}}'
			;;
		darwin)
			route -n get default 2>/dev/null | awk '/gateway:/ {print $2; exit}'
			;;
	esac
}

# Which interface would an outbound packet to $1 actually leave through?
route_dev_for() {
	local target="$1"
	case "$(os_kind)" in
		linux)
			ip route get "$target" 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}'
			;;
		darwin)
			route -n get "$target" 2>/dev/null | awk '/interface:/ {print $2; exit}'
			;;
	esac
}

resolve_host_ipv4() {
	local host="$1"
	if validate_ipv4 "$host"; then
		echo "$host"
		return 0
	fi
	if have getent; then
		getent ahostsv4 "$host" 2>/dev/null | awk '{print $1; exit}'
	elif have dig; then
		dig +short A "$host" 2>/dev/null | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' | head -1
	elif have host; then
		host -t A "$host" 2>/dev/null | awk '/ has address / {print $4; exit}'
	fi
}

# ---------------------------------------------------------------------------
# Profile metadata
#
# `qp-tunnel-cli open create` stamps machine-readable comments into the .ovpn
# file so the client can preflight the subnet *before* connecting.  Under
# route-nopull the server never tells us the subnet, so without this header the
# client would have to connect first and check afterwards.
# ---------------------------------------------------------------------------

profile_meta() {
	local file="$1" key="$2"
	awk -v key="# qp-open-$key:" '
		index($0, key) == 1 { sub(/^[^:]*:[[:space:]]*/, ""); print; exit }
	' "$file" 2>/dev/null
}

assert_profile_readable() {
	local file="$1"
	[[ -f "$file" ]] || die "Profile not found: $file"
	[[ -r "$file" ]] || die "Profile is not readable: $file"
	grep -q '^[[:space:]]*<ca>' "$file" || die "Profile has no inline <ca> block: $file"
	grep -q '^[[:space:]]*<key>' "$file" || die "Profile has no inline <key> block: $file"
}

# ---------------------------------------------------------------------------
# preflight
# ---------------------------------------------------------------------------

preflight() {
	local subnet="" profile="" strict=false

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--subnet) [[ $# -ge 2 ]] || die "Missing value for --subnet."; subnet="$2"; shift 2 ;;
			--subnet=*) subnet="${1#--subnet=}"; shift ;;
			--file) [[ $# -ge 2 ]] || die "Missing value for --file."; profile="$2"; shift 2 ;;
			--file=*) profile="${1#--file=}"; shift ;;
			--strict) strict=true; shift ;;
			--help|-h) preflight_help; return 0 ;;
			*) die "Unknown preflight option: $1" ;;
		esac
	done

	if [[ -z "$subnet" && -n "$profile" ]]; then
		assert_profile_readable "$profile"
		subnet="$(profile_meta "$profile" subnet)"
		[[ -n "$subnet" ]] || die "Profile has no '# qp-open-subnet:' header; pass --subnet explicitly."
	fi
	[[ -n "$subnet" ]] || subnet="100.127.0.0/24"
	validate_cidr "$subnet" || die "Invalid --subnet value: $subnet"

	info "Host: $(uname -n) ($(os_kind))"
	info "Candidate tunnel subnet: $subnet"
	info ""

	local claimed conflicts=() count=0
	claimed="$(local_claimed_cidrs | sort -u || true)"

	local cidr
	while IFS= read -r cidr; do
		[[ -n "$cidr" ]] || continue
		count=$((count + 1))
		if cidrs_overlap "$subnet" "$cidr"; then
			conflicts+=("$cidr")
		fi
	done <<< "$claimed"

	info "Scanned $count locally routed / container network(s)."

	if [[ "${#conflicts[@]}" -gt 0 ]]; then
		info ""
		info "CONFLICT: $subnet overlaps existing local networks:"
		local entry
		for entry in "${conflicts[@]}"; do
			info "  - $entry"
		done
		info ""
		suggest_free_subnets "$claimed"
		return 1
	fi

	info "OK: $subnet does not overlap anything this host currently routes."

	local dev gateway
	dev="$(default_route_dev || true)"
	gateway="$(default_route_gateway || true)"
	info ""
	info "Default route: dev=${dev:-unknown} via ${gateway:-unknown}"

	if [[ -n "$dev" ]] && [[ "$dev" =~ ^(tun|tap|utun|wg|mihomo|Meta) ]]; then
		warn "The default route already points at a tunnel device ($dev)."
		warn "Enrollment will pin a /32 host route for the OpenVPN server so the"
		warn "outbound handshake is not captured by that tunnel."
	fi

	if [[ -e "$QP_OPEN_HOME" ]]; then
		info ""
		warn "Instance '$QP_OPEN_INSTANCE' already has state at $QP_OPEN_HOME"
	fi

	if [[ "$strict" == true && "${#conflicts[@]}" -gt 0 ]]; then
		return 1
	fi
	return 0
}

# Proposes RFC 6598 / RFC 1918 /24 blocks that do not collide with anything on
# this host.  100.127.x is preferred: Docker's default address pools never
# reach it, kubeadm does not default there, and the HDO overlay only occupies
# 100.88-100.91.
suggest_free_subnets() {
	local claimed="$1"
	local -a candidates=()
	local octet
	for octet in 0 1 2 3 4 5 6 7 8 9 10; do
		candidates+=("100.127.$octet.0/24")
	done
	candidates+=("100.126.0.0/24" "172.16.250.0/24" "10.100.0.0/24")

	info "Free /24 candidates on this host:"
	local candidate cidr ok printed=0
	for candidate in "${candidates[@]}"; do
		ok=true
		while IFS= read -r cidr; do
			[[ -n "$cidr" ]] || continue
			if cidrs_overlap "$candidate" "$cidr"; then
				ok=false
				break
			fi
		done <<< "$claimed"
		if [[ "$ok" == true ]]; then
			info "  - $candidate"
			printed=$((printed + 1))
			[[ "$printed" -ge 5 ]] && break
		fi
	done
	[[ "$printed" -eq 0 ]] && info "  (none; pass --subnet with a block you know is free)"
}

preflight_help() {
	cat <<'EOF'
Usage:
  qp-tunnel-cli open preflight [--subnet CIDR | --file profile.ovpn] [--strict]

Read-only. Enumerates every network this host already routes (kernel routing
table, WireGuard interfaces, Docker bridges, CNI) and reports whether the
candidate tunnel subnet collides with any of them.
EOF
}

# ---------------------------------------------------------------------------
# enroll
# ---------------------------------------------------------------------------

enroll() {
	local profile="" start=true pin_route="auto" force=false

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--file) [[ $# -ge 2 ]] || die "Missing value for --file."; profile="$2"; shift 2 ;;
			--file=*) profile="${1#--file=}"; shift ;;
			--no-start) start=false; shift ;;
			--pin-route) [[ $# -ge 2 ]] || die "Missing value for --pin-route."; pin_route="$2"; shift 2 ;;
			--pin-route=*) pin_route="${1#--pin-route=}"; shift ;;
			--force) force=true; shift ;;
			--help|-h) enroll_help; return 0 ;;
			*) die "Unknown enroll option: $1" ;;
		esac
	done

	[[ -n "$profile" ]] || die "enroll requires --file <profile.ovpn>."
	case "$pin_route" in
		auto|on|off) ;;
		*) die "--pin-route must be auto, on or off." ;;
	esac

	require_root
	assert_profile_readable "$profile"

	local kind
	kind="$(os_kind)"
	[[ "$kind" != unsupported ]] || die "Unsupported platform: $(uname -s)"

	have openvpn || die "openvpn is not installed. Install it first:
  Debian/Ubuntu : apt-get install -y openvpn
  RHEL/Rocky    : dnf install -y openvpn
  macOS         : brew install openvpn"

	local subnet client_ip server_host
	subnet="$(profile_meta "$profile" subnet)"
	client_ip="$(profile_meta "$profile" client-ip)"
	server_host="$(profile_meta "$profile" server-host)"
	[[ -n "$server_host" ]] || server_host="$(awk '/^[[:space:]]*remote[[:space:]]/ {print $2; exit}' "$profile")"
	[[ -n "$server_host" ]] || die "Could not determine the server host from the profile."

	if [[ -n "$subnet" ]]; then
		validate_cidr "$subnet" || die "Profile carries an invalid subnet: $subnet"
		if ! preflight_quiet "$subnet"; then
			if [[ "$force" == true ]]; then
				warn "Subnet $subnet conflicts with an existing local network; continuing because --force was given."
			else
				die "Subnet $subnet conflicts with an existing local network.
Run 'qp-tunnel-cli open preflight --file $profile' for the details, then either
re-issue the profile with a free subnet or pass --force to override."
			fi
		fi
	else
		warn "Profile has no '# qp-open-subnet:' header; skipping the collision check."
	fi

	if [[ -e "$QP_OPEN_CONFIG" && "$force" != true ]]; then
		die "Instance '$QP_OPEN_INSTANCE' is already enrolled at $QP_OPEN_CONFIG.
Use --force to replace it, or pick another --instance."
	fi

	mkdir -p "$QP_OPEN_HOME"
	chmod 0700 "$QP_OPEN_HOME"

	capture_snapshot

	install -m 0600 "$profile" "$QP_OPEN_PROFILE"
	write_client_config "$server_host"

	local pinned="none"
	if [[ "$kind" == linux ]]; then
		pinned="$(maybe_pin_server_route "$server_host" "$pin_route")"
		install_systemd_unit
	else
		install_launchd_plist
	fi

	write_state "$server_host" "${subnet:-}" "${client_ip:-}" "$pinned"

	info "Enrolled instance '$QP_OPEN_INSTANCE'."
	info "  interface : $QP_OPEN_DEV"
	info "  config    : $QP_OPEN_CONFIG"
	info "  server    : $server_host"
	[[ -n "$client_ip" ]] && info "  address   : $client_ip"
	info "  egress    : off (routing unchanged; enable with 'open egress on')"

	if [[ "$start" == true ]]; then
		up
	else
		info ""
		info "Not started (--no-start). Start it with: qp-tunnel-cli open up --instance $QP_OPEN_INSTANCE"
	fi
}

preflight_quiet() {
	local subnet="$1" cidr
	while IFS= read -r cidr; do
		[[ -n "$cidr" ]] || continue
		if cidrs_overlap "$subnet" "$cidr"; then
			return 1
		fi
	done < <(local_claimed_cidrs | sort -u)
	return 0
}

enroll_help() {
	cat <<'EOF'
Usage:
  qp-tunnel-cli open enroll --file <profile.ovpn> [options]

Options:
  --instance NAME      Instance namespace, default "mx". One instance per
                       Oversea server; each owns its own interface and unit.
  --no-start           Write the configuration without starting the tunnel.
  --pin-route MODE     auto (default) | on | off. Pins a /32 host route to the
                       OpenVPN server through the physical default gateway so
                       the handshake cannot be captured by a local TUN proxy.
                       "auto" only pins when a tunnel device would capture it.
  --force              Replace an existing enrollment for this instance.

The generated client configuration uses route-nopull and pull-filters, so the
server cannot install routes, a default gateway, or DNS on this host. The only
kernel change is the connected route for the tunnel interface itself.
EOF
}

# ---------------------------------------------------------------------------
# Configuration rendering
# ---------------------------------------------------------------------------

# Cipher negotiation, spelled for the openvpn on this host. 2.5 replaced
# ncp-ciphers with data-ciphers, and RHEL still ships 2.4, where data-ciphers is
# a fatal "Unrecognized option". Deriving this locally rather than copying it
# out of the profile means a spoke works regardless of which server version
# issued its profile.
render_client_ciphers() {
	if client_openvpn_at_least_2_5; then
		echo "data-ciphers AES-256-GCM:AES-128-GCM"
		echo "data-ciphers-fallback AES-256-GCM"
	else
		echo "cipher AES-256-GCM"
		echo "ncp-ciphers AES-256-GCM:AES-128-GCM"
	fi
}

client_openvpn_at_least_2_5() {
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

write_client_config() {
	local server_host="$1"
	local tmp
	tmp="$(mktemp "$QP_OPEN_HOME/.client.conf.XXXXXX")"

	{
		cat <<EOF
# Generated by qp-tunnel-cli open enroll. Do not edit by hand.
# Instance: $QP_OPEN_INSTANCE
client
dev $QP_OPEN_DEV
dev-type tun
resolv-retry infinite
nobind
persist-key
persist-tun
remote-cert-tls server
auth-nocache
verb 3

# The server advertises a subnet topology. route-nopull discards the pushed
# topology along with the routes, so it has to be stated locally or ifconfig
# will fall back to net30 and fail to match the server.
topology subnet

# Spoke mode. Accept the assigned address and nothing else: no routes, no
# gateway, no DNS. OpenVPN >= 2.5 folds dhcp-option into route-nopull, but the
# explicit pull-filters keep older clients (RHEL) equally contained.
route-nopull
pull-filter ignore "redirect-gateway"
pull-filter ignore "dhcp-option"
pull-filter ignore "route"
pull-filter ignore "route-ipv6"
pull-filter ignore "block-outside-dns"
pull-filter ignore "register-dns"

# Level 1, not 0. It forbids user-defined scripts - so nothing can rewrite the
# resolver behind our back - while still allowing openvpn's own built-in
# helpers. RHEL builds openvpn with --enable-iproute2, which configures the
# interface by executing /sbin/ip; level 0 blocks that too and the tunnel dies
# with "Linux ip link set failed: disallowed by script-security setting".
# Script options cannot be pushed by a server, so level 1 gives up nothing.
script-security 1
EOF

		render_client_ciphers

		# Remote lines and inline PKI come straight from the issued profile so
		# the CA/cert/key material is never re-encoded. Cipher directives are
		# deliberately not copied: whether they parse depends on the openvpn
		# installed *here*, not on the version of the server that issued the
		# profile.
		echo ""
		echo "# --- remotes and PKI from the issued profile ---"
		awk '
			/^[[:space:]]*(remote|proto|connect-retry|connect-timeout|remote-random|tls-crypt-v2|auth)[[:space:]]/ { print; next }
			/^[[:space:]]*<(ca|cert|key|tls-auth|tls-crypt)>/ { emit = 1 }
			emit { print }
			/^[[:space:]]*<\/(ca|cert|key|tls-auth|tls-crypt)>/ { emit = 0 }
		' "$QP_OPEN_PROFILE"

		# `key-direction` matters for tls-auth profiles and is easy to lose.
		grep -E '^[[:space:]]*key-direction[[:space:]]' "$QP_OPEN_PROFILE" || true

		if [[ -f "$QP_OPEN_EGRESS_CONF" ]]; then
			echo ""
			echo "# --- egress routes (qp-tunnel-cli open egress) ---"
			echo "config $QP_OPEN_EGRESS_CONF"
		fi
	} > "$tmp"

	grep -qE '^[[:space:]]*remote[[:space:]]' "$tmp" \
		|| { rm -f "$tmp"; die "The profile contains no 'remote' line."; }

	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_OPEN_CONFIG"
	info "Wrote $QP_OPEN_CONFIG"
	# Referenced so the unused-variable check stays honest about the argument.
	: "$server_host"
}

# ---------------------------------------------------------------------------
# Server route pinning
# ---------------------------------------------------------------------------

maybe_pin_server_route() {
	local server_host="$1" mode="$2"
	local server_ip dev physical_dev

	[[ "$mode" == off ]] && { echo none; return 0; }

	server_ip="$(resolve_host_ipv4 "$server_host" || true)"
	if [[ -z "$server_ip" ]]; then
		warn "Could not resolve $server_host to an IPv4 address; skipping route pinning." >&2
		echo none
		return 0
	fi

	physical_dev="$(default_route_dev || true)"
	dev="$(route_dev_for "$server_ip" || true)"

	if [[ "$mode" == auto ]]; then
		# Only pin when the packet would currently leave through something
		# other than the physical default interface, which is what happens when
		# a local TUN proxy or an overlay has claimed the route.
		if [[ -z "$dev" || "$dev" == "$physical_dev" ]]; then
			echo none
			return 0
		fi
		if [[ ! "$dev" =~ ^(tun|tap|utun|wg|mihomo|Meta|ovpn) ]]; then
			echo none
			return 0
		fi
	fi

	local gateway
	gateway="$(default_route_gateway || true)"
	if [[ -z "$gateway" || -z "$physical_dev" ]]; then
		warn "No usable physical default gateway; skipping route pinning." >&2
		echo none
		return 0
	fi

	# Same reason as detect_runtime: capture first, then test, so a SIGPIPE from
	# an early-exiting grep cannot be mistaken for "no existing route" and make
	# this add a duplicate pin.
	local existing_route
	existing_route="$(ip route show "$server_ip/32" 2>/dev/null || true)"
	if [[ -n "$existing_route" ]]; then
		warn "A host route for $server_ip already exists; leaving it untouched." >&2
		echo none
		return 0
	fi

	ip route add "$server_ip/32" via "$gateway" dev "$physical_dev" \
		|| { warn "Failed to pin $server_ip/32 via $gateway dev $physical_dev." >&2; echo none; return 0; }

	info "Pinned $server_ip/32 via $gateway dev $physical_dev" >&2
	echo "$server_ip/32|$gateway|$physical_dev"
}

unpin_server_route() {
	local pinned
	pinned="$(state_field pinnedRoute)"
	[[ -n "$pinned" && "$pinned" != none ]] || return 0

	local cidr gateway dev
	IFS='|' read -r cidr gateway dev <<< "$pinned"
	[[ -n "$cidr" ]] || return 0

	if ip route del "$cidr" via "$gateway" dev "$dev" 2>/dev/null; then
		info "Removed pinned route $cidr via $gateway dev $dev"
	fi
}

# ---------------------------------------------------------------------------
# Service units
#
# These are QPJoy-owned units. The distribution templates openvpn-client@ and
# openvpn-server@ are never created, modified or enabled: on at least one target
# host openvpn-server@server.service is live and belongs to someone else.
# ---------------------------------------------------------------------------

openvpn_binary() {
	command -v openvpn 2>/dev/null || echo /usr/sbin/openvpn
}

systemd_service_type() {
	# Type=notify needs an openvpn built with systemd support. Everything Debian
	# and RHEL ship has it, but a self-compiled or bundled binary may not, and
	# guessing wrong makes the unit hang until its timeout.
	if openvpn --version 2>/dev/null | grep -q 'enable_systemd=yes'; then
		echo notify
	else
		echo simple
	fi
}

install_systemd_unit() {
	have systemctl || die "systemd is required on Linux hosts."

	if [[ -e "$QP_OPEN_UNIT_TEMPLATE" ]] && ! grep -q 'qp-tunnel-cli' "$QP_OPEN_UNIT_TEMPLATE"; then
		die "$QP_OPEN_UNIT_TEMPLATE exists and was not written by qp-tunnel-cli. Refusing to overwrite it."
	fi

	local binary type
	binary="$(openvpn_binary)"
	type="$(systemd_service_type)"

	cat > "$QP_OPEN_UNIT_TEMPLATE" <<EOF
# Generated by qp-tunnel-cli open enroll. Do not edit by hand.
# Deliberately separate from the distribution openvpn-client@/openvpn-server@
# templates so a QPJoy spoke can never disturb an unrelated OpenVPN install.
[Unit]
Description=QPJoy OpenVPN spoke client (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=$type
WorkingDirectory=/etc/qp-openvpn/%i
ExecStart=$binary --config /etc/qp-openvpn/%i/client.conf --cd /etc/qp-openvpn/%i --status /var/run/qp-openvpn-%i.status 10
Restart=on-failure
RestartSec=5
KillMode=process
LimitNPROC=100

[Install]
WantedBy=multi-user.target
EOF
	chmod 0644 "$QP_OPEN_UNIT_TEMPLATE"
	systemctl daemon-reload
	info "Installed $QP_OPEN_UNIT_TEMPLATE"
}

install_launchd_plist() {
	local binary
	binary="$(openvpn_binary)"

	if [[ -e "$QP_OPEN_PLIST" ]] && ! grep -q 'qp-tunnel-cli' "$QP_OPEN_PLIST"; then
		die "$QP_OPEN_PLIST exists and was not written by qp-tunnel-cli. Refusing to overwrite it."
	fi

	cat > "$QP_OPEN_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by qp-tunnel-cli open enroll. Do not edit by hand. -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$QP_OPEN_PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$binary</string>
    <string>--config</string><string>$QP_OPEN_CONFIG</string>
    <string>--cd</string><string>$QP_OPEN_HOME</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$QP_OPEN_LOG</string>
  <key>StandardErrorPath</key><string>$QP_OPEN_LOG</string>
</dict>
</plist>
EOF
	chmod 0644 "$QP_OPEN_PLIST"
	info "Installed $QP_OPEN_PLIST"
}

# macOS has no persistent tun name, so `dev ovpn-mx` is rewritten to a utun.
adjust_config_for_darwin() {
	[[ "$(os_kind)" == darwin ]] || return 0
	local tmp
	tmp="$(mktemp "$QP_OPEN_HOME/.client.conf.XXXXXX")"
	sed -e "s/^dev $QP_OPEN_DEV\$/dev utun/" -e '/^dev-type tun$/d' "$QP_OPEN_CONFIG" > "$tmp"
	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_OPEN_CONFIG"
}

# ---------------------------------------------------------------------------
# Lifecycle
# ---------------------------------------------------------------------------

assert_enrolled() {
	[[ -f "$QP_OPEN_CONFIG" ]] \
		|| die "Instance '$QP_OPEN_INSTANCE' is not enrolled. Run: qp-tunnel-cli open enroll --file <profile.ovpn> --instance $QP_OPEN_INSTANCE"
}

up() {
	require_root
	assert_enrolled
	adjust_config_for_darwin

	case "$(os_kind)" in
		linux)
			systemctl enable "$QP_OPEN_UNIT" >/dev/null 2>&1 || true
			systemctl restart "$QP_OPEN_UNIT"
			info "Started $QP_OPEN_UNIT"
			;;
		darwin)
			launchctl unload "$QP_OPEN_PLIST" 2>/dev/null || true
			launchctl load -w "$QP_OPEN_PLIST"
			info "Loaded $QP_OPEN_PLIST_LABEL"
			;;
	esac

	wait_for_tunnel_address
}

wait_for_tunnel_address() {
	local expected attempt=0 address=""
	expected="$(state_field clientIp)"

	while [[ "$attempt" -lt 20 ]]; do
		address="$(current_tunnel_address || true)"
		[[ -n "$address" ]] && break
		attempt=$((attempt + 1))
		sleep 1
	done

	if [[ -z "$address" ]]; then
		echo "" >&2
		echo "The tunnel did not come up: $QP_OPEN_DEV has no address." >&2
		if ! client_is_running; then
			echo "The service is not running either. Last log lines:" >&2
		else
			echo "The service is running but never got an address. Last log lines:" >&2
		fi
		echo "" >&2
		client_recent_logs 30 >&2 || true
		echo "" >&2
		die "Tunnel start failed. Full log: qp-tunnel-cli open logs --instance $QP_OPEN_INSTANCE"
	fi

	info "Tunnel address: $address"
	if [[ -n "$expected" && "$expected" != "$address" ]]; then
		warn "Expected $expected from the profile; the server assigned $address."
		warn "Without a client-config-dir entry the server hands out pool addresses,"
		warn "which are not stable across reconnects."
	fi
	return 0
}

client_is_running() {
	case "$(os_kind)" in
		linux) systemctl is-active --quiet "$QP_OPEN_UNIT" ;;
		darwin) launchctl list 2>/dev/null | grep -q "$QP_OPEN_PLIST_LABEL" ;;
		*) return 1 ;;
	esac
}

client_recent_logs() {
	local lines="${1:-100}"
	case "$(os_kind)" in
		linux) journalctl -u "$QP_OPEN_UNIT" -n "$lines" --no-pager 2>&1 ;;
		darwin) [[ -f "$QP_OPEN_LOG" ]] && tail -n "$lines" "$QP_OPEN_LOG" 2>&1 ;;
	esac
}

current_tunnel_address() {
	case "$(os_kind)" in
		linux)
			ip -4 -o addr show dev "$QP_OPEN_DEV" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1
			;;
		darwin)
			local dev
			for dev in $(ifconfig -l 2>/dev/null | tr ' ' '\n' | grep '^utun'); do
				if ifconfig "$dev" 2>/dev/null | grep -q "inet "; then
					local candidate
					candidate="$(ifconfig "$dev" 2>/dev/null | awk '/inet /{print $2; exit}')"
					local subnet
					subnet="$(state_field subnet)"
					if [[ -n "$subnet" ]] && cidrs_overlap "$candidate/32" "$subnet"; then
						echo "$candidate"
						return 0
					fi
				fi
			done
			;;
	esac
}

down() {
	require_root
	case "$(os_kind)" in
		linux)
			systemctl stop "$QP_OPEN_UNIT" 2>/dev/null || true
			systemctl disable "$QP_OPEN_UNIT" >/dev/null 2>&1 || true
			info "Stopped $QP_OPEN_UNIT"
			;;
		darwin)
			launchctl unload "$QP_OPEN_PLIST" 2>/dev/null || true
			info "Unloaded $QP_OPEN_PLIST_LABEL"
			;;
	esac
	unpin_server_route
}

restart() {
	down
	up
}

status() {
	assert_enrolled

	info "Instance : $QP_OPEN_INSTANCE"
	info "Interface: $QP_OPEN_DEV"
	info "Server   : $(state_field serverHost)"
	info "Subnet   : $(state_field subnet)"
	info "Expected : $(state_field clientIp)"
	info "Egress   : $(egress_mode)"
	info "Pinned   : $(state_field pinnedRoute)"
	info ""

	case "$(os_kind)" in
		linux)
			systemctl is-active "$QP_OPEN_UNIT" >/dev/null 2>&1 \
				&& info "Service  : active" \
				|| info "Service  : inactive"
			;;
		darwin)
			launchctl list 2>/dev/null | grep -q "$QP_OPEN_PLIST_LABEL" \
				&& info "Service  : loaded" \
				|| info "Service  : not loaded"
			;;
	esac

	local address
	address="$(current_tunnel_address || true)"
	if [[ -n "$address" ]]; then
		info "Address  : $address"
	else
		info "Address  : (none; tunnel is not up)"
	fi

	if [[ -f "$QP_OPEN_STATUS_FILE" ]]; then
		info ""
		info "--- OpenVPN status ---"
		head -20 "$QP_OPEN_STATUS_FILE"
	fi
}

logs() {
	[[ "$(os_kind)" != linux ]] || have journalctl || die "journalctl is not available."
	[[ "$(os_kind)" != darwin || -f "$QP_OPEN_LOG" ]] || die "No log at $QP_OPEN_LOG"
	client_recent_logs "${1:-100}"
}

routes() {
	assert_enrolled
	info "Routes owned by instance '$QP_OPEN_INSTANCE':"
	case "$(os_kind)" in
		linux)
			ip route show dev "$QP_OPEN_DEV" 2>/dev/null | sed 's/^/  /' || info "  (interface is down)"
			local pinned
			pinned="$(state_field pinnedRoute)"
			[[ -n "$pinned" && "$pinned" != none ]] && info "  pinned: ${pinned//|/ via }"
			;;
		darwin)
			netstat -rn -f inet 2>/dev/null | awk -v dev="utun" '$0 ~ dev {print "  " $0}'
			;;
	esac
}

# ---------------------------------------------------------------------------
# doctor: prove that enrollment changed nothing it was not supposed to change
# ---------------------------------------------------------------------------

capture_snapshot() {
	{
		echo "# qp-tunnel-cli open snapshot"
		echo "# captured: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
		echo "## default-route"
		default_route_dev
		default_route_gateway
		echo "## resolv-conf-sha256"
		checksum_of /etc/resolv.conf
		echo "## nat-rules-sha256"
		if have iptables-save; then
			iptables-save -t nat 2>/dev/null | sha_stdin
		else
			echo "-"
		fi
		echo "## routed-cidrs"
		local_claimed_cidrs | sort -u
	} > "$QP_OPEN_SNAPSHOT" 2>/dev/null || true
	chmod 0600 "$QP_OPEN_SNAPSHOT" 2>/dev/null || true
	info "Captured pre-enrollment snapshot at $QP_OPEN_SNAPSHOT"
}

sha_stdin() {
	if have sha256sum; then
		sha256sum | awk '{print $1}'
	elif have shasum; then
		shasum -a 256 | awk '{print $1}'
	else
		echo "-"
	fi
}

checksum_of() {
	local file="$1"
	[[ -f "$file" ]] || { echo "-"; return 0; }
	sha_stdin < "$file"
}

doctor() {
	assert_enrolled
	[[ -f "$QP_OPEN_SNAPSHOT" ]] || die "No pre-enrollment snapshot at $QP_OPEN_SNAPSHOT"

	local failures=0

	local before_resolv now_resolv
	before_resolv="$(awk '/^## resolv-conf-sha256$/{getline; print; exit}' "$QP_OPEN_SNAPSHOT")"
	now_resolv="$(checksum_of /etc/resolv.conf)"
	if [[ "$before_resolv" == "$now_resolv" ]]; then
		info "PASS  /etc/resolv.conf unchanged"
	else
		info "FAIL  /etc/resolv.conf changed since enrollment"
		failures=$((failures + 1))
	fi

	local before_dev now_dev before_gw now_gw
	before_dev="$(awk '/^## default-route$/{getline; print; exit}' "$QP_OPEN_SNAPSHOT")"
	before_gw="$(awk '/^## default-route$/{getline; getline; print; exit}' "$QP_OPEN_SNAPSHOT")"
	now_dev="$(default_route_dev || true)"
	now_gw="$(default_route_gateway || true)"

	if [[ "$(egress_mode)" == off ]]; then
		if [[ "$before_dev" == "$now_dev" && "$before_gw" == "$now_gw" ]]; then
			info "PASS  default route unchanged (dev=$now_dev via $now_gw)"
		else
			info "FAIL  default route changed: was dev=$before_dev via $before_gw, now dev=$now_dev via $now_gw"
			failures=$((failures + 1))
		fi
	else
		info "SKIP  default route (egress is enabled on purpose)"
	fi

	local before_nat now_nat
	before_nat="$(awk '/^## nat-rules-sha256$/{getline; print; exit}' "$QP_OPEN_SNAPSHOT")"
	if have iptables-save; then
		now_nat="$(iptables-save -t nat 2>/dev/null | sha_stdin)"
		if [[ "$before_nat" == "$now_nat" ]]; then
			info "PASS  iptables nat table unchanged"
		else
			info "WARN  iptables nat table changed since enrollment"
			info "      Docker and kube-proxy rewrite this table constantly, so this is"
			info "      only meaningful if nothing else was deployed in the meantime."
		fi
	fi

	local address
	address="$(current_tunnel_address || true)"
	if [[ -n "$address" ]]; then
		info "PASS  tunnel is up with address $address"
	else
		info "FAIL  tunnel has no address"
		failures=$((failures + 1))
	fi

	info ""
	if [[ "$failures" -eq 0 ]]; then
		info "doctor: no regressions detected."
		return 0
	fi
	info "doctor: $failures check(s) failed."
	return 1
}

# ---------------------------------------------------------------------------
# egress: opt-in, reversible, never enabled by enrollment
# ---------------------------------------------------------------------------

egress_mode() {
	[[ -f "$QP_OPEN_EGRESS_CONF" ]] || { echo off; return 0; }
	awk '/^# qp-open-egress-mode:/ {print $3; exit}' "$QP_OPEN_EGRESS_CONF" 2>/dev/null || echo on
}

egress() {
	local action="${1:-}" mode="cn-direct"
	shift || true

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--mode) [[ $# -ge 2 ]] || die "Missing value for --mode."; mode="$2"; shift 2 ;;
			--mode=*) mode="${1#--mode=}"; shift ;;
			--cn-routes) [[ $# -ge 2 ]] || die "Missing value for --cn-routes."; QP_OPEN_CN_ROUTES_FILE="$2"; shift 2 ;;
			--cn-routes=*) QP_OPEN_CN_ROUTES_FILE="${1#--cn-routes=}"; shift ;;
			--help|-h) egress_help; return 0 ;;
			*) die "Unknown egress option: $1" ;;
		esac
	done

	case "$action" in
		on) egress_on "$mode" ;;
		off) egress_off ;;
		status|"") info "Egress: $(egress_mode)" ;;
		*) die "Unknown egress action: $action (expected on, off or status)" ;;
	esac
}

egress_on() {
	local mode="$1"
	require_root
	assert_enrolled

	case "$mode" in
		full|cn-direct) ;;
		*) die "--mode must be full or cn-direct." ;;
	esac

	[[ "$(os_kind)" == linux ]] \
		|| die "egress is Linux-only in this release. On macOS, connect in spoke mode and use a proxy client for egress."

	local allowed
	allowed="$(profile_meta "$QP_OPEN_PROFILE" egress)"
	if [[ "$allowed" == denied ]]; then
		die "This profile was issued without egress. Re-issue it on the server with:
  qp-tunnel-cli open create <name> --oversea"
	fi

	local server_ip gateway physical_dev
	server_ip="$(resolve_host_ipv4 "$(state_field serverHost)" || true)"
	gateway="$(default_route_gateway || true)"
	physical_dev="$(default_route_dev || true)"
	[[ -n "$gateway" ]] || die "No default gateway; refusing to enable egress."

	local tmp
	tmp="$(mktemp "$QP_OPEN_HOME/.egress.conf.XXXXXX")"
	{
		echo "# Generated by qp-tunnel-cli open egress on. Do not edit by hand."
		echo "# qp-open-egress-mode: $mode"
		echo ""
		echo "# Send the default route through the tunnel using two /1 routes so the"
		echo "# original default route is preserved underneath and restored on exit."
		echo "redirect-gateway def1 bypass-dhcp"
		echo ""
		echo "# The server itself must stay reachable through the physical link, or"
		echo "# the tunnel would have to route its own transport."
		[[ -n "$server_ip" ]] && echo "route $server_ip 255.255.255.255 net_gateway"
		echo ""
		echo "# Everything this host already routes locally stays local: LAN, Docker"
		echo "# bridges, the CNI, WireGuard overlays and the existing OpenVPN server."
		emit_local_direct_routes

		if [[ "$mode" == cn-direct ]]; then
			echo ""
			echo "# China-direct split. Pure OpenVPN has no domain rules, so this is an"
			echo "# IP-prefix approximation: good enough to keep domestic traffic off the"
			echo "# tunnel, not equivalent to a Clash ruleset."
			local cn_file
			cn_file="$(resolve_cn_routes_file)"
			if [[ -n "$cn_file" ]]; then
				emit_cn_routes "$cn_file"
			else
				warn "No China route list found; egress will send all non-local traffic through the tunnel."
			fi
		fi
	} > "$tmp"

	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_OPEN_EGRESS_CONF"

	local server_host
	server_host="$(state_field serverHost)"
	write_client_config "$server_host"

	info "Egress enabled (mode: $mode)."
	info "Physical default: dev=${physical_dev:-unknown} via $gateway"
	info "Restarting the tunnel to apply it."
	restart
}

# Renders one `route <net> <mask> net_gateway` line per network this host
# already routes, so enabling egress can never pull the LAN, a Docker bridge,
# the CNI or an existing overlay into the tunnel.
emit_local_direct_routes() {
	local cidr network prefix mask
	while IFS= read -r cidr; do
		[[ -n "$cidr" ]] || continue
		network="${cidr%%/*}"
		prefix="${cidr#*/}"
		[[ "$prefix" == "$cidr" ]] && prefix=32
		mask="$(cidr_to_netmask "$prefix")"
		echo "route $network $mask net_gateway"
	done < <(local_direct_cidrs)
}

resolve_cn_routes_file() {
	local candidate
	for candidate in \
		"$QP_OPEN_CN_ROUTES_FILE" \
		"$QP_OPEN_HOME/china-ipv4.txt" \
		"$(dirname "${BASH_SOURCE[0]}")/china-ipv4-coarse.txt" \
		"$(dirname "${BASH_SOURCE[0]}")/../ovpn/china-ipv4-coarse.txt"
	do
		[[ -n "$candidate" && -s "$candidate" ]] && { echo "$candidate"; return 0; }
	done
	return 1
}

emit_cn_routes() {
	local file="$1" cidr network prefix mask
	while IFS= read -r cidr; do
		cidr="${cidr%%#*}"
		cidr="${cidr// /}"
		[[ -n "$cidr" ]] || continue
		validate_cidr "$cidr" || continue
		network="${cidr%/*}"
		prefix="${cidr#*/}"
		mask="$(cidr_to_netmask "$prefix")"
		echo "route $network $mask net_gateway"
	done < "$file"
}

egress_off() {
	require_root
	assert_enrolled

	if [[ ! -f "$QP_OPEN_EGRESS_CONF" ]]; then
		info "Egress is already off."
		return 0
	fi

	rm -f "$QP_OPEN_EGRESS_CONF"
	write_client_config "$(state_field serverHost)"
	info "Egress disabled; back to spoke mode."
	restart
}

egress_help() {
	cat <<'EOF'
Usage:
  qp-tunnel-cli open egress on [--mode cn-direct|full] [--cn-routes FILE]
  qp-tunnel-cli open egress off
  qp-tunnel-cli open egress status

Off by default. Enrollment never routes internet traffic through the tunnel.

  cn-direct  Default. Everything except local networks and Chinese IP prefixes
             goes through the Oversea server. This is an IP-prefix split, not a
             domain ruleset: OpenVPN has no equivalent of Clash rules.
  full       Everything except local networks goes through the tunnel.

Local networks are read from the live routing table at the moment egress is
enabled, so LAN, Docker bridges, the CNI, WireGuard overlays and any existing
OpenVPN server all stay direct. Re-run 'egress on' after adding new local
networks so they are picked up.
EOF
}

# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------

write_state() {
	local server_host="$1" subnet="$2" client_ip="$3" pinned="$4"
	local tmp
	tmp="$(mktemp "$QP_OPEN_HOME/.state.json.XXXXXX")"
	cat > "$tmp" <<EOF
{
  "version": 1,
  "instance": "$QP_OPEN_INSTANCE",
  "interface": "$QP_OPEN_DEV",
  "serverHost": "$server_host",
  "subnet": "$subnet",
  "clientIp": "$client_ip",
  "pinnedRoute": "$pinned",
  "unit": "$QP_OPEN_UNIT",
  "enrolledAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
	chmod 0600 "$tmp"
	mv -f "$tmp" "$QP_OPEN_STATE"
}

state_field() {
	local key="$1"
	[[ -f "$QP_OPEN_STATE" ]] || return 0
	awk -v key="\"$key\"" '
		index($0, key) {
			sub(/^[^:]*:[[:space:]]*"/, "")
			sub(/",?[[:space:]]*$/, "")
			print
			exit
		}
	' "$QP_OPEN_STATE"
}

# ---------------------------------------------------------------------------
# uninstall
# ---------------------------------------------------------------------------

uninstall() {
	local purge=false
	while [[ $# -gt 0 ]]; do
		case "$1" in
			--purge) purge=true; shift ;;
			--help|-h) info "Usage: qp-tunnel-cli open uninstall [--purge]"; return 0 ;;
			*) die "Unknown uninstall option: $1" ;;
		esac
	done

	require_root
	down || true

	case "$(os_kind)" in
		linux)
			rm -f "/etc/systemd/system/multi-user.target.wants/$QP_OPEN_UNIT"
			systemctl daemon-reload 2>/dev/null || true
			# The template is shared by every instance; only remove it when this
			# was the last one.
			if [[ -z "$(ls -A /etc/qp-openvpn 2>/dev/null | grep -v "^$QP_OPEN_INSTANCE\$")" ]]; then
				rm -f "$QP_OPEN_UNIT_TEMPLATE"
				systemctl daemon-reload 2>/dev/null || true
				info "Removed $QP_OPEN_UNIT_TEMPLATE (last instance)"
			fi
			;;
		darwin)
			rm -f "$QP_OPEN_PLIST"
			;;
	esac

	rm -f "$QP_OPEN_STATUS_FILE"

	if [[ "$purge" == true ]]; then
		rm -rf "$QP_OPEN_HOME"
		info "Purged $QP_OPEN_HOME"
	else
		rm -f "$QP_OPEN_CONFIG" "$QP_OPEN_EGRESS_CONF"
		info "Removed the generated configuration; profile and state remain in $QP_OPEN_HOME"
		info "Use --purge to remove them too."
	fi

	info "Uninstalled instance '$QP_OPEN_INSTANCE'."
}

# ---------------------------------------------------------------------------

usage() {
	cat <<'EOF'
QPJoy OpenVPN spoke client

Usage:
  qp-tunnel-cli open preflight [--subnet CIDR | --file profile.ovpn]
  qp-tunnel-cli open enroll --file <profile.ovpn> [--no-start] [--pin-route auto|on|off] [--force]
  qp-tunnel-cli open up | down | restart | status | routes | doctor
  qp-tunnel-cli open logs [LINES]
  qp-tunnel-cli open egress on [--mode cn-direct|full] | off | status
  qp-tunnel-cli open uninstall [--purge]

Global option:
  --instance NAME   Instance namespace, default "mx". One per Oversea server.
                    Each instance owns interface ovpn-<name>, /etc/qp-openvpn/
                    <name> and unit qp-openvpn-client@<name>.service.

Enrollment joins this host to an Oversea OpenVPN server as a spoke: the host
receives one stable address the server can reach back on, and nothing else
about the local network changes. Routing internet traffic through the tunnel is
a separate opt-in command ('open egress on') that is always reversible.
EOF
}

main() {
	local command="${1:-help}"
	shift || true

	case "$command" in
		preflight) preflight "$@" ;;
		enroll) enroll "$@" ;;
		up|start) up ;;
		down|stop) down ;;
		restart) restart ;;
		status) status ;;
		logs) logs "$@" ;;
		routes) routes ;;
		doctor) doctor ;;
		egress) egress "$@" ;;
		uninstall) uninstall "$@" ;;
		help|--help|-h) usage ;;
		*) echo "Unknown command: $command" >&2; usage; exit 1 ;;
	esac
}

main "$@"
