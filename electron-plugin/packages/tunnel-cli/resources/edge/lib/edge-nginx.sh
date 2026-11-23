# shellcheck shell=bash
# qp-tunnel-cli edge: nginx site files for the *-nginx stacks. Needs edge-os.sh sourced first.
#
# Site files come from the component's state directory (pushed with
# `edge push --state-dir`), never from the release, because they name real
# domains and certificate paths. Each file <name>.conf becomes
#   /etc/nginx/conf.d/qp-edge-<component>--<name>.conf
# with @STATE_DIR@ replaced by the state directory, so certificates can live
# next to the site files. Both Debian and RHEL nginx packages include
# conf.d/*.conf from nginx.conf.
#
# Files this component wrote before are moved to
#   /etc/nginx/qp-edge-backup/<component>/<timestamp>-<revision>/
# not deleted. If `nginx -t` rejects the new set, the old set is moved back.

EDGE_NGINX_CONF_DIR="${EDGE_NGINX_CONF_DIR:-/etc/nginx/conf.d}"
EDGE_NGINX_BACKUP_ROOT="${EDGE_NGINX_BACKUP_ROOT:-/etc/nginx/qp-edge-backup}"

edge_nginx_install() {
  if [ "$EDGE_OS_FAMILY" = rhel ] && [ "${EDGE_OS_MAJOR:-0}" -le 7 ] 2>/dev/null; then edge_need_epel; fi
  edge_pkg_install nginx
  edge_need_cmd curl curl
}

edge_nginx_apply() { # edge_nginx_apply <component> <revision> <site_dir> <state_dir>
  local component="$1" revision="$2" site_dir="$3" state_dir="$4"
  local prefix="qp-edge-${component}--" file name backup written=""
  [ -d "$site_dir" ] || edge_die "no site directory $site_dir. Put <name>.conf files under nginx/ in the --state-dir you push."
  set -- "$site_dir"/*.conf
  [ -f "$1" ] || edge_die "no *.conf in $site_dir"

  backup="$EDGE_NGINX_BACKUP_ROOT/$component/$(date -u +%Y%m%dT%H%M%SZ)-$revision"
  mkdir -p "$EDGE_NGINX_CONF_DIR" "$backup"
  for file in "$EDGE_NGINX_CONF_DIR/$prefix"*.conf; do
    if [ -f "$file" ]; then mv "$file" "$backup/"; fi
  done
  for file in "$site_dir"/*.conf; do
    name="$(basename "$file")"
    case "$name" in *[!A-Za-z0-9._-]*) edge_die "site file name not allowed: $name" ;; esac
    sed "s#@STATE_DIR@#${state_dir}#g" "$file" > "$EDGE_NGINX_CONF_DIR/$prefix$name"
    chmod 644 "$EDGE_NGINX_CONF_DIR/$prefix$name"
    written="$written $name"
  done
  edge_log "nginx site files:$written (previous ones kept in $backup)"

  if ! nginx -t; then
    for name in $written; do rm -f "$EDGE_NGINX_CONF_DIR/$prefix$name"; done
    for file in "$backup"/*.conf; do if [ -f "$file" ]; then mv "$file" "$EDGE_NGINX_CONF_DIR/"; fi; done
    edge_die "nginx -t rejected the new site files; the previous ones are back in place"
  fi
  edge_service_reload nginx
  systemctl is-enabled --quiet nginx 2>/dev/null || systemctl enable nginx >/dev/null 2>&1 || true
}

edge_nginx_health() {
  [ "$(edge_unit_state nginx)" = active ] || { edge_warn "nginx is $(edge_unit_state nginx)"; return 1; }
  nginx -t -q 2>/dev/null || { edge_warn "nginx -t fails"; return 1; }
  if [ -n "${EDGE_HEALTH_URL:-}" ]; then
    local code
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "$EDGE_HEALTH_URL" || true)"
    case "$code" in
      ''|000|5??) edge_warn "$EDGE_HEALTH_URL answered ${code:-nothing}"; return 1 ;;
      *) edge_log "$EDGE_HEALTH_URL answered $code" ;;
    esac
  fi
}
