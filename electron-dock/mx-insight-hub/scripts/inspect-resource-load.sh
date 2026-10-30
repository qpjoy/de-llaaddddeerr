#!/usr/bin/env bash
# Read-only, no workload probes or supplier calls. Run on the cluster operator host.
set -euo pipefail
kubectl --request-timeout=15s top nodes
kubectl --request-timeout=15s -n mx-insight-hub top pods --containers
kubectl --request-timeout=15s -n mx-common top pods --containers
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
