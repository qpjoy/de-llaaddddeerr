#!/usr/bin/env bash
# Standalone read-only inspector: no repository checkout or new image required.
# Requires bash, kubectl and python3 on the operator host; Node exists in Hub Admin.
# No Secrets, credentials, source bodies or logs are exported. No mutations/rebuilds.
set -euo pipefail
probe_hanlp=0
output_dir=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --probe-hanlp) probe_hanlp=1; shift ;;
    --output) output_dir="${2:?--output requires a directory}"; shift 2 ;;
    --help) echo 'Usage: bash inspect-retrieval-capacity.sh [--probe-hanlp] [--output DIRECTORY]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
for command_name in kubectl python3 tar; do command -v "$command_name" >/dev/null || { echo "Missing: $command_name" >&2; exit 1; }; done
if [ -z "$output_dir" ]; then output_dir="/tmp/mx-hub-capacity-$(date +%Y%m%d-%H%M%S)"; fi
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"
umask 077
report="$output_dir/report.txt"
exec 3>"$report"
say() { echo "$*"; echo "$*" >&3; }
capture() {
  local label="$1"; shift
  say "Collecting: $label"
  if "$@" >"$output_dir/$label.txt" 2>&1; then :; else say "  unavailable: $label (see its file; remaining checks continue)"; fi
}
say 'MX Insight Hub capacity evidence — READ ONLY'
say "UTC time: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say 'No Embedding calls, reindex, initialization, deletion, deployment or setting changes.'
capture context kubectl config current-context
capture host-disks df -hT / /home /data
capture nodes kubectl --request-timeout=10s get nodes -o wide
capture resources kubectl --request-timeout=10s top pods -n mx-common
capture hub-resources kubectl --request-timeout=10s top pods -n mx-insight-hub
for ns in mx-common mx-insight-hub; do
  # Only allowlisted projection is written; the raw Pod spec is never saved.
  say "Collecting: $ns pod mounts, resources and safe runtime settings"
  if kubectl --request-timeout=10s -n "$ns" get pods -o json | python3 -c '
import sys,json
x=json.load(sys.stdin); output=[]
allow={"MAX_CONCURRENT_INFERENCES","INFERENCE_QUEUE_TIMEOUT_SECONDS","MAX_BATCH_TEXTS","MAX_BODY_BYTES","OMP_NUM_THREADS","MKL_NUM_THREADS","TORCH_NUM_THREADS","HANLP_MODEL","MX_INSIGHT_EMBEDDING_MODEL","MX_INSIGHT_EMBEDDING_DIMENSIONS","MX_COMMON_SEGMENTER_CONCURRENCY","MX_COMMON_SEGMENTER_BATCH_SIZE"}
for p in x.get("items",[]):
 if not p["metadata"]["name"].startswith(("mx-common-elasticsearch","mx-common-postgres","mx-common-hanlp","mx-insight-hub-admin","mx-insight-hub-retrieval","mx-insight-hub-projector")): continue
 s=p["spec"]
 output.append({"name":p["metadata"]["name"],"node":s.get("nodeName"),"phase":p.get("status",{}).get("phase"),"containers":[{"name":c["name"],"image":c.get("image"),"resources":c.get("resources"),"mounts":c.get("volumeMounts",[]),"safeEnv":{v["name"]:v.get("value","[valueFrom]") for v in c.get("env",[]) if v["name"] in allow}} for c in s.get("containers",[])],"volumes":[v for v in s.get("volumes",[]) if "persistentVolumeClaim" in v or "hostPath" in v],"containerStatus":[{"name":c["name"],"ready":c.get("ready"),"restartCount":c.get("restartCount")} for c in p.get("status",{}).get("containerStatuses",[])]})
print(json.dumps(output,ensure_ascii=False,indent=2))
' >"$output_dir/$ns-pods.json" 2>"$output_dir/$ns-pods-error.txt"; then :; else say "  could not inspect $ns pods"; fi
  capture "$ns-pvc" kubectl --request-timeout=10s -n "$ns" get pvc -o wide
