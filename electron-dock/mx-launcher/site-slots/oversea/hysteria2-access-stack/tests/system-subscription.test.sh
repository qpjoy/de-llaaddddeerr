#!/bin/bash

set -euo pipefail
export LC_ALL=C
export LANG=C

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
	echo "system-subscription.test: $*" >&2
	exit 1
}

assert_contains() {
	local file="$1"
	local expected="$2"
	grep -F -- "$expected" "$file" >/dev/null || fail "missing ${expected} in ${file}"
}

assert_not_contains() {
	local file="$1"
	local unexpected="$2"
	if grep -F -- "$unexpected" "$file" >/dev/null; then
		fail "unexpected ${unexpected} in ${file}"
	fi
}

cp "$SOURCE_DIR/manage.sh" "$TEST_ROOT/manage.sh"
cp "$SOURCE_DIR/.env.example" "$TEST_ROOT/.env.example"
cp "$SOURCE_DIR/Caddyfile" "$TEST_ROOT/Caddyfile"
cp "$SOURCE_DIR/docker-compose.yml" "$TEST_ROOT/docker-compose.yml"
cp -R "$SOURCE_DIR/scripts" "$TEST_ROOT/scripts"

(
	cd "$TEST_ROOT"
	# shellcheck disable=SC1091
	source ./manage.sh
	if ! type mapfile >/dev/null 2>&1; then
		# macOS still ships Bash 3.2; production Linux Bash provides mapfile.
		mapfile() {
			[[ "${1:-}" == "-t" ]] && shift
			local array_name="$1"
			local line escaped
			local -a values=()
			while IFS= read -r line; do
				printf -v escaped '%q' "$line"
				values+=("$escaped")
			done
			eval "$array_name=(${values[*]})"
		}
	fi
	EXPECTED_TLS_FINGERPRINT="D6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58"
	MISMATCH_TLS_FINGERPRINT="E6:55:9C:55:7C:BF:F7:F1:D1:EE:0C:65:18:8E:90:A1:50:66:1F:70:F8:71:1D:16:50:E9:D2:B2:48:DD:00:58"
	stable_env_dir="$TEST_ROOT/stable-state"
	stable_env_file="$stable_env_dir/.env"
	mkdir -p "$stable_env_dir"
	cp .env.example "$stable_env_file"
	ln -s "$stable_env_file" .env
	env_link_target="$(readlink .env)"
	assert_env_symlink_intact() {
		[[ -L "$ENV_FILE" ]] || fail "atomic env update replaced the stable .env symlink"
		[[ "$(readlink "$ENV_FILE")" == "$env_link_target" ]] \
			|| fail "atomic env update changed the stable .env symlink target"
	}
	assert_env_symlink_intact
	ensure_stack_dirs
	ensure_users_file

	set_env_value HY2_SERVER_HOST "198.51.100.8"
	assert_env_symlink_intact
	set_env_value HY2_SERVER_PORTS "52120"
	set_env_value HY2_TLS_FINGERPRINT "$EXPECTED_TLS_FINGERPRINT"
	set_env_value HY2_EXPORT_PASSWORD_HASH '$2a$14$Zkx.HbQOScCQ1YI8Iu7/fO1M/ieGJqmXiF6Vq95PVIYzGKqG7SNU.'
	set_env_value HY2_SYSTEM_SUBSCRIPTION_ACCOUNT "oversea-main-subscriptions"
	set_env_value HY2_SYSTEM_SUBSCRIPTION_BASIC_USER "subscriptions"
	set_env_value HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH '$2a$14$Zkx.HbQOScCQ1YI8Iu7/fO1M/ieGJqmXiF6Vq95PVIYzGKqG7SNU.'
	set_env_value HY2_SYSTEM_SUBSCRIPTION_AUTH_TOKEN_SHA256 ""
	set_env_value HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT "7788"
	cat > tunnel-state.json <<'JSON'
{
  "revision": "test-system-subscription-v1",
  "node": { "publicHost": "198.51.100.8", "serverPorts": "52120" },
  "policies": [{ "id": "cn-direct", "isDefault": true, "routingMode": "cn-direct" }],
  "accounts": [
    { "username": "oversea-main-internal", "authToken": "ordinary-token", "status": "active", "upRate": "30 Mbps", "downRate": "30 Mbps" },
    { "username": "oversea-main-subscriptions", "authToken": "token-'one", "status": "active", "systemSubscription": true, "upRate": "50 Mbps", "downRate": "50 Mbps" }
  ]
}
JSON

	# hash_password must pass only a root-only file path to Docker. The token may
	# be read from the bind mount, but it must never become a host argv/Config.Cmd
	# element, and both success and failure paths must remove the secret.
	HASH_SECURITY_SECRET="argv-leak-regression-token"
	hash_security_mount_record="$TEST_ROOT/hash-security-mount"
	inspect_hash_docker_call() {
		local previous=""
		local arg mount_spec="" mount_source="" file_mode=""
		local saw_network_none="false"
		local saw_read_only="false"
		local saw_root_user="false"
		local saw_entrypoint="false"
		local saw_image="false"
		local saw_fixed_command="false"
		for arg in "$@"; do
			[[ "$arg" != *"$HASH_SECURITY_SECRET"* ]] \
				|| fail "hash secret leaked into docker argv/Config.Cmd"
			[[ "$arg" != "--plaintext" ]] \
				|| fail "hash_password passed --plaintext as a host docker argv element"
			[[ "$arg" == "--read-only" ]] && saw_read_only="true"
			[[ "$arg" == "caddy:2-alpine" ]] && saw_image="true"
			[[ "$previous" == "--network" && "$arg" == "none" ]] && saw_network_none="true"
			[[ "$previous" == "--user" && "$arg" == "0:0" ]] && saw_root_user="true"
			[[ "$previous" == "--entrypoint" && "$arg" == "/bin/sh" ]] && saw_entrypoint="true"
			[[ "$arg" == *'caddy hash-password --algorithm bcrypt < /run/secrets/mx-hy2-password'* ]] && saw_fixed_command="true"
			if [[ "$previous" == "--mount" ]]; then
				mount_spec="$arg"
			fi
			previous="$arg"
		done
		[[ "$saw_network_none" == "true" && "$saw_read_only" == "true" ]] \
			|| fail "hash container was not network-isolated/read-only"
		[[ "$saw_root_user" == "true" && "$saw_entrypoint" == "true" && "$saw_image" == "true" ]] \
			|| fail "hash container invocation contract changed"
		[[ "$saw_fixed_command" == "true" ]] \
			|| fail "hash container did not read the mounted secret through its fixed command"
		[[ "$mount_spec" == type=bind,source=*,target=/run/secrets/mx-hy2-password,readonly ]] \
			|| fail "hash secret mount was not an exact read-only bind mount"
		mount_source="${mount_spec#type=bind,source=}"
		mount_source="${mount_source%%,target=*}"
		[[ -f "$mount_source" ]] || fail "hash secret file was absent during docker invocation"
		[[ "$(cat "$mount_source")" == "$HASH_SECURITY_SECRET" ]] \
			|| fail "hash container mount did not contain the requested secret"
		if [[ "$(tail -c 1 "$mount_source" | od -An -tx1 | tr -d '[:space:]')" != "0a" ]]; then
			echo "Error: EOF" >&2
			return 65
		fi
		file_mode="$(stat -f '%Lp' "$mount_source" 2>/dev/null || stat -c '%a' "$mount_source")"
		[[ "$file_mode" == "600" ]] || fail "hash secret mode is ${file_mode}, expected 600"
		printf "%s" "$mount_source" > "$hash_security_mount_record"
	}
	docker() {
		inspect_hash_docker_call "$@" || return $?
		printf "%s\n" '$2a$14$Zkx.HbQOScCQ1YI8Iu7/fO1M/ieGJqmXiF6Vq95PVIYzGKqG7SNU.'
	}
	security_hash="$(hash_password "$HASH_SECURITY_SECRET")"
	is_bcrypt_password_hash "$security_hash" || fail "secure hash path did not return bcrypt"
	hash_security_mounted_path="$(cat "$hash_security_mount_record")"
	[[ ! -e "$hash_security_mounted_path" && ! -d "$(dirname "$hash_security_mounted_path")" ]] \
		|| fail "hash secret survived a successful hash_password call"

	docker() {
		inspect_hash_docker_call "$@"
		return 37
	}
	if hash_password "$HASH_SECURITY_SECRET" >/dev/null; then
		fail "hash_password hid a Docker hashing failure"
	else
		hash_failure_status=$?
	fi
	[[ "$hash_failure_status" == "37" ]] || fail "hash_password returned ${hash_failure_status}, expected 37"
	hash_security_mounted_path="$(cat "$hash_security_mount_record")"
	[[ ! -e "$hash_security_mounted_path" && ! -d "$(dirname "$hash_security_mounted_path")" ]] \
		|| fail "hash secret survived a failed hash_password call"

	# Avoid Docker in this unit test while preserving the bcrypt contract.
	hash_calls_file="$TEST_ROOT/hash-calls"
	hash_password() {
		printf "x" >> "$hash_calls_file"
		printf "%s" '$2a$14$Zkx.HbQOScCQ1YI8Iu7/fO1M/ieGJqmXiF6Vq95PVIYzGKqG7SNU.'
	}
	compose() {
		if [[ "${1:-}" == "up" && "${3:-}" == "subscriptions" ]]; then
			load_env
			is_bcrypt_password_hash "$HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH" \
				|| fail "first Caddy compose start received an invalid/empty system bcrypt hash"
			[[ "$HY2_SYSTEM_SUBSCRIPTION_PATH" == "/peer_oversea-main-subscriptions.mihomo.yaml" ]] \
				|| fail "first Caddy compose start did not receive the exact managed path"
		fi
		return 0
	}
	docker() {
		return 0
	}
	container_running() {
		return 1
	}
	wait_for_container() {
		return 0
	}
	hysteria_published_port_matches_env() {
		return 0
	}
	ensure_cert_material() {
		return 0
	}

	reconcile_from_json_command --state-file tunnel-state.json
	load_env
	assert_env_symlink_intact
	[[ "$(read_env_value_from_file "$stable_env_file" HY2_TLS_FINGERPRINT)" == "$EXPECTED_TLS_FINGERPRINT" ]] \
		|| fail "atomic env update did not persist the TLS fingerprint in stable state"
	assert_contains data/hysteria/users.csv "oversea-main-subscriptions,token-'one,50 Mbps,50 Mbps"
	[[ "$(internal_defaults_drift_report)" == "passed" ]] \
		|| fail "50 Mbps system account was incorrectly reported as Internal defaults drift"

	managed="data/subscriptions/peer_oversea-main-subscriptions.mihomo.yaml"
	[[ -f "$managed" ]] || fail "managed YAML was not created"
	assert_contains "$managed" "mixed-port: 7788"
	assert_not_contains "$managed" "mixed-port: 7890"
	assert_contains "$managed" "password: 'token-''one'"
	assert_contains "$managed" "down: '50 Mbps'"
	assert_contains "$managed" "up: '50 Mbps'"
	assert_contains "$managed" "  - name: PROXY"
	assert_contains "$managed" "  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve"
	assert_contains "$managed" "  - GEOSITE,CN,DIRECT"
	assert_contains "$managed" "  - GEOIP,CN,DIRECT"
	assert_contains "$managed" "  - MATCH,PROXY"
	assert_not_contains "$managed" "listen: 127.0.0.1:1053"
	assert_contains "$managed" "fingerprint: '$EXPECTED_TLS_FINGERPRINT'"
	[[ "$HY2_SYSTEM_SUBSCRIPTION_PATH" == "/peer_oversea-main-subscriptions.mihomo.yaml" ]] \
		|| fail "Caddy path was not derived from the managed account"
	[[ "$HY2_SYSTEM_SUBSCRIPTION_AUTH_TOKEN_SHA256" != "disabled" && -n "$HY2_SYSTEM_SUBSCRIPTION_AUTH_TOKEN_SHA256" ]] \
		|| fail "derived credential digest was not recorded"
	[[ "$(wc -c < "$hash_calls_file" | tr -d ' ')" == "1" ]] \
		|| fail "empty credential digest did not force exactly one bcrypt derivation"
	set_env_value HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH ""
	load_env
	materialize_system_subscription
	load_env
	is_bcrypt_password_hash "$HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH" \
		|| fail "active system account with an empty hash was not repaired before publication"
	[[ "$(wc -c < "$hash_calls_file" | tr -d ' ')" == "2" ]] \
		|| fail "active system account with an empty hash did not force bcrypt derivation"
	mode="$(stat -f '%Lp' "$managed" 2>/dev/null || stat -c '%a' "$managed")"
	[[ "$mode" == "600" ]] || fail "managed YAML mode is ${mode}, expected 600"
	[[ -z "$(find data/subscriptions -maxdepth 1 -type f -name '.peer_*-subscriptions.mihomo.yaml.*' -print -quit)" ]] \
		|| fail "atomic render left a temporary file"
	container_running() {
		return 0
	}
	readiness_trace="$TEST_ROOT/system-subscription-readiness-trace"
	sleep_trace="$TEST_ROOT/system-subscription-sleep-trace"
	sleep() {
		printf "%s\n" "${1:-}" >> "$sleep_trace"
	}
	curl() {
		local output="" url="" ready_attempts
		while [[ $# -gt 0 ]]; do
			case "$1" in
				-o) output="$2"; shift 2 ;;
				http://*) url="$1"; shift ;;
				*) shift ;;
			esac
		done
		if [[ "$url" == "http://127.0.0.1:${HY2_EXPORT_FALLBACK_PORT}/healthz" ]]; then
			printf "healthz\n" >> "$readiness_trace"
			ready_attempts="$(grep -c '^healthz$' "$readiness_trace")"
			(( ready_attempts >= 3 ))
			return
		fi
		[[ "$url" == "http://127.0.0.1:${HY2_EXPORT_FALLBACK_PORT}${HY2_SYSTEM_SUBSCRIPTION_PATH}" ]] \
			|| fail "unexpected system subscription curl URL: $url"
		[[ "$(grep -c '^healthz$' "$readiness_trace")" == "3" ]] \
			|| fail "exact-path curl ran before subscription readiness"
		printf "exact-path\n" >> "$readiness_trace"
		[[ -n "$output" ]] || return 1
		cp "$managed" "$output"
	}
	certificate_fingerprint() {
		[[ "${1:-}" == "$CERT_CRT_PATH" ]] \
			|| fail "system subscription gate inspected an unexpected certificate path"
		printf "%s\n" "$EXPECTED_TLS_FINGERPRINT"
	}
	certificate_key_pair_matches() {
		[[ "${1:-}" == "$CERT_CRT_PATH" && "${2:-}" == "$CERT_KEY_PATH" ]] \
			|| fail "system subscription gate inspected an unexpected certificate/key path"
		return 0
	}
	hysteria_runtime_mounts_match() {
		return 0
	}
	subscriptions_runtime_mounts_match() {
		return 0
	}
	hysteria_runtime_certificate_fingerprint() {
		printf "%s\n" "$MISMATCH_TLS_FINGERPRINT"
	}
	hysteria_runtime_applied_certificate_fingerprint() {
		printf "%s\n" "$EXPECTED_TLS_FINGERPRINT"
	}
	if mismatch_output="$(check_system_subscription_command 2>&1)"; then
		fail "live Hysteria TLS identity mismatch did not block the system subscription gate"
	fi
	[[ "$mismatch_output" == *"stale release mount or TLS certificate"* ]] \
		|| fail "live Hysteria TLS identity mismatch returned an unexpected error"
	[[ ! -s "$readiness_trace" ]] \
		|| fail "system subscription HTTP curl ran before the live TLS mismatch gate"

	hysteria_runtime_certificate_fingerprint() {
		return 1
	}
	if unavailable_output="$(check_system_subscription_command 2>&1)"; then
		fail "unavailable live Hysteria TLS identity did not block the system subscription gate"
	fi
	[[ "$unavailable_output" == *"stale release mount or TLS certificate"* ]] \
		|| fail "unavailable live Hysteria TLS identity returned an unexpected error"
	[[ ! -s "$readiness_trace" ]] \
		|| fail "system subscription HTTP curl ran before the unavailable live TLS gate"

	hysteria_runtime_certificate_fingerprint() {
		printf "%s\n" "$EXPECTED_TLS_FINGERPRINT"
	}
	hysteria_runtime_applied_certificate_fingerprint() {
		printf "%s\n" "$MISMATCH_TLS_FINGERPRINT"
	}
	if applied_mismatch_output="$(check_system_subscription_command 2>&1)"; then
		fail "container-start TLS fingerprint mismatch did not block the system subscription gate"
	fi
	[[ "$applied_mismatch_output" == *"stale release mount or TLS certificate"* ]] \
		|| fail "container-start TLS fingerprint mismatch returned an unexpected error"
	[[ ! -s "$readiness_trace" ]] \
		|| fail "system subscription HTTP curl ran before the container-start TLS gate"

	hysteria_runtime_applied_certificate_fingerprint() {
		return 1
	}
	if applied_unavailable_output="$(check_system_subscription_command 2>&1)"; then
		fail "missing container-start TLS fingerprint did not block the system subscription gate"
	fi
	[[ "$applied_unavailable_output" == *"stale release mount or TLS certificate"* ]] \
		|| fail "missing container-start TLS fingerprint returned an unexpected error"
	[[ ! -s "$readiness_trace" ]] \
		|| fail "system subscription HTTP curl ran before the missing container-start TLS gate"

	hysteria_runtime_applied_certificate_fingerprint() {
		printf "%s\n" "$EXPECTED_TLS_FINGERPRINT"
	}
	check_system_subscription_command | grep -F "live Hysteria TLS identity: passed" >/dev/null \
		|| fail "exact-path system subscription verification did not pass"
	[[ "$(tr '\n' ' ' < "$readiness_trace")" == "healthz healthz healthz exact-path " ]] \
		|| fail "system subscription readiness/exact-path curl order changed"
	[[ "$(wc -l < "$sleep_trace" | tr -d ' ')" == "2" ]] \
		|| fail "readiness retry did not use the non-blocking sleep stub exactly twice"
	container_running() {
		return 1
	}

	printf "legacy\n" > data/subscriptions/peer_legacy.mihomo.yaml
	AUTH_TOKEN="later-token" DOWN_CEIL="30 Mbps" UP_CEIL="30 Mbps" \
		add_user_command "oversea-main-user-added-later"
	[[ "$(wc -c < "$hash_calls_file" | tr -d ' ')" == "2" ]] \
		|| fail "unchanged account token unnecessarily rotated its bcrypt hash"
	[[ -f "$managed" ]] || fail "refresh_subscriptions deleted the managed YAML"
	[[ ! -e data/subscriptions/peer_legacy.mihomo.yaml ]] || fail "refresh_subscriptions kept an unmanaged YAML"
	[[ -f data/subscriptions/clients.csv ]] || fail "clients.csv evidence summary was not preserved"
	assert_contains data/subscriptions/clients.csv "oversea-main-user-added-later,internal,config-center"
	count="$(find data/subscriptions -maxdepth 1 -type f -name 'peer_*-subscriptions.mihomo.yaml' | wc -l | tr -d ' ')"
	[[ "$count" == "1" ]] || fail "expected exactly one managed system YAML, found ${count}"

	set_env_value HY2_SYSTEM_SUBSCRIPTION_ACCOUNT ""
	set_env_value HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH ""
	set_env_value HY2_SYSTEM_SUBSCRIPTION_AUTH_TOKEN_SHA256 ""
	load_env
	materialize_system_subscription
	load_env
	[[ "$HY2_SYSTEM_SUBSCRIPTION_PATH" == "/__system-subscription-disabled__" ]] \
		|| fail "empty account did not select the disabled Caddy path"
	is_bcrypt_password_hash "$HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH" \
		|| fail "empty hash did not fall back to a parseable locked bcrypt hash"
	[[ ! -e "$managed" ]] || fail "disabled system account left its YAML behind"
	[[ -f data/subscriptions/clients.csv ]] || fail "disabling system subscription removed evidence summary"
)

