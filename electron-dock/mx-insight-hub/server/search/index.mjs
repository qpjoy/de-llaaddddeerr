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
import { withCurrentStateCutoverFence } from './current-state.mjs'

export { SearchProjector, runProjectorLoop } from './projector.mjs'
export { SearchQueries } from './queries.mjs'
export { contentIndex, chunkIndex } from './index-definitions.mjs'
export {
  resolveCurrentStateBackings,
  purgeStaleCurrentStateCopies,
  withCurrentStateWriteFence,
  withCurrentStateCutoverFence,
} from './current-state.mjs'

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
/**
 * Read whether a restart should replay the corpus.
 *
 * Absent table or row means "no": a deployment that has not been asked to
 * rebuild should come up and serve.
 */
export async function startupRebuildEnabled(pool) {
  if (!pool?.query) return false
  try {
    const { rows } = await pool.query('SELECT startup_rebuild FROM control.search_settings WHERE id')
    return rows[0]?.startup_rebuild === true
  } catch {
    return false
  }
}

export async function setStartupRebuild(pool, enabled, updatedBy = null) {
  await pool.query(
    `INSERT INTO control.search_settings (id, startup_rebuild, updated_by, updated_at)
     VALUES (true, $1, $2, now())
     ON CONFLICT (id) DO UPDATE
       SET startup_rebuild = EXCLUDED.startup_rebuild,
           updated_by = EXCLUDED.updated_by,
           updated_at = now()`,
    [Boolean(enabled), updatedBy],
  )
  return { startupRebuild: Boolean(enabled) }
}

