#!/usr/bin/env bash
# qp-tunnel-cli edge: the half that runs on the remote edge host.
#
# `qp-tunnel-cli edge` streams lib/edge-os.sh followed by this file over SSH
# (`bash -s -- <command> ...`), so the remote host needs nothing but bash, tar
# and coreutils. Run by hand, it sources lib/edge-os.sh from next to itself.
#
# Layout, borrowed from the v1 Launcher site-slot push deploy:
#   $MX_ROOT/incoming/<component>-<revision>.tar.gz   upload target, removed after extraction
#   $MX_ROOT/releases/<component>/<revision>/         one directory per pushed bundle, never overwritten
#   $MX_ROOT/state/<component>/                       survives releases (.env, keys, site files, data)
#   $MX_ROOT/current/<component> -> releases/...      what is live
#
# A bundle may ship deploy.sh (applies the release) and health.sh (proves it
# works, read-only). Both run as root from the release directory with
# MX_COMPONENT, MX_REVISION, MX_RELEASE_DIR, MX_STATE_DIR, MX_PREVIOUS_RELEASE
# and MX_ROOT set. A bundle built from a stack also ships stack.env, which
# activate checks before it switches anything: OS family, systemd, required
# state files.
#
# State files pushed with --state-dir are kept with their release
# (releases/<component>/<revision>/.edge-state, root only) and copied into
# state/<component>/ only after preflight passes; a rollback copies the target
# release's set back. Nothing here deletes a release or the state directory;
# state files replaced by a push or rollback are copied to
# state/<component>/.edge-replaced/<label>/ first.
#
# Several Internal machines can push (each is an "origin"; qp-tunnel-cli edge
# passes its name as EDGE_ORIGIN). The origin that last pushed or rolled back a
# component is recorded in state/<component>/.edge-origin, and a push or
# rollback from a different origin is refused unless EDGE_TAKE_OVER=1, so two
# Internal machines never overwrite each other's work by accident.
# A host where another tool deployed into the same layout (the v1 Launcher,
# for one: the current Domestic) is refused as a whole unless
# EDGE_SHARED_HOST=1, even for components it does not have yet.
# .edge-history lines are "<utc time> <revision> <origin> <push|rollback>";
# lines from before origins were recorded have only the first two fields.
# Must stay bash 3.2 compatible: the tests run it on macOS.

set -euo pipefail

MX_ROOT="${MX_ROOT:-/opt/mx}"

if ! command -v edge_os_detect >/dev/null 2>&1; then
  _edge_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
  [ -f "$_edge_dir/lib/edge-os.sh" ] || { printf 'edge: lib/edge-os.sh not found next to %s\n' "$0" >&2; exit 1; }
  # shellcheck source=lib/edge-os.sh
  . "$_edge_dir/lib/edge-os.sh"
fi

die() { printf 'edge: %s\n' "$*" >&2; exit 1; }

EDGE_ORIGIN="${EDGE_ORIGIN:-manual}"

