#!/usr/bin/env bash
# Offline caller integration: the shared helper has its own readiness/retry tests.
set -euo pipefail
HUB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mx-hub-control-plane-test.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/siblings/mx-launcher/scripts" "$TEST_DIR/missing"
cat >"$TEST_DIR/siblings/mx-launcher/scripts/k8s-control-plane.sh" <<'HELPER'
k8s_configure_proxy_bypass() {
  export NO_PROXY="${NO_PROXY:+$NO_PROXY,}fixture-api"
  export no_proxy="${no_proxy:+$no_proxy,}fixture-api"
  printf 'configure\n' >>"$CASE_DIR/events"
}
k8s_require_apiserver_ready() {
  k8s_configure_proxy_bypass
  PREFLIGHT_COUNT=$((${PREFLIGHT_COUNT:-0} + 1))
  printf 'gate:%s\n' "$PREFLIGHT_COUNT" >>"$CASE_DIR/events"
  [ "${HTTP_PROXY:-}" = http://external-proxy:7788 ] || die 'HTTP proxy changed'
  [ "${MX_INSIGHT_BUILD_PROXY:-}" = http://build-proxy:7788 ] || die 'build proxy changed'
  [ "${MX_INSIGHT_SYNC_LAUNCHER:-}" = 0 ] || die 'Launcher isolation lost'
  [ "${MX_SMOKE_DATA:-}" = 0 ] || die 'data smoke was enabled'
  case "$CASE_MODE:$PREFLIGHT_COUNT" in
    initial_failure:*|postbuild_failure:2) die 'control plane unavailable fixture' ;;
  esac
}
HELPER

run_deploy_case() {
  local mode="$1" action="$2" expected="$3" result=0
  local case_dir="$TEST_DIR/$mode-$action"
  mkdir "$case_dir"
  CASE_DIR="$case_dir" CASE_MODE="$mode" TEST_SIBLINGS="$TEST_DIR/siblings" \
    CASE_ACTION="$action" bash -c '
    source "$1/scripts/manage.sh"
    ELECTRON_DOCK_DIR="$TEST_SIBLINGS"
    export HTTP_PROXY=http://external-proxy:7788
    export MX_INSIGHT_BUILD_PROXY=http://build-proxy:7788
    export MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0
    export MX_INSIGHT_API_KEY_PEPPER=fixture-pepper
    need() { :; }
    require_production_env() { :; }
    load_env_file() {
      MX_INSIGHT_SYNC_LAUNCHER=1
      MX_SMOKE_DATA=1
      MX_INSIGHT_BUILD_PROXY=http://persisted-build-proxy:7788
    }
    kubectl() {
      printf "kubectl:%s\n" "$*" >>"$CASE_DIR/events"
      case "$*" in
        "--request-timeout=10s get nodes "*)
          [[ "$NO_PROXY" == *fixture-api* && "$no_proxy" == *fixture-api* ]] || exit 98
          printf "internal-node\n" ;;
        *) printf "unexpected Kubernetes mutation\n" >&2; exit 99 ;;
      esac
    }
    init_deploy_runtime() { printf "init\n" >>"$CASE_DIR/events"; }
    acquire_deploy_lock() { printf "lock\n" >>"$CASE_DIR/events"; }
    validate_existing_runtime_secret() { printf "credentials\n" >>"$CASE_DIR/events"; }
    node() { printf "credential-preflight\n" >>"$CASE_DIR/events"; }
    ensure_shared_data_plane() { printf "shared-data-plane\n" >>"$CASE_DIR/events"; }
    build_and_import_image() { printf "build\n" >>"$CASE_DIR/events"; }
    disable_projector_startup_rebuild_for_deploy() {
      if [ "${PREFLIGHT_COUNT:-0}" -eq 2 ]; then
        printf "apply-first-mutation\n" >>"$CASE_DIR/events"
        # The first mutation is sufficient to prove both successful gates and
        # their order. Stop here rather than emulate unrelated migration logic.
        exit 17
      fi
      printf "disable-rebuild-before-build\n" >>"$CASE_DIR/events"
    }
    ops_action internal-production "$CASE_ACTION"
  ' _ "$HUB_ROOT" >"$case_dir/output" 2>&1 || result=$?
  [ "$result" = "$expected" ] || {
    printf 'not ok - Hub preflight %s/%s: expected %s, got %s\n' "$mode" "$action" "$expected" "$result" >&2
    cat "$case_dir/output" >&2
    exit 1
  }
  case "$mode" in
    initial_failure)
      [ "$(cat "$case_dir/events")" = $'configure\ngate:1' ] ;;
    postbuild_failure)
      grep -q '^build$' "$case_dir/events"
      [ "$(tail -n 2 "$case_dir/events")" = $'configure\ngate:2' ]
      ! grep -q 'apply-first-mutation' "$case_dir/events" ;;
    healthy)
      [ "$(tail -n 3 "$case_dir/events")" = $'configure\ngate:2\napply-first-mutation' ]
      grep -q '^kubectl:--request-timeout=10s get nodes ' "$case_dir/events"
      ! grep -Eq 'scale |rollout|migration' "$case_dir/events" ;;
  esac
  printf 'ok - Hub preflight %s/%s\n' "$mode" "$action"
}

