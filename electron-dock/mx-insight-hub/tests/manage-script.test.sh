#!/usr/bin/env bash
#
# Behavioural tests for scripts/manage.sh.
#
# Rewritten after PostgreSQL moved into the shared mx-common data plane: the
# previous suite exercised local PV binding, runtime-image preloading and pod
# security reconciliation, none of which the Hub owns any more. What it tests now
# is the deploy contract that remains: credentials must not drift silently,
# database provisioning must happen before the config that consumes it, and a
# failed deploy must leave nothing behind.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/manage.sh
source "${ROOT_DIR}/scripts/manage.sh"

assert_eq() {
  local expected="$1" actual="$2" label="$3"
  if [ "$expected" != "$actual" ]; then
    printf 'not ok - %s: expected %q, got %q\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'ok - %s\n' "$label"
}

# ---------------------------------------------------------------------------
# Image reference canonicalisation (used by the containerd import path)
# ---------------------------------------------------------------------------

assert_eq \
  docker.io/library/postgres:16-bookworm \
  "$(canonical_image_ref postgres:16-bookworm)" \
  "canonical Docker Hub library image"
assert_eq \
  docker.io/qpjoy/mx-insight-hub:release \
  "$(canonical_image_ref qpjoy/mx-insight-hub:release)" \
  "canonical Docker Hub organization image"
assert_eq \
  registry.example/mx-insight-hub:release \
  "$(canonical_image_ref registry.example/mx-insight-hub:release)" \
  "qualified registry image"

# ---------------------------------------------------------------------------
# Credential drift
# ---------------------------------------------------------------------------

# Rotating the API-key pepper invalidates every issued API key, so a changed
# value must stop the deploy before the Secret is overwritten. The database
# password is deliberately NOT checked here any more: mx-common owns it.
pepper_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-pepper-drift.XXXXXX")"
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  export MX_INSIGHT_API_KEY_PEPPER=current-api-key-pepper-1234567890
  old_encoded="$(encoded_secret_value "old-api-key-pepper-0987654321xx")"
  kubectl() {
    case "$*" in
      *"MX_INSIGHT_API_KEY_PEPPER"*) printf "%s" "$old_encoded" ;;
      *"get secret mx-insight-hub-secrets"*) printf "%s" secret/mx-insight-hub-secrets ;;
      *) return 1 ;;
    esac
  }
  validate_existing_runtime_secret
' _ "$ROOT_DIR" 2>"$pepper_error"; then
  printf 'not ok - API-key pepper drift was accepted\n' >&2
  exit 1
fi
grep -q 'automatic rotation is blocked' "$pepper_error"
if grep -qE 'current-api-key-pepper|old-api-key-pepper' "$pepper_error"; then
  printf 'not ok - drift error exposed a secret value\n' >&2
  exit 1
fi
rm -f -- "$pepper_error"
printf 'ok - API-key pepper drift fails before Secret overwrite\n'

bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  export MX_INSIGHT_API_KEY_PEPPER=current-api-key-pepper-1234567890
  pepper_encoded="$(encoded_secret_value "$MX_INSIGHT_API_KEY_PEPPER")"
  kubectl() {
    case "$*" in
      *"MX_INSIGHT_API_KEY_PEPPER"*) printf "%s" "$pepper_encoded" ;;
      *"get secret mx-insight-hub-secrets"*) printf "%s" secret/mx-insight-hub-secrets ;;
      *) return 1 ;;
    esac
  }
  validate_existing_runtime_secret
' _ "$ROOT_DIR"
printf 'ok - unchanged retained Secret remains deployable\n'

# A missing Secret is no longer fatal: the database credential it used to guard
# now lives in mx-common, which regenerates nothing on its own.
#
# The stub mirrors the real command: `get --ignore-not-found -o name` exits 0
# with empty output when the object is absent.
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() { return 0; }
  validate_existing_runtime_secret
' _ "$ROOT_DIR"
printf 'ok - absent Secret is provisioned rather than refused\n'

# API keys enter a fixed 30-day overlap window. The deploy must inspect the
# effective status and expiry rather than trusting the persisted raw status.
rotation_secret='mih_live_rotation_example_1234'
assert_eq \
  'reuse|11111111-1111-4111-8111-111111111111|valid|1970-02-01T00:00:00.000Z' \
  "$(api_key_rotation_decision \
    '{"data":[{"id":"11111111-1111-4111-8111-111111111111","prefix":"mih_live_rotation","lastFour":"1234","status":"active","effectiveStatus":"active","expiresAt":"1970-02-01T00:00:00.000Z"}]}' \
    "$rotation_secret" \
    0)" \
  'key beyond the 30-day window is reused'
assert_eq \
  'rotate|11111111-1111-4111-8111-111111111111|rotation_window|1970-01-31T00:00:00.000Z' \
  "$(api_key_rotation_decision \
    '{"data":[{"id":"11111111-1111-4111-8111-111111111111","prefix":"mih_live_rotation","lastFour":"1234","status":"active","effectiveStatus":"active","expiresAt":"1970-01-31T00:00:00.000Z"}]}' \
    "$rotation_secret" \
    0)" \
  'key at the 30-day boundary rotates'
assert_eq \
  'rotate|11111111-1111-4111-8111-111111111111|expired|1970-02-01T00:00:00.000Z' \
  "$(api_key_rotation_decision \
    '{"data":[{"id":"11111111-1111-4111-8111-111111111111","prefix":"mih_live_rotation","lastFour":"1234","status":"active","effectiveStatus":"expired","expiresAt":"1970-02-01T00:00:00.000Z"}]}' \
    "$rotation_secret" \
    0)" \
  'effective expiry overrides raw active status'

# Reusing a healthy bootstrap key must not mint or rotate it. An operator can
# explicitly add a newly approved platform to that same consumer, and deploy
# output must never echo the retained plaintext key.
reuse_events="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-key-reuse.XXXXXX")"
reuse_output="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-key-output.XXXXXX")"
reuse_curl_audit="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-curl-audit.XXXXXX")"
reuse_secret='mih_live_bootstrap_reuse_material_4321'
reuse_admin_token='admin-token-with-at-least-32-bytes'
reuse_encoded="$(printf '%s' "$reuse_secret" | base64)"
reuse_tenant_id='11111111-1111-4111-8111-111111111111'
reuse_consumer_id='22222222-2222-4222-8222-222222222222'
reuse_tenant_encoded="$(printf '%s' "$reuse_tenant_id" | base64)"
reuse_consumer_encoded="$(printf '%s' "$reuse_consumer_id" | base64)"
reuse_prefix="${reuse_secret:0:25}"
reuse_last_four="${reuse_secret: -4}"
REUSE_EVENTS="$reuse_events" \
REUSE_CURL_AUDIT="$reuse_curl_audit" \
REUSE_SECRET="$reuse_secret" \
REUSE_ENCODED="$reuse_encoded" \
REUSE_TENANT_ENCODED="$reuse_tenant_encoded" \
REUSE_CONSUMER_ENCODED="$reuse_consumer_encoded" \
REUSE_PREFIX="$reuse_prefix" \
REUSE_LAST_FOUR="$reuse_last_four" \
MX_INSIGHT_ADMIN_TOKEN="$reuse_admin_token" \
MX_INSIGHT_BOOTSTRAP_PLATFORMS=' telegram,telegram ' \
NIGHT_ALL_BASE_URL='http://127.0.0.1:13141' \
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    case "$*" in
      *"MX_INSIGHT_API_KEY"*) printf "%s" "$REUSE_ENCODED" ;;
      *"MX_INSIGHT_TENANT_ID"*) printf "%s" "$REUSE_TENANT_ENCODED" ;;
      *"MX_INSIGHT_CONSUMER_ID"*) printf "%s" "$REUSE_CONSUMER_ENCODED" ;;
      *) return 1 ;;
    esac
  }
  audit_curl_header() {
    label="$1"
    expected_header="$2"
    shift 2
    header_file=""
    for argument in "$@"; do
      case "$argument" in
        *"$MX_INSIGHT_ADMIN_TOKEN"*|*"$REUSE_SECRET"*)
          printf "unsafe-argv:%s\n" "$label" >>"$REUSE_CURL_AUDIT"
          return 88
          ;;
        @*) header_file="${argument#@}" ;;
      esac
    done
    if [ -z "$header_file" ] || [ ! -f "$header_file" ]; then
      printf "missing-header-file:%s\n" "$label" >>"$REUSE_CURL_AUDIT"
      return 89
    fi
    header_mode="$(stat -f "%Lp" "$header_file" 2>/dev/null || stat -c "%a" "$header_file")"
    IFS= read -r header_line <"$header_file"
    if [ "$header_mode" != "600" ] || [ "$header_line" != "$expected_header" ]; then
      printf "unsafe-header-file:%s\n" "$label" >>"$REUSE_CURL_AUDIT"
      return 90
    fi
    printf "safe-header-file:%s:%s\n" "$label" "$header_file" >>"$REUSE_CURL_AUDIT"
  }
  curl() {
    case "$*" in
      *"/internal/v1/admin/api-keys"*)
        audit_curl_header key-list "x-mx-insight-admin-token: $MX_INSIGHT_ADMIN_TOKEN" "$@" || return
        printf '\''{"data":[{"id":"33333333-3333-4333-8333-333333333333","prefix":"%s","lastFour":"%s","status":"active","effectiveStatus":"active","expiresAt":"2999-01-01T00:00:00.000Z"}]}'\'' "$REUSE_PREFIX" "$REUSE_LAST_FOUR"
        ;;
      *"-X PUT"*"/internal/v1/admin/platforms/telegram"*)
        audit_curl_header platform-grant "x-mx-insight-admin-token: $MX_INSIGHT_ADMIN_TOKEN" "$@" || return
        printf "grant:telegram\n" >>"$REUSE_EVENTS"
        printf '\''{"data":{"platform":"telegram","enabled":true}}'\''
        ;;
      *"/api/v1/data/capabilities"*)
        audit_curl_header summary-capabilities "authorization: Bearer $REUSE_SECRET" "$@" || return
        printf '\''{"data":{"platforms":[]}}'\''
        ;;
      *) return 1 ;;
    esac
  }
  node() {
    case "$*" in
      *"scripts/provision.mjs"*)
        printf "mint\n" >>"$REUSE_EVENTS"
        return 1
        ;;
      *) command node "$@" ;;
    esac
  }
  ensure_default_api_key
  print_deploy_summary
