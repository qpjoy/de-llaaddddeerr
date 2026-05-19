#!/usr/bin/env bash
# HDO gateway installer scaffold.
#
# This script deliberately keeps domestic public ingress direct. It only
# creates the home overlay WireGuard config and optional scoped egress hints.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
STACK_DIR="$SCRIPT_DIR"
DATA_DIR="$STACK_DIR/data"
WG_DIR="$DATA_DIR/wireguard"
PEERS_DIR="$WG_DIR/peers"
ENV_FILE="$STACK_DIR/.env"

mkdir -p "$WG_DIR" "$PEERS_DIR"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/manage.sh hdo <command> [options]

Commands:
  menu                Interactive HDO deployment/config menu
  deploy-domestic     Guided domestic-vps + WireGuard setup
  setup-domestic      Generate domestic wg-home server config
  add-home            Generate one home peer config and append it to wg-home
  apply-domestic      Install generated wg-home config into /etc/wireguard
  setup-oversea-egress Write scoped egress env template for npm/GitHub/Docker
  status              Show generated files

Examples:
  ./scripts/manage.sh hdo deploy-domestic
  ./scripts/manage.sh hdo setup-domestic --server-url http://domestic:8080 --public-host domestic.example.com
  ./scripts/manage.sh hdo add-home --name home-main
  sudo ./scripts/manage.sh hdo apply-domestic

Optional API registration:
  HDO_TOKEN=<admin bearer token> ./scripts/manage.sh hdo setup-domestic --server-url http://domestic:8080
EOF
}

die() { echo "hdo: $*" >&2; exit 1; }
say() { echo "▸ $*"; }
ok() { echo "✓ $*"; }
warn() { echo "hdo: $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

gen_private_key() {
  require_cmd wg
  wg genkey
}

public_key_of() {
  require_cmd wg
  printf '%s' "$1" | wg pubkey
}

load_env() {
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
  fi
}

save_env() {
  cat > "$ENV_FILE" <<EOF
HDO_SERVER_URL=${HDO_SERVER_URL:-}
HDO_PUBLIC_HOST=${HDO_PUBLIC_HOST:-}
HDO_WG_PORT=${HDO_WG_PORT:-51888}
HDO_HOME_CIDR=${HDO_HOME_CIDR:-100.88.0.0/24}
HDO_DOMESTIC_IP=${HDO_DOMESTIC_IP:-100.88.0.1}
HDO_NEXT_HOME_OCTET=${HDO_NEXT_HOME_OCTET:-10}
HDO_DOMESTIC_PRIVATE_KEY=${HDO_DOMESTIC_PRIVATE_KEY:-}
HDO_DOMESTIC_PUBLIC_KEY=${HDO_DOMESTIC_PUBLIC_KEY:-}
EOF
}

parse_common() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --server-url) HDO_SERVER_URL="${2:?}"; shift 2 ;;
      --public-host) HDO_PUBLIC_HOST="${2:?}"; shift 2 ;;
      --port|--listen-port) HDO_WG_PORT="${2:?}"; shift 2 ;;
      --home-cidr) HDO_HOME_CIDR="${2:?}"; shift 2 ;;
      --domestic-ip) HDO_DOMESTIC_IP="${2:?}"; shift 2 ;;
      --name) HDO_PEER_NAME="${2:?}"; shift 2 ;;
      --peer-ip) HDO_PEER_IP="${2:?}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done
}

read_env_value() {
  local file="$1" key="$2"
  [ -f "$file" ] || return 1
  awk -F= -v k="$key" '
    $1 == k {
      sub(/^[^=]*=/, "")
      gsub(/^["'\'' ]+|["'\'' ]+$/, "")
      print
      exit
    }
  ' "$file"
}

port_from_value() {
  local value="$1"
  value="${value##*,}"
  value="${value##*:}"
  value="${value%%/*}"
  case "$value" in
    ''|*[!0-9]*) return 1 ;;
    *) echo "$value" ;;
  esac
}