valid_name() {
  case "$1" in
    ''|.|..|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

need_name() { # need_name <label> <value>
  valid_name "$2" || die "invalid $1: '$2' (allowed: letters, digits, . _ -)"
}

# Atomic on GNU coreutils (ln -T); plain replace elsewhere.
switch_link() { # switch_link <target> <link>
  if ln -sfnT "$1" "$2" 2>/dev/null; then return 0; fi
  rm -f "$2"
  ln -s "$1" "$2"
}

current_release() { # prints the live release path or nothing
  local link="$MX_ROOT/current/$1"
  if [ -L "$link" ]; then readlink "$link"; fi
}

kv_value() { # kv_value <file> <KEY>  reads KEY=value without sourcing the file
  local line
  [ -f "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$2="*) edge_unquote "${line#"$2"=}"; return 0 ;;
    esac
  done < "$1"
}

kv_from_text() { # kv_from_text <KEY>  same, reading stdin
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$1="*) edge_unquote "${line#"$1"=}"; return 0 ;;
    esac
  done
}

run_hook() { # run_hook <hook> <component> <revision> <release_dir> <previous>
  local hook="$1" component="$2" revision="$3" release_dir="$4" previous="$5"
  [ -f "$release_dir/$hook" ] || { printf 'hook %s: not shipped, skipped\n' "$hook"; return 0; }
  printf 'hook %s: running\n' "$hook"
  (
    cd "$release_dir"
    MX_COMPONENT="$component" \
    MX_REVISION="$revision" \
    MX_RELEASE_DIR="$release_dir" \
    MX_STATE_DIR="$MX_ROOT/state/$component" \
    MX_PREVIOUS_RELEASE="$previous" \
    MX_ROOT="$MX_ROOT" \
      bash "./$hook"
  )
}

host_name() { hostname 2>/dev/null || uname -n 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null || echo UNKNOWN; }

record_history() { # record_history <component> <revision> <push|rollback>
  printf '%s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$2" "$EDGE_ORIGIN" "$3" >> "$MX_ROOT/state/$1/.edge-history"
}

history_revision() { # history_revision <line>  the second field
  local rest="${1#* }"
  printf '%s' "${rest%% *}"
}

read_root_file() { # read_root_file <file>  state/ is root-only; read through sudo -n when we are not root
  cat "$1" 2>/dev/null || edge_as_root cat "$1" 2>/dev/null
}

owner_of() { # owner_of <component>  the origin that manages it here, or nothing
  read_root_file "$MX_ROOT/state/$1/.edge-origin" | head -n 1
}

need_origin() {
  valid_name "$EDGE_ORIGIN" || die "invalid EDGE_ORIGIN '$EDGE_ORIGIN' (allowed: letters, digits, . _ -)"
}

guard_owner() { # guard_owner <component>  returns 1, saying why, when another origin manages it and EDGE_TAKE_OVER is not 1
  local owner; owner="$(owner_of "$1")"
  if [ -z "$owner" ] || [ "$owner" = "$EDGE_ORIGIN" ]; then return 0; fi
  if [ "${EDGE_TAKE_OVER:-0}" = 1 ]; then
    printf 'take-over: %s moves from origin %s to %s\n' "$1" "$owner" "$EDGE_ORIGIN"
    return 0
  fi
  printf 'edge: %s on this host is managed from %s (state/%s/.edge-origin); this request comes from %s.\n' "$1" "$owner" "$1" "$EDGE_ORIGIN" >&2
  return 1
}

foreign_components() { # foreign_components <except>  prints " a b" for current/* links without edge history
  local link name out=""
  for link in "$MX_ROOT"/current/*; do
    [ -L "$link" ] || continue
    name="$(basename "$link")"
    [ "$name" != "$1" ] || continue
    [ -f "$MX_ROOT/state/$name/.edge-history" ] || out="$out $name"
  done
  printf '%s' "$out"
}

claim_owner() { # claim_owner <component>
  printf '%s\n' "$EDGE_ORIGIN" > "$MX_ROOT/state/$1/.edge-origin"
  chmod 600 "$MX_ROOT/state/$1/.edge-origin"
}

# ---------- activate ----------

refuse() { # refuse <message>  for cmd_activate before anything is written: drops this push's uploads, then dies
  # tarball and state_tarball are cmd_activate's locals (bash scoping is dynamic).
  rm -f "${tarball:-}"
  if [ -n "${state_tarball:-}" ]; then rm -f "$state_tarball"; fi
  die "$@"
}

unpack_state() { # unpack_state <state_tarball> <dir>  extracts pushed state files, refusing paths the host owns
  local tarball="$1" dir="$2" rel
  [ -f "$tarball" ] || die "uploaded state not found: $tarball"
  mkdir -p "$dir"
  chmod 700 "$dir"
  tar -xzf "$tarball" -C "$dir"
  rm -f "$tarball"
  for rel in $(cd "$dir" && find . -type f | sed 's#^\./##'); do
    case "/$rel/" in */../*|*/.edge-*) die "state path not allowed: $rel" ;; esac
  done
}

apply_state() { # apply_state <component> <tree> <backup_label>  copies the tree into state/<component>
  local component="$1" tree="$2" label="$3"
  local state="$MX_ROOT/state/$component" list="$MX_ROOT/incoming/.edge-state-list.$$" rel written=0 replaced=0
  [ -d "$tree" ] || return 0
  (cd "$tree" && find . -type f) > "$list"
  while IFS= read -r rel; do
    rel="${rel#./}"
    if [ -e "$state/$rel" ]; then
      if edge_same_file "$tree/$rel" "$state/$rel"; then continue; fi
      mkdir -p "$state/.edge-replaced/$label/$(dirname "$rel")"
      cp -p "$state/$rel" "$state/.edge-replaced/$label/$rel"
      replaced=$((replaced + 1))
    fi
    mkdir -p "$state/$(dirname "$rel")"
    cp "$tree/$rel" "$state/$rel"
    chmod 600 "$state/$rel"
    written=$((written + 1))
  done < "$list"
  rm -f "$list"
  find "$state" -type d -exec chmod 700 {} + 2>/dev/null || true
  if [ "$replaced" -gt 0 ]; then
    printf 'state %s: %d file(s) written, %d replaced (old copies in %s)\n' "$component" "$written" "$replaced" "$state/.edge-replaced/$label"
  else
    printf 'state %s: %d file(s) written\n' "$component" "$written"
  fi
}

preflight() { # preflight <unpacked_bundle> <component>; prints why and returns 1 when the host is wrong for it
  # Required state may already be on the host or arrive with this push (<bundle>/.edge-state).
  local manifest="$1/stack.env" pushed="$1/.edge-state" component="$2" name families systemd required f missing=""
  [ -f "$manifest" ] || { printf 'preflight: no stack.env, nothing to check\n'; return 0; }
  name="$(kv_value "$manifest" STACK_NAME)"
  families="$(kv_value "$manifest" STACK_OS)"
  systemd="$(kv_value "$manifest" STACK_SYSTEMD)"
  required="$(kv_value "$manifest" STACK_STATE_REQUIRED)"
  edge_os_detect
  if [ -n "$(edge_os_eol)" ]; then printf 'preflight: warning: %s\n' "$(edge_os_eol_hint)"; fi
  if [ -n "$families" ]; then
    case " $families " in
      *" $EDGE_OS_FAMILY "*) ;;
      *)
        if [ "${EDGE_FORCE_OS:-0}" = 1 ]; then
          printf 'preflight: stack %s lists %s, host is %s; continuing because of --force-os\n' "$name" "$families" "$EDGE_OS_FAMILY"
        else
          printf 'edge: stack %s supports OS families: %s. This host: %s\n' "$name" "$families" "$(edge_os_summary)" >&2
          return 1
        fi
        ;;
    esac
  fi
  if [ "$systemd" = 1 ] && [ "$EDGE_INIT" != systemd ]; then
    printf 'edge: stack %s needs systemd; this host is not running it\n' "$name" >&2
    return 1
  fi
  for f in $required; do
    [ -e "$MX_ROOT/state/$component/$f" ] || [ -e "$pushed/$f" ] || missing="$missing $f"
  done
  if [ -n "$missing" ]; then
    printf 'edge: state/%s is missing:%s\n' "$component" "$missing" >&2
    if [ -n "$(kv_value "$manifest" STACK_STATE_HINT)" ]; then
      printf 'edge: %s\n' "$(kv_value "$manifest" STACK_STATE_HINT)" >&2
    else
      printf 'edge: push them with --state-dir; start from: qp-tunnel-cli edge stacks %s --init <dir>\n' "$name" >&2
    fi
    return 1
  fi
  printf 'preflight ok: stack %s on %s\n' "$name" "$(edge_os_summary)"
}

