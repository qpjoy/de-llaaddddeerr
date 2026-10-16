#!/usr/bin/env bash
# Current Public Pod evidence only; no DB, paid endpoint, rollout or config write.
set -euo pipefail
set +x
if [[ $# -ne 0 ]]; then
  echo 'Usage: bash diagnose-night-all-crawl-runtime.sh' >&2
  exit 1
fi
pod="$(kubectl -n mx-insight-hub get pods \
  -l app.kubernetes.io/name=mx-insight-hub-public \
  -o 'jsonpath={range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}')"
if [[ -z "$pod" || "$pod" == *$'\n'* || ! "$pod" =~ ^[a-z0-9][a-z0-9.-]*$ ]]; then
  echo 'Expected exactly one running Hub Public Pod; inspect the deployment before retrying.' >&2
  exit 1
fi
kubectl -n mx-insight-hub get pod "$pod" -o \
  'custom-columns=NAME:.metadata.name,NODE:.spec.nodeName,HOST_NETWORK:.spec.hostNetwork,CREATED:.metadata.creationTimestamp,DELETING:.metadata.deletionTimestamp,CONTAINER:.status.containerStatuses[*].name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,IMAGE:.status.containerStatuses[*].image,IMAGE_ID:.status.containerStatuses[*].imageID'
cm_timeout="$(kubectl -n mx-insight-hub get configmap mx-insight-hub-config \
  -o 'jsonpath={.data.NIGHT_ALL_TIMEOUT_MS}')"
kubectl -n mx-insight-hub exec -i "$pod" -c api -- \
  node --input-type=module - "$cm_timeout" <<'NODE'
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const positiveInteger = value => {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 'invalid_value_hidden';
};
const report = { revision: 'night-all-crawl-runtime.v1', checkedAt: new Date().toISOString(),
  configMapTimeoutMs: positiveInteger(process.argv[2]),
  publicContainerTimeoutMs: positiveInteger(process.env.NIGHT_ALL_TIMEOUT_MS),
  effectiveTimeoutMs: null,
  effectiveConfigStatus: 'not_loaded_to_avoid_runtime_initializers', sources: {} };
// Fingerprint the deployed files without importing application/integration code.
for (const path of ['server/config.mjs', 'server/adapters/night-all.mjs']) {
  try {
    const bytes = await readFile(path);
    report.sources[path] = { sha256: createHash('sha256').update(bytes).digest('hex') };
    if (path === 'server/config.mjs') {
      const match = bytes.toString().match(/positiveInteger\(environment\.NIGHT_ALL_TIMEOUT_MS,\s*([0-9_]+),\s*['"]NIGHT_ALL_TIMEOUT_MS['"]\)/);
      report.configSourceDefaultTimeoutMs = match ? positiveInteger(match[1].replaceAll('_', '')) : null;
    }
  } catch { report.sources[path] = { state: 'unavailable' }; }
}
const started = performance.now();
try {
  const base = process.env.NIGHT_ALL_BASE_URL || 'http://127.0.0.1:13141';
  const parsed = new URL(base);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Object.assign(new Error(), { code: 'unsupported_base_url' });
  }
  report.target = { origin: parsed.origin,
    path: ['/', '/api', '/api/', '/api/v1', '/api/v1/'].includes(parsed.pathname)
      ? parsed.pathname : '[nonstandard_path_hidden]',
    source: process.env.NIGHT_ALL_BASE_URL ? 'public_container_environment' : 'adapter_default' };
  const response = await fetch(base.replace(/\/$/, '') + '/api/v1/health', {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: process.env.NIGHT_ALL_SERVICE_TOKEN
      ? { authorization: `Bearer ${process.env.NIGHT_ALL_SERVICE_TOKEN}` } : {},
  });
  report.healthNow = { httpStatus: response.status, durationMs: Math.round(performance.now() - started) };
  await response.body?.cancel();
} catch (error) {
  const code = error.cause?.code || error.code;
  report.healthNow = { durationMs: Math.round(performance.now() - started),
    errorName: ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name) ? error.name : 'Error',
    errorCode: ['unsupported_base_url', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN',
      'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
      'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) ? code : null };
}
report.evidenceBoundary = 'Current Pod/config and health only; no historical recovery, provider readiness or billing conclusion. No request/response body or credential output.';
console.log(JSON.stringify(report, null, 2));
NODE
