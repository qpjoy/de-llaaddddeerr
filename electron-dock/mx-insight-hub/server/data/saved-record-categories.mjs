import { createHash } from 'node:crypto'
import { crawlerSourceSpec, listCrawlerSpecs, crawlerSourceContractIssues } from '../ingest/crawler/source-contract.mjs'

export async function savedRecordCategoryCatalog(store, grantedPlatforms = []) {
  const [specs, sources, discovery] = await Promise.all([
    listCrawlerSpecs(store), store.listExternalSources?.() || [], store.getCrawlerDiscoveryState?.() || null,
  ])
  const byType = new Map(specs.map(spec => [spec.sourceType, spec]))
  for (const item of discovery?.items || []) {
    const spec = crawlerSourceSpec(item.sourceType)
    if (spec) byType.set(spec.sourceType, spec)
    else if (typeof item.sourceType === 'string' && item.sourceType) byType.set(item.sourceType, {
      sourceType: item.sourceType, displayName: item.sourceType,
      datasetId: null, platform: null, objectType: 'saved_record',
    })
  }
  const sourceByKey = new Map(sources.map(source => [source.sourceKey, source]))
  const grants = new Set(grantedPlatforms)
  const items = [...byType.values()].sort((a, b) => a.sourceType.localeCompare(b.sourceType)).map(spec => {
    const source = sourceByKey.get(spec.sourceKey)
    const registered = Boolean(source && crawlerSourceContractIssues(source, spec).length === 0)
    return {
      id: spec.sourceType, sourceType: spec.sourceType,
      label: spec.displayName.replace(/^Night-All(?:-A)? /, ''),
      datasetId: spec.datasetId, platform: spec.platform, objectType: spec.objectType,
      registered, authorized: registered && grants.has(spec.platform),
    }
  })
  return {
    contractVersion: 'mx-insight-hub.saved-record-categories.v1',
    revision: createHash('sha256').update(JSON.stringify(items)).digest('hex'),
    discoveryCheckedAt: discovery?.checkedAt ?? null,
    scope: 'known_categories',
    product: 'saved_records',
    // Metadata discovery is not a source-wide completeness or freshness promise.
    items,
  }
}