cmd_activate() { # activate <component> <revision> <tarball> [state_tarball]
  local component="${1:-}" revision="${2:-}" tarball="${3:-}" state_tarball="${4:-}"
  need_name component "$component"
  need_name revision "$revision"
  [ -f "$tarball" ] || die "uploaded bundle not found: $tarball"

  local release_dir="$MX_ROOT/releases/$component/$revision"
  [ ! -e "$release_dir" ] || refuse "release $component/$revision already exists; push with another --revision (releases are never overwritten)"
  # v1 Launcher pushes use the same layout. Its components carry no edge history,
  # so refuse to switch them unless the operator says so.
  if [ -L "$MX_ROOT/current/$component" ] && [ ! -f "$MX_ROOT/state/$component/.edge-history" ] && [ "${EDGE_TAKE_OVER:-0}" != 1 ]; then
    refuse "current/$component exists but was not deployed by qp-tunnel-cli edge (no state/$component/.edge-history; the v1 Launcher uses this layout too). Nothing was changed. Pass --take-over to replace it."
  fi
  valid_name "$EDGE_ORIGIN" || refuse "invalid EDGE_ORIGIN '$EDGE_ORIGIN' (allowed: letters, digits, . _ -)"
  local others; others="$(foreign_components "$component")"
  if [ -n "$others" ] && [ "${EDGE_SHARED_HOST:-0}" != 1 ]; then
    refuse "this host also runs$others, deployed by something other than qp-tunnel-cli edge (the v1 Launcher uses this layout; the current Domestic is such a host). Pushing here changes a machine another tool manages. Nothing was changed. Pass --shared-host to push anyway."
  fi
  guard_owner "$component" || refuse "Nothing was changed. Pass --take-over to move $component to $EDGE_ORIGIN."

  local previous; previous="$(current_release "$component")"
  mkdir -p "$MX_ROOT/releases/$component" "$MX_ROOT/state/$component" "$MX_ROOT/current" "$MX_ROOT/incoming"
  chmod 700 "$MX_ROOT/state/$component"
  local staging="$MX_ROOT/incoming/$component-$revision.d"
  [ ! -e "$staging" ] || die "$staging already exists from an earlier attempt; move it away and push again"
  mkdir "$staging"
  tar -xzf "$tarball" -C "$staging"
  rm -f "$tarball"
  [ ! -e "$staging/.edge-state" ] || { rm -rf "$staging"; die "bundles must not ship .edge-state"; }
  # Pushed state is kept with the release, so a rollback can put it back.
  if [ -n "$state_tarball" ]; then unpack_state "$state_tarball" "$staging/.edge-state"; fi

  if ! preflight "$staging" "$component"; then
    rm -rf "$staging"
    die "preflight failed; nothing was written and current/$component was not switched${previous:+ (still $(basename "$previous"))}"
  fi
  apply_state "$component" "$staging/.edge-state" "$revision"
  mv "$staging" "$release_dir"
  printf 'pushed_at=%s\nstack=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(kv_value "$release_dir/stack.env" STACK_NAME)" > "$release_dir/.edge-release"
  if [ ! -e "$release_dir/state" ]; then ln -s "$MX_ROOT/state/$component" "$release_dir/state"; fi

  switch_link "$release_dir" "$MX_ROOT/current/$component"
  claim_owner "$component"
  record_history "$component" "$revision" push
  printf 'current %s -> %s (previous: %s; managed from %s)\n' "$component" "$release_dir" "${previous:-none}" "$EDGE_ORIGIN"

  local rollback_hint="roll back with: qp-tunnel-cli edge rollback <host> --component $component"
  run_hook deploy.sh "$component" "$revision" "$release_dir" "$previous" \
    || die "deploy.sh failed; current already points at $revision. $rollback_hint"
  run_hook health.sh "$component" "$revision" "$release_dir" "$previous" \
    || die "health.sh failed for $revision. $rollback_hint"
  printf 'activated %s %s\n' "$component" "$revision"
}

