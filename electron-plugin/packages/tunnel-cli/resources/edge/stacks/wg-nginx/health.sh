#!/usr/bin/env bash
# Read-only: the relay unit is up (peers without a handshake yet are reported,
# not failed: the Internal side comes up after the first push); nginx running
# with a valid config when this component has sites; optional URL below 500.
set -euo pipefail
. ./lib/edge-os.sh
. ./lib/edge-nginx.sh
edge_os_detect
if [ -f "$MX_STATE_DIR/edge.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$MX_STATE_DIR/edge.env"
  set +a
fi
iface="$(edge_kv "$MX_STATE_DIR/wg/relay.env" EDGE_WG_INTERFACE)"
unit="wg-quick@$iface.service"
state="$(edge_unit_state "$unit")"
[ "$state" = active ] || edge_die "$unit is $state"
edge_log "$unit active"
now="$(date +%s)"
while read -r key at; do
  [ -n "$key" ] || continue
  if [ "${at:-0}" = 0 ]; then
    edge_log "  peer ${key:0:8}...: no handshake yet (edge link up on the Internal machine)"
  else
    edge_log "  peer ${key:0:8}...: last handshake $((now - at))s ago"
  fi
done < <(wg show "$iface" latest-handshakes 2>/dev/null || true)

set -- "${EDGE_NGINX_CONF_DIR:-/etc/nginx/conf.d}/qp-edge-${MX_COMPONENT}--"*.conf
if [ -f "$1" ]; then
  edge_nginx_health
  edge_log "nginx active, config valid"
else
  edge_log "no nginx sites for $MX_COMPONENT"
fi
