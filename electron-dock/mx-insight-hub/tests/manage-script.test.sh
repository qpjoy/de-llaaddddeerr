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