cmd_rollback() { # rollback <component> [revision]
  local component="${1:-}" target="${2:-}"
  need_name component "$component"
  need_origin
  local live; live="$(current_release "$component")"
  [ -n "$live" ] || die "$component has no current release on this host"
  guard_owner "$component" || die "Nothing was changed. Pass --take-over to move $component to $EDGE_ORIGIN."
  local live_rev; live_rev="$(basename "$live")"

  if [ -z "$target" ]; then
    # The newest history entry that is not the live revision and still exists.
    local history="$MX_ROOT/state/$component/.edge-history" line rev
    [ -f "$history" ] || die "no edge history for $component; pass the revision explicitly"
    while read -r line; do
      rev="$(history_revision "$line")"
      if [ "$rev" != "$live_rev" ] && [ -d "$MX_ROOT/releases/$component/$rev" ]; then target="$rev"; fi
    done < "$history"
    [ -n "$target" ] || die "no earlier release of $component to roll back to"
  fi
  need_name revision "$target"
  local release_dir="$MX_ROOT/releases/$component/$target"
  [ -d "$release_dir" ] || die "release $component/$target does not exist"
  [ "$target" != "$live_rev" ] || die "$component is already on $target"

  # Put back the state files that release was pushed with (newer copies go to .edge-replaced).
  apply_state "$component" "$release_dir/.edge-state" "rollback-$(date -u +%Y%m%dT%H%M%SZ)-to-$target"
  switch_link "$release_dir" "$MX_ROOT/current/$component"
  claim_owner "$component"
  record_history "$component" "$target" rollback
  printf 'current %s -> %s (was: %s; managed from %s)\n' "$component" "$release_dir" "$live_rev" "$EDGE_ORIGIN"
  run_hook deploy.sh "$component" "$target" "$release_dir" "$live" || die "deploy.sh failed while rolling back to $target"
  run_hook health.sh "$component" "$target" "$release_dir" "$live" || die "health.sh failed after rolling back to $target"
  printf 'rolled back %s to %s\n' "$component" "$target"
}