(
	cd "$TEST_ROOT"
	# shellcheck disable=SC1091
	source ./manage.sh
	env_link_target="$(readlink "$ENV_FILE")"
	set_env_value HY2_TLS_FINGERPRINT "stale-before-cert-sync"
	ensure_cert_material
	first_fingerprint="$(certificate_fingerprint "$CERT_CRT_PATH")"
	[[ "$(read_env_value_from_file "$(env_storage_file)" HY2_TLS_FINGERPRINT)" == "$first_fingerprint" ]] \
		|| fail "disk certificate fingerprint did not replace stale env state"
	set_env_value HY2_TLS_FINGERPRINT "stale-after-cert-sync"
	ensure_cert_material
	[[ "$(certificate_fingerprint "$CERT_CRT_PATH")" == "$first_fingerprint" ]] \
		|| fail "fingerprint convergence unexpectedly rotated an existing certificate"
	[[ "$(read_env_value_from_file "$(env_storage_file)" HY2_TLS_FINGERPRINT)" == "$first_fingerprint" ]] \
		|| fail "existing disk certificate did not repair stale env fingerprint"
	openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$CERT_KEY_PATH" >/dev/null 2>&1
	if certificate_key_pair_matches "$CERT_CRT_PATH" "$CERT_KEY_PATH"; then
		fail "mismatched certificate/private-key fixture unexpectedly passed validation"
	fi
	ensure_cert_material
	certificate_key_pair_matches "$CERT_CRT_PATH" "$CERT_KEY_PATH" \
		|| fail "mismatched certificate/private-key state was not repaired"
	repaired_fingerprint="$(certificate_fingerprint "$CERT_CRT_PATH")"
	[[ "$repaired_fingerprint" != "$first_fingerprint" ]] \
		|| fail "mismatched certificate/private-key repair did not replace the certificate"
	[[ "$(read_env_value_from_file "$(env_storage_file)" HY2_TLS_FINGERPRINT)" == "$repaired_fingerprint" ]] \
		|| fail "certificate/private-key repair did not publish the replacement fingerprint"
	[[ -L "$ENV_FILE" && "$(readlink "$ENV_FILE")" == "$env_link_target" ]] \
		|| fail "certificate fingerprint convergence replaced the stable .env symlink"
)

