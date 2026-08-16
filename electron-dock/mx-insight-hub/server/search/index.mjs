import { createElasticsearchClient, ElasticsearchError } from '@qpjoy/mx-common/elasticsearch'
import { createSegmenter } from '@qpjoy/mx-common/segmenter'
import { buildChunkDocument } from '../embedding/document.mjs'
import { contentIndex, chunkIndex } from './index-definitions.mjs'
import { buildContentDocument } from './document.mjs'
import { SearchQueries } from './queries.mjs'
import { SearchProjector } from './projector.mjs'

export { SearchProjector, runProjectorLoop } from './projector.mjs'
export { SearchQueries } from './queries.mjs'
export { contentIndex, chunkIndex } from './index-definitions.mjs'
export { resolveCurrentStateBackings, purgeStaleCurrentStateCopies } from './current-state.mjs'

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
    pool,
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
 * Reconcile the mutable current-state content and chunk indices.
 *
 * Called from the projector worker on startup rather than from the API: the API
 * must start and serve even with an unreachable cluster, and putting a cluster
 * round trip on its startup path would turn a search outage into an API outage.
 * Returns a report instead of throwing by default, for the same reason. The
 * dedicated projector can opt into fail-fast startup so its supervisor retries
 * the whole reconciliation instead of entering a loop that only drains outbox
 * events.
 */
export async function ensureSearchIndices(search, {
  logger = console,
  failOnError = false,
  onProgress = null,
} = {}) {
  if (!search.client) return { enabled: false, reason: 'MX_COMMON_ELASTICSEARCH_URL is not configured' }
  const report = { enabled: true, content: null, chunk: null, error: null }
  try {
    await search.client.clusterHealth({ waitForStatus: 'yellow', timeout: '30s' })
    report.content = await ensureCurrentContentIndex({
      client: search.client,
      pool: search.pool,
      segmenter: search.segmenter,
      indexSet: search.indexSet,
      logger,
      onProgress,
    })
    if (failOnError && report.content?.mappingConflict) {
      throw new Error(`Content index mapping conflict: ${report.content.mappingConflict}`)
    }
    if (search.chunkIndexSet) {
      report.chunk = await ensureCurrentChunkIndex({
        client: search.client,
        pool: search.pool,
        segmenter: search.segmenter,
        indexSet: search.chunkIndexSet,
        logger,
        onProgress,
      })
      if (failOnError && report.chunk?.mappingConflict) {
        throw new Error(`Chunk index mapping conflict: ${report.chunk.mappingConflict}`)
      }
    }
    logger?.log?.(`[search] indices ready: ${search.indexSet.writeAlias}`)
  } catch (error) {
    report.error = error.message
    logger?.error?.(`[search] index reconcile failed: ${error.message}`)
    if (failOnError) throw error
  }
  return report
}

const CURRENT_REBUILD_BATCH = 200
const CURRENT_REBUILD_LOCK_PREFIX = 'mx-insight-hub:search:current-rebuild:'

/**
 * Reconcile a mutable content projection into one non-rollover concrete index.
 *
 * The old index manager is intentionally not used here: its read alias spans
 * schema versions and ILM generations, which is correct for append-only time
 * series but lets stale copies of mutable records survive edits and deletes.
 */
export async function ensureCurrentContentIndex({
  client,
  pool,
  segmenter,
  indexSet,
  logger = console,
  onProgress = null,
}) {
  return ensureCurrentStateIndex({
    client,
    pool,
    segmenter,
    indexSet,
    logger,
    onProgress,
    projection: 'content',
    reconcileSnapshot: reconcileContentSnapshot,
  })
}

/** Rebuild the retrieval projection from vectors already stored in PostgreSQL. */
export async function ensureCurrentChunkIndex({
  client,
  pool,
  segmenter,
  indexSet,
  logger = console,
  onProgress = null,
}) {
  return ensureCurrentStateIndex({
    client,
    pool,
    segmenter,
    indexSet,
    logger,
    onProgress,
    projection: 'chunks',
    reconcileSnapshot: reconcileChunkSnapshot,
  })
}