# ---------- state-export: copy pushed state back to an origin ----------

cmd_state_export() { # state-export <component>  tar.gz on stdout; only stdout carries the archive
  # The files any push of this component carried (the union of the releases'
  # .edge-state sets), with their current content in state/<component>.
  # What the stacks write there themselves (hy2-mihomo's repo/, markers) and
  # the .edge-* bookkeeping stay on the host.
  local component="${1:-}" state list rel snap
  need_name component "$component"
  state="$MX_ROOT/state/$component"
  [ -f "$state/.edge-history" ] || die "$component has no edge history on this host; only what qp-tunnel-cli edge pushed can be exported"
  list="$(mktemp "${TMPDIR:-/tmp}/edge-state-export.XXXXXX")"
  for snap in "$MX_ROOT"/releases/"$component"/*/.edge-state; do
    if [ -d "$snap" ]; then (cd "$snap" && find . -type f); fi
  done | sed 's#^\./##' | sort -u | while IFS= read -r rel; do
    if [ -f "$state/$rel" ]; then printf './%s\n' "$rel"; fi
  done > "$list"
  if [ ! -s "$list" ]; then
    rm -f "$list"
    die "no release of $component on this host was pushed with --state-dir, so there is nothing to export"
  fi
  printf 'state-export %s: %s file(s), managed from %s\n' "$component" "$(wc -l < "$list" | tr -d ' ')" "$(owner_of "$component" || true)" >&2
  tar -czf - -C "$state" -T "$list"
  rm -f "$list"
}

cmd_releases() { # releases [component]
  local filter="${1:-}" dir component live rev
  [ -d "$MX_ROOT/releases" ] || { printf 'no releases under %s\n' "$MX_ROOT"; return 0; }
  for dir in "$MX_ROOT"/releases/*/; do
    [ -d "$dir" ] || continue
    component="$(basename "$dir")"
    if [ -n "$filter" ] && [ "$filter" != "$component" ]; then continue; fi
    live="$(current_release "$component")"
    printf '%s\n' "$component"
    for rev in "$dir"*/; do
      [ -d "$rev" ] || continue
      if [ "${rev%/}" = "$live" ]; then printf '  * %s\n' "$(basename "$rev")"
      else printf '    %s\n' "$(basename "$rev")"; fi
    done
  done
}

# ---------- status: read-only, one record per thing deployed on this host ----------

TAB="$(printf '\t')"

rec() { # rec <kind> <name> <version> <state> <detail>  ->  @edge<TAB>...
  local out="@edge" field
  for field in "$@"; do
    field="$(printf '%s' "$field" | tr '\t\r\n' '   ')"
    out="$out$TAB${field:--}"
  done
  printf '%s\n' "$out"
}

