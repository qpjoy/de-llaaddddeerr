import { createElasticsearchClient, ensureIndexSet } from '@qpjoy/mx-common/elasticsearch'
import { createSegmenter } from '@qpjoy/mx-common/segmenter'
import { contentIndex, chunkIndex } from './index-definitions.mjs'
import { SearchQueries } from './queries.mjs'
import { SearchProjector } from './projector.mjs'

export { SearchProjector, runProjectorLoop } from './projector.mjs'
export { SearchQueries } from './queries.mjs'
export { contentIndex, chunkIndex } from './index-definitions.mjs'

/**
 * Build the search subsystem.
 *
 * Returns a usable object even when Elasticsearch is not configured: `client` is
 * null, `queries` transparently uses the PostgreSQL path, and `projector` is
 * null. Nothing above this layer needs to branch on whether search exists, which
 * is what keeps "ES is optional" true in practice rather than only on paper.
 */
export function createSearch({ pool, config, logger = console }) {
  const client = createElasticsearchClient(config.elasticsearch)
  const segmenter = createSegmenter(config.segmenter, { logger })
  const indexSet = contentIndex({ numberOfReplicas: config.elasticsearch.numberOfReplicas })
  const chunks = chunkIndex({
    dimensions: config.embedding?.dimensions,
    numberOfReplicas: config.elasticsearch.numberOfReplicas,
  })

  return {
    client,
    segmenter,
    indexSet,
    chunkIndexSet: chunks,
    queries: new SearchQueries({ pool, client, segmenter, indexSet, chunkIndexSet: chunks, logger }),
    projector: client
      ? new SearchProjector({ pool, client, segmenter, indexSet, logger })
      : null,
  }
}

/**
 * Reconcile index templates, ILM policies and bootstrap indices.
 *
 * Called from the projector worker on startup rather than from the API: the API
 * must start and serve even with an unreachable cluster, and putting a cluster
 * round trip on its startup path would turn a search outage into an API outage.
 * Returns a report instead of throwing, for the same reason.
 */
export async function ensureSearchIndices(search, { logger = console } = {}) {
  if (!search.client) return { enabled: false, reason: 'MX_COMMON_ELASTICSEARCH_URL is not configured' }
  const report = { enabled: true, content: null, chunk: null, error: null }
  try {
    await search.client.clusterHealth({ waitForStatus: 'yellow', timeout: '30s' })
    report.content = await ensureIndexSet(search.client, search.indexSet, { logger })
    if (search.chunkIndexSet) {
      report.chunk = await ensureIndexSet(search.client, search.chunkIndexSet, { logger })
    }
    logger?.log?.(`[search] indices ready: ${search.indexSet.writeAlias}`)
  } catch (error) {
    report.error = error.message
    logger?.error?.(`[search] index reconcile failed: ${error.message}`)
  }
  return report
}
