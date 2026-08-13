#!/bin/bash

set -euo pipefail

STACK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$STACK_DIR/../.." && pwd)"
ENV_FILE="$STACK_DIR/.env"
ENV_EXAMPLE="$STACK_DIR/.env.example"
USERS_FILE="$STACK_DIR/data/hysteria/users.csv"
USER_HEADER='name,auth,up,down'
CERT_DIR="$STACK_DIR/config/hysteria/certs"
CERT_CRT_PATH="$CERT_DIR/server.crt"
CERT_KEY_PATH="$CERT_DIR/server.key"
AUTH_SCRIPT_PATH="$STACK_DIR/config/hysteria/auth.sh"
SERVER_CONFIG_PATH="$STACK_DIR/config/hysteria/server.yaml"
HYSTERIA_CONTAINER="mx-oversea-hysteria2"
SUBSCRIPTIONS_CONTAINER="mx-oversea-hysteria2-health"
OLD_WG_STACK_DIR="$ROOT_DIR/docker/wg-mihomo-stack"
OLD_WG_ENV_FILE="$OLD_WG_STACK_DIR/.env"
SYSTEM_SUBSCRIPTION_DISABLED_PATH="/__system-subscription-disabled__"
SYSTEM_SUBSCRIPTION_DISABLED_PASSWORD_HASH='$2a$14$Zkx.HbQOScCQ1YI8Iu7/fO1M/ieGJqmXiF6Vq95PVIYzGKqG7SNU.'
SYSTEM_SUBSCRIPTION_CADDY_SIGNATURE_FILE="$STACK_DIR/data/caddy/system-subscription-signature.sha256"
SYSTEM_SUBSCRIPTION_MIXED_PORT_DEFAULT="7788"
SYSTEM_SUBSCRIPTION_BANDWIDTH_HINT="50 Mbps"
COMPOSE_BIN=""

usage() {
	cat <<'EOF'
Usage:
  sudo bash ./manage.sh <command> [options]

Commands:
  setup             Initialize .env, users, certs, start health/evidence outlet + hysteria
  reconfigure       Update ports/auth/defaults, then recreate the stack safely
  reset-auth        Reset health/evidence username/password and recreate outlet only
  start             Start services: all|hysteria|subscriptions
  stop              Stop services: all|hysteria|subscriptions
  restart           Restart services: all|hysteria|subscriptions
  destroy           Stop/remove stack containers; optionally wipe generated data/env
  reinstall         Destroy generated stack state and immediately run setup again
  status            Show stack status, users, ports, and defaults
  docker-status     Show Docker hysteria2 runtime status; --soft keeps diagnostics exit 0
  sync-internal-defaults
                    Apply Internal-managed runtime defaults, render config, and reconcile containers
  check-subscription-auth
                    Show health/evidence Basic Auth state; optionally verify with --password
  check-system-subscription
                    Verify the exact system YAML is live behind its dedicated Basic Auth
  list-users        Show current configured Hysteria2 users and advertised up/down values
  add-user          Add/upsert one or more Hysteria2 users, no restart needed
  del-user          Delete one or more Hysteria2 users and refresh summary
  set-limit         Set/update one or more users' Hysteria2 up/down values, then refresh summary
  clear-limit       Reset one or more users' Hysteria2 up/down values to stack defaults
  reapply-limits    Refresh Internal-issued account summary using current user defaults
  export            Refresh Internal-issued account summary from current user registry
  reconcile-from-json
                    Apply D tunnel control-plane state JSON to users/env, then refresh
  help              Show this help

Examples:
  sudo bash ./manage.sh setup
  sudo bash ./manage.sh reconfigure
  sudo bash ./manage.sh reset-auth --user download --password pass
  sudo bash ./manage.sh check-subscription-auth --password pass
  sudo bash ./manage.sh add-user --names intelligent01,intelligent02
  sudo bash ./manage.sh add-user --names mx-user --auth-token internal-issued-token --down-ceil "30 Mbps" --up-ceil "30 Mbps"
  sudo bash ./manage.sh del-user --names intelligent02
  sudo bash ./manage.sh set-limit --names intelligent01 --down-ceil "30 Mbps" --up-ceil "30 Mbps"
  sudo bash ./manage.sh reconcile-from-json --state-file /tmp/tunnel-state.json
EOF
}

die() {
	echo "Error: $*" >&2
	exit 1
}

require_root() {
	[[ "${EUID:-0}" -eq 0 ]] || die "Please run this script as root."
}

detect_compose() {
	if docker compose version >/dev/null 2>&1; then
		COMPOSE_BIN="docker compose"
	elif command -v docker-compose >/dev/null 2>&1; then
		COMPOSE_BIN="docker-compose"
	else
		die "Neither 'docker compose' nor 'docker-compose' is available."
	fi
}

compose() {
	(
		cd "$STACK_DIR"
		if [[ "$COMPOSE_BIN" == "docker compose" ]]; then
			docker compose "$@"
		else
			docker-compose "$@"
		fi
	)
}

ensure_stack_dirs() {
	mkdir -p \
		"$STACK_DIR/data/hysteria" \
		"$STACK_DIR/data/subscriptions" \
		"$STACK_DIR/data/caddy" \
		"$STACK_DIR/config/caddy" \
		"$STACK_DIR/config/hysteria" \
		"$CERT_DIR"
	chmod 700 "$STACK_DIR/data/subscriptions"
}

ensure_env_file() {
	if [[ ! -f "$ENV_FILE" ]]; then
		cp "$ENV_EXAMPLE" "$ENV_FILE"
	fi
}

ensure_users_file() {
	if [[ ! -f "$USERS_FILE" ]]; then
		echo "$USER_HEADER" > "$USERS_FILE"
	fi
}

read_env_value_from_file() {
	local file="$1"
	local key="$2"
	local raw

	[[ -f "$file" ]] || return 1
	raw="$(awk -v key="$key" -F= '$1 == key { sub("^[^=]*=", "", $0); print $0; exit }' "$file")"
	[[ -n "$raw" ]] || return 1

	raw="$(echo "$raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
	if [[ "$raw" == \"*\" ]]; then
		raw="${raw#\"}"
		raw="${raw%\"}"
	fi
	if [[ "$raw" == \'*\' ]]; then
		raw="${raw#\'}"
		raw="${raw%\'}"
	fi
	echo "$raw"
}

old_wg_env_value() {
	local key="$1"
	read_env_value_from_file "$OLD_WG_ENV_FILE" "$key" || true
}

default_users_from_old_wg_stack() {
	local clients_csv="$OLD_WG_STACK_DIR/data/subscriptions/clients.csv"
	if [[ -f "$clients_csv" ]]; then
		awk -F, 'NR > 1 && $1 != "" { sub(/^peer_/, "", $1); if (!seen[$1]++) print $1 }' "$clients_csv" | paste -sd, - && return 0
	fi

	old_wg_env_value WG_PEERS || true
}

quote_env_value() {
	local value="$1"
	local escaped

	escaped="$(printf "%s" "$value" | sed "s/'/'\\\\''/g")"
	printf "'%s'" "$escaped"
}

set_env_value() {
	local key="$1"
	local value="$2"
	local tmp

	value="$(quote_env_value "$value")"

	tmp="$(mktemp)"
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
	' "$ENV_FILE" > "$tmp"
	mv "$tmp" "$ENV_FILE"
}

sanitize_env_file_for_source() {
	local tmp line key value trimmed first last

	[[ -f "$ENV_FILE" ]] || return 0
	tmp="$(mktemp)"
	while IFS= read -r line || [[ -n "$line" ]]; do
		if [[ -z "$line" || "$line" == \#* ]]; then
			printf "%s\n" "$line" >> "$tmp"
			continue
		fi

		if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
			key="${BASH_REMATCH[1]}"
			value="${BASH_REMATCH[2]}"
			trimmed="$(printf "%s" "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
			first="${trimmed:0:1}"
			last="${trimmed: -1}"
			if [[ -z "$trimmed" || ( "$first" == "'" && "$last" == "'" ) || ( "$first" == '"' && "$last" == '"' ) ]]; then
				printf "%s=%s\n" "$key" "$value" >> "$tmp"
			else
				printf "%s=%s\n" "$key" "$(quote_env_value "$trimmed")" >> "$tmp"
			fi
			continue
		fi

		printf "%s\n" "$line" >> "$tmp"
	done < "$ENV_FILE"
	mv "$tmp" "$ENV_FILE"
	chmod 600 "$ENV_FILE" 2>/dev/null || true
}

normalize_password_hash_quotes() {
	local raw_value normalized

	[[ -f "$ENV_FILE" ]] || return 0
	raw_value="$(awk -F= '/^HY2_EXPORT_PASSWORD_HASH=/{sub(/^HY2_EXPORT_PASSWORD_HASH=/, "", $0); print $0; exit}' "$ENV_FILE")"
	[[ -n "$raw_value" ]] || return 0

	normalized="$(echo "$raw_value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
	if [[ "$normalized" == \'*\' ]]; then
		return 0
	fi

	if [[ "$normalized" == \"*\" ]]; then
		normalized="${normalized#\"}"
		normalized="${normalized%\"}"
	fi

	set_env_value HY2_EXPORT_PASSWORD_HASH "$normalized"
}

normalize_routing_mode_value() {
	local value="$1"
	case "$value" in
		internal-mihomo|cn-direct|global)
			echo "$value"
		;;
		"" )
			echo "cn-direct"
		;;
		*)
			die "Unsupported routing policy: $value (expected: cn-direct or global; internal-mihomo is accepted only for legacy state)"
		;;
	esac
}

default_hy2_download_rate() {
	echo "30 Mbps"
}

default_hy2_upload_rate() {
	echo "30 Mbps"
}

default_hy2_server_ports() {
	echo "51288"
}

default_hy2_peer_dns() {
	echo "223.5.5.5,119.29.29.29,1.1.1.1,8.8.8.8"
}

apply_internal_managed_defaults() {
	set_env_value HY2_SERVER_PORTS "$(default_hy2_server_ports_value)"
	set_env_value HY2_HOP_INTERVAL_SECONDS "0"
	set_env_value HY2_PEER_DNS "$(default_hy2_peer_dns)"
	set_env_value HY2_SERVER_BANDWIDTH_DOWN "$(default_hy2_download_rate)"
	set_env_value HY2_SERVER_BANDWIDTH_UP "$(default_hy2_upload_rate)"
	set_env_value HY2_DEFAULT_DOWN "$(default_hy2_download_rate)"
	set_env_value HY2_DEFAULT_UP "$(default_hy2_upload_rate)"
	set_env_value HY2_INTERNAL_SUBSCRIPTION_STORE "config-center"
}

internal_managed_runtime_signature() {
	printf "%s|%s|%s|%s|%s|%s|%s|%s\n" \
		"${HY2_SERVER_PORTS:-}" \
		"${HY2_HOP_INTERVAL_SECONDS:-}" \
		"${HY2_PEER_DNS:-}" \
		"${HY2_SERVER_BANDWIDTH_DOWN:-}" \
		"${HY2_SERVER_BANDWIDTH_UP:-}" \
		"${HY2_DEFAULT_DOWN:-}" \
		"${HY2_DEFAULT_UP:-}" \
		"${HY2_INTERNAL_SUBSCRIPTION_STORE:-}"
}

default_hy2_server_ports_value() {
	case "${HY2_SERVER_PORTS:-}" in
		""|"52120-52159") default_hy2_server_ports ;;
		*) echo "$HY2_SERVER_PORTS" ;;
	esac
}

default_hy2_peer_dns_value() {
	case "${HY2_PEER_DNS:-}" in
		""|"1.1.1.1,8.8.8.8") default_hy2_peer_dns ;;
		*) echo "$HY2_PEER_DNS" ;;
	esac
}

default_hy2_hop_interval_value() {
	local selected_ports="${1:-${HY2_SERVER_PORTS:-}}"

	if [[ "$selected_ports" != *-* ]]; then
		echo "0"
	elif [[ -z "${HY2_HOP_INTERVAL_SECONDS:-}" ]]; then
		echo "0"
	else
		echo "$HY2_HOP_INTERVAL_SECONDS"
	fi
}

default_hy2_server_download_rate_value() {
	case "${HY2_SERVER_BANDWIDTH_DOWN:-}" in
		""|"3 Mbps") default_hy2_download_rate ;;
		*) echo "$HY2_SERVER_BANDWIDTH_DOWN" ;;
	esac
}

default_hy2_user_download_rate_value() {
	local fallback="${1:-$(default_hy2_download_rate)}"
	case "${HY2_DEFAULT_DOWN:-}" in
		""|"3 Mbps") echo "$fallback" ;;
		*) echo "$HY2_DEFAULT_DOWN" ;;
	esac
}

