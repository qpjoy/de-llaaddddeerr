#!/usr/bin/env bash
#
# mx-common shared data-plane lifecycle.
#
# Design contract, because products call `ensure` from inside their own deploy:
#
#   * `ensure` is idempotent and non-destructive. It never deletes an index, a
#     PVC, a PV or a namespace. `kubectl apply` on unchanged manifests is a
#     no-op, so a healthy stack is left strictly alone.
#   * `ensure` exits non-zero only when a REQUIRED dependency cannot be brought
#     up. Optional components that fail are reported and skipped, so a product
#     deploy degrades rather than aborts.
#   * Nothing here touches a product's own database or workloads.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K8S_DIR="${ROOT_DIR}/deploy/k8s"
NAMESPACE="mx-common"
HOST_DATA_ROOT="${MX_COMMON_HOST_DATA_ROOT:-/var/lib/mx-common/k8s}"
# Captured before any relocation rebinds HOST_DATA_ROOT, so the migration can
# still name the directory the operator must reclaim by hand.
HOST_DATA_ROOT_ORIGINAL="$HOST_DATA_ROOT"
WAIT_TIMEOUT="${MX_COMMON_WAIT_TIMEOUT:-300}"
HANLP_WAIT_TIMEOUT="${MX_COMMON_HANLP_WAIT_TIMEOUT:-900}"

# Image references, overridable for mirrors or air-gapped nodes. These registries
# are slow or unreachable from some networks, and a 1.3GB Elasticsearch pull is
# the single most likely reason `ensure` appears to hang.
ELASTICSEARCH_IMAGE="${MX_COMMON_ELASTICSEARCH_IMAGE:-docker.elastic.co/elasticsearch/elasticsearch:9.4.2}"
POSTGRES_IMAGE="${MX_COMMON_POSTGRES_IMAGE:-pgvector/pgvector:pg16}"
REDIS_IMAGE="${MX_COMMON_REDIS_IMAGE:-redis:7.4-alpine}"
HANLP_IMAGE="${MX_COMMON_HANLP_IMAGE:-mx-common-hanlp:local}"
HANLP_SERVICE_URL="http://mx-common-hanlp.mx-common.svc.cluster.local:8000"
HANLP_BUILD_MEMORY="${MX_COMMON_HANLP_BUILD_MEMORY:-4g}"
HANLP_BUILD_CPU_QUOTA="${MX_COMMON_HANLP_BUILD_CPU_QUOTA:-200000}"
HANLP_BUILDER="${MX_COMMON_HANLP_BUILDER:-mx-common-hanlp}"

# Elasticsearch heap. Xms and Xmx are always set together: a JVM whose min and
# max heap differ fails Elasticsearch's production bootstrap check, and the
# memory REQUEST has to leave room for both the heap and the off-heap page cache
# Lucene reads segments through. Roughly heap x2 is the working rule.
ELASTICSEARCH_HEAP="${MX_COMMON_ELASTICSEARCH_HEAP:-4g}"

say() { printf '[mx-common] %s\n' "$*"; }
warn() { printf '[mx-common] WARN: %s\n' "$*" >&2; }
die() { printf '[mx-common] ERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "Missing command: $1"; }

usage() {
  cat <<'EOF'
Usage: bash scripts/manage.sh <command>

  ensure          Reconcile the shared data plane and wait until it is healthy.
                  Safe to call on every product deploy; a healthy stack is a no-op.
                  Missing images are preloaded through Docker automatically.
  deploy          Alias for `ensure`.
  deploy hanlp    Build and import the model-preloaded HanLP image, deploy only
                  the HanLP service and its dependencies, and require it healthy.
  status          Show workloads, PVCs and Elasticsearch cluster health.
  health          Probe only. Exit 0 healthy, 1 degraded/down. Prints JSON.
  plan            Print the manifests that `ensure` would apply.
  preload         Pull the shared images through Docker and import them into
                  containerd. Use when the node cannot reach the registries
                  directly, or to avoid a slow pull during `ensure`.
  down            Scale shared workloads to zero. Data, PVCs and indices are kept.

  migrate-storage <new-root> [--confirm]
                  Move every retained local PV to another volume. Stops the
                  shared workloads, copies with rsync, verifies byte-for-byte,
                  repoints the PVs and restarts. The source is never deleted.
                  Without --confirm it only reports what it would do.

  relocate [<new-root>] [--confirm]
                  migrate-storage followed by a full redeploy on the new volume.
                  Defaults to /data/k8s/mx-runtime/mx-common/k8s.
  logs [service]  Tail logs (elasticsearch | redis | hanlp | postgres).

  snapshot status|run|list|apply
                  Elasticsearch backups. `status` reports whether a snapshot has
                  actually succeeded, not merely that a policy exists.

  provision <productId>
                  Create (idempotently) the per-product PostgreSQL role, database
                  and extensions, and print the connection string on stdout.

Optional components (off by default):
  deploy hanlp                   Preferred HanLP build/import/deploy workflow.

Environment:
  MX_COMMON_HOST_DATA_ROOT      Host path for local PVs (default /var/lib/mx-common/k8s)
  MX_COMMON_DISK_WARN_PERCENT   Warn above this disk usage during deploy (default 85)
  MX_COMMON_WAIT_TIMEOUT        Seconds to wait for readiness (default 300)
  MX_COMMON_SNAPSHOT_SCHEDULE   SLM cron (default "0 30 1 * * ?", 01:30 daily)
  MX_COMMON_SNAPSHOT_S3_BUCKET  Store snapshots off-node instead of on this host
  MX_COMMON_ELASTICSEARCH_IMAGE Mirror override (default docker.elastic.co/...:9.4.2)
  MX_COMMON_POSTGRES_IMAGE      Mirror override (default pgvector/pgvector:pg16)
  MX_COMMON_REDIS_IMAGE         Mirror override (default redis:7.4-alpine)
  MX_COMMON_HANLP_IMAGE         HanLP image tag (default mx-common-hanlp:local)
  MX_COMMON_HANLP_WAIT_TIMEOUT  HanLP init/start wait in seconds (default 900)
  MX_COMMON_HANLP_BUILD_MEMORY  Docker build memory ceiling (default 4g)
  MX_COMMON_HANLP_BUILD_CPU_QUOTA Docker build CPU quota (default 200000 = 2 CPUs)
  MX_COMMON_HANLP_BUILDER        Dedicated constrained buildx builder name
  MX_COMMON_HANLP_MIN_FREE_GIB  Free disk required before build/import (default 8)
  MX_COMMON_CONTAINERD_ROOT     containerd data root for disk check (default /var/lib/containerd)
  MX_COMMON_ELASTICSEARCH_HEAP  JVM heap, Xms and Xmx together (default 4g, cap 31g)
  MX_COMMON_AUTO_PRELOAD=0      Do not preload images during ensure
EOF
}

# ---------------------------------------------------------------------------
# Storage relocation
# ---------------------------------------------------------------------------

# Recover the host root from the cluster instead of from an operator's shell.
#
# A relocated deployment must not depend on someone remembering to export
# MX_COMMON_HOST_DATA_ROOT: the next deploy would recreate PVs at the old path
# and silently strand the data that was just moved. The PV itself already
# records where the bytes are, so that is what gets believed. An explicit
# environment variable still wins, for a first install or a deliberate override.
resolve_host_data_root() {
  [ -n "${MX_COMMON_HOST_DATA_ROOT:-}" ] && return 0
  command -v kubectl >/dev/null 2>&1 || return 0
  local recorded
  recorded="$(kubectl get pv mx-common-postgres-data \
    -o jsonpath='{.spec.hostPath.path}' 2>/dev/null || true)"
  case "$recorded" in
    */postgres/data)
      HOST_DATA_ROOT="${recorded%/postgres/data}"
      HOST_DATA_ROOT_ORIGINAL="$HOST_DATA_ROOT"
      ;;
  esac
}

# Every retained local PV, as: pv-name claim-name size sub-path owner mode.
# Kept in one place so the migration can never drift from what `ensure_storage`
# and `ensure_hanlp_storage` actually create.
local_pv_inventory() {
  cat <<'INVENTORY'
mx-common-postgres-data data-mx-common-postgres-0 50Gi postgres/data 999:999 0700
mx-common-elasticsearch-data data-mx-common-elasticsearch-0 50Gi elasticsearch/data 1000:0 0775
mx-common-elasticsearch-snapshots mx-common-elasticsearch-snapshots 20Gi elasticsearch/snapshots 1000:0 0775
mx-common-hanlp-models mx-common-hanlp-models 10Gi hanlp/models 1000:1000 0755
INVENTORY
}

# Free bytes on the filesystem backing a path, walking up to the nearest parent
# that exists so an unborn target can still be measured.
free_bytes_for() {
  local path="$1" probe="$1"
  while [ ! -e "$probe" ] && [ "$probe" != / ]; do
    probe="${probe%/*}"
    [ -n "$probe" ] || probe=/
  done
  df -Pk "$probe" 2>/dev/null | awk 'NR == 2 { print $4 * 1024 }'
}

used_bytes_for() {
  [ -d "$1" ] || { printf '0'; return 0; }
  du -sk "$1" 2>/dev/null | awk '{ print $1 * 1024 }'
}

gib() {
  awk -v bytes="${1:-0}" 'BEGIN { printf "%.1f", bytes / 1073741824 }'
}

