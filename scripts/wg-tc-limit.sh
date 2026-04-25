#!/bin/bash

set -euo pipefail

TC_BIN="${TC_BIN:-/sbin/tc}"
IP_BIN="${IP_BIN:-/sbin/ip}"
DOCKER_BIN="${DOCKER_BIN:-$(command -v docker || true)}"
NSENTER_BIN="${NSENTER_BIN:-$(command -v nsenter || true)}"
IFACE="${IFACE:-wg0}"
LIMITS_FILE="${LIMITS_FILE:-}"
TOTAL_RATE="${TOTAL_RATE:-100mbit}"
BASE_RATE="${BASE_RATE:-1mbit}"
DEFAULT_CEIL="${DEFAULT_CEIL:-}"
DOCKER_CONTAINER="${DOCKER_CONTAINER:-}"
NETNS_PID="${NETNS_PID:-}"
INGRESS_ENABLED="${INGRESS_ENABLED:-false}"
INGRESS_TOTAL_RATE="${INGRESS_TOTAL_RATE:-}"
INGRESS_BASE_RATE="${INGRESS_BASE_RATE:-}"
INGRESS_DEFAULT_CEIL="${INGRESS_DEFAULT_CEIL:-}"
IFB_IFACE="${IFB_IFACE:-}"
MODPROBE_BIN="${MODPROBE_BIN:-$(command -v modprobe || true)}"
ACTION="apply"

usage() {
	cat <<'EOF'
Usage:
  sudo bash ./scripts/wg-tc-limit.sh [apply|clean|show] [options]

Options:
  --if IFACE          WireGuard interface name. Default: wg0
  --docker-container  Run tc against a Docker container's network namespace
  --netns-pid PID     Run tc against an existing network namespace PID
  --ingress           Also shape client->server traffic via ifb
  --ifb IFACE         IFB interface name for ingress shaping
  --limits-file PATH  CSV file: name,cidr,rate,ceil
  --total-rate RATE   Total parent HTB rate. Default: 100mbit
  --base-rate RATE    Per-peer guaranteed minimum. Default: 1mbit
  --default-ceil RATE Default ceil when a CSV row omits ceil. Default: total-rate
  --ingress-total-rate RATE   Ingress parent HTB rate. Default: total-rate
  --ingress-base-rate RATE    Ingress minimum per-peer rate. Default: base-rate
  --ingress-default-ceil RATE Ingress default ceil. Default: ingress-total-rate
  --help              Show this help

CSV example:
  user01,10.13.13.2/32,5mbit,20mbit
  user02,10.13.13.3/32,2mbit,10mbit

Extended CSV example:
  user01,10.13.13.2/32,5mbit,20mbit,2mbit,8mbit
  user02,10.13.13.3/32,2mbit,10mbit,1mbit,5mbit

Notes:
  - This follows the same egress-shaping idea as scripts/iptables_tc.sh
  - Matching is IPv4 only and applies to packets leaving the WG interface
  - For Docker WG, prefer: --docker-container wg-mihomo-wireguard --if wg0
EOF
}

trim_spaces() {
	sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<< "$1"
}

clean_qdisc() {
	tc_run qdisc del dev "$IFACE" root 2>/dev/null || true
	tc_run qdisc del dev "$IFACE" ingress 2>/dev/null || true
	if ip_run link show "$IFB_IFACE" >/dev/null 2>&1; then
		tc_run qdisc del dev "$IFB_IFACE" root 2>/dev/null || true
		ip_run link set dev "$IFB_IFACE" down 2>/dev/null || true
		ip_run link delete "$IFB_IFACE" type ifb 2>/dev/null || true
	fi
}

resolve_netns_pid() {
	if [[ -n "$NETNS_PID" ]]; then
		return
	fi

	if [[ -n "$DOCKER_CONTAINER" ]]; then
		if [[ -z "$DOCKER_BIN" ]] || ! command -v "$DOCKER_BIN" >/dev/null 2>&1; then
			echo "docker command not found, cannot resolve container PID." >&2
			exit 1
		fi

		NETNS_PID="$("$DOCKER_BIN" inspect -f '{{.State.Pid}}' "$DOCKER_CONTAINER" 2>/dev/null || true)"
		if [[ -z "$NETNS_PID" || "$NETNS_PID" == "0" ]]; then
			echo "Failed to resolve running PID for container: $DOCKER_CONTAINER" >&2
			exit 1
		fi
	fi
}

