#!/bin/bash

set -euo pipefail

STACK_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$STACK_DIR/../.." && pwd)"
ENV_FILE="$STACK_DIR/.env"
ENV_EXAMPLE="$STACK_DIR/.env.example"
LIMITS_FILE="$STACK_DIR/peer-limits.csv"
LIMITS_ENV_FILE="$STACK_DIR/peer-limits.env"
WIREGUARD_CONTAINER="wg-mihomo-wireguard"
SUBSCRIPTIONS_CONTAINER="wg-mihomo-subscriptions"
COMPOSE_BIN=""
PEER_GEN_TIMEOUT_SECONDS="${PEER_GEN_TIMEOUT_SECONDS:-300}"

usage() {
	cat <<'EOF'
Usage:
  sudo bash ./docker/wg-mihomo-stack/manage.sh <command> [options]

Commands:
  setup             Initialize .env, start subscriptions + wireguard, export profiles
  reconfigure       Update ports/auth/bandwidth defaults, then recreate the stack safely
  reset-auth        Reset subscription username/password and recreate subscriptions only
  start             Start services: all|wireguard|subscriptions
  stop              Stop services: all|wireguard|subscriptions
  restart           Restart services: all|wireguard|subscriptions
  destroy           Stop/remove stack containers; optionally wipe generated data/env
  reinstall         Destroy generated stack state and immediately run setup again
  status            Show stack status, users, ports, and limits
  list-users        Show current configured users and their tunnel IPs
  add-user          Add one or more users, restart WG if needed, export profiles, reapply limits
  del-user          Delete one or more users and their generated profiles/configs
  set-limit         Set/update one or more users' rate limits, then reapply tc rules
  clear-limit       Remove one or more users' rate limits, then reapply tc rules
  reapply-limits    Reapply tc/ifb rules from peer-limits.csv
  export            Re-export Mihomo YAML subscriptions from current peer confs
  help              Show this help

Examples:
  sudo bash ./docker/wg-mihomo-stack/manage.sh setup
  sudo bash ./docker/wg-mihomo-stack/manage.sh reconfigure
  sudo bash ./docker/wg-mihomo-stack/manage.sh reset-auth
  sudo bash ./docker/wg-mihomo-stack/manage.sh destroy --wipe-data --wipe-env --yes
  sudo bash ./docker/wg-mihomo-stack/manage.sh reinstall
  sudo bash ./docker/wg-mihomo-stack/manage.sh add-user --names test01,test02
  sudo bash ./docker/wg-mihomo-stack/manage.sh set-limit --names test01 --down-ceil 9mbit --up-ceil 9mbit
  sudo bash ./docker/wg-mihomo-stack/manage.sh del-user --names test02,test03
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
		"$STACK_DIR/data/wireguard" \
		"$STACK_DIR/data/subscriptions" \
		"$STACK_DIR/data/caddy" \
		"$STACK_DIR/config/caddy"
	chmod 700 "$STACK_DIR/data/subscriptions"
}

ensure_env_file() {
	if [[ ! -f "$ENV_FILE" ]]; then
		cp "$ENV_EXAMPLE" "$ENV_FILE"
	fi
}

