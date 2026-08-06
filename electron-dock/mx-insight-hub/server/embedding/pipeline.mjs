import { randomUUID } from 'node:crypto'
import { toPresegmentedText } from '@qpjoy/mx-common/segmenter'
import { ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { CHUNKER_VERSION, chunkRecord } from './chunker.mjs'

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
    return Boolean(this.chunkIndexSet && this.agent?.embeddings?.available)
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
      'SELECT * FROM core.records_needing_chunks ORDER BY id LIMIT $1',
      [limit],
    )
    if (rows.length === 0) return { records: 0, chunks: 0, removed: 0 }

    let chunkCount = 0
    let removed = 0
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const record of rows) {
        const chunks = chunkRecord(record)

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
          await client.query(
            `INSERT INTO core.record_chunks
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
               projected_at = NULL`,
            [
              randomUUID(), record.id, chunk.chunkIndex, chunk.content,
              chunk.tokenCount, chunk.chunkerVersion, chunk.sourceRevision,
            ],
          )
          chunkCount += 1
        }
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }

    return { records: rows.length, chunks: chunkCount, removed }
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
      `SELECT id, content FROM core.record_chunks
        WHERE embedded_at IS NULL
        ORDER BY created_at
        LIMIT $1`,
      [limit],
    )
    if (rows.length === 0) return { embedded: 0 }

    const result = await this.agent.embed(rows.map((row) => row.content))
    const model = `${result.provider}:${result.model}`

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const [index, row] of rows.entries()) {
        await client.query(
          `UPDATE core.record_chunks
              SET embedding_model = $2, embedding_version = 1, embedded_at = now(),
                  vector = $3::real[]
            WHERE id = $1`,
          [row.id, model, result.vectors[index]],
        )
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
    return { embedded: rows.length, model, provider: result.provider }
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
              c.embedding_model, c.embedding_version, c.vector,
              r.dataset_id, r.platform, r.external_id, r.url, r.title, r.event_time
         FROM core.record_chunks c
         JOIN core.canonical_records r ON r.id = c.record_id
        WHERE c.embedded_at IS NOT NULL AND c.projected_at IS NULL
        ORDER BY c.embedded_at
        LIMIT $1`,
      [limit],
    )
    if (rows.length === 0) return { projected: 0 }

    const operations = []
    for (const row of rows) {
      const tokens = await this.segmenter.segment(row.content)
      operations.push({
        index: {
          _index: this.chunkIndexSet.writeAlias,
          _id: `${row.record_id}:${row.chunk_index}:${row.chunker_version}`,
        },
      })
      operations.push({
        id: row.id,
        recordId: row.record_id,
        chunkIndex: row.chunk_index,
        datasetId: row.dataset_id,
        platform: row.platform,
        externalId: row.external_id,
        url: row.url,
        title: row.title,
        content: row.content,
        contentHanlp: toPresegmentedText(tokens),
        embedding: row.vector,
        embeddingModel: row.embedding_model,
        embeddingVersion: row.embedding_version,
        chunkerVersion: row.chunker_version,
        eventTime: row.event_time,
        createdAt: new Date().toISOString(),
      })
    }

    const response = await this.client.bulk(operations)
    const projected = []
    const failed = []
    for (const [index, item] of (response.items || []).entries()) {
      const action = item.index || {}
      if (action.error) failed.push({ id: rows[index].id, error: JSON.stringify(action.error).slice(0, 500) })
      else projected.push(rows[index].id)
    }

    if (projected.length > 0) {
      await this.pool.query(
        'UPDATE core.record_chunks SET projected_at = now() WHERE id = ANY($1::uuid[])',
        [projected],
      )
    }
    if (failed.length > 0) {
      // Left unmarked so the next pass retries them. The vector is already paid
      // for and stored, so a retry costs only the indexing call.
      this.logger?.error?.(`[embed] ${failed.length} chunk(s) rejected by Elasticsearch: ${failed[0].error}`)
    }
    return { projected: projected.length, failed: failed.length }
  }

  /** One full cycle. Returns counts so a caller can decide whether to idle. */
  async runOnce() {
    const chunked = await this.materializeChunks()
    const embedded = await this.embedPending()
    const projected = await this.projectPending()
    return { chunked, embedded, projected, idle: chunked.records === 0 && embedded.embedded === 0 && projected.projected === 0 }
  }

  async status() {
    const { rows } = await this.pool.query(`
      SELECT
        (SELECT count(*) FROM core.records_needing_chunks)::int AS records_pending_chunks,
        (SELECT count(*) FROM core.record_chunks WHERE embedded_at IS NULL)::int AS chunks_pending_embedding,
        (SELECT count(*) FROM core.record_chunks WHERE embedded_at IS NOT NULL AND projected_at IS NULL)::int AS chunks_pending_projection,
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
          `[embed] chunked=${result.chunked.chunks} embedded=${result.embedded.embedded} projected=${result.projected.projected}`,
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