run_deploy_case initial_failure deploy 1
run_deploy_case initial_failure apply 1
run_deploy_case postbuild_failure deploy 1
run_deploy_case healthy deploy 17
run_deploy_case healthy apply 17

# The operator can inspect the API without Hub credentials, builds, or writes.
mkdir "$TEST_DIR/standalone"
CASE_DIR="$TEST_DIR/standalone" CASE_MODE=healthy TEST_SIBLINGS="$TEST_DIR/siblings" bash -c '
  source "$1/scripts/manage.sh"
  ELECTRON_DOCK_DIR="$TEST_SIBLINGS"
  unset MX_INSIGHT_ADMIN_TOKEN MX_INSIGHT_API_KEY_PEPPER
  export HTTP_PROXY=http://external-proxy:7788 MX_INSIGHT_BUILD_PROXY=http://build-proxy:7788
  export MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0
  need() { :; }
  load_env_file() { :; }
  require_production_env() { exit 98; }
  kubectl() { exit 99; }
  ops_action internal-production control-plane-preflight
  [[ "$NO_PROXY" == *fixture-api* && "$no_proxy" == *fixture-api* ]]
' _ "$HUB_ROOT" >"$TEST_DIR/standalone/output" 2>&1
[ "$(cat "$TEST_DIR/standalone/events")" = $'configure\ngate:1' ]
printf 'ok - standalone Hub preflight needs no Hub credentials and retains proxy exports\n'

# Missing sibling files affect only operations that need the shared preflight.
TEST_SIBLINGS="$TEST_DIR/missing" bash -c '
  source "$1/scripts/manage.sh"
  ELECTRON_DOCK_DIR="$TEST_SIBLINGS"
  need() { :; }
  load_env_file() { :; }
  kubectl() { exit 99; }
  compose() { :; }
  ops_action internal-production plan >/dev/null
  local_action status
' _ "$HUB_ROOT"
if TEST_SIBLINGS="$TEST_DIR/missing" bash -c '
  source "$1/scripts/manage.sh"
  ELECTRON_DOCK_DIR="$TEST_SIBLINGS"
  need() { :; }
  load_env_file() { :; }
  kubectl() { exit 99; }
  ops_action internal-production control-plane-preflight
' _ "$HUB_ROOT" >"$TEST_DIR/missing/output" 2>&1; then
  printf 'not ok - missing Kubernetes preflight helper was accepted\n' >&2
  exit 1
fi
grep -q 'restore the sibling mx-launcher scripts' "$TEST_DIR/missing/output"
printf 'ok - missing helper leaves Compose/plan usable and reports an actionable preflight error\n'

# Exercise the real shared helper through Hub's action once as well: a failed
# read may retry, but no application operation or production credential is used.
mkdir "$TEST_DIR/shared-helper"
CASE_DIR="$TEST_DIR/shared-helper" bash -c '
  source "$1/scripts/manage.sh"
  unset MX_INSIGHT_ADMIN_TOKEN MX_INSIGHT_API_KEY_PEPPER
  export MX_K8S_APISERVER_PREFLIGHT_ATTEMPTS=2 MX_K8S_APISERVER_PREFLIGHT_TIMEOUT=1s
  export MX_K8S_CONFIGURE_NO_PROXY=1
  export HTTP_PROXY=http://external-proxy:7788 MX_INSIGHT_BUILD_PROXY=http://build-proxy:7788
  export NO_PROXY=existing.example no_proxy=lower.example
  readiness_probe_calls=0
  load_env_file() { :; }
  sleep() { printf "retry-wait\n" >>"$CASE_DIR/events"; }
  kubectl() {
    printf "%s\n" "$*" >>"$CASE_DIR/events"
    case "$*" in
      "config view --minify "*) printf "https://hub-control.internal:6443" ;;
      "--request-timeout=1s get --raw=/readyz")
        readiness_probe_calls=$((readiness_probe_calls + 1))
        [ "$readiness_probe_calls" -eq 2 ] ;;
      *) exit 99 ;;
    esac
  }
  ops_action internal-production control-plane-preflight
  [ "$readiness_probe_calls" -eq 2 ]
  [[ ",$NO_PROXY," == *,hub-control.internal,* && ",$no_proxy," == *,hub-control.internal,* ]]
  [[ ",$NO_PROXY," == *,existing.example,* && ",$no_proxy," == *,lower.example,* ]]
  [ "$HTTP_PROXY" = http://external-proxy:7788 ]
  [ "$MX_INSIGHT_BUILD_PROXY" = http://build-proxy:7788 ]
' _ "$HUB_ROOT" >"$TEST_DIR/shared-helper/output" 2>&1
[ "$(grep -c -- '--request-timeout=1s get --raw=/readyz' "$TEST_DIR/shared-helper/events")" = 2 ]
[ "$(grep -c '^retry-wait$' "$TEST_DIR/shared-helper/events")" = 1 ]
printf 'ok - real shared helper retries only API reads and keeps Hub proxy state in the caller\n'