(
	cd "$TEST_ROOT"
	# shellcheck disable=SC1091
	source ./manage.sh
	require_root() { return 0; }
	detect_compose() { return 0; }
	ensure_stack_dirs() { return 0; }
	ensure_env_file() { return 0; }
	ensure_users_file() { return 0; }
	docker_status_command() {
		[[ "$#" == "1" && "$1" == "--soft" ]] \
			|| fail "main did not pass docker-status options through"
	}
	main docker-status --soft
)

(
	cd "$TEST_ROOT"
	# shellcheck disable=SC1091
	source ./manage.sh
	recreate_trace="$TEST_ROOT/hysteria-runtime-recreate-trace"
	identity_checks=0
	container_running() { return 0; }
	hysteria_runtime_identity_matches() {
		identity_checks=$((identity_checks + 1))
		[[ "$identity_checks" -ge 2 ]]
	}
	render_runtime_files() { return 0; }
	safe_recreate_service() {
		[[ "${1:-}" == "hysteria" ]] || fail "runtime identity repair recreated an unexpected service"
		printf "hysteria\n" >> "$recreate_trace"
	}
	wait_for_container() {
		[[ "${1:-}" == "$HYSTERIA_CONTAINER" ]] || fail "runtime identity repair waited for an unexpected container"
	}
	ensure_hysteria_published_port() { return 0; }

	ensure_hysteria_runtime_identity_current
	[[ "$(wc -l < "$recreate_trace" | tr -d ' ')" == "1" ]] \
		|| fail "runtime identity drift did not recreate Hysteria exactly once"
	[[ "$identity_checks" == "2" ]] \
		|| fail "runtime identity was not verified before and after Hysteria recreate"
)

