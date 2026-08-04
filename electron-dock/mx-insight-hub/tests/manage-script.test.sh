#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=../scripts/manage.sh
source "${ROOT_DIR}/scripts/manage.sh"

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"
  if [ "$expected" != "$actual" ]; then
    printf 'not ok - %s: expected %q, got %q\n' "$label" "$expected" "$actual" >&2
    exit 1
  fi
  printf 'ok - %s\n' "$label"
}

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

runtime_calls=""
run_ctr() {
  if [ "$*" = "images ls -q" ]; then
    printf '%s\n' docker.io/library/postgres:16-bookworm
  else
    runtime_calls="${runtime_calls}ctr:$*;"
  fi
}
docker() {
  runtime_calls="${runtime_calls}docker:$*;"
}
ensure_k8s_runtime_image postgres:16-bookworm
assert_eq "" "$runtime_calls" "existing runtime image is reused"

storage_calls=""
mock_pvc_phase=Pending
kubectl() {
  case "$*" in
    *"get pvc ${POSTGRES_PVC_NAME} -o jsonpath={.status.phase}"*)
      printf '%s' "$mock_pvc_phase"
      ;;
    *"get pvc ${POSTGRES_PVC_NAME} -o jsonpath={.spec.storageClassName}"*|\
    *"get pvc ${POSTGRES_PVC_NAME} -o jsonpath={.spec.volumeName}"*|\
    *"get pv ${POSTGRES_PV_NAME} -o jsonpath={.status.phase}"*)
      :
      ;;
    *)
      storage_calls="${storage_calls}kubectl:$*;"
      ;;
  esac
}
k8s_default_storage_class() { :; }
ensure_postgres_local_pv() { storage_calls="${storage_calls}ensure-local-pv;"; }
ensure_postgres_storage
assert_eq "ensure-local-pv;" "$storage_calls" "pending classless PVC selects retained local PV"

storage_calls=""
k8s_default_storage_class() { printf '%s' fast-storage; }
ensure_postgres_storage
assert_eq \
  "ensure-local-pv;" \
  "$storage_calls" \
  "existing classless Pending PVC binds locally without deletion"
storage_calls=""
mock_pvc_phase=""
ensure_postgres_storage
assert_eq "" "$storage_calls" "new PVC uses the available default StorageClass"
mock_pvc_phase=Pending
k8s_default_storage_class() { :; }

released_log="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-released-pv.XXXXXX")"
PV_LOG="$released_log" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  prepare_postgres_host_path() { printf "prepare\n" >>"$PV_LOG"; }
  validate_postgres_local_pv() { printf "validate\n" >>"$PV_LOG"; }
  kubectl() {
    printf "kubectl:%s\n" "$*" >>"$PV_LOG"
    case "$*" in
      *"get pv ${POSTGRES_PV_NAME} -o jsonpath={.status.phase}"*)
        printf Released
        ;;
    esac
  }
  ensure_postgres_local_pv
' _ "$ROOT_DIR"
validate_line="$(grep -n '^validate$' "$released_log" | cut -d: -f1)"
delete_line="$(grep -n "delete pv ${POSTGRES_PV_NAME}" "$released_log" | cut -d: -f1)"
apply_line="$(grep -n '08-postgres-local-pv.yaml' "$released_log" | cut -d: -f1)"
if [ -z "$validate_line" ] || [ -z "$delete_line" ] || [ -z "$apply_line" ] \
  || [ "$validate_line" -ge "$delete_line" ] || [ "$delete_line" -ge "$apply_line" ]; then
  printf 'not ok - released PV was not validated before safe metadata rebuild\n' >&2
  sed -n '1,120p' "$released_log" >&2
  exit 1
fi
rm -f -- "$released_log"
printf 'ok - released retained PV is validated before metadata rebuild\n'

secret_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-secret-drift.XXXXXX")"
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  export MX_INSIGHT_POSTGRES_PASSWORD=current-postgres-password-123456
  export MX_INSIGHT_API_KEY_PEPPER=current-api-key-pepper-1234567890
  old_password="old-postgres-password-1234567890"
  old_encoded="$(encoded_secret_value "$old_password")"
  kubectl() {
    case "$*" in
      *"postgres-password"*)
        printf "%s" "$old_encoded"
        ;;
      *"get secret mx-insight-hub-secrets"*)
        printf '%s' secret/mx-insight-hub-secrets
        ;;
      *)
        return 1
        ;;
    esac
  }
  validate_existing_runtime_secret