port_hop_status() {
	if [[ "${HY2_SERVER_PORTS:-}" != *-* || -z "${HY2_HOP_INTERVAL_SECONDS:-}" || "${HY2_HOP_INTERVAL_SECONDS:-}" == "0" ]]; then
		echo "disabled"
	else
		echo "${HY2_HOP_INTERVAL_SECONDS}s"
	fi
}

load_env() {
	ensure_env_file
	sanitize_env_file_for_source
	normalize_password_hash_quotes
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
}

cidr_range() {
	local cidr="$1"
	local a b c d prefix ip mask start end

	[[ "$cidr" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.([0-9]+)/([0-9]+)$ ]] || return 1
	a=$((10#${BASH_REMATCH[1]}))
	b=$((10#${BASH_REMATCH[2]}))
	c=$((10#${BASH_REMATCH[3]}))
	d=$((10#${BASH_REMATCH[4]}))
	prefix=$((10#${BASH_REMATCH[5]}))
	(( a <= 255 && b <= 255 && c <= 255 && d <= 255 && prefix <= 32 )) || return 1

	ip=$(( (a << 24) | (b << 16) | (c << 8) | d ))
	if (( prefix == 0 )); then
		mask=0
	else
		mask=$(( (0xffffffff << (32 - prefix)) & 0xffffffff ))
	fi
	start=$(( ip & mask ))
	end=$(( start | (0xffffffff ^ mask) ))
	printf "%s %s\n" "$start" "$end"
}

cidrs_overlap() {
	local left="$1"
	local right="$2"
	local left_range right_range left_start left_end right_start right_end

	left_range="$(cidr_range "$left")" || return 1
	right_range="$(cidr_range "$right")" || return 1
	read -r left_start left_end <<< "$left_range"
	read -r right_start right_end <<< "$right_range"
	(( left_start <= right_end && right_start <= left_end ))
}

stack_network_name() {
	printf "%s_hy2_access\n" "$(basename "$STACK_DIR")"
}

docker_network_cidrs_except_current_stack() {
	local network_id name subnet current_network

	command -v docker >/dev/null 2>&1 || return 0
	current_network="$(stack_network_name)"
	while IFS= read -r network_id; do
		[[ -n "$network_id" ]] || continue
		name="$(docker network inspect "$network_id" -f '{{.Name}}' 2>/dev/null || true)"
		[[ -n "$name" ]] || continue
		[[ "$name" == "$current_network" ]] && continue
		while IFS= read -r subnet; do
			[[ -n "$subnet" ]] && printf "%s\n" "$subnet"
		done < <(docker network inspect "$network_id" -f '{{range .IPAM.Config}}{{if .Subnet}}{{.Subnet}}{{"\n"}}{{end}}{{end}}' 2>/dev/null || true)
	done < <(docker network ls -q 2>/dev/null || true)
}

docker_network_cidr_conflict() {
	local cidr="$1"
	local existing

	cidr_range "$cidr" >/dev/null || return 1
	while IFS= read -r existing; do
		if cidrs_overlap "$cidr" "$existing"; then
			printf "%s\n" "$existing"
			return 0
		fi
	done < <(docker_network_cidrs_except_current_stack)
	return 1
}

gateway_for_cidr() {
	local cidr="$1"
	local a b c prefix

	[[ "$cidr" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)\.[0-9]+/([0-9]+)$ ]] || return 1
	a=$((10#${BASH_REMATCH[1]}))
	b=$((10#${BASH_REMATCH[2]}))
	c=$((10#${BASH_REMATCH[3]}))
	prefix=$((10#${BASH_REMATCH[4]}))
	(( a <= 255 && b <= 255 && c <= 255 && prefix <= 30 )) || return 1
	printf "%s.%s.%s.1\n" "$a" "$b" "$c"
}

ensure_non_overlapping_stack_subnet() {
	local current conflict candidate gateway
	local -a candidates=(
		"10.254.0.0/24"
		"10.253.0.0/24"
		"10.252.0.0/24"
		"10.251.0.0/24"
		"10.250.0.0/24"
		"172.31.254.0/24"
		"172.30.254.0/24"
		"192.168.254.0/24"
	)

	command -v docker >/dev/null 2>&1 || return 0
	load_env
	current="${HY2_STACK_SUBNET:-10.254.0.0/24}"
	cidr_range "$current" >/dev/null || return 0
	if ! conflict="$(docker_network_cidr_conflict "$current")"; then
		return 0
	fi

	for candidate in "$current" "${candidates[@]}"; do
		cidr_range "$candidate" >/dev/null || continue
		if docker_network_cidr_conflict "$candidate" >/dev/null; then
			continue
		fi
		gateway="$(gateway_for_cidr "$candidate" 2>/dev/null || true)"
		[[ -n "$gateway" ]] || gateway="${HY2_STACK_GATEWAY:-10.254.0.1}"
		echo "Docker stack subnet ${current} overlaps existing Docker network ${conflict}; using ${candidate}." >&2
		set_env_value HY2_STACK_SUBNET "$candidate"
		set_env_value HY2_STACK_GATEWAY "$gateway"
		load_env
		return 0
	done

	die "Docker stack subnet ${current} overlaps existing Docker network ${conflict}; set HY2_STACK_SUBNET/HY2_STACK_GATEWAY to a free Docker bridge subnet."
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
	local value confirm

	while true; do
		read -r -s -p "$prompt: " value
		echo
		[[ -n "$value" ]] || {
			echo "Password cannot be empty." >&2
			continue
		}
		read -r -s -p "Confirm password: " confirm
		echo
		[[ "$value" == "$confirm" ]] && break
		echo "Passwords do not match, please try again." >&2
	done

	echo "$value"
}

prompt_yes_no() {
	local prompt="$1"
	local default_value="${2:-no}"
	local answer normalized

	while true; do
		read -r -p "$prompt [$default_value]: " answer
		answer="${answer:-$default_value}"
		normalized="$(echo "$answer" | tr '[:upper:]' '[:lower:]')"
		case "$normalized" in
			y|yes|n|no)
				echo "$normalized"
				return 0
			;;
		esac
		echo "Please answer yes or no." >&2
	done
}

normalize_optional_value() {
	local value="$1"
	case "$value" in
		-|none|NONE|disable|DISABLE)
			echo ""
		;;
		*)
			echo "$value"
		;;
	esac
}

sanitize_name() {
	sed 's/[^0-9A-Za-z_-]/_/g' <<< "$1" | cut -c-32
}

parse_names_csv() {
	local input="${1:-}"
	local raw clean
	local -a raw_names parsed=()

	input="${input// /,}"
	IFS=',' read -r -a raw_names <<< "$input"

	for raw in "${raw_names[@]}"; do
		raw="$(echo "$raw" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
		[[ -z "$raw" ]] && continue
		clean="$(sanitize_name "$raw")"
		[[ -n "$clean" ]] && parsed+=("$clean")
	done

	printf '%s\n' "${parsed[@]}" | awk 'NF && !seen[$0]++'
}

csv_to_array() {
	local csv="${1:-}"
	local -a values=()
	local value

	IFS=',' read -r -a values <<< "$csv"
	for value in "${values[@]}"; do
		value="$(echo "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
		[[ -n "$value" ]] && echo "$value"
	done
}

array_join_csv() {
	local IFS=','
	echo "$*"
}

container_name_for_service() {
	case "$1" in
		hysteria) echo "$HYSTERIA_CONTAINER" ;;
		subscriptions) echo "$SUBSCRIPTIONS_CONTAINER" ;;
		*) die "Unknown service: $1" ;;
	esac
}

safe_recreate_service() {
	local service="$1"
	local container_name
	container_name="$(container_name_for_service "$service")"
	if [[ "$service" == "subscriptions" ]]; then
		# Every entry point, including `start subscriptions` and `reset-auth`,
		# reaches Caddy with either a fully materialized exact route or the
		# locked disabled route. Never start it with an empty Basic Auth hash.
		load_env
		materialize_system_subscription
		load_env
	fi

	compose stop "$service" >/dev/null 2>&1 || true
	compose rm -f "$service" >/dev/null 2>&1 || true
	docker rm -f "$container_name" >/dev/null 2>&1 || true
	if [[ "$service" == "subscriptions" ]]; then
		rm -rf "$STACK_DIR/data/caddy/"* >/dev/null 2>&1 || true
		rm -rf "$STACK_DIR/config/caddy/"* >/dev/null 2>&1 || true
		rm -f "$STACK_DIR/config/caddy/autosave.json" >/dev/null 2>&1 || true
		rm -f "$STACK_DIR/config/caddy/caddy/autosave.json" >/dev/null 2>&1 || true
	fi
	compose up -d "$service"
	if [[ "$service" == "subscriptions" ]]; then
		load_env
		record_system_subscription_caddy_signature
	fi
}

wait_for_container() {
	local container_name="$1"
	local deadline=$((SECONDS + 60))

	while (( SECONDS < deadline )); do
		if [[ "$(docker inspect -f '{{.State.Running}}' "$container_name" 2>/dev/null || true)" == "true" ]]; then
			return 0
		fi
		sleep 1
	done

	die "Container did not become ready in time: $container_name"
}

container_running() {
	local container_name="$1"
	[[ "$(docker inspect -f '{{.State.Running}}' "$container_name" 2>/dev/null || true)" == "true" ]]
}

hysteria_port_publish_check_supported() {
	[[ "${HY2_SERVER_PORTS:-}" =~ ^[0-9]+$ ]]
}

hysteria_published_port_matches_env() {
	hysteria_port_publish_check_supported || return 0
	docker port "$HYSTERIA_CONTAINER" "${HY2_SERVER_PORTS}/udp" >/dev/null 2>&1
}

ensure_hysteria_published_port() {
	load_env
	container_running "$HYSTERIA_CONTAINER" || return 0
	hysteria_port_publish_check_supported || return 0
	if hysteria_published_port_matches_env; then
		return 0
	fi

	echo "Docker published UDP port drift detected for $HYSTERIA_CONTAINER; expected ${HY2_SERVER_PORTS}/udp. Recreating hysteria service."
	recreate_full_stack
}

hysteria_runtime_users_file_matches() {
	container_running "$HYSTERIA_CONTAINER" || return 0
	[[ -f "$USERS_FILE" ]] || return 1
	docker exec "$HYSTERIA_CONTAINER" sh -c 'test -f /var/lib/hysteria/users.csv && cat /var/lib/hysteria/users.csv' 2>/dev/null | cmp -s "$USERS_FILE" -
}

ensure_hysteria_runtime_users_current() {
	container_running "$HYSTERIA_CONTAINER" || return 0
	if hysteria_runtime_users_file_matches; then
		return 0
	fi

	echo "Docker hysteria users.csv drift detected; recreating hysteria service to mount current account material."
	render_runtime_files
	safe_recreate_service hysteria
	wait_for_container "$HYSTERIA_CONTAINER"
	ensure_hysteria_published_port
	if ! hysteria_runtime_users_file_matches; then
		die "Docker hysteria users.csv still differs after recreate; check bind mount source for $HYSTERIA_CONTAINER."
	fi
}

wait_for_subscription_http_ready() {
	local port="${1:-$HY2_EXPORT_FALLBACK_PORT}"
	local deadline=$((SECONDS + 60))

	while (( SECONDS < deadline )); do
		if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done

	die "Subscription HTTP endpoint did not become ready in time on port ${port}."
}

hash_password() (
	# Keep plaintext out of the host docker argv and the persisted container Cmd.
	# The subshell scopes traps so every success/failure/signal path removes the
	# root-only secret without changing traps used by the caller.
	local plaintext="$1"
	local secret_dir=""
	local secret_file=""
	local raw_hash=""
	local status=0
	local hash_tmp_base="${TMPDIR:-/tmp}"

	cleanup_hash_password_secret() {
		if [[ -n "$secret_file" ]]; then
			rm -f "$secret_file" 2>/dev/null || true
		fi
		if [[ -n "$secret_dir" ]]; then
			rmdir "$secret_dir" 2>/dev/null || true
		fi
	}
	trap cleanup_hash_password_secret EXIT
	trap 'exit 129' HUP
	trap 'exit 130' INT
	trap 'exit 143' TERM

	umask 077
	secret_dir="$(mktemp -d "${hash_tmp_base%/}/mx-hy2-caddy-hash.XXXXXX")"
	secret_file="$secret_dir/plaintext"
	# Caddy's stdin password prompt requires a line terminator; without it the
	# non-interactive reader returns EOF before hashing.
	printf "%s\n" "$plaintext" > "$secret_file"
	chmod 600 "$secret_file"
	unset plaintext

	# The fixed shell command reads the read-only mount inside the container.
	# No secret value is interpolated into docker's host argv or Config.Cmd.
	raw_hash="$(
		docker run --rm \
			--network none \
			--read-only \
			--user 0:0 \
			--mount "type=bind,source=${secret_file},target=/run/secrets/mx-hy2-password,readonly" \
			--entrypoint /bin/sh \
			caddy:2-alpine \
			-ec 'exec caddy hash-password --algorithm bcrypt < /run/secrets/mx-hy2-password'
	)" || status=$?
	if (( status != 0 )); then
		return "$status"
	fi

	printf "%s" "$raw_hash" | tr -d '\r\n'
)

random_token() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 16
	elif command -v hexdump >/dev/null 2>&1; then
		hexdump -vn 16 -e '/1 "%02x"' /dev/urandom
	else
		die "Neither openssl nor hexdump is available for token generation."
	fi
}

is_placeholder_value() {
	local value="${1:-}"
	case "$value" in
		""|REPLACE_WITH_*|\<*\>|*from-internal-secret*)
			return 0
		;;
		*)
			return 1
		;;
	esac
}

is_ip_value() {
	local value="$1"
	[[ "$value" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ || "$value" =~ : ]]
}

default_tls_sni_for_host() {
	local host="$1"
	local current="${2:-}"

	if [[ -n "$current" ]]; then
		echo "$current"
		return 0
	fi

	if is_ip_value "$host"; then
		echo ""
	else
		echo "$host"
	fi
}

generate_self_signed_cert() {
	local host="$1"
	local sni="$2"
	local cn tmp_cfg fp index=1 name
	local -a names=()

	cn="${sni:-$host}"
	names+=("$host")
	if [[ -n "$sni" && "$sni" != "$host" ]]; then
		names+=("$sni")
	fi

	tmp_cfg="$(mktemp)"
	{
		echo "[req]"
		echo "distinguished_name = dn"
		echo "x509_extensions = v3_req"
		echo "prompt = no"
		echo
		echo "[dn]"
		echo "CN = $cn"
		echo
		echo "[v3_req]"
		echo "subjectAltName = @alt_names"
		echo
		echo "[alt_names]"
		for name in "${names[@]}"; do
			if is_ip_value "$name"; then
				echo "IP.$index = $name"
			else
				echo "DNS.$index = $name"
			fi
			index=$((index + 1))
		done
	} > "$tmp_cfg"

	openssl req -x509 -newkey rsa:2048 -sha256 -nodes \
		-days "${HY2_TLS_SELF_SIGNED_DAYS:-3650}" \
		-keyout "$CERT_KEY_PATH" \
		-out "$CERT_CRT_PATH" \
		-config "$tmp_cfg" \
		-extensions v3_req >/dev/null 2>&1
	rm -f "$tmp_cfg"

	chmod 600 "$CERT_KEY_PATH"
	chmod 644 "$CERT_CRT_PATH"

	fp="$(openssl x509 -noout -fingerprint -sha256 -in "$CERT_CRT_PATH" | cut -d= -f2)"
	set_env_value HY2_TLS_FINGERPRINT "$fp"
}

render_auth_script() {
	cat > "$AUTH_SCRIPT_PATH" <<'EOF'
#!/bin/sh
set -eu

AUTH="${2:-}"
USER_DB="/var/lib/hysteria/users.csv"

[ -n "$AUTH" ] || exit 1
[ -f "$USER_DB" ] || exit 1

awk -F, -v auth="$AUTH" '
	NR == 1 { next }
	$1 ~ /^[[:space:]]*#/ || $1 ~ /^[[:space:]]*$/ { next }
	{
		gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1)
		gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
	}
	$2 == auth {
		print $1
		found = 1
		exit
	}
	END { exit(found ? 0 : 1) }
' "$USER_DB"
EOF
	chmod 755 "$AUTH_SCRIPT_PATH"
}

render_server_config() {
	{
		echo "listen: :${HY2_SERVER_PORTS}"
		echo
		echo "tls:"
		echo "  cert: /etc/hysteria/certs/server.crt"
		echo "  key: /etc/hysteria/certs/server.key"
		echo
		echo "auth:"
		echo "  type: command"
		echo "  command: /etc/hysteria/auth.sh"
		if [[ -n "${HY2_SERVER_BANDWIDTH_UP:-}" || -n "${HY2_SERVER_BANDWIDTH_DOWN:-}" ]]; then
			echo
			echo "bandwidth:"
			if [[ -n "${HY2_SERVER_BANDWIDTH_UP:-}" ]]; then
				# Server "up" is the client's download direction.
				echo "  down: ${HY2_SERVER_BANDWIDTH_UP}"
			fi
			if [[ -n "${HY2_SERVER_BANDWIDTH_DOWN:-}" ]]; then
				# Server "down" is the client's upload direction.
				echo "  up: ${HY2_SERVER_BANDWIDTH_DOWN}"
			fi
		fi
		if [[ -n "${HY2_OBFS_PASSWORD:-}" ]]; then
			echo
			echo "obfs:"
			echo "  type: salamander"
			echo "  salamander:"
			echo "    password: ${HY2_OBFS_PASSWORD}"
		fi
		if [[ -n "${HY2_MASQUERADE_URL:-}" ]]; then
			echo
			echo "masquerade:"
			echo "  type: proxy"
			echo "  proxy:"
			echo "    url: ${HY2_MASQUERADE_URL}"
			echo "    rewriteHost: true"
		fi
	} > "$SERVER_CONFIG_PATH"
}

ensure_cert_material() {
	load_env
	if [[ ! -f "$CERT_CRT_PATH" || ! -f "$CERT_KEY_PATH" ]]; then
		generate_self_signed_cert "${HY2_SERVER_HOST}" "${HY2_TLS_SERVER_NAME:-$HY2_SERVER_HOST}"
		load_env
	fi
}

render_runtime_files() {
	load_env
	ensure_users_file
	ensure_export_auth_defaults
	load_env
	ensure_cert_material
	load_env
	materialize_system_subscription
	load_env
	render_auth_script
	render_server_config
}

current_users() {
	ensure_users_file
	awk -F, 'NR > 1 && $1 != "" { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); print $1 }' "$USERS_FILE"
}

normalize_internal_managed_user_limits() {
	local tmp default_up default_down

	ensure_users_file
	default_up="${HY2_DEFAULT_UP:-$(default_hy2_upload_rate)}"
	default_down="${HY2_DEFAULT_DOWN:-$(default_hy2_download_rate)}"
	tmp="$(mktemp)"
	awk -F, -v default_up="$default_up" -v default_down="$default_down" '
		BEGIN { OFS = "," }
		NR == 1 {
			print "name,auth,up,down"
			next
		}
		{
			for (i = 1; i <= 4; i++) {
				gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
			}
			if ($1 == "" || $2 == "") next
			if ($3 == "" || $3 == "3 Mbps") $3 = default_up
			if ($4 == "" || $4 == "3 Mbps") $4 = default_down
			print $1, $2, $3, $4
		}
	' "$USERS_FILE" > "$tmp"
	mv "$tmp" "$USERS_FILE"
	chmod 600 "$USERS_FILE"
}

sync_env_user_list_from_file() {
	local -a names=()

	normalize_internal_managed_user_limits
	mapfile -t names < <(current_users)
	set_env_value HY2_USERS "$(array_join_csv "${names[@]}")"
}

ensure_export_auth_defaults() {
	local first_user auth_user auth_hash generated_password

	first_user="$(current_users | head -n 1 || true)"
	auth_user="${HY2_EXPORT_USER:-}"
	if is_placeholder_value "$auth_user"; then
		auth_user="${first_user:-download}"
		set_env_value HY2_EXPORT_USER "$auth_user"
	fi

	auth_hash="${HY2_EXPORT_PASSWORD_HASH:-}"
	if is_placeholder_value "$auth_hash"; then
		generated_password="$(random_token)"
		set_env_value HY2_EXPORT_PASSWORD_HASH "$(hash_password "$generated_password")"
		echo "Generated random health/evidence password hash for ${auth_user}; plaintext is intentionally not stored." >&2
	fi
}

node_parser_command() {
	if command -v node >/dev/null 2>&1; then
		command -v node
		return 0
	fi
	return 1
}

python_parser_command() {
	if command -v python3 >/dev/null 2>&1; then
		command -v python3
		return 0
	elif command -v python >/dev/null 2>&1; then
		command -v python
		return 0
	fi
	return 1
}

json_parser_command() {
	node_parser_command && return 0
	python_parser_command && return 0
	return 1
}

install_nvm_prerequisites() {
	if command -v curl >/dev/null 2>&1; then
		return 0
	fi

	if command -v apt-get >/dev/null 2>&1; then
		export DEBIAN_FRONTEND=noninteractive
		apt-get update
		apt-get install -y ca-certificates curl
	elif command -v dnf >/dev/null 2>&1; then
		dnf install -y ca-certificates curl
	elif command -v yum >/dev/null 2>&1; then
		yum install -y ca-certificates curl
	elif command -v apk >/dev/null 2>&1; then
		apk add --no-cache ca-certificates curl
	elif command -v zypper >/dev/null 2>&1; then
		zypper --non-interactive install ca-certificates curl
	else
		return 1
	fi
}

load_nvm_for_json_parser() {
	export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
	[[ -s "$NVM_DIR/nvm.sh" ]] || return 1
	# shellcheck disable=SC1090
	source "$NVM_DIR/nvm.sh"
}

install_nvm_node_for_json_parser() {
	local node_version="${MX_OVERSEA_NODE_VERSION:-22}"
	local nvm_version="${MX_OVERSEA_NVM_VERSION:-v0.40.3}"

	export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
	if ! load_nvm_for_json_parser; then
		install_nvm_prerequisites || return 1
		mkdir -p "$NVM_DIR" || return 1
		curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/${nvm_version}/install.sh" | PROFILE=/dev/null METHOD=script bash || return 1
		load_nvm_for_json_parser || return 1
	fi
	nvm install "$node_version" || return 1
	nvm alias default "$node_version" >/dev/null 2>&1 || true
	nvm use "$node_version" || return 1
	command -v node >/dev/null 2>&1 || return 1
	node --version >&2 || true
}

install_python3_for_json_parser() {
	if command -v apt-get >/dev/null 2>&1; then
		export DEBIAN_FRONTEND=noninteractive
		apt-get update
		apt-get install -y python3
	elif command -v dnf >/dev/null 2>&1; then
		dnf install -y python3
	elif command -v yum >/dev/null 2>&1; then
		yum install -y python3
	elif command -v apk >/dev/null 2>&1; then
		apk add --no-cache python3
	elif command -v zypper >/dev/null 2>&1; then
		zypper --non-interactive install python3
	else
		die "node or python3 is required to parse tunnel state, and no supported package manager was found."
	fi
}

ensure_json_parser() {
	local parser

	parser="$(node_parser_command || true)"
	if [[ -n "$parser" ]]; then
		echo "$parser"
		return 0
	fi

	echo "Node is not installed; installing nvm and Node 22 for tunnel-state reconciliation." >&2
	if install_nvm_node_for_json_parser >&2; then
		parser="$(node_parser_command || true)"
		[[ -n "$parser" ]] || die "nvm completed but node is still unavailable."
		echo "$parser"
		return 0
	fi

	echo "nvm/Node 22 install failed; trying python3 fallback for tunnel-state reconciliation." >&2
	parser="$(python_parser_command || true)"
	if [[ -n "$parser" ]]; then
		echo "$parser"
		return 0
	fi

	install_python3_for_json_parser >&2
	parser="$(json_parser_command || true)"
	[[ -n "$parser" ]] || die "node or python3 is required to parse tunnel state."
	echo "$parser"
}

reconcile_tunnel_state_files() {
	local parser="$1"
	local state_file="$2"
	local users_file="$3"
	local env_file="$4"
	local parser_name

	parser_name="$(basename "$parser")"
	if [[ "$parser_name" == "node" ]]; then
		"$parser" "$STACK_DIR/scripts/reconcile-tunnel-state.mjs" \
			--state-file "$state_file" \
			--users-file "$users_file" \
			--output-env-file "$env_file"
	else
		"$parser" "$STACK_DIR/scripts/reconcile-tunnel-state.py" \
			--state-file "$state_file" \
			--users-file "$users_file" \
			--output-env-file "$env_file"
	fi
}

user_record() {
	local name="$1"
	awk -F, -v name="$name" '
		NR == 1 { next }
		{
			for (i = 1; i <= 4; i++) {
				gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
			}
		}
		$1 == name {
			printf "%s\t%s\t%s\n", $2, $3, $4
			exit
		}
	' "$USERS_FILE"
}

sha256_text() {
	local value="$1"
	if command -v sha256sum >/dev/null 2>&1; then
		printf "%s" "$value" | sha256sum | awk '{ print $1 }'
	elif command -v shasum >/dev/null 2>&1; then
		printf "%s" "$value" | shasum -a 256 | awk '{ print $1 }'
	elif command -v openssl >/dev/null 2>&1; then
		printf "%s" "$value" | openssl dgst -sha256 | awk '{ print $NF }'
	else
		die "sha256sum, shasum, or openssl is required for system subscription credential tracking."
	fi
}

yaml_single_quote() {
	local value="$1"
	value="$(printf "%s" "$value" | sed "s/'/''/g")"
	printf "'%s'" "$value"
}

is_bcrypt_password_hash() {
	local value="${1:-}"
	[[ "$value" =~ ^\$2[aby]\$[0-9][0-9]\$[./A-Za-z0-9]{53}$ ]]
}

system_subscription_account_name() {
	local account="${HY2_SYSTEM_SUBSCRIPTION_ACCOUNT:-}"
	if is_placeholder_value "$account"; then
		return 1
	fi
	[[ "$account" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] || return 1
	[[ "$account" == *-subscriptions ]] || return 1
	printf "%s\n" "$account"
}

system_subscription_filename() {
	local account
	account="$(system_subscription_account_name)" || return 1
	printf "peer_%s.mihomo.yaml\n" "$account"
}

system_subscription_public_path() {
	local filename
	filename="$(system_subscription_filename)" || return 1
	printf "/%s\n" "$filename"
}

cleanup_system_subscription_yamls() {
	local keep_name="${1:-}"
	if [[ -n "$keep_name" ]]; then
		find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f \
			-name 'peer_*-subscriptions.mihomo.yaml' ! -name "$keep_name" -delete 2>/dev/null || true
	else
		find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f \
			-name 'peer_*-subscriptions.mihomo.yaml' -delete 2>/dev/null || true
	fi
}

disable_system_subscription_artifact() {
	local reason="${1:-not configured}"
	local current_hash="${HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH:-}"

	cleanup_system_subscription_yamls
	set_env_value HY2_SYSTEM_SUBSCRIPTION_PATH "$SYSTEM_SUBSCRIPTION_DISABLED_PATH"
	if ! is_bcrypt_password_hash "$current_hash"; then
		set_env_value HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH "$SYSTEM_SUBSCRIPTION_DISABLED_PASSWORD_HASH"
		set_env_value HY2_SYSTEM_SUBSCRIPTION_AUTH_TOKEN_SHA256 "disabled"
	fi
	echo "System subscription disabled: ${reason}. Health/evidence outlet remains available." >&2
}

system_subscription_caddy_signature() {
	sha256_text "${HY2_SYSTEM_SUBSCRIPTION_ACCOUNT:-}|${HY2_SYSTEM_SUBSCRIPTION_BASIC_USER:-}|${HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH:-}|${HY2_SYSTEM_SUBSCRIPTION_PATH:-}"
}

record_system_subscription_caddy_signature() {
	local tmp
	mkdir -p "$(dirname "$SYSTEM_SUBSCRIPTION_CADDY_SIGNATURE_FILE")"
	tmp="$(mktemp "${SYSTEM_SUBSCRIPTION_CADDY_SIGNATURE_FILE}.XXXXXX")"
	system_subscription_caddy_signature > "$tmp"
	chmod 600 "$tmp"
	mv -f "$tmp" "$SYSTEM_SUBSCRIPTION_CADDY_SIGNATURE_FILE"
}

ensure_system_subscription_caddy_current() {
	local expected applied
	load_env
	container_running "$SUBSCRIPTIONS_CONTAINER" || return 0
	expected="$(system_subscription_caddy_signature)"
	applied="$(cat "$SYSTEM_SUBSCRIPTION_CADDY_SIGNATURE_FILE" 2>/dev/null || true)"
	[[ -n "$expected" && "$expected" == "$applied" ]] && return 0

	echo "System subscription Caddy credential/path changed; recreating the health/evidence outlet."
	safe_recreate_service subscriptions
	wait_for_container "$SUBSCRIPTIONS_CONTAINER"
}

materialize_system_subscription() {
	local account record auth_token ignored_up ignored_down host server_port mixed_port
	local basic_user auth_hash auth_token_sha stored_auth_token_sha filename public_path proxy_name
	local fingerprint tmp dns_server

	ensure_stack_dirs
	ensure_users_file
	account="$(system_subscription_account_name || true)"
	if [[ -z "$account" ]]; then
		disable_system_subscription_artifact "Internal did not provide a valid *-subscriptions account"
		return 0
	fi
	filename="peer_${account}.mihomo.yaml"
	public_path="/${filename}"

	basic_user="${HY2_SYSTEM_SUBSCRIPTION_BASIC_USER:-subscriptions}"
	if is_placeholder_value "$basic_user"; then
		basic_user="subscriptions"
		set_env_value HY2_SYSTEM_SUBSCRIPTION_BASIC_USER "$basic_user"
	elif [[ ! "$basic_user" =~ ^[A-Za-z0-9_.-]{1,64}$ ]]; then
		set_env_value HY2_SYSTEM_SUBSCRIPTION_BASIC_USER "subscriptions"
		disable_system_subscription_artifact "Basic Auth username is invalid"
		return 0
	fi

	record="$(user_record "$account")"
	if [[ -z "$record" ]]; then
		disable_system_subscription_artifact "${account} is absent from Internal-issued users.csv"
		return 0
	fi
	IFS=$'\t' read -r auth_token ignored_up ignored_down <<< "$record"
	if [[ -z "$auth_token" ]]; then
		disable_system_subscription_artifact "${account} has no auth token"
		return 0
	fi

	host="${HY2_SERVER_HOST:-}"
	if is_placeholder_value "$host" || [[ "$host" =~ [[:space:]/] ]] || ! is_ip_value "$host"; then
		disable_system_subscription_artifact "a direct Hysteria public IP is missing or invalid"
		return 0
	fi
	server_port="${HY2_SERVER_PORTS:-}"
	server_port="${server_port%%-*}"
	if [[ ! "$server_port" =~ ^[0-9]+$ ]] || (( server_port < 1 || server_port > 65535 )); then
		disable_system_subscription_artifact "Hysteria public UDP port is invalid"
		return 0
	fi
	fingerprint="${HY2_TLS_FINGERPRINT:-}"
	if is_placeholder_value "$fingerprint"; then
		disable_system_subscription_artifact "TLS certificate fingerprint is missing"
		return 0
	fi
	mixed_port="${HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT:-$SYSTEM_SUBSCRIPTION_MIXED_PORT_DEFAULT}"
	if [[ ! "$mixed_port" =~ ^[0-9]+$ ]] || (( mixed_port < 1 || mixed_port > 65535 )); then
		disable_system_subscription_artifact "system subscription mixed port is invalid"
		return 0
	fi
	set_env_value HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT "$mixed_port"

	auth_hash="${HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH:-}"
	stored_auth_token_sha="${HY2_SYSTEM_SUBSCRIPTION_AUTH_TOKEN_SHA256:-}"
	auth_token_sha="$(sha256_text "$auth_token")"
	if is_placeholder_value "$auth_hash" \
		|| [[ "$stored_auth_token_sha" == "disabled" ]] \
		|| [[ "$stored_auth_token_sha" != "$auth_token_sha" ]]; then
		# Remove the old artifact before rotating the download credential. A hash
		# failure therefore cannot leave a stale credential-bearing YAML available.
		cleanup_system_subscription_yamls
		set_env_value HY2_SYSTEM_SUBSCRIPTION_PATH "$SYSTEM_SUBSCRIPTION_DISABLED_PATH"
		auth_hash="$(hash_password "$auth_token")"
		if ! is_bcrypt_password_hash "$auth_hash"; then
			disable_system_subscription_artifact "Caddy did not return a valid bcrypt hash"
			return 0
		fi
		set_env_value HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH "$auth_hash"
		set_env_value HY2_SYSTEM_SUBSCRIPTION_AUTH_TOKEN_SHA256 "$auth_token_sha"
	elif ! is_bcrypt_password_hash "$auth_hash"; then
		disable_system_subscription_artifact "configured Basic Auth hash is not bcrypt"
		return 0
	fi

	proxy_name="peer_${account}"
	tmp="$(mktemp "$STACK_DIR/data/subscriptions/.${filename}.XXXXXX")"
	{
		echo "# Generated from the Internal-issued ${account} access account."
		echo "# Unmetered traffic quota; 50 Mbps values are client bandwidth hints."
		echo "mixed-port: ${mixed_port}"
		echo "allow-lan: false"
		echo "mode: rule"
		echo "log-level: info"
		echo "geodata-mode: true"
		echo "geo-auto-update: true"
		echo "geo-update-interval: 24"
		echo
		echo "proxies:"
		printf "  - name: %s\n" "$(yaml_single_quote "$proxy_name")"
		echo "    type: hysteria2"
		printf "    server: %s\n" "$(yaml_single_quote "$host")"
		echo "    port: ${server_port}"
		printf "    password: %s\n" "$(yaml_single_quote "$auth_token")"
		printf "    down: %s\n" "$(yaml_single_quote "$SYSTEM_SUBSCRIPTION_BANDWIDTH_HINT")"
		printf "    up: %s\n" "$(yaml_single_quote "$SYSTEM_SUBSCRIPTION_BANDWIDTH_HINT")"
		echo "    skip-cert-verify: true"
		printf "    fingerprint: %s\n" "$(yaml_single_quote "$fingerprint")"
		echo "    alpn:"
		echo "      - h3"
		echo "    dns:"
		while IFS= read -r dns_server; do
			printf "      - %s\n" "$(yaml_single_quote "$dns_server")"
		done < <(csv_to_array "${HY2_PEER_DNS:-$(default_hy2_peer_dns)}")
		echo
		echo "proxy-groups:"
		echo "  - name: PROXY"
		echo "    type: select"
		echo "    proxies:"
		printf "      - %s\n" "$(yaml_single_quote "$proxy_name")"
		echo "      - DIRECT"
		echo
		echo "rules:"
		echo "  - DOMAIN-SUFFIX,local,DIRECT"
		echo "  - IP-CIDR,127.0.0.0/8,DIRECT,no-resolve"
		echo "  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve"
		echo "  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve"
		echo "  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve"
		echo "  - IP-CIDR,169.254.0.0/16,DIRECT,no-resolve"
		echo "  - IP-CIDR6,::1/128,DIRECT,no-resolve"
		echo "  - IP-CIDR6,fc00::/7,DIRECT,no-resolve"
		echo "  - IP-CIDR6,fe80::/10,DIRECT,no-resolve"
		echo "  - GEOSITE,CN,DIRECT"
		echo "  - GEOIP,CN,DIRECT"
		echo "  - MATCH,PROXY"
	} > "$tmp"
	chmod 600 "$tmp"
	mv -f "$tmp" "$STACK_DIR/data/subscriptions/$filename"
	cleanup_system_subscription_yamls "$filename"
	set_env_value HY2_SYSTEM_SUBSCRIPTION_PATH "$public_path"
}

upsert_user_record() {
	local name="$1"
	local auth_token="$2"
	local up_rate="$3"
	local down_rate="$4"
	local tmp

	tmp="$(mktemp)"
	awk -F, -v name="$name" '
		BEGIN { OFS = "," }
		NR == 1 { print; next }
		{
			gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1)
		}
		$1 == name { next }
		{ print }
	' "$USERS_FILE" > "$tmp"
	mv "$tmp" "$USERS_FILE"

	echo "$name,$auth_token,$up_rate,$down_rate" >> "$USERS_FILE"
	chmod 600 "$USERS_FILE"
}

remove_user_record() {
	local name="$1"
	local tmp

	tmp="$(mktemp)"
	awk -F, -v name="$name" '
		BEGIN { OFS = "," }
		NR == 1 { print; next }
		{
			gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1)
		}
		$1 == name { next }
		{ print }
	' "$USERS_FILE" > "$tmp"
	mv "$tmp" "$USERS_FILE"
}

delete_user_artifacts() {
	local name="$1"
	find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f \( -name "peer_${name}.*.yaml" -o -name "${name}.*.yaml" -o -name "${name}.yaml" \) -delete 2>/dev/null || true
}

first_subscription_yaml() {
	local summary="$STACK_DIR/data/subscriptions/clients.csv"
	[[ -f "$summary" ]] && echo "$summary"
}

verify_subscription_auth() {
	local auth_user="$1"
	local auth_pass="$2"
	local deadline=$((SECONDS + 45))

	[[ -f "$STACK_DIR/data/subscriptions/clients.csv" ]] || refresh_subscriptions

	wait_for_subscription_http_ready "$HY2_EXPORT_FALLBACK_PORT"

	while (( SECONDS < deadline )); do
		if curl -fsS -u "${auth_user}:${auth_pass}" "http://127.0.0.1:${HY2_EXPORT_FALLBACK_PORT}/clients.csv" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done

	die "Health/evidence auth verification failed for clients.csv. Please re-run reset-auth with a known password."
}

subscription_auth_hash_state() {
	local hash="${HY2_EXPORT_PASSWORD_HASH:-}"

	if [[ -z "$hash" ]]; then
		echo "missing"
	elif is_placeholder_value "$hash"; then
		echo "placeholder"
	else
		echo "configured"
	fi
}

refresh_subscriptions() {
	local user_count managed_filename

	load_env
	materialize_system_subscription
	load_env
	managed_filename=""
	if [[ "${HY2_SYSTEM_SUBSCRIPTION_PATH:-}" =~ ^/([^/]+-subscriptions\.mihomo\.yaml)$ ]]; then
		managed_filename="${BASH_REMATCH[1]}"
	fi
	if [[ -n "$managed_filename" && -f "$STACK_DIR/data/subscriptions/$managed_filename" ]]; then
		find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f -name '*.yaml' \
			! -name "$managed_filename" -delete 2>/dev/null || true
	else
		find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f -name '*.yaml' -delete 2>/dev/null || true
	fi

	user_count="$(awk -F, 'NR > 1 && $1 != "" { count++ } END { print count + 0 }' "$USERS_FILE")"
	(
		echo "name,source,subscription_authority,internal_mihomo_base_url,access_endpoint"
		awk -F, \
			-v internal="${HY2_INTERNAL_MIHOMO_BASE_URL:-}" \
			-v endpoint="${HY2_SERVER_HOST:-}:${HY2_SERVER_PORTS:-}" \
			'NR > 1 && $1 != "" { printf "%s,internal,config-center,%s,%s\n", $1, internal, endpoint }' \
			"$USERS_FILE"
	) > "$STACK_DIR/data/subscriptions/clients.csv"
	chmod 600 "$STACK_DIR/data/subscriptions/clients.csv"
	if [[ "$user_count" == "0" ]]; then
		echo "No users found, health/evidence summary reset."
	else
		echo "Health/evidence summary refreshed for ${user_count} Hysteria2 users."
	fi
	ensure_system_subscription_caddy_current
}

wait_for_existing_yaml() {
	local deadline=$((SECONDS + 60))

	while (( SECONDS < deadline )); do
		if [[ -n "$(first_subscription_yaml || true)" ]]; then
			return 0
		fi
		sleep 1
	done
	return 1
}

stop_target() {
	local target="${1:-all}"

	case "$target" in
		all)
			compose stop subscriptions >/dev/null 2>&1 || true
			compose stop hysteria >/dev/null 2>&1 || true
		;;
		hysteria|subscriptions)
			compose stop "$target" >/dev/null 2>&1 || true
		;;
		*)
			die "Unknown stop target: $target"
		;;
	esac
}

backup_generated_state() {
	local backup_dir="$STACK_DIR/backups"
	local stamp backup_file

	mkdir -p "$backup_dir"
	stamp="$(date '+%Y%m%d-%H%M%S')"
	backup_file="$backup_dir/hy2-access-stack-$stamp.tar.gz"

	tar -czf "$backup_file" \
		-C "$STACK_DIR" \
		--ignore-failed-read \
		.env \
		data \
		config

	echo "$backup_file"
}

confirm_or_die() {
	local prompt="$1"
	local answer

	read -r -p "$prompt [y/N]: " answer
	case "$answer" in
		y|Y|yes|YES) return 0 ;;
		*) die "Cancelled." ;;
	esac
}