# Refuse a deploy that is one ingest away from an unallocatable shard.
#
# Elasticsearch stops placing shards at cluster.routing.allocation.disk.
# watermark.high, 90% by default, and the symptom is a red index with an
# INDEX_CREATED shard that never assigns -- which reads as a connectivity
# problem everywhere except in the allocation explain output. Catching it here
# names the real cause while it is still cheap to fix.
check_storage_headroom() {
  local warn_percent="${MX_COMMON_DISK_WARN_PERCENT:-85}" percent probe="$HOST_DATA_ROOT"
  while [ ! -e "$probe" ] && [ "$probe" != / ]; do
    probe="${probe%/*}"
    [ -n "$probe" ] || probe=/
  done
  percent="$(df -Pk "$probe" 2>/dev/null | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')"
  case "$percent" in
    ''|*[!0-9]*) warn "cannot measure disk usage for ${HOST_DATA_ROOT}"; return 0 ;;
  esac
  [ "$percent" -lt "$warn_percent" ] && return 0

  warn "${HOST_DATA_ROOT} is on a filesystem that is ${percent}% full."
  warn "  Elasticsearch refuses to allocate new shards past the 90% high watermark,"
  warn "  and PostgreSQL has no watermark at all -- it simply fails to write."
  warn "  Relocate the shared data to a larger volume:"
  warn "    bash scripts/manage.sh migrate-storage /data/k8s/mx-runtime/mx-common/k8s"
  [ "$percent" -ge 90 ] && warn "  Past the watermark already: new indices will not become allocatable."
  return 0
}

# Accept the root and the confirmation flag in either order.
#
# Positional parsing made `relocate --confirm` read the flag as a path, which
# then failed the absolute-path check -- a confusing way to reject a command
# that was written exactly as documented. Results land in PARSED_RELOCATION_*
# because this shell targets POSIX-ish portability rather than nameref returns.
PARSED_RELOCATION_ROOT=""
PARSED_RELOCATION_CONFIRMED=0
parse_relocation_args() {
  PARSED_RELOCATION_ROOT=""
  PARSED_RELOCATION_CONFIRMED=0
  local argument
  for argument in "$@"; do
    case "$argument" in
      '') ;;
      --confirm) PARSED_RELOCATION_CONFIRMED=1 ;;
      -*) die "unknown option: ${argument}" ;;
      *)
        [ -z "$PARSED_RELOCATION_ROOT" ] || die "only one host data root may be given"
        PARSED_RELOCATION_ROOT="$argument"
        ;;
    esac
  done
}

