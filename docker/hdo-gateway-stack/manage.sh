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
DNS_DIR="$DATA_DIR/dns"
DNS_HOSTS_FILE="$DNS_DIR/hdo.hosts"
DNS_COREFILE="$DNS_DIR/Corefile"
DNS_CONTAINER="${HDO_DNS_CONTAINER:-hdo-coredns}"
DNS_IMAGE="${HDO_DNS_IMAGE:-coredns/coredns:1.11.3}"
DNS_BIND_IP="${HDO_DNS_BIND_IP:-100.88.0.1}"
DNS_UPSTREAMS="${HDO_DNS_UPSTREAMS:-223.5.5.5 119.29.29.29 1.1.1.1 8.8.8.8}"
ENV_FILE="$STACK_DIR/.env"

mkdir -p "$WG_DIR" "$PEERS_DIR" "$DNS_DIR"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/manage.sh hdo <command> [options]

Commands:
  menu                Interactive HDO deployment/config menu
  deploy-domestic     Guided domestic-vps + WireGuard setup
  setup-domestic      Generate domestic wg-home server config
  add-home            Generate one home peer config and append it to wg-home
  sync-domestic-peers Pull managed H member/client peers from electron-server
  sync-and-repair-domestic
                      Pull peers, reload live WireGuard, routes and forwarding
  sync-dns            Pull HDO DNS hosts and run CoreDNS on 100.88.0.1:53
  apply-domestic      Install generated wg-home config into /etc/wireguard
  repair-domestic-routes
                      Reload live domestic peers, routes and forwarding rules
  deploy-domestic-mihomo-wireguard
                      Run docker/wg-mihomo-stack setup from this HDO entrypoint
  deploy-oversea-mihomo-hysteria2
                      Run docker/hysteria2-mihomo-stack setup from this HDO entrypoint
  tunnel-reconcile-oversea
                      Apply D tunnel control-plane state to oversea Mihomo + Hysteria2
  tunnel-status-oversea
                      Show oversea Mihomo + Hysteria2 status from this entrypoint
  setup-oversea-egress Write scoped egress env template for npm/GitHub/Docker
  nuke                Wipe generated HDO gateway state; optional host WG cleanup
  status              Show generated files

Examples:
  ./scripts/manage.sh hdo deploy-domestic
  ./scripts/manage.sh hdo setup-domestic --server-url http://domestic:8080 --public-host domestic.example.com
  ./scripts/manage.sh hdo add-home --name home-main
  ./scripts/manage.sh hdo sync-domestic-peers --server-url http://domestic:8080
  sudo ./scripts/manage.sh hdo sync-and-repair-domestic --server-url http://domestic:8080
  sudo ./scripts/manage.sh hdo sync-dns --server-url http://domestic:8080
  sudo ./scripts/manage.sh hdo apply-domestic
  sudo ./scripts/manage.sh hdo repair-domestic-routes
  sudo ./scripts/manage.sh hdo deploy-domestic-mihomo-wireguard
  sudo ./scripts/manage.sh hdo deploy-oversea-mihomo-hysteria2
  sudo QPJOY_TUNNEL_STATE_FILE=/tmp/state.json ./scripts/manage.sh hdo tunnel-reconcile-oversea
  sudo ./scripts/manage.sh hdo nuke --all --yes

Optional API registration:
  HDO_TOKEN=<admin bearer token> ./scripts/manage.sh hdo setup-domestic --server-url http://domestic:8080

Direct sync commands reuse electron-server/data/hdo-gateway-runner.token when
present. If the token file is missing, pass HDO_TOKEN or HDO_GATEWAY_RUNNER_TOKEN.
EOF
}

die() { echo "hdo: $*" >&2; exit 1; }
say() { echo "▸ $*"; }
ok() { echo "✓ $*"; }
warn() { echo "hdo: $*" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

is_private_ipv4() {
  case "$1" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) return 0 ;;
    *) return 1 ;;
  esac
}

detect_public_ipv4() {
  local url ip
  command -v curl >/dev/null 2>&1 || return 1
  for url in \
    "https://api.ipify.org" \
    "https://ifconfig.me/ip" \
    "http://ip1.dynupdate.no-ip.com/"; do
    ip="$(curl -4fsS --max-time 4 "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    case "$ip" in
      *.*.*.*)
        if ! is_private_ipv4 "$ip"; then
          echo "$ip"
          return 0
        fi
        ;;
    esac
  done
  return 1
}