destroy_stack_command() {
	local wipe_data="${1:-false}"
	local wipe_env="${2:-false}"
	local force_yes="${3:-false}"
	local backup_file=""

	if [[ "$wipe_data" == "true" || "$wipe_env" == "true" ]]; then
		backup_file="$(backup_generated_state)"
		echo "Backup created: $backup_file"
	fi

	if [[ "$force_yes" != "true" ]]; then
		if [[ "$wipe_data" == "true" || "$wipe_env" == "true" ]]; then
			confirm_or_die "This will remove stack containers and wipe generated state under $STACK_DIR. Continue?"
		else
			confirm_or_die "This will remove stack containers. Continue?"
		fi
	fi

	compose down --remove-orphans >/dev/null 2>&1 || true
	docker rm -f "$HYSTERIA_CONTAINER" >/dev/null 2>&1 || true
	docker rm -f "$SUBSCRIPTIONS_CONTAINER" >/dev/null 2>&1 || true

	if [[ "$wipe_data" == "true" ]]; then
		rm -rf \
			"$STACK_DIR/data/hysteria" \
			"$STACK_DIR/data/subscriptions" \
			"$STACK_DIR/data/caddy" \
			"$STACK_DIR/config/caddy" \
			"$STACK_DIR/config/hysteria"
	fi

	if [[ "$wipe_env" == "true" ]]; then
		rm -f "$ENV_FILE"
	fi

	ensure_stack_dirs
	ensure_env_file
	ensure_users_file

	echo "Stack containers removed."
	if [[ "$wipe_data" == "true" ]]; then
		echo "Generated data wiped."
	fi
	if [[ "$wipe_env" == "true" ]]; then
		echo "Environment reset from defaults."
	fi
}