' _ "$ROOT_DIR" >"$reuse_output" 2>&1
assert_eq 'grant:telegram' "$(cat "$reuse_events")" 'reused bootstrap key reconciles only the explicit platform without minting'
assert_eq '3' "$(grep -c '^safe-header-file:' "$reuse_curl_audit")" 'bootstrap key list, grant, and summary use protected headers'
while IFS= read -r reuse_header_file; do
  if [ -e "$reuse_header_file" ]; then
    printf 'not ok - bootstrap credential request did not clean up its protected header file\n' >&2
    exit 1
  fi
done < <(sed -n 's/^safe-header-file:[^:]*://p' "$reuse_curl_audit")
if grep -Fq "$reuse_secret" "$reuse_output" || grep -Fq "$reuse_admin_token" "$reuse_output"; then
  printf 'not ok - deploy output exposed a bootstrap credential\n' >&2
  exit 1
fi
grep -q 'stored in Secret mx-insight-hub-bootstrap (plaintext withheld)' "$reuse_output"
grep -q 'bash scripts/manage.sh verify-data-path' "$reuse_output"
rm -f -- "$reuse_events" "$reuse_output" "$reuse_curl_audit"
printf 'ok - bootstrap grant reconciliation protects credentials and deploy output withholds keys\n'

# Rotation is overlap-safe: mint and persist the replacement before revoking
# the old key. Stubs record externally visible ordering while the real decision
# helper continues to run in Node.
rotation_events="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-key-rotation.XXXXXX")"
rotation_curl_audit="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-rotation-curl.XXXXXX")"
rotation_output="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-rotation-output.XXXXXX")"
rotation_old_secret='mih_live_bootstrap_old_5678'
rotation_new_secret='mih_live_bootstrap_new_9999'
rotation_admin_token='rotation-admin-token-with-at-least-32-bytes'
rotation_old_encoded="$(printf '%s' "$rotation_old_secret" | base64)"
ROTATION_EVENTS="$rotation_events" \
ROTATION_CURL_AUDIT="$rotation_curl_audit" \
ROTATION_OLD_ENCODED="$rotation_old_encoded" \
ROTATION_OLD_SECRET="$rotation_old_secret" \
ROTATION_NEW_SECRET="$rotation_new_secret" \
MX_INSIGHT_ADMIN_TOKEN="$rotation_admin_token" \
NIGHT_ALL_BASE_URL='http://127.0.0.1:13141' \
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    case "$*" in
      *"get secret mx-insight-hub-bootstrap"*) printf "%s" "$ROTATION_OLD_ENCODED" ;;
      *"create secret generic mx-insight-hub-bootstrap"*)
        printf "persist\n" >>"$ROTATION_EVENTS"
        printf "apiVersion: v1\n"
        ;;
      *"apply -f -"*) cat >/dev/null ;;
      *) return 1 ;;
    esac
  }
  audit_admin_curl() {
    label="$1"
    shift
    header_file=""
    for argument in "$@"; do
      case "$argument" in
        *"$MX_INSIGHT_ADMIN_TOKEN"*|*"$ROTATION_OLD_SECRET"*|*"$ROTATION_NEW_SECRET"*)
          printf "unsafe-argv:%s\n" "$label" >>"$ROTATION_CURL_AUDIT"
          return 88
          ;;
        @*) header_file="${argument#@}" ;;
      esac
    done
    if [ -z "$header_file" ] || [ ! -f "$header_file" ]; then
      printf "missing-header-file:%s\n" "$label" >>"$ROTATION_CURL_AUDIT"
      return 89
    fi
    header_mode="$(stat -f "%Lp" "$header_file" 2>/dev/null || stat -c "%a" "$header_file")"
    IFS= read -r header_line <"$header_file"
    if [ "$header_mode" != "600" ] || [ "$header_line" != "x-mx-insight-admin-token: $MX_INSIGHT_ADMIN_TOKEN" ]; then
      printf "unsafe-header-file:%s\n" "$label" >>"$ROTATION_CURL_AUDIT"
      return 90
    fi
    printf "safe-header-file:%s:%s\n" "$label" "$header_file" >>"$ROTATION_CURL_AUDIT"
  }
  curl() {
    case "$*" in
      *"/revoke"*)
        audit_admin_curl revoke "$@" || return
        printf "revoke\n" >>"$ROTATION_EVENTS"
        ;;
      *"/internal/v1/admin/api-keys"*)
        audit_admin_curl key-list "$@" || return
        printf "%s" '\''{"data":[{"id":"22222222-2222-4222-8222-222222222222","prefix":"mih_live_bootstrap_old","lastFour":"5678","status":"active","effectiveStatus":"expired","expiresAt":"2000-01-01T00:00:00.000Z"}]}'\''
        ;;
      *) return 1 ;;
    esac
  }
  node() {
    case "$*" in
      *"scripts/provision.mjs"*)
        printf "mint\n" >>"$ROTATION_EVENTS"
        printf "%s\ntenant-id\nconsumer-id\n" "$ROTATION_NEW_SECRET"
        ;;
      *) command node "$@" ;;
    esac
  }
  ensure_default_api_key
' _ "$ROOT_DIR" >"$rotation_output" 2>&1
assert_eq $'mint\npersist\nrevoke' "$(cat "$rotation_events")" 'bootstrap rotation persists before revoke'
assert_eq '2' "$(grep -c '^safe-header-file:' "$rotation_curl_audit")" 'bootstrap key inspection and revoke use protected headers'
while IFS= read -r rotation_header_file; do
  if [ -e "$rotation_header_file" ]; then
    printf 'not ok - bootstrap rotation did not clean up its protected header file\n' >&2
    exit 1
  fi
done < <(sed -n 's/^safe-header-file:[^:]*://p' "$rotation_curl_audit")
if grep -Fq "$rotation_admin_token" "$rotation_output" \
  || grep -Fq "$rotation_old_secret" "$rotation_output" \
  || grep -Fq "$rotation_new_secret" "$rotation_output"; then
  printf 'not ok - bootstrap rotation output exposed a credential\n' >&2
  exit 1
fi
rm -f -- "$rotation_events" "$rotation_curl_audit" "$rotation_output"

# The operator verification command makes two public requests. Its API key is
# protected in the same way as deploy-time requests, including the billed
# search path.
verify_curl_audit="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-verify-curl.XXXXXX")"
verify_output="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-verify-output.XXXXXX")"
verify_pg_marker="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-verify-pg.XXXXXX")"
verify_secret='mih_live_verify_path_material_2468'
rm -f -- "$verify_pg_marker"
VERIFY_CURL_AUDIT="$verify_curl_audit" \
VERIFY_PG_MARKER="$verify_pg_marker" \
VERIFY_SECRET="$verify_secret" \
NIGHT_ALL_BASE_URL='http://127.0.0.1:13141' \
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  audit_public_curl() {
    label="$1"
    shift
    header_file=""
    for argument in "$@"; do
      case "$argument" in
        *"$VERIFY_SECRET"*)
          printf "unsafe-argv:%s\n" "$label" >>"$VERIFY_CURL_AUDIT"
          return 88
          ;;
        @*) header_file="${argument#@}" ;;
      esac
    done
    if [ -z "$header_file" ] || [ ! -f "$header_file" ]; then
      printf "missing-header-file:%s\n" "$label" >>"$VERIFY_CURL_AUDIT"
      return 89
    fi
    header_mode="$(stat -f "%Lp" "$header_file" 2>/dev/null || stat -c "%a" "$header_file")"
    IFS= read -r header_line <"$header_file"
    if [ "$header_mode" != "600" ] || [ "$header_line" != "authorization: Bearer $VERIFY_SECRET" ]; then
      printf "unsafe-header-file:%s\n" "$label" >>"$VERIFY_CURL_AUDIT"
      return 90
    fi
    printf "safe-header-file:%s:%s\n" "$label" "$header_file" >>"$VERIFY_CURL_AUDIT"
  }
  curl() {
    case "$*" in
      *"/api/v1/data/capabilities"*)
        audit_public_curl capabilities "$@" || return
        printf '\''{"data":{"platforms":["xiaohongshu"]}}'\''
        ;;
      *"/api/v1/data/search"*)
        audit_public_curl search "$@" || return
        printf '\''{"data":{"items":[{"externalId":"one"}]}}'\''
        ;;
      *) return 1 ;;
    esac
  }
  pg_count() {
    case "$1" in
      *"core.canonical_records"*)
        if [ -f "$VERIFY_PG_MARKER" ]; then printf "1"; else : >"$VERIFY_PG_MARKER"; printf "0"; fi
        ;;
      *"outbox.projection_events"*) printf "0" ;;
      *) printf "0" ;;
    esac
  }
  kubectl() { printf '\''{"count":1}'\''; }
  verify_data_path "$VERIFY_SECRET"
