#!/bin/bash

set -euo pipefail

MIHOMO_VERBOSE="${MIHOMO_VERBOSE:-false}"

MIHOMO_HOME="${MIHOMO_HOME:-/etc/mihomo-client}"
MIHOMO_ENV_FILE="${MIHOMO_ENV_FILE:-$MIHOMO_HOME/client.env}"
MIHOMO_SUBSCRIPTION_FILE="${MIHOMO_SUBSCRIPTION_FILE:-$MIHOMO_HOME/subscription.yaml}"
MIHOMO_CONFIG_FILE="${MIHOMO_CONFIG_FILE:-$MIHOMO_HOME/config.yaml}"
MIHOMO_TUN_OVERLAY_FILE="${MIHOMO_TUN_OVERLAY_FILE:-$MIHOMO_HOME/tun-overlay.yaml}"
MIHOMO_BIN="${MIHOMO_BIN:-/usr/local/bin/mihomo}"
MIHOMO_SERVICE_NAME="${MIHOMO_SERVICE_NAME:-mihomo-client.service}"
MIHOMO_SERVICE_FILE="${MIHOMO_SERVICE_FILE:-/etc/systemd/system/$MIHOMO_SERVICE_NAME}"
MIHOMO_PROFILE_PROXY_FILE="${MIHOMO_PROFILE_PROXY_FILE:-/etc/profile.d/mihomo-client-proxy.sh}"
GITHUB_API_ROOT="${GITHUB_API_ROOT:-https://api.github.com/repos/MetaCubeX/mihomo/releases}"
MIHOMO_GEOX_GEOIP_URL="${MIHOMO_GEOX_GEOIP_URL:-https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat}"
MIHOMO_GEOX_GEOSITE_URL="${MIHOMO_GEOX_GEOSITE_URL:-https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat}"
MIHOMO_GEOX_MMDB_URL="${MIHOMO_GEOX_MMDB_URL:-https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb}"

usage() {
	cat <<'EOF'
Usage:
  sudo bash ./scripts/mihomo-client.sh [--verbose] <command> [options]

Commands:
  setup                Interactive install wizard (same as install without flags)
  install              Install Mihomo core, fetch remote subscription, create+enable service
  update-subscription  Re-download remote YAML and restart service if it is running
  start                Start Mihomo client service
  stop                 Stop Mihomo client service
  restart              Restart Mihomo client service
  status               Show service status and current local proxy info
  logs                 Show recent service logs
  enable               Enable service on boot
  disable              Disable service on boot
  proxy-on             Write /etc/profile.d proxy exports for login shells
  proxy-off            Remove /etc/profile.d proxy exports
  tun-on               Enable Mihomo TUN mode and also turn proxy-on on
  tun-off              Disable Mihomo TUN mode and also turn proxy-on off
  run                  Run one command with Mihomo proxy env injected
  test                 Test outbound access through the local mixed-port
  print-env            Print proxy env exports for the current local mixed-port
  uninstall            Stop+disable service and optionally remove config/binary
  help                 Show this help

Install options:
  --url URL            Subscription URL, e.g. http://IP:3434/peer_user01.mihomo.yaml
  --user USER          Basic Auth username for subscription
  --password PASS      Basic Auth password for subscription
  --version TAG        Mihomo version tag. Default: latest stable release
  --binary-path PATH   Use an existing Mihomo binary instead of downloading from GitHub
  --no-start           Install/update files but do not start the service

Update options:
  --url URL            Override saved subscription URL
  --user USER          Override saved subscription username
  --password PASS      Override saved subscription password

Uninstall options:
  --purge              Also remove config, env, downloaded YAML, and Mihomo binary

Examples:
  sudo bash ./scripts/mihomo-client.sh install \
    --url http://IP:3434/peer_user01.mihomo.yaml \
    --user download \
    --password pass

  sudo bash ./scripts/mihomo-client.sh install \
    --url http://IP:3434/peer_user01.mihomo.yaml \
    --binary-path /tmp/mihomo

  sudo bash ./scripts/mihomo-client.sh update-subscription
  sudo bash ./scripts/mihomo-client.sh start
  sudo bash ./scripts/mihomo-client.sh proxy-on
  sudo bash ./scripts/mihomo-client.sh tun-on
  sudo bash ./scripts/mihomo-client.sh run curl -I https://www.google.com/generate_204
  sudo bash ./scripts/mihomo-client.sh print-env
EOF
}

