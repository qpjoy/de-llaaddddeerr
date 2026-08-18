import {
  createElasticsearchClient,
  describeClusterHealth,
  ElasticsearchError,
} from '@qpjoy/mx-common/elasticsearch'
import { batchingSegmenter, createSegmenter } from '@qpjoy/mx-common/segmenter'
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
    // Only the bulk rebuild uses this; live projector traffic stays one call at
    // a time so an interactive search never queues behind a rebuild's fan-out.
    segmenterConcurrency: config.segmenter?.concurrency || 1,
    segmenterBatchSize: config.segmenter?.batchSize || 64,
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
  const report = { enabled: true, content: null, chunk: null, error: null, clusterHealth: null }
  try {
    // Waiting for yellow lets shards settle before index creation races them.
    // Not reaching it is reported and then ignored: this reconciliation builds
    // a new index from PostgreSQL rather than reading the existing projection,
    // so a cluster held below yellow by the generation being replaced must not
    // veto its own replacement.
    const health = await search.client.clusterHealth({ waitForStatus: 'yellow', timeout: '30s' })
    report.clusterHealth = health?.status || null
    if (health?.status !== 'green' && health?.status !== 'yellow') {
      logger?.warn?.(`[search] rebuilding against a degraded cluster: ${describeClusterHealth(health)}`)
    }
    // One cache for the whole reconciliation, shared by both projections and
    // both passes. The catch-up pass and any resumed run therefore re-segment
    // almost nothing.
    // Order matters. The memo answers repeats without any request at all; what
    // does reach the tokenizer is then coalesced, so the concurrent calls the
    // batch builder makes leave as one forward pass instead of many.
    const segmenter = cachingSegmenter(batchingSegmenter(search.segmenter, {
      maxBatch: search.segmenterBatchSize,
    }))
    const concurrency = search.segmenterConcurrency || 1
    report.content = await ensureCurrentContentIndex({
      client: search.client,
      pool: search.pool,
      segmenter,
      indexSet: search.indexSet,
      concurrency,
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
        segmenter,
        indexSet: search.chunkIndexSet,
        concurrency,
        logger,
        onProgress,
      })
      if (failOnError && report.chunk?.mappingConflict) {
        throw new Error(`Chunk index mapping conflict: ${report.chunk.mappingConflict}`)
      }
    }
    report.segmentCacheSize = segmenter.stats().size
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
// Bounded so a rebuild cannot trade an Elasticsearch problem for an out-of-memory
// one. Sized for the fields whose values actually repeat -- author names,
// usernames and chat titles are drawn from a far smaller set than the messages
// that carry them, so this absorbs most of the tokenizer traffic without
// needing to hold every distinct message body.
const SEGMENT_CACHE_MAX_ENTRIES = 200_000
const SEGMENT_CACHE_MAX_TEXT_LENGTH = 2_048

/**
 * Memoise segmentation for the length of one rebuild.
 *
 * Every call is a round trip to a single-slot HanLP service, and it is the
 * dominant cost of a rebuild by orders of magnitude. Identical input yields
 * identical tokens, so repeating the call is pure waste -- and repetition is
 * the norm here, not the exception: five fields are segmented per record and
 * three of them (author name, username, chat username) repeat across every
 * message from the same sender or chat.
 *
 * Deliberately per-rebuild and in-process. A persistent cache would also make
 * retries cheap, but it would put a second copy of the corpus on the same disk
 * whose exhaustion already stops rebuilds.
 */
export function cachingSegmenter(segmenter) {
  const cache = new Map()
  const remember = (key, value) => {
    if (key === null) return value
    // Insertion-ordered eviction: the oldest key is the first one Map yields.
    if (cache.size >= SEGMENT_CACHE_MAX_ENTRIES) {
      cache.delete(cache.keys().next().value)
    }
    cache.set(key, value)
    return value
  }
  const keyOf = (text) => {
    const value = String(text ?? '')
    return value.length <= SEGMENT_CACHE_MAX_TEXT_LENGTH ? value : null
  }

  return {
    stats: () => ({ size: cache.size }),
    async segmentWithMeta(text) {
      const key = keyOf(text)
      if (key !== null && cache.has(key)) return cache.get(key)
      return remember(key, await segmenter.segmentWithMeta(text))
    },
    async segment(text) {
      const key = keyOf(text)
      if (key !== null && cache.has(key)) return cache.get(key).tokens
      return remember(key, await segmenter.segmentWithMeta(text)).tokens
    },
  }
}