install_wireguard_tools() {
  [ "$(id -u)" -eq 0 ] || die "WireGuard tools are missing. Re-run as root or install wireguard-tools first."

  say "installing WireGuard tools"
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y wireguard-tools
  elif command -v yum >/dev/null 2>&1; then
    yum install -y epel-release || true
    yum install -y wireguard-tools
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache wireguard-tools
  elif command -v zypper >/dev/null 2>&1; then
    zypper --non-interactive install wireguard-tools
  elif command -v pacman >/dev/null 2>&1; then
    pacman -Sy --noconfirm wireguard-tools
  else
    die "missing command: wg. Please install wireguard-tools with the OS package manager."
  fi
}

ensure_wireguard_tools() {
  if command -v wg >/dev/null 2>&1 && command -v wg-quick >/dev/null 2>&1; then
    return 0
  fi
  install_wireguard_tools
  command -v wg >/dev/null 2>&1 || die "WireGuard install finished but wg is still unavailable"
  command -v wg-quick >/dev/null 2>&1 || die "WireGuard install finished but wg-quick is still unavailable"
}

gen_private_key() {
  ensure_wireguard_tools
  wg genkey
}

public_key_of() {
  ensure_wireguard_tools
  printf '%s' "$1" | wg pubkey
}

load_env() {
  if [ -f "$ENV_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$ENV_FILE"; set +a
  fi
}

maybe_load_hdo_runner_token() {
  if [ -n "${HDO_TOKEN:-}" ] || [ -n "${HDO_GATEWAY_RUNNER_TOKEN:-}" ]; then
    return 0
  fi

  local token_file="${HDO_GATEWAY_RUNNER_TOKEN_FILE:-}"
  if [ -z "$token_file" ]; then
    token_file="$ROOT_DIR/electron-server/data/hdo-gateway-runner.token"
  fi

  if [ -s "$token_file" ]; then
    HDO_GATEWAY_RUNNER_TOKEN="$(tr -d '\r\n' < "$token_file")"
    export HDO_GATEWAY_RUNNER_TOKEN
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
HDO_TCP_MSS=${HDO_TCP_MSS:-1240}
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
  ip="$(detect_public_ipv4 || true)"
  if [ -n "$ip" ]; then
    echo "$ip"
    return 0
  fi

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

sudo_repair_domestic_routes() {
  if [ "$(id -u)" -eq 0 ]; then
    cmd_repair_domestic_routes
    return
  fi
  if command -v sudo >/dev/null 2>&1; then
    sudo bash "$SCRIPT_DIR/manage.sh" repair-domestic-routes
  else
    warn "sudo not found; run as root later: ./scripts/manage.sh hdo repair-domestic-routes"
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

  if [ "$create_home" -eq 1 ]; then
    local peer_args=(--name "$HDO_PEER_NAME")
    if [ -n "${HDO_PEER_IP:-}" ]; then
      peer_args+=(--peer-ip "$HDO_PEER_IP")
    fi
    cmd_add_home "${peer_args[@]}"
  fi

  if [ "$apply_now" -eq 1 ]; then
    sudo_apply_domestic || true
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
  maybe_register_node "domestic" "domestic-vps" "$HDO_PUBLIC_HOST" "$HDO_DOMESTIC_IP" "$HDO_DOMESTIC_PUBLIC_KEY"
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
AllowedIPs = 100.88.0.0/16, 100.89.0.0/16, 100.90.0.0/16
Endpoint = ${HDO_PUBLIC_HOST}:${HDO_WG_PORT}
PersistentKeepalive = 25
EOF

  HDO_NEXT_HOME_OCTET=$((HDO_NEXT_HOME_OCTET + 1))
  save_env

  ok "generated home peer $conf"
  maybe_register_node "home" "$HDO_PEER_NAME" "" "$peer_ip" "$public"
  echo
  echo "Install this file on the home node:"
  echo "  $conf"
}

sync_domestic_peer_routes() {
  local iface="${1:-hdo-home}"
  local config="${2:-/etc/wireguard/hdo-home.conf}"
  local cidr

  [ "$(id -u)" -eq 0 ] || return 0
  [ -f "$config" ] || return 0
  require_cmd ip

  while IFS= read -r cidr; do
    [ -n "$cidr" ] || continue
    case "$cidr" in
      0.0.0.0/0|::/0|*:*) continue ;;
    esac
    ip -4 route replace "$cidr" dev "$iface" || warn "failed to route $cidr via $iface"
  done < <(
    awk '
      /^\[Peer\]$/ { in_peer = 1; next }
      /^\[/ { in_peer = 0; next }
      in_peer == 1 && /^[[:space:]]*AllowedIPs[[:space:]]*=/ {
        sub(/^[^=]*=/, "")
        gsub(/[[:space:]]/, "")
        n = split($0, cidrs, ",")
        for (i = 1; i <= n; i++) {
          if (cidrs[i] ~ /^[0-9]+\./) print cidrs[i]
        }
      }
    ' "$config" | sort -u
  )
}

ensure_domestic_forwarding() {
  local iface="${1:-hdo-home}"
  local mss="${HDO_TCP_MSS:-1240}"

  [ "$(id -u)" -eq 0 ] || return 0

  sysctl -w net.ipv4.ip_forward=1 >/dev/null 2>&1 || true
  sysctl -w net.ipv6.conf.all.forwarding=1 >/dev/null 2>&1 || true
  sysctl -w net.ipv4.conf.all.rp_filter=0 >/dev/null 2>&1 || true
  sysctl -w net.ipv4.conf.default.rp_filter=0 >/dev/null 2>&1 || true
  sysctl -w "net.ipv4.conf.${iface}.rp_filter=0" >/dev/null 2>&1 || true
  ip link set dev "$iface" txqueuelen 4096 >/dev/null 2>&1 || true

  if command -v iptables >/dev/null 2>&1; then
    if ! iptables -C FORWARD -i "$iface" -o "$iface" -j ACCEPT >/dev/null 2>&1; then
      iptables -I FORWARD -i "$iface" -o "$iface" -j ACCEPT \
        || warn "failed to allow forwarding on $iface"
    fi
    if iptables -nL DOCKER-USER >/dev/null 2>&1; then
      if ! iptables -C DOCKER-USER -i "$iface" -o "$iface" -j ACCEPT >/dev/null 2>&1; then
        iptables -I DOCKER-USER 1 -i "$iface" -o "$iface" -j ACCEPT \
          || warn "failed to allow Docker user forwarding on $iface"
      fi
    fi
    if [ -n "$mss" ] && [ "$mss" -gt 0 ] 2>/dev/null; then
      if ! iptables -t mangle -C FORWARD -o "$iface" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$mss" >/dev/null 2>&1; then
        iptables -t mangle -I FORWARD 1 -o "$iface" -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --set-mss "$mss" \
          || warn "failed to install TCP MSS clamp on $iface"
      fi
    fi
  fi
}

report_domestic_peer_endpoints() {
  local iface="${1:-hdo-home}"

  maybe_load_hdo_runner_token
  [ -n "${HDO_SERVER_URL:-}" ] || return 0
  [ -n "${HDO_TOKEN:-}" ] || [ -n "${HDO_GATEWAY_RUNNER_TOKEN:-}" ] || return 0
  command -v wg >/dev/null 2>&1 || return 0
  command -v curl >/dev/null 2>&1 || return 0
  wg show "$iface" >/dev/null 2>&1 || return 0

  local payload curl_headers=()
  payload="$(mktemp)"
  wg show "$iface" endpoints | awk '
    function esc(s) { gsub(/\\/, "\\\\", s); gsub(/"/, "\\\"", s); return s }
    BEGIN { printf "{\"endpoints\":["; first = 1 }
    $2 != "(none)" {
      if (!first) printf ","
      first = 0
      printf "{\"publicKey\":\"%s\",\"endpoint\":\"%s\"}", esc($1), esc($2)
    }
    END { print "]}" }
  ' > "$payload"

  if [ -n "${HDO_TOKEN:-}" ]; then
    curl_headers+=(-H "authorization: Bearer ${HDO_TOKEN}")
  fi
  if [ -n "${HDO_GATEWAY_RUNNER_TOKEN:-}" ]; then
    curl_headers+=(-H "x-hdo-runner-token: ${HDO_GATEWAY_RUNNER_TOKEN}")
  fi
  curl -fsS \
    "${curl_headers[@]}" \
    -H "content-type: application/json" \
    -X POST \
    --data-binary "@${payload}" \
    "${HDO_SERVER_URL%/}/api/v1/hdo/admin/wireguard/peer-endpoints" >/dev/null \
    && ok "reported observed WireGuard peer endpoints" \
    || warn "failed to report observed WireGuard peer endpoints"
  rm -f "$payload"
}

cmd_sync_domestic_peers() {
  load_env
  parse_common "$@"
  maybe_load_hdo_runner_token
  [ -f "$WG_DIR/wg-home.conf" ] || die "run setup-domestic first"
  [ -n "${HDO_SERVER_URL:-}" ] || die "--server-url or HDO_SERVER_URL required"
  [ -n "${HDO_TOKEN:-}" ] || [ -n "${HDO_GATEWAY_RUNNER_TOKEN:-}" ] || die "HDO_TOKEN=<admin bearer token> or HDO_GATEWAY_RUNNER_TOKEN required; start the server gateway runner once to create electron-server/data/hdo-gateway-runner.token"
  require_cmd curl

  local fetched stripped curl_headers=()
  fetched="$(mktemp)"
  stripped="$(mktemp)"
  if [ -n "${HDO_TOKEN:-}" ]; then
    curl_headers+=(-H "authorization: Bearer ${HDO_TOKEN}")
  fi
  if [ -n "${HDO_GATEWAY_RUNNER_TOKEN:-}" ]; then
    curl_headers+=(-H "x-hdo-runner-token: ${HDO_GATEWAY_RUNNER_TOKEN}")
  fi
  curl -fsS \
    "${curl_headers[@]}" \
    "${HDO_SERVER_URL%/}/api/v1/hdo/admin/wireguard/domestic-peers.conf" \
    -o "$fetched"

  awk '
    /^# BEGIN_HDO_MANAGED_PEERS$/ { skip = 1; next }
    /^# END_HDO_MANAGED_PEERS$/ { skip = 0; next }
    skip != 1 { print }
  ' "$WG_DIR/wg-home.conf" > "$stripped"
  printf '\n' >> "$stripped"
  cat "$fetched" >> "$stripped"
  install -m 600 "$stripped" "$WG_DIR/wg-home.conf"
  rm -f "$fetched" "$stripped"
  ok "synced managed peers into $WG_DIR/wg-home.conf"

  if [ "$(id -u)" -eq 0 ] && [ -f /etc/wireguard/hdo-home.conf ]; then
    install -m 600 "$WG_DIR/wg-home.conf" /etc/wireguard/hdo-home.conf
    if command -v wg >/dev/null 2>&1 && wg show hdo-home >/dev/null 2>&1; then
      wg syncconf hdo-home <(wg-quick strip hdo-home)
      ensure_domestic_forwarding hdo-home
      sync_domestic_peer_routes hdo-home /etc/wireguard/hdo-home.conf
      report_domestic_peer_endpoints hdo-home
      ok "reloaded live hdo-home WireGuard peers"
    else
      systemctl restart wg-quick@hdo-home || true
      ensure_domestic_forwarding hdo-home
      sync_domestic_peer_routes hdo-home /etc/wireguard/hdo-home.conf
      report_domestic_peer_endpoints hdo-home
      ok "restarted wg-quick@hdo-home"
    fi
  else
    echo "Next:"
    echo "  sudo ./scripts/manage.sh hdo apply-domestic"
  fi
}

write_hdo_dns_corefile() {
  local bind_ip="${HDO_DNS_BIND_IP:-$DNS_BIND_IP}"
  local upstreams="${HDO_DNS_UPSTREAMS:-$DNS_UPSTREAMS}"
  cat > "$DNS_COREFILE" <<EOF
.:53 {
  bind ${bind_ip}
  hosts /etc/coredns/hdo.hosts {
    ttl 30
    reload 5s
    fallthrough
  }
  forward . ${upstreams}
  cache 30
  errors
}
EOF
}

ensure_hdo_dns_firewall() {
  local iface="${1:-hdo-home}"

  [ "$(id -u)" -eq 0 ] || return 0
  command -v iptables >/dev/null 2>&1 || return 0

  if ! iptables -C INPUT -i "$iface" -p udp --dport 53 -j ACCEPT >/dev/null 2>&1; then
    iptables -I INPUT -i "$iface" -p udp --dport 53 -j ACCEPT \
      || warn "failed to allow HDO DNS UDP traffic on $iface"
  fi
  if ! iptables -C INPUT -i "$iface" -p tcp --dport 53 -j ACCEPT >/dev/null 2>&1; then
    iptables -I INPUT -i "$iface" -p tcp --dport 53 -j ACCEPT \
      || warn "failed to allow HDO DNS TCP traffic on $iface"
  fi
}

cmd_sync_dns() {
  load_env
  parse_common "$@"
  maybe_load_hdo_runner_token
  [ -n "${HDO_SERVER_URL:-}" ] || die "--server-url or HDO_SERVER_URL required"
  [ -n "${HDO_TOKEN:-}" ] || [ -n "${HDO_GATEWAY_RUNNER_TOKEN:-}" ] || die "HDO_TOKEN=<admin bearer token> or HDO_GATEWAY_RUNNER_TOKEN required; start the server gateway runner once to create electron-server/data/hdo-gateway-runner.token"
  require_cmd curl

  local fetched curl_headers=()
  mkdir -p "$DNS_DIR"
  fetched="$(mktemp)"
  if [ -n "${HDO_TOKEN:-}" ]; then
    curl_headers+=(-H "authorization: Bearer ${HDO_TOKEN}")
  fi
  if [ -n "${HDO_GATEWAY_RUNNER_TOKEN:-}" ]; then
    curl_headers+=(-H "x-hdo-runner-token: ${HDO_GATEWAY_RUNNER_TOKEN}")
  fi
  curl -fsS \
    "${curl_headers[@]}" \
    "${HDO_SERVER_URL%/}/api/v1/hdo/admin/dns/hosts" \
    -o "$fetched"
  install -m 644 "$fetched" "$DNS_HOSTS_FILE"
  rm -f "$fetched"
  write_hdo_dns_corefile
  ok "synced HDO DNS hosts into $DNS_HOSTS_FILE"

  if [ "$(id -u)" -eq 0 ] && command -v docker >/dev/null 2>&1; then
    docker rm -f "$DNS_CONTAINER" >/dev/null 2>&1 || true
    docker run -d \
      --name "$DNS_CONTAINER" \
      --restart unless-stopped \
      --network host \
      -v "$DNS_DIR:/etc/coredns:ro" \
      "$DNS_IMAGE" \
      -conf /etc/coredns/Corefile >/dev/null
    ensure_hdo_dns_firewall hdo-home
    ok "started CoreDNS container $DNS_CONTAINER on ${HDO_DNS_BIND_IP:-$DNS_BIND_IP}:53"
  else
    echo "Next:"
    echo "  sudo docker rm -f $DNS_CONTAINER || true"
    echo "  sudo docker run -d --name $DNS_CONTAINER --restart unless-stopped --network host -v '$DNS_DIR:/etc/coredns:ro' $DNS_IMAGE -conf /etc/coredns/Corefile"
  fi
}

cmd_sync_and_repair_domestic() {
  cmd_sync_domestic_peers "$@"
  cmd_sync_dns "$@" || warn "HDO DNS sync failed; peers/routes were still repaired"
  if [ "$(id -u)" -eq 0 ] && [ -f /etc/wireguard/hdo-home.conf ]; then
    cmd_repair_domestic_routes
  else
    echo "Next:"
    echo "  sudo ./scripts/manage.sh hdo repair-domestic-routes"
  fi
}

cmd_apply_domestic() {
  [ "$(id -u)" -eq 0 ] || die "apply-domestic must run as root"
  [ -f "$WG_DIR/wg-home.conf" ] || die "run setup-domestic first"
  ensure_wireguard_tools
  require_cmd systemctl
  cat > /etc/sysctl.d/99-hdo-forwarding.conf <<'EOF'
net.ipv4.ip_forward = 1
net.ipv6.conf.all.forwarding = 1
net.ipv4.conf.all.rp_filter = 0
net.ipv4.conf.default.rp_filter = 0
EOF
  sysctl -p /etc/sysctl.d/99-hdo-forwarding.conf >/dev/null || true
  install -d -m 700 /etc/wireguard
  install -m 600 "$WG_DIR/wg-home.conf" /etc/wireguard/hdo-home.conf
  systemctl enable --now wg-quick@hdo-home
  ensure_domestic_forwarding hdo-home
  sync_domestic_peer_routes hdo-home /etc/wireguard/hdo-home.conf
  ok "enabled wg-quick@hdo-home"
}

cmd_repair_domestic_routes() {
  [ "$(id -u)" -eq 0 ] || die "repair-domestic-routes must run as root"
  ensure_wireguard_tools
  require_cmd ip
  [ -f /etc/wireguard/hdo-home.conf ] || die "missing /etc/wireguard/hdo-home.conf; run apply-domestic first"

  if wg show hdo-home >/dev/null 2>&1; then
    wg syncconf hdo-home <(wg-quick strip hdo-home)
    ok "reloaded live hdo-home WireGuard peers from /etc/wireguard/hdo-home.conf"
  else
    systemctl restart wg-quick@hdo-home || true
    ok "restarted wg-quick@hdo-home"
  fi
  ensure_domestic_forwarding hdo-home
  sync_domestic_peer_routes hdo-home /etc/wireguard/hdo-home.conf
  ok "repaired hdo-home peer routes and forwarding"
  ip route show dev hdo-home || true
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

backup_gateway_state() {
  local backup_dir stamp backup_file
  backup_dir="$STACK_DIR/backups"
  stamp="$(date '+%Y%m%d-%H%M%S')"
  backup_file="$backup_dir/hdo-gateway-$stamp.tar.gz"

  mkdir -p "$backup_dir"
  tar -czf "$backup_file" \
    -C "$STACK_DIR" \
    --ignore-failed-read \
    .env \
    egress.env.example \
    data >/dev/null 2>&1 || true

  echo "$backup_file"
}

delete_iptables_rule_all() {
  local chain="$1"
  shift

  command -v iptables >/dev/null 2>&1 || return 0
  iptables -nL "$chain" >/dev/null 2>&1 || return 0

  while iptables -C "$chain" "$@" >/dev/null 2>&1; do
    iptables -D "$chain" "$@" >/dev/null 2>&1 || break
  done
}

cmd_nuke() {
  local assume_yes=0 wipe_host_wg=0 wipe_stacks=0 make_backup=1 confirm

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --yes|-y) assume_yes=1; shift ;;
      --all) wipe_host_wg=1; wipe_stacks=1; shift ;;
      --host-wg|--include-host-wg) wipe_host_wg=1; shift ;;
      --no-host-wg) wipe_host_wg=0; shift ;;
      --stacks|--include-stacks) wipe_stacks=1; shift ;;
      --no-stacks) wipe_stacks=0; shift ;;
      --no-backup) make_backup=0; shift ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done

  warn "this will wipe generated HDO gateway state under $STACK_DIR."
  warn "use --all or --host-wg to also remove live wg-quick@hdo-home and host routes."
  if [ "$assume_yes" -ne 1 ]; then
    read -r -p "Type 'HDO-NUKE' to confirm: " confirm
    [ "$confirm" = "HDO-NUKE" ] || die "aborted"
  fi

  if [ "$make_backup" -eq 1 ]; then
    ok "backup created: $(backup_gateway_state)"
  fi

  if [ "$wipe_stacks" -eq 1 ]; then
    if [ -f "$ROOT_DIR/docker/wg-mihomo-stack/manage.sh" ]; then
      say "destroying domestic Docker Mihomo + WireGuard stack"
      bash "$ROOT_DIR/docker/wg-mihomo-stack/manage.sh" destroy --wipe-data --wipe-env --yes || true
    fi
    if [ -f "$ROOT_DIR/docker/hysteria2-mihomo-stack/manage.sh" ]; then
      say "destroying oversea Docker Mihomo + Hysteria2 stack"
      bash "$ROOT_DIR/docker/hysteria2-mihomo-stack/manage.sh" destroy --wipe-data --wipe-env --yes || true
    fi
  fi

  if [ "$wipe_host_wg" -eq 1 ]; then
    [ "$(id -u)" -eq 0 ] || die "--host-wg/--all must run as root"

    say "removing live hdo-home WireGuard state"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl disable --now wg-quick@hdo-home >/dev/null 2>&1 || true
    fi
    if command -v wg-quick >/dev/null 2>&1; then
      wg-quick down hdo-home >/dev/null 2>&1 || true
    fi
    delete_iptables_rule_all FORWARD -i hdo-home -o hdo-home -j ACCEPT
    delete_iptables_rule_all DOCKER-USER -i hdo-home -o hdo-home -j ACCEPT
    if command -v ip >/dev/null 2>&1; then
      ip -4 route flush dev hdo-home >/dev/null 2>&1 || true
      ip link delete hdo-home >/dev/null 2>&1 || true
    fi
    rm -f /etc/wireguard/hdo-home.conf /etc/sysctl.d/99-hdo-forwarding.conf
    ok "removed host hdo-home WireGuard config, routes and HDO forwarding rules"
  fi

  if command -v docker >/dev/null 2>&1; then
    docker rm -f "$DNS_CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$DATA_DIR" "$ENV_FILE" "$STACK_DIR/egress.env.example"
  mkdir -p "$WG_DIR" "$PEERS_DIR" "$DNS_DIR"
  ok "HDO gateway generated state wiped"
}

