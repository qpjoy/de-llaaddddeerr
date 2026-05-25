#!/bin/bash

set -euo pipefail

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
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
HYSTERIA_CONTAINER="hy2-mihomo-hysteria"
SUBSCRIPTIONS_CONTAINER="hy2-mihomo-subscriptions"
OLD_WG_STACK_DIR="$ROOT_DIR/docker/wg-mihomo-stack"
OLD_WG_ENV_FILE="$OLD_WG_STACK_DIR/.env"
COMPOSE_BIN=""

usage() {
	cat <<'EOF'
Usage:
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh <command> [options]

Commands:
  setup             Initialize .env, users, certs, start subscriptions + hysteria, export profiles
  reconfigure       Update ports/auth/defaults, then recreate the stack safely
  reset-auth        Reset subscription username/password and recreate subscriptions only
  start             Start services: all|hysteria|subscriptions
  stop              Stop services: all|hysteria|subscriptions
  restart           Restart services: all|hysteria|subscriptions
  destroy           Stop/remove stack containers; optionally wipe generated data/env
  reinstall         Destroy generated stack state and immediately run setup again
  status            Show stack status, users, ports, and defaults
  check-subscription-auth
                    Show subscription Basic Auth state; optionally verify with --password
  list-users        Show current configured users and their advertised up/down values
  add-user          Add one or more users, export profiles, no restart needed
  del-user          Delete one or more users and their generated profiles
  set-limit         Set/update one or more users' Hysteria2 up/down values, then re-export
  clear-limit       Reset one or more users' Hysteria2 up/down values to stack defaults
  reapply-limits    Re-export subscriptions using current user defaults
  export            Re-export Mihomo YAML subscriptions from current user registry
  reconcile-from-json
                    Apply D tunnel control-plane state JSON to users/env, then refresh
  help              Show this help

Examples:
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh setup
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh reconfigure
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh reset-auth --user download --password pass
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh check-subscription-auth --password pass
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh add-user --names intelligent01,intelligent02
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh del-user --names intelligent02
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh set-limit --names intelligent01 --down-ceil "3 Mbps" --up-ceil "30 Mbps"
  sudo bash ./docker/hysteria2-mihomo-stack/manage.sh reconcile-from-json --state-file /tmp/tunnel-state.json
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

set_env_value() {
	local key="$1"
	local value="$2"
	local tmp escaped

	escaped="$(printf "%s" "$value" | sed "s/'/'\\\\''/g")"
	value="'$escaped'"

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
		cn-direct|global)
			echo "$value"
		;;
		"" )
			echo "cn-direct"
		;;
		*)
			die "Unsupported Mihomo routing mode: $value (expected: cn-direct or global)"
		;;
	esac
}

default_hy2_download_rate() {
	echo "3 Mbps"
}

default_hy2_upload_rate() {
	echo "30 Mbps"
}

load_env() {
	ensure_env_file
	normalize_password_hash_quotes
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
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

hash_password() {
	local plaintext="$1"
	docker run --rm caddy:2-alpine caddy hash-password --plaintext "$plaintext" | tr -d '\r\n'
}

random_token() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 16
	elif command -v hexdump >/dev/null 2>&1; then
		hexdump -vn 16 -e '/1 "%02x"' /dev/urandom
	else
		die "Neither openssl nor hexdump is available for token generation."
	fi
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
	ensure_cert_material
	render_auth_script
	render_server_config
}

current_users() {
	ensure_users_file
	awk -F, 'NR > 1 && $1 != "" { gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); print $1 }' "$USERS_FILE"
}

sync_env_user_list_from_file() {
	local -a names=()

	mapfile -t names < <(current_users)
	set_env_value HY2_USERS "$(array_join_csv "${names[@]}")"
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
	find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f \( -name "peer_${name}.mihomo.yaml" -o -name "${name}.mihomo.yaml" \) -delete 2>/dev/null || true
}

first_subscription_yaml() {
	find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f -name '*.mihomo.yaml' | sort | head -n 1
}

verify_subscription_auth() {
	local auth_user="$1"
	local auth_pass="$2"
	local sample_yaml sample_name deadline=$((SECONDS + 45))

	sample_yaml="$(first_subscription_yaml || true)"
	[[ -n "$sample_yaml" && -f "$sample_yaml" ]] || die "No Mihomo YAML file found for subscription auth verification."
	sample_name="$(basename "$sample_yaml")"

	wait_for_subscription_http_ready "$HY2_EXPORT_FALLBACK_PORT"

	while (( SECONDS < deadline )); do
		if curl -fsS -u "${auth_user}:${auth_pass}" "http://127.0.0.1:${HY2_EXPORT_FALLBACK_PORT}/${sample_name}" >/dev/null 2>&1; then
			return 0
		fi
		sleep 1
	done

	die "Subscription auth verification failed for ${sample_name}. Please re-run reset-auth with a known password."
}