tc_run() {
	if [[ -n "$NETNS_PID" ]]; then
		"$NSENTER_BIN" -t "$NETNS_PID" -n "$TC_BIN" "$@"
	else
		"$TC_BIN" "$@"
	fi
}

ip_run() {
	if [[ -n "$NETNS_PID" ]]; then
		"$NSENTER_BIN" -t "$NETNS_PID" -n "$IP_BIN" "$@"
	else
		"$IP_BIN" "$@"
	fi
}

ensure_ifb_name() {
	if [[ -z "$IFB_IFACE" ]]; then
		IFB_IFACE="ifb-${IFACE}"
	fi
	IFB_IFACE="${IFB_IFACE:0:15}"
}

ensure_ifb_module() {
	if [[ -n "$MODPROBE_BIN" ]] && command -v "$MODPROBE_BIN" >/dev/null 2>&1; then
		"$MODPROBE_BIN" ifb >/dev/null 2>&1 || true
	fi
}

setup_ingress_path() {
	ensure_ifb_module

	if ip_run link show "$IFB_IFACE" >/dev/null 2>&1; then
		ip_run link set dev "$IFB_IFACE" down 2>/dev/null || true
		ip_run link delete "$IFB_IFACE" type ifb 2>/dev/null || true
	fi

	ip_run link add "$IFB_IFACE" type ifb
	ip_run link set dev "$IFB_IFACE" up

	tc_run qdisc add dev "$IFACE" ingress
	tc_run filter add dev "$IFACE" parent ffff: protocol ip u32 match u32 0 0 \
		action mirred egress redirect dev "$IFB_IFACE"

	tc_run qdisc add dev "$IFB_IFACE" root handle 2: htb default 999
	tc_run class add dev "$IFB_IFACE" parent 2: classid 2:1 htb rate "$INGRESS_TOTAL_RATE" ceil "$INGRESS_TOTAL_RATE"
	tc_run class add dev "$IFB_IFACE" parent 2:1 classid 2:999 htb rate 1kbit ceil "$INGRESS_DEFAULT_CEIL"
}

ensure_requirements() {
	if [[ "$EUID" -ne 0 ]]; then
		echo "This script needs to run as root." >&2
		exit 1
	fi

	if ! command -v "$TC_BIN" >/dev/null 2>&1; then
		echo "tc command not found: $TC_BIN" >&2
		exit 1
	fi

	if ! command -v "$IP_BIN" >/dev/null 2>&1; then
		echo "ip command not found: $IP_BIN" >&2
		exit 1
	fi

	resolve_netns_pid

	if [[ -n "$NETNS_PID" ]]; then
		if [[ -z "$NSENTER_BIN" ]] || ! command -v "$NSENTER_BIN" >/dev/null 2>&1; then
			echo "nsenter command not found, required for --docker-container/--netns-pid." >&2
			exit 1
		fi
	fi

	if ! ip_run link show "$IFACE" >/dev/null 2>&1; then
		echo "Interface not found: $IFACE" >&2
		exit 1
	fi

	ensure_ifb_name
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		apply|clean|show)
			ACTION="$1"
			shift
		;;
		--if)
			IFACE="$2"
			shift 2
		;;
		--docker-container)
			DOCKER_CONTAINER="$2"
			shift 2
		;;
		--netns-pid)
			NETNS_PID="$2"
			shift 2
		;;
		--ingress)
			INGRESS_ENABLED="true"
			shift
		;;
		--ifb)
			IFB_IFACE="$2"
			shift 2
		;;
		--limits-file)
			LIMITS_FILE="$2"
			shift 2
		;;
		--total-rate)
			TOTAL_RATE="$2"
			shift 2
		;;
		--base-rate)
			BASE_RATE="$2"
			shift 2
		;;
		--default-ceil)
			DEFAULT_CEIL="$2"
			shift 2
		;;
		--ingress-total-rate)
			INGRESS_TOTAL_RATE="$2"
			shift 2
		;;
		--ingress-base-rate)
			INGRESS_BASE_RATE="$2"
			shift 2
		;;
		--ingress-default-ceil)
			INGRESS_DEFAULT_CEIL="$2"
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

ensure_requirements

if [[ -z "$DEFAULT_CEIL" ]]; then
	DEFAULT_CEIL="$TOTAL_RATE"
fi