# Move every retained local PV to a new host root, without losing data.
#
# Order is the whole design. Workloads stop first so nothing writes during the
# copy; the copy is verified before anything is deleted; the PVs are Retain, so
# removing the PVC and the PV detaches the claim without touching bytes; and the
# source directory is never deleted -- reclaiming it stays a separate, human
# decision made after the new root has proven itself.
cmd_migrate_storage() {
  need kubectl
  need rsync
  resolve_host_data_root
  parse_relocation_args "$@" || return 1
  local target_root="$PARSED_RELOCATION_ROOT" confirmed="$PARSED_RELOCATION_CONFIRMED"
  [ -n "$target_root" ] || die "usage: manage.sh migrate-storage <new-host-data-root> [--confirm]"
  case "$target_root" in
    /*) ;;
    *) die "the new host data root must be an absolute path" ;;
  esac
  target_root="${target_root%/}"
  [ "$target_root" != "$HOST_DATA_ROOT" ] \
    || die "the new root is the current root (${HOST_DATA_ROOT}); nothing to do"
  case "$target_root" in
    "${HOST_DATA_ROOT}"/*) die "the new root must not live inside the current root" ;;
  esac

  # Other products keep their own retained volumes on the same disk. mx-launcher
  # in particular carries the running MX-H2I estate, and rsync into a live PGDATA
  # would corrupt a database this migration has no business touching. Refuse any
  # target that lands on, inside, or above another product's data.
  local reserved
  for reserved in \
      /data/k8s/mx-runtime/mx-launcher \
      /data/k8s/mx-runtime/mx-launcher/k8s \
      /data/k8s/mx-runtime/mx-launcher/k8s/postgres; do
    [ "$target_root" = "$reserved" ] && die "refusing to write into ${reserved}: that volume belongs to mx-launcher"
    case "$target_root" in
      "${reserved}"/*) die "refusing to write inside ${reserved}: that volume belongs to mx-launcher" ;;
    esac
    case "$reserved" in
      "${target_root}"/*) die "refusing a root that contains ${reserved}: that volume belongs to mx-launcher" ;;
    esac
  done
  if [ -d "$target_root" ] && [ -n "$(ls -A "$target_root" 2>/dev/null)" ]; then
    warn "${target_root} is not empty; rsync will merge into it"
    ls -A "$target_root" | sed 's/^/    /' >&2
  fi

  local used free
  used="$(used_bytes_for "$HOST_DATA_ROOT")"
  free="$(free_bytes_for "$target_root")"
  [ -n "$free" ] || die "cannot measure free space on ${target_root}"
  say "source ${HOST_DATA_ROOT} holds $(gib "$used")GiB; ${target_root} has $(gib "$free")GiB free"
  # A tenth over the measured size covers rsync's own overhead and any growth
  # between measuring and copying.
  awk -v free="$free" -v used="$used" 'BEGIN { exit !(free > used * 1.1) }' \
    || die "not enough free space on ${target_root}: need $(gib "$(awk -v u="$used" 'BEGIN{print u*1.1}')")GiB"

  if [ "$confirmed" != 1 ]; then
    say ""
    say "This stops PostgreSQL, Elasticsearch and HanLP, copies their data to"
    say "${target_root}, and repoints every retained PV. The source is left in"
    say "place. Re-run with --confirm to proceed:"
    say "  bash scripts/manage.sh migrate-storage ${target_root} --confirm"
    return 0
  fi

  say "1/6 stopping shared workloads"
  kubectl -n "$NAMESPACE" scale statefulset mx-common-postgres --replicas=0 >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" scale statefulset mx-common-elasticsearch --replicas=0 >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" scale deployment mx-common-hanlp --replicas=0 >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" scale deployment mx-common-redis --replicas=0 >/dev/null 2>&1 || true
  local waited=0
  while [ "$waited" -lt 180 ]; do
    local remaining
    remaining="$(kubectl -n "$NAMESPACE" get pods \
      -l 'app.kubernetes.io/part-of=mx-common' --no-headers 2>/dev/null | wc -l | tr -d ' ')"
    [ "${remaining:-0}" -eq 0 ] && break
    sleep 3
    waited=$((waited + 3))
  done
  [ "$waited" -lt 180 ] || die "shared pods did not terminate; nothing has been changed"
  say "  all shared pods are gone"

  say "2/6 copying data to ${target_root}"
  mkdir -p "$target_root" 2>/dev/null || sudo -n mkdir -p "$target_root" \
    || die "cannot create ${target_root}"
  # Numeric ids and full attribute preservation: the pods run as fixed uids and
  # hostPath ignores fsGroup, so a remapped owner is an unstartable database.
  rsync -aHAX --numeric-ids --info=progress2 "${HOST_DATA_ROOT}/" "${target_root}/" \
    || die "copy failed; the source is untouched and the workloads are still stopped"

  say "3/6 verifying the copy"
  local drift
  drift="$(rsync -aHAXn --numeric-ids --checksum --itemize-changes \
    "${HOST_DATA_ROOT}/" "${target_root}/" | head -20)"
  if [ -n "$drift" ]; then
    warn "the copy does not match the source:"
    printf '%s\n' "$drift" >&2
    die "aborting before any PV is touched; the source is intact"
  fi
  say "  byte-for-byte identical"

  say "4/6 detaching claims from the old root"
  # Reclaim policy is Retain, so this releases the binding and keeps the data.
  local pv claim size sub owner mode
  while read -r pv claim size sub owner mode; do
    [ -n "$pv" ] || continue
    kubectl -n "$NAMESPACE" delete pvc "$claim" --ignore-not-found --wait=true >/dev/null 2>&1 || true
    kubectl delete pv "$pv" --ignore-not-found --wait=true >/dev/null 2>&1 || true
  done <<EOF
$(local_pv_inventory)
EOF

  say "5/6 recreating retained PVs under ${target_root}"
  HOST_DATA_ROOT="$target_root"
  while read -r pv claim size sub owner mode; do
    [ -n "$pv" ] || continue
    ensure_local_pv "$pv" "$claim" "$size" "$sub" "$owner" "$mode"
  done <<EOF
$(local_pv_inventory)
EOF
  # Standalone claims live in the manifests; the StatefulSet templates recreate
  # theirs on scale-up.
  kubectl apply -f deploy/k8s/common/ >/dev/null \
    || die "could not reapply the shared manifests"

  say "6/6 restarting shared workloads"
  kubectl -n "$NAMESPACE" scale statefulset mx-common-postgres --replicas=1 >/dev/null
  kubectl -n "$NAMESPACE" scale statefulset mx-common-elasticsearch --replicas=1 >/dev/null
  kubectl -n "$NAMESPACE" scale deployment mx-common-redis --replicas=1 >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" scale deployment mx-common-hanlp --replicas=1 >/dev/null 2>&1 || true

  say "  waiting for the shared data plane to come back"
  kubectl -n "$NAMESPACE" rollout status statefulset/mx-common-postgres --timeout=300s >/dev/null \
    || die "PostgreSQL did not become ready on the new volume; the old data is still at ${HOST_DATA_ROOT_ORIGINAL}"
  kubectl -n "$NAMESPACE" rollout status statefulset/mx-common-elasticsearch --timeout=600s >/dev/null \
    || die "Elasticsearch did not become ready on the new volume; the old data is still at ${HOST_DATA_ROOT_ORIGINAL}"

  say ""
  say "migration complete; both stores are ready on ${target_root}."
  say "Future deploys read the root back from the PV, so nothing needs exporting."
  say ""
  say "The old copy is still at ${HOST_DATA_ROOT_ORIGINAL} and was not touched."
  say "Verify, then reclaim it:"
  say "  kubectl -n ${NAMESPACE} exec statefulset/mx-common-elasticsearch -c elasticsearch -- \\"
  say "    curl -sS 'http://127.0.0.1:9200/_cluster/health?pretty'"
  say "  sudo rm -rf ${HOST_DATA_ROOT_ORIGINAL}"
}

# Relocate and redeploy in one step.
#
# The two halves are separable on purpose -- a migration that succeeds should
# not be undone by a deploy that fails -- but running them together is what an
# operator actually wants, so the sequencing is written down here rather than
# left to be remembered under pressure.
cmd_relocate() {
  local target_root="" confirmed=0
  parse_relocation_args "$@" || return 1
  target_root="${PARSED_RELOCATION_ROOT:-/data/k8s/mx-runtime/mx-common/k8s}"
  confirmed="$PARSED_RELOCATION_CONFIRMED"

  if [ "$confirmed" != 1 ]; then
    cmd_migrate_storage "$target_root"
    say ""
    say "Then this command will also redeploy the shared data plane. To run both:"
    say "  bash scripts/manage.sh relocate ${target_root} --confirm"
    return 0
  fi
  cmd_migrate_storage "$target_root" --confirm
  say ""
  say "reconciling the shared data plane on the new volume"
  MX_COMMON_HOST_DATA_ROOT="$target_root" cmd_ensure
}

# ---------------------------------------------------------------------------
# Host prerequisites
# ---------------------------------------------------------------------------

# Elasticsearch mmaps its indices and refuses to start when the kernel limit is
# below 262144. Setting it needs root on the NODE, not in the pod, so this is
# done here rather than through a privileged init container — an init container
# with CAP_SYS_ADMIN would be a far larger standing privilege than a one-time
# sysctl.
ensure_vm_max_map_count() {
  local required=262144 current
  current="$(sysctl -n vm.max_map_count 2>/dev/null || echo 0)"
  if [ "$current" -ge "$required" ]; then
    return 0
  fi
  say "vm.max_map_count is ${current}; Elasticsearch requires ${required}"
  if sysctl -w vm.max_map_count="$required" >/dev/null 2>&1; then
    say "raised vm.max_map_count to ${required} for this boot"
  elif sudo -n sysctl -w vm.max_map_count="$required" >/dev/null 2>&1; then
    say "raised vm.max_map_count to ${required} for this boot (sudo)"
  else
    warn "cannot raise vm.max_map_count; Elasticsearch will fail to start."
    warn "Run as root:  sysctl -w vm.max_map_count=${required}"
    warn "Persist with: echo 'vm.max_map_count=${required}' > /etc/sysctl.d/99-mx-common.conf"
    return 1
  fi
  # Persist so a node reboot does not silently break search on next start.
  if [ -w /etc/sysctl.d ] || sudo -n test -w /etc/sysctl.d 2>/dev/null; then
    printf 'vm.max_map_count=%s\n' "$required" \
      | (sudo -n tee /etc/sysctl.d/99-mx-common.conf >/dev/null 2>&1 \
         || tee /etc/sysctl.d/99-mx-common.conf >/dev/null 2>&1) || true
  fi
}

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

has_default_storage_class() {
  kubectl get storageclass -o json 2>/dev/null \
    | grep -q '"storageclass.kubernetes.io/is-default-class": *"true"'
}

# Take ownership of a hostPath directory on behalf of the workload that mounts it.
#
# This is the step whose absence breaks both PostgreSQL and Elasticsearch, and it
# is not obvious: `fsGroup` in a pod securityContext does NOT apply to hostPath
# volumes. The kubelet only fixes ownership for volume types that support it
# (CSI, emptyDir, and friends); a hostPath is used exactly as the node presents
# it. A directory created here by root is therefore root:root, and a container
# running as uid 999 or 1000 cannot write to it — PostgreSQL fails to mkdir
# PGDATA, Elasticsearch fails to create node.lock.
#
# Applied on every run, not only at creation, so a directory left with the wrong
# owner by an earlier version is repaired rather than requiring a manual chown.
ensure_host_path_ownership() {
  local host_path="$1" owner="$2" mode="$3"
  # `stat %a` prints 700, not 0700, so the expected mode is normalised before
  # comparing. Getting this wrong only costs a redundant chown, but it also
  # prints a misleading "ownership changed" line on every single run.
  local current expected
  current="$(stat -c '%u:%g:%a' "$host_path" 2>/dev/null || true)"
  expected="${owner}:${mode#0}"
  [ -n "$current" ] && [ "$current" = "$expected" ] && return 0

  if chown -R "$owner" "$host_path" 2>/dev/null && chmod "$mode" "$host_path" 2>/dev/null; then
    :
  elif sudo -n chown -R "$owner" "$host_path" 2>/dev/null \
    && sudo -n chmod "$mode" "$host_path" 2>/dev/null; then
    :
  else
    warn "cannot set ${host_path} to ${owner} (${mode}); the workload will fail to write to it"
    warn "  Run as root:  chown -R ${owner} ${host_path} && chmod ${mode} ${host_path}"
    return 1
  fi
  say "host path ${host_path} owned by ${owner} (${mode})"
}

# Bare kubeadm has no dynamic provisioner, so a PVC stays Pending forever and the
# StatefulSet never schedules. Pre-create a Retain hostPath PV bound to the exact
# claim. Reclaim policy is Retain so that deleting the PVC never deletes data.
ensure_local_pv() {
  local pv_name="$1" claim_name="$2" size="$3" sub_path="$4"
  # Must match the pod's runAsUser:runAsGroup, since hostPath ignores fsGroup.
  local owner="${5:-1000:0}" mode="${6:-0775}"
  local host_path="${HOST_DATA_ROOT}/${sub_path}"

  mkdir -p "$host_path" 2>/dev/null \
    || sudo -n mkdir -p "$host_path" 2>/dev/null \
    || die "cannot create host path ${host_path}"
  ensure_host_path_ownership "$host_path" "$owner" "$mode" || true

  if kubectl get pv "$pv_name" >/dev/null 2>&1; then
    local phase
    phase="$(kubectl get pv "$pv_name" -o jsonpath='{.status.phase}')"
    case "$phase" in
      Released)
        warn "PV ${pv_name} is Released; leaving it untouched to protect retained data."
        warn "Inspect ${host_path} and clear spec.claimRef manually to reuse it."
        ;;
    esac
    return 0
  fi

  say "creating retained local PV ${pv_name} -> ${host_path}"
  kubectl apply -f - <<EOF >/dev/null
apiVersion: v1
kind: PersistentVolume
metadata:
  name: ${pv_name}
  labels:
    app.kubernetes.io/part-of: mx-common
spec:
  capacity:
    storage: ${size}
  accessModes: ["ReadWriteOnce"]
  persistentVolumeReclaimPolicy: Retain
  storageClassName: ""
  hostPath:
    path: ${host_path}
    type: DirectoryOrCreate
  claimRef:
    namespace: ${NAMESPACE}
    name: ${claim_name}
EOF
}

ensure_storage() {
  if has_default_storage_class; then
    say "default StorageClass present; using dynamic provisioning"
    return 0
  fi
  say "no default StorageClass; provisioning retained local PVs"
  # Owners mirror each pod's securityContext. PostgreSQL additionally refuses to
  # start unless PGDATA's parent is 0700 or 0750.
  ensure_local_pv mx-common-postgres-data data-mx-common-postgres-0 50Gi postgres/data 999:999 0700
  ensure_local_pv mx-common-elasticsearch-data data-mx-common-elasticsearch-0 50Gi elasticsearch/data 1000:0 0775
  ensure_local_pv mx-common-elasticsearch-snapshots mx-common-elasticsearch-snapshots 20Gi elasticsearch/snapshots 1000:0 0775
}

# ---------------------------------------------------------------------------
# Manifests
# ---------------------------------------------------------------------------

manifest_list() {
  printf '%s\n' \
    "${K8S_DIR}/common/00-namespace.yaml" \
    "${K8S_DIR}/common/10-postgres.yaml" \
    "${K8S_DIR}/common/20-elasticsearch.yaml" \
    "${K8S_DIR}/common/30-redis.yaml"
  # Network policy last: it references labels the workloads above define.
  printf '%s\n' "${K8S_DIR}/common/40-network-policy.yaml"
}

ensure_secret() {
  if kubectl -n "$NAMESPACE" get secret mx-common-secrets >/dev/null 2>&1; then
    return 0
  fi
  local password="${MX_COMMON_POSTGRES_PASSWORD:-}"
  if [ -z "$password" ]; then
    password="$(generate_password)"
    say "generated a PostgreSQL password into secret/mx-common-secrets"
  fi
  kubectl -n "$NAMESPACE" create secret generic mx-common-secrets \
    --from-literal=postgres-password="$password" >/dev/null
}

# A product namespace must be labelled before its pods can reach the shared
# stores; the NetworkPolicy selects on this label rather than on pod identity so
# onboarding is one explicit, auditable action.
allow_client_namespace() {
  local target="$1"
  kubectl get namespace "$target" >/dev/null 2>&1 || return 0
  kubectl label namespace "$target" mx-common.io/client=allowed --overwrite >/dev/null
  say "namespace ${target} is allowed to reach the shared data plane"
}

render_manifest() {
  local hanlp_image_id="${MX_COMMON_HANLP_IMAGE_ID:-unmanaged}"
  local hanlp_node_name="${MX_COMMON_HANLP_NODE_NAME:-unmanaged}"
  sed -e "s#docker.elastic.co/elasticsearch/elasticsearch:9.4.2#${ELASTICSEARCH_IMAGE}#g" \
      -e "s#pgvector/pgvector:pg16#${POSTGRES_IMAGE}#g" \
      -e "s#redis:7.4-alpine#${REDIS_IMAGE}#g" \
      -e "s#mx-common-hanlp:local#${HANLP_IMAGE}#g" \
      -e "s#MX_COMMON_HANLP_IMAGE_ID_PLACEHOLDER#${hanlp_image_id}#g" \
      -e "s#MX_COMMON_HANLP_NODE_NAME_PLACEHOLDER#${hanlp_node_name}#g" \
      -e "s#-Xms4g -Xmx4g#-Xms${ELASTICSEARCH_HEAP} -Xmx${ELASTICSEARCH_HEAP}#g" \
      "$1"
}

apply_manifests() {
  local file
  while IFS= read -r file; do
    render_manifest "$file" | kubectl apply -f - >/dev/null
  done < <(manifest_list)
  allow_hostnetwork_clients
  restart_crashlooping_pods
  say "manifests applied"
}

# Delete pods that are crash-looping so they retry immediately.
#
# CrashLoopBackOff grows to a five-minute delay. Once the cause is fixed --
# a hostPath ownership repair, a config change -- the pod would otherwise sit
# out the remaining backoff, and `ensure` would report failure for a stack that
# is actually already correct.
restart_crashlooping_pods() {
  local pod
  while IFS= read -r pod; do
    [ -n "$pod" ] || continue
    say "restarting crash-looping pod ${pod} so it retries without waiting out its backoff"
    kubectl -n "$NAMESPACE" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done < <(
    kubectl -n "$NAMESPACE" get pods \
      -o jsonpath='{range .items[?(@.status.containerStatuses[0].state.waiting.reason=="CrashLoopBackOff")]}{.metadata.name}{"\n"}{end}' \
      2>/dev/null || true
  )
}

# Allow node IPs to reach the shared stores.
#
# This is not a convenience hole. A pod with `hostNetwork: true` shares the
# node's network namespace, so its packets carry the NODE's IP and carry no pod
# identity at all -- `namespaceSelector` and `podSelector` rules simply never
# match it. mx-insight-hub's public and admin planes run that way deliberately,
# to reach host-local Night-All at 127.0.0.1, so without this rule they can
# connect to nothing in mx-common.
#
# The allowance is narrowed as far as the mechanism permits: exact /32 node
# addresses discovered at apply time, not a CIDR. Anything else sharing a node
# IP is already inside the cluster's trust boundary.
allow_hostnetwork_clients() {
  local addresses cidrs=""
  addresses="$(kubectl get nodes \
    -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' \
    2>/dev/null | awk 'NF')"
  if [ -z "$addresses" ]; then
    warn "could not discover node InternalIPs; hostNetwork clients may be blocked"
    return 0
  fi
  local address
  while IFS= read -r address; do
    cidrs="${cidrs}
        - ipBlock:
            cidr: ${address}/32"
  done <<EOF
$addresses
EOF

  kubectl apply -f - <<EOF >/dev/null
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: mx-common-hostnetwork-clients
  namespace: ${NAMESPACE}
  annotations:
    mx-common.io/generated-by: scripts/manage.sh
    mx-common.io/reason: >-
      hostNetwork pods present the node IP and carry no pod identity, so
      namespaceSelector rules cannot match them.
spec:
  podSelector: {}
  policyTypes: ["Ingress"]
  ingress:
    - from:${cidrs}
      ports:
        - protocol: TCP
          port: 5432
        - protocol: TCP
          port: 9200
        - protocol: TCP
          port: 6379
        - protocol: TCP
          port: 8000
EOF
  say "allowed hostNetwork clients from node IPs: $(printf '%s' "$addresses" | tr '\n' ' ')"
}

# Container states that will never resolve on their own. Waiting out the full
# timeout on these teaches the operator nothing and wastes five minutes.
pod_terminal_reason() {
  local name="$1"
  kubectl -n "$NAMESPACE" get pods -l "app.kubernetes.io/name=${name}" \
    -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.state.waiting.reason}{"\n"}{end}{range .status.initContainerStatuses[*]}{.state.waiting.reason}{"\n"}{end}{end}' \
    2>/dev/null | awk 'NF' | grep -E '^(ImagePullBackOff|ErrImagePull|ErrImageNeverPull|CrashLoopBackOff|CreateContainerConfigError|InvalidImageName)$' | head -1
}

# One-line progress summary: phase, readiness, restarts and whatever the pod is
# currently waiting on.
pod_progress() {
  local name="$1"
  kubectl -n "$NAMESPACE" get pods -l "app.kubernetes.io/name=${name}" \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.phase}{" ready="}{.status.containerStatuses[0].ready}{" restarts="}{.status.containerStatuses[0].restartCount}{" "}{.status.containerStatuses[0].state.waiting.reason}{end}' \
    2>/dev/null || true
}

# Wait for a workload, reporting progress while it happens.
#
# The previous version ran `rollout status` with all output discarded, which
# meant up to five minutes of total silence — indistinguishable from a hang.
# Pulling a 1.3GB image over a slow link is a legitimate reason to wait; being
# unable to tell that apart from a crash loop is not.
wait_ready() {
  local kind="$1" name="$2" required="${3:-required}"
  local waited=0 interval=5 reason progress last_progress=""

  while [ "$waited" -lt "$WAIT_TIMEOUT" ]; do
    if kubectl -n "$NAMESPACE" rollout status "$kind/$name" --timeout=3s >/dev/null 2>&1; then
      say "${name} is ready (${waited}s)"
      return 0
    fi

    reason="$(pod_terminal_reason "$name")"
    if [ -n "$reason" ]; then
      warn "${name} is stuck in ${reason}; not waiting out the remaining $((WAIT_TIMEOUT - waited))s"
      case "$reason" in
        ImagePullBackOff|ErrImagePull|ErrImageNeverPull|InvalidImageName)
          warn "  The node cannot pull this workload's image. Options:"
          warn "    1. Point at a mirror:  MX_COMMON_ELASTICSEARCH_IMAGE=... MX_COMMON_POSTGRES_IMAGE=... MX_COMMON_REDIS_IMAGE=..."
          warn "    2. Preload from a host that can reach the registry:  bash scripts/manage.sh preload"
          warn "  Current images: $(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=${name} -o jsonpath='{.items[*].spec.containers[*].image}' 2>/dev/null)"
          ;;
        CrashLoopBackOff)
          diagnose_workload "$name"
          warn "  If the logs mention Permission denied, AccessDeniedException or node.lock,"
          warn "  the hostPath directory is owned by the wrong uid. fsGroup does NOT apply to"
          warn "  hostPath volumes, so ${HOST_DATA_ROOT} must be chowned to the pod's runAsUser."
          warn "  Re-running ensure repairs it."
          ;;
      esac
      [ "$required" = "optional" ] && return 0
      return 1
    fi

    progress="$(pod_progress "$name")"
    # Print only on change, so a slow pull produces a readable trail rather than
    # a wall of identical lines.
    if [ -n "$progress" ] && [ "$progress" != "$last_progress" ]; then
      say "  ${progress} (${waited}s elapsed)"
      last_progress="$progress"
    elif [ $((waited % 30)) -eq 0 ] && [ "$waited" -gt 0 ]; then
      say "  still waiting on ${name} (${waited}s of ${WAIT_TIMEOUT}s)"
    fi

    sleep "$interval"
    waited=$((waited + interval))
  done

  warn "${name} did not become ready in ${WAIT_TIMEOUT}s"
  diagnose_workload "$name"
  [ "$required" = "optional" ] && return 0
  return 1
}

# Print the diagnosis that actually explains a stuck workload.
#
# Describing the StatefulSet or Deployment shows only controller-level events
# ("SuccessfulCreate"), which say nothing about why the pod is not running.
# Scheduling failures, image pulls and mount errors are all POD events, so that
# is what gets described here.
diagnose_workload() {
  local name="$1" pod
  pod="$(kubectl -n "$NAMESPACE" get pods -l "app.kubernetes.io/name=${name}" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -z "$pod" ]; then
    warn "  no pod exists for ${name}; the controller could not create one"
    kubectl -n "$NAMESPACE" get events --field-selector "involvedObject.name=${name}" \
      --sort-by=.lastTimestamp 2>/dev/null | tail -10 >&2 || true
    return 0
  fi

  warn "  pod ${pod}:"
  kubectl -n "$NAMESPACE" get pod "$pod" -o wide 2>/dev/null >&2 || true

  # Container-level waiting reason and message: this is where "Back-off pulling
  # image" and "failed to create containerd task" actually appear.
  kubectl -n "$NAMESPACE" get pod "$pod" -o jsonpath='{range .status.containerStatuses[*]}  container {.name}: {.state.waiting.reason}{" - "}{.state.waiting.message}{"\n"}{end}' \
    2>/dev/null >&2 || true
  kubectl -n "$NAMESPACE" get pod "$pod" -o jsonpath='{range .status.conditions[*]}  {.type}={.status} {.reason} {.message}{"\n"}{end}' \
    2>/dev/null >&2 || true

  warn "  recent pod events:"
  kubectl -n "$NAMESPACE" describe pod "$pod" 2>/dev/null \
    | sed -n '/^Events:/,$p' | tail -15 >&2 || true

  # Logs only exist once a container has actually started; absence here is
  # itself the signal that the problem is before startup.
  local logs
  logs="$(kubectl -n "$NAMESPACE" logs "$pod" --tail=20 --all-containers 2>/dev/null || true)"
  if [ -n "$logs" ]; then
    warn "  last log lines:"
    printf '%s\n' "$logs" >&2
  else
    warn "  no container logs yet: the container has not started (image pull, mount or scheduling)"
  fi
}

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

es_port_forward_pid=""
cleanup_port_forward() {
  [ -n "$es_port_forward_pid" ] && kill "$es_port_forward_pid" 2>/dev/null || true
  es_port_forward_pid=""
}
trap cleanup_port_forward EXIT

# Probe Elasticsearch from inside the cluster. Running curl in the ES pod itself
# avoids a port-forward and works identically whether or not the caller has a
# route into the pod network.
es_cluster_health() {
  kubectl -n "$NAMESPACE" exec statefulset/mx-common-elasticsearch -c elasticsearch -- \
    curl -fsS --max-time 5 'http://127.0.0.1:9200/_cluster/health' 2>/dev/null || true
}

health_json() {
  local es_health es_status="down" redis_status="down" pg_status="down" hanlp_status="disabled"

  es_health="$(es_cluster_health)"
  if [ -n "$es_health" ]; then
    es_status="$(printf '%s' "$es_health" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')"
    [ -n "$es_status" ] || es_status="unknown"
  fi

  if kubectl -n "$NAMESPACE" exec deployment/mx-common-redis -- redis-cli ping >/dev/null 2>&1; then
    redis_status="ok"
  fi

  pg_status="down"
  if kubectl -n "$NAMESPACE" exec statefulset/mx-common-postgres -- \
      pg_isready -U mx_common -d mx_common >/dev/null 2>&1; then
    pg_status="ok"
  fi

  if hanlp_is_deployed; then
    hanlp_status="down"
    if hanlp_is_healthy; then
      hanlp_status="ok"
    fi
  fi

  printf '{"elasticsearch":"%s","redis":"%s","postgres":"%s","hanlp":"%s"}\n' \
    "$es_status" "$redis_status" "$pg_status" "$hanlp_status"
}

# Yellow is healthy here: a single-node cluster holds no replicas, so green is
# unreachable by construction and gating on it would hang every deploy.
es_is_healthy() {
  local health status
  health="$(es_cluster_health)"
  status="$(printf '%s' "$health" | sed -n 's/.*"status":"\([a-z]*\)".*/\1/p')"
  [ "$status" = "green" ] || [ "$status" = "yellow" ]
}