cmd_status() {
  load_env
  echo "stack: $STACK_DIR"
  echo "server: ${HDO_SERVER_URL:-}"
  echo "public host: ${HDO_PUBLIC_HOST:-}"
  echo "wg config: $WG_DIR/wg-home.conf"
  echo "dns hosts: $DNS_HOSTS_FILE"
  [ -f "$WG_DIR/wg-home.conf" ] && sed -n '1,120p' "$WG_DIR/wg-home.conf"
  if [ -f "$DNS_HOSTS_FILE" ]; then
    echo
    echo "dns hosts:"
    sed -n '1,120p' "$DNS_HOSTS_FILE"
  fi
  if command -v docker >/dev/null 2>&1; then
    echo
    echo "dns container:"
    docker ps --filter "name=^/${DNS_CONTAINER}$" --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' || true
  fi
  echo
  echo "peers:"
  find "$PEERS_DIR" -maxdepth 1 -type f -name '*.conf' -print 2>/dev/null | sort
  echo
  echo "host state:"
  if [ "$(id -u)" -eq 0 ]; then
    sysctl net.ipv4.ip_forward 2>/dev/null || true
    if command -v wg >/dev/null 2>&1 && wg show hdo-home >/dev/null 2>&1; then
      echo
      echo "wg allowed-ips:"
      wg show hdo-home allowed-ips || true
      echo
      echo "wg transfer:"
      wg show hdo-home transfer || true
    fi
    if command -v ip >/dev/null 2>&1; then
      echo
      echo "link stats:"
      ip -s link show dev hdo-home || true
      echo
      echo "routes on hdo-home:"
      ip route show dev hdo-home || true
    fi
    if command -v iptables >/dev/null 2>&1; then
      echo
      echo "iptables hdo-home forwarding:"
      iptables -vnL FORWARD | awk 'NR == 1 || /hdo-home/' || true
      iptables -vnL DOCKER-USER 2>/dev/null | awk 'NR == 1 || /hdo-home/' || true
      iptables -t mangle -vnL FORWARD | awk 'NR == 1 || /hdo-home|TCPMSS/' || true
      echo
      echo "iptables HDO DNS input:"
      iptables -vnL INPUT | awk 'NR == 1 || /hdo-home.*dpt:53/' || true
    fi
  else
    echo "run as root to include live wg, route and iptables state"
  fi
}