die() {
	echo "Error: $*" >&2
	exit 1
}

log() {
	echo "[mihomo-client] $*" >&2
}

enable_verbose() {
	MIHOMO_VERBOSE="true"
	set -x
}

require_root() {
	[[ "${EUID:-0}" -eq 0 ]] || die "Please run this script as root."
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

ensure_dirs() {
	mkdir -p "$MIHOMO_HOME"
	chmod 700 "$MIHOMO_HOME"
}

set_env_value() {
	local key="$1"
	local value="$2"
	local tmp escaped

	escaped="$(printf "%s" "$value" | sed "s/'/'\\\\''/g")"
	value="'$escaped'"
	tmp="$(mktemp)"

	if [[ -f "$MIHOMO_ENV_FILE" ]]; then
		awk -v key="$key" -v value="$value" '
			BEGIN { updated = 0 }
			$0 ~ "^" key "=" {
				print key "=" value
				updated = 1
				next
			}
			{ print }
			END {
				if (!updated) {
					print key "=" value
				}
			}
		' "$MIHOMO_ENV_FILE" > "$tmp"
	else
		printf "%s=%s\n" "$key" "$value" > "$tmp"
	fi

	mv "$tmp" "$MIHOMO_ENV_FILE"
	chmod 600 "$MIHOMO_ENV_FILE"
}

load_env() {
	[[ -f "$MIHOMO_ENV_FILE" ]] || return 0
	set -a
	# shellcheck disable=SC1090
	source "$MIHOMO_ENV_FILE"
	set +a
}

prompt_default() {
	local prompt="$1"
	local default_value="${2:-}"
	local result

	if [[ -n "$default_value" ]]; then
		read -r -p "$prompt [$default_value]: " result
		echo "${result:-$default_value}"
	else
		read -r -p "$prompt: " result
		echo "$result"
	fi
}

prompt_password() {
	local prompt="$1"
	local value
	read -r -s -p "$prompt: " value
	echo
	echo "$value"
}

extract_auth_from_url() {
	local raw_url="$1"
	python3 - "$raw_url" <<'PY'
import sys
from urllib.parse import urlsplit, urlunsplit, unquote

raw = sys.argv[1]
parts = urlsplit(raw)

username = parts.username or ""
password = parts.password or ""

hostname = parts.hostname or ""
netloc = hostname
if parts.port:
    netloc = f"{netloc}:{parts.port}"

sanitized = urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
print(sanitized)
print(unquote(username))
print(unquote(password))
PY
}

normalize_subscription_inputs() {
	local url="$1"
	local username="$2"
	local password="$3"
	local sanitized_url parsed_user parsed_pass
	local -a parsed=()

	if [[ "$url" == *"@"* ]] && [[ "$url" == http://* || "$url" == https://* ]]; then
		mapfile -t parsed < <(extract_auth_from_url "$url")
		if [[ "${#parsed[@]}" -ge 3 ]]; then
			sanitized_url="${parsed[0]}"
			parsed_user="${parsed[1]}"
			parsed_pass="${parsed[2]}"
			url="$sanitized_url"
			log "Detected Basic Auth inside subscription URL. Credentials will be stored separately."
			if [[ -z "$username" && -n "$parsed_user" ]]; then
				username="$parsed_user"
			fi
			if [[ -z "$password" && -n "$parsed_pass" ]]; then
				password="$parsed_pass"
			fi
		fi
	fi

	printf "%s\n%s\n%s\n" "$url" "$username" "$password"
}

detect_asset_selector() {
	case "$(uname -m)" in
		x86_64|amd64) echo "linux-amd64-v1" ;;
		aarch64|arm64) echo "linux-arm64" ;;
		armv7l|armv7) echo "linux-armv7" ;;
		armv6l|armv6) echo "linux-armv6" ;;
		i386|i686) echo "linux-386" ;;
		riscv64) echo "linux-riscv64" ;;
		s390x) echo "linux-s390x" ;;
		*) die "Unsupported CPU architecture: $(uname -m)" ;;
	esac
}