' _ "$ROOT_DIR" 2>"$secret_error"; then
  printf 'not ok - retained PostgreSQL password drift was accepted\n' >&2
  exit 1
fi
grep -q 'automatic rotation is blocked' "$secret_error"
if grep -qE 'current-postgres-password|old-postgres-password' "$secret_error"; then
  printf 'not ok - secret drift error exposed a secret value\n' >&2
  exit 1
fi
rm -f -- "$secret_error"
printf 'ok - retained PostgreSQL password drift fails before Secret overwrite\n'

bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  export MX_INSIGHT_POSTGRES_PASSWORD=current-postgres-password-123456
  export MX_INSIGHT_API_KEY_PEPPER=current-api-key-pepper-1234567890
  postgres_encoded="$(encoded_secret_value "$MX_INSIGHT_POSTGRES_PASSWORD")"
  pepper_encoded="$(encoded_secret_value "$MX_INSIGHT_API_KEY_PEPPER")"
  kubectl() {
    case "$*" in
      *"postgres-password"*) printf "%s" "$postgres_encoded" ;;
      *"MX_INSIGHT_API_KEY_PEPPER"*) printf "%s" "$pepper_encoded" ;;
      *"get secret mx-insight-hub-secrets"*) printf "%s" secret/mx-insight-hub-secrets ;;
      *) return 1 ;;
    esac
  }
  validate_existing_runtime_secret
' _ "$ROOT_DIR"
printf 'ok - unchanged retained Secret remains deployable\n'

missing_secret_error="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-missing-secret.XXXXXX")"
if bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    case "$*" in
      *"get secret mx-insight-hub-secrets"*) return 0 ;;
      *"get pvc ${POSTGRES_PVC_NAME} -o jsonpath={.status.phase}"*) printf Bound ;;
      *) return 0 ;;
    esac
  }
  validate_existing_runtime_secret
' _ "$ROOT_DIR" 2>"$missing_secret_error"; then
  printf 'not ok - missing Secret was reconstructed over retained storage\n' >&2
  exit 1
fi
grep -q 'retained PostgreSQL storage exists' "$missing_secret_error"
rm -f -- "$missing_secret_error"
printf 'ok - missing Secret with retained storage fails closed\n'

if ops_action internal-production plan | grep -q "$POSTGRES_PV_NAME"; then
  printf 'not ok - conditional local PV leaked into unconditional plan output\n' >&2
  exit 1
fi
printf 'ok - static local PV is absent from unconditional plan output\n'

run_pod_security_case() {
  local pod_user="$1"
  local log_path="$2"
  POD_USER="$pod_user" POD_SECURITY_LOG="$log_path" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  kubectl() {
    case "$*" in
      *"get statefulset mx-insight-hub-postgres"*"containers"*)
        :
        ;;
      *"get statefulset mx-insight-hub-postgres"*)
        printf 999
        ;;
      *"get pod ${POSTGRES_POD_NAME}"*"-o name"*)
        printf "pod/%s" "$POSTGRES_POD_NAME"
        ;;
      *"get pod ${POSTGRES_POD_NAME}"*)
        printf "%s" "$POD_USER"
        ;;
      *"delete pod ${POSTGRES_POD_NAME}"*)
        printf "%s\n" "$*" >>"$POD_SECURITY_LOG"
        ;;
      *)
        return 1
        ;;
    esac
  }
  reconcile_postgres_pod_security_context
' _ "$ROOT_DIR"
}

pod_security_log="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-pod-security.XXXXXX")"
run_pod_security_case "" "$pod_security_log"
grep -q "delete pod ${POSTGRES_POD_NAME} --ignore-not-found --wait=false" "$pod_security_log"
: >"$pod_security_log"
run_pod_security_case 999 "$pod_security_log"
if [ -s "$pod_security_log" ]; then
  printf 'not ok - current UID 999 PostgreSQL Pod was unnecessarily replaced\n' >&2
  exit 1
fi
rm -f -- "$pod_security_log"
printf 'ok - only a legacy root PostgreSQL Pod is replaced without touching storage\n'