start_full_stack_services() {
	render_runtime_files
	ensure_non_overlapping_stack_subnet
	safe_recreate_service subscriptions
	wait_for_container "$SUBSCRIPTIONS_CONTAINER"
	safe_recreate_service hysteria
	wait_for_container "$HYSTERIA_CONTAINER"
	hysteria_published_port_matches_env || die "Docker did not publish expected Hysteria2 UDP port ${HY2_SERVER_PORTS}/udp after recreate."
	refresh_subscriptions
}

start_target() {
	local target="${1:-all}"

	case "$target" in
		all)
			start_full_stack_services
		;;
		hysteria)
			render_runtime_files
			ensure_non_overlapping_stack_subnet
			safe_recreate_service hysteria
			wait_for_container "$HYSTERIA_CONTAINER"
			ensure_hysteria_published_port
			refresh_subscriptions
		;;
		subscriptions)
			ensure_non_overlapping_stack_subnet
			safe_recreate_service subscriptions
			wait_for_container "$SUBSCRIPTIONS_CONTAINER"
		;;
		*)
			die "Unknown start target: $target"
		;;
	esac
}

recreate_full_stack() {
	compose down --remove-orphans >/dev/null 2>&1 || true
	docker rm -f "$HYSTERIA_CONTAINER" >/dev/null 2>&1 || true
	docker rm -f "$SUBSCRIPTIONS_CONTAINER" >/dev/null 2>&1 || true
	start_full_stack_services
}