subscription_auth_hash_state() {
	local hash="${HY2_EXPORT_PASSWORD_HASH:-}"

	if [[ -z "$hash" ]]; then
		echo "missing"
	elif [[ "$hash" == "REPLACE_WITH_CADDY_HASH" ]]; then
		echo "placeholder"
	else
		echo "configured"
	fi
}

refresh_subscriptions() {
	local user_count

	find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f -name '*.mihomo.yaml' -delete 2>/dev/null || true

	user_count="$(awk -F, 'NR > 1 && $1 != "" { count++ } END { print count + 0 }' "$USERS_FILE")"
	if [[ "$user_count" == "0" ]]; then
		echo "name,ipv4,source_conf,mihomo_yaml,subscription_url" > "$STACK_DIR/data/subscriptions/clients.csv"
		echo "No users found, subscriptions summary reset."
		return 0
	fi

	(
		cd "$ROOT_DIR"
		bash ./scripts/export-hysteria2-mihomo-stack.sh --stack-dir "$STACK_DIR"
	)
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
	backup_file="$backup_dir/hy2-mihomo-stack-$stamp.tar.gz"

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

start_target() {
	local target="${1:-all}"

	case "$target" in
		all)
			render_runtime_files
			safe_recreate_service subscriptions
			wait_for_container "$SUBSCRIPTIONS_CONTAINER"
			safe_recreate_service hysteria
			wait_for_container "$HYSTERIA_CONTAINER"
			refresh_subscriptions
		;;
		hysteria)
			render_runtime_files
			safe_recreate_service hysteria
			wait_for_container "$HYSTERIA_CONTAINER"
			refresh_subscriptions
		;;
		subscriptions)
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
	start_target all
}

status_command() {
	local line

	load_env
	echo "Stack directory: $STACK_DIR"
	echo "Hysteria server host: ${HY2_SERVER_HOST:-unset}"
	echo "Hysteria server ports: ${HY2_SERVER_PORTS:-unset}"
	echo "Subscription URL: ${HY2_EXPORT_BASE_URL:-unset}"
	echo "Subscription listen port: ${HY2_EXPORT_FALLBACK_PORT:-unset}"
	echo "Subscription auth user: ${HY2_EXPORT_USER:-unset}"
	echo "Subscription auth hash: $(subscription_auth_hash_state)"
	echo "Routing mode: ${HY2_MIHOMO_ROUTING_MODE:-unset}"
	echo "TLS server name: ${HY2_TLS_SERVER_NAME:-unset}"
	echo "TLS fingerprint: ${HY2_TLS_FINGERPRINT:-unset}"
	echo "Port hop interval: ${HY2_HOP_INTERVAL_SECONDS:-unset}s"
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

	echo "Subscription URL: ${HY2_EXPORT_BASE_URL:-unset}"
	echo "Subscription listen port: ${HY2_EXPORT_FALLBACK_PORT:-unset}"
	echo "Subscription auth user: ${HY2_EXPORT_USER:-unset}"
	echo "Subscription auth hash: $hash_state"
	if [[ -n "$sample_name" ]]; then
		echo "Sample profile: $sample_name"
		echo "Local test URL: http://${HY2_EXPORT_USER:-user}:<password>@127.0.0.1:${HY2_EXPORT_FALLBACK_PORT:-3434}/${sample_name}"
	else
		echo "Sample profile: missing"
	fi

	if [[ "$hash_state" != "configured" ]]; then
		echo
		echo "Subscription password hash is not configured. Run reset-auth with a known user/password."
		return 1
	fi

	if [[ -z "$sample_name" ]]; then
		echo
		echo "No exported Mihomo YAML profile was found. Run add-user or export first."
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
	echo "Subscription Basic Auth verified locally."
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
	port_spec="$(prompt_default "Hysteria UDP port or range" "${HY2_SERVER_PORTS:-52120-52159}")"
	sub_port="$(prompt_default "Subscription TCP port" "${HY2_EXPORT_FALLBACK_PORT:-$(old_wg_env_value WG_EXPORT_FALLBACK_PORT || echo 3434)}")"
	initial_users_csv="$(prompt_default "Initial users (comma-separated)" "$users_default")"
	mapfile -t initial_names < <(parse_names_csv "$initial_users_csv")
	[[ "${#initial_names[@]}" -gt 0 ]] || die "Please provide at least one valid initial user."

	default_auth_user=""
	if [[ -n "${HY2_EXPORT_USER:-}" && "${HY2_EXPORT_USER:-}" != "download" ]]; then
		default_auth_user="$HY2_EXPORT_USER"
	fi
	[[ -n "$default_auth_user" ]] || default_auth_user="$(old_wg_env_value WG_EXPORT_USER || true)"
	[[ -n "$default_auth_user" ]] || default_auth_user="${initial_names[0]}"
	auth_user="$(prompt_default "Subscription username" "$default_auth_user")"
	auth_pass="$(prompt_password "Subscription password")"
	peer_dns="$(prompt_default "Peer DNS servers" "${HY2_PEER_DNS:-1.1.1.1,8.8.8.8}")"
	routing_mode="$(normalize_routing_mode_value "$(prompt_default "Mihomo routing mode (cn-direct/global)" "${HY2_MIHOMO_ROUTING_MODE:-cn-direct}")")"
	tls_sni="$(normalize_optional_value "$(prompt_default "TLS server name / SNI ('-' to disable)" "$(default_tls_sni_for_host "$host" "${HY2_TLS_SERVER_NAME:-}")")")"
	hop_interval="$(prompt_default "Port hop interval seconds" "${HY2_HOP_INTERVAL_SECONDS:-30}")"
	server_down="$(prompt_default "Server-side per-client download cap" "${HY2_SERVER_BANDWIDTH_DOWN:-$(default_hy2_download_rate)}")"
	server_up="$(prompt_default "Server-side per-client upload cap" "${HY2_SERVER_BANDWIDTH_UP:-$(default_hy2_upload_rate)}")"
	initial_down="$(prompt_default "Default per-user download hint" "${HY2_DEFAULT_DOWN:-${server_down:-$(default_hy2_download_rate)}}")"
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
	echo "Subscriptions: http://${host}:${sub_port}/peer_<name>.mihomo.yaml"
	echo "Subscription auth user: ${auth_user}"
	echo "Example with auth: http://${auth_user}:<password>@${host}:${sub_port}/peer_${initial_names[0]}.mihomo.yaml"
}

