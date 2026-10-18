import { z } from 'zod'
import { AppError } from '../core/errors.mjs'
import { isPostgresSafeText } from '../core/postgres-json.mjs'
import { publicTelegramMonitorRecord, telegramStoredDatasetIds } from '../data/telegram-monitor.mjs'
import { withRetrievalSlot } from './search.mjs'

const CANDIDATE_LIMIT = 100
const TEXT_LIMIT = 12000
const SNIPPET_LIMIT = 1600
const TITLE_LIMIT = 500
const identifier = z.string().trim().min(1).max(256).refine(isPostgresSafeText)
const querySchema = z.object({
  query: z.string().trim().min(1).max(500).refine(isPostgresSafeText),
  sourceScope: z.enum(['monitor', 'sqlite', 'all']).default('all'),
  chatId: identifier.optional(),
  authorId: identifier.optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  topK: z.number().int().min(1).max(50).optional(),
  minSimilarity: z.number().min(-1).max(1).optional(),
}).strict()

function timestamp(value, field) {
  if (value === undefined) return null
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  const local = match && new Date(`${match[1]}Z`)
  const parsed = match && new Date(value)
  if (!match || !Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== match[1]
    || !Number.isFinite(parsed.getTime()) || parsed.getUTCFullYear() < 1 || parsed.getUTCFullYear() > 9999) {
    throw new AppError(400, 'invalid_request', `${field} must be a valid RFC3339 timestamp with at most six fractional digits`)
  }
  return `${parsed.toISOString().slice(0, 19)}.${(match[2] || '').padEnd(6, '0')}Z`
}

export function normalizeTelegramSemanticQuery(input, maxTopK = 50) {
  const parsed = querySchema.safeParse(input)
  if (!parsed.success) {
    throw new AppError(400, 'invalid_request', 'Telegram semantic search accepts only query, sourceScope, chatId, authorId, from, to, topK and minSimilarity with their documented types')
  }
  if (!Number.isInteger(maxTopK) || maxTopK < 1) {
    throw new AppError(500, 'semantic_policy_invalid', 'Telegram semantic search page policy is invalid')
  }
  const maximum = Math.min(50, maxTopK)
  const topK = parsed.data.topK ?? Math.min(20, maximum)
  if (topK > maximum) throw new AppError(400, 'page_size_exceeded', `topK must not exceed ${maximum}`)
  const from = timestamp(parsed.data.from, 'from')
  const to = timestamp(parsed.data.to, 'to')
  if (from && to && from > to) throw new AppError(400, 'invalid_request', 'from must not be later than to')
  return {
    query: parsed.data.query,
    sourceScope: parsed.data.sourceScope,
    chatId: parsed.data.chatId ?? null,
    authorId: parsed.data.authorId ?? null,
    from,
    to,
    topK,
    minSimilarity: parsed.data.minSimilarity ?? null,
  }
}

function candidate(hit, minSimilarity) {
  const source = hit?._source
  const recordId = source?.recordId
  const chunkKey = typeof hit?._id === 'string' && hit._id.length <= 512
    ? /^([^:]+):(\d+):(.+)$/.exec(hit._id) : null
  const revision = source?.sourceRevision
  if (!z.uuid().safeParse(recordId).success || !chunkKey || chunkKey[1] !== recordId
    || chunkKey[3] !== source.chunkerVersion || chunkKey[3].length > 200 || !isPostgresSafeText(chunkKey[3])
    || !Number.isSafeInteger(Number(chunkKey[2])) || Number(chunkKey[2]) > 2147483647
    || !Number.isInteger(revision) || revision < 1 || revision > 2147483647
    || typeof source.embeddingModel !== 'string' || source.embeddingModel.length > 512 || !isPostgresSafeText(source.embeddingModel)
    || typeof hit._score !== 'number' || !Number.isFinite(hit._score) || hit._score < 0 || hit._score > 1) return null
  const similarity = 2 * hit._score - 1
  if (minSimilarity !== null && similarity + 1e-6 < minSimilarity) return null
  return { record_id: recordId, chunk_index: Number(chunkKey[2]), chunker_version: source.chunkerVersion,
    source_revision: revision, embedding_model: source.embeddingModel, similarity }
}

function publicItem(row) {
  const item = publicTelegramMonitorRecord({ ...row, stable_fields: {
    relations: { chatId: row.chat_id }, attributes: { username: row.author_username },
  } })
  return {
    canonicalId: item.canonicalId,
    id: item.canonicalId,
    externalId: item.externalId,
    platform: 'telegram',
    objectType: 'message',
    contentType: item.contentType,
    datasetId: row.dataset_id,
    sourceScope: item.sourceScope,
    chatId: row.chat_id,
    title: item.title,
    titleTruncated: row.title_truncated === true,
    text: item.text,
    textTruncated: row.text_truncated === true,
    snippet: row.snippet,
    snippetTruncated: row.snippet_truncated === true,
    url: item.url,
    author: item.author,
    eventTime: row.event_time_cursor ?? item.eventTime,
    revision: Number(row.current_revision),
    semanticSimilarity: row.similarity,
  }
}

/** Bounded semantic candidates revalidated against current PostgreSQL evidence.
 * Authentication, authorization and customer metering belong to HubService.
 */
export class TelegramSemanticSearch {
  constructor({ pool, advancedSearch }) {
    this.pool = pool
    this.advancedSearch = advancedSearch
  }