hanlp_is_deployed() {
  kubectl -n "$NAMESPACE" get deployment mx-common-hanlp >/dev/null 2>&1
}

hanlp_is_healthy() {
  kubectl -n "$NAMESPACE" exec deployment/mx-common-hanlp -- \
    python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3).status==200 else 1)" \
    >/dev/null 2>&1
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_ensure() {
  need kubectl
  resolve_host_data_root
  local target_namespaces="${MX_COMMON_CLIENT_NAMESPACES:-mx-insight-hub}"

  if [ "${MX_COMMON_HANLP_ENABLED:-0}" = "1" ]; then
    die "MX_COMMON_HANLP_ENABLED is no longer a standalone deploy switch; run 'bash scripts/manage.sh deploy hanlp', then run ensure without that variable"
  fi

  if kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 && es_is_healthy; then
    say "shared data plane is already healthy; reconciling declaratively (no restart unless a manifest changed)"
  else
    say "shared data plane is absent or unhealthy; deploying"
  fi

  ensure_vm_max_map_count || warn "continuing; Elasticsearch may fail to start"
  check_storage_headroom
  report_capacity
  report_image_readiness
  kubectl apply -f "${K8S_DIR}/common/00-namespace.yaml" >/dev/null
  ensure_secret
  ensure_storage
  apply_manifests

  for namespace in $target_namespaces; do
    allow_client_namespace "$namespace"
  done

  local failed=0
  # PostgreSQL is the only hard requirement: it holds every product's
  # transactional truth. Elasticsearch failing is a search degradation.
  wait_ready statefulset mx-common-postgres || failed=1
  wait_ready statefulset mx-common-elasticsearch || warn "elasticsearch is not ready; products run with search degraded"
  wait_ready deployment mx-common-redis || warn "redis is not ready; products fall back to their PostgreSQL queue"

  if [ "$failed" -ne 0 ]; then
    warn "a required shared component did not become ready"
    health_json
    return 1
  fi

  # Readiness of the pod is not the same as usability of the cluster; wait for
  # the cluster to actually accept requests before declaring success.
  local waited=0
  until es_is_healthy || [ "$waited" -ge "$WAIT_TIMEOUT" ]; do
    sleep 5
    waited=$((waited + 5))
  done
  if ! es_is_healthy; then
    warn "Elasticsearch pod is running but the cluster is not yellow/green after ${WAIT_TIMEOUT}s"
    health_json
    return 1
  fi

  # Backups reconcile after the cluster is confirmed usable: registering a
  # repository against a cluster that is still forming just fails.
  ensure_snapshot_policy

  say "shared data plane healthy: $(health_json)"
}

