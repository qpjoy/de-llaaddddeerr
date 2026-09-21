#!/usr/bin/env bash
# One entry point for deploying and operating mx-static. Every command is
# idempotent; none of them ever deletes stored objects, manifests or job
# history, and none of them widens permissions.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$here"

version="$(node -p "require('./package.json').version")"
image="mx-static:${version}"
project="${MX_STATIC_PROJECT:-mx-static}"

[ -f .env ] && set -a && . ./.env && set +a || true

data_path="${MX_STATIC_DATA_PATH:-/srv/mx-static/data}"
state_path="${MX_STATIC_STATE_PATH:-/srv/mx-static/state}"
secrets_path="${MX_STATIC_SECRETS_PATH:-$here/secrets}"
uid="${MX_STATIC_UID:-1000}"
gid="${MX_STATIC_GID:-1000}"
writer_port="${MX_STATIC_WRITER_PORT:-18200}"
bind_ip="${MX_STATIC_BIND_IP:-127.0.0.1}"

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*" >&2; }
die() { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

nas_configured() { [ -n "${MX_STATIC_NAS_PATH:-}" ] && [ -n "${MX_STATIC_NAS_VOLUME_ID:-}" ]; }
# Never stat the NAS to choose Compose files: even `test -d` can block on hard NFS.
compose() { docker compose -p "$project" -f compose.yml -f compose.nas.yml "$@"; }
core() { docker compose -p "$project" -f compose.yml "$@"; }

require_nfs_mount() {
  nas_configured || die "set MX_STATIC_NAS_PATH and MX_STATIC_NAS_VOLUME_ID in .env first"
  # Read the kernel mount table only; remote identity is checked by the worker.
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { filesystemAt } from "./src/mounts.mjs";
    const path = process.argv[1];
    if (process.platform !== "linux" || !path.startsWith("/") ||
        !["nfs", "nfs4"].includes(filesystemAt(path, readFileSync("/proc/self/mountinfo", "utf8")))) {
      console.error("NAS must be an absolute path on an already mounted NFS filesystem");
      process.exit(1);
    }
  ' "$MX_STATIC_NAS_PATH"
}

secret() { # name, generator -- never overwrite an existing credential
  local file="$secrets_path/$1"
  [ -f "$file" ] && return 0
  mkdir -p "$secrets_path"
  eval "$2" > "$file"
  chmod 0440 "$file"
  say "generated $1"
}

ensure_layout() {
  mkdir -p "$secrets_path"
  for path in "$data_path" "$state_path"; do
    if [ ! -d "$path" ]; then
      say "creating $path"
      mkdir -p "$path" || die "cannot create $path; create it with the right ownership and re-run"
    fi
  done
  secret signing-key "openssl rand -hex 32"
  secret admin-token "openssl rand -hex 32"
  secret projects.json "node -e \"const {randomBytes}=require('crypto');const t=()=>randomBytes(32).toString('hex');console.log(JSON.stringify({'mx-insight-hub':{read:t(),write:t()}},null,2))\""
  if [ "$(id -u)" = 0 ]; then
    chown "$uid:$gid" "$secrets_path/signing-key" "$secrets_path/admin-token" "$secrets_path/projects.json"
  fi
  # Only fix ownership when it is actually wrong, and never widen the mode.
  for path in "$data_path" "$state_path"; do
    local owner; owner="$(stat -c '%u:%g' "$path" 2>/dev/null || stat -f '%u:%g' "$path")"
    if [ "$owner" != "$uid:$gid" ]; then
      say "setting ownership of $path to $uid:$gid"
      chown -R "$uid:$gid" "$path" 2>/dev/null || warn "could not chown $path (run as root, or pre-create it as $uid:$gid)"
    fi
  done
}

migrate() {
  [ -z "$(core ps --status running --quiet writer)" ] || die "stop writer before migrate; active downloads must not lose their staging files"
  say "applying control-plane migrations"
  docker run --rm --user "$uid:$gid" \
    -v "$data_path:/data" -v "$state_path:/state" \
    -e MX_STATIC_STATE_DIR=/state -e MX_STATIC_DATA_DIR=/data \
    "$image" node src/migrate.mjs
}

prune() {
  # Only superseded builds of this image; never a dangling layer from elsewhere.
  local stale
  stale="$(docker images --filter 'label=org.opencontainers.image.title=mx-static' --filter 'dangling=true' --format '{{.ID}}' | sort -u)"
  if [ -n "$stale" ]; then
    say "removing superseded mx-static images"
    echo "$stale" | xargs -r docker rmi >/dev/null 2>&1 || true
  fi
}

wait_healthy() {
  say "waiting for health"
  for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://$bind_ip:$writer_port/static/health" >/dev/null 2>&1; then
      say "healthy"; return 0
    fi
    sleep 2
  done
  warn "writer did not become healthy in 120s; see: bash scripts/manage.sh logs"
  return 1
}

cmd_deploy() {
  ensure_layout
  say "building $image"
  core build --quiet
  # The migration cleans crash leftovers; drain the old writer first so its
  # active downloads cannot be mistaken for abandoned .part files.
  core stop writer reader
  migrate
  say "starting writer and reader"
  core up -d --no-build --wait --wait-timeout 120 writer reader
  wait_healthy
  prune
  cmd_status
  if [ -f "$secrets_path/admin-token" ]; then
    say "settings console: http://$bind_ip:$writer_port/static/admin"
    say "admin token:      $secrets_path/admin-token"
  fi
  nas_configured || say "NAS not configured; run 'attach' once MX_STATIC_NAS_PATH and MX_STATIC_NAS_VOLUME_ID are set"
}

cmd_status() {
  say "containers"
  compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' || true
  local token
  token="$(node -e "try{const p=require('$secrets_path/projects.json');console.log(Object.values(p)[0].read)}catch{}" 2>/dev/null || true)"
  if [ -n "$token" ]; then
    local project_name
    project_name="$(node -e "try{console.log(Object.keys(require('$secrets_path/projects.json'))[0])}catch{}" 2>/dev/null || true)"
    say "capacity"
    curl -fsS --max-time 3 -H "Authorization: Bearer $token" \
      "http://$bind_ip:$writer_port/static/v1/projects/$project_name/capacity" 2>/dev/null \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const c=JSON.parse(s);console.log('  feasible      ', c.feasible);console.log('  permits       ', JSON.stringify(c.limits));console.log('  bandwidth     ', c.budget.totalMbps+' Mbps ('+Math.round(c.budget.linkUtilisation*100)+'% of link)');console.log('  event loop    ', c.live.eventLoopLagMs+' ms');console.log('  image streams ', c.live.assetStreams.inUse+'/'+c.live.assetStreams.limit);console.log('  video streams ', c.live.videoStreams.inUse+'/'+c.live.videoStreams.limit);console.log('  downloads     ', 'image '+c.live.downloads.image.inUse+'/'+c.live.downloads.image.limit+', video '+c.live.downloads.video.inUse+'/'+c.live.downloads.video.limit);(c.warnings||[]).forEach(w=>console.log('  warning       ', w))}catch{console.log('  (writer not reachable)')}})" || true
  fi
}

