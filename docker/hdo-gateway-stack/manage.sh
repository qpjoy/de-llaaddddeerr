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
  setup-domestic      Generate domestic wg-home server config
  add-home            Generate one home peer config and append it to wg-home
  apply-domestic      Install generated wg-home config into /etc/wireguard
  setup-oversea-egress Write scoped egress env template for npm/GitHub/Docker
  status              Show generated files

Examples:
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
  private="$(gen_private_key)"
  public="$(public_key_of "$private")"
  conf="$PEERS_DIR/${HDO_PEER_NAME}.conf"

  if ! grep -q "BEGIN_HDO_PEER ${HDO_PEER_NAME}" "$WG_DIR/wg-home.conf"; then
    cat >> "$WG_DIR/wg-home.conf" <<EOF

# BEGIN_HDO_PEER ${HDO_PEER_NAME}
[Peer]
PublicKey = ${public}
AllowedIPs = ${peer_ip}/32
PersistentKeepalive = 25
# END_HDO_PEER ${HDO_PEER_NAME}
EOF
  fi

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

command="${1:-help}"
shift || true
case "$command" in
  setup-domestic) cmd_setup_domestic "$@" ;;
  add-home) cmd_add_home "$@" ;;
  apply-domestic) cmd_apply_domestic "$@" ;;
  setup-oversea-egress) cmd_setup_oversea_egress "$@" ;;
  status) cmd_status "$@" ;;
  help|-h|--help) usage ;;
  *) usage; die "unknown command: $command" ;;
esac