done
say 'Collecting: PV to node/host path mapping'
if kubectl --request-timeout=10s get pv -o json | python3 -c '
import sys,json
out=[]
for p in json.load(sys.stdin).get("items",[]):
 s=p["spec"]; ref=s.get("claimRef",{})
 if ref.get("namespace") not in ("mx-common","mx-insight-hub"): continue
 out.append({"pv":p["metadata"]["name"],"claim":ref.get("namespace","")+"/"+ref.get("name",""),"capacity":s.get("capacity"),"storageClass":s.get("storageClassName"),"local":s.get("local"),"hostPath":s.get("hostPath"),"csiDriver":s.get("csi",{}).get("driver"),"volumeHandle":s.get("csi",{}).get("volumeHandle"),"nodeAffinity":s.get("nodeAffinity")})
print(json.dumps(out,ensure_ascii=False,indent=2))
' >"$output_dir/pv-paths.json" 2>"$output_dir/pv-paths-error.txt"; then :; else say '  could not inspect PV paths'; fi
# Container df proves the actual mounted filesystem (Docker root does not).
for component in elasticsearch postgres; do
  pod="$(kubectl --request-timeout=10s -n mx-common get pod -l "app.kubernetes.io/name=mx-common-$component" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [ -n "$pod" ]; then capture "$component-mounted-disk" kubectl --request-timeout=20s -n mx-common exec "$pod" -- df -kP; fi
done
admin_pod="$(kubectl --request-timeout=10s -n mx-insight-hub get pod -l app.kubernetes.io/name=mx-insight-hub-admin --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [ -n "$admin_pod" ]; then
  say 'Collecting: Hub PG sample, ES mappings/watermarks/storage and optional HanLP probe'
  probe_args=()
  if [ "$probe_hanlp" = 1 ]; then probe_args+=(--probe-hanlp); fi
  if kubectl --request-timeout=240s -n mx-insight-hub exec -i "$admin_pod" -- node --input-type=module - "${probe_args[@]}" >"$output_dir/capacity.json" 2>"$output_dir/capacity-error.txt" <<'MX_CAPACITY_NODE'
// Read-only capacity evidence. Run inside an existing configured Hub container.
// Does not initialize indexes, enqueue jobs, invoke Embedding or expose source text.
import { createPool } from '@qpjoy/mx-common'
import { loadConfig } from './server/config.mjs'
import { createSearch } from './server/search/index.mjs'
import { chunkRecord } from './server/embedding/chunker.mjs'

export function summarizeSample(rows, approximateRows, dimensions) {
  let eligible = 0, chunks = 0, tokens = 0, clipped = 0
  for (const row of rows) {
    if (row.deleted_at || (row.title?.length || 0) + (row.body?.length || 0) < 24) continue
    eligible++
    if (Number(row.original_length) > (row.title?.length || 0) + (row.body?.length || 0)) clipped++
    const pieces = chunkRecord(row)
    chunks += pieces.length
    tokens += pieces.reduce((sum, item) => sum + item.tokenCount, 0)
  }
  const scale = rows.length && approximateRows > 0 ? approximateRows / rows.length : null
  const estimatedChunks = scale === null ? null : Math.ceil(chunks * scale)
  return {
    sampledRecords: rows.length, eligibleInSample: eligible, clippedRecords: clipped,
    approximateCanonicalRows: approximateRows,
    estimatedEligibleRecords: scale === null ? null : Math.ceil(eligible * scale),
    averageChunksPerEligibleRecord: eligible ? chunks / eligible : null,
    estimatedChunks, estimatedTokensBeforeReuse: scale === null ? null : Math.ceil(tokens * scale),
    dimensions: dimensions || null,
    vectorBytesOnly: dimensions && estimatedChunks !== null ? {
      postgresFloat32: estimatedChunks * dimensions * 4,
      elasticsearchFloat32PlusInt8: estimatedChunks * dimensions * 5,
    } : null,
    limits: 'Page sample and planner row estimate, not a census or fit guarantee. Vector bytes exclude text, HNSW graph, metadata, indexes, replicas, WAL, old ES generations and merge peaks. Clipped records underestimate long text. No reuse discount applied.',
  }
}