reconfigure_command() {
	local host port_spec sub_port auth_user rotate_auth auth_pass peer_dns routing_mode
	local tls_sni hop_interval masq_url obfs_password stack_subnet stack_gateway
	local server_down server_up down_default up_default hash

	load_env

	host="$(prompt_default "Hysteria public host/IP" "${HY2_SERVER_HOST:-}")"
	port_spec="$(prompt_default "Hysteria UDP port or range" "${HY2_SERVER_PORTS:-52120-52159}")"
	sub_port="$(prompt_default "Subscription TCP port" "${HY2_EXPORT_FALLBACK_PORT:-3434}")"
	auth_user="$(prompt_default "Subscription username" "${HY2_EXPORT_USER:-download}")"
	rotate_auth="$(prompt_yes_no "Rotate subscription password?" "no")"
	if [[ "$rotate_auth" == "y" || "$rotate_auth" == "yes" ]]; then
		auth_pass="$(prompt_password "New subscription password")"
		hash="$(hash_password "$auth_pass")"
		set_env_value HY2_EXPORT_PASSWORD_HASH "$hash"
	fi
	peer_dns="$(prompt_default "Peer DNS servers" "${HY2_PEER_DNS:-1.1.1.1,8.8.8.8}")"
	routing_mode="$(normalize_routing_mode_value "$(prompt_default "Mihomo routing mode (cn-direct/global)" "${HY2_MIHOMO_ROUTING_MODE:-cn-direct}")")"
	tls_sni="$(normalize_optional_value "$(prompt_default "TLS server name / SNI ('-' to disable)" "$(default_tls_sni_for_host "$host" "${HY2_TLS_SERVER_NAME:-}")")")"
	hop_interval="$(prompt_default "Port hop interval seconds" "${HY2_HOP_INTERVAL_SECONDS:-30}")"
	server_down="$(prompt_default "Server-side per-client download cap" "${HY2_SERVER_BANDWIDTH_DOWN:-$(default_hy2_download_rate)}")"
	server_up="$(prompt_default "Server-side per-client upload cap" "${HY2_SERVER_BANDWIDTH_UP:-$(default_hy2_upload_rate)}")"
	down_default="$(prompt_default "Default per-user download hint" "${HY2_DEFAULT_DOWN:-${server_down:-$(default_hy2_download_rate)}}")"
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

	echo "Reconfigured stack and recreated subscriptions + hysteria."
}