status_command() {
	local line

	load_env
	echo "Stack directory: $STACK_DIR"
	echo "Hysteria server host: ${HY2_SERVER_HOST:-unset}"
	echo "Hysteria server ports: ${HY2_SERVER_PORTS:-unset}"
	echo "Health/evidence outlet URL: ${HY2_EXPORT_BASE_URL:-unset}/clients.csv"
	echo "Health/evidence outlet listen port: ${HY2_EXPORT_FALLBACK_PORT:-unset}"
	echo "Health/evidence auth user: ${HY2_EXPORT_USER:-unset}"
	echo "Health/evidence auth hash: $(subscription_auth_hash_state)"
	echo "Internal mihomo URL: ${HY2_INTERNAL_MIHOMO_BASE_URL:-unset}"
	echo "Internal subscription authority: ${HY2_INTERNAL_SUBSCRIPTION_STORE:-unset}"
	echo "Routing policy: ${HY2_MIHOMO_ROUTING_MODE:-cn-direct}"
	echo "Peer DNS servers: ${HY2_PEER_DNS:-unset}"
	echo "Reserved Internal CIDRs: ${HY2_RESERVED_INTERNAL_CIDRS:-10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16}"
	echo "Domestic gateway IP: ${HY2_DOMESTIC_GATEWAY_IP:-10.88.0.1}"
	echo "TLS server name: ${HY2_TLS_SERVER_NAME:-unset}"
	echo "TLS fingerprint: ${HY2_TLS_FINGERPRINT:-unset}"
	echo "Port hop interval: $(port_hop_status)"
	echo "Per-client download cap: ${HY2_SERVER_BANDWIDTH_DOWN:-unset}"
	echo "Per-client upload cap: ${HY2_SERVER_BANDWIDTH_UP:-unset}"
	echo
	compose ps
	echo
	echo "Users:"
	if [[ ! -f "$USERS_FILE" ]]; then
		echo "  (users file missing)"
		return 0
	fi
	while IFS= read -r line; do
		[[ -n "$line" ]] || continue
		echo "  $line"
	done < <(awk -F, 'NR > 1 && $1 != "" { printf "- %s (up=%s, down=%s)\n", $1, $3, $4 }' "$USERS_FILE")
}

docker_container_summary() {
	local container_name="$1"

	docker inspect -f 'name={{.Name}} image={{.Config.Image}} status={{.State.Status}} running={{.State.Running}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name"
}