normalize_password_hash_quotes() {
	local raw_value normalized

	[[ -f "$ENV_FILE" ]] || return 0
	raw_value="$(awk -F= '/^WG_EXPORT_PASSWORD_HASH=/{sub(/^WG_EXPORT_PASSWORD_HASH=/, "", $0); print $0; exit}' "$ENV_FILE")"
	[[ -n "$raw_value" ]] || return 0

	normalized="$(echo "$raw_value" | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")"
	if [[ "$normalized" == \'*\' ]]; then
		return 0
	fi

	if [[ "$normalized" == \"*\" ]]; then
		normalized="${normalized#\"}"
		normalized="${normalized%\"}"
	fi

	set_env_value WG_EXPORT_PASSWORD_HASH "'$normalized'"
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

load_env() {
	ensure_env_file
	normalize_password_hash_quotes
	set -a
	# shellcheck disable=SC1090
	source "$ENV_FILE"
	set +a
}

save_limits_env() {
	cat > "$LIMITS_ENV_FILE" <<EOF
TC_TOTAL_RATE=${TC_TOTAL_RATE}
TC_INGRESS_TOTAL_RATE=${TC_INGRESS_TOTAL_RATE}
TC_BASE_RATE=${TC_BASE_RATE}
TC_DEFAULT_CEIL=${TC_DEFAULT_CEIL}
TC_INGRESS_DEFAULT_CEIL=${TC_INGRESS_DEFAULT_CEIL}
TC_DOCKER_CONTAINER=${WIREGUARD_CONTAINER}
TC_IFACE=${TC_IFACE}
TC_IFB_IFACE=${TC_IFB_IFACE}
TC_ENABLE_INGRESS=${TC_ENABLE_INGRESS}
EOF
}

ensure_limits_files() {
	if [[ ! -f "$LIMITS_FILE" ]]; then
		cat > "$LIMITS_FILE" <<'EOF'
# name,cidr,down_rate,down_ceil,up_rate,up_ceil
EOF
	fi

	if [[ ! -f "$LIMITS_ENV_FILE" ]]; then
		TC_TOTAL_RATE="9mbit"
		TC_INGRESS_TOTAL_RATE="9mbit"
		TC_BASE_RATE="1mbit"
		TC_DEFAULT_CEIL="9mbit"
		TC_INGRESS_DEFAULT_CEIL="9mbit"
		TC_IFACE="wg0"
		TC_IFB_IFACE="ifb-wg0"
		TC_ENABLE_INGRESS="true"
		save_limits_env
	fi
}

load_limits_env() {
	ensure_limits_files
	set -a
	# shellcheck disable=SC1090
	source "$LIMITS_ENV_FILE"
	set +a
}

reload_runtime_state() {
	load_env
	load_limits_env
}

set_env_value() {
	local key="$1"
	local value="$2"
	local tmp

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
		wireguard) echo "$WIREGUARD_CONTAINER" ;;
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

wait_for_interface_ready() {
	local iface="$1"
	local deadline=$((SECONDS + 60))

	while (( SECONDS < deadline )); do
		if [[ -n "${TC_DOCKER_CONTAINER:-}" ]]; then
			if docker exec "$TC_DOCKER_CONTAINER" ip link show dev "$iface" >/dev/null 2>&1; then
				return 0
			fi
		else
			if ip link show dev "$iface" >/dev/null 2>&1; then
				return 0
			fi
		fi
		sleep 1
	done

	return 1
}

find_peer_conf() {
	local name="$1"
	find "$STACK_DIR/data/wireguard" -type f -name '*.conf' \
		! -path '*/wg_confs/*' ! -path '*/templates/*' ! -path '*/server/*' \
		\( -path "*/peer_${name}/*" -o -name "${name}.conf" -o -name "peer_${name}.conf" \) \
		| sort | head -n 1
}

peer_ipv4() {
	local name="$1"
	local conf_path addresses addr
	local -a address_list

	conf_path="$(find_peer_conf "$name")"
	[[ -n "$conf_path" && -f "$conf_path" ]] || return 1

	addresses="$(awk '
		$0 == "[Interface]" { section = 1; next }
		/^\[/ { section = 0 }
		section == 1 && /^Address = / {
			sub("^Address = ", "", $0)
			print
			exit
		}
	' "$conf_path")"

	IFS=',' read -r -a address_list <<< "$addresses"
	for addr in "${address_list[@]}"; do
		addr="$(echo "$addr" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
		addr="${addr%%/*}"
		if [[ "$addr" == *.* ]]; then
			echo "$addr"
			return 0
		fi
	done

	return 1
}

current_users() {
	load_env
	csv_to_array "${WG_PEERS:-}"
}

write_summary_header() {
	mkdir -p "$STACK_DIR/data/subscriptions"
	chmod 700 "$STACK_DIR/data/subscriptions"
	echo "name,ipv4,source_conf,mihomo_yaml,subscription_url" > "$STACK_DIR/data/subscriptions/clients.csv"
}

first_subscription_yaml() {
	find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f -name '*.mihomo.yaml' | sort | head -n 1
}

refresh_subscriptions() {
	local conf_count

	find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f -name '*.mihomo.yaml' -delete 2>/dev/null || true
	write_summary_header

	conf_count="$(find "$STACK_DIR/data/wireguard" -type f -name '*.conf' ! -path '*/wg_confs/*' ! -path '*/templates/*' ! -path '*/server/*' | wc -l | tr -d ' ')"
	if [[ "$conf_count" == "0" ]]; then
		echo "No peer configs found, subscriptions summary reset."
		return 0
	fi

	(
		cd "$ROOT_DIR"
		bash ./scripts/export-wg-mihomo-stack.sh --stack-dir "$STACK_DIR"
	)
}

count_limit_rows() {
	awk -F, 'NF && $1 !~ /^[[:space:]]*#/ && $1 !~ /^[[:space:]]*$/ { count++ } END { print count + 0 }' "$LIMITS_FILE"
}

upsert_limit_row() {
	local name="$1"
	local cidr="$2"
	local down_rate="$3"
	local down_ceil="$4"
	local up_rate="$5"
	local up_ceil="$6"
	local tmp

	tmp="$(mktemp)"
	awk -F, -v name="$name" '
		BEGIN { OFS = "," }
		$1 ~ /^[[:space:]]*#/ || $1 ~ /^[[:space:]]*$/ { print; next }
		$1 == name { next }
		{ print }
	' "$LIMITS_FILE" > "$tmp"
	mv "$tmp" "$LIMITS_FILE"

	echo "$name,$cidr,$down_rate,$down_ceil,$up_rate,$up_ceil" >> "$LIMITS_FILE"
}

remove_limit_row() {
	local name="$1"
	local tmp

	tmp="$(mktemp)"
	awk -F, -v name="$name" '
		BEGIN { OFS = "," }
		$1 ~ /^[[:space:]]*#/ || $1 ~ /^[[:space:]]*$/ { print; next }
		$1 == name { next }
		{ print }
	' "$LIMITS_FILE" > "$tmp"
	mv "$tmp" "$LIMITS_FILE"
}

limit_row_values() {
	local name="$1"

	awk -F, -v name="$name" '
		$1 ~ /^[[:space:]]*#/ || $1 ~ /^[[:space:]]*$/ { next }
		$1 == name {
			for (i = 2; i <= 6; i++) {
				gsub(/^[[:space:]]+|[[:space:]]+$/, "", $i)
			}
			printf "%s\t%s\t%s\t%s\t%s\n", $2, $3, $4, $5, $6
			exit
		}
	' "$LIMITS_FILE"
}

apply_limits() {
	local row_count

	load_limits_env
	row_count="$(count_limit_rows)"
	if [[ "$row_count" == "0" ]]; then
		bash "$ROOT_DIR/scripts/wg-tc-limit.sh" clean --docker-container "$WIREGUARD_CONTAINER" --if "${TC_IFACE}" >/dev/null 2>&1 || true
		echo "No limit rows configured, cleared existing tc rules if present."
		return 0
	fi

	if ! wait_for_interface_ready "${TC_IFACE}"; then
		die "WireGuard interface ${TC_IFACE} did not become ready in time for tc shaping."
	fi

	local -a cmd=(
		bash "$ROOT_DIR/scripts/wg-tc-limit.sh" apply
		--docker-container "$WIREGUARD_CONTAINER"
		--if "${TC_IFACE}"
		--limits-file "$LIMITS_FILE"
		--total-rate "${TC_TOTAL_RATE}"
		--base-rate "${TC_BASE_RATE}"
		--default-ceil "${TC_DEFAULT_CEIL}"
	)

	if [[ "${TC_ENABLE_INGRESS}" == "true" ]]; then
		cmd+=(
			--ingress
			--ifb "${TC_IFB_IFACE}"
			--ingress-total-rate "${TC_INGRESS_TOTAL_RATE}"
			--ingress-base-rate "${TC_BASE_RATE}"
			--ingress-default-ceil "${TC_INGRESS_DEFAULT_CEIL}"
		)
	fi

	"${cmd[@]}"
}

default_limit_values() {
	DEFAULT_DOWN_RATE="${DEFAULT_DOWN_RATE:-$TC_BASE_RATE}"
	DEFAULT_DOWN_CEIL="${DEFAULT_DOWN_CEIL:-$TC_DEFAULT_CEIL}"
	DEFAULT_UP_RATE="${DEFAULT_UP_RATE:-$TC_BASE_RATE}"
	DEFAULT_UP_CEIL="${DEFAULT_UP_CEIL:-$TC_INGRESS_DEFAULT_CEIL}"
}

sync_limits_for_users() {
	local down_rate="$1"
	local down_ceil="$2"
	local up_rate="$3"
	local up_ceil="$4"
	shift 4
	local name ip cidr

	for name in "$@"; do
		ip="$(peer_ipv4 "$name" || true)"
		if [[ -z "$ip" ]]; then
			echo "Warning: could not resolve tunnel IP for $name, skipping limit row for now." >&2
			continue
		fi
		cidr="${ip}/32"
		upsert_limit_row "$name" "$cidr" "$down_rate" "$down_ceil" "$up_rate" "$up_ceil"
	done
}

refresh_limit_targets_for_current_users() {
	local name ip record old_cidr down_rate down_ceil up_rate up_ceil
	local -a names=()

	mapfile -t names < <(current_users)
	for name in "${names[@]}"; do
		record="$(limit_row_values "$name" || true)"
		[[ -n "$record" ]] || continue
		IFS=$'\t' read -r old_cidr down_rate down_ceil up_rate up_ceil <<< "$record"
		ip="$(peer_ipv4 "$name" || true)"
		if [[ -z "$ip" ]]; then
			echo "Warning: could not resolve updated tunnel IP for $name while refreshing limit targets." >&2
			continue
		fi
		upsert_limit_row "$name" "${ip}/32" "$down_rate" "$down_ceil" "$up_rate" "$up_ceil"
	done
}

delete_user_artifacts() {
	local name="$1"
	find "$STACK_DIR/data/wireguard" -maxdepth 2 -type d -name "peer_${name}" -exec rm -rf {} + 2>/dev/null || true
	find "$STACK_DIR/data/subscriptions" -maxdepth 1 -type f \( -name "${name}.mihomo.yaml" -o -name "peer_${name}.mihomo.yaml" \) -delete 2>/dev/null || true
}

wait_for_peer_confs() {
	local deadline=$((SECONDS + PEER_GEN_TIMEOUT_SECONDS))
	local all_ready name
	local -a missing=()

	while (( SECONDS < deadline )); do
		all_ready="true"
		missing=()
		for name in "$@"; do
			if [[ -z "$(find_peer_conf "$name")" ]]; then
				all_ready="false"
				missing+=("$name")
			fi
		done
		[[ "$all_ready" == "true" ]] && return 0
		sleep 1
	done

	echo "Timed out waiting for peer config generation after ${PEER_GEN_TIMEOUT_SECONDS}s." >&2
	if [[ "${#missing[@]}" -gt 0 ]]; then
		echo "Still missing peer configs for: $(array_join_csv "${missing[@]}")" >&2
	fi
	echo "Current generated peer files:" >&2
	find "$STACK_DIR/data/wireguard" -type f -name '*.conf' ! -path '*/wg_confs/*' ! -path '*/templates/*' ! -path '*/server/*' | sort >&2 || true
	echo "Recent wireguard container logs:" >&2
	docker logs --tail=80 "$WIREGUARD_CONTAINER" >&2 || true
	die "Timed out waiting for peer config generation."
}

wait_for_all_current_peers() {
	local -a names=()

	mapfile -t names < <(current_users)
	if [[ "${#names[@]}" -gt 0 ]]; then
		wait_for_peer_confs "${names[@]}"
	fi
}

stop_target() {
	local target="${1:-all}"

	case "$target" in
		all)
			compose stop subscriptions >/dev/null 2>&1 || true
			compose stop wireguard >/dev/null 2>&1 || true
		;;
		wireguard|subscriptions)
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
	backup_file="$backup_dir/wg-mihomo-stack-$stamp.tar.gz"

	tar -czf "$backup_file" \
		-C "$STACK_DIR" \
		--ignore-failed-read \
		.env \
		peer-limits.csv \
		peer-limits.env \
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
	docker rm -f "$WIREGUARD_CONTAINER" >/dev/null 2>&1 || true
	docker rm -f "$SUBSCRIPTIONS_CONTAINER" >/dev/null 2>&1 || true

	if [[ "$wipe_data" == "true" ]]; then
		rm -rf \
			"$STACK_DIR/data/wireguard" \
			"$STACK_DIR/data/subscriptions" \
			"$STACK_DIR/data/caddy" \
			"$STACK_DIR/config/caddy"
	fi

	if [[ "$wipe_env" == "true" ]]; then
		rm -f "$ENV_FILE" "$LIMITS_FILE" "$LIMITS_ENV_FILE"
	fi

	ensure_stack_dirs
	ensure_limits_files
	[[ "$wipe_env" == "true" ]] && ensure_env_file

	echo "Stack containers removed."
	if [[ "$wipe_data" == "true" ]]; then
		echo "Generated data wiped."
	fi
	if [[ "$wipe_env" == "true" ]]; then
		echo "Environment and limit files reset from defaults."
	fi
}

start_target() {
	local target="${1:-all}"

	case "$target" in
		all)
			safe_recreate_service subscriptions
			wait_for_container "$SUBSCRIPTIONS_CONTAINER"
			safe_recreate_service wireguard
			wait_for_container "$WIREGUARD_CONTAINER"
			wait_for_all_current_peers
			refresh_subscriptions
			apply_limits
		;;
		wireguard)
			safe_recreate_service wireguard
			wait_for_container "$WIREGUARD_CONTAINER"
			wait_for_all_current_peers
			refresh_subscriptions
			apply_limits
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
	docker rm -f "$WIREGUARD_CONTAINER" >/dev/null 2>&1 || true
	docker rm -f "$SUBSCRIPTIONS_CONTAINER" >/dev/null 2>&1 || true
	start_target all
}

status_command() {
	load_env
	load_limits_env

	echo "Stack directory: $STACK_DIR"
	echo "WG server host: ${WG_SERVER_HOST:-unset}"
	echo "WG server port: ${WG_SERVER_PORT:-unset}"
	echo "Subscription URL: ${WG_EXPORT_BASE_URL:-unset}"
	echo "Subscription listen port: ${WG_EXPORT_FALLBACK_PORT:-unset}"
	echo "Current users: ${WG_PEERS:-<none>}"
	echo
	compose ps
	echo
	bash "$ROOT_DIR/scripts/check-vpn-stack.sh" --stack-dir "$STACK_DIR" --env-file "$ENV_FILE" || true
	echo
	echo "Limit profile:"
	cat "$LIMITS_ENV_FILE"
	echo
	echo "Limit rows:"
	cat "$LIMITS_FILE"
}

list_users_command() {
	local name ip

	load_env
	echo "Configured users:"
	while IFS= read -r name; do
		[[ -n "$name" ]] || continue
		ip="$(peer_ipv4 "$name" || true)"
		if [[ -n "$ip" ]]; then
			echo "  - $name ($ip)"
		else
			echo "  - $name (ip pending)"
		fi
	done < <(current_users)
}

setup_command() {
	local host wg_port sub_port auth_user auth_pass initial_users_csv peer_dns
	local routing_mode wg_subnet stack_subnet stack_gateway tz puid pgid
	local total_rate ingress_total_rate base_rate down_ceil up_ceil hash
	local primary_user
	local -a initial_names=()

	ensure_stack_dirs
	ensure_env_file
	load_env
	load_limits_env

	host="$(prompt_default "WireGuard public host/IP" "${WG_SERVER_HOST:-}")"
	wg_port="$(prompt_default "WireGuard UDP port" "${WG_SERVER_PORT:-52080}")"
	sub_port="$(prompt_default "Subscription TCP port" "${WG_EXPORT_FALLBACK_PORT:-3434}")"
	auth_user="$(prompt_default "Subscription username" "${WG_EXPORT_USER:-download}")"
	auth_pass="$(prompt_password "Subscription password")"
	initial_users_csv="$(prompt_default "Initial users (comma-separated)" "${WG_PEERS:-test01}")"
	peer_dns="$(prompt_default "Peer DNS servers" "${WG_PEER_DNS:-1.1.1.1,8.8.8.8}")"
	routing_mode="$(normalize_routing_mode_value "$(prompt_default "Mihomo routing mode (cn-direct/global)" "${WG_MIHOMO_ROUTING_MODE:-cn-direct}")")"
	wg_subnet="$(prompt_default "WireGuard client subnet" "${WG_INTERNAL_SUBNET:-10.13.13.0}")"
	stack_subnet="$(prompt_default "Docker stack subnet" "${WG_STACK_SUBNET:-10.253.0.0/24}")"
	stack_gateway="$(prompt_default "Docker stack gateway" "${WG_STACK_GATEWAY:-10.253.0.1}")"
	total_rate="$(prompt_default "Server max download cap" "${TC_TOTAL_RATE:-9mbit}")"
	ingress_total_rate="$(prompt_default "Server max upload cap" "${TC_INGRESS_TOTAL_RATE:-9mbit}")"
	base_rate="$(prompt_default "Per-user guaranteed rate" "${TC_BASE_RATE:-1mbit}")"
	down_ceil="$(prompt_default "Default per-user download ceiling" "${TC_DEFAULT_CEIL:-9mbit}")"
	up_ceil="$(prompt_default "Default per-user upload ceiling" "${TC_INGRESS_DEFAULT_CEIL:-9mbit}")"
	mapfile -t initial_names < <(parse_names_csv "$initial_users_csv")
	[[ "${#initial_names[@]}" -gt 0 ]] || die "Please provide at least one valid initial user."
	primary_user="${initial_names[0]}"

	tz="${TZ:-$(cat /etc/timezone 2>/dev/null || echo Asia/Shanghai)}"
	puid="${PUID:-$(id -u)}"
	pgid="${PGID:-$(id -g)}"

	hash="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$auth_pass" | tr -d '\r\n')"

	set_env_value PUID "$puid"
	set_env_value PGID "$pgid"
	set_env_value TZ "$tz"
	set_env_value WG_SERVER_HOST "$host"
	set_env_value WG_SERVER_PORT "$wg_port"
	set_env_value WG_STACK_SUBNET "$stack_subnet"
	set_env_value WG_STACK_GATEWAY "$stack_gateway"
	set_env_value WG_PEERS "$primary_user"
	set_env_value WG_PEER_DNS "$peer_dns"
	set_env_value WG_MIHOMO_ROUTING_MODE "$routing_mode"
	set_env_value WG_INTERNAL_SUBNET "$wg_subnet"
	set_env_value WG_ALLOWEDIPS "0.0.0.0/0"
	set_env_value WG_KEEPALIVE_PEERS "all"
	set_env_value WG_LOG_CONFS "false"
	set_env_value WG_EXPORT_SITE_ADDRESS ":8080"
	set_env_value WG_EXPORT_BASE_URL "http://${host}:${sub_port}"
	set_env_value WG_EXPORT_FALLBACK_PORT "$sub_port"
	set_env_value WG_EXPORT_USER "$auth_user"
	set_env_value WG_EXPORT_PASSWORD_HASH "'$hash'"

	TC_TOTAL_RATE="$total_rate"
	TC_INGRESS_TOTAL_RATE="$ingress_total_rate"
	TC_BASE_RATE="$base_rate"
	TC_DEFAULT_CEIL="$down_ceil"
	TC_INGRESS_DEFAULT_CEIL="$up_ceil"
	TC_IFACE="wg0"
	TC_IFB_IFACE="ifb-wg0"
	TC_ENABLE_INGRESS="true"
	save_limits_env
	cat > "$LIMITS_FILE" <<'EOF'
# name,cidr,down_rate,down_ceil,up_rate,up_ceil
EOF
	reload_runtime_state

	echo "Bootstrapping stack with first user: $primary_user"
	start_target all

	sync_limits_for_users "$TC_BASE_RATE" "$TC_DEFAULT_CEIL" "$TC_BASE_RATE" "$TC_INGRESS_DEFAULT_CEIL" "$primary_user"
	apply_limits

	if (( ${#initial_names[@]} > 1 )); then
		echo "Adding remaining users one by one: $(array_join_csv "${initial_names[@]:1}")"
		local remaining_user
		for remaining_user in "${initial_names[@]:1}"; do
			DOWN_RATE="$TC_BASE_RATE" \
			DOWN_CEIL="$TC_DEFAULT_CEIL" \
			UP_RATE="$TC_BASE_RATE" \
			UP_CEIL="$TC_INGRESS_DEFAULT_CEIL" \
			add_user_command "$remaining_user"
		done
	fi

	echo
	echo "Setup complete."
	echo "Subscriptions: http://${host}:${sub_port}/<user>.mihomo.yaml"
}

reconfigure_command() {
	local host wg_port sub_port auth_user rotate_auth auth_pass peer_dns routing_mode
	local wg_subnet stack_subnet stack_gateway total_rate ingress_total_rate
	local base_rate down_ceil up_ceil hash

	load_env
	load_limits_env

	host="$(prompt_default "WireGuard public host/IP" "${WG_SERVER_HOST:-}")"
	wg_port="$(prompt_default "WireGuard UDP port" "${WG_SERVER_PORT:-52080}")"
	sub_port="$(prompt_default "Subscription TCP port" "${WG_EXPORT_FALLBACK_PORT:-3434}")"
	auth_user="$(prompt_default "Subscription username" "${WG_EXPORT_USER:-download}")"
	rotate_auth="$(prompt_yes_no "Rotate subscription password?" "no")"
	if [[ "$rotate_auth" == "y" || "$rotate_auth" == "yes" ]]; then
		auth_pass="$(prompt_password "New subscription password")"
		hash="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$auth_pass" | tr -d '\r\n')"
		set_env_value WG_EXPORT_PASSWORD_HASH "'$hash'"
	fi
	peer_dns="$(prompt_default "Peer DNS servers" "${WG_PEER_DNS:-1.1.1.1,8.8.8.8}")"
	routing_mode="$(normalize_routing_mode_value "$(prompt_default "Mihomo routing mode (cn-direct/global)" "${WG_MIHOMO_ROUTING_MODE:-cn-direct}")")"
	wg_subnet="$(prompt_default "WireGuard client subnet" "${WG_INTERNAL_SUBNET:-10.13.13.0}")"
	stack_subnet="$(prompt_default "Docker stack subnet" "${WG_STACK_SUBNET:-10.253.0.0/24}")"
	stack_gateway="$(prompt_default "Docker stack gateway" "${WG_STACK_GATEWAY:-10.253.0.1}")"
	total_rate="$(prompt_default "Server max download cap" "${TC_TOTAL_RATE:-9mbit}")"
	ingress_total_rate="$(prompt_default "Server max upload cap" "${TC_INGRESS_TOTAL_RATE:-9mbit}")"
	base_rate="$(prompt_default "Per-user guaranteed rate" "${TC_BASE_RATE:-1mbit}")"
	down_ceil="$(prompt_default "Default per-user download ceiling" "${TC_DEFAULT_CEIL:-9mbit}")"
	up_ceil="$(prompt_default "Default per-user upload ceiling" "${TC_INGRESS_DEFAULT_CEIL:-9mbit}")"

	set_env_value WG_SERVER_HOST "$host"
	set_env_value WG_SERVER_PORT "$wg_port"
	set_env_value WG_STACK_SUBNET "$stack_subnet"
	set_env_value WG_STACK_GATEWAY "$stack_gateway"
	set_env_value WG_PEER_DNS "$peer_dns"
	set_env_value WG_MIHOMO_ROUTING_MODE "$routing_mode"
	set_env_value WG_INTERNAL_SUBNET "$wg_subnet"
	set_env_value WG_EXPORT_SITE_ADDRESS ":8080"
	set_env_value WG_EXPORT_BASE_URL "http://${host}:${sub_port}"
	set_env_value WG_EXPORT_FALLBACK_PORT "$sub_port"
	set_env_value WG_EXPORT_USER "$auth_user"

	TC_TOTAL_RATE="$total_rate"
	TC_INGRESS_TOTAL_RATE="$ingress_total_rate"
	TC_BASE_RATE="$base_rate"
	TC_DEFAULT_CEIL="$down_ceil"
	TC_INGRESS_DEFAULT_CEIL="$up_ceil"
	TC_IFACE="wg0"
	TC_IFB_IFACE="ifb-wg0"
	TC_ENABLE_INGRESS="true"
	save_limits_env
	reload_runtime_state

	recreate_full_stack
	refresh_limit_targets_for_current_users
	apply_limits

	echo "Reconfigured stack and recreated subscriptions + wireguard."
}

reset_auth_command() {
	local auth_user="${1:-}"
	local auth_pass="${2:-}"
	local hash sample_yaml sample_name

	load_env

	if [[ -z "$auth_user" ]]; then
		auth_user="$(prompt_default "Subscription username" "${WG_EXPORT_USER:-download}")"
	fi
	if [[ -z "$auth_pass" ]]; then
		auth_pass="$(prompt_password "New subscription password")"
	fi

	hash="$(docker run --rm caddy:2-alpine caddy hash-password --plaintext "$auth_pass" | tr -d '\r\n')"
	set_env_value WG_EXPORT_USER "$auth_user"
	set_env_value WG_EXPORT_PASSWORD_HASH "'$hash'"
	load_env

	safe_recreate_service subscriptions
	wait_for_container "$SUBSCRIPTIONS_CONTAINER"

	sample_yaml="$(first_subscription_yaml || true)"
	if [[ -n "$sample_yaml" && -f "$sample_yaml" ]] && command -v curl >/dev/null 2>&1; then
		sample_name="$(basename "$sample_yaml")"
		if curl -fsS -u "${WG_EXPORT_USER}:${auth_pass}" "http://127.0.0.1:${WG_EXPORT_FALLBACK_PORT}/${sample_name}" >/dev/null; then
			echo "Subscription auth reset succeeded."
			echo "Verified locally with: http://${WG_EXPORT_USER}:<password>@127.0.0.1:${WG_EXPORT_FALLBACK_PORT}/${sample_name}"
			return 0
		fi
		die "Subscription auth was updated, but local verification still failed for ${sample_name}."
	fi

	echo "Subscription auth reset succeeded. No local Mihomo YAML file was available for verification."
}

add_user_command() {
	local names_csv="${1:-}"
	local skip_limit="${SKIP_LIMIT:-false}"
	local down_rate="${DOWN_RATE:-}"
	local down_ceil="${DOWN_CEIL:-}"
	local up_rate="${UP_RATE:-}"
	local up_ceil="${UP_CEIL:-}"
	local -a current=() additions=() updated=()
	local name exists

	load_env
	load_limits_env
	default_limit_values

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to add (comma-separated)" "")"
	fi

	mapfile -t additions < <(parse_names_csv "$names_csv")
	[[ "${#additions[@]}" -gt 0 ]] || die "No valid user names provided."
	mapfile -t current < <(current_users)

	for name in "${additions[@]}"; do
		exists="false"
		for current_name in "${current[@]}"; do
			if [[ "$current_name" == "$name" ]]; then
				exists="true"
				break
			fi
		done
		if [[ "$exists" == "false" ]]; then
			current+=("$name")
			updated+=("$name")
		else
			echo "User already exists, skipping: $name"
		fi
	done

	[[ "${#updated[@]}" -gt 0 ]] || {
		echo "No new users were added."
		return 0
	}

	set_env_value WG_PEERS "$(array_join_csv "${current[@]}")"
	load_env
	start_target wireguard
	refresh_subscriptions

	if [[ "$skip_limit" != "true" ]]; then
		sync_limits_for_users "${down_rate:-$DEFAULT_DOWN_RATE}" "${down_ceil:-$DEFAULT_DOWN_CEIL}" "${up_rate:-$DEFAULT_UP_RATE}" "${up_ceil:-$DEFAULT_UP_CEIL}" "${updated[@]}"
		apply_limits
	fi

	echo "Added users: $(array_join_csv "${updated[@]}")"
}

del_user_command() {
	local names_csv="${1:-}"
	local -a current=() removals=() kept=()
	local name remove

	load_env
	load_limits_env

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to delete (comma-separated)" "")"
	fi

	mapfile -t removals < <(parse_names_csv "$names_csv")
	[[ "${#removals[@]}" -gt 0 ]] || die "No valid user names provided."
	mapfile -t current < <(current_users)

	for name in "${current[@]}"; do
		remove="false"
		for removed_name in "${removals[@]}"; do
			if [[ "$removed_name" == "$name" ]]; then
				remove="true"
				break
			fi
		done
		if [[ "$remove" == "false" ]]; then
			kept+=("$name")
		fi
	done

	set_env_value WG_PEERS "$(array_join_csv "${kept[@]}")"
	for name in "${removals[@]}"; do
		remove_limit_row "$name"
		delete_user_artifacts "$name"
	done

	reload_runtime_state
	start_target wireguard
	refresh_subscriptions
	apply_limits

	echo "Deleted users: $(array_join_csv "${removals[@]}")"
}

set_limit_command() {
	local names_csv="${1:-}"
	local down_rate="${DOWN_RATE:-}"
	local down_ceil="${DOWN_CEIL:-}"
	local up_rate="${UP_RATE:-}"
	local up_ceil="${UP_CEIL:-}"
	local -a names=()
	local name ip

	load_limits_env
	default_limit_values

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to limit (comma-separated)" "")"
	fi
	mapfile -t names < <(parse_names_csv "$names_csv")
	[[ "${#names[@]}" -gt 0 ]] || die "No valid user names provided."

	for name in "${names[@]}"; do
		ip="$(peer_ipv4 "$name" || true)"
		[[ -n "$ip" ]] || die "Could not resolve tunnel IP for $name. Make sure the user exists and WG has generated configs."
		upsert_limit_row "$name" "${ip}/32" "${down_rate:-$DEFAULT_DOWN_RATE}" "${down_ceil:-$DEFAULT_DOWN_CEIL}" "${up_rate:-$DEFAULT_UP_RATE}" "${up_ceil:-$DEFAULT_UP_CEIL}"
	done

	apply_limits
	echo "Updated limits for: $(array_join_csv "${names[@]}")"
}

clear_limit_command() {
	local names_csv="${1:-}"
	local -a names=()
	local name

	if [[ -z "$names_csv" ]]; then
		names_csv="$(prompt_default "Users to clear limits for (comma-separated)" "")"
	fi
	mapfile -t names < <(parse_names_csv "$names_csv")
	[[ "${#names[@]}" -gt 0 ]] || die "No valid user names provided."

	for name in "${names[@]}"; do
		remove_limit_row "$name"
	done

	apply_limits
	echo "Removed limits for: $(array_join_csv "${names[@]}")"
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
	apply_limits
}

export_command() {
	refresh_subscriptions
	echo "Exported subscriptions to $STACK_DIR/data/subscriptions"
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
	ensure_limits_files

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
		list-users)
			list_users_command
		;;
		add-user)
			local names_csv=""
			local skip_limit="false"
			local down_rate=""
			local down_ceil=""
			local up_rate=""
			local up_ceil=""
			while [[ $# -gt 0 ]]; do
				case "$1" in
					--names) names_csv="$2"; shift 2 ;;
					--skip-limit) skip_limit="true"; shift ;;
					--down-rate) down_rate="$2"; shift 2 ;;
					--down-ceil) down_ceil="$2"; shift 2 ;;
					--up-rate) up_rate="$2"; shift 2 ;;
					--up-ceil) up_ceil="$2"; shift 2 ;;
					*) die "Unknown add-user option: $1" ;;
				esac
			done
			SKIP_LIMIT="$skip_limit" DOWN_RATE="$down_rate" DOWN_CEIL="$down_ceil" UP_RATE="$up_rate" UP_CEIL="$up_ceil" add_user_command "$names_csv"
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
		*)
			die "Unknown command: $command"
		;;
	esac
}

main "$@"
