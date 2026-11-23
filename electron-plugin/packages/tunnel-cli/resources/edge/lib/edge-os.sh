# shellcheck shell=bash
# qp-tunnel-cli edge: operating-system adaptation shared by remote.sh and every stack hook.
#
# Sourcing this file only defines functions. edge_os_detect fills:
#   EDGE_OS_ID       ubuntu, debian, centos, rocky, almalinux, rhel, fedora, ... or unknown
#   EDGE_OS_VERSION  VERSION_ID from os-release (EDGE_OS_MAJOR is the part before the first dot)
#   EDGE_OS_PRETTY   PRETTY_NAME, for messages
#   EDGE_OS_NAME     NAME ("CentOS Linux" and "CentOS Stream" share ID=centos)
#   EDGE_OS_FAMILY   debian | rhel | unknown   <- what stacks declare in STACK_OS
#   EDGE_PKG         apt | dnf | yum | none
#   EDGE_INIT        systemd | other
#   EDGE_ARCH        uname -m
#
# Stacks call edge_pkg_install with real package names and branch on
# EDGE_OS_FAMILY where names differ. Nothing here opens firewall ports: the
# report functions say what is open and print the command, a person runs it.
#
# Must stay bash 3.2 compatible: the tests source it on macOS.

edge_log() { printf '[edge] %s\n' "$*"; }
edge_warn() { printf '[edge] warning: %s\n' "$*" >&2; }
edge_die() { printf '[edge] error: %s\n' "$*" >&2; exit 1; }
edge_have() { command -v "$1" >/dev/null 2>&1; }

edge_same_file() { # true when both files exist with the same bytes
  [ -f "$1" ] && [ -f "$2" ] || return 1
  # cmp lives in diffutils, which minimal CentOS/Rocky images leave out; cksum is coreutils.
  if command -v cmp >/dev/null 2>&1; then cmp -s "$1" "$2"
  else [ "$(cksum < "$1")" = "$(cksum < "$2")" ]; fi
}

