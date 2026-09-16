import { crawlerSourceSpec, crawlerLeafPartitionIssues } from './source-contract.mjs'

// Catalog reads avoid scanning the large parent corpus. DEFAULT values use a
// daily, time-bounded DISTINCT query; timeout/truncation is explicitly reported.
export function crawlerDiscoveryCandidates(relations, defaultValues = []) {
  const candidates = []
  for (const relation of relations) {
    const match = /^FOR VALUES IN \('((?:[^']|'')*)'\)$/.exec(relation.partitionBound || '')
    const sourceType = match ? match[1].replaceAll("''", "'") : null
    if (!match && String(relation.partitionBound).startsWith('FOR VALUES IN (')) {
      const values = [...relation.partitionBound.matchAll(/'((?:[^']|'')*)'/g)].map(value => value[1].replaceAll("''", "'"))
      for (const value of values) candidates.push({ sourceType: value,
        table: `${relation.schema}.${relation.table}`, spec: crawlerSourceSpec(value),
        issues: ['多个类别共用分区；需拆成单值 source_type 叶分区后才能自动登记清洗任务'] })
      if (values.length) continue
    }
    const spec = crawlerSourceSpec(sourceType)
    const issues = spec ? crawlerLeafPartitionIssues(relation, spec) : ['需要独立的单值 source_type LIST 叶分区及规范类别标识']
    if (spec && (relation.schema !== spec.locator.schema || relation.table !== spec.locator.table)) {
      issues.push(`类别 ${sourceType} 应绑定 ${spec.locator.schema}.${spec.locator.table}`)
    }
    candidates.push({ sourceType, table: `${relation.schema}.${relation.table}`, spec, issues })
  }
  for (const value of defaultValues) {
    if (candidates.some(candidate => candidate.sourceType === value)) continue
    candidates.push({ sourceType: value, spec: crawlerSourceSpec(value),
      issues: ['类别位于 DEFAULT 分区；需先建立独立叶分区、游标索引并验证 writer 合同'] })
  }
  return candidates
}

// Run beside, not inside, the ingestion scheduler. Discovery failure cannot
// delay existing source scans, API readiness or identity services.
export async function runCrawlerDiscovery({ pipeline, store, signal, logger = console, intervalMs = 86400000 }) {
  while (!signal?.aborted) {
    try {
      const previous = await store.getCrawlerDiscoveryState()
      if (!previous?.checkedAt || Date.now() - new Date(previous.checkedAt).getTime() >= intervalMs) await pipeline.discover()
    } catch (error) {
      const code = /^[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'crawler_discovery_failed'
      logger.warn?.(`[crawler-discovery] ${code}`)
      try {
        const previous = await store.getCrawlerDiscoveryState()
        await store.saveCrawlerDiscoveryState({ ...previous, failedAt: new Date().toISOString(), error: code })
      } catch { /* Preserve ingestion availability even before the metadata migration. */ }
    }
    if (signal?.aborted) break
    await new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve() }
      const timer = setTimeout(done, Math.min(intervalMs, 60000))
      signal?.addEventListener('abort', done, { once: true })
    })
  }
}