detect_market_port() {
  local port=""
  if command -v docker >/dev/null 2>&1; then
    port="$(docker port qpjoy-market 8080/tcp 2>/dev/null | head -n 1 || true)"
    if [ -n "$port" ]; then
      port_from_value "$port" && return 0
    fi
    port="$(docker ps --filter name=qpjoy-market --format '{{.Ports}}' 2>/dev/null | head -n 1 || true)"
    if [ -n "$port" ]; then
      port_from_value "$port" && return 0
    fi
  fi
  port="$(read_env_value "$ROOT_DIR/electron-server/.env" MARKET_PORT 2>/dev/null || true)"
  if [ -n "$port" ]; then
    port_from_value "$port" && return 0
  fi
  echo 8080
}

detect_public_host() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then
    ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '$1 !~ /^127\./ {print; exit}')"
  fi
  if [ -z "$ip" ] && command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig 2>/dev/null | awk '/inet / && $2 !~ /^127\./ {print $2; exit}')"
  fi
  if [ -n "$ip" ]; then
    echo "$ip"
  else
    hostname -f 2>/dev/null || hostname
  fi
}

prompt_default() {
  local prompt="$1" default="$2" value
  if [ -t 0 ]; then
    read -r -p "$prompt [$default]: " value
    echo "${value:-$default}"
  else
    echo "$default"
  fi
}

