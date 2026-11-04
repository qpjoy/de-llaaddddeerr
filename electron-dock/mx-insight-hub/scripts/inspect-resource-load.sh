#!/usr/bin/env bash
# Read-only, no workload probes or supplier calls. Run on the cluster operator host.
set -euo pipefail
# Metrics Server is optional. A missing API must not prevent the independent
# cgroup, Hub pressure and HanLP health checks below from running.
optional() {
  local label="$1"; shift
  printf '\n--- %s ---\n' "$label"
  if "$@"; then :; else printf 'unavailable: %s; continuing other checks\n' "$label" >&2; fi
}
optional node-metrics kubectl --request-timeout=15s top nodes
optional hub-metrics kubectl --request-timeout=15s -n mx-insight-hub top pods --containers
optional common-metrics kubectl --request-timeout=15s -n mx-common top pods --containers

# Direct container counters need no Metrics API. Never read env/config/secrets.
# CPU usage/throttling are cumulative: compare the two timestamps. These paths
# describe the mounted cgroup; a non-namespaced mount may describe an ancestor.
for target in mx-insight-hub:mx-insight-hub-public mx-insight-hub:mx-insight-hub-admin mx-common:mx-common-hanlp; do
  namespace="${target%%:*}"
  deployment="${target#*:}"
  optional "cgroup:$target" kubectl --request-timeout=30s -n "$namespace" exec -i "deployment/$deployment" -- sh -s <<'CGROUP'
for sample in 1 2; do
  date -u '+observedAt=%Y-%m-%dT%H:%M:%SZ'
  found=0
  for file in /sys/fs/cgroup/cpu.stat /sys/fs/cgroup/cpu.max \
    /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.events \
    /sys/fs/cgroup/cpuacct/cpuacct.usage /sys/fs/cgroup/cpu/cpu.stat \
    /sys/fs/cgroup/cpu/cpu.cfs_quota_us /sys/fs/cgroup/cpu/cpu.cfs_period_us \
    /sys/fs/cgroup/cpu,cpuacct/cpu.stat /sys/fs/cgroup/cpu,cpuacct/cpuacct.usage \
    /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_quota_us /sys/fs/cgroup/cpu,cpuacct/cpu.cfs_period_us \
    /sys/fs/cgroup/memory/memory.usage_in_bytes /sys/fs/cgroup/memory/memory.limit_in_bytes \
    /sys/fs/cgroup/memory/memory.max_usage_in_bytes /sys/fs/cgroup/memory/memory.failcnt \
    /sys/fs/cgroup/memory/memory.oom_control; do
    if [ -r "$file" ]; then
      printf '%s\n' "$file"
      cat "$file"
      found=1
    fi
  done
  if [ "$found" = 0 ]; then printf 'cgroup counters unavailable at standard paths\n'; fi
  if [ "$sample" = 1 ]; then sleep 10; fi
done
CGROUP
done
kubectl --request-timeout=15s -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -- node --input-type=module - <<'NODE'
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function get(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { unavailable: true, status: response.status }
    return await response.json()
  } catch { return { unavailable: true } }
}
const adminUrl = `http://127.0.0.1:${process.env.MX_INSIGHT_PORT || '18151'}/internal/v1/admin/data-pressure`
let hanlpUrl
try { const url = new URL(process.env.MX_COMMON_HANLP_URL); url.pathname = '/health'; url.search = ''; hanlpUrl = url.href } catch {}
for (let index = 0; index < 3; index++) {
  const [pressure, health] = await Promise.all([
    get(adminUrl, { 'x-mx-insight-admin-token': process.env.MX_INSIGHT_ADMIN_TOKEN || '' }),
    hanlpUrl ? get(hanlpUrl) : Promise.resolve({ unavailable: true }),
  ])
  console.log(JSON.stringify({ observedAt: new Date().toISOString(),
    scopeNote: 'Hub pressure is this Admin process only, not Public worker totals. HanLP health is shared-service evidence. No inference or supplier request was sent.',
    adminPressure: pressure.data ? { processId: pressure.data.processId, admission: pressure.data.admission,
      resources: pressure.data.resources, databases: pressure.data.databases, tokenizer: pressure.data.tokenizer } : pressure,
    hanlp: health.pool ? { status: health.status, workers: health.pool.workers, liveWorkers: health.pool.liveWorkers,
      threadsPerWorker: health.pool.threadsPerWorker, reservedForInteractive: health.pool.reservedForInteractive,
      queued: health.pool.queued, skippedDisconnected: health.pool.skippedDisconnected, replacedWorkers: health.pool.replacedWorkers } : { status: health.status, unavailable: true },
  }))
  if (index < 2) await wait(10000)
}
NODE