' _ "$ROOT_DIR" >"$verify_output" 2>&1
assert_eq '2' "$(grep -c '^safe-header-file:' "$verify_curl_audit")" 'verification capabilities and search use protected headers'
while IFS= read -r verify_header_file; do
  if [ -e "$verify_header_file" ]; then
    printf 'not ok - data-path verification did not clean up its protected header file\n' >&2
    exit 1
  fi
done < <(sed -n 's/^safe-header-file:[^:]*://p' "$verify_curl_audit")
if grep -Fq "$verify_secret" "$verify_output"; then
  printf 'not ok - data-path verification output exposed its API key\n' >&2
  exit 1
fi
rm -f -- "$verify_curl_audit" "$verify_output" "$verify_pg_marker"
printf 'ok - data-path verification protects its API key\n'

# Protected header files must also disappear when curl fails or the request is
# interrupted, not only after successful requests.
cleanup_curl_audit="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-cleanup-curl.XXXXXX")"
cleanup_output="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-cleanup-output.XXXXXX")"
cleanup_secret='cleanup-secret-with-at-least-32-bytes'
CLEANUP_CURL_AUDIT="$cleanup_curl_audit" \
CLEANUP_SECRET="$cleanup_secret" \
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  curl() {
    label=failure
    case "$*" in *"/interrupt"*) label=interrupt ;; esac
    header_file=""
    for argument in "$@"; do
      case "$argument" in
        *"$CLEANUP_SECRET"*)
          printf "unsafe-argv:%s\n" "$label" >>"$CLEANUP_CURL_AUDIT"
          return 88
          ;;
        @*) header_file="${argument#@}" ;;
      esac
    done
    if [ -z "$header_file" ] || [ ! -f "$header_file" ]; then
      printf "missing-header-file:%s\n" "$label" >>"$CLEANUP_CURL_AUDIT"
      return 89
    fi
    header_mode="$(stat -f "%Lp" "$header_file" 2>/dev/null || stat -c "%a" "$header_file")"
    IFS= read -r header_line <"$header_file"
    if [ "$header_mode" != "600" ] || [ "$header_line" != "authorization: Bearer $CLEANUP_SECRET" ]; then
      printf "unsafe-header-file:%s\n" "$label" >>"$CLEANUP_CURL_AUDIT"
      return 90
    fi
    printf "safe-header-file:%s:%s\n" "$label" "$header_file" >>"$CLEANUP_CURL_AUDIT"
    if [ "$label" = interrupt ]; then
      sh -c '\''kill -TERM "$PPID"'\''
    fi
    return 22
  }
  if curl_with_protected_header authorization "Bearer $CLEANUP_SECRET" -fsS http://example/failure; then
    exit 91
  fi
  if curl_with_protected_header authorization "Bearer $CLEANUP_SECRET" -fsS http://example/interrupt; then
    exit 92
  fi
' _ "$ROOT_DIR" >"$cleanup_output" 2>&1
assert_eq '2' "$(grep -c '^safe-header-file:' "$cleanup_curl_audit")" 'protected headers are created for failed and interrupted requests'
while IFS= read -r cleanup_header_file; do
  if [ -e "$cleanup_header_file" ]; then
    printf 'not ok - failed or interrupted curl left a protected header file behind\n' >&2
    exit 1
  fi
done < <(sed -n 's/^safe-header-file:[^:]*://p' "$cleanup_curl_audit")
if grep -Fq "$cleanup_secret" "$cleanup_output"; then
  printf 'not ok - failed or interrupted curl output exposed its credential\n' >&2
  exit 1
fi
rm -f -- "$cleanup_curl_audit" "$cleanup_output"
printf 'ok - failed and interrupted requests clean up protected headers\n'

assert_eq \
  '2' \
  "$(grep -c "jsonpath='{.data.MX_INSIGHT_API_KEY}'" "$ROOT_DIR/scripts/manage.sh")" \
  'bootstrap provisioning and verification read the same Secret field'

# Direct source credentials now live in the Admin-managed catalog. Production
# validation must therefore succeed without a separate provider credential key.
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  load_env_file() { :; }
  export MX_INSIGHT_ADMIN_TOKEN=admin-token-with-at-least-32-bytes
  export MX_INSIGHT_API_KEY_PEPPER=api-key-pepper-with-at-least-32-bytes
  export NIGHT_ALL_BASE_URL=http://127.0.0.1:13141
  unset MX_INSIGHT_POSTGRES_PASSWORD
  require_production_env
' _ "$ROOT_DIR"
printf 'ok - production validation needs no separate source credential key\n'

# ---------------------------------------------------------------------------
# Optional HanLP discovery
# ---------------------------------------------------------------------------

hanlp_explicit="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  say() { :; }
  export MX_COMMON_HANLP_URL=http://external-hanlp.example:8000
  kubectl() { return 99; }
  discover_hanlp_url
  printf "%s" "$MX_COMMON_HANLP_URL"
' _ "$ROOT_DIR")"
assert_eq \
  'http://external-hanlp.example:8000' \
  "$hanlp_explicit" \
  'explicit HanLP URL overrides cluster discovery'

hanlp_disabled="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  say() { :; }
  export MX_COMMON_HANLP_URL=
  kubectl() { printf "10.42.0.9"; }
  discover_hanlp_url
  printf "%s:%s" "${MX_COMMON_HANLP_URL+x}" "$MX_COMMON_HANLP_URL"
' _ "$ROOT_DIR")"
assert_eq 'x:' "$hanlp_disabled" 'explicit empty HanLP URL disables discovery'

hanlp_discovered="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  say() { :; }
  unset MX_COMMON_HANLP_URL
  kubectl() {
    case " $* " in
      *" get endpoints mx-common-hanlp "*) printf "10.42.0.9" ;;
      *) return 1 ;;
    esac
  }
  discover_hanlp_url
  printf "%s" "$MX_COMMON_HANLP_URL"
' _ "$ROOT_DIR")"
assert_eq \
  'http://mx-common-hanlp.mx-common.svc.cluster.local:8000' \
  "$hanlp_discovered" \
  'ready HanLP Endpoint is auto-discovered'

hanlp_absent="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  say() { :; }
  unset MX_COMMON_HANLP_URL
  kubectl() {
    case " $* " in
      *" get endpoints mx-common-hanlp "*|*" get configmap mx-insight-hub-config "*) return 0 ;;
      *) return 1 ;;
    esac
  }
  discover_hanlp_url
  printf "%s" "$MX_COMMON_HANLP_URL"
' _ "$ROOT_DIR")"
assert_eq '' "$hanlp_absent" 'first general deploy without HanLP leaves the province pipeline gated'

# A transiently empty Endpoint must not turn a deployed HanLP-backed Hub into a
# jieba deployment. Discovery runs before ConfigMap creation and every workload
# rollout, so failing here preserves the current runtime and cannot reach the
# optional Launcher synchronization path even if an operator enabled it.
hanlp_fail_closed_events="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-hanlp-fail-closed.XXXXXX")"
hanlp_fail_closed_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-hanlp-fail-closed-error.XXXXXX")"
if HANLP_FAIL_CLOSED_EVENTS="$hanlp_fail_closed_events" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  unset MX_COMMON_HANLP_URL
  export MX_INSIGHT_SYNC_LAUNCHER=1
  kubectl() {
    printf "kubectl:%s\n" "$*" >>"$HANLP_FAIL_CLOSED_EVENTS"
    case " $* " in
      *" get endpoints mx-common-hanlp "*) return 0 ;;
      *" get configmap mx-insight-hub-config "*".data.MX_COMMON_HANLP_URL"*)
        printf "http://mx-common-hanlp.mx-common.svc.cluster.local:8000"
        ;;
      *) return 0 ;;
    esac
  }
  validate_existing_runtime_secret() { :; }
  create_runtime_config() { printf "runtime-config\n" >>"$HANLP_FAIL_CLOSED_EVENTS"; }
  create_model_key_secret() { printf "model-secret\n" >>"$HANLP_FAIL_CLOSED_EVENTS"; }
  sync_launcher_secret() { printf "launcher-sync\n" >>"$HANLP_FAIL_CLOSED_EVENTS"; }
  refresh_launcher_workload() { printf "launcher-rollout\n" >>"$HANLP_FAIL_CLOSED_EVENTS"; }
  warn_local_postgres_present() { :; }
  apply_k8s
' _ "$ROOT_DIR" >"$hanlp_fail_closed_error" 2>&1; then
  printf 'not ok - transient HanLP Endpoint loss downgraded the deployed Hub\n' >&2
  exit 1
fi
grep -Fq 'refusing to clear an existing HanLP URL while its Endpoint is temporarily unavailable' "$hanlp_fail_closed_error"
if grep -Eq 'runtime-config|rollout restart|launcher|mx-launcher' "$hanlp_fail_closed_events"; then
  printf 'not ok - failed HanLP discovery changed runtime config, workloads, or Launcher\n' >&2
  exit 1
fi
rm -f -- "$hanlp_fail_closed_events" "$hanlp_fail_closed_error"
printf 'ok - transient HanLP Endpoint loss preserves the deployed config before any rollout or Launcher sync\n'

grep -q '^    mx-common\.io/client: allowed$' \
  "$ROOT_DIR/deploy/k8s/internal/00-namespace.yaml"
printf 'ok - Hub namespace is always admitted by the mx-common client policy\n'

