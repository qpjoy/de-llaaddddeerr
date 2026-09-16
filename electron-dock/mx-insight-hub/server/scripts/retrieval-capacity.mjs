// Read-only capacity evidence. Run inside an existing configured Hub container.
// Does not initialize indexes, enqueue jobs, invoke Embedding or expose source text.
import { pathToFileURL } from 'node:url'
import { createPool } from '@qpjoy/mx-common'
import { loadConfig } from '../config.mjs'
import { createSearch } from '../search/index.mjs'
import { chunkRecord } from '../embedding/chunker.mjs'

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  inspectCapacity({ probeHanlp: process.argv.includes('--probe-hanlp') })
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => { console.error(error.code || 'capacity_inspection_failed'); process.exitCode = 1 })
}