reset_auth_command() {
	local auth_user="${1:-}"
	local auth_pass="${2:-}"
	local hash sample_yaml sample_name

	load_env

	if [[ -z "$auth_user" ]]; then
		auth_user="$(prompt_default "Subscription username" "${HY2_EXPORT_USER:-download}")"
	fi
	if [[ -z "$auth_pass" ]]; then
		auth_pass="$(prompt_password "New subscription password")"
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
	echo "Subscription auth reset succeeded."
	echo "Verified locally with: http://${HY2_EXPORT_USER}:<password>@127.0.0.1:${HY2_EXPORT_FALLBACK_PORT}/${sample_name}"
}

add_user_command() {
	local names_csv="${1:-}"
	local down_value="${DOWN_CEIL:-${DOWN_RATE:-}}"
	local up_value="${UP_CEIL:-${UP_RATE:-}}"
	local -a additions=()
	local name existing_record auth_token

	load_env
	ensure_users_file

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to add (comma-separated)" "")"
	fi

	mapfile -t additions < <(parse_names_csv "$names_csv")
	[[ "${#additions[@]}" -gt 0 ]] || die "No valid user names provided."

	for name in "${additions[@]}"; do
		existing_record="$(user_record "$name" || true)"
		if [[ -n "$existing_record" ]]; then
			echo "User already exists, skipping: $name"
			continue
		fi
		auth_token="$(random_token)"
		upsert_user_record "$name" "$auth_token" "${up_value:-${HY2_DEFAULT_UP:-$(default_hy2_upload_rate)}}" "${down_value:-${HY2_DEFAULT_DOWN:-$(default_hy2_download_rate)}}"
	done

	sync_env_user_list_from_file
	refresh_subscriptions
	echo "Added users: $(array_join_csv "${additions[@]}")"
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
	echo "Re-exported subscriptions using current Hysteria2 up/down values."
}

export_command() {
	refresh_subscriptions
	echo "Exported subscriptions to $STACK_DIR/data/subscriptions"
}

reconcile_from_json_command() {
	local state_file=""
	local tmp_users tmp_env old_ports old_host old_routing

	while [[ $# -gt 0 ]]; do
		case "$1" in
			--state-file) state_file="$2"; shift 2 ;;
			*) die "Unknown reconcile-from-json option: $1" ;;
		esac
	done
	[[ -n "$state_file" ]] || die "--state-file is required."
	[[ -f "$state_file" ]] || die "State file not found: $state_file"
	command -v node >/dev/null 2>&1 || die "node is required to parse tunnel state."

	load_env
	old_host="${HY2_SERVER_HOST:-}"
	old_ports="${HY2_SERVER_PORTS:-}"
	old_routing="${HY2_MIHOMO_ROUTING_MODE:-}"
	tmp_users="$(mktemp)"
	tmp_env="$(mktemp)"

	node "$STACK_DIR/scripts/reconcile-tunnel-state.mjs" \
		--state-file "$state_file" \
		--users-file "$tmp_users" \
		--output-env-file "$tmp_env"

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

	mv "$tmp_users" "$USERS_FILE"
	chmod 600 "$USERS_FILE"
	sync_env_user_list_from_file

	load_env
	render_runtime_files

	if ! container_running "$HYSTERIA_CONTAINER" || ! container_running "$SUBSCRIPTIONS_CONTAINER"; then
		start_target all
	elif [[ "$old_ports" != "${HY2_SERVER_PORTS:-}" ]]; then
		safe_recreate_service hysteria
		wait_for_container "$HYSTERIA_CONTAINER"
		refresh_subscriptions
	else
		refresh_subscriptions
	fi

	echo "Tunnel reconcile applied: revision=${TUNNEL_REVISION:-unknown}, users=${TUNNEL_ACCOUNT_COUNT:-0}, host=${HY2_SERVER_HOST:-unset}, ports=${HY2_SERVER_PORTS:-unset}, routing=${HY2_MIHOMO_ROUTING_MODE:-cn-direct}"
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
		list-users)
			list_users_command
		;;
		add-user)
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
					*) die "Unknown add-user option: $1" ;;
				esac
			done
			DOWN_RATE="$down_rate" DOWN_CEIL="$down_ceil" UP_RATE="$up_rate" UP_CEIL="$up_ceil" add_user_command "$names_csv"
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

main "$@"