edge_unquote() { # strips one pair of surrounding quotes
  local value="$1"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

edge_kv() { # edge_kv <file> <KEY>  value of KEY=value from a file that is parsed, not sourced
  local line
  [ -r "$1" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      "$2="*) edge_unquote "${line#"$2"=}"; return 0 ;;
    esac
  done < "$1"
}

# ---------- IPv4 networks ----------

edge_ip_to_int() { # edge_ip_to_int a.b.c.d  prints the address as an integer; fails on anything else
  local ip="$1" a b c d rest part
  case "$ip" in ''|*[!0-9.]*|.*|*.|*..*) return 1 ;; esac
  IFS=. read -r a b c d rest <<EOF
$ip
EOF
  [ -n "$d" ] && [ -z "$rest" ] || return 1
  for part in "$a" "$b" "$c" "$d"; do
    [ "${#part}" -le 3 ] && [ $((10#$part)) -le 255 ] || return 1
  done
  printf '%s' $(( (10#$a << 24) + (10#$b << 16) + (10#$c << 8) + 10#$d ))
}

edge_cidr_parse() { # edge_cidr_parse a.b.c.d[/n]  prints "<network as integer> <prefix>"
  local addr="${1%/*}" prefix=32 n mask
  case "$1" in */*) prefix="${1#*/}" ;; esac
  case "$prefix" in ''|*[!0-9]*) return 1 ;; esac
  [ "$prefix" -le 32 ] || return 1
  n="$(edge_ip_to_int "$addr")" || return 1
  if [ "$prefix" -eq 0 ]; then mask=0; else mask=$(( (0xFFFFFFFF << (32 - prefix)) & 0xFFFFFFFF )); fi
  printf '%s %s' $(( n & mask )) "$prefix"
}

edge_cidr_overlap() { # edge_cidr_overlap <cidr> <cidr>  true when the two blocks share any address
  local a b an ap bn bp p mask
  a="$(edge_cidr_parse "$1")" || return 1
  b="$(edge_cidr_parse "$2")" || return 1
  an="${a% *}"; ap="${a#* }"; bn="${b% *}"; bp="${b#* }"
  p="$ap"; [ "$bp" -lt "$p" ] && p="$bp"
  if [ "$p" -eq 0 ]; then mask=0; else mask=$(( (0xFFFFFFFF << (32 - p)) & 0xFFFFFFFF )); fi
  [ $(( an & mask )) -eq $(( bn & mask )) ]
}

edge_route_overlaps() { # edge_route_overlaps <cidr> [own_interface]  prints routes (any table) overlapping <cidr>, "; "-separated
  local want="$1" own="${2:-}" line dest dev
  edge_have ip || return 0
  while IFS= read -r line; do
    # shellcheck disable=SC2086
    set -- $line
    case "${1:-}" in
      ''|default|local|broadcast|multicast|anycast|nat) continue ;;
      unicast|blackhole|unreachable|prohibit|throw) shift ;;
    esac
    dest="${1:-}"
    case "$dest" in ''|default) continue ;; esac
    dev="$(printf '%s\n' "$line" | sed -n 's/.* dev \([^ ]*\).*/\1/p')"
    if [ -n "$own" ] && [ "$dev" = "$own" ]; then continue; fi
    if edge_cidr_overlap "$want" "$dest"; then printf '%s; ' "$line"; fi
  done <<EOF
$(ip -4 route show table all 2>/dev/null)
EOF
}

edge_os_detect() {
  EDGE_OS_ID=unknown
  EDGE_OS_LIKE=
  EDGE_OS_VERSION=
  EDGE_OS_NAME=
  EDGE_OS_PRETTY="$(uname -s 2>/dev/null || echo unknown)"
  local file="${EDGE_OS_RELEASE_FILE:-/etc/os-release}" line
  if [ -r "$file" ]; then
    # Parsed, not sourced: the file only gets to set these five values.
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        NAME=*) EDGE_OS_NAME="$(edge_unquote "${line#NAME=}")" ;;
        ID=*) EDGE_OS_ID="$(edge_unquote "${line#ID=}")" ;;
        ID_LIKE=*) EDGE_OS_LIKE="$(edge_unquote "${line#ID_LIKE=}")" ;;
        VERSION_ID=*) EDGE_OS_VERSION="$(edge_unquote "${line#VERSION_ID=}")" ;;
        PRETTY_NAME=*) EDGE_OS_PRETTY="$(edge_unquote "${line#PRETTY_NAME=}")" ;;
      esac
    done < "$file"
  fi
  EDGE_OS_MAJOR="${EDGE_OS_VERSION%%.*}"
  case " $EDGE_OS_ID $EDGE_OS_LIKE " in
    *" debian "*|*" ubuntu "*) EDGE_OS_FAMILY=debian ;;
    *" rhel "*|*" centos "*|*" fedora "*|*" rocky "*|*" almalinux "*|*" ol "*) EDGE_OS_FAMILY=rhel ;;
    *) EDGE_OS_FAMILY=unknown ;;
  esac
  if edge_have apt-get; then EDGE_PKG=apt
  elif edge_have dnf; then EDGE_PKG=dnf
  elif edge_have yum; then EDGE_PKG=yum
  else EDGE_PKG=none; fi
  if [ -d /run/systemd/system ]; then EDGE_INIT=systemd; else EDGE_INIT=other; fi
  EDGE_ARCH="$(uname -m 2>/dev/null || echo unknown)"
}

edge_os_summary() { # one line, for logs and reports
  printf '%s (family=%s pkg=%s init=%s arch=%s)' "$EDGE_OS_PRETTY" "$EDGE_OS_FAMILY" "$EDGE_PKG" "$EDGE_INIT" "$EDGE_ARCH"
}

edge_os_eol() { # prints a note when the vendor no longer updates this release; nothing otherwise
  case "$EDGE_OS_ID:$EDGE_OS_NAME:$EDGE_OS_MAJOR" in
    'centos:CentOS Linux:8') printf 'CentOS Linux 8 reached end of life on 2021-12-31' ;;
    'centos:CentOS Linux:7') printf 'CentOS Linux 7 reached end of life on 2024-06-30' ;;
    'centos:CentOS Stream:8') printf 'CentOS Stream 8 reached end of life on 2024-05-31' ;;
  esac
}

edge_os_eol_hint() { # what an end-of-life release means for edge_pkg_install
  local eol; eol="$(edge_os_eol)"
  [ -n "$eol" ] || return 0
  printf '%s; its mirrors moved to vault.centos.org, so package installs work only if this host'"'"'s repositories point at the vault or a local mirror (this tool does not change repository files)' "$eol"
}

edge_require_systemd() {
  [ "$EDGE_INIT" = systemd ] || edge_die "this stack needs systemd; $EDGE_OS_PRETTY is not running it"
}

# ---------- packages ----------

edge_pkg_installed() { # edge_pkg_installed <package>
  case "$EDGE_PKG" in
    apt) dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'install ok installed' ;;
    dnf|yum) rpm -q "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