ops_log="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-ops-log.XXXXXX")"
OPS_LOG="$ops_log" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  export MX_INSIGHT_ADMIN_TOKEN=admin-token-at-least-32-characters
  export MX_INSIGHT_API_KEY_PEPPER=api-key-pepper-at-least-32-characters
  export MX_INSIGHT_POSTGRES_PASSWORD=postgres-password-at-least-24
  export NIGHT_ALL_BASE_URL=http://10.88.88.88:13141
  export MX_INSIGHT_SYNC_LAUNCHER=0
  ensure_k8s_runtime_image() { printf "ensure-image:%s\n" "$1" >>"$OPS_LOG"; }
  prepare_postgres_host_path() { printf "prepare-host-path\n" >>"$OPS_LOG"; }
  kubectl() {
    printf "kubectl:%s\n" "$*" >>"$OPS_LOG"
    case "$*" in
      *"get secret mx-insight-hub-secrets"*)
        return 0
        ;;
      *"create configmap"*|*"create secret"*)
        printf "apiVersion: v1\nkind: List\nitems: []\n"
        ;;
      *"apply -f -"*)
        cat >/dev/null
        ;;
      *"get pvc ${POSTGRES_PVC_NAME} -o jsonpath={.status.phase}"*)
        printf Pending
        ;;
      *"get pvc ${POSTGRES_PVC_NAME} -o jsonpath={.spec.storageClassName}"*|\
      *"get pvc ${POSTGRES_PVC_NAME} -o jsonpath={.spec.volumeName}"*|\
      *"get pv ${POSTGRES_PV_NAME} -o jsonpath={.status.phase}"*)
        :
        ;;
      *"get storageclass -o jsonpath="*)
        :
        ;;
      *"get statefulset mx-insight-hub-postgres"*"containers"*)
        :
        ;;
      *"get statefulset mx-insight-hub-postgres"*)
        printf 999
        ;;
      *"get pod ${POSTGRES_POD_NAME}"*"-o name"*)
        :
        ;;
    esac
  }
  apply_k8s
' _ "$ROOT_DIR"
pv_line="$(grep -n '08-postgres-local-pv.yaml' "$ops_log" | head -n 1 | cut -d: -f1)"
statefulset_line="$(grep -n '10-postgres.yaml' "$ops_log" | head -n 1 | cut -d: -f1)"
if [ -z "$pv_line" ] || [ -z "$statefulset_line" ] || [ "$pv_line" -ge "$statefulset_line" ]; then
  printf 'not ok - deploy did not reconcile the local PV before PostgreSQL\n' >&2
  sed -n '1,160p' "$ops_log" >&2
  exit 1
fi
grep -q '^ensure-image:postgres:16-bookworm$' "$ops_log"
rm -f -- "$ops_log"
printf 'ok - apply preloads PostgreSQL and binds storage before StatefulSet rollout\n'

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

image_log="$(mktemp "${TMPDIR:-/tmp}/mx-insight-hub-runtime-image.XXXXXX")"
image_tmp="$(mktemp -d "${TMPDIR:-/tmp}/mx-insight-hub-runtime-image-tmp.XXXXXX")"
IMAGE_LOG="$image_log" TMPDIR="$image_tmp" bash -c '
  set -euo pipefail
  source "$1/scripts/manage.sh"
  containerd_image_ref_present() { return 1; }
  containerd_import_docker_image() { :; }
  docker() {
    printf "%s\n" "$*" >>"$IMAGE_LOG"
    case "$*" in
      "image inspect "*) return 1 ;;
      *) return 0 ;;
    esac
  }
  init_deploy_runtime
  ensure_k8s_runtime_image postgres:16-bookworm
' _ "$ROOT_DIR"
grep -q '^pull postgres:16-bookworm$' "$image_log"
grep -q '^image rm postgres:16-bookworm$' "$image_log"
if find "$image_tmp" -mindepth 1 -print -quit | grep -q .; then
  printf 'not ok - runtime image staging temp survived cleanup\n' >&2
  exit 1
fi
rm -f -- "$image_log"
rmdir "$image_tmp"
printf 'ok - Docker-only runtime image pulled by deploy is removed after import\n'
