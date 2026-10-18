// Read-only capacity evidence. Run inside an existing configured Hub container.
// Does not initialize indexes, enqueue jobs, invoke Embedding or expose source text.
import { pathToFileURL } from 'node:url'
import { createPool } from '@qpjoy/mx-common'
import { loadConfig } from '../config.mjs'
import { createSearch } from '../search/index.mjs'
import { chunkRecord } from '../embedding/chunker.mjs'

// Fixed metadata/statistics GETs only. Keep this block in sync with the standalone
// shell probe so an operator can collect the same evidence before a new image.
// ES v9 APIs: /operation-indices-stats, /operation-nodes-stats and
// /operation-indices-get-settings under https://www.elastic.co/docs/api/doc/elasticsearch/v9
export const ES_CAPACITY_ENDPOINTS = Object.freeze({
  version: '/?filter_path=version.number',
  allocation: '/_cat/allocation?format=json&bytes=b&h=node,shards,disk.indices,disk.used,disk.avail,disk.total,disk.percent',
  indices: '/_cat/indices/mx-insight-hub*?format=json&bytes=b&h=index,health,docs.count,pri,rep,store.size,pri.store.size',
  watermarks: '/_cluster/settings?include_defaults=true&filter_path=persistent.cluster.routing.allocation.disk,transient.cluster.routing.allocation.disk,defaults.cluster.routing.allocation.disk',
  vectorMappings: '/mx-insight-hub*chunk*/_mapping?filter_path=*.mappings.properties.embedding,*.mappings._source',
  aliases: '/_cat/aliases/mx-insight-hub*?format=json&h=alias,index,is_write_index',
  indexSettings: '/mx-insight-hub*/_settings/index.refresh_interval,index.number_of_shards,index.number_of_replicas?include_defaults=true&filter_path=*.settings.index.refresh_interval,*.settings.index.number_of_shards,*.settings.index.number_of_replicas,*.defaults.index.refresh_interval,*.defaults.index.number_of_shards,*.defaults.index.number_of_replicas',
  indexStats: '/mx-insight-hub*/_stats/indexing,search,merge,refresh?level=indices&filter_path=_shards.total,_shards.successful,_shards.failed,indices.*.uuid,indices.*.primaries.indexing,indices.*.primaries.search,indices.*.primaries.merges,indices.*.primaries.refresh,indices.*.total.indexing,indices.*.total.search,indices.*.total.merges,indices.*.total.refresh',
  nodeStats: '/_nodes/stats/jvm,fs,thread_pool,indexing_pressure?timeout=10s&filter_path=_nodes.total,_nodes.successful,_nodes.failed,nodes.*.timestamp,nodes.*.jvm.uptime_in_millis,nodes.*.jvm.mem.heap_used_in_bytes,nodes.*.jvm.mem.heap_used_percent,nodes.*.jvm.mem.heap_max_in_bytes,nodes.*.jvm.gc.collectors.*.collection_count,nodes.*.jvm.gc.collectors.*.collection_time_in_millis,nodes.*.fs.total.*_in_bytes,nodes.*.fs.io_stats.total,nodes.*.thread_pool.write,nodes.*.thread_pool.write_coordination,nodes.*.indexing_pressure.memory',
})

function flattenDiskSettings(settings, prefix = 'cluster.routing.allocation.disk') {
  return Object.fromEntries(Object.entries(settings || {}).flatMap(([key, value]) => {
    const path = `${prefix}.${key}`
    return value !== null && typeof value === 'object'
      ? Object.entries(flattenDiskSettings(value, path))
      : [[path, value]]
  }))
}

export async function inspectElasticsearchCapacity(client) {
  const report = {
    observedAt: new Date().toISOString(),
    limits: 'Index settings/stats target mx-insight-hub*; settings override defaults. Aliases match alias names mx-insight-hub*, not every cluster reference to these indices; an absent alias is not evidence that an index is safe to delete. Node stats cover all workloads on each node, not just Hub. Totals/time/rejections/GC/IO are cumulative counters: compare spaced samples with node uptime and index UUID, allowing for restarts, relocations and resets; one sample does not establish a bottleneck. Index total includes replicas; primaries does not. Missing fields are unavailable, not zero. GETs are sequential, not an atomic snapshot.',
  }
  for (const [name, path] of Object.entries(ES_CAPACITY_ENDPOINTS)) {
    try {
      const value = await client.request('GET', path, undefined, { timeoutMs: 10000 })
      report[name] = name === 'watermarks'
        // Preserve the original flat report shape without fetching all settings.
        ? Object.fromEntries(['persistent', 'transient', 'defaults'].map((scope) => [scope,
          flattenDiskSettings(value[scope]?.cluster?.routing?.allocation?.disk)]))
        : value
    } catch (error) {
      // Errors can include request URLs, credentials or node addresses.
      report[name] = { unavailable: true, status: Number.isInteger(error?.status) ? error.status : null }
    }
  }
  report.completedAt = new Date().toISOString()
  return report
}

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
      report.elasticsearch = await inspectElasticsearchCapacity(search.client)
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectCapacity({ probeHanlp: process.argv.includes('--probe-hanlp') })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error.code || 'capacity_inspection_failed'); process.exitCode = 1 })
}
