#!/usr/bin/env bash
# hy2-mihomo: runs docker/hysteria2-mihomo-stack unchanged, non-interactively.
#
# The stack writes .env, data/ and config/ next to its manage.sh, so the stack
# directory itself lives in state (mirroring the repository layout, because
# manage.sh calls ../../scripts/export-hysteria2-mihomo-stack.sh):
#   $MX_STATE_DIR/repo/docker/hysteria2-mihomo-stack/   manage.sh, compose file, .env, data/, config/
#   $MX_STATE_DIR/repo/scripts/                         the two export scripts
# Each push overwrites only the code files there, plus docker-compose.override.yml
# with the pinned image versions; .env, users, certificates and subscriptions stay. Rolling back reruns the old release's deploy.sh,
# which copies the old code back.
set -euo pipefail
. ./lib/edge-os.sh
edge_os_detect
edge_require_systemd
edge_log "host: $(edge_os_summary)"

repo="$MX_STATE_DIR/repo"
stack="$repo/docker/hysteria2-mihomo-stack"
env_in="$MX_STATE_DIR/hy2.env"
applied="$stack/.edge-hy2.env.applied"

# Checked before anything is installed: a placeholder here would start a stack nobody can log in to.
if ! grep -Eq '^HY2_EXPORT_PASSWORD_HASH=.?[$]2[aby]?[$]' "$env_in"; then
  edge_die "hy2.env needs HY2_EXPORT_PASSWORD_HASH set to a bcrypt hash, in single quotes. Make one on any machine with docker: docker run --rm caddy:2.11.9-alpine caddy hash-password --plaintext '<password>'"
fi
if grep -Eq '^HY2_SERVER_HOST=.?203[.]0[.]113[.]10' "$env_in"; then
  edge_die "hy2.env still has the example HY2_SERVER_HOST=203.0.113.10; put this host's public address there"
fi

# manage.sh makes the self-signed certificate and user tokens with openssl; health.sh uses curl.
edge_need_cmd openssl openssl
edge_need_cmd curl curl
edge_ensure_docker
edge_docker_load ./images

# Never take over a copy of the stack that runs from somewhere else (a repo checkout, an older deploy).
for container in hy2-mihomo-hysteria hy2-mihomo-subscriptions; do
  workdir="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container" 2>/dev/null || true)"
  if [ -n "$workdir" ] && [ "$workdir" != "$stack" ]; then
    edge_die "container $container already runs from $workdir; this push will not take it over"
  fi
done

# changed=1 when code or .env differ from what runs now; only then are the
# containers recreated (manage.sh start recreates them, which drops clients).
changed=0
mkdir -p "$stack/scripts" "$repo/scripts"
for rel in $(cd ./vendor && find . -type f | sed 's#^\./##'); do
  if ! edge_same_file "./vendor/$rel" "$repo/$rel"; then
    changed=1
    mkdir -p "$repo/$(dirname "$rel")"
    cp "./vendor/$rel" "$repo/$rel"
  fi
done
chmod 755 "$stack/manage.sh" "$repo/scripts/"*.sh
# Pinned image versions; compose picks the override up by itself (see the file's header).
if ! edge_same_file ./docker-compose.override.yml "$stack/docker-compose.override.yml"; then
  changed=1
  cp ./docker-compose.override.yml "$stack/docker-compose.override.yml"
  edge_log "images: $(sed -n 's/^ *image: //p' ./docker-compose.override.yml | tr '\n' ' ')(docker-compose.override.yml)"
fi

# hy2.env is the operator's copy. Apply it when it is new or changed; otherwise
# keep .env as manage.sh last wrote it (users, normalised hash quotes).
if [ ! -f "$stack/.env" ]; then
  cp "$env_in" "$stack/.env"
  cp "$env_in" "$applied"
  changed=1
  edge_log "hy2.env applied as the stack's .env"
elif ! edge_same_file "$env_in" "$applied"; then
  cp -p "$stack/.env" "$stack/.env.before-$MX_REVISION"
  cp "$env_in" "$stack/.env"
  cp "$env_in" "$applied"
  changed=1
  edge_log "hy2.env changed; applied (previous .env kept as .env.before-$MX_REVISION)"
else
  edge_log "hy2.env unchanged; keeping the stack's .env"
fi
chmod 600 "$stack/.env" "$applied"

export COMPOSE_PROJECT_NAME=hysteria2-mihomo-stack
if [ "$changed" = 0 ] && edge_container_running hy2-mihomo-hysteria && edge_container_running hy2-mihomo-subscriptions; then
  edge_log "code and .env unchanged and both containers running; left them running (no client drop)"
else
  [ "$changed" = 0 ] || edge_log "starting the stack (manage.sh start all recreates the containers; connected clients reconnect)"
  bash "$stack/manage.sh" start all
fi

users="$(awk -F, 'NR > 1 && $1 != "" { n++ } END { print n + 0 }' "$stack/data/hysteria/users.csv" 2>/dev/null || echo 0)"
initial="$(sed -n "s/^HY2_USERS=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1/p" "$stack/.env" | head -n 1)"
if [ "$users" = 0 ] && [ -n "$initial" ]; then
  edge_log "no users yet; adding HY2_USERS: $initial"
  bash "$stack/manage.sh" add-user --names "$initial"
fi

ports="$(sed -n "s/^HY2_SERVER_PORTS=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1/p" "$stack/.env" | head -n 1)"
sub_port="$(sed -n "s/^HY2_EXPORT_FALLBACK_PORT=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1/p" "$stack/.env" | head -n 1)"
edge_firewall_report "${ports:-51288}/udp" "${sub_port:-3434}/tcp"
cat <<NEXT
[edge] Manage users with the stack's own commands, e.g.:
[edge]   qp-tunnel-cli edge ssh <host> -- sudo bash $stack/manage.sh list-users
[edge]   qp-tunnel-cli edge ssh <host> -- sudo bash $stack/manage.sh add-user --names alice
NEXT
