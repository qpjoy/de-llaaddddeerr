#!/usr/bin/env bash
# Offline behavioural tests: no cluster, real sleeping, or deployment writes.
set -euo pipefail
HUB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mx-hub-admin-freeze-test.XXXXXX")"
trap 'rm -rf -- "$TEST_DIR"' EXIT

run_case() {
  local mode="$1" expected="$2" result=0
  mkdir "$TEST_DIR/$mode"
  CASE_DIR="$TEST_DIR/$mode" CASE_MODE="$mode" bash -c '
    source "$1/scripts/manage.sh"
    sleep() {
      case "$CASE_MODE" in
        stalled|read_failure|pod_read_failure) SECONDS=$((SECONDS + 120)) ;;
        observed_then_read_failure) SECONDS=$((SECONDS + 60)) ;;
        *) SECONDS=$((SECONDS + $1)) ;;
      esac
    }
    kubectl() {
      printf "%s\n" "$*" >>"$CASE_DIR/calls"
      local count=0
      if [[ "$*" == *"get deployment/mx-insight-hub-admin"* ]]; then
        [ ! -f "$CASE_DIR/deployment-count" ] || read -r count <"$CASE_DIR/deployment-count"
        count=$((count + 1)); printf "%s\n" "$count" >"$CASE_DIR/deployment-count"
        case "$CASE_MODE" in
          stalled) printf "admin-uid|418|417|0|1|1" ;;
          converging)
            case "$count" in
              1) printf "admin-uid|418|417|0|1|1" ;;
              2) printf "admin-uid|418|418|0|1|1" ;;
              *) printf "admin-uid|418|418|0|0|0" ;;
            esac ;;
          replaced) printf "other-uid|418|418|0|0|0" ;;
          rescaled) printf "admin-uid|419|419|1|0|0" ;;
          late_rescale)
            if [ "$count" = 1 ]; then printf "admin-uid|418|418|0|0|0"
            else printf "admin-uid|419|419|1|0|0"; fi ;;
          late_replacement)
            if [ "$count" = 1 ]; then printf "admin-uid|418|418|0|0|0"
            else printf "other-uid|418|418|0|0|0"; fi ;;
          malformed) printf "admin-uid|418|invalid|0|0|0" ;;
          missing) : ;;
          read_failure) printf "PRIVATE_API_ERROR" >&2; return 1 ;;
          transient_read)
            if [ "$count" = 1 ]; then printf "PRIVATE_API_ERROR" >&2; return 1; fi
            printf "admin-uid|418|418|0|0|0" ;;
          observed_then_read_failure)
            if [ "$count" = 1 ]; then printf "admin-uid|418|417|0|1|1"
            else printf "PRIVATE_API_ERROR" >&2; return 1; fi ;;
          missing_status) printf "admin-uid|418|418|0||" ;;
          *) printf "admin-uid|418|418|0|0|0" ;;
        esac
      elif [[ "$*" == *"get pods"* ]]; then
        [ ! -f "$CASE_DIR/pod-count" ] || read -r count <"$CASE_DIR/pod-count"
        count=$((count + 1)); printf "%s\n" "$count" >"$CASE_DIR/pod-count"
        case "$CASE_MODE" in
          deleting) [ "$count" -gt 1 ] || printf "pod/admin-terminating\n" ;;
          pod_read_failure) printf "PRIVATE_API_ERROR" >&2; return 1 ;;
        esac
      else
        printf "unexpected kubectl command\n" >&2; return 97
      fi
    }
    k8s_wait_for_admin_stop admin-uid
  ' _ "$HUB_ROOT" >"$TEST_DIR/$mode/output" 2>&1 || result=$?
  if [ "$result" -ne "$expected" ]; then
    printf 'not ok - Admin freeze %s: expected %s, got %s\n' "$mode" "$expected" "$result" >&2
    cat "$TEST_DIR/$mode/output" >&2
    exit 1
  fi
  if grep -Eq 'PRIVATE_API_ERROR| --force| delete | scale |rollout|mx-launcher| logs |describe' "$TEST_DIR/$mode/output" "$TEST_DIR/$mode/calls"; then
    printf 'not ok - Admin freeze %s exposed private errors or mutated workloads\n' "$mode" >&2
    exit 1
  fi
  if grep -v -- '--request-timeout=[1-5]s' "$TEST_DIR/$mode/calls" >/dev/null; then
    printf 'not ok - Admin freeze %s used an unbounded read\n' "$mode" >&2
    exit 1
  fi
  printf 'ok - Admin freeze %s\n' "$mode"
}