# Discovery must happen after the namespace exists and before the ConfigMap is
# rendered so a regular Hub redeploy publishes the discovered URL atomically.
apply_k8s_body="$(sed -n '/^apply_k8s() {/,/^}/p' "$ROOT_DIR/scripts/manage.sh")"
runtime_config_body="$(sed -n '/^create_runtime_config() {/,/^}/p' "$ROOT_DIR/scripts/manage.sh")"
namespace_line="$(grep -n '00-namespace.yaml' <<<"$apply_k8s_body" | cut -d: -f1)"
discovery_line="$(grep -n 'discover_hanlp_url' <<<"$apply_k8s_body" | cut -d: -f1)"
config_line="$(grep -n 'create_runtime_config' <<<"$apply_k8s_body" | cut -d: -f1)"
first_workload_change_line="$(grep -nE 'rollout restart|scale deployment' <<<"$apply_k8s_body" | head -1 | cut -d: -f1)"
if ! [ "$namespace_line" -lt "$discovery_line" ] \
  || ! [ "$discovery_line" -lt "$config_line" ] \
  || ! [ "$config_line" -lt "$first_workload_change_line" ]; then
  printf 'not ok - HanLP discovery is not ordered before runtime ConfigMap creation\n' >&2
  exit 1
fi
grep -q -- '--from-literal=MX_COMMON_HANLP_URL=' <<<"$runtime_config_body"
printf 'ok - regular deploy discovers HanLP before publishing runtime config\n'

# Fixed-source serving indexes are an idempotent deploy prerequisite, not a
# separate operator memory step. They must run only after schema migrations and
# before any API workload is applied/restarted.
migration_complete_line="$(grep -n -- '--for=condition=complete job/mx-insight-hub-migrate' <<<"$apply_k8s_body" | cut -d: -f1)"
province_indexes_line="$(grep -n '^  ensure_province_opinion_serving_indexes$' <<<"$apply_k8s_body" | cut -d: -f1)"
context_indexes_line="$(grep -n '^  ensure_canonical_context_serving_indexes$' <<<"$apply_k8s_body" | cut -d: -f1)"
first_api_apply_line="$(grep -n '30-public-api.yaml' <<<"$apply_k8s_body" | cut -d: -f1)"
if ! [ "$migration_complete_line" -lt "$province_indexes_line" ] \
  || ! [ "$province_indexes_line" -lt "$context_indexes_line" ] \
  || ! [ "$context_indexes_line" -lt "$first_api_apply_line" ]; then
  printf 'not ok - serving indexes are not reconciled after migrations and before API rollout\n' >&2
  exit 1
fi

province_index_stdin="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-province-index-stdin.XXXXXX")"
province_index_argv="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-province-index-argv.XXXXXX")"
PROVINCE_INDEX_STDIN="$province_index_stdin" \
PROVINCE_INDEX_ARGV="$province_index_argv" \
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    printf "%s\n" "$*" >"$PROVINCE_INDEX_ARGV"
    cat >"$PROVINCE_INDEX_STDIN"
  }
  ensure_province_opinion_serving_indexes
' _ "$ROOT_DIR"
assert_eq \
  '-n mx-common exec -i statefulset/mx-common-postgres -- psql -X -U mx_common -d mx_insight_hub -v ON_ERROR_STOP=1' \
  "$(cat "$province_index_argv")" \
  'deploy streams province indexes to the shared Hub database'
cmp -s "$ROOT_DIR/scripts/province-opinion-serving-indexes.sql" "$province_index_stdin" \
  || { printf 'not ok - deploy did not stream the exact province serving-index SQL\n' >&2; exit 1; }

# The column form of pg_get_indexdef omits sort options. Guard the regression by
# requiring expression-only comparisons plus the exact pg_index bit pattern for
# every key, with both preflight checks and the final assertion sharing one view.
province_index_sql="$(cat "$ROOT_DIR/scripts/province-opinion-serving-indexes.sql")"
for key_number in 1 2 3 4; do
  grep -Fq "pg_get_indexdef(c.oid, ${key_number}, true)), '[()[:space:]\"]', '', 'g') = e.key_${key_number}" \
    <<<"$province_index_sql"
done
for option_number in 0 1 2 3; do
  expected_number=$((option_number + 1))
  grep -Fq "i.indoption[${option_number}] = e.option_${expected_number}" \
    <<<"$province_index_sql"
done
assert_eq \
  '2' \
  "$(grep -Fc '0, 1, 1, 3,' <<<"$province_index_sql")" \
  'both province indexes require ASC, DESC NULLS LAST, DESC NULLS LAST, DESC defaults'
assert_eq \
  '3' \
  "$(grep -c 'FROM province_opinion_serving_index_contract' <<<"$province_index_sql")" \
  'province index preflight and final gate reuse one complete contract'
grep -Fq 'SELECT count(*) = 2 AND bool_and(contract_ready)' <<<"$province_index_sql"
grep -Fq 'CREATE INDEX CONCURRENTLY canonical_public_opinion_region_latest_idx' <<<"$province_index_sql"
grep -Fq 'CREATE INDEX CONCURRENTLY public_opinion_current_state_region_idx' <<<"$province_index_sql"
grep -Fq 'FROM public_opinion_region_serving_index_contract' <<<"$province_index_sql"
if grep -Eq 'heat_scoredescnullslast|collected_atdescnullslast|iddesc' <<<"$province_index_sql"; then
  printf 'not ok - province index contract expects sort syntax from column-only pg_get_indexdef\n' >&2
  exit 1
fi

province_index_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-province-index-error.XXXXXX")"
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() { cat >/dev/null; return 1; }
  ensure_province_opinion_serving_indexes
' _ "$ROOT_DIR" >"$province_index_error" 2>&1; then
  printf 'not ok - deploy continued after province serving-index reconciliation failed\n' >&2
  exit 1
fi
grep -q 'province-opinion serving indexes could not be reconciled' "$province_index_error"
rm -f -- "$province_index_stdin" "$province_index_argv" "$province_index_error"
printf 'ok - province serving-index reconciliation is exact and fail-closed\n'

context_index_stdin="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-context-index-stdin.XXXXXX")"
context_index_argv="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-context-index-argv.XXXXXX")"
CONTEXT_INDEX_STDIN="$context_index_stdin" \
CONTEXT_INDEX_ARGV="$context_index_argv" \
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    printf "%s\n" "$*" >>"$CONTEXT_INDEX_ARGV"
    cat >"$CONTEXT_INDEX_STDIN"
  }
  ensure_canonical_context_serving_indexes
' _ "$ROOT_DIR"
assert_eq \
  '-n mx-common exec -i statefulset/mx-common-postgres -- psql -X -U mx_common -d mx_insight_hub -v ON_ERROR_STOP=1' \
  "$(cat "$context_index_argv")" \
  'deploy streams canonical context indexes to the shared Hub database'
assert_eq '1' "$(wc -l <"$context_index_argv" | tr -d ' ')" \
  'canonical context reconciliation performs exactly one kubectl call'
if grep -Eq 'mx-launcher|mx-internal-shadow' "$context_index_argv"; then
  printf 'not ok - canonical context reconciliation touched Launcher resources\n' >&2
  exit 1
fi
cmp -s "$ROOT_DIR/scripts/canonical-context-serving-indexes.sql" "$context_index_stdin" \
  || { printf 'not ok - deploy did not stream the exact canonical context serving-index SQL\n' >&2; exit 1; }

context_index_sql="$(cat "$ROOT_DIR/scripts/canonical-context-serving-indexes.sql")"
for key_number in 1 2 3; do
  grep -Fq "pg_get_indexdef(c.oid, ${key_number}, true), '[()[:space:]\"]', '', 'g') = e.key_${key_number}" \
    <<<"$context_index_sql"
done
for option_number in 0 1 2; do
  expected_number=$((option_number + 1))
  grep -Fq "i.indoption[${option_number}] = e.option_${expected_number}" \
    <<<"$context_index_sql"
done
assert_eq \
  '2' \
  "$(grep -Fc '0, 3, 3,' <<<"$context_index_sql")" \
  'both canonical context indexes require ASC, DESC defaults, DESC defaults'
assert_eq \
  '3' \
  "$(grep -c 'FROM canonical_context_serving_index_contract' <<<"$context_index_sql")" \
  'context index preflight and final gate reuse one complete contract'
grep -Fq 'DROP INDEX CONCURRENTLY IF EXISTS core.canonical_monitor_tg_messages_chat_time_idx' \
  <<<"$context_index_sql"
grep -Fq 'DROP INDEX CONCURRENTLY IF EXISTS core.canonical_sqlite_tg_messages_chat_time_idx' \
  <<<"$context_index_sql"
grep -Fq "stable_fields#>>''{relations,chatId}''::text[]" <<<"$context_index_sql"
if grep -Fq 'lower(pg_get_indexdef' <<<"$context_index_sql"; then
  printf 'not ok - canonical context contract lowercases a case-sensitive JSON path\n' >&2
  exit 1
fi
grep -Fq 'SELECT count(*) = 2 AND bool_and(contract_ready)' <<<"$context_index_sql"
if grep -Eq 'CREATE INDEX CONCURRENTLY IF NOT EXISTS' <<<"$context_index_sql"; then
  printf 'not ok - canonical context reconciliation can skip an invalid same-name index\n' >&2
  exit 1
fi

context_index_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-context-index-error.XXXXXX")"
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() { cat >/dev/null; return 1; }
  ensure_canonical_context_serving_indexes
' _ "$ROOT_DIR" >"$context_index_error" 2>&1; then
  printf 'not ok - deploy continued after canonical context serving-index reconciliation failed\n' >&2
  exit 1
fi
grep -q 'canonical context serving indexes could not be reconciled' "$context_index_error"
rm -f -- "$context_index_stdin" "$context_index_argv" "$context_index_error"
printf 'ok - canonical context serving-index reconciliation is exact and fail-closed\n'