resolve_release_asset() {
	local version="${1:-latest}"
	local selector="$2"
	local api_url json_file

	json_file="$(mktemp)"
	if [[ "$version" == "latest" ]]; then
		api_url="$GITHUB_API_ROOT"
		log "Querying latest stable Mihomo release metadata for $selector"
	else
		api_url="$GITHUB_API_ROOT/tags/$version"
		log "Querying Mihomo release metadata for tag $version ($selector)"
	fi

	if [[ "$version" == "latest" ]]; then
		curl -fsSL "$api_url" -o "$json_file"
		python3 - "$json_file" "$selector" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
selector = sys.argv[2]
releases = json.loads(path.read_text())

for rel in releases:
    if rel.get("prerelease"):
        continue
    assets = rel.get("assets", [])
    for asset in assets:
        name = asset.get("name", "")
        if name.startswith(f"mihomo-{selector}-") and name.endswith(".gz"):
            print(rel.get("tag_name", ""))
            print(asset.get("browser_download_url", ""))
            sys.exit(0)
raise SystemExit(1)
PY
	else
		curl -fsSL "$api_url" -o "$json_file"
		python3 - "$json_file" "$selector" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
selector = sys.argv[2]
rel = json.loads(path.read_text())
assets = rel.get("assets", [])

for asset in assets:
    name = asset.get("name", "")
    if name.startswith(f"mihomo-{selector}-") and name.endswith(".gz"):
        print(rel.get("tag_name", ""))
        print(asset.get("browser_download_url", ""))
        sys.exit(0)
raise SystemExit(1)
PY
	fi
	rm -f "$json_file"
}

install_binary() {
	local version="${1:-latest}"
	local selector release_info tag download_url tmpdir archive tmpbin

	require_cmd curl
	require_cmd python3
	require_cmd gzip

	selector="$(detect_asset_selector)"
	mapfile -t release_info < <(resolve_release_asset "$version" "$selector") || die "Failed to resolve Mihomo release asset for $selector"
	[[ "${#release_info[@]}" -ge 2 ]] || die "Unexpected release metadata returned from GitHub."
	tag="${release_info[0]}"
	download_url="${release_info[1]}"

	tmpdir="$(mktemp -d)"
	archive="$tmpdir/mihomo.gz"
	tmpbin="$tmpdir/mihomo"

	log "Downloading Mihomo $tag from GitHub"
	curl -fsSL "$download_url" -o "$archive"
	gzip -dc "$archive" > "$tmpbin"
	chmod 755 "$tmpbin"
	mv "$tmpbin" "$MIHOMO_BIN"

	set_env_value MIHOMO_VERSION "$tag"
	echo "Installed Mihomo $tag to $MIHOMO_BIN"
	rm -rf "$tmpdir"
}

install_binary_from_path() {
	local source_path="$1"
	[[ -n "$source_path" ]] || die "Binary path is required."
	[[ -f "$source_path" ]] || die "Mihomo binary not found: $source_path"
	[[ -x "$source_path" ]] || die "Mihomo binary is not executable: $source_path"
	cp "$source_path" "$MIHOMO_BIN"
	chmod 755 "$MIHOMO_BIN"
	set_env_value MIHOMO_VERSION "local"
	echo "Installed Mihomo local binary to $MIHOMO_BIN"
}