cmd_menu() {
  local options=(
    "deploy-domestic    部署 domestic-vps + WireGuard"
    "deploy-domestic-mihomo-wireguard  部署 domestic Docker Mihomo + WireGuard"
    "deploy-oversea-mihomo-hysteria2   部署 oversea Docker Mihomo + Hysteria2"
    "tunnel-reconcile  同步 D tunnel 控制面状态到 Oversea"
    "tunnel-status     查看 Oversea tunnel 状态"
    "add-home           生成 Home WireGuard peer"
    "sync-peers         同步服务端 H 成员/client peers 到 domestic"
    "sync-repair        同步 peers 并修复 live 路由/转发"
    "sync-dns           同步 HDO DNS hosts 并运行 CoreDNS"
    "apply-domestic     启用 wg-quick@hdo-home"
    "repair-routes      修复 hdo-home peer 路由和转发"
    "setup-egress       生成 oversea scoped egress 模板"
    "nuke               清空 HDO gateway 本地状态"
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
      deploy-domestic-mihomo-wireguard) cmd_stack_delegate "$ROOT_DIR/docker/wg-mihomo-stack/manage.sh" setup ;;
      deploy-oversea-mihomo-hysteria2) cmd_stack_delegate "$ROOT_DIR/docker/hysteria2-mihomo-stack/manage.sh" setup ;;
      tunnel-reconcile) cmd_tunnel_reconcile_oversea ;;
      tunnel-status)    cmd_tunnel_status_oversea ;;
      add-home)        cmd_add_home ;;
      sync-peers)      cmd_sync_domestic_peers ;;
      sync-repair)     cmd_sync_and_repair_domestic ;;
      sync-dns)        cmd_sync_dns ;;
      apply-domestic)  sudo_apply_domestic ;;
      repair-routes)   sudo_repair_domestic_routes ;;
      setup-egress)    cmd_setup_oversea_egress ;;
      nuke)            cmd_nuke ;;
      status)          cmd_status ;;
      help)            usage ;;
      quit|exit)       break ;;
      *) warn "unknown option" ;;
    esac
    echo
  done
}

