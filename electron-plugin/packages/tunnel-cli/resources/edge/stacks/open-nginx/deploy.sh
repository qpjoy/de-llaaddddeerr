#!/usr/bin/env bash
# open-nginx: OpenVPN server (the Internal side connects as a spoke) + nginx sites proxied over the tunnel.
set -euo pipefail
. ./lib/edge-os.sh
. ./lib/edge-nginx.sh
edge_os_detect
edge_require_systemd
edge_log "host: $(edge_os_summary)"

set -a
# shellcheck disable=SC1091
. "$MX_STATE_DIR/edge.env"
set +a
inst="${EDGE_OPEN_INSTANCE:-edge}"
port="${EDGE_OPEN_PORT:-1194}"
proto="${EDGE_OPEN_PROTO:-udp}"
[ -n "${EDGE_OPEN_SUBNET:-}" ] || edge_die "EDGE_OPEN_SUBNET is empty in edge.env (pick a block that overlaps nothing on either end)"

# openvpn and easy-rsa live in EPEL on every RHEL-family release.
[ "$EDGE_OS_FAMILY" != rhel ] || edge_need_epel
edge_nginx_install

# Created once, then owned by `qp-tunnel-cli open` on this host (clients, keys, port).
if [ -e "/etc/qp-openvpn-server/$inst/server.env" ]; then
  edge_log "OpenVPN server instance '$inst' already exists; left as it is"
else
  set -- install --instance "$inst" --subnet "$EDGE_OPEN_SUBNET" --port "$port" --proto "$proto" --runtime "${EDGE_OPEN_RUNTIME:-host}"
  [ -z "${EDGE_PUBLIC_HOST:-}" ] || set -- "$@" --host "$EDGE_PUBLIC_HOST"
  edge_log "creating OpenVPN server instance '$inst' ($EDGE_OPEN_SUBNET, $proto $port)"
  QP_OPENS_INSTANCE="$inst" bash ./vendor/scripts/openvpn-server.sh "$@"
fi

edge_selinux_proxy_check
edge_nginx_apply "$MX_COMPONENT" "$MX_REVISION" "$MX_STATE_DIR/nginx" "$MX_STATE_DIR"
edge_firewall_report 80/tcp 443/tcp "$port/$proto"

cat <<NEXT
[edge] Internal side of the tunnel, once:
[edge]   on this host: sudo bash $MX_ROOT/current/$MX_COMPONENT/vendor/scripts/openvpn-server.sh create <peer> --instance $inst
[edge]   on Internal:  sudo qp-tunnel-cli open enroll --file <peer>.ovpn
NEXT