run_case stalled 1
grep -q 'phase=controller_observation' "$TEST_DIR/stalled/output"
grep -q 'after 120s' "$TEST_DIR/stalled/output"
! grep -q 'get pods' "$TEST_DIR/stalled/calls"
run_case converging 0
grep -q 'phase=controller_observation' "$TEST_DIR/converging/output"
grep -q 'phase=replica_scale_down' "$TEST_DIR/converging/output"
grep -q 'freeze confirmed' "$TEST_DIR/converging/output"
run_case already_gone 0
run_case missing_status 0
run_case deleting 0
grep -q 'phase=pod_termination' "$TEST_DIR/deleting/output"
run_case replaced 1
run_case rescaled 1
run_case late_rescale 1
run_case late_replacement 1
run_case malformed 1
run_case missing 1
run_case read_failure 1
grep -q 'phase=deployment_read_unavailable' "$TEST_DIR/read_failure/output"
run_case transient_read 0
run_case observed_then_read_failure 1
grep -q 'phase=deployment_read_unavailable' "$TEST_DIR/observed_then_read_failure/output"
grep -q 'Deployment controller' "$TEST_DIR/observed_then_read_failure/output"
grep -q '418' "$TEST_DIR/observed_then_read_failure/output"
grep -q '417' "$TEST_DIR/observed_then_read_failure/output"
run_case pod_read_failure 1
grep -q 'phase=pod_read_unavailable' "$TEST_DIR/pod_read_failure/output"

# API failure is not a missing Deployment. Exercise the production caller so
# a failed inspection cannot bypass the freeze and reach the migration writer.
if CASE_DIR="$TEST_DIR" bash -c '
  source "$1/scripts/manage.sh"
  for helper in disable_projector_startup_rebuild_for_deploy validate_existing_runtime_secret \
    preserve_existing_justone_runtime_config preserve_existing_tikhub_runtime_config \
    preserve_existing_peripheral_runtime_config preserve_existing_news_runtime_config \
    discover_hanlp_url create_runtime_config create_model_key_secret sync_launcher_secret \
    warn_local_postgres_present ensure_acquisition_history_indexes; do
    eval "$helper() { :; }"
  done
  kubectl() {
    printf "%s\n" "$*" >>"$CASE_DIR/inspection-calls"
    if [[ "$*" == *"get deployment/mx-insight-hub-admin"* ]]; then
      printf "PRIVATE_API_ERROR" >&2; return 23
    fi
  }
  terminate_active_migration_job() { printf "migration-reached\n" >>"$CASE_DIR/inspection-calls"; }
  render_file() { printf "render:%s\n" "$*" >>"$CASE_DIR/inspection-calls"; }
  apply_k8s
' _ "$HUB_ROOT" >"$TEST_DIR/inspection-output" 2>&1; then
  printf 'not ok - failed Admin inspection bypassed the freeze\n' >&2
  exit 1
fi
grep -q 'could not inspect Hub Admin before the staged rollout' "$TEST_DIR/inspection-output"
! grep -Eq 'migration-reached|20-migration-job| scale |mx-launcher' "$TEST_DIR/inspection-calls"
! grep -q 'PRIVATE_API_ERROR' "$TEST_DIR/inspection-output"
printf 'ok - failed Admin inspection never reaches scale or migration\n'