cmd_stack_delegate() {
  local script="$1"
  shift
  [ -f "$script" ] || die "missing stack script: $script"
  bash "$script" "$@"
}

cmd_tunnel_reconcile_oversea() {
  local state_file="${QPJOY_TUNNEL_STATE_FILE:-}"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --state-file) state_file="${2:?}"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option: $1" ;;
    esac
  done
  [ -n "$state_file" ] || die "QPJOY_TUNNEL_STATE_FILE or --state-file is required"
  cmd_stack_delegate "$ROOT_DIR/docker/hysteria2-mihomo-stack/manage.sh" reconcile-from-json --state-file "$state_file"
}

cmd_tunnel_status_oversea() {
  cmd_stack_delegate "$ROOT_DIR/docker/hysteria2-mihomo-stack/manage.sh" status
}

maybe_register_node() {
  local kind="$1" name="$2" public_host="$3" overlay_ip="$4"
  local public_key="${5:-}"
  local metadata="null"
  [ -n "${HDO_SERVER_URL:-}" ] || return 0
  [ -n "${HDO_TOKEN:-}" ] || return 0
  require_cmd curl

  if [ "$kind" = "domestic" ] && [ -n "${public_key:-${HDO_DOMESTIC_PUBLIC_KEY:-}}" ]; then
    public_key="${public_key:-${HDO_DOMESTIC_PUBLIC_KEY:-}}"
    metadata="{\"wireGuard\":{\"publicKey\":\"${public_key}\",\"listenPort\":${HDO_WG_PORT:-51888},\"endpointHost\":\"${public_host}\",\"dnsServers\":[\"${HDO_DNS_BIND_IP:-$DNS_BIND_IP}\"]}}"
  elif [ "$kind" = "home" ] && [ -n "$public_key" ]; then
    metadata="{\"wireGuard\":{\"publicKey\":\"${public_key}\"}}"
  fi

  curl -fsS \
    -H "authorization: Bearer ${HDO_TOKEN}" \
    -H "content-type: application/json" \
    -X POST \
    --data "{\"name\":\"${name}\",\"kind\":\"${kind}\",\"publicHost\":\"${public_host}\",\"overlayIp\":\"${overlay_ip}\",\"status\":\"pending\",\"metadata\":${metadata}}" \
    "${HDO_SERVER_URL%/}/api/v1/hdo/admin/nodes" >/dev/null \
    && ok "registered ${kind} node in HDO control plane" \
    || echo "hdo: node registration failed; generated local config anyway" >&2
}

