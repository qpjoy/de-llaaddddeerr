#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXACT_OUTPUT_FILE="${1:-$SCRIPT_DIR/china-ipv4.txt}"
COARSE_OUTPUT_FILE="${2:-$SCRIPT_DIR/china-ipv4-coarse.txt}"
APNIC_DELEGATED_URL="https://ftp.apnic.net/apnic/stats/apnic/delegated-apnic-latest"
CHINA_COARSE_PREFIX="${CHINA_COARSE_PREFIX:-10}"

tmp_file=$(mktemp)
trap 'rm -f "$tmp_file"' EXIT

if ! [[ "$CHINA_COARSE_PREFIX" =~ ^[0-9]+$ ]] || [[ "$CHINA_COARSE_PREFIX" -lt 8 || "$CHINA_COARSE_PREFIX" -gt 24 ]]; then
	echo "CHINA_COARSE_PREFIX must be an integer between 8 and 24." >&2
	exit 1
fi

if hash curl 2>/dev/null; then
	curl -fsSL "$APNIC_DELEGATED_URL" -o "$tmp_file"
elif hash wget 2>/dev/null; then
	wget -qO "$tmp_file" "$APNIC_DELEGATED_URL"
else
	echo "Neither curl nor wget is installed." >&2
	exit 1
fi

if ! hash python3 2>/dev/null; then
	echo "python3 is required to collapse China IPv4 ranges safely." >&2
	exit 1
fi

python3 - "$tmp_file" "$EXACT_OUTPUT_FILE" "$COARSE_OUTPUT_FILE" "$APNIC_DELEGATED_URL" "$CHINA_COARSE_PREFIX" <<'PY'
import ipaddress
import sys
from pathlib import Path
from datetime import datetime, timezone

source_path = Path(sys.argv[1])
exact_output_path = Path(sys.argv[2])
coarse_output_path = Path(sys.argv[3])
source_url = sys.argv[4]
coarse_prefix = int(sys.argv[5])

networks = []
for raw_line in source_path.read_text().splitlines():
    parts = raw_line.strip().split("|")
    if len(parts) < 7 or parts[1] != "CN" or parts[2] != "ipv4":
        continue
    network = parts[3]
    count = int(parts[4])
    prefix = 32 - (count.bit_length() - 1)
    networks.append(ipaddress.ip_network(f"{network}/{prefix}", strict=True))

collapsed = list(ipaddress.collapse_addresses(networks))

coarse_networks = []
for network in collapsed:
    widened = network
    while widened.prefixlen > coarse_prefix:
        widened = widened.supernet()
    coarse_networks.append(widened)

coarse_collapsed = list(
    ipaddress.collapse_addresses(
        sorted(set(coarse_networks), key=lambda net: (int(net.network_address), net.prefixlen))
    )
)

timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

with exact_output_path.open("w", encoding="utf-8") as fh:
    fh.write(f"# Generated from {source_url}\n")
    fh.write(f"# Updated at {timestamp}\n")
    fh.write("# Exact collapsed China IPv4 ranges\n")
    for network in collapsed:
        fh.write(f"{network.with_prefixlen}\n")

with coarse_output_path.open("w", encoding="utf-8") as fh:
    fh.write(f"# Generated from {source_url}\n")
    fh.write(f"# Updated at {timestamp}\n")
    fh.write(f"# Coarse client-side China IPv4 ranges using /{coarse_prefix} supernets\n")
    for network in coarse_collapsed:
        fh.write(f"{network.with_prefixlen}\n")

print(f"exact={len(collapsed)}")
print(f"coarse={len(coarse_collapsed)}")
PY

exact_route_count=$(grep -vcE '^[[:space:]]*(#|$)' "$EXACT_OUTPUT_FILE")
coarse_route_count=$(grep -vcE '^[[:space:]]*(#|$)' "$COARSE_OUTPUT_FILE")
echo "Saved $exact_route_count exact China IPv4 CIDRs to: $EXACT_OUTPUT_FILE"
echo "Saved $coarse_route_count coarse China IPv4 CIDRs (/${CHINA_COARSE_PREFIX}) to: $COARSE_OUTPUT_FILE"