# Run the real apply -> die -> EXIT cleanup path, including a competing change
# between the cleanup read and its conditional scale write.
for mode in owned initial_three initial_zero transient_restore_read replaced rescaled unavailable conflict initial_conflict initial_replacement initial_unknown; do
  mkdir "$TEST_DIR/trap-$mode"
  result=0
  CASE_DIR="$TEST_DIR/trap-$mode" CASE_MODE="$mode" bash -c '
    source "$1/scripts/manage.sh"
    trap cleanup_deploy_runtime EXIT
    sleep() {
      if [ -f "$CASE_DIR/freeze-wait-ended" ]; then
        SECONDS=$((SECONDS + $1))
      else
        SECONDS=$((SECONDS + 120))
        : >"$CASE_DIR/freeze-wait-ended"
      fi
    }
    docker() { :; }
    for helper in disable_projector_startup_rebuild_for_deploy validate_existing_runtime_secret \
      preserve_existing_justone_runtime_config preserve_existing_tikhub_runtime_config \
      preserve_existing_peripheral_runtime_config preserve_existing_news_runtime_config \
      discover_hanlp_url create_runtime_config create_model_key_secret sync_launcher_secret \
      warn_local_postgres_present ensure_acquisition_history_indexes; do
      eval "$helper() { :; }"
    done
    kubectl() {
      printf "%s\n" "$*" >>"$CASE_DIR/calls"
      case "$*" in
        *"--ignore-not-found"*"jsonpath={.metadata.uid}|{.metadata.resourceVersion}|{.spec.replicas}"*)
          case "$CASE_MODE" in
            initial_three) printf "admin-uid|900|3" ;;
            initial_zero) printf "admin-uid|900|0" ;;
            *) printf "admin-uid|900|1" ;;
          esac ;;
        *"scale deployment/mx-insight-hub-admin --replicas=0"*)
          [[ "$*" == *"--resource-version=900 --request-timeout=10s"* ]] || return 97
          case "$CASE_MODE" in
            initial_conflict|initial_replacement|initial_unknown)
              [ "$CASE_MODE" != initial_unknown ] || printf "unknown\n" >"$CASE_DIR/scale-outcome"
              printf "PRIVATE_API_ERROR" >&2; return 23 ;;
          esac ;;
        *"jsonpath={.metadata.uid}|{.spec.replicas}"*)
          local restore_reads=0
          [ ! -f "$CASE_DIR/restore-reads" ] || read -r restore_reads <"$CASE_DIR/restore-reads"
          restore_reads=$((restore_reads + 1))
          printf "%s\n" "$restore_reads" >"$CASE_DIR/restore-reads"
          printf "%s\n" "$SECONDS" >>"$CASE_DIR/restore-read-times"
          [[ "$*" == *"--request-timeout="* ]] || return 97
          if [[ "$*" =~ --request-timeout=([0-9]+)s ]]; then
            [ "${BASH_REMATCH[1]}" -ge 1 ] && [ "${BASH_REMATCH[1]}" -le 10 ] || return 97
          else
            return 97
          fi
          case "$CASE_MODE" in
            replaced) printf "other-uid|0|1235" ;;
            rescaled) printf "admin-uid|2|1235" ;;
            unavailable) printf "PRIVATE_API_ERROR" >&2; return 23 ;;
            transient_restore_read)
              if [ "$restore_reads" = 1 ]; then printf "PRIVATE_API_ERROR" >&2; return 23; fi
              printf "admin-uid|0|1234" ;;
            *) printf "admin-uid|0|1234" ;;
          esac ;;
        *"jsonpath={.metadata.uid}|"*)
          case "$CASE_MODE" in
            replaced) printf "other-uid|418|417|0|1|1" ;;
            rescaled) printf "admin-uid|419|418|2|1|1" ;;
            *) printf "admin-uid|418|417|0|1|1" ;;
          esac ;;
        *"scale deployment/mx-insight-hub-admin --replicas=3"*)
          [ "$CASE_MODE" = initial_three ] || return 97
          [[ "$*" == *"--current-replicas=0 --resource-version=1234 --request-timeout=10s"* ]] || return 97
          printf "accepted\n" >>"$CASE_DIR/restored" ;;
        *"scale deployment/mx-insight-hub-admin --replicas=1"*)
          [ "$CASE_MODE" != initial_three ] && [ "$CASE_MODE" != initial_zero ] || return 97
          [[ "$*" == *"--current-replicas=0 --resource-version=1234 --request-timeout=10s"* ]] || return 97
          if [ "$CASE_MODE" = conflict ]; then printf "PRIVATE_API_ERROR" >&2; return 23; fi
          printf "accepted\n" >>"$CASE_DIR/restored" ;;
      esac
    }
    terminate_active_migration_job() { printf "migration-reached\n" >>"$CASE_DIR/calls"; }
    render_file() { printf "render:%s\n" "$*" >>"$CASE_DIR/calls"; }
    apply_k8s
  ' _ "$HUB_ROOT" >"$TEST_DIR/trap-$mode/output" 2>&1 || result=$?
  [ "$result" = 1 ] || { printf 'not ok - %s cleanup lost deployment exit status\n' "$mode" >&2; exit 1; }
  ! grep -Eq 'PRIVATE_API_ERROR|freeze confirmed' "$TEST_DIR/trap-$mode/output"
  ! grep -Eq 'migration-reached|20-migration-job|mx-launcher' "$TEST_DIR/trap-$mode/calls"
  case "$mode" in
    owned|initial_three|transient_restore_read)
      [ -f "$TEST_DIR/trap-$mode/restored" ]
      ! grep -q 'Admin availability is unconfirmed' "$TEST_DIR/trap-$mode/output"
      if [ "$mode" = transient_restore_read ]; then
        [ "$(cat "$TEST_DIR/trap-$mode/restore-reads")" = 2 ]
        [ "$(grep -c 'scale deployment/mx-insight-hub-admin --replicas=1' "$TEST_DIR/trap-$mode/calls")" = 1 ]
      elif [ "$mode" = initial_three ]; then
        [ "$(grep -c 'scale deployment/mx-insight-hub-admin --replicas=3' "$TEST_DIR/trap-$mode/calls")" = 1 ]
        ! grep -q 'scale deployment/mx-insight-hub-admin --replicas=1' "$TEST_DIR/trap-$mode/calls"
      fi ;;
    initial_zero)
      [ ! -f "$TEST_DIR/trap-$mode/restored" ]
      ! grep -Eq 'scale deployment/mx-insight-hub-admin --replicas=[1-9]' "$TEST_DIR/trap-$mode/calls"
      [ "$(cat "$TEST_DIR/trap-$mode/restore-reads")" = 1 ]
      ! grep -q 'Admin availability is unconfirmed' "$TEST_DIR/trap-$mode/output"
      grep -Eq '(already|original|previous|initial|原).*(zero|0)|zero.*(original|previous|initial)' "$TEST_DIR/trap-$mode/output" ;;
    conflict)
      [ ! -f "$TEST_DIR/trap-$mode/restored" ]
      [ "$(grep -c 'scale deployment/mx-insight-hub-admin --replicas=1' "$TEST_DIR/trap-$mode/calls")" = 1 ]
      grep -q 'Admin availability is unconfirmed' "$TEST_DIR/trap-$mode/output" ;;
    initial_*)
      ! grep -q 'scale deployment/mx-insight-hub-admin --replicas=1' "$TEST_DIR/trap-$mode/calls"
      ! grep -q 'jsonpath={.metadata.uid}|{.metadata.generation}' "$TEST_DIR/trap-$mode/calls"
      grep -q 'scale-to-zero was not confirmed' "$TEST_DIR/trap-$mode/output"
      [ "$(grep -c 'scale deployment/mx-insight-hub-admin --replicas=0' "$TEST_DIR/trap-$mode/calls")" = 1 ] ;;
    unavailable)
      ! grep -q 'scale deployment/mx-insight-hub-admin --replicas=1' "$TEST_DIR/trap-$mode/calls"
      restore_reads="$(cat "$TEST_DIR/trap-$mode/restore-reads")"
      [ "$restore_reads" -ge 2 ] && [ "$restore_reads" -le 16 ]
      first_read="$(head -n 1 "$TEST_DIR/trap-$mode/restore-read-times")"
      last_read="$(tail -n 1 "$TEST_DIR/trap-$mode/restore-read-times")"
      [ "$((last_read - first_read))" -le 30 ]
      grep -q 'Admin availability is unconfirmed' "$TEST_DIR/trap-$mode/output" ;;
    *) ! grep -q 'scale deployment/mx-insight-hub-admin --replicas=1' "$TEST_DIR/trap-$mode/calls" ;;
  esac
  printf 'ok - Admin freeze EXIT cleanup %s\n' "$mode"