edge_pkg_install() { # edge_pkg_install <package>...  installs only the missing ones
  local missing="" pkg
  for pkg in "$@"; do
    edge_pkg_installed "$pkg" || missing="$missing $pkg"
  done
  [ -n "$missing" ] || return 0
  edge_log "installing:$missing ($EDGE_PKG)"
  case "$EDGE_PKG" in
    apt)
      if [ -z "${EDGE_APT_UPDATED:-}" ]; then
        DEBIAN_FRONTEND=noninteractive apt-get update -q || edge_die "apt-get update failed"
        EDGE_APT_UPDATED=1
      fi
      # shellcheck disable=SC2086
      DEBIAN_FRONTEND=noninteractive apt-get install -y -q $missing || edge_die "apt-get install failed:$missing"
      ;;
    dnf)
      # shellcheck disable=SC2086
      dnf install -y -q $missing || edge_pkg_failed dnf "$missing"
      ;;
    yum)
      # shellcheck disable=SC2086
      yum install -y -q $missing || edge_pkg_failed yum "$missing"
      ;;
    *) edge_die "no package manager found (looked for apt-get, dnf, yum); install by hand:$missing" ;;
  esac
}

edge_pkg_failed() { # edge_pkg_failed <tool> <packages>
  local hint; hint="$(edge_os_eol_hint)"
  edge_die "$1 install failed:$2${hint:+. $hint}"
}

edge_need_cmd() { # edge_need_cmd <command> <package>  installs the package only when the command is missing
  # By command, not package name: RHEL 9 ships curl as curl-minimal, and asking
  # dnf for "curl" then conflicts with it.
  edge_have "$1" || edge_pkg_install "$2"
}

edge_pkg_available() { # edge_pkg_available <package>  true when the repositories know it
  case "$EDGE_PKG" in
    apt) apt-cache show "$1" >/dev/null 2>&1 ;;
    dnf) dnf -q list --available "$1" >/dev/null 2>&1 || rpm -q "$1" >/dev/null 2>&1 ;;
    yum) yum -q list available "$1" >/dev/null 2>&1 || rpm -q "$1" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}

edge_need_epel() { # CentOS/Rocky/Alma keep nginx, openvpn and friends in EPEL on older releases
  [ "$EDGE_OS_FAMILY" = rhel ] || return 0
  [ "$EDGE_OS_ID" != fedora ] || return 0
  edge_pkg_installed epel-release && return 0
  edge_pkg_install epel-release
}

# ---------- services ----------

edge_unit_state() { # prints active | inactive | failed | activating | unknown
  local state
  if edge_have systemctl; then
    state="$(systemctl is-active "$1" 2>/dev/null || true)"
    [ -n "$state" ] || state=unknown
  else
    state=unknown
  fi
  printf '%s' "$state"
}

edge_unit_known() { # true when systemd has a unit file or a loaded unit by that name
  edge_have systemctl || return 1
  # No --value: CentOS 7 ships systemd 219.
  [ "$(systemctl show -p LoadState "$1" 2>/dev/null)" = LoadState=loaded ]
}

edge_service_enable_now() {
  systemctl enable --now "$1" >/dev/null || edge_die "systemctl enable --now $1 failed"
}

edge_service_reload() { # reload when running, start otherwise
  if [ "$(edge_unit_state "$1")" = active ]; then
    systemctl reload "$1" || systemctl restart "$1" || edge_die "could not reload $1"
  else
    edge_service_enable_now "$1"
  fi
}

# ---------- read-only reports ----------

edge_as_root() { # run a read-only command as root when that needs no password prompt
  if [ "$(id -u)" = 0 ]; then "$@"
  elif edge_have sudo && sudo -n true 2>/dev/null; then sudo -n "$@"
  else return 126; fi
}

edge_firewall_kind() { # ufw | firewalld | none | unknown
  if edge_have ufw; then
    local out
    if out="$(edge_as_root ufw status 2>/dev/null)"; then
      case "$out" in *"Status: active"*) printf ufw; return ;; esac
    else
      printf unknown; return
    fi
  fi
  if edge_have firewall-cmd && [ "$(edge_unit_state firewalld)" = active ]; then printf firewalld; return; fi
  printf none
}

edge_selinux_mode() { # Enforcing | Permissive | Disabled | absent
  if edge_have getenforce; then getenforce 2>/dev/null || printf unknown; else printf absent; fi
}