prompt_yes_no() {
  local prompt="$1" default="${2:-y}" value suffix
  suffix="[y/N]"
  [ "$default" = "y" ] && suffix="[Y/n]"
  if [ -t 0 ]; then
    read -r -p "$prompt $suffix " value
  else
    value="$default"
  fi
  value="${value:-$default}"
  case "$value" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

sudo_apply_domestic() {
  if [ "$(id -u)" -eq 0 ]; then
    cmd_apply_domestic
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo bash "$SCRIPT_DIR/manage.sh" apply-domestic
  else
    warn "sudo not found; run as root later: ./scripts/manage.sh hdo apply-domestic"
    return 1
  fi
}

cmd_deploy_domestic() {
  load_env
  local assume_yes=0 apply_now=1 create_home=1 setup_egress=1 force_setup=0
  HDO_SERVER_URL="${HDO_SERVER_URL:-}"
  HDO_PUBLIC_HOST="${HDO_PUBLIC_HOST:-}"
  HDO_WG_PORT="${HDO_WG_PORT:-51888}"
  HDO_HOME_CIDR="${HDO_HOME_CIDR:-100.88.0.0/24}"
  HDO_DOMESTIC_IP="${HDO_DOMESTIC_IP:-100.88.0.1}"
  HDO_PEER_NAME="${HDO_PEER_NAME:-home-main}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes|-y) assume_yes=1; shift ;;
      --apply) apply_now=1; shift ;;
      --no-apply) apply_now=0; shift ;;
      --home-peer) create_home=1; shift ;;
      --no-home-peer) create_home=0; shift ;;
      --egress) setup_egress=1; shift ;;
      --no-egress) setup_egress=0; shift ;;
      --force) force_setup=1; shift ;;
      --server-url) HDO_SERVER_URL="${2:?}"; shift 2 ;;
      --public-host) HDO_PUBLIC_HOST="${2:?}"; shift 2 ;;
      --port|--listen-port) HDO_WG_PORT="${2:?}"; shift 2 ;;
      --home-cidr) HDO_HOME_CIDR="${2:?}"; shift 2 ;;
      --domestic-ip) HDO_DOMESTIC_IP="${2:?}"; shift 2 ;;
      --name) HDO_PEER_NAME="${2:?}"; shift 2 ;;
      --peer-ip) HDO_PEER_IP="${2:?}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  local detected_port
  detected_port="$(detect_market_port)"
  HDO_PUBLIC_HOST="${HDO_PUBLIC_HOST:-$(detect_public_host)}"
  HDO_SERVER_URL="${HDO_SERVER_URL:-http://${HDO_PUBLIC_HOST}:${detected_port}}"

  if [ "$assume_yes" -ne 1 ]; then
    echo
    echo "HDO domestic 部署向导"
    echo "检测到的默认值可以直接回车确认。"
    HDO_PUBLIC_HOST="$(prompt_default "domestic 公网 IP/域名" "$HDO_PUBLIC_HOST")"
    HDO_SERVER_URL="$(prompt_default "HDO / 插件市场 server URL" "$HDO_SERVER_URL")"
    HDO_WG_PORT="$(prompt_default "WireGuard UDP 端口" "$HDO_WG_PORT")"
    HDO_DOMESTIC_IP="$(prompt_default "domestic overlay IP" "$HDO_DOMESTIC_IP")"
    HDO_PEER_NAME="$(prompt_default "首个 Home peer 名称" "$HDO_PEER_NAME")"
    prompt_yes_no "现在启用 wg-quick@hdo-home？" y || apply_now=0
    prompt_yes_no "生成首个 Home WireGuard 配置？" y || create_home=0
    prompt_yes_no "生成 oversea scoped egress 模板？" y || setup_egress=0
    if [ -f "$WG_DIR/wg-home.conf" ]; then
      prompt_yes_no "已存在 wg-home.conf，是否重新生成？这会移除已追加 peer" n && force_setup=1
    fi
  fi

  HDO_SERVER_URL="$HDO_SERVER_URL"
  HDO_PUBLIC_HOST="$HDO_PUBLIC_HOST"
  HDO_WG_PORT="$HDO_WG_PORT"
  HDO_DOMESTIC_IP="$HDO_DOMESTIC_IP"
  save_env

  if [ ! -f "$WG_DIR/wg-home.conf" ] || [ "$force_setup" -eq 1 ]; then
    cmd_setup_domestic \
      --server-url "$HDO_SERVER_URL" \
      --public-host "$HDO_PUBLIC_HOST" \
      --port "$HDO_WG_PORT" \
      --home-cidr "$HDO_HOME_CIDR" \
      --domestic-ip "$HDO_DOMESTIC_IP"
  else
    ok "kept existing $WG_DIR/wg-home.conf"
  fi

  if [ "$apply_now" -eq 1 ]; then
    sudo_apply_domestic || true
  fi

  if [ "$create_home" -eq 1 ]; then
    local peer_args=(--name "$HDO_PEER_NAME")
    if [ -n "${HDO_PEER_IP:-}" ]; then
      peer_args+=(--peer-ip "$HDO_PEER_IP")
    fi
    cmd_add_home "${peer_args[@]}"
  fi

  if [ "$setup_egress" -eq 1 ]; then
    cmd_setup_oversea_egress --server-url "$HDO_SERVER_URL" --public-host "$HDO_PUBLIC_HOST"
  fi

  echo
  ok "HDO domestic deploy wizard finished"
  echo "Server URL: $HDO_SERVER_URL"
  echo "Public host: $HDO_PUBLIC_HOST"
  echo "WireGuard:  udp/${HDO_WG_PORT}, domestic ${HDO_DOMESTIC_IP}"
  if [ "$create_home" -eq 1 ]; then
    echo "Home peer:  $PEERS_DIR/${HDO_PEER_NAME}.conf"
  fi
}

