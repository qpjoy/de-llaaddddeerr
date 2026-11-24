#!/usr/bin/env bash
# Read-only: the unit is active and holds the UDP port from hy2.env.
set -euo pipefail
. ./lib/edge-os.sh
port="$(edge_kv "$MX_STATE_DIR/hy2.env" HY2_PORT)"
unit="qp-edge-$MX_COMPONENT.service"
state=unknown
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  state="$(edge_unit_state "$unit")"
  if [ "$state" = active ]; then
    if ! edge_have ss; then
      edge_log "$unit active (ss is missing here, so udp $port was not checked)"
      exit 0
    fi
    if [ "$(id -u)" = 0 ]; then
      # As root ss names the process: it must be this unit's.
      pid="$(systemctl show -p MainPID "$unit" 2>/dev/null | sed 's/^MainPID=//')"
      if ss -lunp "sport = :$port" 2>/dev/null | grep -q "pid=$pid,"; then
        edge_log "$unit active, listening on udp $port"
        exit 0
      fi
    elif [ -n "$(ss -lun "sport = :$port" 2>/dev/null | sed 1d)" ]; then
      edge_log "$unit active, udp $port is listening"
      exit 0
    fi
  fi
  sleep 1
done
journalctl -u "$unit" -n 20 --no-pager >&2 2>/dev/null || true
edge_die "$unit is $state and not listening on udp ${port:-?}"