  async run(query) {
    if (!this.pool || !this.advancedSearch?.search?.client || !this.advancedSearch?.search?.chunkIndexSet
      || typeof this.advancedSearch?.vector !== 'function') {
      throw new AppError(503, 'semantic_unavailable', 'Telegram semantic retrieval is not configured')
    }
    return withRetrievalSlot(this.pool, 'search', async () => {
      let result
      const datasets = telegramStoredDatasetIds(query.sourceScope, 'messages')
      try {
        result = await this.advancedSearch.vector({
          query: query.query, platform: 'telegram', datasetIds: datasets, objectType: 'message',
          account: query.authorId, minSimilarity: query.minSimilarity,
          // Chunk eventTime is ES date (milliseconds). Widen to that millisecond
          // before exact PostgreSQL comparison so precision loss cannot exclude
          // a boundary candidate. The six-digit bounds remain in query below.
          fromTime: query.from ? `${query.from.slice(0, 23)}Z` : null,
          toTime: query.to ? `${query.to.slice(0, 23)}Z` : null,
        })
      } catch (error) {
        if (error instanceof AppError && ['semantic_unavailable', 'semantic_timeout'].includes(error.code)) throw error
        throw new AppError(503, 'semantic_search_failed', 'Telegram semantic retrieval could not complete')
      }
      if (result?.timed_out || result?._shards?.failed || !Array.isArray(result?.hits?.hits)
        || typeof result.embeddingSpace !== 'string' || !result.embeddingSpace || result.embeddingSpace.length > 512
        || !isPostgresSafeText(result.embeddingSpace)) {
        throw new AppError(503, 'semantic_search_failed', 'Telegram semantic retrieval did not return complete candidates')
      }
      const hits = result.hits.hits.slice(0, CANDIDATE_LIMIT)
      const candidates = hits.map(hit => candidate(hit, query.minSimilarity)).filter(Boolean)
      const rows = candidates.length ? (await this.pool.query(
        `WITH candidates AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS candidate(
             record_id uuid, chunk_index integer, chunker_version text,
             source_revision integer, embedding_model text, similarity double precision)
         )
         SELECT record.id,record.dataset_id,record.external_id,record.content_type,
                record.author_external_id,record.author_name,record.event_time,record.current_revision,
                to_char(record.event_time AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS event_time_cursor,
                record.url,left(record.title,${TITLE_LIMIT}) AS title,
                coalesce(char_length(record.title)>${TITLE_LIMIT},false) AS title_truncated,
                left(record.body,${TEXT_LIMIT}) AS body,
                coalesce(char_length(record.body)>${TEXT_LIMIT},false) AS text_truncated,
                record.stable_fields #>> '{relations,chatId}' AS chat_id,
                coalesce(record.stable_fields #>> '{attributes,username}',record.stable_fields #>> '{author,handle}') AS author_username,
                left(chunk.content,${SNIPPET_LIMIT}) AS snippet,
                char_length(chunk.content)>${SNIPPET_LIMIT} AS snippet_truncated,
                candidate.similarity
           FROM candidates candidate
           JOIN core.record_chunks chunk ON chunk.record_id=candidate.record_id
             AND chunk.chunk_index=candidate.chunk_index AND chunk.chunker_version=candidate.chunker_version
             AND chunk.source_revision=candidate.source_revision AND chunk.embedding_model=candidate.embedding_model
           JOIN core.canonical_records record ON record.id=chunk.record_id
             AND record.current_revision=chunk.source_revision
          WHERE record.platform='telegram' AND record.object_type='message' AND record.deleted_at IS NULL
            AND record.dataset_id=ANY($2::text[])
            AND chunk.embedded_at IS NOT NULL AND chunk.vector IS NOT NULL
            AND substring(chunk.embedding_model FROM position(':' in chunk.embedding_model)+1)
                || ':' || cardinality(chunk.vector)::text = $3
            AND ($4::text IS NULL OR record.stable_fields #>> '{relations,chatId}'=$4)
            AND ($5::text IS NULL OR record.author_external_id=$5)
            AND ($6::timestamptz IS NULL OR record.event_time >= $6::timestamptz)
            AND ($7::timestamptz IS NULL OR record.event_time <= $7::timestamptz)
          ORDER BY candidate.similarity DESC,record.id,chunk.chunk_index`,
        [JSON.stringify(candidates), datasets, result.embeddingSpace, query.chatId, query.authorId, query.from, query.to],
      )).rows : []
      const unique = new Map()
      for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row)
      const items = [...unique.values()].slice(0, query.topK).map(publicItem)
      return {
        items,
        pageInfo: { paginationMode: 'top_k', returnedCount: items.length, topK: query.topK, nextCursor: null, cursorType: 'none' },
        retrieval: {
          mode: 'semantic', similarityMetric: 'cosine', similarityIsProbability: false,
          embeddingSpace: result.embeddingSpace, minSimilarity: query.minSimilarity,
          candidateLimit: CANDIDATE_LIMIT, numCandidates: 200,
          candidateChunks: hits.length, candidateLimitReached: result.hits.hits.length >= CANDIDATE_LIMIT,
          validatedChunks: rows.length, validatedRecords: unique.size,
          discardedCandidates: hits.length - rows.length,
          chatFilter: query.chatId ? 'post_filter_candidates' : 'not_requested',
          exhaustive: false, coverage: 'unknown', consistency: 'current-canonical-revalidated',
          textLimit: TEXT_LIMIT, snippetLimit: SNIPPET_LIMIT,
          warnings: [
            { code: 'semantic_coverage_unknown', message: 'Results cover only indexed vectors and bounded ANN candidates; vector coverage and corpus completeness are unknown.' },
            ...(query.chatId ? [{ code: 'semantic_chat_post_filter', message: 'chatId is checked after bounded vector recall because the chunk index has no chatId field; matching messages may be absent from the candidate set.' }] : []),
          ],
        },
      }
    })
  }
}