if [[ -z "$INGRESS_TOTAL_RATE" ]]; then
	INGRESS_TOTAL_RATE="$TOTAL_RATE"
fi

if [[ -z "$INGRESS_BASE_RATE" ]]; then
	INGRESS_BASE_RATE="$BASE_RATE"
fi

if [[ -z "$INGRESS_DEFAULT_CEIL" ]]; then
	INGRESS_DEFAULT_CEIL="$INGRESS_TOTAL_RATE"
fi

case "$ACTION" in
	clean)
		clean_qdisc
		echo "Cleared tc qdisc on $IFACE"
		exit 0
	;;
	show)
		tc_run -s class show dev "$IFACE"
		echo
		tc_run filter show dev "$IFACE"
		if ip_run link show "$IFB_IFACE" >/dev/null 2>&1; then
			echo
			tc_run -s class show dev "$IFB_IFACE"
			echo
			tc_run filter show dev "$IFB_IFACE"
		fi
		exit 0
	;;
esac

if [[ -z "$LIMITS_FILE" ]]; then
	echo "--limits-file is required for apply." >&2
	exit 1
fi

if [[ ! -f "$LIMITS_FILE" ]]; then
	echo "Limits file not found: $LIMITS_FILE" >&2
	exit 1
fi

clean_qdisc

tc_run qdisc add dev "$IFACE" root handle 1: htb default 999
tc_run class add dev "$IFACE" parent 1: classid 1:1 htb rate "$TOTAL_RATE" ceil "$TOTAL_RATE"
tc_run class add dev "$IFACE" parent 1:1 classid 1:999 htb rate 1kbit ceil "$DEFAULT_CEIL"

if [[ "$INGRESS_ENABLED" == "true" ]]; then
	setup_ingress_path
fi

count=0
while IFS=, read -r raw_name raw_cidr raw_rate raw_ceil raw_ingress_rate raw_ingress_ceil; do
	name=$(trim_spaces "${raw_name:-}")
	cidr=$(trim_spaces "${raw_cidr:-}")
	rate=$(trim_spaces "${raw_rate:-}")
	ceil=$(trim_spaces "${raw_ceil:-}")
	ingress_rate=$(trim_spaces "${raw_ingress_rate:-}")
	ingress_ceil=$(trim_spaces "${raw_ingress_ceil:-}")

	if [[ -z "$name" || "$name" == \#* ]]; then
		continue
	fi

	if [[ -z "$cidr" ]]; then
		echo "Missing cidr for peer '$name' in $LIMITS_FILE" >&2
		exit 1
	fi

	if [[ -z "$rate" ]]; then
		rate="$BASE_RATE"
	fi

	if [[ -z "$ceil" ]]; then
		ceil="$DEFAULT_CEIL"
	fi

	if [[ -z "$ingress_rate" ]]; then
		ingress_rate="$rate"
	fi

	if [[ -z "$ingress_ceil" ]]; then
		ingress_ceil="$ceil"
	fi

	minor=$((10 + count))
	classid="1:${minor}"

	tc_run class add dev "$IFACE" parent 1:1 classid "$classid" htb rate "$rate" ceil "$ceil"
	tc_run filter add dev "$IFACE" protocol ip parent 1: prio 1 u32 match ip dst "$cidr" flowid "$classid"

	if [[ "$INGRESS_ENABLED" == "true" ]]; then
		ingress_classid="2:${minor}"
		tc_run class add dev "$IFB_IFACE" parent 2:1 classid "$ingress_classid" htb rate "$ingress_rate" ceil "$ingress_ceil"
		tc_run filter add dev "$IFB_IFACE" protocol ip parent 2: prio 1 u32 match ip src "$cidr" flowid "$ingress_classid"
		echo "Applied $name -> $cidr down=$rate/$ceil up=$ingress_rate/$ingress_ceil classid=$classid ingress_classid=$ingress_classid"
	else
		echo "Applied $name -> $cidr rate=$rate ceil=$ceil classid=$classid"
	fi
	count=$((count + 1))
done < "$LIMITS_FILE"

echo
if [[ -n "$DOCKER_CONTAINER" ]]; then
	echo "Applied $count tc rule(s) on $IFACE inside container $DOCKER_CONTAINER"
elif [[ -n "$NETNS_PID" ]]; then
	echo "Applied $count tc rule(s) on $IFACE inside netns pid $NETNS_PID"
else
	echo "Applied $count tc rule(s) on $IFACE"
fi
