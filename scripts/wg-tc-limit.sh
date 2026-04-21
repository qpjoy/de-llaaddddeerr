#!/bin/bash

set -euo pipefail

TC_BIN="${TC_BIN:-/sbin/tc}"
IFACE="${IFACE:-wg0}"
LIMITS_FILE="${LIMITS_FILE:-}"
TOTAL_RATE="${TOTAL_RATE:-100mbit}"
BASE_RATE="${BASE_RATE:-1mbit}"
DEFAULT_CEIL="${DEFAULT_CEIL:-}"
ACTION="apply"

usage() {
	cat <<'EOF'
Usage:
  sudo bash ./scripts/wg-tc-limit.sh [apply|clean|show] [options]

Options:
  --if IFACE          WireGuard interface name. Default: wg0
  --limits-file PATH  CSV file: name,cidr,rate,ceil
  --total-rate RATE   Total parent HTB rate. Default: 100mbit
  --base-rate RATE    Per-peer guaranteed minimum. Default: 1mbit
  --default-ceil RATE Default ceil when a CSV row omits ceil. Default: total-rate
  --help              Show this help

CSV example:
  user01,10.13.13.2/32,5mbit,20mbit
  user02,10.13.13.3/32,2mbit,10mbit

Notes:
  - This follows the same egress-shaping idea as scripts/iptables_tc.sh
  - Matching is IPv4 only and applies to packets leaving the WG interface
EOF
}

trim_spaces() {
	sed 's/^[[:space:]]*//;s/[[:space:]]*$//' <<< "$1"
}

clean_qdisc() {
	"$TC_BIN" qdisc del dev "$IFACE" root 2>/dev/null || true
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

	if ! ip link show "$IFACE" >/dev/null 2>&1; then
		echo "Interface not found: $IFACE" >&2
		exit 1
	fi
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

case "$ACTION" in
	clean)
		clean_qdisc
		echo "Cleared tc qdisc on $IFACE"
		exit 0
	;;
	show)
		"$TC_BIN" -s class show dev "$IFACE"
		echo
		"$TC_BIN" filter show dev "$IFACE"
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

"$TC_BIN" qdisc add dev "$IFACE" root handle 1: htb default 999
"$TC_BIN" class add dev "$IFACE" parent 1: classid 1:1 htb rate "$TOTAL_RATE" ceil "$TOTAL_RATE"
"$TC_BIN" class add dev "$IFACE" parent 1:1 classid 1:999 htb rate 1kbit ceil "$DEFAULT_CEIL"

count=0
while IFS=, read -r raw_name raw_cidr raw_rate raw_ceil; do
	name=$(trim_spaces "${raw_name:-}")
	cidr=$(trim_spaces "${raw_cidr:-}")
	rate=$(trim_spaces "${raw_rate:-}")
	ceil=$(trim_spaces "${raw_ceil:-}")

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

	minor=$((10 + count))
	classid="1:${minor}"

	"$TC_BIN" class add dev "$IFACE" parent 1:1 classid "$classid" htb rate "$rate" ceil "$ceil"
	"$TC_BIN" filter add dev "$IFACE" protocol ip parent 1: prio 1 u32 match ip dst "$cidr" flowid "$classid"

	echo "Applied $name -> $cidr rate=$rate ceil=$ceil classid=$classid"
	count=$((count + 1))
done < "$LIMITS_FILE"

echo
echo "Applied $count tc rule(s) on $IFACE"