cmd_setup_domestic() {
  load_env
  HDO_SERVER_URL="${HDO_SERVER_URL:-}"
  HDO_PUBLIC_HOST="${HDO_PUBLIC_HOST:-}"
  HDO_WG_PORT="${HDO_WG_PORT:-51888}"
  HDO_HOME_CIDR="${HDO_HOME_CIDR:-100.88.0.0/24}"
  HDO_DOMESTIC_IP="${HDO_DOMESTIC_IP:-100.88.0.1}"
  HDO_NEXT_HOME_OCTET="${HDO_NEXT_HOME_OCTET:-10}"
  parse_common "$@"

  [ -n "$HDO_PUBLIC_HOST" ] || HDO_PUBLIC_HOST="$(hostname -f 2>/dev/null || hostname)"
  if [ -z "${HDO_DOMESTIC_PRIVATE_KEY:-}" ]; then
    HDO_DOMESTIC_PRIVATE_KEY="$(gen_private_key)"
    HDO_DOMESTIC_PUBLIC_KEY="$(public_key_of "$HDO_DOMESTIC_PRIVATE_KEY")"
  fi
  save_env

  cat > "$WG_DIR/wg-home.conf" <<EOF
[Interface]
Address = ${HDO_DOMESTIC_IP}/24
ListenPort = ${HDO_WG_PORT}
PrivateKey = ${HDO_DOMESTIC_PRIVATE_KEY}

# HDO home peers are appended by:
#   ./scripts/manage.sh hdo add-home --name home-main
EOF

  ok "generated $WG_DIR/wg-home.conf"
  maybe_register_node "domestic" "domestic-vps" "$HDO_PUBLIC_HOST" "$HDO_DOMESTIC_IP"
  echo
  echo "Next:"
  echo "  sudo ./scripts/manage.sh hdo apply-domestic"
  echo "  ./scripts/manage.sh hdo add-home --name home-main"
}

cmd_add_home() {
  load_env
  [ -f "$WG_DIR/wg-home.conf" ] || die "run setup-domestic first"
  HDO_PEER_NAME="${HDO_PEER_NAME:-home-main}"
  HDO_NEXT_HOME_OCTET="${HDO_NEXT_HOME_OCTET:-10}"
  HDO_WG_PORT="${HDO_WG_PORT:-51888}"
  HDO_PUBLIC_HOST="${HDO_PUBLIC_HOST:-}"
  HDO_DOMESTIC_PUBLIC_KEY="${HDO_DOMESTIC_PUBLIC_KEY:-}"
  parse_common "$@"

  local peer_ip="${HDO_PEER_IP:-100.88.0.${HDO_NEXT_HOME_OCTET}}"
  local private public conf
  conf="$PEERS_DIR/${HDO_PEER_NAME}.conf"

  if [ -f "$conf" ]; then
    ok "home peer already exists: $conf"
    return 0
  fi
  if grep -q "BEGIN_HDO_PEER ${HDO_PEER_NAME}" "$WG_DIR/wg-home.conf"; then
    die "peer ${HDO_PEER_NAME} already exists in wg-home.conf but $conf is missing; choose another --name"
  fi

  private="$(gen_private_key)"
  public="$(public_key_of "$private")"

  cat >> "$WG_DIR/wg-home.conf" <<EOF

# BEGIN_HDO_PEER ${HDO_PEER_NAME}
[Peer]
PublicKey = ${public}
AllowedIPs = ${peer_ip}/32
PersistentKeepalive = 25
# END_HDO_PEER ${HDO_PEER_NAME}
EOF

  cat > "$conf" <<EOF
[Interface]
Address = ${peer_ip}/24
PrivateKey = ${private}

[Peer]
PublicKey = ${HDO_DOMESTIC_PUBLIC_KEY}
AllowedIPs = 100.88.0.0/16, 100.90.0.0/16
Endpoint = ${HDO_PUBLIC_HOST}:${HDO_WG_PORT}
PersistentKeepalive = 25
EOF

  HDO_NEXT_HOME_OCTET=$((HDO_NEXT_HOME_OCTET + 1))
  save_env

  ok "generated home peer $conf"
  maybe_register_node "home" "$HDO_PEER_NAME" "" "$peer_ip"
  echo
  echo "Install this file on the home node:"
  echo "  $conf"
}