status_edge_components() {
  local with_health="$1" link component target rev stack history since origin state last
  for link in "$MX_ROOT"/current/*; do
    [ -L "$link" ] || continue
    component="$(basename "$link")"
    target="$(readlink "$link")"
    rev="$(basename "$target")"
    stack="$(kv_value "$target/stack.env" STACK_NAME)"
    history="$MX_ROOT/state/$component/.edge-history"
    # state/ is root-only; read the history through sudo -n when we are not root.
    if [ -f "$history" ] || edge_as_root test -f "$history" 2>/dev/null; then
      last="$(read_root_file "$history" | tail -n 1)"
      since="${last%% *}"
      # The origin that manages it; "edge" for components pushed before origins were recorded.
      origin="$(owner_of "$component")"
      [ -n "$origin" ] || origin=edge
    elif [ ! -e "$MX_ROOT/state/$component" ] || [ -r "$MX_ROOT/state/$component" ] || [ "$(id -u)" = 0 ] || edge_as_root true 2>/dev/null; then
      origin=other; since=-
    else
      origin="? (state needs root)"; since=-
    fi
    state=live
    [ -d "$target" ] || state=BROKEN-LINK
    if [ "$with_health" = 1 ] && [ "$state" = live ] && [ -f "$target/health.sh" ]; then
      if [ "$(id -u)" != 0 ]; then state="live (health needs root)"
      elif run_hook health.sh "$component" "$rev" "$target" "" >/dev/null 2>&1; then state=healthy
      else state=UNHEALTHY; fi
    fi
    rec edge "$component" "$rev" "$state" "stack=${stack:--} pushed-by=$origin since=$since"
  done
}

status_tunnel_cli() { # instances made by qp-tunnel-cli wg / open / install on this host
  local dir inst unit env port subnet runtime state
  for dir in /etc/qp-wireguard/server/*/; do
    [ -d "$dir" ] || continue
    inst="$(basename "$dir")"; unit="wg-quick@qpwgs-$inst.service"
    env="$(edge_as_root cat "$dir/server.env" 2>/dev/null)"
    port="$(printf '%s\n' "$env" | kv_from_text QP_WG_PORT)"; subnet="$(printf '%s\n' "$env" | kv_from_text QP_WG_SUBNET)"
    rec wg-server "$inst" - "$(edge_unit_state "$unit")" "unit=$unit${port:+ port=$port/udp}${subnet:+ subnet=$subnet}"
  done
  for dir in /etc/qp-wireguard/client/*/; do
    [ -d "$dir" ] || continue
    inst="$(basename "$dir")"; unit="wg-quick@qpwgc-$inst.service"
    rec wg-client "$inst" - "$(edge_unit_state "$unit")" "unit=$unit"
  done
  for dir in /etc/qp-openvpn-server/*/; do
    [ -d "$dir" ] || continue
    inst="$(basename "$dir")"; unit="qp-openvpn-server@$inst.service"
    env="$(edge_as_root cat "$dir/server.env" 2>/dev/null)"
    port="$(printf '%s\n' "$env" | kv_from_text QP_OPEN_PORT)"; runtime="$(printf '%s\n' "$env" | kv_from_text QP_OPEN_RUNTIME)"
    state="$(edge_unit_state "$unit")"
    if [ "$runtime" = docker ]; then
      if edge_have docker && edge_container_running "mx-oversea-openvpn-$inst" 2>/dev/null; then state=running; else state="not running"; fi
    fi
    rec open-server "$inst" - "$state" "runtime=${runtime:-?}${port:+ port=$port}"
  done
  for dir in /etc/qp-openvpn/*/; do
    [ -d "$dir" ] || continue
    inst="$(basename "$dir")"; unit="qp-openvpn-client@$inst.service"
    rec open-client "$inst" - "$(edge_unit_state "$unit")" "unit=$unit"
  done
  if [ -f /etc/systemd/system/mihomo-client.service ]; then
    rec mihomo-client default - "$(edge_unit_state mihomo-client.service)" "home=/etc/mihomo-client"
  fi
  for dir in /etc/mihomo-client/instances/*/; do
    [ -d "$dir" ] || continue
    inst="$(basename "$dir")"
    rec mihomo-client "$inst" - "$(edge_unit_state "mihomo-client@$inst.service")" "home=$dir"
  done
}

status_wireguard_interfaces() { # interfaces not made by qp-tunnel-cli (the v1 Domestic relay, for one)
  edge_have wg || return 0
  local ifaces iface now
  if ! ifaces="$(edge_as_root wg show interfaces 2>/dev/null)"; then
    rec wireguard - - UNKNOWN "listing interfaces needs root"
    return 0
  fi
  now="$(date +%s)"
  for iface in $ifaces; do
    case "$iface" in qpwgs-*|qpwgc-*) continue ;; esac
    rec wireguard "$iface" - up "$(edge_as_root wg show "$iface" latest-handshakes 2>/dev/null | awk -v now="$now" '
      { n++; if ($2 > 0 && now - $2 < 180) a++ } END { printf "peers=%d handshake_within_3m=%d", n, a }')"
  done
}

status_docker() { # status_docker <all>: running containers; stopped ones and Kubernetes pod containers are counted
  edge_have docker || return 0
  local all="$1" out name image state status project k8s=0 stopped=0
  local format='{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Label "com.docker.compose.project"}}'
  out="$(docker ps -a --format "$format" 2>/dev/null)" \
    || out="$(edge_as_root docker ps -a --format "$format" 2>/dev/null)" \
    || { rec docker - - UNKNOWN "needs root or the docker group"; return 0; }
  while IFS='|' read -r name image state status project; do
    [ -n "$name" ] || continue
    case "$name" in k8s_*) [ "$state" = running ] && k8s=$((k8s + 1)); [ "$all" = 1 ] || continue ;; esac
    if [ "$state" != running ] && [ "$all" != 1 ]; then stopped=$((stopped + 1)); continue; fi
    rec docker "$name" "$image" "$state" "$status${project:+ project=$project}"
  done <<EOF_DOCKER