internal_defaults_drift_report() {
	local drift=0
	local default_up default_down system_account user_limit_drift

	if [[ -z "${HY2_SERVER_PORTS:-}" ]]; then
		echo "drift: HY2_SERVER_PORTS=unset expected Internal-managed Hysteria2 UDP port"
		drift=1
	fi
	if [[ "${HY2_HOP_INTERVAL_SECONDS:-}" != "0" ]]; then
		echo "drift: HY2_HOP_INTERVAL_SECONDS=${HY2_HOP_INTERVAL_SECONDS:-unset} expected 0"
		drift=1
	fi
	if [[ "${HY2_PEER_DNS:-}" != "$(default_hy2_peer_dns)" ]]; then
		echo "drift: HY2_PEER_DNS=${HY2_PEER_DNS:-unset} expected $(default_hy2_peer_dns)"
		drift=1
	fi
	if [[ "${HY2_SERVER_BANDWIDTH_DOWN:-}" != "$(default_hy2_download_rate)" ]]; then
		echo "drift: HY2_SERVER_BANDWIDTH_DOWN=${HY2_SERVER_BANDWIDTH_DOWN:-unset} expected $(default_hy2_download_rate)"
		drift=1
	fi
	if [[ "${HY2_SERVER_BANDWIDTH_UP:-}" != "$(default_hy2_upload_rate)" ]]; then
		echo "drift: HY2_SERVER_BANDWIDTH_UP=${HY2_SERVER_BANDWIDTH_UP:-unset} expected $(default_hy2_upload_rate)"
		drift=1
	fi
	if [[ "${HY2_DEFAULT_DOWN:-}" != "$(default_hy2_download_rate)" ]]; then
		echo "drift: HY2_DEFAULT_DOWN=${HY2_DEFAULT_DOWN:-unset} expected $(default_hy2_download_rate)"
		drift=1
	fi
	if [[ "${HY2_DEFAULT_UP:-}" != "$(default_hy2_upload_rate)" ]]; then
		echo "drift: HY2_DEFAULT_UP=${HY2_DEFAULT_UP:-unset} expected $(default_hy2_upload_rate)"
		drift=1
	fi
	if container_running "$HYSTERIA_CONTAINER" && ! hysteria_published_port_matches_env; then
		echo "drift: Docker published UDP port does not match HY2_SERVER_PORTS=${HY2_SERVER_PORTS:-unset}"
		docker port "$HYSTERIA_CONTAINER" 2>/dev/null || true
		drift=1
	fi
	if [[ "${HY2_INTERNAL_SUBSCRIPTION_STORE:-}" != "config-center" ]]; then
		echo "drift: HY2_INTERNAL_SUBSCRIPTION_STORE=${HY2_INTERNAL_SUBSCRIPTION_STORE:-unset} expected config-center"
		drift=1
	fi
	if [[ -f "$USERS_FILE" ]]; then
		default_up="${HY2_DEFAULT_UP:-$(default_hy2_upload_rate)}"
		default_down="${HY2_DEFAULT_DOWN:-$(default_hy2_download_rate)}"
		system_account="${HY2_SYSTEM_SUBSCRIPTION_ACCOUNT:-}"
		user_limit_drift="$(awk -F, \
			-v default_up="$default_up" \
			-v default_down="$default_down" \
			-v system_account="$system_account" \
			-v system_bandwidth="$SYSTEM_SUBSCRIPTION_BANDWIDTH_HINT" '
			NR > 1 && $1 != "" {
				expected_up = default_up
				expected_down = default_down
				for (i = 1; i <= 4; i++) {
					gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
				}
				if (system_account != "" && $1 == system_account) {
					expected_up = system_bandwidth
					expected_down = system_bandwidth
				}
				if ($3 != expected_up || $4 != expected_down) {
					printf "%s up=%s down=%s expected up=%s down=%s\n", $1, $3, $4, expected_up, expected_down
				}
			}
		' "$USERS_FILE")"
		if [[ -n "$user_limit_drift" ]]; then
			echo "$user_limit_drift" | sed 's/^/drift: user-limit /'
			drift=1
		fi
	fi

	if [[ "$drift" == "0" ]]; then
		echo "passed"
	fi
	return "$drift"
}

docker_status_command() {
	local soft="false"
	local missing=0
	local defaults_drift=0

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--soft|--allow-stopped) soft="true"; shift ;;
			*) die "Unknown docker-status option: $1" ;;
		esac
	done

	status_command
	echo
	echo "Internal-managed defaults:"
	if ! internal_defaults_drift_report; then
		defaults_drift=1
	fi
	echo
	echo "Docker Hysteria2 runtime:"
	if container_running "$HYSTERIA_CONTAINER"; then
		docker_container_summary "$HYSTERIA_CONTAINER"
		docker port "$HYSTERIA_CONTAINER" "${HY2_SERVER_PORTS:-51288}/udp" 2>/dev/null || true
	else
		echo "missing or stopped: $HYSTERIA_CONTAINER"
		missing=1
	fi
	if container_running "$SUBSCRIPTIONS_CONTAINER"; then
		docker_container_summary "$SUBSCRIPTIONS_CONTAINER"
	else
		echo "missing or stopped: $SUBSCRIPTIONS_CONTAINER"
		missing=1
	fi
	echo
	docker ps --filter "name=mx-oversea-hysteria2" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

	if [[ "$missing" != "0" ]]; then
		if [[ "$soft" == "true" ]]; then
			echo
			echo "status: stopped"
			echo "next action: run Internal Install / Sync to start Docker hysteria2 access stack."
			return 0
		fi
		die "Docker hysteria2 access stack is not running; run setup or Internal Install / Sync."
	fi
	if [[ "$defaults_drift" != "0" ]]; then
		if [[ "$soft" == "true" ]]; then
			echo
			echo "status: defaults-drift"
			echo "next action: run Internal Install / Sync to apply Internal-managed defaults."
			return 0
		fi
		die "Docker hysteria2 access stack defaults drift from Internal-managed values; run setup or Internal Install / Sync."
	fi
	echo
	echo "Docker Hysteria2 account material:"
	if hysteria_runtime_users_file_matches; then
		echo "passed"
	elif [[ "$soft" == "true" ]]; then
		echo "status: users-drift"
		echo "next action: run sync-internal-defaults or per-user ensure-subscription to recreate hysteria with current users.csv."
	else
		die "Docker hysteria users.csv differs from current account material; run sync-internal-defaults or Internal Install / Sync."
	fi
}

sync_internal_defaults_command() {
	local old_signature new_signature

	load_env
	old_signature="$(internal_managed_runtime_signature)"
	apply_internal_managed_defaults
	load_env
	new_signature="$(internal_managed_runtime_signature)"
	render_runtime_files

	if ! container_running "$HYSTERIA_CONTAINER" || ! container_running "$SUBSCRIPTIONS_CONTAINER"; then
		start_target all
	elif [[ "$old_signature" != "$new_signature" ]]; then
		recreate_full_stack
	elif ! hysteria_published_port_matches_env; then
		ensure_hysteria_published_port
	elif ! hysteria_runtime_users_file_matches; then
		ensure_hysteria_runtime_users_current
	else
		refresh_subscriptions
	fi
	ensure_system_subscription_caddy_current

	echo "Internal-managed Docker hysteria2 defaults synced: ports=${HY2_SERVER_PORTS:-unset}, dns=${HY2_PEER_DNS:-unset}, down=${HY2_SERVER_BANDWIDTH_DOWN:-unset}"
}

check_subscription_auth_command() {
	local auth_pass="${1:-}"
	local sample_yaml sample_name hash_state

	load_env
	hash_state="$(subscription_auth_hash_state)"
	sample_yaml="$(first_subscription_yaml || true)"
	sample_name=""
	if [[ -n "$sample_yaml" && -f "$sample_yaml" ]]; then
		sample_name="$(basename "$sample_yaml")"
	fi

	echo "Health/evidence outlet URL: ${HY2_EXPORT_BASE_URL:-unset}/clients.csv"
	echo "Health/evidence outlet listen port: ${HY2_EXPORT_FALLBACK_PORT:-unset}"
	echo "Health/evidence auth user: ${HY2_EXPORT_USER:-unset}"
	echo "Health/evidence auth hash: $hash_state"
	if [[ -n "$sample_name" ]]; then
		echo "Protected summary: $sample_name"
		echo "Local test URL: http://${HY2_EXPORT_USER:-user}:<password>@127.0.0.1:${HY2_EXPORT_FALLBACK_PORT:-3434}/${sample_name}"
	else
		echo "Protected summary: missing"
	fi

	if [[ "$hash_state" != "configured" ]]; then
		echo
		echo "Health/evidence password hash is not configured. Run reset-auth with a known user/password."
		return 1
	fi

	if [[ -z "$sample_name" ]]; then
		echo
		echo "No protected clients.csv summary was found. Run add-user or export first."
		return 1
	fi

	if [[ -z "$auth_pass" ]]; then
		echo
		echo "To verify the password now:"
		echo "  sudo bash $0 check-subscription-auth --password '<password>'"
		return 0
	fi

	verify_subscription_auth "${HY2_EXPORT_USER:-}" "$auth_pass"
	echo
	echo "Health/evidence Basic Auth verified locally."
}

check_system_subscription_command() {
	local account record auth_token ignored_up ignored_down basic_user public_path filename artifact downloaded

	load_env
	account="$(system_subscription_account_name || true)"
	[[ -n "$account" ]] || die "System subscription account is not configured."
	record="$(user_record "$account")"
	[[ -n "$record" ]] || die "System subscription account is absent from Internal-issued users.csv."
	IFS=$'\t' read -r auth_token ignored_up ignored_down <<< "$record"
	[[ -n "$auth_token" ]] || die "System subscription account has no auth token."
	public_path="$(system_subscription_public_path)"
	[[ "${HY2_SYSTEM_SUBSCRIPTION_PATH:-}" == "$public_path" ]] \
		|| die "System subscription Caddy path does not match the Internal-issued account."
	[[ "${HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT:-$SYSTEM_SUBSCRIPTION_MIXED_PORT_DEFAULT}" == "$SYSTEM_SUBSCRIPTION_MIXED_PORT_DEFAULT" ]] \
		|| die "System subscription mixed port must remain ${SYSTEM_SUBSCRIPTION_MIXED_PORT_DEFAULT}."
	is_bcrypt_password_hash "${HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH:-}" \
		|| die "System subscription Basic Auth hash is missing or invalid."
	filename="${public_path#/}"
	artifact="$STACK_DIR/data/subscriptions/$filename"
	[[ -f "$artifact" ]] || die "System subscription YAML is not materialized: $filename"
	grep -Eq "^mixed-port:[[:space:]]*${SYSTEM_SUBSCRIPTION_MIXED_PORT_DEFAULT}[[:space:]]*$" "$artifact" \
		|| die "System subscription YAML does not advertise mixed-port ${SYSTEM_SUBSCRIPTION_MIXED_PORT_DEFAULT}."
	container_running "$SUBSCRIPTIONS_CONTAINER" || die "System subscription outlet is not running."
	basic_user="${HY2_SYSTEM_SUBSCRIPTION_BASIC_USER:-subscriptions}"
	wait_for_subscription_http_ready "$HY2_EXPORT_FALLBACK_PORT"
	downloaded="$(mktemp "$STACK_DIR/data/subscriptions/.system-subscription-check.XXXXXX")"
	if ! curl -fsS \
		--config <(printf 'user = "%s:%s"\n' "$basic_user" "$auth_token") \
		-o "$downloaded" \
		"http://127.0.0.1:${HY2_EXPORT_FALLBACK_PORT}${public_path}"; then
		rm -f "$downloaded"
		die "System subscription exact-path Basic Auth verification failed."
	fi
	if ! cmp -s "$artifact" "$downloaded"; then
		rm -f "$downloaded"
		die "System subscription outlet returned content that differs from the managed YAML."
	fi
	rm -f "$downloaded"
	echo "System subscription exact path, Basic Auth, and mixed-port ${SYSTEM_SUBSCRIPTION_MIXED_PORT_DEFAULT}: passed"
}

list_users_command() {
	if [[ ! -f "$USERS_FILE" ]]; then
		echo "Users file not found."
		return 0
	fi

	awk -F, 'NR > 1 && $1 != "" { printf "%s\tup=%s\tdown=%s\n", $1, $3, $4 }' "$USERS_FILE"
}