edge_firewall_report() { # edge_firewall_report <port/proto>...  (ports may be ranges like 20000-20100/udp)
  local kind spec port proto
  kind="$(edge_firewall_kind)"
  edge_log "firewall on this host: $kind. The cloud security group must also allow: $*"
  for spec in "$@"; do
    port="${spec%/*}"; proto="${spec#*/}"
    case "$kind" in
      ufw)
        if edge_as_root ufw status 2>/dev/null | grep -Eq "^${port//-/:}/${proto}[[:space:]].*ALLOW"; then
          edge_log "  $spec allowed by ufw"
        else
          edge_log "  $spec NOT allowed by ufw. To open it: sudo ufw allow ${port//-/:}/${proto}"
        fi
        ;;
      firewalld)
        if firewall-cmd --query-port="$spec" >/dev/null 2>&1; then
          edge_log "  $spec allowed by firewalld"
        else
          edge_log "  $spec not listed as a firewalld port (it may be open as a service). To open it: sudo firewall-cmd --permanent --add-port=$spec && sudo firewall-cmd --reload"
        fi
        ;;
    esac
  done
}

edge_selinux_proxy_check() { # nginx on SELinux-enforcing hosts cannot proxy until httpd_can_network_connect is on
  [ "$(edge_selinux_mode)" = Enforcing ] || return 0
  if getsebool httpd_can_network_connect 2>/dev/null | grep -q -- '--> on'; then return 0; fi
  if [ "${EDGE_SELINUX_ALLOW_PROXY:-0}" = 1 ]; then
    edge_log "SELinux: turning on httpd_can_network_connect (EDGE_SELINUX_ALLOW_PROXY=1)"
    setsebool -P httpd_can_network_connect 1 || edge_die "setsebool failed"
  else
    edge_warn "SELinux is enforcing and httpd_can_network_connect is off: nginx will answer 502 for proxied sites."
    edge_warn "Run 'sudo setsebool -P httpd_can_network_connect 1', or set EDGE_SELINUX_ALLOW_PROXY=1 in the stack env and push again."
  fi
}

# ---------- docker ----------

edge_compose_cmd() { # prints "docker compose" or "docker-compose", or nothing
  if docker compose version >/dev/null 2>&1; then printf 'docker compose'
  elif edge_have docker-compose; then printf 'docker-compose'; fi
}

edge_ensure_docker() {
  if edge_have docker && [ -n "$(edge_compose_cmd)" ]; then
    [ "$(edge_unit_state docker)" = active ] || edge_service_enable_now docker
    return 0
  fi
  [ "${EDGE_INSTALL_DOCKER:-1}" = 1 ] || edge_die "docker with compose is missing and EDGE_INSTALL_DOCKER=0; install it first"
  case "$EDGE_OS_FAMILY" in
    debian)
      edge_have docker || edge_pkg_install docker.io
      if [ -z "$(edge_compose_cmd)" ]; then
        local candidate
        for candidate in docker-compose-v2 docker-compose-plugin docker-compose; do
          if edge_pkg_available "$candidate"; then edge_pkg_install "$candidate"; break; fi
        done
      fi
      ;;
    rhel)
      if ! edge_have docker; then
        # Docker CE's repository; EDGE_DOCKER_REPO can point at a mirror such as
        # https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo
        local repo="${EDGE_DOCKER_REPO:-https://download.docker.com/linux/centos/docker-ce.repo}"
        if [ ! -f /etc/yum.repos.d/docker-ce.repo ]; then
          edge_log "adding the Docker CE repository from $repo"
          curl -fsSL "$repo" -o /etc/yum.repos.d/docker-ce.repo || edge_die "could not fetch $repo (set EDGE_DOCKER_REPO to a reachable mirror)"
        fi
        edge_pkg_install docker-ce docker-ce-cli containerd.io docker-compose-plugin
      elif [ -z "$(edge_compose_cmd)" ]; then
        edge_pkg_install docker-compose-plugin
      fi
      ;;
    *) edge_die "do not know how to install docker on $EDGE_OS_PRETTY; install docker and compose by hand" ;;
  esac
  edge_service_enable_now docker
  [ -n "$(edge_compose_cmd)" ] || edge_die "docker is installed but neither 'docker compose' nor 'docker-compose' works"
}

edge_docker_load() { # edge_docker_load <dir>  loads image tarballs shipped with the release (edge push --image)
  local dir="$1" file
  [ -d "$dir" ] || return 0
  for file in "$dir"/*.tar "$dir"/*.tar.gz; do
    [ -f "$file" ] || continue
    edge_log "docker load $(basename "$file")"
    docker load -i "$file" >/dev/null || edge_die "docker load failed for $file"
  done
}

edge_container_running() { # true when a container by that name is running
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]
}