archive_control() {
  docker run --rm --user "$uid:$gid" -v "$state_path:/state" -e MX_STATIC_STATE_DIR=/state \
    "$image" node src/archive-control.mjs "$@"
}

case "${1:-help}" in
  deploy)  cmd_deploy ;;
  status)  cmd_status ;;
  migrate) migrate ;;
  prune)   prune ;;
  build)   core build ;;
  start)   core start writer reader; wait_healthy ;;
  stop)    core stop writer reader ;;
  restart) core restart writer reader; wait_healthy ;;
  logs)    compose logs -f --tail "${2:-200}" ;;
  attach)
    require_nfs_mount
    archive_control attach "$MX_STATIC_NAS_VOLUME_ID"
    compose --profile nas up -d --no-build --no-deps --force-recreate archive
    say "archive attached; check 'storage' for the backend health"
    ;;
  detach)
    archive_control detach
    compose --profile nas stop -t 10 archive 2>/dev/null || true
    say "archive detached"
    ;;
  storage) archive_control status ;;
  console)
    say "settings console: http://$bind_ip:$writer_port/static/admin"
    say "admin token:      $secrets_path/admin-token"
    ;;
  doctor)
    say "image     $image"
    say "data      $data_path  $([ -d "$data_path" ] && echo present || echo MISSING)"
    say "state     $state_path $([ -d "$state_path" ] && echo present || echo MISSING)"
    say "secrets   $secrets_path"
    for name in signing-key admin-token projects.json; do
      printf '  %-14s %s\n' "$name" "$([ -f "$secrets_path/$name" ] && echo present || echo MISSING)"
    done
    say "nas       $(nas_configured && echo "configured at ${MX_STATIC_NAS_PATH} (mount not probed)" || echo 'not configured (optional)')"
    say "compose config"
    compose config --quiet && say "  valid"
    ;;
  *)
    cat <<USAGE
mx-static $version

  deploy    build, migrate, start, prune superseded images, report status
  status    container state and live capacity
  logs [n]  follow logs
  migrate   apply control-plane migrations only
  build     rebuild the image
  start | stop | restart
  attach    attach the NAS archive (requires a mounted, marked NFS)
  detach    detach the NAS archive
  storage   archive backend state and per-project counts
  console   print the settings console URL and token location
  prune     remove superseded build artifacts
  doctor    check paths, credentials and compose validity

Settings live in .env; anything malformed falls back to its default with a
warning rather than stopping the service. Everything marked adjustable can be
changed at runtime from the settings console.
USAGE
    ;;
esac