done

# A failed metadata request is not an empty workload list. Also consume the
# complete kubectl output under pipefail while retaining only bounded rows.
for mode in deployment_failure_empty_pods both_reads_fail large_pod_list; do
  mkdir "$TEST_DIR/diagnostic-$mode"
  CASE_DIR="$TEST_DIR/diagnostic-$mode" CASE_MODE="$mode" bash -c '
    source "$1/scripts/manage.sh"
    kubectl() {
      printf "%s\n" "$*" >>"$CASE_DIR/calls"
      [[ "$*" == *"--request-timeout=10s"* ]] || return 97
      if [[ "$*" == *"get deployment/mx-insight-hub-admin"* ]]; then
        if [ "$CASE_MODE" != large_pod_list ]; then
          printf "PRIVATE_API_ERROR\n" >&2
          return 23
        fi
        printf "NAME GENERATION OBSERVED DESIRED CURRENT READY AVAILABLE\nadmin-snapshot 418 417 0 1 1 1\n"
      elif [[ "$*" == *"get pods"* ]]; then
        if [ "$CASE_MODE" = both_reads_fail ]; then
          printf "PRIVATE_API_ERROR\n" >&2
          return 23
        fi
        printf "NAME NODE PHASE DELETING\n"
        if [ "$CASE_MODE" = large_pod_list ]; then
          local index
          for ((index = 1; index <= 5000; index++)); do
            printf "admin-pod-%04d node Running metadata-padding-to-fill-the-producer-pipe\n" "$index"
          done
          printf "complete\n" >"$CASE_DIR/producer-finished"
        fi
      else
        return 97
      fi
    }
    k8s_admin_stop_diagnostics
  ' _ "$HUB_ROOT" >"$TEST_DIR/diagnostic-$mode/output" 2>&1
  ! grep -Eq 'PRIVATE_API_ERROR|admin-pod-(0021|5000)' "$TEST_DIR/diagnostic-$mode/output"
  ! grep -Eq ' scale | delete | logs |describe|mx-launcher' "$TEST_DIR/diagnostic-$mode/calls"
  case "$mode" in
    deployment_failure_empty_pods)
      grep -q 'Admin Deployment metadata read failed' "$TEST_DIR/diagnostic-$mode/output"
      grep -q 'No matching Admin Pods were returned' "$TEST_DIR/diagnostic-$mode/output"
      ! grep -q 'Admin Pod metadata read failed' "$TEST_DIR/diagnostic-$mode/output" ;;
    both_reads_fail)
      grep -q 'Admin Deployment metadata read failed' "$TEST_DIR/diagnostic-$mode/output"
      grep -q 'Admin Pod metadata read failed' "$TEST_DIR/diagnostic-$mode/output"
      ! grep -q 'No matching Admin Pods were returned' "$TEST_DIR/diagnostic-$mode/output" ;;
    large_pod_list)
      [ -f "$TEST_DIR/diagnostic-$mode/producer-finished" ]
      grep -q 'admin-pod-0020 ' "$TEST_DIR/diagnostic-$mode/output"
      ! grep -q 'metadata read failed' "$TEST_DIR/diagnostic-$mode/output" ;;
  esac
  printf 'ok - Admin stop metadata diagnostics %s\n' "$mode"
done