write_service_file() {
	cat > "$MIHOMO_SERVICE_FILE" <<EOF
[Unit]
Description=Mihomo Client
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$MIHOMO_HOME
ExecStart=$MIHOMO_BIN -d $MIHOMO_HOME -f $MIHOMO_CONFIG_FILE
Restart=on-failure
RestartSec=5
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
}

systemd_reload() {
	systemctl daemon-reload
}

service_is_active() {
	systemctl is-active --quiet "$MIHOMO_SERVICE_NAME"
}

ensure_subscription_source() {
	if [[ ! -f "$MIHOMO_SUBSCRIPTION_FILE" && -f "$MIHOMO_CONFIG_FILE" ]]; then
		cp "$MIHOMO_CONFIG_FILE" "$MIHOMO_SUBSCRIPTION_FILE"
		chmod 600 "$MIHOMO_SUBSCRIPTION_FILE"
	fi
	[[ -f "$MIHOMO_SUBSCRIPTION_FILE" ]] || die "Subscription source not found. Please run install or update-subscription first."
}

write_tun_overlay() {
	cat > "$MIHOMO_TUN_OVERLAY_FILE" <<'EOF'
tun:
  enable: true
  stack: system
  auto-route: true
  auto-redirect: true
  auto-detect-interface: true
  strict-route: true
  dns-hijack:
    - any:53
    - tcp://any:53
EOF
	chmod 600 "$MIHOMO_TUN_OVERLAY_FILE"
}

remove_tun_overlay() {
	rm -f "$MIHOMO_TUN_OVERLAY_FILE"
}

tun_enabled() {
	[[ -f "$MIHOMO_TUN_OVERLAY_FILE" ]]
}

config_uses_geodata() {
	grep -Eq '^[[:space:]]*geodata-mode:[[:space:]]*true([[:space:]]|$)' "$MIHOMO_SUBSCRIPTION_FILE"
}

config_has_geox_url() {
	grep -Eq '^[[:space:]]*geox-url:[[:space:]]*$' "$MIHOMO_SUBSCRIPTION_FILE"
}

append_geox_overlay_if_needed() {
	if config_uses_geodata && ! config_has_geox_url; then
		log "Injecting geox-url mirror overrides for geo data downloads"
		cat >> "$MIHOMO_CONFIG_FILE" <<EOF

geox-url:
  geoip: "$MIHOMO_GEOX_GEOIP_URL"
  geosite: "$MIHOMO_GEOX_GEOSITE_URL"
  mmdb: "$MIHOMO_GEOX_MMDB_URL"
EOF
	fi
}

render_runtime_config() {
	ensure_subscription_source
	cat "$MIHOMO_SUBSCRIPTION_FILE" > "$MIHOMO_CONFIG_FILE"
	append_geox_overlay_if_needed
	if tun_enabled; then
		printf "\n" >> "$MIHOMO_CONFIG_FILE"
		cat "$MIHOMO_TUN_OVERLAY_FILE" >> "$MIHOMO_CONFIG_FILE"
	fi
	chmod 600 "$MIHOMO_CONFIG_FILE"
}

fetch_subscription() {
	local url="$1"
	local username="${2:-}"
	local password="${3:-}"
	local tmp_file
	local -a curl_args=()

	[[ -n "$url" ]] || die "Subscription URL is required."

	tmp_file="$(mktemp)"
	curl_args=(-fsSL)
	if [[ -n "$username" || -n "$password" ]]; then
		curl_args+=(-u "${username}:${password}")
	fi

	log "Fetching remote subscription: $url"
	curl "${curl_args[@]}" "$url" -o "$tmp_file"
	[[ -s "$tmp_file" ]] || die "Downloaded subscription is empty."
	mv "$tmp_file" "$MIHOMO_SUBSCRIPTION_FILE"
	chmod 600 "$MIHOMO_SUBSCRIPTION_FILE"
	render_runtime_config
}