run_hanlp_hub_smoke() (
  export MX_COMMON_HANLP_URL=http://hanlp.test
  export MX_INSIGHT_SEARCH_READY=1
  export HANLP_SMOKE_MODE="$1"
  kubectl() {
    [ "$1" = "-n" ] \
      && [ "$2" = "mx-insight-hub" ] \
      && [ "$3" = "exec" ] \
      && [ "$4" = "deployment/mx-insight-hub-projector" ] \
      && [ "$5" = "--" ] \
      || return 2
    shift 5
    [ "$1" = "node" ] && [ "$2" = "--input-type=module" ] && [ "$3" = "-e" ] || return 2

    HANLP_SMOKE_SCRIPT="$4" node --input-type=module -e '
      globalThis.fetch = async (endpoint, options) => {
        const input = JSON.parse(options.body)
        if (endpoint !== "http://hanlp.test/tokenize"
          || options.method !== "POST"
          || options.headers["content-type"] !== "application/json"
          || input.text !== "吴恩达与人工智能"
          || input.coarse !== true) {
          return new Response(JSON.stringify({ error: "request contract mismatch" }), { status: 418 })
        }
        if (process.env.HANLP_SMOKE_MODE === "success") {
          return new Response(JSON.stringify([["吴恩达", "人工智能"]]), { status: 200 })
        }
        if (process.env.HANLP_SMOKE_MODE === "empty") {
          return new Response(JSON.stringify([[]]), { status: 200 })
        }
        return new Response(JSON.stringify({
          error: `BertTokenizer has no attribute encode_plus ${"x".repeat(5000)}`,
        }), { status: 500 })
      }
      await import(`data:text/javascript,${encodeURIComponent(process.env.HANLP_SMOKE_SCRIPT)}`)
    ' "$5"
  }
  verify_hanlp_from_hub
)

run_hanlp_hub_smoke success
printf 'ok - HanLP connectivity smoke runs through a real Hub pod command\n'

hanlp_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-hanlp-error.XXXXXX")"
if run_hanlp_hub_smoke error 2>"$hanlp_error"; then
  printf 'not ok - HanLP HTTP 500 passed the deployment smoke\n' >&2
  exit 1
fi
grep -Fq 'returned HTTP 500; response body="{\"error\":\"BertTokenizer has no attribute encode_plus' "$hanlp_error"
grep -Fq ' [truncated]' "$hanlp_error"
if [ "$(wc -c <"$hanlp_error")" -gt 2400 ]; then
  printf 'not ok - HanLP error diagnostic was not bounded\n' >&2
  exit 1
fi
if grep -Eq 'file:///.+\[eval\]|^[[:space:]]+at ' "$hanlp_error"; then
  printf 'not ok - HanLP smoke exposed a raw eval stack\n' >&2
  exit 1
fi
grep -Fq 'HanLP /tokenize contract failed from the projector' "$hanlp_error"
rm -f -- "$hanlp_error"
printf 'ok - HanLP non-2xx response body is bounded without an eval stack\n'

hanlp_empty_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-hanlp-empty.XXXXXX")"
if run_hanlp_hub_smoke empty 2>"$hanlp_empty_error"; then
  printf 'not ok - HanLP nested empty token response passed the deployment smoke\n' >&2
  exit 1
fi
grep -Fq 'response contains no non-empty token' "$hanlp_empty_error"
if grep -Eq 'file:///.+\[eval\]|^[[:space:]]+at ' "$hanlp_empty_error"; then
  printf 'not ok - empty HanLP response exposed a raw eval stack\n' >&2
  exit 1
fi
rm -f -- "$hanlp_empty_error"
printf 'ok - HanLP smoke rejects nested empty token responses\n'

# A segmentation rebuild runs as a strict one-shot process in the Ready Admin
# Pod. It must not depend on or restart the fail-soft projector, API/login,
# Launcher, or ingest workloads.
reindex_events="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-reindex-events.XXXXXX")"
reindex_output="$(REINDEX_EVENTS="$reindex_events" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    printf "%s\n" "$*" >>"$REINDEX_EVENTS"
    case "$*" in
      *"get configmap mx-insight-hub-config"*"MX_COMMON_ELASTICSEARCH_URL"*)
        printf "http://mx-common-elasticsearch.mx-common.svc.cluster.local:9200"
        ;;
      *"get deployment mx-insight-hub-admin"*".status.readyReplicas"*) printf "1" ;;
      *"get deployment mx-insight-hub-projector"*".spec.replicas"*) printf "1" ;;
      *"get deployment mx-insight-hub-projector"*".status.readyReplicas"*) printf "1" ;;
      *"exec deployment/mx-insight-hub-admin -- node server/scripts/reindex-search.mjs"*)
        printf "[reindex] completed with verified tokenizer backend=hanlp\n"
        ;;
      *) return 0 ;;
    esac
  }
  reindex_search
' _ "$ROOT_DIR")"
grep -Fq 'exec deployment/mx-insight-hub-admin -- node server/scripts/reindex-search.mjs' "$reindex_events"
grep -Fq 'search reindex completed with verified configured-tokenizer output' <<<"$reindex_output"
if grep -Eq 'rollout restart|scale deployment|mx-launcher' "$reindex_events"; then
  printf 'not ok - search reindex restarted a user-facing or ingest workload\n' >&2
  exit 1
fi
rm -f -- "$reindex_events"
printf 'ok - strict search reindex runs without restarting login, ingest, or projector workloads\n'

# A stale empty ConfigMap must not block runtime discovery inside the Admin Pod.
# The strict one-shot process owns final URL resolution and connectivity checks,
# so the CLI warning is diagnostic rather than a second, conflicting gate.
reindex_empty_url_events="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-reindex-empty-url-events.XXXXXX")"
reindex_empty_url_output="$(REINDEX_EVENTS="$reindex_empty_url_events" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    printf "%s\n" "$*" >>"$REINDEX_EVENTS"
    case "$*" in
      *"get configmap mx-insight-hub-config"*"MX_COMMON_ELASTICSEARCH_URL"*) : ;;
      *"get deployment mx-insight-hub-admin"*".status.readyReplicas"*) printf "1" ;;
      *"get deployment mx-insight-hub-projector"*".spec.replicas"*) printf "1" ;;
      *"get deployment mx-insight-hub-projector"*".status.readyReplicas"*) printf "1" ;;
      *"exec deployment/mx-insight-hub-admin -- node server/scripts/reindex-search.mjs"*)
        printf "[reindex] completed with verified tokenizer backend=hanlp\n"
        ;;
      *) return 0 ;;
    esac
  }
  reindex_search
' _ "$ROOT_DIR" 2>&1)"
grep -Fq 'MX_COMMON_ELASTICSEARCH_URL is empty in mx-insight-hub-config; continuing' <<<"$reindex_empty_url_output"
grep -Fq 'search reindex completed with verified configured-tokenizer output' <<<"$reindex_empty_url_output"
grep -Fq 'exec deployment/mx-insight-hub-admin -- node server/scripts/reindex-search.mjs' "$reindex_empty_url_events"
if grep -Fq 'there is no search projection to rebuild' <<<"$reindex_empty_url_output"; then
  printf 'not ok - an empty ConfigMap URL still blocked Admin runtime discovery\n' >&2
  exit 1
fi
rm -f -- "$reindex_empty_url_events"
printf 'ok - empty ConfigMap URL defers discovery and connectivity checks to Admin runtime\n'

reindex_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-reindex-strict.XXXXXX")"
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    case "$*" in
      *"get configmap mx-insight-hub-config"*"MX_COMMON_ELASTICSEARCH_URL"*)
        printf "http://mx-common-elasticsearch.mx-common.svc.cluster.local:9200"
        ;;
      *"get deployment mx-insight-hub-admin"*".status.readyReplicas"*) printf "1" ;;
      *"get deployment mx-insight-hub-projector"*".spec.replicas"*) printf "1" ;;
      *"get deployment mx-insight-hub-projector"*".status.readyReplicas"*) printf "1" ;;
      *"exec deployment/mx-insight-hub-admin -- node server/scripts/reindex-search.mjs"*)
        printf "[reindex] fatal: reindex requires hanlp tokens but received jieba\n" >&2
        return 42
        ;;
      *) return 0 ;;
    esac
  }
  reindex_search
' _ "$ROOT_DIR" >"$reindex_error" 2>&1; then
  printf 'not ok - HanLP reindex reported success after tokenizer degradation\n' >&2
  exit 1
fi
grep -Fq 'reindex requires hanlp tokens but received jieba' "$reindex_error"
grep -Fq 'search reindex failed tokenizer integrity' "$reindex_error"
if grep -Fq 'search reindex completed with verified' "$reindex_error"; then
  printf 'not ok - failed HanLP reindex emitted the success marker\n' >&2
  exit 1
fi
rm -f -- "$reindex_error"
printf 'ok - HanLP fallback makes reindex-search fail without a success marker\n'

# A non-ready projector must not block the independent Admin executor. Print
# bounded current/previous logs and rollout events, then continue the reindex.
reindex_not_ready_events="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-reindex-not-ready.XXXXXX")"
reindex_not_ready_output="$(REINDEX_EVENTS="$reindex_not_ready_events" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    printf "%s\n" "$*" >>"$REINDEX_EVENTS"
    case "$*" in
      *"get configmap mx-insight-hub-config"*"MX_COMMON_ELASTICSEARCH_URL"*)
        printf "http://mx-common-elasticsearch.mx-common.svc.cluster.local:9200"
        ;;
      *"get deployment mx-insight-hub-admin"*".status.readyReplicas"*) printf "1" ;;
      *"get deployment mx-insight-hub-projector"*".spec.replicas"*) printf "1" ;;
      *"get deployment mx-insight-hub-projector"*".status.readyReplicas"*) printf "0" ;;
      *"exec deployment/mx-insight-hub-admin -- node server/scripts/reindex-search.mjs"*)
        printf "[reindex] completed with verified tokenizer backend=hanlp\n"
        ;;
      *) return 0 ;;
    esac
  }
  reindex_search
