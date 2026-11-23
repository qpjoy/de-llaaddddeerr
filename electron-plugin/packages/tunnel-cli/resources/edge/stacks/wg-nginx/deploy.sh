#!/usr/bin/env bash
# wg-nginx: a WireGuard relay the Internal side dials out to, plus nginx sites
# proxied over it. Same shape as the Launcher's Domestic relay `mx-domestic`
# (10.88.0.1/16, Table = off, keys made on Internal): this host has the public
# address and listens; Internal machines connect out to it, so they need no
# public ingress. Unlike mx-domestic there is no forwarding between peers and
# no NAT: only this host talks to the peers, so ip_forward and iptables are
# left as they are.
#
# The relay config comes from the Internal machine (`qp-tunnel-cli edge link
# init` writes wg/relay.conf and wg/relay.env into the state it pushes). nginx
# sites are optional: with no nginx/*.conf in the state only the tunnel is set
# up and nginx is not touched, so the tunnel can come first.
set -euo pipefail
. ./lib/edge-os.sh
. ./lib/edge-nginx.sh
edge_os_detect
edge_require_systemd
edge_log "host: $(edge_os_summary)"

if [ -f "$MX_STATE_DIR/edge.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$MX_STATE_DIR/edge.env"
  set +a
fi
relay_conf="$MX_STATE_DIR/wg/relay.conf"
relay_env="$MX_STATE_DIR/wg/relay.env"
if [ ! -f "$relay_conf" ] || [ ! -f "$relay_env" ]; then
  edge_die "no wg/relay.conf and wg/relay.env in state/$MX_COMPONENT. On the Internal machine: qp-tunnel-cli edge link init <host> (or qp-tunnel-cli edge setup), then push again"
fi
iface="$(edge_kv "$relay_env" EDGE_WG_INTERFACE)"
port="$(edge_kv "$relay_env" EDGE_WG_PORT)"
subnet="$(edge_kv "$relay_env" EDGE_WG_SUBNET)"
link_host="$(edge_kv "$relay_env" EDGE_LINK_HOST)"
case "$iface" in ''|*[!A-Za-z0-9_=+.-]*) edge_die "EDGE_WG_INTERFACE '$iface' in wg/relay.env is not a WireGuard interface name" ;; esac
[ "${#iface}" -le 15 ] || edge_die "EDGE_WG_INTERFACE '$iface' is longer than 15 characters"
case "$port" in ''|*[!0-9]*) edge_die "EDGE_WG_PORT '$port' in wg/relay.env is not a port" ;; esac
edge_cidr_parse "$subnet" >/dev/null || edge_die "EDGE_WG_SUBNET '$subnet' in wg/relay.env is not an IPv4 CIDR"
head -n 1 "$relay_conf" | grep -q '^# qp-tunnel-cli edge link' || edge_die "wg/relay.conf was not written by qp-tunnel-cli edge link init"

if [ "$EDGE_OS_FAMILY" = rhel ] && [ "${EDGE_OS_MAJOR:-0}" -le 7 ] 2>/dev/null; then
  edge_die "CentOS/RHEL 7 kernels have no WireGuard module; use the open-nginx stack there, or a newer release"
fi
if ! edge_have wg || ! edge_have wg-quick; then
  edge_need_epel
  edge_pkg_install wireguard-tools
fi
if ! ip link show "$iface" >/dev/null 2>&1 && [ ! -d /sys/module/wireguard ] && ! modprobe wireguard 2>/dev/null; then
  edge_die "this kernel ($(uname -r)) has no WireGuard module. On EL8, kmod-wireguard from ELRepo provides it; or use the open-nginx stack"
fi

# The subnet must not already be routed somewhere else on this host (Docker
# networks, another VPN). Routes on our own interface are a re-push.
clash="$(edge_route_overlaps "$subnet" "$iface")"
[ -z "$clash" ] || edge_die "$subnet overlaps what this host already routes ($clash). Pick another subnet: edge link init on the Internal machine"

target_dir="${EDGE_WG_DIR:-/etc/wireguard}"
target="$target_dir/$iface.conf"
unit="wg-quick@$iface"
changed=0
if [ -L "$target_dir" ] && [ ! -d "$target_dir" ]; then edge_die "$target_dir is a symlink to a missing directory ($(readlink "$target_dir")); create that directory first"; fi
[ -d "$target_dir" ] || install -d -m 700 "$target_dir"
if [ -e "$target" ]; then
  if edge_same_file "$relay_conf" "$target"; then
    edge_log "$target unchanged"
  elif head -n 1 "$target" | grep -q '^# qp-tunnel-cli edge link'; then
    backup="$target_dir/qp-edge-backup/$MX_COMPONENT/$(date -u +%Y%m%dT%H%M%SZ)-$MX_REVISION"
    mkdir -p "$backup"
    chmod 700 "$target_dir/qp-edge-backup"
    cp -p "$target" "$backup/"
    install -m 600 "$relay_conf" "$target"
    changed=1
    edge_log "$target replaced (the previous one is in $backup)"
  else
    edge_die "$target exists and was not written by qp-tunnel-cli edge link; nothing was changed. Pick another name: edge link init --relay-interface"
  fi
else
  install -m 600 "$relay_conf" "$target"
  changed=1
  edge_log "$target written"
fi

systemctl enable "$unit" >/dev/null 2>&1 || edge_die "systemctl enable $unit failed"
if [ "$(edge_unit_state "$unit")" = active ]; then
  if [ "$changed" = 1 ]; then
    systemctl restart "$unit" || edge_die "systemctl restart $unit failed (journalctl -u $unit)"
    edge_log "$unit restarted with the new config"
  else
    edge_log "$unit already active"
  fi
else
  systemctl start "$unit" || edge_die "systemctl start $unit failed (journalctl -u $unit)"
  edge_log "$unit started"
fi
edge_log "relay $(edge_kv "$relay_env" EDGE_WG_ADDRESS) on $iface, udp $port; peers $(edge_kv "$relay_env" EDGE_WG_PEERS)"

ports="$port/udp"
set -- "$MX_STATE_DIR"/nginx/*.conf
if [ -f "$1" ]; then
  edge_nginx_install
  edge_selinux_proxy_check
  edge_nginx_apply "$MX_COMPONENT" "$MX_REVISION" "$MX_STATE_DIR/nginx" "$MX_STATE_DIR"
  ports="80/tcp 443/tcp $ports"
else
  edge_log "no nginx/*.conf in state/$MX_COMPONENT: tunnel only; nginx was not installed or changed"
fi
# shellcheck disable=SC2086
edge_firewall_report $ports

cat <<NEXT
[edge] Internal side, on the machine that ran edge link init:
[edge]   qp-tunnel-cli edge link up ${link_host:-<host>}      its WireGuard interface (routes only $subnet)
[edge]   qp-tunnel-cli edge link check ${link_host:-<host>}   handshake and ping, both ends
NEXT