async function ensureCurrentStateIndex({
  client,
  pool,
  segmenter,
  indexSet,
  logger,
  onProgress,
  projection,
  reconcileSnapshot,
}) {
  if (!pool?.connect) throw new Error('A PostgreSQL pool is required to rebuild a current-state projection')
  if (!indexSet?.currentIndex) throw new Error('A current-state index definition is required')
  const connection = await pool.connect()
  let locked = false
  const lockName = `${CURRENT_REBUILD_LOCK_PREFIX}${indexSet.readAlias}`
  try {
    await connection.query(
      'SELECT pg_advisory_lock(hashtextextended($1, 0))',
      [lockName],
    )
    locked = true

    // Replace the old rollover template before creating `*-current`. Otherwise
    // Elasticsearch would inherit its ILM settings and, worse, attach the read
    // alias while the PostgreSQL snapshot is only partially loaded.
    await putCurrentIndexTemplate(client, indexSet)

    const before = await currentAliasState(client, indexSet)
    const active = before.readIndices.length === 1
      && before.readIndices[0] === indexSet.currentIndex
      && before.aliasesToMove.every((alias) => {
        const indices = before.aliasIndices.get(alias)
        return indices?.length === 1 && indices[0] === indexSet.currentIndex
      })

    if (active) {
      const mappingConflict = await updateCurrentMapping(client, indexSet, logger)
      if (mappingConflict) {
        return currentEnsureReport(indexSet, { mappingConflict, rebuilt: false, created: false })
      }
      // The previous process may have died after the atomic alias switch but
      // before its second reconciliation pass.  Replaying PostgreSQL truth on
      // every active startup closes that crash window; external_gte makes the
      // pass safe alongside live projectors.
      const indexed = await reconcileSnapshot({
        connection,
        client,
        segmenter,
        index: indexSet.currentIndex,
        onProgress: progressReporter(onProgress, projection, 'reconcile'),
      })
      return currentEnsureReport(indexSet, {
        mappingConflict: null,
        rebuilt: false,
        created: false,
        indexed,
      })
    }

    let exists = await client.indexExists(indexSet.currentIndex)
    let created = false
    const currentWasServing = before.readIndices.includes(indexSet.currentIndex)
    if (exists && !currentWasServing) {
      // A prior rebuild may have died before the atomic alias switch. It is not
      // serving traffic, so recreate it rather than carrying a partial snapshot.
      await client.request('DELETE', `/${encodeURIComponent(indexSet.currentIndex)}`)
      exists = false
    }
    if (!exists) {
      await client.createIndex(indexSet.currentIndex, {
        settings: indexSet.settings,
        mappings: indexSet.mappings,
      })
      created = true
    } else {
      const mappingConflict = await updateCurrentMapping(client, indexSet, logger)
      if (mappingConflict) {
        return currentEnsureReport(indexSet, { mappingConflict, rebuilt: false, created: false })
      }
    }

    const firstPass = await reconcileSnapshot({
      connection,
      client,
      segmenter,
      index: indexSet.currentIndex,
      onProgress: progressReporter(onProgress, projection, 'build'),
    })
    const aliasState = await currentAliasState(client, indexSet)
    await switchCurrentAliases(client, indexSet, aliasState)

    // Writes can commit while the first pass is scanning. Once every legacy
    // write alias points at the new concrete index, replay PostgreSQL current
    // truth once more; external_gte prevents a late older snapshot row from
    // overwriting a newer projector write.
    const secondPass = await reconcileSnapshot({
      connection,
      client,
      segmenter,
      index: indexSet.currentIndex,
      onProgress: progressReporter(onProgress, projection, 'catch-up'),
    })
    logger?.info?.(
      `[search] rebuilt ${indexSet.currentIndex}: first=${firstPass} second=${secondPass}`,
    )
    return currentEnsureReport(indexSet, {
      mappingConflict: null,
      rebuilt: true,
      created,
      indexed: secondPass,
    })
  } finally {
    if (locked) {
      await connection.query(
        'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [lockName],
      ).catch(() => {})
    }
    connection.release()
  }
}

function progressReporter(onProgress, projection, pass) {
  if (typeof onProgress !== 'function') return null
  return (processed) => onProgress({ projection, pass, processed })
}