assert_contains "$SOURCE_DIR/Caddyfile" '@systemSubscription path {$HY2_SYSTEM_SUBSCRIPTION_PATH:/__system-subscription-disabled__}'
assert_not_contains "$SOURCE_DIR/Caddyfile" '@systemSubscription path /peer_*'
assert_contains "$SOURCE_DIR/Caddyfile" '{$HY2_SYSTEM_SUBSCRIPTION_BASIC_USER} {$HY2_SYSTEM_SUBSCRIPTION_PASSWORD_HASH}'
assert_contains "$SOURCE_DIR/docker-compose.yml" '${HY2_EXPORT_FALLBACK_PORT}:8080'
assert_contains "$SOURCE_DIR/docker-compose.yml" 'com.mx.hysteria2.tls-fingerprint: "${HY2_TLS_FINGERPRINT}"'
assert_contains "$SOURCE_DIR/docker-compose.yml" 'HY2_SYSTEM_SUBSCRIPTION_PATH: ${HY2_SYSTEM_SUBSCRIPTION_PATH:-/__system-subscription-disabled__}'
assert_contains "$SOURCE_DIR/.env.example" 'HY2_EXPORT_FALLBACK_PORT=3434'
assert_contains "$SOURCE_DIR/.env.example" 'HY2_SYSTEM_SUBSCRIPTION_MIXED_PORT=7788'
assert_contains "$SOURCE_DIR/manage.sh" 'chmod 600 "$secret_file"'
assert_contains "$SOURCE_DIR/manage.sh" 'trap cleanup_hash_password_secret EXIT'
assert_contains "$SOURCE_DIR/manage.sh" 'target=/run/secrets/mx-hy2-password,readonly'
assert_contains "$SOURCE_DIR/manage.sh" 'unset plaintext'
assert_contains "$SOURCE_DIR/manage.sh" 'exec caddy hash-password --algorithm bcrypt < /run/secrets/mx-hy2-password'
assert_contains "$SOURCE_DIR/manage.sh" 'docker_status_command "$@"'
assert_not_contains "$SOURCE_DIR/manage.sh" 'hash-password --plaintext'
if grep -Eq 'docker run[^#]*--plaintext' "$SOURCE_DIR/manage.sh"; then
	fail "hash_password regressed to passing plaintext through host docker argv"
fi
if docker compose version >/dev/null 2>&1; then
	compose_3435="$(
		cd "$SOURCE_DIR"
		HY2_EXPORT_FALLBACK_PORT=3435 docker compose --env-file .env.example config
	)"
	printf "%s\n" "$compose_3435" | grep -F 'published: "3435"' >/dev/null \
		|| fail "docker compose did not honor a configured 3435 export port"
fi

echo "system-subscription.test: passed"