command="${1:-menu}"
shift || true
if [ "$command" = "hdo" ]; then
  command="${1:-menu}"
  shift || true
fi
case "$command" in
  menu) cmd_menu ;;
  deploy-domestic|deploy) cmd_deploy_domestic "$@" ;;
  deploy-domestic-mihomo-wireguard|domestic-mihomo-wireguard) cmd_stack_delegate "$ROOT_DIR/docker/wg-mihomo-stack/manage.sh" setup "$@" ;;
  deploy-oversea-mihomo-hysteria2|oversea-mihomo-hysteria2) cmd_stack_delegate "$ROOT_DIR/docker/hysteria2-mihomo-stack/manage.sh" setup "$@" ;;
  tunnel-reconcile-oversea|tunnel-reconcile) cmd_tunnel_reconcile_oversea "$@" ;;
  tunnel-status-oversea|tunnel-status) cmd_tunnel_status_oversea "$@" ;;
  setup-domestic) cmd_setup_domestic "$@" ;;
  add-home) cmd_add_home "$@" ;;
  sync-domestic-peers|sync-peers) cmd_sync_domestic_peers "$@" ;;
  sync-and-repair-domestic|sync-repair) cmd_sync_and_repair_domestic "$@" ;;
  sync-dns) cmd_sync_dns "$@" ;;
  apply-domestic) cmd_apply_domestic "$@" ;;
  repair-domestic-routes|repair-routes) cmd_repair_domestic_routes "$@" ;;
  setup-oversea-egress) cmd_setup_oversea_egress "$@" ;;
  nuke|wipe|reset) cmd_nuke "$@" ;;
  status) cmd_status "$@" ;;
  help|-h|--help) usage ;;
  *) usage; die "unknown command: $command" ;;
esac