export async function inspectCapacity({ probeHanlp = false } = {}) {
  const config = loadConfig()
  if (config.storeDriver !== 'postgres') throw new Error('requires_postgres')
  const pool = createPool({ ...config.common.postgres, maxConnections: 1, statementTimeoutMs: 10000 },
    { applicationName: 'mx-insight-hub-capacity-readonly' })
  pool.on('error', () => {})
  const report = { observedAt: new Date().toISOString(), readOnly: true }
  try {
    const client = await pool.connect()
    try {
      await client.query('BEGIN READ ONLY')
      const tables = await client.query(`SELECT c.relname,c.reltuples::bigint AS approximate_rows,
        pg_table_size(c.oid)::bigint AS table_bytes,pg_indexes_size(c.oid)::bigint AS index_bytes
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE (n.nspname='core' AND c.relname IN ('canonical_records','record_chunks'))
          OR (n.nspname='retrieval' AND c.relname IN ('jobs','run_items'))`)
      const rows = await client.query(`SELECT dataset_id,deleted_at,left(title,20000) AS title,left(body,64000) AS body,
        coalesce(length(title),0)+coalesce(length(body),0) AS original_length
        FROM core.canonical_records TABLESAMPLE SYSTEM (0.5) REPEATABLE (42) LIMIT 2000`)
      report.postgres = tables.rows
      report.sample = summarizeSample(rows.rows,
        Number(tables.rows.find((r) => r.relname === 'canonical_records')?.approximate_rows || 0), config.embedding.dimensions)
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      report.postgresError = error.code || 'postgres_read_failed'
    } finally { client.release() }
    const search = createSearch({ pool, config: config.common, logger: { warn() {}, error() {} } })
    if (search.client) {
      report.elasticsearch = {}
      for (const [name, path] of Object.entries({
        version: '/?filter_path=version.number',
        allocation: '/_cat/allocation?format=json&bytes=b',
        indices: '/_cat/indices/mx-insight-hub*?format=json&bytes=b&h=index,health,docs.count,pri,rep,store.size,pri.store.size',
        watermarks: '/_cluster/settings?include_defaults=true&flat_settings=true',
        vectorMappings: '/mx-insight-hub*chunk*/_mapping?filter_path=*.mappings.properties.embedding,*.mappings._source',
      })) {
        try {
          const value = await search.client.request('GET', path)
          report.elasticsearch[name] = name === 'watermarks'
            ? Object.fromEntries(['persistent','transient','defaults'].map((scope) => [scope,
              Object.fromEntries(Object.entries(value[scope] || {}).filter(([key]) => key.startsWith('cluster.routing.allocation.disk.')))]))
            : value
        }
        catch (error) { report.elasticsearch[name] = { unavailable: true, status: error.status || null } }
      }
    }
    report.hanlpClient = { batchSize: search.segmenterBatchSize, rebuildConcurrency: search.segmenterConcurrency }
    if (probeHanlp) {
      report.hanlpProbe = []
      // Three sequential bounded synthetic requests, no embeddings or source data.
      for (const count of [1, 8, 16]) {
        const texts = Array.from({ length: count }, (_, i) => `第${i}条测试。${'这是分词容量检查使用的合成文本，用来观察批量请求延迟。'.repeat(8)}`)
        const start = performance.now()
        try {
          const result = await search.segmenter.segmentBatchWithMeta(texts, { allowFallback: false })
          report.hanlpProbe.push({ count, durationMs: Math.round(performance.now() - start),
            verifiedHanlp: result.length === count && result.every((v) => v.backendUsed === 'hanlp' && !v.degraded) })
        } catch { report.hanlpProbe.push({ count, failed: true }); break }
      }
    }
    return report
  } finally { await pool.end() }
}


try { console.log(JSON.stringify(await inspectCapacity({probeHanlp:process.argv.includes('--probe-hanlp')}),null,2)) } catch(e) { console.log(JSON.stringify({error:e.code||'capacity_inspection_failed'}));process.exitCode=1 }
MX_CAPACITY_NODE
  then :; else say '  Hub capacity probe incomplete; inspect capacity-error.txt'; fi
else
  say 'No running Hub Admin Pod found; topology evidence is still available.'
fi
say 'Interpretation: host-disks is the machine running this script; PV nodeAffinity + container df locate actual ES/PG disks.'
say 'Sampling is approximate and may underestimate unusually long text. This report does not authorize a rebuild or guarantee free space.'
say 'HanLP probe, when requested, uses 1/8/16 synthetic strings in three sequential requests; it is not a load test.'
archive="${output_dir}.tar.gz"
tar -czf "$archive" -C "$(dirname "$output_dir")" "$(basename "$output_dir")"
echo "Report directory: $output_dir"
echo "Send this archive for analysis: $archive"