/**
 * Map with a fixed number of workers, preserving input order.
 *
 * Used to overlap segmentation across the records of one bulk batch. Order is
 * preserved because the bulk body pairs each action line with the document line
 * that follows it; shuffling would attach documents to the wrong ids.
 *
 * Workers pull from a shared index rather than the batch being split up front,
 * so one slow document cannot leave the other workers idle.
 */
export async function mapWithConcurrency(items, limit, mapper) {
  const width = Math.max(1, Math.min(Number(limit) || 1, items.length))
  if (width === 1) {
    const serial = []
    for (const [index, item] of items.entries()) serial.push(await mapper(item, index))
    return serial
  }
  const results = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
  return results
}

async function readRebuildProgress(connection, indexName) {
  const { rows } = await connection.query(
    `SELECT last_record_id, processed, build_started_at
       FROM control.search_rebuild_progress
      WHERE index_name = $1 AND completed_at IS NULL`,
    [indexName],
  )
  return rows[0] || null
}

async function beginRebuildProgress(connection, indexName, projection) {
  const { rows } = await connection.query(
    `INSERT INTO control.search_rebuild_progress (index_name, projection)
     VALUES ($1, $2)
     ON CONFLICT (index_name) DO UPDATE
       SET projection = EXCLUDED.projection,
           last_record_id = NULL,
           processed = 0,
           build_started_at = now(),
           completed_at = NULL,
           updated_at = now()
     RETURNING build_started_at`,
    [indexName, projection],
  )
  return rows[0].build_started_at
}

// Written after the batch is durably in Elasticsearch, never before. Saving
// first would skip a batch on crash -- the failure mode that actually loses
// documents, as opposed to replaying one, which `external_gte` absorbs.
async function saveRebuildProgress(connection, indexName, lastRecordId, processed) {
  await connection.query(
    `UPDATE control.search_rebuild_progress
        SET last_record_id = $2, processed = $3, updated_at = now()
      WHERE index_name = $1`,
    [indexName, lastRecordId, processed],
  )
}