mixed_port_from_config() {
	if [[ -f "$MIHOMO_CONFIG_FILE" ]]; then
		awk -F: '/^[[:space:]]*mixed-port[[:space:]]*:/ {gsub(/[[:space:]]/, "", $2); print $2; exit}' "$MIHOMO_CONFIG_FILE"
	fi
}

proxy_env_lines() {
	local port="$1"
	cat <<EOF
export http_proxy=http://127.0.0.1:$port
export https_proxy=http://127.0.0.1:$port
export HTTP_PROXY=http://127.0.0.1:$port
export HTTPS_PROXY=http://127.0.0.1:$port
export all_proxy=socks5://127.0.0.1:$port
export ALL_PROXY=socks5://127.0.0.1:$port
EOF
}

print_env_command() {
	local port
	port="$(mixed_port_from_config)"
	[[ -n "$port" ]] || die "Could not detect mixed-port from $MIHOMO_CONFIG_FILE"
	proxy_env_lines "$port"
}

status_command() {
	local port version
	load_env
	version="${MIHOMO_VERSION:-unknown}"
	port="$(mixed_port_from_config || true)"

	echo "Mihomo binary: $MIHOMO_BIN"
	echo "Mihomo version: $version"
	echo "Config file: $MIHOMO_CONFIG_FILE"
	echo "Subscription file: $MIHOMO_SUBSCRIPTION_FILE"
	echo "Subscription URL: ${MIHOMO_SUBSCRIPTION_URL:-unset}"
	echo "Mixed port: ${port:-unknown}"
	echo "Shell proxy profile: $([[ -f "$MIHOMO_PROFILE_PROXY_FILE" ]] && echo enabled || echo disabled)"
	echo "TUN mode: $([[ -f "$MIHOMO_TUN_OVERLAY_FILE" ]] && echo enabled || echo disabled)"
	echo
	systemctl status "$MIHOMO_SERVICE_NAME" --no-pager || true
}

logs_command() {
	journalctl -u "$MIHOMO_SERVICE_NAME" -n 100 --no-pager
}

update_subscription_command() {
	local url="${1:-}"
	local username="${2:-}"
	local password="${3:-}"
	local -a normalized=()

	load_env

	url="${url:-${MIHOMO_SUBSCRIPTION_URL:-}}"
	username="${username:-${MIHOMO_SUBSCRIPTION_USER:-}}"
	password="${password:-${MIHOMO_SUBSCRIPTION_PASSWORD:-}}"
	mapfile -t normalized < <(normalize_subscription_inputs "$url" "$username" "$password")
	url="${normalized[0]}"
	username="${normalized[1]}"
	password="${normalized[2]}"

	[[ -n "$url" ]] || die "No subscription URL configured. Use install or pass --url."

	fetch_subscription "$url" "$username" "$password"
	set_env_value MIHOMO_SUBSCRIPTION_URL "$url"
	set_env_value MIHOMO_SUBSCRIPTION_USER "$username"
	set_env_value MIHOMO_SUBSCRIPTION_PASSWORD "$password"

	if service_is_active; then
		log "Restarting Mihomo service after subscription update"
		systemctl restart "$MIHOMO_SERVICE_NAME"
		echo "Subscription updated and service restarted."
	else
		echo "Subscription updated."
	fi
}

proxy_on_command() {
	local port
	port="$(mixed_port_from_config)"
	[[ -n "$port" ]] || die "Could not detect mixed-port from $MIHOMO_CONFIG_FILE"
	cat > "$MIHOMO_PROFILE_PROXY_FILE" <<EOF
# Generated by scripts/mihomo-client.sh
$(proxy_env_lines "$port")
EOF
	chmod 644 "$MIHOMO_PROFILE_PROXY_FILE"
	echo "Shell proxy exports enabled at $MIHOMO_PROFILE_PROXY_FILE"
	echo "Open a new shell or run: source $MIHOMO_PROFILE_PROXY_FILE"
}

