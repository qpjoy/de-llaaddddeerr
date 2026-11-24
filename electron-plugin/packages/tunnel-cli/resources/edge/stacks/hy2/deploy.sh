#!/usr/bin/env bash
# hy2: a Hysteria2 server run by the mihomo engine under systemd. No Docker and
# nothing downloaded on this host: the engine ships in the bundle
# (engine/mihomo.gz for this host's architecture, picked by `qp-tunnel-cli hy2
# push`), and the configuration comes from the pushing machine's state
# (`qp-tunnel-cli hy2 init` writes server.yaml, the self-signed certificate and
# hy2.env; the matching client configuration stays on that machine).
#
# The unit runs current/<component>/bin/mihomo, so a rollback (which switches
# current and reruns the old release's deploy.sh) restarts the old engine with
# the restored state. The server is restarted only when the engine, the
# configuration, the certificate or the unit changed: a restart makes connected
# clients wait for their QUIC idle timeout (about 30 s) before they reconnect.
set -euo pipefail
. ./lib/edge-os.sh
edge_os_detect
edge_require_systemd
edge_log "host: $(edge_os_summary)"

marker='# qp-tunnel-cli hy2'
state="$MX_STATE_DIR"
env_file="$state/hy2.env"
config="$state/server.yaml"
for f in "$env_file" "$config" "$state/tls/server.crt" "$state/tls/server.key"; do
  [ -f "$f" ] || edge_die "missing $f; on the pushing machine: qp-tunnel-cli hy2 push <host>"
done
head -n 1 "$config" | grep -q "^$marker" || edge_die "server.yaml was not written by qp-tunnel-cli hy2"
port="$(edge_kv "$env_file" HY2_PORT)"
case "$port" in ''|*[!0-9]*) edge_die "HY2_PORT '$port' in hy2.env is not a port" ;; esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || edge_die "HY2_PORT $port is out of range"

# The engine must be built for this host.
[ -f ./engine/mihomo.gz ] || edge_die "this bundle has no engine/mihomo.gz; push it with qp-tunnel-cli hy2 push <host>, not edge push"
target="$(head -n 1 ./engine/target 2>/dev/null || true)"
case "$EDGE_ARCH" in
  x86_64|amd64) want=linux-x64 ;;
  aarch64|arm64) want=linux-arm64 ;;
  *) want="unsupported ($EDGE_ARCH)" ;;
esac
[ "$target" = "$want" ] || edge_die "the bundle carries the $target engine; this host needs $want. Push again with qp-tunnel-cli hy2 push <host>"
if [ ! -x ./bin/mihomo ]; then
  mkdir -p ./bin
  gunzip -c ./engine/mihomo.gz > ./bin/mihomo.tmp
  chmod 755 ./bin/mihomo.tmp
  mv ./bin/mihomo.tmp ./bin/mihomo
fi
bin="$MX_RELEASE_DIR/bin/mihomo"
edge_log "engine: $("$bin" -v 2>/dev/null | head -n 1) ($(head -n 1 ./engine/source 2>/dev/null || echo 'source unknown'))"

# Check the configuration with this engine before anything running is touched.
chmod 700 "$state" "$state/tls"
chmod 600 "$config" "$env_file" "$state/tls/server.key"
if ! check="$("$bin" -t -d "$state" -f "$config" 2>&1)"; then
  printf '%s\n' "$check" >&2
  edge_die "the engine rejects server.yaml; nothing was restarted"
fi

unit="qp-edge-$MX_COMPONENT.service"
unit_file="${EDGE_SYSTEMD_DIR:-/etc/systemd/system}/$unit"
if [ -f "$unit_file" ] && ! head -n 1 "$unit_file" | grep -q "^$marker"; then
  edge_die "$unit_file exists and was not written by qp-tunnel-cli hy2; nothing was changed"
fi