' _ "$ROOT_DIR" 2>&1)"
grep -Fq 'projector diagnostics' <<<"$reindex_not_ready_output"
grep -Fq 'projector is not Ready (desired=1, ready=0)' <<<"$reindex_not_ready_output"
grep -Fq 'search reindex completed with verified configured-tokenizer output' <<<"$reindex_not_ready_output"
grep -Fq 'logs deployment/mx-insight-hub-projector --all-containers --tail=200' "$reindex_not_ready_events"
grep -Fq 'logs deployment/mx-insight-hub-projector --all-containers --previous --tail=200' "$reindex_not_ready_events"
grep -Fq 'exec deployment/mx-insight-hub-admin -- node server/scripts/reindex-search.mjs' "$reindex_not_ready_events"
if grep -Fq 'exec deployment/mx-insight-hub-projector' "$reindex_not_ready_events"; then
  printf 'not ok - reindex-search used a non-ready projector instead of Admin\n' >&2
  exit 1
fi
rm -f -- "$reindex_not_ready_events"
printf 'ok - non-ready projector prints diagnostics and reindexes in Ready Admin\n'

# If the Admin plane is also unavailable there is no safe in-cluster executor;
# fail before trying either workload and print the API rollout diagnostics.
reindex_admin_not_ready_events="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-reindex-admin-not-ready.XXXXXX")"
reindex_admin_not_ready_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-reindex-admin-not-ready-error.XXXXXX")"
if REINDEX_EVENTS="$reindex_admin_not_ready_events" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    printf "%s\n" "$*" >>"$REINDEX_EVENTS"
    case "$*" in
      *"get configmap mx-insight-hub-config"*"MX_COMMON_ELASTICSEARCH_URL"*)
        printf "http://mx-common-elasticsearch.mx-common.svc.cluster.local:9200"
        ;;
      *"get deployment mx-insight-hub-admin"*".status.readyReplicas"*) printf "0" ;;
      *) return 0 ;;
    esac
  }
  reindex_search
' _ "$ROOT_DIR" >"$reindex_admin_not_ready_error" 2>&1; then
  printf 'not ok - reindex-search accepted a non-ready Admin executor\n' >&2
  exit 1
fi
grep -Fq 'API rollout diagnostics' "$reindex_admin_not_ready_error"
grep -Fq 'mx-insight-hub-admin must have at least one Ready replica to host the reindex process (ready=0)' "$reindex_admin_not_ready_error"
if grep -Fq 'exec deployment/' "$reindex_admin_not_ready_events"; then
  printf 'not ok - reindex-search execed a workload without a Ready Admin\n' >&2
  exit 1
fi
rm -f -- "$reindex_admin_not_ready_events" "$reindex_admin_not_ready_error"
printf 'ok - non-ready Admin blocks reindex before kubectl exec\n'

# Independent deployment is the safety default: neither secret sync nor a
# Launcher rollout may issue kubectl mutations unless explicitly enabled.
launcher_default="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  unset MX_INSIGHT_SYNC_LAUNCHER
  say() { :; }
  kubectl() { printf "kubectl-called"; return 99; }
  sync_launcher_secret
  refresh_launcher_workload
' _ "$ROOT_DIR")"
assert_eq '' "$launcher_default" 'default deploy does not mutate Launcher'

launcher_cli_override="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  export MX_INSIGHT_SYNC_LAUNCHER=0
  load_env_file() { MX_INSIGHT_SYNC_LAUNCHER=1; export MX_INSIGHT_SYNC_LAUNCHER; }
  need() { :; }
  kubectl() { printf "%s" "$MX_INSIGHT_SYNC_LAUNCHER"; }
  ops_action internal-production status
' _ "$ROOT_DIR")"
assert_eq '00' "$launcher_cli_override" 'explicit Hub-only deploy flag overrides a persisted Launcher sync setting'

# ---------------------------------------------------------------------------
# Database provisioning
# ---------------------------------------------------------------------------

# The DSN must come from mx-common's `provision`, on stdout, so it can be
# captured. Everything else that command prints goes to stderr for this reason.
provision_dsn="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  manage_stub="$(mktemp)"
  cat >"$manage_stub" <<"STUB"
#!/usr/bin/env bash
echo "[mx-common] chatter that must not be captured" >&2
echo "postgres://mx_insight_hub:secret@mx-common-postgres.mx-common.svc.cluster.local:5432/mx_insight_hub"
STUB
  chmod +x "$manage_stub"
  ensure_hub_database "$manage_stub" >/dev/null 2>&1
  printf "%s" "$MX_INSIGHT_DATABASE_URL"
  rm -f "$manage_stub"
' _ "$ROOT_DIR")"
assert_eq \
  "postgres://mx_insight_hub:secret@mx-common-postgres.mx-common.svc.cluster.local:5432/mx_insight_hub" \
  "$provision_dsn" \
  "provisioned DSN is captured from stdout only"

# A provisioning step that returns something else must stop the deploy rather
# than write a nonsense DATABASE_URL into the Secret.
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  manage_stub="$(mktemp)"
  printf "#!/usr/bin/env bash\necho not-a-dsn\n" >"$manage_stub"
  chmod +x "$manage_stub"
  ensure_hub_database "$manage_stub"
' _ "$ROOT_DIR" >/dev/null 2>&1; then
  printf 'not ok - a malformed connection string was accepted\n' >&2
  exit 1
fi
printf 'ok - a malformed connection string stops the deploy\n'

# create_runtime_config must refuse to run before provisioning, instead of
# silently writing an empty DATABASE_URL.
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  unset MX_INSIGHT_DATABASE_URL
  kubectl() { return 0; }
  create_runtime_config
' _ "$ROOT_DIR" >/dev/null 2>&1; then
  printf 'not ok - runtime config was written without a provisioned database\n' >&2
  exit 1
fi
printf 'ok - runtime config requires provisioning to have run first\n'

# The deployment captures Docker's effective proxy state without sourcing or
# mutating systemd drop-ins. URLs remain inside the runtime Secret; only the
# namespaced Agent env receives the resulting JSON snapshot.
daemon_proxy_snapshot="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  DEPLOY_K8S_NODE_NAME="internal-node-1"
  docker() {
    case "$*" in
      "info --format {{json .}}")
        printf "%s" '\''{"HTTPProxy":"http://proxy-user:proxy-pass@127.0.0.1:7890","HttpsProxy":"http://127.0.0.1:7788","NoProxy":"localhost,.svc"}'\''
        ;;
      *) return 1 ;;
    esac
  }
  systemctl() {
    case "$*" in
      "show docker.service --property=DropInPaths --value --no-pager")
        printf "%s" "/etc/systemd/system/docker.service.d/proxy.conf /run/systemd/system/docker.service.d/runtime.conf"
        ;;
      *) return 1 ;;
    esac
  }
  docker_daemon_proxy_snapshot
' _ "$ROOT_DIR")"
MX_INSIGHT_TEST_DAEMON_PROXY_SNAPSHOT="$daemon_proxy_snapshot" node -e '
  const snapshot = JSON.parse(process.env.MX_INSIGHT_TEST_DAEMON_PROXY_SNAPSHOT)
  if (snapshot.version !== 1 || snapshot.configured !== true) process.exit(1)
  if (snapshot.sourceKind !== "docker-daemon-effective") process.exit(1)
  if (snapshot.runtimeKind !== "kubernetes-host-network") process.exit(1)
  if (snapshot.httpProxy !== "http://proxy-user:proxy-pass@127.0.0.1:7890") process.exit(1)
  if (snapshot.httpsProxy !== "http://127.0.0.1:7788") process.exit(1)
  if (snapshot.noProxy !== "localhost,.svc") process.exit(1)
  if (snapshot.nodeName !== "internal-node-1") process.exit(1)
  if (snapshot.sourceLocations.join("|") !== "/etc/systemd/system/docker.service.d/proxy.conf|/run/systemd/system/docker.service.d/runtime.conf") process.exit(1)
  if (!Number.isFinite(Date.parse(snapshot.observedAt))) process.exit(1)
'
printf 'ok - effective Docker daemon proxy is captured with provenance\n'

empty_daemon_proxy_snapshot="$(bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  docker() { return 1; }
  systemctl() { return 1; }
  docker_daemon_proxy_snapshot
' _ "$ROOT_DIR")"
MX_INSIGHT_TEST_DAEMON_PROXY_SNAPSHOT="$empty_daemon_proxy_snapshot" node -e '
  const snapshot = JSON.parse(process.env.MX_INSIGHT_TEST_DAEMON_PROXY_SNAPSHOT)
  if (snapshot.configured !== false) process.exit(1)
  if (snapshot.httpProxy !== null || snapshot.httpsProxy !== null || snapshot.noProxy !== null) process.exit(1)
  if (snapshot.nodeName !== null || snapshot.sourceLocations.length !== 0) process.exit(1)
'
printf 'ok - unavailable or unconfigured Docker daemon produces an explicit empty snapshot\n'