$out
EOF_DOCKER
  if [ "$k8s" -gt 0 ] && [ "$all" != 1 ]; then rec docker "k8s_*" - "$k8s running" "Kubernetes pod containers; look at them with kubectl"; fi
  if [ "$stopped" -gt 0 ]; then rec docker "(not running)" - "$stopped" "stopped containers; --all lists them"; fi
}

status_services() { # a few host services that tell what kind of machine this is
  local unit version
  for unit in nginx caddy docker containerd kubelet; do
    edge_unit_known "$unit.service" || continue
    version=-
    case "$unit" in
      nginx) version="$(nginx -v 2>&1 | sed -n 's#.*nginx/##p')" ;;
      docker) version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || edge_as_root docker version --format '{{.Server.Version}}' 2>/dev/null)" ;;
      kubelet) version="$(kubelet --version 2>/dev/null | awk '{print $2}')" ;;
    esac
    rec service "$unit" "${version:--}" "$(edge_unit_state "$unit.service")" ""
  done
}

cmd_status() { # status [--health] [--all]
  set +e
  set +o pipefail
  local with_health=0 all=0 access arg
  for arg in "$@"; do
    case "$arg" in
      --health) with_health=1 ;;
      --all) all=1 ;;
    esac
  done
  edge_os_detect
  if [ "$(id -u)" = 0 ]; then access=root
  elif edge_have sudo && sudo -n true 2>/dev/null; then access=sudo
  else access="no root (some rows may be missing)"; fi
  rec host "$(host_name)" "$EDGE_OS_PRETTY" "$access" \
    "family=$EDGE_OS_FAMILY pkg=$EDGE_PKG init=$EDGE_INIT arch=$EDGE_ARCH root=$MX_ROOT$( [ -z "$(edge_os_eol)" ] || printf ' eol=yes')"
  status_edge_components "$with_health"
  status_tunnel_cli
  status_wireguard_interfaces
  status_docker "$all"
  status_services
  return 0
}

# ---------- check: read-only ----------

cpu_sample() { # prints "user system softirq steal idle" percentages over one second
  [ -r /proc/stat ] || { echo UNKNOWN; return; }
  local a b
  a="$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat)"
  sleep 1
  b="$(awk '/^cpu /{print $2,$3,$4,$5,$6,$7,$8,$9}' /proc/stat)"
  printf '%s %s\n' "$a" "$b" | awk '{
    for (i = 1; i <= 8; i++) d[i] = $(i + 8) - $i
    t = 0; for (i = 1; i <= 8; i++) t += d[i]
    if (t <= 0) { print "UNKNOWN"; exit }
    printf "user=%.0f%% system=%.0f%% softirq=%.0f%% steal=%.0f%% iowait=%.0f%% idle=%.0f%%\n",
      (d[1]+d[2])*100/t, d[3]*100/t, d[7]*100/t, d[8]*100/t, d[5]*100/t, d[4]*100/t
  }'
}

net_sample() { # prints rx/tx Mbps of the default-route interface over one second
  local dev
  dev="$(ip route show default 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "dev") {print $(i + 1); exit}}')"
  [ -n "$dev" ] && [ -r /proc/net/dev ] || { echo UNKNOWN; return; }
  local a b
  a="$(awk -v d="$dev:" '$1 == d {print $2, $10}' /proc/net/dev)"
  sleep 1
  b="$(awk -v d="$dev:" '$1 == d {print $2, $10}' /proc/net/dev)"
  printf '%s %s %s\n' "$dev" "$a" "$b" | awk '{printf "%s rx=%.1fMbps tx=%.1fMbps\n", $1, ($4-$2)*8/1e6, ($5-$3)*8/1e6}'
}

