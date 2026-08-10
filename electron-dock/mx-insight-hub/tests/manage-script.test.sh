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

# Rotation is overlap-safe: mint and persist the replacement before revoking
# the old key. Stubs record externally visible ordering while the real decision
# helper continues to run in Node.
rotation_events="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-key-rotation.XXXXXX")"
rotation_old_secret='mih_live_bootstrap_old_5678'
rotation_old_encoded="$(printf '%s' "$rotation_old_secret" | base64)"
ROTATION_EVENTS="$rotation_events" \
ROTATION_OLD_ENCODED="$rotation_old_encoded" \
MX_INSIGHT_ADMIN_TOKEN='admin-token-with-at-least-32-bytes' \
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
  curl() {
    case "$*" in
      *"/revoke"*) printf "revoke\n" >>"$ROTATION_EVENTS" ;;
      *"/internal/v1/admin/api-keys"*)
        printf "%s" '\''{"data":[{"id":"22222222-2222-4222-8222-222222222222","prefix":"mih_live_bootstrap_old","lastFour":"5678","status":"active","effectiveStatus":"expired","expiresAt":"2000-01-01T00:00:00.000Z"}]}'\''
        ;;
      *) return 1 ;;
    esac
  }
  node() {
    case "$*" in
      *"scripts/provision.mjs"*)
        printf "mint\n" >>"$ROTATION_EVENTS"
        printf "mih_live_bootstrap_new_9999\ntenant-id\nconsumer-id\n"
        ;;
      *) command node "$@" ;;
    esac
  }
  ensure_default_api_key
' _ "$ROOT_DIR"
assert_eq $'mint\npersist\nrevoke' "$(cat "$rotation_events")" 'bootstrap rotation persists before revoke'
rm -f -- "$rotation_events"

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
grep -q '^  ingest:' "$ROOT_DIR/deploy/compose/docker-compose.yml"
grep -q 'server/workers/ingest.mjs' "$ROOT_DIR/deploy/compose/docker-compose.yml"
printf 'ok - local Compose wires the periodic external-pull worker\n'
grep -q -- '--from-literal=MX_INSIGHT_EXTERNAL_PULL_INTERVAL_MS=' "$ROOT_DIR/scripts/manage.sh"
grep -q -- '--from-literal=MX_INSIGHT_EXTERNAL_PULL_BATCH_SIZE=' "$ROOT_DIR/scripts/manage.sh"
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