daemon_proxy_secret_marker="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-daemon-proxy-secret.XXXXXX")"
daemon_proxy_configmap_marker="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-daemon-proxy-configmap.XXXXXX")"
rm -f -- "$daemon_proxy_secret_marker" "$daemon_proxy_configmap_marker"
DAEMON_PROXY_SECRET_MARKER="$daemon_proxy_secret_marker" \
DAEMON_PROXY_CONFIGMAP_MARKER="$daemon_proxy_configmap_marker" \
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  DEPLOY_K8S_NODE_NAME="internal-node-1"
  export MX_INSIGHT_DATABASE_URL="postgres://hub:hub-secret@hub-db/hub"
  export MX_INSIGHT_ADMIN_TOKEN="admin-token-with-at-least-32-bytes"
  export MX_INSIGHT_API_KEY_PEPPER="api-key-pepper-with-at-least-32-bytes"
  export NIGHT_ALL_BASE_URL="http://night-all.internal"
  export MX_INSIGHT_SEARCH_READY=1
  docker() {
    printf "%s" '\''{"HttpProxy":"http://127.0.0.1:7890","HttpsProxy":"http://127.0.0.1:7890","NoProxy":"localhost,.cluster.local"}'\''
  }
  systemctl() { printf "%s" "/etc/systemd/system/docker.service.d/proxy.conf"; }
  kubectl() {
    local target="" argument
    case " $* " in
      *" create configmap mx-insight-hub-config "*) target="$DAEMON_PROXY_CONFIGMAP_MARKER" ;;
      *" create secret generic mx-insight-hub-secrets "*) target="$DAEMON_PROXY_SECRET_MARKER" ;;
    esac
    if [ -n "$target" ]; then
      for argument in "$@"; do
        case "$argument" in
          --from-literal=MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT=*)
            printf "%s" "${argument#--from-literal=MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT=}" >"$target"
            ;;
        esac
      done
    fi
    case " $* " in
      *" --dry-run=client -o yaml "*) printf "apiVersion: v1\\nkind: List\\nitems: []\\n" ;;
      *) while IFS= read -r _line; do :; done ;;
    esac
  }
  create_runtime_config
' _ "$ROOT_DIR"
if [ ! -s "$daemon_proxy_secret_marker" ]; then
  printf 'not ok - Docker daemon proxy snapshot was not stored in the runtime Secret\n' >&2
  exit 1
fi
if [ -e "$daemon_proxy_configmap_marker" ]; then
  printf 'not ok - Docker daemon proxy snapshot leaked into the runtime ConfigMap\n' >&2
  exit 1
fi
MX_INSIGHT_TEST_DAEMON_PROXY_SNAPSHOT="$(cat "$daemon_proxy_secret_marker")" node -e '
  const snapshot = JSON.parse(process.env.MX_INSIGHT_TEST_DAEMON_PROXY_SNAPSHOT)
  if (!snapshot.configured || snapshot.nodeName !== "internal-node-1") process.exit(1)
'
rm -f -- "$daemon_proxy_secret_marker"

for agent_manifest in 31-admin-api.yaml 32-projector.yaml 34-classifier.yaml; do
  grep -q 'name: MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT' "$ROOT_DIR/deploy/k8s/internal/$agent_manifest"
  grep -q 'key: MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT' "$ROOT_DIR/deploy/k8s/internal/$agent_manifest"
done
if rg -q 'MX_INSIGHT_AGENT_DOCKER_PROXY_SNAPSHOT' \
  "$ROOT_DIR/deploy/k8s/internal/30-public-api.yaml" \
  "$ROOT_DIR/deploy/k8s/internal/33-ingest.yaml"; then
  printf 'not ok - Docker daemon proxy snapshot escaped the Agent workloads\n' >&2
  exit 1
fi
runtime_config_function="$(sed -n '/^create_runtime_config() {/,/^}/p' "$ROOT_DIR/scripts/manage.sh")"
if grep -Eq -- '--from-literal=(HTTP_PROXY|HTTPS_PROXY|NO_PROXY)=' <<<"$runtime_config_function"; then
  printf 'not ok - Docker daemon proxy was injected as a process-wide proxy variable\n' >&2
  exit 1
fi
printf 'ok - Docker daemon proxy snapshot is Secret-wired only to Agent workloads\n'

# The production loader sources this example as Bash. Quote JSON as one value;
# otherwise Bash strips its inner quotes before the runtime validator sees it.
example_server_roots="$(
  bash -c '
    set -euo pipefail
    unset MX_INSIGHT_SERVER_FILE_ROOTS
    source "$1/.env.example"
    printf "%s" "$MX_INSIGHT_SERVER_FILE_ROOTS"
  ' _ "$ROOT_DIR"
)"
assert_eq \
  '{"shared-dir":"/shared_dir"}' \
  "$example_server_roots" \
  '.env.example preserves server-file root JSON when sourced'
MX_INSIGHT_SERVER_FILE_ROOTS_VALUE="$example_server_roots" \
  node --input-type=module -e '
    const { parseServerFileRoots } = await import(process.argv[1])
    parseServerFileRoots(process.env.MX_INSIGHT_SERVER_FILE_ROOTS_VALUE)
  ' "$ROOT_DIR/server/ingest/external/server-files.mjs"

# A configured JSON object must reach the ConfigMap byte-for-byte. Keeping a
# brace literal inside Bash `${VAR:-word}` appends one `}` when VAR is set.
server_roots_marker="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-server-roots.XXXXXX")"
rm -f -- "$server_roots_marker"
SERVER_ROOTS_MARKER="$server_roots_marker" \
MX_INSIGHT_SERVER_FILE_ROOTS='{"custom-root":"/srv/custom-files"}' \
bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  export MX_INSIGHT_DATABASE_URL="postgres://hub:hub-secret@hub-db/hub"
  export MX_INSIGHT_ADMIN_TOKEN="admin-token-with-at-least-32-bytes"
  export MX_INSIGHT_API_KEY_PEPPER="api-key-pepper-with-at-least-32-bytes"
  export NIGHT_ALL_BASE_URL="http://night-all.internal"
  export MX_INSIGHT_SEARCH_READY=1
  kubectl() {
    local argument
    for argument in "$@"; do
      case "$argument" in
        --from-literal=MX_INSIGHT_SERVER_FILE_ROOTS=*)
          printf "%s" "${argument#--from-literal=MX_INSIGHT_SERVER_FILE_ROOTS=}" >"$SERVER_ROOTS_MARKER"
          ;;
      esac
    done
    case " $* " in
      *" --dry-run=client -o yaml "*) printf "apiVersion: v1\\nkind: List\\nitems: []\\n" ;;
      *) while IFS= read -r _line; do :; done ;;
    esac
  }
  create_runtime_config
' _ "$ROOT_DIR"
assert_eq \
  '{"custom-root":"/srv/custom-files"}' \
  "$(cat "$server_roots_marker")" \
  'configured server-file root JSON is preserved exactly'
rm -f -- "$server_roots_marker"

# Reject malformed configuration before kubectl can overwrite the last known
# good ConfigMap and take the Admin listener down.
invalid_roots_kubectl_marker="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-invalid-roots.XXXXXX")"
invalid_roots_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-invalid-roots-error.XXXXXX")"
rm -f -- "$invalid_roots_kubectl_marker"
if INVALID_ROOTS_KUBECTL_MARKER="$invalid_roots_kubectl_marker" \
  MX_INSIGHT_SERVER_FILE_ROOTS='{"custom-root":"/srv/custom-files"}}' \
  bash -c '
    set -euo pipefail
    source "$1/scripts/manage.sh"
    export MX_INSIGHT_DATABASE_URL="postgres://hub:hub-secret@hub-db/hub"
    export MX_INSIGHT_ADMIN_TOKEN="admin-token-with-at-least-32-bytes"
    export MX_INSIGHT_API_KEY_PEPPER="api-key-pepper-with-at-least-32-bytes"
    export NIGHT_ALL_BASE_URL="http://night-all.internal"
    kubectl() { : >"$INVALID_ROOTS_KUBECTL_MARKER"; }
    create_runtime_config
  ' _ "$ROOT_DIR" >/dev/null 2>"$invalid_roots_error"; then
  printf 'not ok - malformed server-file root JSON was accepted\n' >&2
  exit 1
fi
if [ -e "$invalid_roots_kubectl_marker" ]; then
  printf 'not ok - malformed server-file root JSON reached kubectl\n' >&2
  exit 1
fi
grep -q 'must be a valid server-file root JSON object' "$invalid_roots_error"
rm -f -- "$invalid_roots_error"
printf 'ok - malformed server-file root JSON fails before ConfigMap mutation\n'

# Reject an invalid SQLite page delay before kubectl can overwrite the last
# known-good ConfigMap. The server validates this too, but deploy must fail
# before mutating cluster state.
for invalid_page_delay in -1 60001 1.5 invalid; do
  invalid_delay_kubectl_marker="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-invalid-delay.XXXXXX")"
  invalid_delay_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-invalid-delay-error.XXXXXX")"
  rm -f -- "$invalid_delay_kubectl_marker"
  if INVALID_DELAY_KUBECTL_MARKER="$invalid_delay_kubectl_marker" \
    MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS="$invalid_page_delay" \
    bash -c '
      set -euo pipefail
      source "$1/scripts/manage.sh"
      export MX_INSIGHT_DATABASE_URL="postgres://hub:hub-secret@hub-db/hub"
      export MX_INSIGHT_ADMIN_TOKEN="admin-token-with-at-least-32-bytes"
      export MX_INSIGHT_API_KEY_PEPPER="api-key-pepper-with-at-least-32-bytes"
      export NIGHT_ALL_BASE_URL="http://night-all.internal"
      kubectl() { : >"$INVALID_DELAY_KUBECTL_MARKER"; }
      create_runtime_config
    ' _ "$ROOT_DIR" >/dev/null 2>"$invalid_delay_error"; then
    printf 'not ok - invalid SQLite page delay %q was accepted\n' "$invalid_page_delay" >&2
    exit 1
  fi
  if [ -e "$invalid_delay_kubectl_marker" ]; then
    printf 'not ok - invalid SQLite page delay %q reached kubectl\n' "$invalid_page_delay" >&2
    exit 1
  fi
  grep -q 'MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS must be an integer from 0 to 60000' "$invalid_delay_error"
  rm -f -- "$invalid_delay_error"