# ---------------------------------------------------------------------------
# Snapshots
# ---------------------------------------------------------------------------

# Run a curl inside the Elasticsearch pod. Keeps every cluster call on the same
# path as the health probe: no port-forward, no cluster credentials on the
# operator's machine, works identically from CI and from a laptop.
es_curl() {
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    printf '%s' "$body" | kubectl -n "$NAMESPACE" exec -i statefulset/mx-common-elasticsearch \
      -c elasticsearch -- curl -fsS --max-time 30 -X "$method" \
      -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:9200${path}"
  else
    kubectl -n "$NAMESPACE" exec statefulset/mx-common-elasticsearch -c elasticsearch -- \
      curl -fsS --max-time 30 -X "$method" "http://127.0.0.1:9200${path}"
  fi
}

# Reconcile the snapshot repository and SLM policy.
#
# The definitions live in src/elasticsearch/snapshots.mjs so they are reviewable
# and unit-tested; this only transports them. Failure is reported, not fatal:
# backup configuration matters, but it must not be able to fail the deploy of an
# otherwise healthy data plane.
ensure_snapshot_policy() {
  local repository="${MX_COMMON_SNAPSHOT_REPOSITORY:-mx-common-snapshots}"
  local policy_name="${MX_COMMON_SNAPSHOT_POLICY:-mx-common-daily}"

  if ! command -v node >/dev/null 2>&1; then
    warn "node is unavailable; skipping snapshot policy reconcile"
    return 0
  fi

  local repository_body policy_body render_error
  render_error="$(mktemp)"
  if ! repository_body="$(node "${ROOT_DIR}/scripts/print-snapshot-config.mjs" repository 2>"$render_error")" \
    || ! policy_body="$(node "${ROOT_DIR}/scripts/print-snapshot-config.mjs" policy 2>>"$render_error")"; then
    warn "could not render the snapshot configuration; BACKUPS ARE NOT SCHEDULED"
    sed -n '1,5p' "$render_error" >&2
    rm -f -- "$render_error"
    warn "  Apply it separately once fixed:  bash scripts/manage.sh snapshot apply"
    return 0
  fi
  rm -f -- "$render_error"

  if ! es_curl PUT "/_snapshot/${repository}?verify=true" "$repository_body" >/dev/null 2>&1; then
    warn "snapshot repository ${repository} could not be registered or verified"
    warn "  the repository path must be inside the cluster's path.repo setting"
    return 0
  fi
  if ! es_curl PUT "/_slm/policy/${policy_name}" "$policy_body" >/dev/null 2>&1; then
    warn "snapshot policy ${policy_name} could not be applied"
    return 0
  fi

  say "snapshot policy ${policy_name} -> ${repository}"
  if [ -z "${MX_COMMON_SNAPSHOT_S3_BUCKET:-}" ]; then
    # Say this every time. A backup on the same disk as the data protects
    # against deleting an index by mistake, not against losing the machine, and
    # that distinction is exactly what gets forgotten between now and an outage.
    say "NOTE: snapshots are stored on this node. They protect against index"
    say "      loss and bad mappings, NOT against losing the machine. Set"
    say "      MX_COMMON_SNAPSHOT_S3_BUCKET for off-node durability."
  fi
}

# Report whether backups are actually happening, not merely configured.
snapshot_status() {
  local policy_name="${MX_COMMON_SNAPSHOT_POLICY:-mx-common-daily}"
  local policy
  policy="$(es_curl GET "/_slm/policy/${policy_name}" 2>/dev/null || true)"
  if [ -z "$policy" ] || [ "$policy" = '{}' ]; then
    printf 'snapshot policy %s is not registered\n' "$policy_name"
    return 1
  fi
  printf '%s\n' "$policy"
  # A policy that exists but has never succeeded is the failure this catches:
  # "configured" and "working" are not the same claim.
  case "$policy" in
    *'"last_success"'*) return 0 ;;
    *) printf 'WARNING: %s has never completed a snapshot successfully\n' "$policy_name" >&2; return 1 ;;
  esac
}

cmd_snapshot() {
  need kubectl
  case "${1:-status}" in
    status) snapshot_status ;;
    run)
      es_curl POST "/_slm/policy/${MX_COMMON_SNAPSHOT_POLICY:-mx-common-daily}/_execute"
      printf '\n'
      say "snapshot started; watch it with: bash scripts/manage.sh snapshot list"
      ;;
    list) es_curl GET "/_snapshot/${MX_COMMON_SNAPSHOT_REPOSITORY:-mx-common-snapshots}/_all?verbose=false"; printf '\n' ;;
    apply) ensure_snapshot_policy ;;
    *) die "unknown snapshot command: $1" ;;
  esac
}

# ---------------------------------------------------------------------------
# Per-product provisioning
# ---------------------------------------------------------------------------

psql_super() {
  local database="${1:-mx_common}"
  shift
  kubectl -n "$NAMESPACE" exec -i statefulset/mx-common-postgres -- \
    psql -v ON_ERROR_STOP=1 -U mx_common -d "$database" -q "$@"
}

# `mx-insight-hub` -> `mx_insight_hub`. Identifiers cannot contain hyphens
# without quoting at every use site, so the mapping is done once, here.
product_identifier() {
  printf '%s' "$1" | tr '-' '_'
}

# Passwords are generated from [A-Za-z0-9] only. That is not cosmetic: it makes
# single-quoted SQL literals and URL userinfo safe without escaping, removing a
# whole class of quoting bugs from a path that runs unattended during deploy.
#
# Every read is BOUNDED. The obvious spelling of this,
#
#   tr -dc 'A-Za-z0-9' </dev/urandom | head -c 40
#
# is a trap under `set -o pipefail`: tr reads an infinite stream, head exits at
# 40 bytes, tr dies of SIGPIPE with status 141, pipefail propagates it and
# `set -e` kills the script — silently, before anything can be logged. Reading a
# fixed number of bytes lets every command in the pipeline exit normally.
generate_password() {
  local candidate=""
  while [ "${#candidate}" -lt 40 ]; do
    # ~96 random bytes yields ~60 usable characters; the loop covers the case
    # where a draw happens to be filtered down below the target.
    candidate="${candidate}$(head -c 96 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  done
  printf '%s' "${candidate:0:40}"
}

