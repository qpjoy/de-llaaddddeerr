#!/usr/bin/env bash
# Read-only: both containers running and the subscription site's /healthz answers 200.
set -euo pipefail
. ./lib/edge-os.sh
stack="$MX_STATE_DIR/repo/docker/hysteria2-mihomo-stack"
for container in hy2-mihomo-hysteria hy2-mihomo-subscriptions; do
  edge_container_running "$container" || edge_die "container $container is not running"
done
edge_log "hy2-mihomo-hysteria and hy2-mihomo-subscriptions running"
sub_port="$(sed -n "s/^HY2_EXPORT_FALLBACK_PORT=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1/p" "$stack/.env" | head -n 1)"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null --max-time 5 "http://127.0.0.1:${sub_port:-3434}/healthz"; then
    edge_log "subscription site answers on :${sub_port:-3434}/healthz"
    exit 0
  fi
  sleep 2
done
edge_die "subscription site does not answer on 127.0.0.1:${sub_port:-3434}/healthz"