export async function ensureSearchIndices(search, {
  logger = console,
  failOnError = false,
  onProgress = null,
  // Skip the corpus replay and only guarantee the index, template and aliases
  // exist. That is all the projector needs to start serving and draining its
  // outbox; the replay is a separate, deliberate operation.
  schemaOnly = false,
  // An operator-requested REINDEX must scan the entire canonical corpus even
  // when the configured schema version already serves traffic. Build into the
  // inactive A/B slot and move aliases only after the first pass succeeds.
  forceFull = false,
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
    const segmenterBackend = search.segmenter?.expectedBackend
      || await observedBackend(search.segmenter)
    const concurrency = search.segmenterConcurrency || 1
    if (schemaOnly) {
      logger?.log?.('[search] schema-only reconcile: the corpus replay is not part of startup')
    }
    report.content = await ensureCurrentContentIndex({
      client: search.client,
      pool: search.pool,
      segmenter,
      indexSet: search.indexSet,
      concurrency,
      schemaOnly,
      forceFull,
      segmenterBackend,
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
        schemaOnly,
        forceFull,
        segmenterBackend,
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
// Sized against the projector's memory limit rather than against how many
// distinct strings exist. The win comes from the fields that repeat heavily --
// author names, usernames, chat titles -- whose cardinality is far below this,
// so a smaller cap keeps almost all of the benefit at a fraction of the heap.
const SEGMENT_CACHE_MAX_ENTRIES = Number(process.env.MX_INSIGHT_SEGMENT_CACHE_ENTRIES) || 50_000
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

  // Only verified results are cached. A degraded result is transient by nature --
  // the strict caller is about to retry it -- so remembering one would turn a
  // momentary tokenizer failure into a permanent hole for that text.
  const cacheable = (result) => result?.degraded === false
  const store = (key, result) => (cacheable(result) ? remember(key, result) : result)

  return {
    stats: () => ({ size: cache.size }),
    async segmentWithMeta(text, options = {}) {
      const key = keyOf(text)
      if (key !== null && cache.has(key)) return cache.get(key)
      return store(key, await segmenter.segmentWithMeta(text, options))
    },
    async segment(text, options = {}) {
      const key = keyOf(text)
      if (key !== null && cache.has(key)) return cache.get(key).tokens
      return store(key, await segmenter.segmentWithMeta(text, options)).tokens
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
    `SELECT last_record_id, processed, build_started_at, aliases_switched_at,
            segmenter_backend
       FROM control.search_rebuild_progress
      WHERE index_name = $1 AND completed_at IS NULL`,
    [indexName],
  )
  return rows[0]
    ? { ...rows[0], segmenter_backend: rows[0].segmenter_backend ?? null }
    : null
}

/**
 * How far canonical truth is already projected into a serving index.
 *
 * NULL -- no row, or a row that never completed cleanly -- means unknown, and
 * unknown must be treated as "replay everything". That is what preserves the
 * crash-window guarantee while letting an ordinary restart replay minutes
 * instead of the whole corpus.
 */
async function readReconciledThrough(connection, indexName) {
  const { rows } = await connection.query(
    `SELECT reconciled_through FROM control.search_rebuild_progress
      WHERE index_name = $1`,
    [indexName],
  )
  return rows[0]?.reconciled_through ?? null
}

/** Which tokenizer's verified output the live projection is made of. */
export async function readIndexBackend(pool, indexName) {
  if (!pool?.query || !indexName) return null
  try {
    const { rows } = await pool.query(
      `SELECT segmenter_backend FROM control.search_rebuild_progress
        WHERE index_name = $1`,
      [indexName],
    )
    return rows[0]?.segmenter_backend ?? null
  } catch {
    // Provenance is reporting, never a precondition.
    return null
  }
}

// Written only after the pass it describes has fully succeeded. Recording it
// earlier would let a crash mid-pass claim ground it never covered.
async function saveReconciledThrough(connection, indexName, projection, through, backend) {
  await connection.query(
    `INSERT INTO control.search_rebuild_progress
       (index_name, projection, reconciled_through, segmenter_backend, completed_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (index_name) DO UPDATE
       SET reconciled_through = EXCLUDED.reconciled_through,
           segmenter_backend = coalesce(EXCLUDED.segmenter_backend, control.search_rebuild_progress.segmenter_backend),
           projection = EXCLUDED.projection,
           updated_at = now()`,
    [indexName, projection, through, backend],
  )
}

/**
 * Name the backend a pass actually used, from the tokens it produced.
 *
 * Taken from a real segmentation rather than from configuration: configuration
 * is what this process intends, provenance must be what the index received.
 */
async function observedBackend(segmenter) {
  try {
    const result = await segmenter?.segmentWithMeta?.('吴恩达与人工智能')
    return typeof result?.backendUsed === 'string' ? result.backendUsed : null
  } catch {
    return null
  }
}

async function beginRebuildProgress(connection, indexName, projection, backend) {
  const { rows } = await connection.query(
    `INSERT INTO control.search_rebuild_progress
       (index_name, projection, segmenter_backend)
     VALUES ($1, $2, $3)
     ON CONFLICT (index_name) DO UPDATE
       SET projection = EXCLUDED.projection,
           segmenter_backend = EXCLUDED.segmenter_backend,
           last_record_id = NULL,
           processed = 0,
           build_started_at = now(),
           aliases_switched_at = NULL,
           completed_at = NULL,
           updated_at = now()
     RETURNING build_started_at`,
    [indexName, projection, backend],
  )
  return rows[0].build_started_at
}

async function markRebuildAliasesSwitched(connection, indexName) {
  await connection.query(
    `UPDATE control.search_rebuild_progress
        SET aliases_switched_at = now(), updated_at = now()
      WHERE index_name = $1 AND completed_at IS NULL`,
    [indexName],
  )
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
  schemaOnly = false,
  forceFull = false,
  segmenterBackend = null,
  logger = console,
  onProgress = null,
}) {
  return ensureCurrentStateIndex({
    client,
    pool,
    segmenter,
    indexSet,
    concurrency,
    schemaOnly,
    forceFull,
    segmenterBackend,
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
  schemaOnly = false,
  forceFull = false,
  segmenterBackend = null,
  logger = console,
  onProgress = null,
}) {
  return ensureCurrentStateIndex({
    client,
    pool,
    segmenter,
    indexSet,
    concurrency,
    schemaOnly,
    forceFull,
    segmenterBackend,
    logger,
    onProgress,
    projection: 'chunks',
    reconcileSnapshot: reconcileChunkSnapshot,
  })
}

const rebuildSlotIndex = (indexSet) => `${indexSet.writeAlias}-rebuild`

/**
 * Pick the inactive physical slot for an operator-requested full rebuild.
 *
 * Two stable names bound disk/orphan growth and make an interrupted rebuild
 * resumable from PostgreSQL. The serving slot is never deleted or overwritten;
 * aliases move only after the inactive slot contains a complete first pass.
 */
export function fullRebuildTargetIndex(indexSet, servingIndex = null) {
  if (!indexSet?.currentIndex || !indexSet?.writeAlias) {
    throw new TypeError('A current-state index definition is required')
  }
  return servingIndex === indexSet.currentIndex
    ? rebuildSlotIndex(indexSet)
    : indexSet.currentIndex
}

/** Resolve a serving A/B generation for this exact schema version. */
function servingGeneration(aliasState, indexSet) {
  if (aliasState.readIndices.length !== 1) return null
  const readIndex = aliasState.readIndices[0]
  // The read alias is the customer-visible truth. Even if a damaged write
  // alias is missing or split, a forced rebuild must select the other slot and
  // must never overwrite the index customers are still reading.
  return readIndex === indexSet.currentIndex || readIndex === rebuildSlotIndex(indexSet)
    ? readIndex
    : null
}

async function ensureCurrentStateIndex({
  client,
  pool,
  segmenter,
  indexSet,
  concurrency = 1,
  schemaOnly = false,
  forceFull = false,
  segmenterBackend = null,
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
    const servingIndex = servingGeneration(before, indexSet)
    const servingProgress = servingIndex
      ? await readRebuildProgress(connection, servingIndex)
      : null
    const recoveringCutover = Boolean(servingProgress?.aliases_switched_at)
    const targetIndex = recoveringCutover
      ? servingIndex
      : (forceFull
          ? fullRebuildTargetIndex(indexSet, servingIndex)
          : (servingIndex || indexSet.currentIndex))
    const targetAliases = before.memberships.get(targetIndex)
    if (forceFull && !recoveringCutover && targetAliases?.size > 0) {
      const error = new Error(
        `Cannot select an inactive rebuild slot for ${indexSet.readAlias}; ` +
          `${targetIndex} still serves alias(es): ${[...targetAliases].join(', ')}`,
      )
      error.code = 'search_alias_ambiguous'
      throw error
    }
    const targetIndexSet = targetIndex === indexSet.currentIndex
      ? indexSet
      : { ...indexSet, currentIndex: targetIndex, bootstrapIndex: targetIndex }
    const passBackend = segmenterBackend
      || segmenter?.expectedBackend
      || await observedBackend(segmenter)
    const targetServesAllAliases = before.readIndices.length === 1
      && before.readIndices[0] === targetIndexSet.currentIndex
      && before.aliasesToMove.every((alias) => {
        const indices = before.aliasIndices.get(alias)
        return indices?.length === 1 && indices[0] === targetIndexSet.currentIndex
      })

    // A process can die after the atomic alias switch and before the catch-up
    // pass completes. The serving physical index plus this durable phase marker
    // proves that its first full pass finished. Complete that exact generation
    // before considering another A/B build; otherwise writes acknowledged on
    // the old slot during the first pass could be missing forever.
    if (recoveringCutover) {
      if (!targetServesAllAliases) {
        const error = new Error(
          `Cannot resume ${targetIndexSet.currentIndex}; read and version write aliases ` +
            'do not converge on the same rebuild generation',
        )
        error.code = 'search_alias_ambiguous'
        throw error
      }
      if (servingProgress.segmenter_backend !== passBackend) {
        const error = new Error(
          `Cannot resume ${targetIndexSet.currentIndex} with tokenizer ` +
            `${passBackend || 'unknown'}; its first pass used ` +
            `${servingProgress.segmenter_backend || 'unknown'}`,
        )
        error.code = 'search_rebuild_backend_mismatch'
        throw error
      }
      const mappingConflict = await updateCurrentMapping(client, targetIndexSet, logger)
      if (mappingConflict) {
        return currentEnsureReport(targetIndexSet, { mappingConflict, rebuilt: false, created: false })
      }
      const indexed = await reconcileSnapshot({
        connection,
        client,
        segmenter,
        index: targetIndexSet.currentIndex,
        concurrency,
        changedSince: servingProgress.build_started_at,
        onProgress: progressReporter(onProgress, projection, 'catch-up', { logger }),
      })
      await completeRebuildProgress(connection, targetIndexSet.currentIndex)
      await saveReconciledThrough(
        connection,
        targetIndexSet.currentIndex,
        projection,
        servingProgress.build_started_at,
        passBackend,
      )
      logger?.log?.(`[search] completed interrupted catch-up for ${targetIndexSet.currentIndex}`)
      return currentEnsureReport(targetIndexSet, {
        mappingConflict: null,
        rebuilt: true,
        created: false,
        indexed,
      })
    }
    const active = targetServesAllAliases

    if (active) {
      const mappingConflict = await updateCurrentMapping(client, targetIndexSet, logger)
      if (mappingConflict) {
        return currentEnsureReport(targetIndexSet, { mappingConflict, rebuilt: false, created: false })
      }
      // The previous process may have died after the atomic alias switch but
      // before its second reconciliation pass, so PostgreSQL truth is replayed
      // on startup to close that crash window; external_gte makes the pass safe
      // alongside live projectors.
      //
      // Replayed from a watermark rather than from the beginning. The window
      // this protects against is narrow, while re-segmenting the whole corpus
      // through a single-slot tokenizer takes hours -- a cost that used to be
      // charged on every ordinary deploy. An unclean exit leaves the watermark
      // unmoved, so the guarantee survives: what is uncertain is still replayed,
      // and only what is certain is skipped.
      if (schemaOnly) {
        return currentEnsureReport(targetIndexSet, {
          mappingConflict: null, rebuilt: false, created: false, indexed: 0,
        })
      }
      const startedAt = new Date()
      const reconciledThrough = await readReconciledThrough(connection, targetIndexSet.currentIndex)
      if (reconciledThrough) {
        logger?.log?.(
          `[search] ${targetIndexSet.currentIndex} replaying changes since ${reconciledThrough.toISOString()}`,
        )
      } else {
        logger?.log?.(`[search] ${targetIndexSet.currentIndex} has no reconciliation watermark; replaying in full`)
      }
      const indexed = await reconcileSnapshot({
        connection,
        client,
        segmenter,
        index: targetIndexSet.currentIndex,
        concurrency,
        changedSince: reconciledThrough,
        onProgress: progressReporter(onProgress, projection, 'reconcile', { logger }),
      })
      // Only now: the pass is complete, so this instant is genuinely covered.
      await saveReconciledThrough(
        connection, targetIndexSet.currentIndex, projection, startedAt, passBackend,
      )
      logger?.log?.(`[search] ${targetIndexSet.currentIndex} reconciled ${indexed} record(s)`)
      return currentEnsureReport(targetIndexSet, {
        mappingConflict: null,
        rebuilt: false,
        created: false,
        indexed,
      })
    }

    let exists = await client.indexExists(targetIndexSet.currentIndex)
    let created = false
    const currentWasServing = before.readIndices.includes(targetIndexSet.currentIndex)
    // A partial index left by an interrupted rebuild is invisible -- no alias
    // points at it -- so it is safe to continue filling rather than to discard.
    // Continuing is not an optimisation at this corpus size: a full pass is
    // hours of single-slot tokenizer work, and restarting from the first row on
    // every transient failure is how a rebuild becomes one that never finishes.
    // The cursor is trusted only when it belongs to this exact index name, so a
    // schema bump can never resume onto an incompatible mapping.
    let resume = null
    if (exists && !currentWasServing) {
      resume = await readRebuildProgress(connection, targetIndexSet.currentIndex)
      if (!resume) {
        // No cursor means unknown provenance: the snapshot could be partial in
        // ways nothing recorded, so it is rebuilt from scratch as before.
        await client.request('DELETE', `/${encodeURIComponent(targetIndexSet.currentIndex)}`)
        exists = false
      } else if (resume.segmenter_backend !== passBackend) {
        logger?.warn?.(
          `[search] discarding partial ${targetIndexSet.currentIndex}: tokenizer changed ` +
            `from ${resume.segmenter_backend || 'unknown'} to ${passBackend || 'unknown'}`,
        )
        await client.request('DELETE', `/${encodeURIComponent(targetIndexSet.currentIndex)}`)
        exists = false
        resume = null
      } else {
        logger?.log?.(
          `[search] resuming ${targetIndexSet.currentIndex} after ${resume.processed} records`,
        )
      }
    }
    if (!exists) {
      await client.createIndex(targetIndexSet.currentIndex, {
        settings: targetIndexSet.settings,
        mappings: targetIndexSet.mappings,
      })
      created = true
    } else if (!resume) {
      const mappingConflict = await updateCurrentMapping(client, targetIndexSet, logger)
      if (mappingConflict) {
        return currentEnsureReport(targetIndexSet, { mappingConflict, rebuilt: false, created: false })
      }
    }

    if (schemaOnly) {
      // Deliberately not skipped here. This index serves no alias yet, so there
      // is nothing to preserve by returning early -- and the aliases must not be
      // switched onto an unpopulated index. Startup creates it and stops; the
      // replay that fills it is the operator's call.
      logger?.warn?.(
        `[search] ${targetIndexSet.currentIndex} exists but serves no alias; run a rebuild to populate and publish it`,
      )
      return currentEnsureReport(targetIndexSet, {
        mappingConflict: null, rebuilt: false, created, indexed: 0,
      })
    }
    const buildStartedAt = resume
      ? resume.build_started_at
      : await beginRebuildProgress(
          connection, targetIndexSet.currentIndex, projection, passBackend,
        )
    const alreadyProcessed = Number(resume?.processed || 0)
    // Best-effort denominator for the progress line. A failure here costs the
    // percentage, never the rebuild.
    let total = null
    try {
      const { rows } = await connection.query(countStatement(projection))
      const counted = Number(rows[0]?.total)
      if (Number.isFinite(counted) && counted > 0) total = counted
    } catch (error) {
      logger?.warn?.(`[search] could not size the ${projection} rebuild: ${error.message}`)
    }

    const firstPass = await reconcileSnapshot({
      connection,
      client,
      segmenter,
      index: targetIndexSet.currentIndex,
      concurrency,
      startAfter: resume?.last_record_id ?? null,
      alreadyProcessed,
      onCheckpoint: (lastId, processed) => saveRebuildProgress(
        connection, targetIndexSet.currentIndex, lastId, processed,
      ),
      onProgress: progressReporter(onProgress, projection, 'build', { logger, total }),
    })
    await withCurrentStateCutoverFence({ connection, indexSet: targetIndexSet }, async () => {
      const aliasState = await currentAliasState(client, targetIndexSet)
      await markRebuildAliasesSwitched(connection, targetIndexSet.currentIndex)
      await switchCurrentAliases(client, targetIndexSet, aliasState)
    })

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
      index: targetIndexSet.currentIndex,
      concurrency,
      changedSince: buildStartedAt,
      onProgress: progressReporter(onProgress, projection, 'catch-up', { logger }),
    })
    await completeRebuildProgress(connection, targetIndexSet.currentIndex)
    // A finished build has projected everything up to when it began, so the next
    // startup can replay the delta rather than the corpus.
    await saveReconciledThrough(
      connection, targetIndexSet.currentIndex, projection, buildStartedAt, passBackend,
    )
    logger?.log?.(
      `[search] rebuilt ${targetIndexSet.currentIndex}: first=${firstPass} catch-up=${secondPass}`,
    )
    return currentEnsureReport(targetIndexSet, {
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

// A rebuild of this corpus runs for hours and, until now, logged nothing until
// it finished: `onProgress` only pulsed a lock heartbeat. The only way to tell a
// working rebuild from a wedged one was to read Elasticsearch's internal
// counters and reason backwards. One throttled line per interval is enough to
// answer "is it alive, how far, how fast" from `kubectl logs`.
const PROGRESS_LOG_INTERVAL_MS = 60_000

function countStatement(projection) {
  return projection === 'chunks'
    ? `SELECT count(*)::bigint AS total FROM core.record_chunks c
         JOIN core.canonical_records r ON r.id = c.record_id
        WHERE c.embedded_at IS NOT NULL AND c.vector IS NOT NULL
          AND r.deleted_at IS NULL AND c.source_revision = r.current_revision`
    : 'SELECT count(*)::bigint AS total FROM core.canonical_records'
}

function progressReporter(onProgress, projection, pass, { logger = null, total = null } = {}) {
  const startedAt = Date.now()
  let lastLoggedAt = startedAt
  let lastLoggedCount = 0
  const log = (processed) => {
    if (!logger?.log) return
    const now = Date.now()
    if (now - lastLoggedAt < PROGRESS_LOG_INTERVAL_MS) return
    const rate = Math.round(((processed - lastLoggedCount) * 1_000) / (now - lastLoggedAt))
    const share = total ? ` of ${total} (${Math.round((processed / total) * 100)}%)` : ''
    const eta = total && rate > 0
      ? `, eta ${Math.round((total - processed) / rate / 60)}m`
      : ''
    logger.log(`[search] ${projection} ${pass}: ${processed}${share} at ${rate}/s${eta}`)
    lastLoggedAt = now
    lastLoggedCount = processed
  }
  if (typeof onProgress !== 'function') {
    return logger?.log ? (processed) => log(processed) : null
  }
  return async (processed) => {
    log(processed)
    await onProgress({ projection, pass, processed })
  }
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
          AND ($3::timestamptz IS NULL
            OR r.last_seen_at >= $3
            OR c.embedded_at >= $3)
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