async function completeRebuildProgress(connection, indexName) {
  await connection.query(
    `UPDATE control.search_rebuild_progress
        SET completed_at = now(), updated_at = now()
      WHERE index_name = $1`,
    [indexName],
  )
}

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
  concurrency = 1,
  logger = console,
  onProgress = null,
}) {
  return ensureCurrentStateIndex({
    client,
    pool,
    segmenter,
    indexSet,
    concurrency,
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
  concurrency = 1,
  logger = console,
  onProgress = null,
}) {
  return ensureCurrentStateIndex({
    client,
    pool,
    segmenter,
    indexSet,
    concurrency,
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
  concurrency = 1,
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
        concurrency,
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
    // A partial index left by an interrupted rebuild is invisible -- no alias
    // points at it -- so it is safe to continue filling rather than to discard.
    // Continuing is not an optimisation at this corpus size: a full pass is
    // hours of single-slot tokenizer work, and restarting from the first row on
    // every transient failure is how a rebuild becomes one that never finishes.
    // The cursor is trusted only when it belongs to this exact index name, so a
    // schema bump can never resume onto an incompatible mapping.
    let resume = null
    if (exists && !currentWasServing) {
      resume = await readRebuildProgress(connection, indexSet.currentIndex)
      if (!resume) {
        // No cursor means unknown provenance: the snapshot could be partial in
        // ways nothing recorded, so it is rebuilt from scratch as before.
        await client.request('DELETE', `/${encodeURIComponent(indexSet.currentIndex)}`)
        exists = false
      } else {
        logger?.log?.(
          `[search] resuming ${indexSet.currentIndex} after ${resume.processed} records`,
        )
      }
    }
    if (!exists) {
      await client.createIndex(indexSet.currentIndex, {
        settings: indexSet.settings,
        mappings: indexSet.mappings,
      })
      created = true
    } else if (!resume) {
      const mappingConflict = await updateCurrentMapping(client, indexSet, logger)
      if (mappingConflict) {
        return currentEnsureReport(indexSet, { mappingConflict, rebuilt: false, created: false })
      }
    }

    const buildStartedAt = resume
      ? resume.build_started_at
      : await beginRebuildProgress(connection, indexSet.currentIndex, projection)
    const alreadyProcessed = Number(resume?.processed || 0)

    const firstPass = await reconcileSnapshot({
      connection,
      client,
      segmenter,
      index: indexSet.currentIndex,
      concurrency,
      startAfter: resume?.last_record_id ?? null,
      alreadyProcessed,
      onCheckpoint: (lastId, processed) => saveRebuildProgress(
        connection, indexSet.currentIndex, lastId, processed,
      ),
      onProgress: progressReporter(onProgress, projection, 'build'),
    })
    const aliasState = await currentAliasState(client, indexSet)
    await switchCurrentAliases(client, indexSet, aliasState)

    // Writes can commit while the first pass is scanning. Once every legacy
    // write alias points at the new concrete index, replay PostgreSQL current
    // truth once more; external_gte prevents a late older snapshot row from
    // overwriting a newer projector write.
    //
    // Only what changed since the build began needs replaying. Rescanning the
    // whole corpus would double a multi-hour rebuild to catch a delta measured
    // in minutes of ingest. `last_seen_at` is bumped by every upsert, changed
    // or not, so this is a superset of the writes that raced the build.
    const secondPass = await reconcileSnapshot({
      connection,
      client,
      segmenter,
      index: indexSet.currentIndex,
      concurrency,
      changedSince: buildStartedAt,
      onProgress: progressReporter(onProgress, projection, 'catch-up'),
    })
    await completeRebuildProgress(connection, indexSet.currentIndex)
    logger?.log?.(
      `[search] rebuilt ${indexSet.currentIndex}: first=${firstPass} catch-up=${secondPass}`,
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

async function reconcileContentSnapshot({
  connection,
  client,
  segmenter,
  index,
  concurrency = 1,
  startAfter = null,
  changedSince = null,
  alreadyProcessed = 0,
  onCheckpoint = null,
  onProgress = null,
}) {
  let cursor = startAfter
  let projected = Number(alreadyProcessed) || 0
  while (true) {
    const { rows } = await connection.query(
      `SELECT * FROM core.canonical_records
        WHERE ($1::uuid IS NULL OR id > $1)
          AND ($3::timestamptz IS NULL OR last_seen_at >= $3)
        ORDER BY id
        LIMIT $2`,
      [cursor, CURRENT_REBUILD_BATCH, changedSince],
    )
    if (rows.length === 0) break

    // Segmentation dominates a rebuild, and every call waits on a remote
    // service. Overlapping them across the batch keeps that service busy
    // instead of leaving it idle between round trips. The strict wrapper still
    // vets every result, so concurrency changes when tokens arrive, never which
    // backend produced them.
    const documents = await mapWithConcurrency(
      rows,
      concurrency,
      (row) => (row.deleted_at != null ? null : buildContentDocument(row, { segmenter })),
    )

    const operations = []
    const operationTypes = []
    for (const [position, row] of rows.entries()) {
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
        operations.push(documents[position])
        operationTypes.push('index')
      }
    }
    const response = await client.bulk(operations)
    assertSnapshotBulk(response, operationTypes, 'Content')
    projected += rows.length
    cursor = rows.at(-1).id
    // Checkpoint only after the batch is acknowledged by Elasticsearch.
    await onCheckpoint?.(cursor, projected)
    await onProgress?.(projected)
    if (rows.length < CURRENT_REBUILD_BATCH) break
  }
  return projected
}

async function reconcileChunkSnapshot({
  connection,
  client,
  segmenter,
  index,
  concurrency = 1,
  startAfter = null,
  changedSince = null,
  alreadyProcessed = 0,
  onCheckpoint = null,
  onProgress = null,
}) {
  let cursor = startAfter
  let projected = Number(alreadyProcessed) || 0
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
          AND ($3::timestamptz IS NULL OR r.last_seen_at >= $3)
        ORDER BY c.id
        LIMIT $2`,
      [cursor, CURRENT_REBUILD_BATCH, changedSince],
    )
    if (rows.length === 0) break

    const tokenSets = await mapWithConcurrency(
      rows,
      concurrency,
      (row) => segmenter.segment(row.content),
    )

    const operations = []
    const operationTypes = []
    for (const [position, row] of rows.entries()) {
      const tokens = tokenSets[position]
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
    cursor = rows.at(-1).id
    await onCheckpoint?.(cursor, projected)
    await onProgress?.(projected)
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