cmd_apply_domestic() {
  [ "$(id -u)" -eq 0 ] || die "apply-domestic must run as root"
  [ -f "$WG_DIR/wg-home.conf" ] || die "run setup-domestic first"
  require_cmd systemctl
  install -d -m 700 /etc/wireguard
  install -m 600 "$WG_DIR/wg-home.conf" /etc/wireguard/hdo-home.conf
  systemctl enable --now wg-quick@hdo-home
  ok "enabled wg-quick@hdo-home"
}

cmd_setup_oversea_egress() {
  load_env
  parse_common "$@"
  cat > "$STACK_DIR/egress.env.example" <<'EOF'
# Scoped egress only. Do not use this as a host-wide proxy profile.
MARKET_SYNC_PROXY_URL=http://127.0.0.1:7890
GITHUB_PROXY_URL=http://127.0.0.1:7890
DOCKER_PROXY_URL=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1,::1,postgres,100.88.0.0/16,100.89.0.0/16,100.90.0.0/16
EOF
  ok "wrote $STACK_DIR/egress.env.example"
}

cmd_status() {
  load_env
  echo "stack: $STACK_DIR"
  echo "server: ${HDO_SERVER_URL:-}"
  echo "public host: ${HDO_PUBLIC_HOST:-}"
  echo "wg config: $WG_DIR/wg-home.conf"
  [ -f "$WG_DIR/wg-home.conf" ] && sed -n '1,120p' "$WG_DIR/wg-home.conf"
  echo
  echo "peers:"
  find "$PEERS_DIR" -maxdepth 1 -type f -name '*.conf' -print 2>/dev/null | sort
}

cmd_menu() {
  local options=(
    "deploy-domestic    部署 domestic-vps + WireGuard"
    "add-home           生成 Home WireGuard peer"
    "apply-domestic     启用 wg-quick@hdo-home"
    "setup-egress       生成 oversea scoped egress 模板"
    "status             查看 HDO 状态"
    "help               帮助"
    "quit               退出"
  )
  echo "HDO Gateway Manager"
  echo
  PS3=$'\n选择 HDO 操作 > '
  select opt in "${options[@]}"; do
    [ -z "$opt" ] && continue
    local cmd="${opt%% *}"
    case "$cmd" in
      deploy-domestic) cmd_deploy_domestic ;;
      add-home)        cmd_add_home ;;
      apply-domestic)  sudo_apply_domestic ;;
      setup-egress)    cmd_setup_oversea_egress ;;
      status)          cmd_status ;;
      help)            usage ;;
      quit|exit)       break ;;
      *) warn "unknown option" ;;
    esac
    echo
  done
}

maybe_register_node() {
  local kind="$1" name="$2" public_host="$3" overlay_ip="$4"
  [ -n "${HDO_SERVER_URL:-}" ] || return 0
  [ -n "${HDO_TOKEN:-}" ] || return 0
  require_cmd curl
  curl -fsS \
    -H "authorization: Bearer ${HDO_TOKEN}" \
    -H "content-type: application/json" \
    -X POST \
    --data "{\"name\":\"${name}\",\"kind\":\"${kind}\",\"publicHost\":\"${public_host}\",\"overlayIp\":\"${overlay_ip}\",\"status\":\"pending\"}" \
    "${HDO_SERVER_URL%/}/api/v1/hdo/admin/nodes" >/dev/null \
    && ok "registered ${kind} node in HDO control plane" \
    || echo "hdo: node registration failed; generated local config anyway" >&2
}

command="${1:-menu}"
shift || true
case "$command" in
  menu) cmd_menu ;;
  deploy-domestic|deploy) cmd_deploy_domestic "$@" ;;
  setup-domestic) cmd_setup_domestic "$@" ;;
  add-home) cmd_add_home "$@" ;;
  apply-domestic) cmd_apply_domestic "$@" ;;
  setup-oversea-egress) cmd_setup_oversea_egress "$@" ;;
  status) cmd_status "$@" ;;
  help|-h|--help) usage ;;
  *) usage; die "unknown command: $command" ;;
esac