function currentEnsureReport(indexSet, {
  mappingConflict,
  rebuilt,
  created,
  indexed = 0,
}) {
  return {
    readAlias: indexSet.readAlias,
    writeAlias: indexSet.writeAlias,
    currentIndex: indexSet.currentIndex,
    createdBootstrapIndex: created,
    mappingConflict,
    rebuilt,
    indexed,
  }
}

async function putCurrentIndexTemplate(client, indexSet) {
  await client.putIndexTemplate(indexSet.templateName, {
    index_patterns: [indexSet.indexPattern],
    priority: 500,
    _meta: {
      owner: indexSet.productId,
      projection: indexSet.name,
      schemaVersion: indexSet.schemaVersion,
      currentState: true,
    },
    template: {
      settings: indexSet.settings,
      mappings: indexSet.mappings,
    },
  })
}

async function updateCurrentMapping(client, indexSet, logger) {
  try {
    await client.putMapping(indexSet.currentIndex, { properties: indexSet.mappings.properties })
    return null
  } catch (error) {
    if (!(error instanceof ElasticsearchError) || error.status !== 400) throw error
    const conflict = error.body?.error?.reason || 'incompatible mapping change'
    logger?.warn?.(`[search] ${indexSet.currentIndex} mapping change needs a schema-version rebuild: ${conflict}`)
    return conflict
  }
}

async function getAliasOrEmpty(client, alias) {
  try {
    return await client.getAlias(alias)
  } catch (error) {
    if (error?.status === 404) return {}
    throw error
  }
}

async function currentAliasState(client, indexSet) {
  const [readMemberships, writeMemberships] = await Promise.all([
    getAliasOrEmpty(client, indexSet.readAlias),
    getAliasOrEmpty(client, `${indexSet.readAlias}-v*`),
  ])
  const combined = new Map()
  for (const response of [readMemberships, writeMemberships]) {
    for (const [index, definition] of Object.entries(response || {})) {
      const aliases = combined.get(index) || new Set()
      for (const alias of Object.keys(definition?.aliases || {})) aliases.add(alias)
      combined.set(index, aliases)
    }
  }

  const writePattern = new RegExp(`^${escapeRegExp(indexSet.readAlias)}-v\\d+$`)
  const aliasesToMove = new Set([indexSet.writeAlias])
  const aliasIndices = new Map()
  for (const [index, aliases] of combined) {
    for (const alias of aliases) {
      if (alias === indexSet.readAlias || writePattern.test(alias)) {
        const indices = aliasIndices.get(alias) || []
        indices.push(index)
        aliasIndices.set(alias, indices)
      }
      if (writePattern.test(alias)) aliasesToMove.add(alias)
    }
  }
  return {
    memberships: combined,
    aliasIndices,
    aliasesToMove: [...aliasesToMove].sort(),
    readIndices: [...(aliasIndices.get(indexSet.readAlias) || [])].sort(),
  }
}

async function switchCurrentAliases(client, indexSet, state) {
  const actions = []
  for (const [index, aliases] of state.memberships) {
    for (const alias of aliases) {
      if (alias !== indexSet.readAlias && !state.aliasesToMove.includes(alias)) continue
      if (index !== indexSet.currentIndex) actions.push({ remove: { index, alias } })
    }
  }
  actions.push({ add: { index: indexSet.currentIndex, alias: indexSet.readAlias } })
  for (const alias of state.aliasesToMove) {
    actions.push({ add: { index: indexSet.currentIndex, alias, is_write_index: true } })
  }
  await client.request('POST', '/_aliases', { actions })
}

async function reconcileContentSnapshot({ connection, client, segmenter, index, onProgress = null }) {
  let cursor = null
  let projected = 0
  while (true) {
    const { rows } = await connection.query(
      `SELECT * FROM core.canonical_records
        WHERE ($1::uuid IS NULL OR id > $1)
        ORDER BY id
        LIMIT $2`,
      [cursor, CURRENT_REBUILD_BATCH],
    )
    if (rows.length === 0) break

    const operations = []
    const operationTypes = []
    for (const row of rows) {
      const version = Number(row.projection_revision)
      if (row.deleted_at != null) {
        operations.push({
          delete: {
            _index: index,
            _id: row.id,
            version,
            version_type: 'external_gte',
          },
        })
        operationTypes.push('delete')
      } else {
        operations.push({
          index: {
            _index: index,
            _id: row.id,
            version,
            version_type: 'external_gte',
          },
        })
        operations.push(await buildContentDocument(row, { segmenter }))
        operationTypes.push('index')
      }
    }
    const response = await client.bulk(operations)
    assertSnapshotBulk(response, operationTypes, 'Content')
    projected += rows.length
    await onProgress?.(projected)
    cursor = rows.at(-1).id
    if (rows.length < CURRENT_REBUILD_BATCH) break
  }
  return projected
}