setup_command() {
	local host port_spec sub_port auth_user auth_pass initial_users_csv peer_dns
	local routing_mode tls_sni stack_subnet stack_gateway tz initial_down initial_up
	local server_down server_up hash users_default hop_interval masq_url obfs_password default_auth_user
	local -a initial_names=()
	local name

	ensure_stack_dirs
	ensure_env_file
	ensure_users_file
	load_env

	users_default="${HY2_USERS:-$(default_users_from_old_wg_stack || true)}"
	users_default="${users_default:-user01,user02,user03}"

	host="$(prompt_default "Hysteria public host/IP" "${HY2_SERVER_HOST:-$(old_wg_env_value WG_SERVER_HOST || echo 203.0.113.10)}")"
	port_spec="$(prompt_default "Hysteria UDP port" "$(default_hy2_server_ports_value)")"
	sub_port="$(prompt_default "Health/evidence TCP port" "${HY2_EXPORT_FALLBACK_PORT:-$(old_wg_env_value WG_EXPORT_FALLBACK_PORT || echo 3434)}")"
	initial_users_csv="$(prompt_default "Initial users (comma-separated)" "$users_default")"
	mapfile -t initial_names < <(parse_names_csv "$initial_users_csv")
	[[ "${#initial_names[@]}" -gt 0 ]] || die "Please provide at least one valid initial user."

	default_auth_user=""
	if [[ -n "${HY2_EXPORT_USER:-}" && "${HY2_EXPORT_USER:-}" != "download" ]]; then
		default_auth_user="$HY2_EXPORT_USER"
	fi
	[[ -n "$default_auth_user" ]] || default_auth_user="$(old_wg_env_value WG_EXPORT_USER || true)"
	[[ -n "$default_auth_user" ]] || default_auth_user="${initial_names[0]}"
	auth_user="$(prompt_default "Health/evidence username" "$default_auth_user")"
	auth_pass="$(prompt_password "Health/evidence password")"
	peer_dns="$(prompt_default "Peer DNS servers" "$(default_hy2_peer_dns_value)")"
	routing_mode="$(normalize_routing_mode_value "$(prompt_default "Routing policy (cn-direct/global)" "${HY2_MIHOMO_ROUTING_MODE:-cn-direct}")")"
	tls_sni="$(normalize_optional_value "$(prompt_default "TLS server name / SNI ('-' to disable)" "$(default_tls_sni_for_host "$host" "${HY2_TLS_SERVER_NAME:-}")")")"
	hop_interval="$(prompt_default "Port hop interval seconds" "$(default_hy2_hop_interval_value "$port_spec")")"
	server_down="$(prompt_default "Server-side per-client download cap" "$(default_hy2_server_download_rate_value)")"
	server_up="$(prompt_default "Server-side per-client upload cap" "${HY2_SERVER_BANDWIDTH_UP:-$(default_hy2_upload_rate)}")"
	initial_down="$(prompt_default "Default per-user download hint" "$(default_hy2_user_download_rate_value "${server_down:-$(default_hy2_download_rate)}")")"
	initial_up="$(prompt_default "Default per-user upload hint" "${HY2_DEFAULT_UP:-${server_up:-$(default_hy2_upload_rate)}}")"
	masq_url="$(normalize_optional_value "$(prompt_default "Masquerade URL ('-' to disable)" "${HY2_MASQUERADE_URL:-https://news.ycombinator.com/}")")"
	obfs_password="$(normalize_optional_value "$(prompt_default "Salamander obfs password ('-' to disable)" "${HY2_OBFS_PASSWORD:-}")")"
	stack_subnet="$(prompt_default "Docker stack subnet" "${HY2_STACK_SUBNET:-10.254.0.0/24}")"
	stack_gateway="$(prompt_default "Docker stack gateway" "${HY2_STACK_GATEWAY:-10.254.0.1}")"

	tz="${TZ:-$(cat /etc/timezone 2>/dev/null || echo Asia/Shanghai)}"
	hash="$(hash_password "$auth_pass")"

	set_env_value TZ "$tz"
	set_env_value HY2_SERVER_HOST "$host"
	set_env_value HY2_SERVER_PORTS "$port_spec"
	set_env_value HY2_HOP_INTERVAL_SECONDS "$hop_interval"
	set_env_value HY2_STACK_SUBNET "$stack_subnet"
	set_env_value HY2_STACK_GATEWAY "$stack_gateway"
	set_env_value HY2_PEER_DNS "$peer_dns"
	set_env_value HY2_MIHOMO_ROUTING_MODE "$routing_mode"
	set_env_value HY2_INTERNAL_SUBSCRIPTION_STORE "${HY2_INTERNAL_SUBSCRIPTION_STORE:-config-center}"
	set_env_value HY2_RESERVED_INTERNAL_CIDRS "${HY2_RESERVED_INTERNAL_CIDRS:-10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16}"
	set_env_value HY2_DOMESTIC_GATEWAY_IP "${HY2_DOMESTIC_GATEWAY_IP:-10.88.0.1}"
	set_env_value HY2_TLS_SERVER_NAME "$tls_sni"
	set_env_value HY2_TLS_SELF_SIGNED_DAYS "${HY2_TLS_SELF_SIGNED_DAYS:-3650}"
	set_env_value HY2_TLS_SKIP_CERT_VERIFY "true"
	set_env_value HY2_SERVER_BANDWIDTH_DOWN "$server_down"
	set_env_value HY2_SERVER_BANDWIDTH_UP "$server_up"
	set_env_value HY2_DEFAULT_DOWN "$initial_down"
	set_env_value HY2_DEFAULT_UP "$initial_up"
	set_env_value HY2_MASQUERADE_URL "$masq_url"
	set_env_value HY2_OBFS_PASSWORD "$obfs_password"
	set_env_value HY2_EXPORT_SITE_ADDRESS ":8080"
	set_env_value HY2_EXPORT_BASE_URL "http://${host}:${sub_port}"
	set_env_value HY2_EXPORT_FALLBACK_PORT "$sub_port"
	set_env_value HY2_EXPORT_USER "$auth_user"
	set_env_value HY2_EXPORT_PASSWORD_HASH "$hash"

	echo "$USER_HEADER" > "$USERS_FILE"
	for name in "${initial_names[@]}"; do
		upsert_user_record "$name" "$(random_token)" "$initial_up" "$initial_down"
	done
	sync_env_user_list_from_file

	load_env
	generate_self_signed_cert "${HY2_SERVER_HOST}" "${HY2_TLS_SERVER_NAME}"
	load_env
	render_runtime_files
	start_target all
	verify_subscription_auth "$auth_user" "$auth_pass"

	echo
	echo "Setup complete."
	echo "Hysteria2 access endpoint: ${host}:${port_spec}/udp"
	echo "Internal subscription authority: ${HY2_INTERNAL_MIHOMO_BASE_URL:-unset}"
	echo "Health/evidence outlet: http://${host}:${sub_port}/clients.csv"
	echo "Health/evidence auth user: ${auth_user}"
}

reconfigure_command() {
	local host port_spec sub_port auth_user rotate_auth auth_pass peer_dns routing_mode
	local tls_sni hop_interval masq_url obfs_password stack_subnet stack_gateway
	local server_down server_up down_default up_default hash

	load_env

	host="$(prompt_default "Hysteria public host/IP" "${HY2_SERVER_HOST:-}")"
	port_spec="$(prompt_default "Hysteria UDP port" "$(default_hy2_server_ports_value)")"
	sub_port="$(prompt_default "Health/evidence TCP port" "${HY2_EXPORT_FALLBACK_PORT:-3434}")"
	auth_user="$(prompt_default "Health/evidence username" "${HY2_EXPORT_USER:-download}")"
	rotate_auth="$(prompt_yes_no "Rotate health/evidence password?" "no")"
	if [[ "$rotate_auth" == "y" || "$rotate_auth" == "yes" ]]; then
		auth_pass="$(prompt_password "New health/evidence password")"
		hash="$(hash_password "$auth_pass")"
		set_env_value HY2_EXPORT_PASSWORD_HASH "$hash"
	fi
	peer_dns="$(prompt_default "Peer DNS servers" "$(default_hy2_peer_dns_value)")"
	routing_mode="$(normalize_routing_mode_value "$(prompt_default "Routing policy (cn-direct/global)" "${HY2_MIHOMO_ROUTING_MODE:-cn-direct}")")"
	tls_sni="$(normalize_optional_value "$(prompt_default "TLS server name / SNI ('-' to disable)" "$(default_tls_sni_for_host "$host" "${HY2_TLS_SERVER_NAME:-}")")")"
	hop_interval="$(prompt_default "Port hop interval seconds" "$(default_hy2_hop_interval_value "$port_spec")")"
	server_down="$(prompt_default "Server-side per-client download cap" "$(default_hy2_server_download_rate_value)")"
	server_up="$(prompt_default "Server-side per-client upload cap" "${HY2_SERVER_BANDWIDTH_UP:-$(default_hy2_upload_rate)}")"
	down_default="$(prompt_default "Default per-user download hint" "$(default_hy2_user_download_rate_value "${server_down:-$(default_hy2_download_rate)}")")"
	up_default="$(prompt_default "Default per-user upload hint" "${HY2_DEFAULT_UP:-${server_up:-$(default_hy2_upload_rate)}}")"
	masq_url="$(normalize_optional_value "$(prompt_default "Masquerade URL ('-' to disable)" "${HY2_MASQUERADE_URL:-https://news.ycombinator.com/}")")"
	obfs_password="$(normalize_optional_value "$(prompt_default "Salamander obfs password ('-' to disable)" "${HY2_OBFS_PASSWORD:-}")")"
	stack_subnet="$(prompt_default "Docker stack subnet" "${HY2_STACK_SUBNET:-10.254.0.0/24}")"
	stack_gateway="$(prompt_default "Docker stack gateway" "${HY2_STACK_GATEWAY:-10.254.0.1}")"

	set_env_value HY2_SERVER_HOST "$host"
	set_env_value HY2_SERVER_PORTS "$port_spec"
	set_env_value HY2_HOP_INTERVAL_SECONDS "$hop_interval"
	set_env_value HY2_STACK_SUBNET "$stack_subnet"
	set_env_value HY2_STACK_GATEWAY "$stack_gateway"
	set_env_value HY2_PEER_DNS "$peer_dns"
	set_env_value HY2_MIHOMO_ROUTING_MODE "$routing_mode"
	set_env_value HY2_INTERNAL_SUBSCRIPTION_STORE "${HY2_INTERNAL_SUBSCRIPTION_STORE:-config-center}"
	set_env_value HY2_RESERVED_INTERNAL_CIDRS "${HY2_RESERVED_INTERNAL_CIDRS:-10.88.0.0/16,10.89.0.0/16,10.90.0.0/16,10.91.0.0/16}"
	set_env_value HY2_DOMESTIC_GATEWAY_IP "${HY2_DOMESTIC_GATEWAY_IP:-10.88.0.1}"
	set_env_value HY2_TLS_SERVER_NAME "$tls_sni"
	set_env_value HY2_SERVER_BANDWIDTH_DOWN "$server_down"
	set_env_value HY2_SERVER_BANDWIDTH_UP "$server_up"
	set_env_value HY2_DEFAULT_DOWN "$down_default"
	set_env_value HY2_DEFAULT_UP "$up_default"
	set_env_value HY2_MASQUERADE_URL "$masq_url"
	set_env_value HY2_OBFS_PASSWORD "$obfs_password"
	set_env_value HY2_EXPORT_SITE_ADDRESS ":8080"
	set_env_value HY2_EXPORT_BASE_URL "http://${host}:${sub_port}"
	set_env_value HY2_EXPORT_FALLBACK_PORT "$sub_port"
	set_env_value HY2_EXPORT_USER "$auth_user"

	load_env
	generate_self_signed_cert "${HY2_SERVER_HOST}" "${HY2_TLS_SERVER_NAME}"
	load_env
	render_runtime_files
	recreate_full_stack

	echo "Reconfigured stack and recreated health/evidence outlet + hysteria."
}

reset_auth_command() {
	local auth_user="${1:-}"
	local auth_pass="${2:-}"
	local hash sample_yaml sample_name

	load_env

	if [[ -z "$auth_user" ]]; then
		auth_user="$(prompt_default "Health/evidence username" "${HY2_EXPORT_USER:-download}")"
	fi
	if [[ -z "$auth_pass" ]]; then
		auth_pass="$(prompt_password "New health/evidence password")"
	fi

	hash="$(hash_password "$auth_pass")"
	set_env_value HY2_EXPORT_USER "$auth_user"
	set_env_value HY2_EXPORT_PASSWORD_HASH "$hash"
	load_env

	safe_recreate_service subscriptions
	wait_for_container "$SUBSCRIPTIONS_CONTAINER"
	verify_subscription_auth "$HY2_EXPORT_USER" "$auth_pass"
	sample_yaml="$(first_subscription_yaml || true)"
	sample_name="$(basename "$sample_yaml")"
	echo "Health/evidence auth reset succeeded."
	echo "Verified locally with: http://${HY2_EXPORT_USER}:<password>@127.0.0.1:${HY2_EXPORT_FALLBACK_PORT}/${sample_name}"
}

add_user_command() {
	local names_csv="${1:-}"
	local down_value="${DOWN_CEIL:-${DOWN_RATE:-}}"
	local up_value="${UP_CEIL:-${UP_RATE:-}}"
	local auth_token_override="${AUTH_TOKEN:-}"
	local -a additions=()
	local name existing_record auth_token current_auth current_up current_down

	load_env
	ensure_users_file

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to add (comma-separated)" "")"
	fi

	mapfile -t additions < <(parse_names_csv "$names_csv")
	[[ "${#additions[@]}" -gt 0 ]] || die "No valid user names provided."
	if [[ -n "$auth_token_override" && "${#additions[@]}" -ne 1 ]]; then
		die "--auth-token can only be used with one user name."
	fi

	for name in "${additions[@]}"; do
		existing_record="$(user_record "$name" || true)"
		if [[ -n "$existing_record" ]]; then
			IFS=$'\t' read -r current_auth current_up current_down <<< "$existing_record"
			if [[ -z "$auth_token_override" && -z "$down_value" && -z "$up_value" ]]; then
				echo "User already exists, skipping: $name"
				continue
			fi
			auth_token="${auth_token_override:-$current_auth}"
			upsert_user_record "$name" "$auth_token" "${up_value:-${current_up:-${HY2_DEFAULT_UP:-$(default_hy2_upload_rate)}}}" "${down_value:-${current_down:-${HY2_DEFAULT_DOWN:-$(default_hy2_download_rate)}}}"
			echo "User updated: $name"
			continue
		fi
		auth_token="${auth_token_override:-$(random_token)}"
		upsert_user_record "$name" "$auth_token" "${up_value:-${HY2_DEFAULT_UP:-$(default_hy2_upload_rate)}}" "${down_value:-${HY2_DEFAULT_DOWN:-$(default_hy2_download_rate)}}"
		echo "User added: $name"
	done

	sync_env_user_list_from_file
	ensure_hysteria_runtime_users_current
	refresh_subscriptions
	echo "Upserted users: $(array_join_csv "${additions[@]}")"
}