done
printf 'ok - invalid SQLite page delays fail before ConfigMap mutation\n'

# The foreign Telegram reader is optional, but when configured it must be
# passed as a Secret key (never a ConfigMap value or terminal output).
tg_marker="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-tg-wired.XXXXXX")"
tg_output="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-tg-output.XXXXXX")"
rm -f -- "$tg_marker"
if ! TG_MARKER="$tg_marker" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  export MX_INSIGHT_DATABASE_URL="postgres://hub:hub-secret@hub-db/hub"
  export MX_INSIGHT_ADMIN_TOKEN="admin-token-with-at-least-32-bytes"
  export MX_INSIGHT_API_KEY_PEPPER="api-key-pepper-with-at-least-32-bytes"
  export NIGHT_ALL_BASE_URL="http://night-all.internal"
  export MX_INSIGHT_SEARCH_READY=1
  export MX_INSIGHT_TG_MONITOR_DATABASE_URL="postgres://tg-reader:tg-reader-password@tg-db/night_all"
  kubectl() {
    local argument
    for argument in "$@"; do
      case "$argument" in
        --from-literal=MX_INSIGHT_TG_MONITOR_DATABASE_URL=*) : >"$TG_MARKER" ;;
      esac
    done
    case " $* " in
      *" --dry-run=client -o yaml "*) printf "apiVersion: v1\\nkind: List\\nitems: []\\n" ;;
      *) while IFS= read -r _line; do :; done ;;
    esac
  }
  create_runtime_config
' _ "$ROOT_DIR" >"$tg_output" 2>&1; then
  printf 'not ok - configured Telegram reader was not accepted by runtime config\n' >&2
  exit 1
fi
if [ ! -f "$tg_marker" ]; then
  printf 'not ok - Telegram reader was not wired into the runtime Secret\n' >&2
  exit 1
fi
if grep -qE 'tg-reader-password|postgres://tg-reader' "$tg_output"; then
  printf 'not ok - runtime config output exposed the Telegram reader DSN\n' >&2
  exit 1
fi
rm -f -- "$tg_marker" "$tg_output"
printf 'ok - optional Telegram reader is Secret-wired without output exposure\n'

grep -q 'MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS.*60000' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q 'MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE.*1000' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q 'MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS.*1000' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q 'MX_INSIGHT_PROVINCE_PAGE_DELAY_MS.*2000' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q '^  ingest:' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q 'server/workers/ingest.mjs' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q '^  classifier:' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q 'server/workers/classifier.mjs' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q 'server/workers/classifier.mjs' "$ROOT_DIR/deploy/k8s/internal/34-classifier.yaml"
grep -q 'MX_INSIGHT_SERVER_FILE_GROUP_ID:-10' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q 'supplementalGroups: \[10\]' "$ROOT_DIR/deploy/k8s/internal/31-admin-api.yaml"
if rg -q 'supplementalGroups|server-files|/shared_dir' \
  "$ROOT_DIR/deploy/k8s/internal/30-public-api.yaml" \
  "$ROOT_DIR/deploy/k8s/internal/32-projector.yaml" \
  "$ROOT_DIR/deploy/k8s/internal/33-ingest.yaml"; then
  printf 'not ok - server-file host access escaped the Admin workload\n' >&2
  exit 1
fi
printf 'ok - server-file read group and mount stay scoped to Admin\n'
printf 'ok - local Compose wires the periodic external-pull worker\n'
grep -q -- '--from-literal=MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS=' "$ROOT_DIR/scripts/manage.sh"
grep -q -- '--from-literal=MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE=' "$ROOT_DIR/scripts/manage.sh"
grep -q -- '--from-literal=MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS=' "$ROOT_DIR/scripts/manage.sh"
grep -q -- '--from-literal=MX_INSIGHT_PROVINCE_PAGE_DELAY_MS=' "$ROOT_DIR/scripts/manage.sh"
printf 'ok - internal runtime ConfigMap wires external-pull scheduling controls\n'

if rg -q 'MX_INSIGHT_PROVIDER_MASTER_KEY' \
  "$ROOT_DIR/.env.example" \
  "$ROOT_DIR/deploy" \
  "$ROOT_DIR/scripts/manage.sh"; then
  printf 'not ok - retired source credential master key is still required by deployment\n' >&2
  exit 1
fi
printf 'ok - deployment has no separate source credential master key\n'

# ---------------------------------------------------------------------------
# Retired local PostgreSQL
# ---------------------------------------------------------------------------

if ops_action internal-production plan 2>/dev/null | grep -q '10-postgres.yaml'; then
  printf 'not ok - retired local PostgreSQL manifest is still in the plan\n' >&2
  exit 1
fi
printf 'ok - retired local PostgreSQL is absent from the plan\n'

# Destroying a database must never be a routine deploy step, so it requires an
# explicit confirmation token.
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  unset MX_INSIGHT_CONFIRM_DESTROY
  kubectl() { printf "unexpected kubectl call: %s\n" "$*" >&2; return 1; }
  decommission_local_postgres
' _ "$ROOT_DIR" >/dev/null 2>&1; then
  printf 'not ok - local PostgreSQL was decommissioned without confirmation\n' >&2
  exit 1
fi
printf 'ok - decommissioning requires explicit confirmation\n'

# ---------------------------------------------------------------------------
# Deploy cleanup
# ---------------------------------------------------------------------------

tmp_root="$(mktemp -d "${TMPDIR:-/tmp}/mx-insight-hub-manage-test.XXXXXX")"
mkdir -p "$tmp_root/tmp" "$tmp_root/work/hub/dist" "$tmp_root/work/dock/mx-launcher/ui-design/dist"
touch "$tmp_root/work/hub/dist/keep" "$tmp_root/work/dock/mx-launcher/ui-design/dist/keep"
if TEST_ROOT="$tmp_root/work" TMPDIR="$tmp_root/tmp" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  ROOT_DIR="${TEST_ROOT}/hub"
  ELECTRON_DOCK_DIR="${TEST_ROOT}/dock"
  RUNTIME_DIR="${TEST_ROOT}/runtime"
  docker() { return 0; }
  init_deploy_runtime
  acquire_deploy_lock
  touch "${DEPLOY_TMP_DIR}/partial-image.tar"
  false
' _ "$ROOT_DIR"; then
  printf 'not ok - failure cleanup test unexpectedly succeeded\n' >&2
  exit 1
fi
if find "$tmp_root/tmp" -mindepth 1 -print -quit | grep -q .; then
  printf 'not ok - deploy temp directory survived a failed command\n' >&2
  exit 1
fi
if [ ! -f "$tmp_root/work/hub/dist/keep" ] \
  || [ ! -f "$tmp_root/work/dock/mx-launcher/ui-design/dist/keep" ]; then
  printf 'not ok - deploy cleanup removed a pre-existing dist directory\n' >&2
  exit 1
fi
if [ -e "$tmp_root/work/runtime/internal-production-deploy.lock" ]; then
  printf 'not ok - deploy lock survived a failed command\n' >&2
  exit 1
fi
rm -rf -- "$tmp_root"
printf 'ok - failed deploy removes only its temp directory and lock\n'

# ---------------------------------------------------------------------------
# A rebuild that cannot be allocated must not be started
# ---------------------------------------------------------------------------

manage_source="$(cat "${ROOT_DIR}/scripts/manage.sh")"

assert_eq \
  "1" \
  "$(printf '%s' "$manage_source" | grep -c 'refusing to start a multi-hour rebuild that cannot be allocated')" \
  "reindex refuses to start past the Elasticsearch high watermark"

assert_eq \
  "1" \
  "$(printf '%s' "$manage_source" | grep -c '_cat/allocation?h=disk.percent')" \
  "reindex measures data node disk before spending hours of tokenizer time"

# ---------------------------------------------------------------------------
# Shared source must not invalidate the dependency install
# ---------------------------------------------------------------------------

dockerfile_source="$(cat "${ROOT_DIR}/Dockerfile")"

# A `file:` dependency is linked by manifest; its sources are read at build and
# run time, never at install time. Copying them above the install sent a one-line
# shared-source edit back to the registry for every dependency.
for stage_marker in "/workspace/mx-common/src" "COPY --from=mx_common src ./src"; do
  install_line="$(printf '%s' "$dockerfile_source" | grep -n 'RUN npm ci' | head -1 | cut -d: -f1)"
  source_line="$(printf '%s' "$dockerfile_source" | grep -Fn "$stage_marker" | head -1 | cut -d: -f1)"
  assert_eq \
    "after" \
    "$([ "$source_line" -gt "$install_line" ] && echo after || echo before)" \
    "shared source (${stage_marker}) is copied after the first npm ci"
done

assert_eq \
  "1" \
  "$(printf '%s' "$dockerfile_source" | grep -Fc 'COPY --from=build /workspace/mx-insight-hub/agent-market ./agent-market')" \
  "runtime image includes the code-owned Agent Market contracts imported at startup"

assert_eq \
  "3" \
  "$(printf '%s' "$dockerfile_source" | grep -Fc 'FROM node:22-bookworm-slim')" \
  "all image stages reuse the deploy-compatible Node 22 base tag"

assert_eq \
  "1" \
  "$(printf '%s' "$dockerfile_source" | grep -Fc 'requires Node >=22.18 for native TypeScript')" \
  "the build rejects a cached Node image without default-enabled native TypeScript stripping"

assert_eq \
  "1" \
  "$(printf '%s' "$dockerfile_source" | grep -Fc "import('./server/index.mjs')")" \
  "runtime image imports the full server entrypoint before deployment"