proxy_off_command() {
	rm -f "$MIHOMO_PROFILE_PROXY_FILE"
	echo "Shell proxy exports removed."
}

tun_on_command() {
	write_tun_overlay
	render_runtime_config
	proxy_on_command
	if service_is_active; then
		systemctl restart "$MIHOMO_SERVICE_NAME"
		echo "Mihomo TUN mode enabled and service restarted."
	else
		systemctl start "$MIHOMO_SERVICE_NAME"
		echo "Mihomo TUN mode enabled and service started."
	fi
}

tun_off_command() {
	remove_tun_overlay
	render_runtime_config
	proxy_off_command
	if service_is_active; then
		systemctl restart "$MIHOMO_SERVICE_NAME"
		echo "Mihomo TUN mode disabled and service restarted."
	else
		echo "Mihomo TUN mode disabled."
	fi
}

run_command() {
	local port
	[[ $# -gt 0 ]] || die "Usage: sudo bash ./scripts/mihomo-client.sh run <command> [args...]"
	port="$(mixed_port_from_config)"
	[[ -n "$port" ]] || die "Could not detect mixed-port from $MIHOMO_CONFIG_FILE"
	http_proxy="http://127.0.0.1:$port" \
	https_proxy="http://127.0.0.1:$port" \
	HTTP_PROXY="http://127.0.0.1:$port" \
	HTTPS_PROXY="http://127.0.0.1:$port" \
	all_proxy="socks5://127.0.0.1:$port" \
	ALL_PROXY="socks5://127.0.0.1:$port" \
	"$@"
}

test_command() {
	local url="${1:-https://www.google.com/generate_204}"
	local port
	port="$(mixed_port_from_config)"
	[[ -n "$port" ]] || die "Could not detect mixed-port from $MIHOMO_CONFIG_FILE"
	require_cmd curl
	echo "Testing through local mixed-port $port -> $url"
	curl -I --proxy "http://127.0.0.1:$port" --max-time 15 "$url"
}

install_command() {
	local url="${1:-}"
	local username="${2:-}"
	local password="${3:-}"
	local version="${4:-latest}"
	local autostart="${5:-true}"
	local binary_path="${6:-}"
	local -a normalized=()

	ensure_dirs
	load_env
	log "Starting Mihomo client install/setup"

	if [[ -z "$url" ]]; then
		url="$(prompt_default "Subscription URL" "${MIHOMO_SUBSCRIPTION_URL:-}")"
	fi
	mapfile -t normalized < <(normalize_subscription_inputs "$url" "$username" "$password")
	url="${normalized[0]}"
	username="${normalized[1]}"
	password="${normalized[2]}"
	if [[ -z "$username" ]]; then
		username="$(prompt_default "Subscription username (empty if none)" "${MIHOMO_SUBSCRIPTION_USER:-}")"
	fi
	if [[ -z "$password" ]]; then
		password="$(prompt_password "Subscription password (empty if none)")"
	fi

	if [[ -n "$binary_path" ]]; then
		log "Installing Mihomo core from local binary path"
		install_binary_from_path "$binary_path"
	else
		log "Installing Mihomo core binary"
		install_binary "$version"
	fi
	log "Writing systemd service file"
	write_service_file
	systemd_reload

	set_env_value MIHOMO_SUBSCRIPTION_URL "$url"
	set_env_value MIHOMO_SUBSCRIPTION_USER "$username"
	set_env_value MIHOMO_SUBSCRIPTION_PASSWORD "$password"

	log "Downloading initial subscription and rendering runtime config"
	update_subscription_command "$url" "$username" "$password"

	systemctl enable "$MIHOMO_SERVICE_NAME" >/dev/null 2>&1 || true
	if [[ "$autostart" == "true" ]]; then
		log "Starting Mihomo client service"
		systemctl restart "$MIHOMO_SERVICE_NAME"
		echo "Mihomo client installed and started."
	else
		echo "Mihomo client installed. Service not started because --no-start was used."
	fi
}

start_command() {
	systemctl start "$MIHOMO_SERVICE_NAME"
}

stop_command() {
	systemctl stop "$MIHOMO_SERVICE_NAME"
}

restart_command() {
	systemctl restart "$MIHOMO_SERVICE_NAME"
}

enable_command() {
	systemctl enable "$MIHOMO_SERVICE_NAME"
}

disable_command() {
	systemctl disable "$MIHOMO_SERVICE_NAME"
}

uninstall_command() {
	local purge="${1:-false}"
	systemctl disable --now "$MIHOMO_SERVICE_NAME" >/dev/null 2>&1 || true
	rm -f "$MIHOMO_SERVICE_FILE"
	rm -f "$MIHOMO_PROFILE_PROXY_FILE"
	rm -f "$MIHOMO_TUN_OVERLAY_FILE"
	systemd_reload

	if [[ "$purge" == "true" ]]; then
		rm -f "$MIHOMO_BIN"
		rm -rf "$MIHOMO_HOME"
	fi

	echo "Mihomo client service removed."
	if [[ "$purge" == "true" ]]; then
		echo "Binary and client state purged."
	fi
}

main() {
	local command="${1:-help}"

	if [[ "${1:-}" == "--verbose" ]]; then
		enable_verbose
		shift
		command="${1:-help}"
	fi

	shift || true

	if [[ "$command" == "help" || "$command" == "-h" || "$command" == "--help" ]]; then
		usage
		exit 0
	fi

	require_root
	require_cmd systemctl

	case "$command" in
		setup)
			install_command "" "" "" "latest" "true"
		;;
		install)
			local url=""
			local username=""
			local password=""
			local version="latest"
			local autostart="true"
			local binary_path=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--url) url="$2"; shift 2 ;;
					--user) username="$2"; shift 2 ;;
					--password) password="$2"; shift 2 ;;
					--version) version="$2"; shift 2 ;;
					--binary-path) binary_path="$2"; shift 2 ;;
					--no-start) autostart="false"; shift ;;
					*) die "Unknown install option: $1" ;;
				esac
			done
			install_command "$url" "$username" "$password" "$version" "$autostart" "$binary_path"
		;;
		update-subscription)
			local url=""
			local username=""
			local password=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--url) url="$2"; shift 2 ;;
					--user) username="$2"; shift 2 ;;
					--password) password="$2"; shift 2 ;;
					*) die "Unknown update-subscription option: $1" ;;
				esac
			done
			update_subscription_command "$url" "$username" "$password"
		;;
		start)
			start_command
		;;
		stop)
			stop_command
		;;
		restart)
			restart_command
		;;
		status)
			status_command
		;;
		logs)
			logs_command
		;;
		enable)
			enable_command
		;;
		disable)
			disable_command
		;;
		proxy-on)
			proxy_on_command
		;;
		proxy-off)
			proxy_off_command
		;;
		tun-on)
			tun_on_command
		;;
		tun-off)
			tun_off_command
		;;
		run)
			run_command "$@"
		;;
		test)
			local url="https://www.google.com/generate_204"
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--url) url="$2"; shift 2 ;;
					*) die "Unknown test option: $1" ;;
				esac
			done
			test_command "$url"
		;;
		print-env)
			print_env_command
		;;
		uninstall)
			local purge="false"
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--purge) purge="true"; shift ;;
					*) die "Unknown uninstall option: $1" ;;
				esac
			done
			uninstall_command "$purge"
		;;
		*)
			die "Unknown command: $command"
		;;
	esac
}

main "$@"