# Create (idempotently) a product's role, database and extensions, then print the
# DSN on stdout. Everything else this script prints goes to stderr, so callers
# can capture the DSN with a plain command substitution.
cmd_provision() {
  need kubectl
  local product_id="$1"
  local password="${2:-}"
  [ -n "$product_id" ] || die "usage: manage.sh provision <productId> [password]"
  case "$product_id" in
    [a-z]*[a-z0-9]) : ;;
    *) die "productId must be lowercase alphanumeric with hyphens: $product_id" ;;
  esac

  local identifier secret_name
  identifier="$(product_identifier "$product_id")"
  secret_name="mx-common-db-${product_id}"

  # The generated password is stored in the shared namespace so re-provisioning
  # is idempotent. Regenerating it on every deploy would rotate the credential
  # out from under running product pods.
  if [ -z "$password" ]; then
    password="$(kubectl -n "$NAMESPACE" get secret "$secret_name" \
      -o jsonpath='{.data.password}' 2>/dev/null | base64 -d 2>/dev/null || true)"
  fi
  if [ -z "$password" ]; then
    password="$(generate_password)"
    say "generated a database password for ${product_id}" >&2
  fi
  case "$password" in
    *[!A-Za-z0-9]*) die "password must be alphanumeric so it is safe in SQL literals and DSNs" ;;
  esac

  kubectl -n "$NAMESPACE" create secret generic "$secret_name" \
    --from-literal=password="$password" \
    --from-literal=database="$identifier" \
    --from-literal=username="$identifier" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  # Role first. ALTER on the existing branch keeps the stored secret and the
  # live credential in agreement even if one of them was changed by hand.
  psql_super mx_common >/dev/null <<SQL
DO \$provision\$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${identifier}') THEN
    ALTER ROLE ${identifier} WITH LOGIN PASSWORD '${password}';
  ELSE
    CREATE ROLE ${identifier} WITH LOGIN PASSWORD '${password}';
  END IF;
END
\$provision\$;
SQL

  # CREATE DATABASE cannot run inside a transaction or a DO block, so it goes
  # through psql's \gexec instead of an IF NOT EXISTS guard.
  psql_super mx_common >/dev/null <<SQL
SELECT 'CREATE DATABASE ${identifier} OWNER ${identifier}'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${identifier}')\gexec
SQL

  # Extensions are installed by the superuser into the product database. pg_trgm
  # is trusted from PostgreSQL 13 and the product role could install it itself,
  # but `vector` is not — doing both here keeps product migrations free of any
  # privilege assumption.
  psql_super "$identifier" >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS vector;
SQL

  # The product role owns the database but not the public schema, which in
  # PostgreSQL 15+ is owned by the bootstrap superuser and is not writable by
  # others by default.
  psql_super "$identifier" >/dev/null <<SQL
ALTER SCHEMA public OWNER TO ${identifier};
GRANT ALL ON SCHEMA public TO ${identifier};
SQL

  say "provisioned database ${identifier} for ${product_id}" >&2
  printf 'postgres://%s:%s@mx-common-postgres.%s.svc.cluster.local:5432/%s\n' \
    "$identifier" "$password" "$NAMESPACE" "$identifier"
}

# Recreate the shared stateful workloads and their storage from scratch.
#
# The only way to change a StatefulSet's volumeClaimTemplate, which Kubernetes
# treats as immutable. Separate command, never part of ensure, and it names what
# it destroys first: every index and every product database goes with it.
cmd_reset_storage() {
  need kubectl
  if [ "${MX_COMMON_CONFIRM_DESTROY:-}" != "mx-common" ]; then
    say "This DESTROYS all shared data:" >&2
    say "  every Elasticsearch index (rebuildable projections)" >&2
    say "  every product database in the shared PostgreSQL (NOT rebuildable)" >&2
    say "  the PVCs, the PVs and ${HOST_DATA_ROOT}" >&2
    die "Re-run with MX_COMMON_CONFIRM_DESTROY=mx-common to proceed"
  fi
  kubectl -n "$NAMESPACE" delete statefulset mx-common-elasticsearch mx-common-postgres --ignore-not-found
  kubectl -n "$NAMESPACE" delete deployment mx-common-redis --ignore-not-found
  kubectl -n "$NAMESPACE" delete pvc --all --ignore-not-found
  kubectl delete pv -l app.kubernetes.io/part-of=mx-common --ignore-not-found
  rm -rf -- "${HOST_DATA_ROOT:?}"/* 2>/dev/null \
    || sudo -n rm -rf -- "${HOST_DATA_ROOT:?}"/* 2>/dev/null \
    || warn "could not clear ${HOST_DATA_ROOT}; remove it as root"
  say "storage reset. Run `ensure` to recreate, then re-provision each product database."
}

cmd_status() {
  need kubectl
  kubectl -n "$NAMESPACE" get statefulsets,deployments,services,pvc 2>/dev/null || {
    say "namespace ${NAMESPACE} does not exist"
    return 0
  }
  kubectl get pv -l app.kubernetes.io/part-of=mx-common -o wide 2>/dev/null || true
  printf '\nHealth: %s\n' "$(health_json)"
  say "Elasticsearch indices:"
  kubectl -n "$NAMESPACE" exec statefulset/mx-common-elasticsearch -c elasticsearch -- \
    curl -fsS --max-time 5 'http://127.0.0.1:9200/_cat/indices?v&s=index' 2>/dev/null || true
}

cmd_health() {
  need kubectl
  local output
  output="$(health_json)"
  printf '%s\n' "$output"
  es_is_healthy
}

cmd_plan() {
  local file
  while IFS= read -r file; do
    printf '\n===== %s =====\n' "${file#"${ROOT_DIR}/"}"
    render_manifest "$file"
  done < <(manifest_list)
}

# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

images_in_use() {
  printf '%s\n' "$POSTGRES_IMAGE" "$ELASTICSEARCH_IMAGE" "$REDIS_IMAGE"
}

containerd_has_image() {
  local image="$1"
  local canonical
  canonical="$(canonical_image_ref "$image")"
  if [ "$(id -u)" -eq 0 ]; then
    ctr -n k8s.io images ls -q 2>/dev/null | grep -Fqx -e "$canonical" -e "$image"
  else
    sudo -n ctr -n k8s.io images ls -q 2>/dev/null | grep -Fqx -e "$canonical" -e "$image"
  fi
}

canonical_image_ref() {
  local image="$1" first
  if [[ "$image" != */* ]]; then
    printf 'docker.io/library/%s\n' "$image"
    return 0
  fi
  first="${image%%/*}"
  case "$first" in
    *.*|*:*|localhost) printf '%s\n' "$image" ;;
    *) printf 'docker.io/%s\n' "$image" ;;
  esac
}

# Report which images the node already has BEFORE applying anything.
#
# This is the difference between "ensure sat silent for five minutes then
# failed" and "ensure told you up front it was about to pull 1.3GB".
report_image_readiness() {
  local image missing=0
  while IFS= read -r image; do
    if containerd_has_image "$image"; then
      say "image present: ${image}"
    else
      say "image NOT cached, will be pulled: ${image}"
      missing=$((missing + 1))
    fi
  done < <(images_in_use)
  if [ "$missing" -gt 0 ]; then
    say "${missing} image(s) not cached; Elasticsearch alone is ~1.3GB."
    # Preloading through Docker beats letting the kubelet pull: the pull happens
    # here, with visible progress and a real error if it fails, instead of
    # inside a pod that just sits in ContainerCreating.
    if [ "${MX_COMMON_AUTO_PRELOAD:-1}" = "1" ] && command -v docker >/dev/null 2>&1; then
      say "preloading images through Docker (set MX_COMMON_AUTO_PRELOAD=0 to skip)"
      cmd_preload || warn "preload did not complete; the kubelet will try to pull directly"
    else
      say "  Set a mirror:  MX_COMMON_ELASTICSEARCH_IMAGE=<mirror>/elasticsearch:9.4.2"
      say "  Or preload:    bash scripts/manage.sh preload"
    fi
  fi
}

# Pull through Docker and import into containerd, matching how mx-insight-hub
# already gets its own image onto this node.
cmd_preload() {
  need docker
  local image failed=0
  while IFS= read -r image; do
    if containerd_has_image "$image"; then
      say "already imported: ${image}"
      continue
    fi
    say "pulling ${image}"
    if ! docker pull "$image"; then
      warn "could not pull ${image}"
      failed=1
      continue
    fi
    local archive
    archive="$(mktemp -t mx-common-image.XXXXXX).tar"
    docker image save -o "$archive" "$image"
    if [ "$(id -u)" -eq 0 ]; then
      ctr -n k8s.io images import "$archive"
    else
      need sudo
      sudo ctr -n k8s.io images import "$archive"
    fi
    rm -f -- "$archive"
    say "imported ${image}"
  done < <(images_in_use)
  [ "$failed" -eq 0 ] || die "one or more images could not be pulled"
  say "all shared data-plane images are present on this node"
}