# Another program on the UDP port stops the push. Our own unit holding it is a re-push.
own_pid="$(systemctl show -p MainPID "$unit" 2>/dev/null | sed 's/^MainPID=//')"
if edge_have ss; then
  holders="$(ss -lunp "sport = :$port" 2>/dev/null | sed 1d || true)"
  if [ -n "$holders" ]; then
    case "$holders" in
      *"pid=${own_pid:-none},"*) ;;
      *) edge_die "udp port $port is already in use on this host: $(printf '%s\n' "$holders" | head -n 1 | tr -s ' '). Pick another: qp-tunnel-cli hy2 push <host> --port <n>" ;;
    esac
  fi
fi

# QUIC asks for large UDP socket buffers (quic-go wants about 7.5 MB). Only the
# ceilings are raised, never lowered; a host that refuses (a container) is warned about.
sysctl_file="${EDGE_SYSCTL_DIR:-/etc/sysctl.d}/90-qp-hy2.conf"
want_buffer=16777216
rmem="$(sysctl -n net.core.rmem_max 2>/dev/null || echo 0)"
wmem="$(sysctl -n net.core.wmem_max 2>/dev/null || echo 0)"
if [ "${rmem:-0}" -lt "$want_buffer" ] 2>/dev/null || [ "${wmem:-0}" -lt "$want_buffer" ] 2>/dev/null; then
  [ "${rmem:-0}" -ge "$want_buffer" ] 2>/dev/null || rmem="$want_buffer"
  [ "${wmem:-0}" -ge "$want_buffer" ] 2>/dev/null || wmem="$want_buffer"
  printf '%s\n# QUIC socket buffer ceilings; only raised, never lowered.\nnet.core.rmem_max = %s\nnet.core.wmem_max = %s\n' "$marker" "$rmem" "$wmem" > "$sysctl_file"
  if sysctl -q -p "$sysctl_file" >/dev/null 2>&1; then
    edge_log "raised net.core.rmem_max/wmem_max to $rmem/$wmem for QUIC ($sysctl_file)"
  else
    edge_warn "could not raise the UDP buffer ceilings ($sysctl_file); hy2 still works, with less throughput"
  fi
fi

unit_new="$(mktemp)"
trap 'rm -f "$unit_new"' EXIT
cat > "$unit_new" <<UNIT
$marker (edge component $MX_COMPONENT); rewritten by every push. Change it with qp-tunnel-cli hy2 push, not by hand.
[Unit]
Description=qp-tunnel-cli hy2 server ($MX_COMPONENT, udp $port)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$MX_ROOT/current/$MX_COMPONENT/bin/mihomo -d $state -f $config
Restart=always
RestartSec=3
LimitNOFILE=1048576
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT

applied="$state/.hy2-applied"
digest="$(cat "$bin" "$config" "$state/tls/server.crt" "$state/tls/server.key" "$unit_new" | sha256sum | cut -d ' ' -f 1)"
if ! edge_same_file "$unit_new" "$unit_file"; then
  install -m 644 "$unit_new" "$unit_file"
  systemctl daemon-reload
  edge_log "wrote $unit_file"
fi
systemctl enable "$unit" >/dev/null 2>&1 || edge_die "systemctl enable $unit failed"
if [ "$(edge_unit_state "$unit")" = active ] && [ "$(cat "$applied" 2>/dev/null || true)" = "$digest" ]; then
  edge_log "engine, server.yaml, certificate and unit unchanged and $unit running; left it running (no client drop)"
else
  if ! systemctl restart "$unit"; then
    journalctl -u "$unit" -n 20 --no-pager >&2 2>/dev/null || true
    edge_die "systemctl restart $unit failed"
  fi
  printf '%s\n' "$digest" > "$applied"
  chmod 600 "$applied"
  edge_log "$unit (re)started on udp $port; connected clients reconnect after their QUIC idle timeout (about 30 s)"
fi
edge_firewall_report "$port/udp"