del_user_command() {
	local names_csv="${1:-}"
	local -a removals=()
	local name

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to delete (comma-separated)" "")"
	fi

	mapfile -t removals < <(parse_names_csv "$names_csv")
	[[ "${#removals[@]}" -gt 0 ]] || die "No valid user names provided."

	for name in "${removals[@]}"; do
		remove_user_record "$name"
		delete_user_artifacts "$name"
	done

	sync_env_user_list_from_file
	ensure_hysteria_runtime_users_current
	refresh_subscriptions
	echo "Deleted users: $(array_join_csv "${removals[@]}")"
}

set_limit_command() {
	local names_csv="${1:-}"
	local down_value="${DOWN_CEIL:-${DOWN_RATE:-}}"
	local up_value="${UP_CEIL:-${UP_RATE:-}}"
	local -a names=()
	local name record auth_token current_up current_down

	load_env

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to update (comma-separated)" "")"
	fi
	mapfile -t names < <(parse_names_csv "$names_csv")
	[[ "${#names[@]}" -gt 0 ]] || die "No valid user names provided."

	for name in "${names[@]}"; do
		record="$(user_record "$name" || true)"
		[[ -n "$record" ]] || die "User not found: $name"
		IFS=$'\t' read -r auth_token current_up current_down <<< "$record"
		upsert_user_record "$name" "$auth_token" "${up_value:-$current_up}" "${down_value:-$current_down}"
	done

	ensure_hysteria_runtime_users_current
	refresh_subscriptions
	echo "Updated Hysteria2 advertised up/down values for: $(array_join_csv "${names[@]}")"
}

clear_limit_command() {
	local names_csv="${1:-}"
	local -a names=()
	local name record auth_token current_up current_down

	load_env

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to reset up/down values for (comma-separated)" "")"
	fi
	mapfile -t names < <(parse_names_csv "$names_csv")
	[[ "${#names[@]}" -gt 0 ]] || die "No valid user names provided."

	for name in "${names[@]}"; do
		record="$(user_record "$name" || true)"
		[[ -n "$record" ]] || die "User not found: $name"
		IFS=$'\t' read -r auth_token current_up current_down <<< "$record"
		upsert_user_record "$name" "$auth_token" "${HY2_DEFAULT_UP:-$(default_hy2_upload_rate)}" "${HY2_DEFAULT_DOWN:-$(default_hy2_download_rate)}"
	done

	ensure_hysteria_runtime_users_current
	refresh_subscriptions
	echo "Reset users to stack default up/down values: $(array_join_csv "${names[@]}")"
}

restart_command() {
	local target="${1:-all}"
	start_target "$target"
	echo "Restarted $target"
}

start_command() {
	local target="${1:-all}"
	start_target "$target"
	echo "Started $target"
}

stop_command() {
	local target="${1:-all}"
	stop_target "$target"
	echo "Stopped $target"
}

reapply_limits_command() {
	refresh_subscriptions
	echo "Refreshed health/evidence summary using current Hysteria2 up/down values."
}

export_command() {
	refresh_subscriptions
	echo "Refreshed health/evidence summary at $STACK_DIR/data/subscriptions/clients.csv"
}

reconcile_from_json_command() {
	local state_file=""
	local mode="hysteria2-only"
	local tmp_users tmp_env old_host old_routing old_signature new_signature parser

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--state-file) state_file="$2"; shift 2 ;;
			--mode) mode="$2"; shift 2 ;;
			*) die "Unknown reconcile-from-json option: $1" ;;
		esac
	done
	[[ -n "$state_file" ]] || die "--state-file is required."
	[[ -f "$state_file" ]] || die "State file not found: $state_file"
	case "$mode" in
		hysteria2-only|compat-subscription-export) ;;
		*) die "Unsupported reconcile mode: $mode" ;;
	esac

	load_env
	old_host="${HY2_SERVER_HOST:-}"
	old_routing="${HY2_MIHOMO_ROUTING_MODE:-cn-direct}"
	old_signature="$(internal_managed_runtime_signature)"
	parser="$(ensure_json_parser)"
	tmp_users="$(mktemp)"
	tmp_env="$(mktemp)"

	reconcile_tunnel_state_files "$parser" "$state_file" "$tmp_users" "$tmp_env"
	apply_internal_managed_defaults

	# shellcheck disable=SC1090
	source "$tmp_env"
	rm -f "$tmp_env"

	if [[ -n "${TUNNEL_NODE_PUBLIC_HOST:-}" ]]; then
		set_env_value HY2_SERVER_HOST "$TUNNEL_NODE_PUBLIC_HOST"
		if [[ "${HY2_TLS_SERVER_NAME:-}" == "$old_host" || -z "${HY2_TLS_SERVER_NAME:-}" ]]; then
			set_env_value HY2_TLS_SERVER_NAME "$TUNNEL_NODE_PUBLIC_HOST"
		fi
	fi
	if [[ -n "${TUNNEL_NODE_SERVER_PORTS:-}" ]]; then
		set_env_value HY2_SERVER_PORTS "$TUNNEL_NODE_SERVER_PORTS"
	fi
	if [[ -n "${TUNNEL_ROUTING_MODE:-}" ]]; then
		set_env_value HY2_MIHOMO_ROUTING_MODE "$TUNNEL_ROUTING_MODE"
	fi
	if [[ "${TUNNEL_SUBSCRIPTION_SOURCE:-}" == "internal" ]]; then
		set_env_value HY2_INTERNAL_SUBSCRIPTION_STORE "config-center"
	fi
	if [[ -n "${TUNNEL_RESERVED_INTERNAL_CIDRS:-}" ]]; then
		set_env_value HY2_RESERVED_INTERNAL_CIDRS "$TUNNEL_RESERVED_INTERNAL_CIDRS"
	fi
	if [[ -n "${TUNNEL_DOMESTIC_GATEWAY_IP:-}" ]]; then
		set_env_value HY2_DOMESTIC_GATEWAY_IP "$TUNNEL_DOMESTIC_GATEWAY_IP"
	fi

	mv "$tmp_users" "$USERS_FILE"
	chmod 600 "$USERS_FILE"
	sync_env_user_list_from_file

	load_env
	new_signature="$(internal_managed_runtime_signature)"
	render_runtime_files

	if ! container_running "$HYSTERIA_CONTAINER" || ! container_running "$SUBSCRIPTIONS_CONTAINER"; then
		start_target all
	elif [[ "$old_signature" != "$new_signature" ]]; then
		recreate_full_stack
	elif ! hysteria_published_port_matches_env; then
		ensure_hysteria_published_port
	elif ! hysteria_runtime_users_file_matches; then
		ensure_hysteria_runtime_users_current
	else
		refresh_subscriptions
	fi
	ensure_system_subscription_caddy_current

	echo "Tunnel reconcile applied: revision=${TUNNEL_REVISION:-unknown}, mode=${mode}, users=${TUNNEL_ACCOUNT_COUNT:-0}, host=${HY2_SERVER_HOST:-unset}, ports=${HY2_SERVER_PORTS:-unset}, routing=${HY2_MIHOMO_ROUTING_MODE:-cn-direct}, subscriptionSource=${TUNNEL_SUBSCRIPTION_SOURCE:-internal}"
	if [[ "$old_host" != "${HY2_SERVER_HOST:-}" || "$old_routing" != "${HY2_MIHOMO_ROUTING_MODE:-}" ]]; then
		echo "Updated stack env from D control-plane state."
	fi
}

main() {
	local command="${1:-help}"
	shift || true

	if [[ "$command" == "help" || "$command" == "-h" || "$command" == "--help" ]]; then
		usage
		return 0
	fi

	require_root
	detect_compose
	ensure_stack_dirs
	ensure_env_file
	ensure_users_file

	case "$command" in
		setup)
			setup_command "$@"
		;;
		reconfigure)
			reconfigure_command "$@"
		;;
		reset-auth)
			local auth_user=""
			local auth_pass=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--user) auth_user="$2"; shift 2 ;;
					--password) auth_pass="$2"; shift 2 ;;
					*) die "Unknown reset-auth option: $1" ;;
				esac
			done
			reset_auth_command "$auth_user" "$auth_pass"
		;;
		start)
			start_command "${1:-all}"
		;;
		stop)
			stop_command "${1:-all}"
		;;
		restart)
			restart_command "${1:-all}"
		;;
		destroy)
			local wipe_data="false"
			local wipe_env="false"
			local force_yes="false"
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--wipe-data) wipe_data="true"; shift ;;
					--wipe-env) wipe_env="true"; shift ;;
					--yes|-y) force_yes="true"; shift ;;
					*) die "Unknown destroy option: $1" ;;
				esac
			done
			destroy_stack_command "$wipe_data" "$wipe_env" "$force_yes"
		;;
		reinstall)
			destroy_stack_command "true" "true" "true"
			setup_command
		;;
		status)
			status_command
		;;
		docker-status)
			docker_status_command "$@"
		;;
		sync-internal-defaults)
			sync_internal_defaults_command
		;;
		check-subscription-auth|subscription-auth)
			local auth_pass=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--password) auth_pass="$2"; shift 2 ;;
					*) die "Unknown check-subscription-auth option: $1" ;;
				esac
			done
			check_subscription_auth_command "$auth_pass"
		;;
		check-system-subscription)
			check_system_subscription_command
		;;
		list-users)
			list_users_command
		;;
		add-user)
			local names_csv=""
			local auth_token=""
			local down_rate=""
			local down_ceil=""
			local up_rate=""
			local up_ceil=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--names) names_csv="$2"; shift 2 ;;
					--auth|--auth-token) auth_token="$2"; shift 2 ;;
					--down-rate) down_rate="$2"; shift 2 ;;
					--down-ceil) down_ceil="$2"; shift 2 ;;
					--up-rate) up_rate="$2"; shift 2 ;;
					--up-ceil) up_ceil="$2"; shift 2 ;;
					*) die "Unknown add-user option: $1" ;;
				esac
			done
			AUTH_TOKEN="$auth_token" DOWN_RATE="$down_rate" DOWN_CEIL="$down_ceil" UP_RATE="$up_rate" UP_CEIL="$up_ceil" add_user_command "$names_csv"
		;;
		del-user)
			local names_csv=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--names) names_csv="$2"; shift 2 ;;
					*) die "Unknown del-user option: $1" ;;
				esac
			done
			del_user_command "$names_csv"
		;;
		set-limit)
			local names_csv=""
			local down_rate=""
			local down_ceil=""
			local up_rate=""
			local up_ceil=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--names) names_csv="$2"; shift 2 ;;
					--down-rate) down_rate="$2"; shift 2 ;;
					--down-ceil) down_ceil="$2"; shift 2 ;;
					--up-rate) up_rate="$2"; shift 2 ;;
					--up-ceil) up_ceil="$2"; shift 2 ;;
					*) die "Unknown set-limit option: $1" ;;
				esac
			done
			DOWN_RATE="$down_rate" DOWN_CEIL="$down_ceil" UP_RATE="$up_rate" UP_CEIL="$up_ceil" set_limit_command "$names_csv"
		;;
		clear-limit)
			local names_csv=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--names) names_csv="$2"; shift 2 ;;
					*) die "Unknown clear-limit option: $1" ;;
				esac
			done
			clear_limit_command "$names_csv"
		;;
		reapply-limits)
			reapply_limits_command
		;;
		export)
			export_command
		;;
		reconcile-from-json)
			reconcile_from_json_command "$@"
		;;
		*)
			die "Unknown command: $command"
		;;
	esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
	main "$@"
fi