ensure_hanlp_builder() {
  docker buildx version >/dev/null 2>&1 \
    || die "HanLP's resource-bounded build requires the Docker buildx plugin"
  case "$HANLP_BUILDER" in
    ''|*[!A-Za-z0-9_.-]*) die "MX_COMMON_HANLP_BUILDER contains unsupported characters" ;;
  esac

  local expected_http_proxy expected_https_proxy proxy_checksum proxy_size proxy_fingerprint
  expected_http_proxy="${HTTP_PROXY:-${http_proxy:-}}"
  expected_https_proxy="${HTTPS_PROXY:-${https_proxy:-}}"
  read -r proxy_checksum proxy_size _ < <(
    printf '%s\n%s\n' "$expected_http_proxy" "$expected_https_proxy" | cksum
  )
  proxy_fingerprint="${proxy_checksum}-${proxy_size}"

  local -a create_args=(
    --name "$HANLP_BUILDER"
    --driver docker-container
    --driver-opt "memory=${HANLP_BUILD_MEMORY}"
    --driver-opt "memory-swap=${HANLP_BUILD_MEMORY}"
    --driver-opt "cpu-period=100000"
    --driver-opt "cpu-quota=${HANLP_BUILD_CPU_QUOTA}"
    --driver-opt network=host
    --driver-opt "env.MX_COMMON_HANLP_PROXY_CONFIG=${proxy_fingerprint}"
    --buildkitd-flags '--allow-insecure-entitlement network.host'
  )
  # NO_PROXY is intentionally not a driver option: its comma-separated value
  # is parsed by buildx as multiple driver options. Docker's normal build args
  # provide it to RUN steps below.
  [ -n "$expected_http_proxy" ] \
    && create_args+=(--driver-opt "env.HTTP_PROXY=${expected_http_proxy}")
  [ -n "$expected_https_proxy" ] \
    && create_args+=(--driver-opt "env.HTTPS_PROXY=${expected_https_proxy}")

  if ! docker buildx inspect "$HANLP_BUILDER" >/dev/null 2>&1; then
    docker buildx create "${create_args[@]}" >/dev/null \
      || die "could not create constrained buildx builder ${HANLP_BUILDER}"
    say "created constrained buildx builder ${HANLP_BUILDER}"
  elif ! docker buildx inspect "$HANLP_BUILDER" \
      | grep -Eq '^Driver:[[:space:]]+docker-container$'; then
    die "buildx builder ${HANLP_BUILDER} exists but does not use the docker-container driver"
  fi

  docker buildx inspect --bootstrap "$HANLP_BUILDER" >/dev/null \
    || die "could not start buildx builder ${HANLP_BUILDER}"

  # Driver options are applied at creation; docker update also converges an
  # existing builder when an operator changes the limits later.
  local builder_container
  builder_container="$(
    docker ps -aq --filter "label=com.docker.buildx.builder=${HANLP_BUILDER}" | head -1
  )"
  if [ -z "$builder_container" ]; then
    builder_container="$(
      docker ps -aq --filter "name=^/buildx_buildkit_${HANLP_BUILDER}0$" | head -1
    )"
  fi
  [ -n "$builder_container" ] \
    || die "cannot locate the buildkit container for ${HANLP_BUILDER}"

  # Builders created by older manage.sh versions lack the entitlement required
  # for a RUN step to reach a host-local proxy such as 127.0.0.1:7788. A builder
  # also has to be reconciled when the operator adds, changes or removes its
  # proxy. Recreate only this dedicated builder and retain its BuildKit cache.
  local builder_args builder_env builder_proxy_fingerprint="" recreate_reason="" proxy_entry
  builder_args="$(docker inspect --format '{{json .Args}}' "$builder_container" 2>/dev/null || true)"
  builder_env="$(
    docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' \
      "$builder_container" 2>/dev/null || true
  )"
  while IFS= read -r proxy_entry; do
    case "$proxy_entry" in
      MX_COMMON_HANLP_PROXY_CONFIG=*)
        builder_proxy_fingerprint="${proxy_entry#MX_COMMON_HANLP_PROXY_CONFIG=}"
        break
        ;;
    esac
  done <<< "$builder_env"
  if [[ "$builder_args" != *allow-insecure-entitlement*network.host* ]]; then
    recreate_reason="host-network support changed"
  elif [ "$builder_proxy_fingerprint" != "$proxy_fingerprint" ]; then
    recreate_reason="proxy configuration changed"
  fi
  if [ -n "$recreate_reason" ]; then
    say "recreating builder ${HANLP_BUILDER}: ${recreate_reason}"
    docker buildx rm --keep-state "$HANLP_BUILDER" >/dev/null \
      || die "could not replace buildx builder ${HANLP_BUILDER}"
    docker buildx create "${create_args[@]}" >/dev/null \
      || die "could not recreate constrained buildx builder ${HANLP_BUILDER}"
    docker buildx inspect --bootstrap "$HANLP_BUILDER" >/dev/null \
      || die "could not start recreated buildx builder ${HANLP_BUILDER}"
    builder_container="$(
      docker ps -aq --filter "label=com.docker.buildx.builder=${HANLP_BUILDER}" | head -1
    )"
    if [ -z "$builder_container" ]; then
      builder_container="$(
        docker ps -aq --filter "name=^/buildx_buildkit_${HANLP_BUILDER}0$" | head -1
      )"
    fi
    [ -n "$builder_container" ] \
      || die "cannot locate the recreated buildkit container for ${HANLP_BUILDER}"
  fi
  docker update \
    --memory "$HANLP_BUILD_MEMORY" \
    --memory-swap "$HANLP_BUILD_MEMORY" \
    --cpu-period 100000 \
    --cpu-quota "$HANLP_BUILD_CPU_QUOTA" \
    "$builder_container" >/dev/null \
    || die "could not enforce HanLP build CPU/memory limits"
}

build_hanlp_image() {
  need docker
  ensure_hanlp_builder
  local -a proxy_build_args=()
  local proxy_name
  # Predefined Docker proxy build args are excluded from image history. Pass
  # only names whose values are exported by the caller, so pip/model downloads
  # use the same scoped proxy as buildkitd without baking credentials in.
  for proxy_name in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    [ -n "${!proxy_name:-}" ] && proxy_build_args+=(--build-arg "$proxy_name")
  done
  say "building model-preloaded HanLP image ${HANLP_IMAGE}"
  if ! docker buildx build \
      --builder "$HANLP_BUILDER" \
      --load \
      --network host \
      --allow network.host \
      --build-arg PREFETCH_MODEL=1 \
      "${proxy_build_args[@]}" \
      -t "$HANLP_IMAGE" \
      -f "${ROOT_DIR}/deploy/hanlp/Dockerfile" \
      "${ROOT_DIR}/deploy/hanlp"; then
    docker buildx stop "$HANLP_BUILDER" >/dev/null 2>&1 || true
    die "HanLP image build failed; downloads are cached, so fix the network/proxy and rerun the same command"
  fi
  docker buildx stop "$HANLP_BUILDER" >/dev/null 2>&1 \
    || warn "could not stop the now-idle HanLP buildx builder"

  MX_COMMON_HANLP_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$HANLP_IMAGE")"
  [ -n "$MX_COMMON_HANLP_IMAGE_ID" ] || die "Docker did not return an image ID for ${HANLP_IMAGE}"
  export MX_COMMON_HANLP_IMAGE_ID
  say "HanLP image ready: ${MX_COMMON_HANLP_IMAGE_ID}"
}

import_hanlp_image() (
  need ctr
  local archive current_image_id
  archive="$(mktemp -t mx-common-hanlp.XXXXXX).tar"
  trap 'rm -f -- "$archive"' EXIT HUP INT TERM

  say "importing ${HANLP_IMAGE} into k8s.io containerd"
  docker image save -o "$archive" "$HANLP_IMAGE"
  current_image_id="$(docker image inspect --format '{{.Id}}' "$HANLP_IMAGE" 2>/dev/null || true)"
  [ "$current_image_id" = "$MX_COMMON_HANLP_IMAGE_ID" ] \
    || die "${HANLP_IMAGE} changed while its archive was being created; retry the deploy"
  if [ "$(id -u)" -eq 0 ]; then
    ctr -n k8s.io images import "$archive" \
      || die "containerd could not import ${HANLP_IMAGE}"
  else
    need sudo
    sudo -n ctr -n k8s.io images import "$archive" \
      || die "non-interactive sudo cannot import ${HANLP_IMAGE} into containerd"
  fi
  containerd_has_image "$HANLP_IMAGE" \
    || die "containerd import completed but ${HANLP_IMAGE} is not present in k8s.io"
  say "imported ${HANLP_IMAGE}"
)

require_local_single_k8s_node() {
  local nodes count node_name node_details node_hostname node_ips local_names local_ips matches=0
  if ! nodes="$(kubectl get nodes \
      -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null)"; then
    die "cannot query Kubernetes nodes; check the current kubeconfig/context"
  fi
  count="$(printf '%s\n' "$nodes" | awk 'NF { count += 1 } END { print count + 0 }')"
  [ "$count" -eq 1 ] \
    || die "local HanLP image and hostPath storage require exactly one Kubernetes node; found ${count}"

  node_name="$(printf '%s\n' "$nodes" | awk 'NF { print; exit }')"
  if ! node_details="$(kubectl get node "$node_name" \
      -o jsonpath='{.metadata.labels.kubernetes\.io/hostname}{"\n"}{range .status.addresses[?(@.type=="InternalIP")]}{.address}{"\n"}{end}' \
      2>/dev/null)"; then
    die "cannot inspect Kubernetes node ${node_name}"
  fi
  node_hostname="$(printf '%s\n' "$node_details" | sed -n '1p')"
  node_ips="$(printf '%s\n' "$node_details" | sed '1d')"
  [ -n "$node_hostname" ] \
    || die "Kubernetes node ${node_name} has no kubernetes.io/hostname label"
  local_names="$(
    hostname 2>/dev/null || true
    hostname -f 2>/dev/null || true
  )"
  local_ips="$(
    hostname -I 2>/dev/null | tr ' ' '\n' || true
    if command -v ip >/dev/null 2>&1; then
      ip -o addr show 2>/dev/null | awk '{ split($4, part, "/"); print part[1] }'
    fi
  )"

  if printf '%s\n' "$local_names" | grep -Fqx -- "$node_name"; then
    matches=1
  else
    local node_ip
    while IFS= read -r node_ip; do
      [ -n "$node_ip" ] || continue
      if printf '%s\n' "$local_ips" | grep -Fqx -- "$node_ip"; then
        matches=1
        break
      fi
    done <<EOF