cmd_check() {
  # A report, not a gate: one probe failing must not hide the rest.
  set +e
  set +o pipefail
  edge_os_detect
  printf '== host\n'
  printf 'hostname=%s\n' "$(host_name)"
  printf 'os=%s\n' "$EDGE_OS_PRETTY"
  printf 'family=%s pkg=%s init=%s arch=%s\n' "$EDGE_OS_FAMILY" "$EDGE_PKG" "$EDGE_INIT" "$EDGE_ARCH"
  printf 'firewall=%s selinux=%s\n' "$(edge_firewall_kind)" "$(edge_selinux_mode)"
  if [ -n "$(edge_os_eol)" ]; then printf 'end_of_life=%s\n' "$(edge_os_eol_hint)"; fi
  printf 'kernel=%s\n' "$(uname -r)"
  printf 'cpus=%s\n' "$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo UNKNOWN)"
  printf 'load=%s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null || echo UNKNOWN)"
  printf 'uptime=%s\n' "$(uptime 2>/dev/null | sed 's/^ *//' || echo UNKNOWN)"
  if command -v free >/dev/null 2>&1; then
    printf 'memory=%s\n' "$(free -m | awk '/^Mem:/{printf "total=%sMiB used=%sMiB available=%sMiB", $2, $3, $7}')"
  else printf 'memory=UNKNOWN\n'; fi
  printf 'disk_root=%s\n' "$(df -hP / 2>/dev/null | awk 'NR==2{print $3 " used of " $2 " (" $5 ")"}')"

  printf '\n== cpu (1s sample; softirq is mostly packet work such as WireGuard, steal is the cloud host taking CPU back)\n'
  cpu_sample
  printf '\n== top processes by cpu\n'
  local procs
  procs="$(ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu 2>/dev/null || ps -Ao pid,user,%cpu,%mem,comm -r 2>/dev/null)"
  if [ -n "$procs" ]; then printf '%s\n' "$procs" | head -9; else echo UNKNOWN; fi

  printf '\n== network (1s sample of the default-route interface)\n'
  net_sample
  if command -v ss >/dev/null 2>&1; then
    printf 'tcp_established=%s\n' "$(ss -Htn state established 2>/dev/null | wc -l | tr -d ' ')"
    printf '\n== listening (tcp/udp)\n'
    local listeners
    if listeners="$(edge_as_root ss -Hltunp 2>/dev/null)"; then
      printf '%s\n' "$listeners" | awk '{print $1, $5, $7}' | sort -u | head -40
    else
      printf '(process names need root)\n'
      ss -Hltun 2>/dev/null | awk '{print $1, $5}' | sort -u | head -40
    fi
  else
    printf 'listening=UNKNOWN (no ss)\n'
  fi

  printf '\n== wireguard\n'
  if command -v wg >/dev/null 2>&1; then
    local ifaces
    if ifaces="$(edge_as_root wg show interfaces 2>/dev/null)"; then
      [ -n "$ifaces" ] || printf 'no interfaces\n'
      local i now; now="$(date +%s)"
      for i in $ifaces; do
        edge_as_root wg show "$i" latest-handshakes 2>/dev/null | awk -v i="$i" -v now="$now" '
          { n++; if ($2 > 0 && now - $2 < 180) a++ }
          END { printf "%s peers=%d handshake_within_3m=%d\n", i, n, a }'
      done
    else
      printf 'UNKNOWN (wg needs root; ssh as root or allow passwordless sudo)\n'
    fi
  else
    printf 'wg not installed\n'
  fi

  printf '\n== docker\n'
  if command -v docker >/dev/null 2>&1; then
    docker ps --format '{{.Names}}  {{.Status}}' 2>/dev/null \
      || edge_as_root docker ps --format '{{.Names}}  {{.Status}}' 2>/dev/null \
      || printf 'UNKNOWN (docker needs root or the docker group)\n'
  else
    printf 'docker not installed\n'
  fi

  printf '\n== releases under %s\n' "$MX_ROOT"
  cmd_releases
}

usage() {
  cat <<'EOF'
remote.sh <command> [args]
  check                                   read-only report: os, cpu, memory, network, listeners, wireguard, docker, releases
  status [--health] [--all]               read-only: one @edge record per release, tunnel-cli instance, container, host service
  releases [component]                    list pushed releases; * marks the live one
  activate <component> <revision> <tar> [state-tar]
                                          unpack an uploaded bundle, apply pushed state files, check the host
                                          (stack.env), then switch current and run deploy.sh and health.sh
  rollback <component> [revision]         switch current back (default: the previous release) and rerun its hooks
  state-export <component>                tar.gz on stdout of the state files pushes carried, as they are now
Environment: MX_ROOT (default /opt/mx), EDGE_ORIGIN (who pushes; default manual),
             EDGE_TAKE_OVER=1 (replace a component another origin or the v1 Launcher manages),
             EDGE_SHARED_HOST=1 (push onto a host where another tool deployed components), EDGE_FORCE_OS=1
EOF
}

command="${1:-help}"
[ $# -gt 0 ] && shift
case "$command" in
  check) cmd_check ;;
  status) cmd_status "$@" ;;
  releases) cmd_releases "$@" ;;
  activate) cmd_activate "$@" ;;
  rollback) cmd_rollback "$@" ;;
  state-export) cmd_state_export "$@" ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