async function reconcileChunkSnapshot({ connection, client, segmenter, index, onProgress = null }) {
  let cursor = null
  let projected = 0
  while (true) {
    const { rows } = await connection.query(
      `SELECT c.id, c.record_id, c.chunk_index, c.content, c.chunker_version,
              c.source_revision, c.embedding_model, c.embedding_version, c.vector,
              c.created_at, r.dataset_id, r.platform, r.external_id, r.url,
              r.title, r.event_time
         FROM core.record_chunks c
         JOIN core.canonical_records r ON r.id = c.record_id
        WHERE c.embedded_at IS NOT NULL
          AND c.vector IS NOT NULL
          AND r.deleted_at IS NULL
          AND c.source_revision = r.current_revision
          AND ($1::uuid IS NULL OR c.id > $1)
        ORDER BY c.id
        LIMIT $2`,
      [cursor, CURRENT_REBUILD_BATCH],
    )
    if (rows.length === 0) break

    const operations = []
    const operationTypes = []
    for (const row of rows) {
      const tokens = await segmenter.segment(row.content)
      operations.push({
        index: {
          _index: index,
          _id: `${row.record_id}:${row.chunk_index}:${row.chunker_version}`,
          version: Number(row.source_revision),
          // Re-segmentation changes contentHanlp without changing the source
          // revision. Equal-version snapshots must therefore replace the old
          // token projection instead of being rejected as a version conflict.
          version_type: 'external_gte',
        },
      })
      operations.push(buildChunkDocument(row, {
        tokens,
        createdAt: row.created_at,
      }))
      operationTypes.push('index')
    }
    const response = await client.bulk(operations)
    assertSnapshotBulk(response, operationTypes, 'Chunk')
    projected += rows.length
    await onProgress?.(projected)
    cursor = rows.at(-1).id
    if (rows.length < CURRENT_REBUILD_BATCH) break
  }

  // The current index starts empty on migration, but a legacy worker can still
  // finish an in-flight write through an alias immediately after cutover. Keep
  // every durable tombstone (including previously acknowledged ones) as part of
  // the rebuild truth so removed/trailing chunks cannot survive that window.
  let deletionCursor = null
  while (true) {
    const { rows } = await connection.query(
      `SELECT document_id, source_revision
         FROM core.chunk_projection_deletes
        WHERE ($1::text IS NULL OR document_id > $1)
        ORDER BY document_id
        LIMIT $2`,
      [deletionCursor, CURRENT_REBUILD_BATCH],
    )
    if (rows.length === 0) break

    const operations = rows.map((row) => ({
      delete: {
        _index: index,
        _id: row.document_id,
        version: Number(row.source_revision),
        version_type: 'external_gte',
      },
    }))
    const response = await client.bulk(operations)
    assertSnapshotBulk(response, rows.map(() => 'delete'), 'Chunk deletion')
    projected += rows.length
    await onProgress?.(projected)
    deletionCursor = rows.at(-1).document_id
    if (rows.length < CURRENT_REBUILD_BATCH) break
  }
  return projected
}

function assertSnapshotBulk(response, operationTypes, projectionName) {
  const items = response?.items || []
  for (const [index, operationType] of operationTypes.entries()) {
    const action = items[index]?.index || items[index]?.delete
    const status = Number(action?.status ?? 0)
    const accepted = action && (
      !action.error
      || status === 409
      || (operationType === 'delete' && status === 404)
    )
    if (accepted) continue
    const reason = action?.error ? JSON.stringify(action.error) : `missing ${operationType} result`
    throw new Error(`${projectionName} snapshot projection failed: ${reason}`)
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