$node_ips
EOF
  fi
  [ "$matches" -eq 1 ] \
    || die "kubectl points at node ${node_name}, but this host is not that node; run 'deploy hanlp' on the Kubernetes node itself"

  MX_COMMON_HANLP_NODE_NAME="$node_hostname"
  export MX_COMMON_HANLP_NODE_NAME
  say "verified local Kubernetes node: ${node_name} (hostname label ${node_hostname})"
}

require_hanlp_disk_capacity() {
  local minimum_gib="${MX_COMMON_HANLP_MIN_FREE_GIB:-8}" docker_root path checked_path available_kib
  case "$minimum_gib" in
    ''|*[!0-9]*) die "MX_COMMON_HANLP_MIN_FREE_GIB must be a non-negative integer" ;;
  esac
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  [ -n "$docker_root" ] || die "cannot determine DockerRootDir; is the Docker daemon running?"

  for path in \
      "$docker_root" \
      "${TMPDIR:-/tmp}" \
      "${MX_COMMON_CONTAINERD_ROOT:-/var/lib/containerd}" \
      "$HOST_DATA_ROOT"; do
    case "$path" in
      /*) ;;
      *) die "disk preflight paths must be absolute: ${path}" ;;
    esac
    checked_path="$path"
    while [ ! -e "$checked_path" ] && [ "$checked_path" != / ]; do
      checked_path="${checked_path%/*}"
      [ -n "$checked_path" ] || checked_path=/
    done
    available_kib="$(df -Pk "$checked_path" 2>/dev/null | awk 'NR == 2 { print $4 }')"
    [ -n "$available_kib" ] || die "cannot measure free disk space for ${path}"
    [ "$available_kib" -ge $((minimum_gib * 1024 * 1024)) ] \
      || die "HanLP build/import needs at least ${minimum_gib}GiB free on ${path}"
  done
  say "HanLP build/import disk preflight passed (${minimum_gib}GiB minimum)."
}

ensure_hanlp_storage() {
  if has_default_storage_class; then
    say "default StorageClass present; using dynamic provisioning for HanLP"
    return 0
  fi
  say "no default StorageClass; provisioning retained HanLP model PV"
  ensure_local_pv mx-common-hanlp-models mx-common-hanlp-models 10Gi hanlp/models 1000:1000 0755
}

hanlp_tokenize_smoke() {
  kubectl -n "$NAMESPACE" exec deployment/mx-common-hanlp -- python -c \
    'import json, sys, urllib.error, urllib.request
body = json.dumps({"text": "吴恩达与人工智能", "coarse": True}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:8000/tokenize",
    data=body,
    headers={"content-type": "application/json"},
)
try:
    response = urllib.request.urlopen(request, timeout=10)
    raw = response.read(65537)
except urllib.error.HTTPError as error:
    detail = " ".join(error.read(2049).decode("utf-8", "replace").split())[:2048]
    detail = detail or "[empty body]"
    print(f"HanLP /tokenize returned HTTP {error.code}: {detail}", file=sys.stderr)
    raise SystemExit(1)
if len(raw) > 65536:
    print("HanLP /tokenize response exceeds 65536 bytes", file=sys.stderr)
    raise SystemExit(1)
try:
    result = json.loads(raw)
except (UnicodeDecodeError, json.JSONDecodeError):
    print("HanLP /tokenize returned invalid JSON", file=sys.stderr)
    raise SystemExit(1)
tokens = result if isinstance(result, list) else []
flat = [token for sentence in tokens for token in (sentence if isinstance(sentence, list) else [sentence])]
if not any(isinstance(token, str) and token.strip() for token in flat):
    print("HanLP /tokenize returned no tokens", file=sys.stderr)
    raise SystemExit(1)'
}

cmd_deploy_hanlp() {
  need docker
  need kubectl
  need ctr
  require_local_single_k8s_node
  case "$HANLP_WAIT_TIMEOUT" in
    ''|*[!0-9]*) die "MX_COMMON_HANLP_WAIT_TIMEOUT must be an integer" ;;
  esac
  [ "$HANLP_WAIT_TIMEOUT" -ge 660 ] \
    || die "MX_COMMON_HANLP_WAIT_TIMEOUT must be at least 660 seconds"
  WAIT_TIMEOUT="$HANLP_WAIT_TIMEOUT"

  report_capacity hanlp
  require_hanlp_disk_capacity
  build_hanlp_image
  # Import every successful build. A tag-exists check cannot prove that Docker
  # and containerd hold the same content for a mutable local tag; re-importing
  # the exact archive is deterministic and self-heals stale node images.
  import_hanlp_image

  kubectl apply -f "${K8S_DIR}/common/00-namespace.yaml" >/dev/null
  ensure_hanlp_storage
  render_manifest "${K8S_DIR}/optional/50-hanlp.yaml" | kubectl apply -f - >/dev/null
  render_manifest "${K8S_DIR}/common/40-network-policy.yaml" | kubectl apply -f - >/dev/null
  allow_hostnetwork_clients

  local target_namespaces="${MX_COMMON_CLIENT_NAMESPACES:-mx-insight-hub}" namespace
  for namespace in $target_namespaces; do
    allow_client_namespace "$namespace"
  done

  wait_ready deployment mx-common-hanlp

  if ! hanlp_is_healthy; then
    diagnose_workload mx-common-hanlp
    die "HanLP deployment is not serving /health"
  fi
  if ! hanlp_tokenize_smoke; then
    diagnose_workload mx-common-hanlp
    die "HanLP deployment failed the /tokenize contract smoke"
  fi
  say "HanLP deployment ready: ${HANLP_SERVICE_URL}"
  say "Redeploy mx-insight-hub to auto-discover this ready endpoint."
}

cmd_deploy() {
  [ "$#" -le 1 ] || die "usage: manage.sh deploy [hanlp]"
  case "${1:-}" in
    "") cmd_ensure ;;
    hanlp) cmd_deploy_hanlp ;;
    *) die "unknown deploy target: $1" ;;
  esac
}

# ---------------------------------------------------------------------------
# Capacity
# ---------------------------------------------------------------------------

# Compare what this stack requests against what the node can still allocate.
#
# Reported as a warning rather than a hard gate: Kubernetes schedules on
# requests, and a node that is tight but sufficient should not be blocked by a
# script's arithmetic. But an operator asking "is memory too small?" deserves
# the numbers rather than a guess.
report_capacity() {
  local component="${1:-core}" allocatable requested_mi=0
  allocatable="$(kubectl get nodes -o jsonpath='{.items[0].status.allocatable.memory}' 2>/dev/null || true)"
  [ -n "$allocatable" ] || return 0

  # PostgreSQL 2Gi + Elasticsearch 10Gi + Redis 512Mi of *requests*.
  requested_mi=$((2048 + 10240 + 512))
  [ "$component" = "hanlp" ] && requested_mi=$((requested_mi + 1024))

  local allocatable_mi=0
  case "$allocatable" in
    *Ki) allocatable_mi=$(( ${allocatable%Ki} / 1024 )) ;;
    *Mi) allocatable_mi=${allocatable%Mi} ;;
    *Gi) allocatable_mi=$(( ${allocatable%Gi} * 1024 )) ;;
  esac
  [ "$allocatable_mi" -gt 0 ] || return 0

  say "node allocatable memory: ${allocatable_mi}Mi; this stack requests ${requested_mi}Mi"
  if [ "$allocatable_mi" -lt $((requested_mi * 2)) ]; then
    warn "memory is tight. Elasticsearch requests 2Gi (1g heap, 3Gi limit) and this"
    warn "node also runs Night-All, the Hub and its workers."
    warn "  Shrink the heap:  MX_COMMON_ELASTICSEARCH_HEAP=512m bash scripts/manage.sh ensure"
    warn "  Keep the memory request at roughly twice the heap; the rest is the"
    warn "  off-heap page cache Lucene reads segments through."
  fi
}

cmd_down() {
  need kubectl
  kubectl -n "$NAMESPACE" scale statefulset/mx-common-elasticsearch --replicas=0 >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" scale deployment/mx-common-redis --replicas=0 >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" scale deployment/mx-common-hanlp --replicas=0 >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" scale statefulset/mx-common-postgres --replicas=0 >/dev/null 2>&1 || true
  say "shared workloads scaled to zero. PVCs, PVs, indices and the namespace were preserved."
}

cmd_logs() {
  need kubectl
  case "${1:-elasticsearch}" in
    elasticsearch) kubectl -n "$NAMESPACE" logs statefulset/mx-common-elasticsearch --tail=200 ;;
    redis) kubectl -n "$NAMESPACE" logs deployment/mx-common-redis --tail=200 ;;
    hanlp) kubectl -n "$NAMESPACE" logs deployment/mx-common-hanlp --tail=200 ;;
    postgres) kubectl -n "$NAMESPACE" logs statefulset/mx-common-postgres --tail=200 ;;
    *) die "unknown service: $1" ;;
  esac
}

main() {
  case "${1:-}" in
    ensure) cmd_ensure ;;
    provision) shift; cmd_provision "${1:-}" "${2:-}" ;;
    preload) cmd_preload ;;
    reset-storage) cmd_reset_storage ;;
    migrate-storage) shift; cmd_migrate_storage "$@" ;;
    relocate) shift; cmd_relocate "$@" ;;
    deploy) shift; cmd_deploy "$@" ;;
    snapshot) shift; cmd_snapshot "${1:-status}" ;;
    status) cmd_status ;;
    health) cmd_health ;;
    plan) cmd_plan ;;
    down) cmd_down ;;
    logs) shift; cmd_logs "${1:-elasticsearch}" ;;
    *) usage; exit 2 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
