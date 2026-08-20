import { randomUUID } from 'node:crypto'
import { ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import {
  purgeStaleCurrentStateCopies,
  withCurrentStateWriteFence,
} from '../search/current-state.mjs'
import { isRetryableSegmenterIntegrityError } from '../search/reindex-integrity.mjs'
import { CHUNKER_VERSION, chunkRecord } from './chunker.mjs'
import { buildChunkDocument } from './document.mjs'

// The retrieval pipeline, in three independently-restartable stages:
//
//   1. chunk    canonical text -> core.record_chunks       (PostgreSQL only)
//   2. embed    chunks without a vector -> model provider  (costs money)
//   3. project  embedded chunks -> Elasticsearch chunk index
//
// They are separate stages, not one loop, because they fail for different
// reasons and have very different costs. If embedding and indexing were one
// step, an Elasticsearch outage would force every affected vector to be
// recomputed at the model's expense when it recovered. Splitting them means a
// computed vector is paid for once.

const CHUNK_BATCH = 200
const EMBED_BATCH = 32
const CHUNK_PROJECTION_MAX_ATTEMPTS = 5

export class EmbeddingPipeline {
  constructor({ pool, agent, client, segmenter, chunkIndexSet, logger = console }) {
    this.pool = pool
    this.agent = agent
    this.client = client
    this.segmenter = segmenter
    this.chunkIndexSet = chunkIndexSet
    this.logger = logger
  }

  get enabled() {
    // Deleting stale/tombstoned documents must keep running even when the model
    // provider is removed or unavailable. embedPending has its own provider gate.
    return Boolean(this.client && this.chunkIndexSet)
  }

  /**
   * Stage 1: materialise chunks for records that have none, or whose chunks came
   * from an older revision.
   *
   * Stale chunks are deleted in the same transaction that writes the new ones.
   * Without that, an edit that shortens a record leaves its extra chunks behind
   * and retrieval keeps returning text the source no longer contains — a
   * failure that looks like a model problem and is really a bookkeeping one.
   */
  async materializeChunks({ limit = CHUNK_BATCH } = {}) {
    const { rows } = await this.pool.query(
      `SELECT r.id, r.dataset_id, r.platform, r.external_id, r.url, r.title,
              r.body, r.event_time, r.current_revision
         FROM core.canonical_records r
        WHERE r.deleted_at IS NULL
          AND coalesce(length(r.body), 0) + coalesce(length(r.title), 0) >= 24
          AND NOT EXISTS (
            SELECT 1 FROM core.record_chunks c
             WHERE c.record_id = r.id
               AND c.chunker_version = $2
               AND c.source_revision = r.current_revision
          )
        ORDER BY r.id
        LIMIT $1`,
      [limit, CHUNKER_VERSION],
    )
    // Deleted records and records shortened below the retrieval threshold do
    // not appear in the materialisation query. They still need their existing
    // PostgreSQL chunks removed and their Elasticsearch ids tombstoned.
    const { rows: retired } = await this.pool.query(
      `SELECT r.id, r.current_revision
         FROM core.canonical_records r
        WHERE EXISTS (SELECT 1 FROM core.record_chunks c WHERE c.record_id = r.id)
          AND (r.deleted_at IS NOT NULL
               OR coalesce(length(r.body), 0) + coalesce(length(r.title), 0) < 24)
        ORDER BY r.id
        LIMIT $1`,
      [limit],
    )
    if (rows.length === 0 && retired.length === 0) {
      return { records: 0, chunks: 0, removed: 0, deletionsQueued: 0 }
    }

    const workByRecord = new Map()
    for (const record of rows) {
      workByRecord.set(record.id, { record, retired: false })
    }
    for (const record of retired) {
      const existing = workByRecord.get(record.id)
      if (!existing || Number(record.current_revision) >= Number(existing.record.current_revision)) {
        workByRecord.set(record.id, { record, retired: true })
      }
    }
    const work = [...workByRecord.values()].sort((left, right) => (
      String(left.record.id).localeCompare(String(right.record.id))
    ))

    let recordCount = 0
    let chunkCount = 0
    let removed = 0
    let deletionsQueued = 0
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const { record, retired: selectedAsRetired } of work) {
        // The discovery queries run before the transaction. Lock and re-check
        // canonical truth so an older worker cannot delete or overwrite chunks
        // after a newer source revision committed in the meantime.
        const { rows: lockedRows } = await client.query(
          `SELECT current_revision, deleted_at,
                  coalesce(length(body), 0) + coalesce(length(title), 0) AS text_length
             FROM core.canonical_records
            WHERE id = $1
            FOR UPDATE`,
          [record.id],
        )
        const current = lockedRows[0]
        if (!current || Number(current.current_revision) !== Number(record.current_revision)) continue
        const currentlyRetired = current.deleted_at != null || Number(current.text_length) < 24
        if (currentlyRetired !== selectedAsRetired) continue

        recordCount += 1
        if (currentlyRetired) {
          deletionsQueued += await this.#queueChunkDeletions(client, {
            recordId: record.id,
            sourceRevision: record.current_revision,
          })
          const deleted = await client.query(
            'DELETE FROM core.record_chunks WHERE record_id = $1',
            [record.id],
          )
          removed += deleted.rowCount
          continue
        }

        const chunks = chunkRecord(record)

        // Only ids that the new chunk set will not reuse need explicit deletes.
        // Retained ids are overwritten by their externally-versioned index op.
        deletionsQueued += await this.#queueChunkDeletions(client, {
          recordId: record.id,
          sourceRevision: record.current_revision,
          chunkerVersion: CHUNKER_VERSION,
          retainedCount: chunks.length,
        })

        // Remove anything from a previous revision or a previous chunker, plus
        // any trailing chunk index the new content no longer reaches.
        const deleted = await client.query(
          `DELETE FROM core.record_chunks
            WHERE record_id = $1
              AND (chunker_version <> $2
                   OR source_revision IS DISTINCT FROM $3
                   OR chunk_index >= $4)`,
          [record.id, CHUNKER_VERSION, record.current_revision, chunks.length],
        )
        removed += deleted.rowCount

        for (const chunk of chunks) {
          const upserted = await client.query(
            `INSERT INTO core.record_chunks AS existing
               (id, record_id, chunk_index, content, token_count, chunker_version, source_revision)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (record_id, chunk_index, chunker_version) DO UPDATE SET
               content = EXCLUDED.content,
               token_count = EXCLUDED.token_count,
               source_revision = EXCLUDED.source_revision,
               -- Content changed, so any existing vector is now for text that
               -- is gone. Clearing these two columns is what re-queues the
               -- chunk for stages 2 and 3.
               embedding_model = NULL,
               embedding_version = NULL,
               embedded_at = NULL,
               projected_at = NULL,
               projection_attempts = 0,
               projection_last_error = NULL,
               projection_failed_at = NULL
             WHERE existing.source_revision IS DISTINCT FROM EXCLUDED.source_revision
                OR existing.content IS DISTINCT FROM EXCLUDED.content
                OR existing.token_count IS DISTINCT FROM EXCLUDED.token_count`,
            [
              randomUUID(), record.id, chunk.chunkIndex, chunk.content,
              chunk.tokenCount, chunk.chunkerVersion, chunk.sourceRevision,
            ],
          )
          chunkCount += upserted.rowCount
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    return {
      records: recordCount,
      chunks: chunkCount,
      removed,
      deletionsQueued,
    }
  }

  async #queueChunkDeletions(client, {
    recordId,
    sourceRevision,
    chunkerVersion = null,
    retainedCount = null,
  }) {
    const { rowCount } = await client.query(
      `INSERT INTO core.chunk_projection_deletes AS deletion
         (document_id, record_id, source_revision)
       SELECT c.record_id::text || ':' || c.chunk_index::text || ':' || c.chunker_version,
              c.record_id, $2
         FROM core.record_chunks c
        WHERE c.record_id = $1
          AND ($3::text IS NULL
               OR c.chunker_version <> $3
               OR c.chunk_index >= $4)
       ON CONFLICT (document_id) DO UPDATE SET
         record_id = EXCLUDED.record_id,
         source_revision = greatest(deletion.source_revision, EXCLUDED.source_revision),
         projected_at = CASE
           WHEN EXCLUDED.source_revision > deletion.source_revision THEN NULL
           ELSE deletion.projected_at
         END,
         updated_at = now()`,
      [recordId, sourceRevision, chunkerVersion, retainedCount],
    )
    return rowCount
  }

  /**
   * Stage 2: embed chunks that have no vector.
   *
   * The vector is written straight back to PostgreSQL alongside the chunk. That
   * is deliberate even though the vector's query home is Elasticsearch: it
   * makes stage 3 replayable, and it means rebuilding the search index never
   * requires paying the model again.
   */
  async embedPending({ limit = EMBED_BATCH } = {}) {
    if (!this.agent?.embeddings?.available) return { embedded: 0, skipped: 'no embedding provider' }

    const { rows } = await this.pool.query(
      `SELECT c.id, c.content, c.source_revision
         FROM core.record_chunks c
         JOIN core.canonical_records r ON r.id = c.record_id
        WHERE c.embedded_at IS NULL
          AND r.deleted_at IS NULL
          AND c.source_revision = r.current_revision
        ORDER BY c.created_at
        LIMIT $1`,
      [limit],
    )
    if (rows.length === 0) return { embedded: 0 }

    const result = await this.agent.embed(rows.map((row) => row.content))
    const model = `${result.provider}:${result.model}`

    let embedded = 0
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const [index, row] of rows.entries()) {
        const updated = await client.query(
          `UPDATE core.record_chunks
              SET embedding_model = $2, embedding_version = 1, embedded_at = now(),
                  vector = $3::real[]
            WHERE id = $1
              AND source_revision = $4
              AND embedded_at IS NULL`,
          [row.id, model, result.vectors[index], row.source_revision],
        )
        embedded += updated.rowCount
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    // Which provider actually served this matters: a corpus embedded half by
    // one model and half by another is not comparable, and the only place that
    // becomes visible is here.
    if (result.attempts?.length > 0) {
      this.logger?.warn?.(
        `[embed] served by fallback provider ${result.provider} (${result.attempts.length} provider(s) skipped)`,
      )
    }
    return { embedded, model, provider: result.provider }
  }

  /**
   * Stage 3: index embedded chunks into Elasticsearch.
   *
   * Document ids are deterministic — `${recordId}:${chunkIndex}:${chunkerVersion}`
   * — so re-projection overwrites rather than duplicating, and a chunker version
   * bump lands in distinct documents that can be cleaned up separately.
   */
  async projectPending({ limit = CHUNK_BATCH } = {}) {
    if (!this.enabled) return { projected: 0, skipped: 'chunk index not configured' }

    const { rows } = await this.pool.query(
      `SELECT c.id, c.record_id, c.chunk_index, c.content, c.chunker_version,
              c.source_revision, c.embedding_model, c.embedding_version, c.vector,
              r.dataset_id, r.platform, r.external_id, r.url, r.title, r.event_time
         FROM core.record_chunks c
         JOIN core.canonical_records r ON r.id = c.record_id
        WHERE c.embedded_at IS NOT NULL AND c.projected_at IS NULL
          AND c.projection_failed_at IS NULL
          AND r.deleted_at IS NULL
          AND c.source_revision = r.current_revision
        ORDER BY c.embedded_at
        LIMIT $1`,
      [limit],
    )
    if (rows.length === 0) return { projected: 0 }

    const projections = []
    let failedCount = 0
    for (const row of rows) {
      try {
        const tokens = await this.segmenter.segment(row.content)
        projections.push({
          id: `${row.record_id}:${row.chunk_index}:${row.chunker_version}`,
          version: Number(row.source_revision),
          row,
          document: buildChunkDocument(row, {
            tokens,
            createdAt: new Date().toISOString(),
          }),
        })
      } catch (error) {
        if (isRetryableSegmenterIntegrityError(error)) throw error
        await this.#markProjectionFailure(row, error)
        failedCount += 1
      }
    }

    if (projections.length === 0) return { projected: 0, failed: failedCount }

    const projected = []
    let retryableBulkError = null
    await withCurrentStateWriteFence({
      pool: this.pool,
      indexSet: this.chunkIndexSet,
    }, async (connection) => {
      const { writeTarget } = await purgeStaleCurrentStateCopies({
        client: this.client,
        pool: connection,
        indexSet: this.chunkIndexSet,
        documents: projections,
        versionField: 'sourceRevision',
        expectedBackend: this.segmenter?.expectedBackend,
      })
      const operations = []
      for (const projection of projections) {
        operations.push({
          index: {
            _index: writeTarget,
            _id: projection.id,
            version: projection.version,
            // Strict external versioning makes a same-revision tombstone win over
            // an in-flight stale index operation (notably across chunker changes).
            version_type: 'external',
          },
        })
        operations.push(projection.document)
      }
      const response = await this.client.bulk(operations)
      for (const [index, projection] of projections.entries()) {
        const item = response.items?.[index]
        const action = item?.index
        if (!action || (action.error && action.status !== 409)) {
          const error = action?.error
            ? JSON.stringify(action.error).slice(0, 500)
            : 'missing index result from Elasticsearch bulk response'
          if (action?.status === 408 || action?.status === 425 || action?.status === 429 || action?.status >= 500) {
            retryableBulkError ||= new ElasticsearchUnavailableError(new Error(error))
          } else {
            await this.#markProjectionFailure(projection.row, new Error(error))
            failedCount += 1
          }
        }
        else projected.push(projection.row)
      }
    })

    let acknowledged = 0
    if (projected.length > 0) {
      const result = await this.pool.query(
        `UPDATE core.record_chunks AS chunk
            SET projected_at = now(), projection_attempts = 0,
                projection_last_error = NULL, projection_failed_at = NULL
           FROM unnest($1::uuid[], $2::bigint[]) AS done(id, source_revision)
          WHERE chunk.id = done.id
            AND chunk.source_revision = done.source_revision`,
        [
          projected.map((row) => row.id),
          projected.map((row) => row.source_revision),
        ],
      )
      acknowledged = result.rowCount
    }
    if (retryableBulkError) throw retryableBulkError
    return { projected: acknowledged, failed: failedCount }
  }

  async #markProjectionFailure(row, error) {
    const message = String(error?.message || error).slice(0, 2_000)
    const { rows = [] } = await this.pool.query(
      `UPDATE core.record_chunks AS chunk
          SET projection_attempts = chunk.projection_attempts + 1,
              projection_last_error = $3,
              projection_failed_at = CASE
                WHEN chunk.projection_attempts + 1 >= $4 THEN now()
                ELSE NULL
              END
        WHERE chunk.id = $1
          AND chunk.source_revision = $2
          AND chunk.projected_at IS NULL
        RETURNING chunk.projection_failed_at`,
      [row.id, row.source_revision, message, CHUNK_PROJECTION_MAX_ATTEMPTS],
    )
    if (rows[0]?.projection_failed_at) {
      this.logger?.error?.(
        `[embed] chunk ${row.id} quarantined after ${CHUNK_PROJECTION_MAX_ATTEMPTS} projection failures: ${message}`,
      )
    } else {
      this.logger?.error?.(`[embed] chunk ${row.id} projection failed: ${message}`)
    }
  }

  /** Project durable chunk tombstones before replacement documents. */
  async projectDeletions({ limit = CHUNK_BATCH } = {}) {
    if (!this.chunkIndexSet || !this.client) {
      return { projected: 0, skipped: 'chunk index not configured' }
    }
    const { rows } = await this.pool.query(
      `SELECT document_id, source_revision
         FROM core.chunk_projection_deletes
        WHERE projected_at IS NULL
        ORDER BY updated_at, document_id
        LIMIT $1`,
      [limit],
    )
    if (rows.length === 0) return { projected: 0, failed: 0 }

    const documents = rows.map((row) => ({
      id: row.document_id,
      version: Number(row.source_revision),
    }))
    let response = null
    await withCurrentStateWriteFence({
      pool: this.pool,
      indexSet: this.chunkIndexSet,
    }, async (connection) => {
      const { writeTarget } = await purgeStaleCurrentStateCopies({
        client: this.client,
        pool: connection,
        indexSet: this.chunkIndexSet,
        documents,
        versionField: 'sourceRevision',
      })
      const operations = documents.map((document) => ({
        delete: {
          _index: writeTarget,
          _id: document.id,
          version: document.version,
          version_type: 'external_gte',
        },
      }))
      response = await this.client.bulk(operations)
    })
    const projected = []
    const failed = []
    for (const [index, item] of (response.items || []).entries()) {
      const action = item.delete
      if (!action || (action.error && action.status !== 409)) {
        const error = action?.error
          ? JSON.stringify(action.error).slice(0, 500)
          : 'missing delete result from Elasticsearch bulk response'
        failed.push({ id: rows[index].document_id, error })
      } else {
        projected.push(rows[index])
      }
    }
    if (projected.length > 0) {
      await this.pool.query(
        `UPDATE core.chunk_projection_deletes AS deletion
            SET projected_at = now(), updated_at = now()
           FROM unnest($1::text[], $2::bigint[]) AS done(document_id, source_revision)
          WHERE deletion.document_id = done.document_id
            AND deletion.source_revision = done.source_revision`,
        [
          projected.map((row) => row.document_id),
          projected.map((row) => row.source_revision),
        ],
      )
    }
    if (failed.length > 0) {
      this.logger?.error?.(`[embed] ${failed.length} chunk delete(s) rejected by Elasticsearch: ${failed[0].error}`)
    }
    return { projected: projected.length, failed: failed.length }
  }

  /** One full cycle. Returns counts so a caller can decide whether to idle. */
  async runOnce() {
    const chunked = await this.materializeChunks()
    // Delete stale searchable documents before calling the model provider. A
    // provider outage must not keep a tombstoned record retrievable.
    const deletions = await this.projectDeletions()
    const embedded = await this.embedPending()
    const projected = await this.projectPending()
    return {
      chunked,
      embedded,
      deletions,
      projected,
      idle: chunked.records === 0
        && embedded.embedded === 0
        && deletions.projected === 0
        && projected.projected === 0,
    }
  }

  async status() {
    const { rows } = await this.pool.query(`
      SELECT
        (SELECT count(*) FROM core.records_needing_chunks)::int AS records_pending_chunks,
        (SELECT count(*) FROM core.record_chunks WHERE embedded_at IS NULL)::int AS chunks_pending_embedding,
        (SELECT count(*) FROM core.record_chunks
          WHERE embedded_at IS NOT NULL AND projected_at IS NULL
            AND projection_failed_at IS NULL)::int AS chunks_pending_projection,
        (SELECT count(*) FROM core.record_chunks WHERE projection_failed_at IS NOT NULL)::int AS chunks_projection_failed,
        (SELECT count(*) FROM core.chunk_projection_deletes WHERE projected_at IS NULL)::int AS chunks_pending_deletion,
        (SELECT count(*) FROM core.record_chunks)::int AS chunks_total,
        (SELECT count(DISTINCT embedding_model) FROM core.record_chunks WHERE embedding_model IS NOT NULL)::int AS distinct_models
    `)
    const status = rows[0]
    return {
      ...status,
      // More than one embedding model in the corpus means vectors from
      // different spaces are being compared, which silently degrades recall.
      mixedEmbeddingModels: status.distinct_models > 1,
    }
  }
}

export async function runEmbeddingLoop(pipeline, { idleDelayMs = 5_000, signal, logger = console }) {
  let backoffMs = idleDelayMs
  while (!signal?.aborted) {
    try {
      const result = await pipeline.runOnce()
      backoffMs = idleDelayMs
      if (result.idle) {
        await delay(idleDelayMs, signal)
      } else {
        logger?.log?.(
          `[embed] chunked=${result.chunked.chunks} embedded=${result.embedded.embedded} deleted=${result.deletions.projected} projected=${result.projected.projected}`,
        )
      }
    } catch (error) {
      backoffMs = Math.min(backoffMs * 2, 300_000)
      const reason = error instanceof ElasticsearchUnavailableError ? 'Elasticsearch unavailable' : error.message
      // Backs off further than the projector does: this loop can cost money per
      // attempt, so hammering a failing model provider is worse than lagging.
      logger?.warn?.(`[embed] cycle failed (${reason}); retrying in ${backoffMs}ms`)
      await delay(backoffMs, signal)
    }
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}
