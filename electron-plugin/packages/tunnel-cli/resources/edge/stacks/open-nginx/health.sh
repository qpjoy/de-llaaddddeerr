#!/usr/bin/env bash
# Read-only: OpenVPN server running (systemd unit or its container), nginx running and its config valid.
set -euo pipefail
. ./lib/edge-os.sh
. ./lib/edge-nginx.sh
edge_os_detect
set -a
# shellcheck disable=SC1091
. "$MX_STATE_DIR/edge.env"
set +a
inst="${EDGE_OPEN_INSTANCE:-edge}"
runtime="$(sed -n "s/^QP_OPEN_RUNTIME='\{0,1\}\([a-z]*\)'\{0,1\}$/\1/p" "/etc/qp-openvpn-server/$inst/server.env" 2>/dev/null | head -n 1)"
if [ "$runtime" = docker ]; then
  edge_container_running "mx-oversea-openvpn-$inst" || edge_die "container mx-oversea-openvpn-$inst is not running"
  edge_log "OpenVPN container mx-oversea-openvpn-$inst running"
else
  unit="qp-openvpn-server@$inst.service"
  state="$(edge_unit_state "$unit")"
  [ "$state" = active ] || edge_die "$unit is $state"
  edge_log "$unit active"
fi
edge_nginx_health
edge_log "nginx active, config valid"
