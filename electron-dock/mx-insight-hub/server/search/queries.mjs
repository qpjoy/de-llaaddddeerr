import { toPresegmentedText } from '@qpjoy/mx-common/segmenter'
import { ElasticsearchError, ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { AppError } from '../core/errors.mjs'
import {
  buildContentSearchPlan,
  DEFAULT_SEARCH_PROFILE,
  knownMatchBranches,
  postgresSearchProfile,
  publicSearchProfile,
  resolveSearchProfile,
  searchCapabilities as profileSearchCapabilities,
  searchProfileNeedsSegmentation,
  searchProfileRequiredIndexSchema,
} from './profiles.mjs'

// Read-side queries, with an explicit PostgreSQL degradation path.
//
// Every function here answers the same question twice: once against
// Elasticsearch (rich, ranked) and once against PostgreSQL (exact, narrower).
// The PG path is not a stub -- migration 006 builds the trigram indexes that
// make it a real plan -- because ADR-0005 promises the API keeps serving when
// the search cluster is down, and a promise with no query behind it is a bug
// waiting for an outage.

const DEFAULT_SIZE = 20
const MAX_SIZE = 100
const SEARCH_PIT_KEEP_ALIVE = '2m'
const SEARCH_EXECUTION_TOKEN_LIMIT = 64
const SEARCH_DEGRADED_TOKEN_BYTE_LIMIT = 512
const SEARCH_DEGRADED_TOKEN_SCAN_LIMIT = 256
const SEARCH_ANALYSIS_STATE_TOKEN_LIMIT = 512
const SEARCH_ANALYSIS_STATE_CHARACTER_LIMIT = 2_048
const SEARCH_ANALYSIS_STATE_VERSION = 1
const SEARCH_BACKENDS = new Set(['hanlp', 'jieba', 'bigram'])
const SEGMENTATION_DEGRADED_PROFILE = 'canonical.phrase.v1'
export const SEARCH_SORTS = Object.freeze(['relevance', 'newest', 'oldest'])

/**
 * Build a total ordering for a search page.
 *
 * Relevance stays available because it is the right default for a question like
 * "where is this phrase", but a reviewer scanning a corpus usually wants time
 * order, and mixing the two silently -- ranking by score while the column header
 * says 时间 -- reads as unsorted data rather than as ranked data.
 */
function sortClause(sort) {
  const time = (order) => ({ eventTime: { order, missing: '_last', format: 'strict_date_time' } })
  if (sort === 'newest') return [time('desc'), { id: { order: 'desc' } }]
  if (sort === 'oldest') return [time('asc'), { id: { order: 'asc' } }]
  return [{ _score: { order: 'desc' } }, time('desc'), { id: { order: 'desc' } }]
}

function clampSize(size) {
  return Math.min(Math.max(Number(size) || DEFAULT_SIZE, 1), MAX_SIZE)
}

function normalizeOffset(offset) {
  if (offset == null) return null
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new AppError(400, 'invalid_search_offset', 'Search offset must be a non-negative integer')
  }
  return offset
}

function wildcardSubstring(term) {
  return `*${String(term).replace(/[\\*?]/g, '\\$&')}*`
}

function boundedQueryAnalysis(metadata, tokens, {
  tokenCount = null,
  truncated = false,
} = {}) {
  const safeTokens = (Array.isArray(tokens) ? tokens : [])
    .filter((token) => typeof token === 'string' && token.trim())
    .map((token) => token.trim())
  const observedTokenCount = Number.isSafeInteger(tokenCount) && tokenCount >= safeTokens.length
    ? tokenCount
    : safeTokens.length
  return {
    tokens: safeTokens.slice(0, SEARCH_EXECUTION_TOKEN_LIMIT),
    tokenCount: observedTokenCount,
    truncated: Boolean(truncated || observedTokenCount > SEARCH_EXECUTION_TOKEN_LIMIT),
    backendUsed: SEARCH_BACKENDS.has(metadata?.backendUsed) ? metadata.backendUsed : null,
    degraded: Boolean(metadata?.degraded),
    errorCode: typeof metadata?.errorCode === 'string' && metadata.errorCode.length <= 64
      ? metadata.errorCode
      : null,
  }
}

function utf8Prefix(value, byteLimit) {
  let bytes = 0
  let prefix = ''
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (bytes + characterBytes > byteLimit) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}

// Degraded tokenizer output is evidence only: the phrase fallback never uses
// it to build the Elasticsearch query. Keep a small, UTF-8-safe sample
// for diagnostics and the signed cursor instead of rejecting the search when
// an unhealthy backend returns an unexpectedly large token list.
function boundedDegradedTokenEvidence(value) {
  const source = Array.isArray(value) ? value : []
  const tokens = []
  let remainingBytes = SEARCH_DEGRADED_TOKEN_BYTE_LIMIT
  let clipped = false
  const scanLimit = Math.min(source.length, SEARCH_DEGRADED_TOKEN_SCAN_LIMIT)
  for (let index = 0; index < scanLimit; index += 1) {
    if (tokens.length >= SEARCH_EXECUTION_TOKEN_LIMIT || remainingBytes <= 0) break
    const token = source[index]
    if (typeof token !== 'string' || !token.trim()) continue
    const normalized = token.trim()
    const prefix = utf8Prefix(normalized, remainingBytes)
    if (!prefix) {
      clipped = true
      break
    }
    tokens.push(prefix)
    remainingBytes -= Buffer.byteLength(prefix, 'utf8')
    if (prefix !== normalized) {
      clipped = true
      break
    }
  }
  return {
    tokens,
    tokenCount: source.length,
    truncated: clipped || tokens.length < source.length,
  }
}

function analysisTokens(value, { cursor = false } = {}) {
  const invalid = () => {
    throw new AppError(
      cursor ? 400 : 503,
      cursor ? 'invalid_cursor' : 'search_analysis_unavailable',
      cursor
        ? 'Search cursor analysis state is invalid; restart from the first page'
        : 'The selected search profile produced invalid query terms',
    )
  }
  if (!Array.isArray(value) || value.length > SEARCH_ANALYSIS_STATE_TOKEN_LIMIT) invalid()
  const tokens = []
  let characterCount = 0
  for (const token of value) {
    if (typeof token !== 'string') invalid()
    const normalized = token.trim()
    if (!normalized || [...normalized].length > 512) invalid()
    characterCount += [...normalized].length
    if (characterCount > SEARCH_ANALYSIS_STATE_CHARACTER_LIMIT) invalid()
    tokens.push(normalized)
  }
  return tokens
}

function analysisState({ appliedProfile, tokens, queryAnalysis }) {
  return {
    v: SEARCH_ANALYSIS_STATE_VERSION,
    appliedProfile: appliedProfile.id,
    tokens: [...tokens],
    backendUsed: queryAnalysis.backendUsed,
    degraded: queryAnalysis.degraded,
    errorCode: queryAnalysis.errorCode,
  }
}

function invalidCursorAnalysis(message = 'Search cursor analysis state is invalid; restart from the first page') {
  return new AppError(400, 'invalid_cursor', message)
}

function restoreAnalysisState(value, requestedProfile) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.v !== SEARCH_ANALYSIS_STATE_VERSION || typeof value.degraded !== 'boolean') {
    throw invalidCursorAnalysis()
  }
  if (value.backendUsed !== null && !SEARCH_BACKENDS.has(value.backendUsed)) {
    throw invalidCursorAnalysis()
  }
  if (value.errorCode !== null && (
    typeof value.errorCode !== 'string' || !value.errorCode || value.errorCode.length > 64
  )) {
    throw invalidCursorAnalysis()
  }
  if (!searchProfileNeedsSegmentation(requestedProfile) && (
    value.tokens?.length > 0 || value.backendUsed !== null || value.degraded || value.errorCode !== null
  )) {
    throw invalidCursorAnalysis()
  }
  let appliedProfile
  try {
    appliedProfile = resolveSearchProfile(value.appliedProfile, { audience: 'admin' })
  } catch {
    throw invalidCursorAnalysis()
  }
  const tokens = analysisTokens(value.tokens, { cursor: true })
  const queryAnalysis = boundedQueryAnalysis({
    backendUsed: value.backendUsed,
    degraded: value.degraded,
    errorCode: value.errorCode,
  }, tokens)
  const expectedAppliedProfile = searchProfileNeedsSegmentation(requestedProfile) && value.degraded
    ? resolveSearchProfile(SEGMENTATION_DEGRADED_PROFILE, { audience: 'admin' })
    : requestedProfile
  if (appliedProfile.id !== expectedAppliedProfile.id) {
    throw invalidCursorAnalysis('Search cursor profile state is invalid; restart from the first page')
  }
  return { appliedProfile, tokens, queryAnalysis }
}

function activeContentIndexSchema(readAlias, aliasResponse) {
  const escaped = String(readAlias).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matcher = new RegExp(`^${escaped}-v(\\d+)(?:-|$)`)
  const versions = [...new Set(Object.keys(aliasResponse || {}).flatMap((index) => {
    const match = matcher.exec(index)
    return match ? [Number(match[1])] : []
  }))]
  if (versions.length === 0) return null
  if (versions.length > 1) return 'mixed'
  return `content-v${versions[0]}`
}

function matchedQueryNames(hit) {
  if (Array.isArray(hit?.matched_queries)) return hit.matched_queries
  if (hit?.matched_queries && typeof hit.matched_queries === 'object') {
    return Object.keys(hit.matched_queries)
  }
  return []
}

function safeMatchEvidence(hit, allowedBranches) {
  return [...new Set(matchedQueryNames(hit)
    .filter((name) => typeof name === 'string' && allowedBranches.has(name)))]
    .sort()
}

function degradedSegmentationWarning(queryAnalysis) {
  const backend = queryAnalysis.backendUsed || 'an unverified fallback tokenizer'
  const reason = queryAnalysis.errorCode ? ` (${queryAnalysis.errorCode})` : ''
  return `Query segmentation degraded to ${backend}${reason}; ${SEGMENTATION_DEGRADED_PROFILE} was applied so fallback tokens are not compared with pre-segmented fields built under different tokenizer provenance.`
}

function searchExecution({
  requestedProfile,
  appliedProfile,
  queryAnalysis,
  matchedBranches = [],
  warning = undefined,
}) {
  const applied = publicSearchProfile(appliedProfile)
  return {
    requestedProfile: requestedProfile.id,
    appliedProfile: appliedProfile.id,
    profile: applied,
    queryAnalysis,
    matchedBranches: [...new Set(matchedBranches)].sort(),
    warning: warning === undefined ? (applied?.warning ?? null) : warning,
  }
}

/**
 * Fuzzy author-name lookup.
 *
 * Deliberately avoids `fuzzy` and avoids wildcard queries on ordinary keyword
 * fields. The dedicated `wildcard` field below is ngram-backed by Elasticsearch
 * for identifier substring lookup; Chinese names additionally use bigrams and
 * pre-segmented text.
 *
 *   authorNameHanlp     segmented tokens   "美丽的 AI 搬运工" matches "搬运工"
 *   authorName.prefix   edge ngrams        "美丽" matches from the first character
 *   authorName.bigram   CJK bigrams        "丽的AI" matches mid-string
 *   authorName.keyword  exact              highest weight, ranks exact matches first
 */
export function authorNameQuery(term, tokens) {
  return {
    bool: {
      should: [
        { term: { 'authorName.keyword': { value: term, boost: 10 } } },
        { match_phrase: { 'authorName.prefix': { query: term, boost: 5 } } },
        { match: { authorNameHanlp: { query: toPresegmentedText(tokens), operator: 'and', boost: 3 } } },
        { match: { 'authorName.bigram': { query: term, operator: 'and', boost: 2 } } },
        { match_phrase: { 'authorHandle.prefix': { query: term, boost: 4 } } },
        { match: { 'authorHandle.bigram': { query: term, operator: 'and', boost: 3 } } },
        { wildcard: { authorHandleSubstring: { value: wildcardSubstring(term), case_insensitive: true, boost: 3 } } },
      ],
      minimum_should_match: 1,
    },
  }
}

/**
 * Reciprocal Rank Fusion: score = sum over lists of 1 / (k + rank).
 *
 * Uses only the rank a document achieved in each list, never its raw score.
 * That is what makes it safe to combine BM25 (unbounded, corpus-dependent) with
 * cosine similarity ([-1, 1]) without a weighting that has to be re-tuned as
 * the corpus grows.
 */
export function reciprocalRankFusion(lists, { k = 60 } = {}) {
  const scores = new Map()
  const names = ['lexical', 'vector']
  for (const [listIndex, list] of lists.entries()) {
    for (const [rank, hit] of list.entries()) {
      const key = hit._id
      const existing = scores.get(key) || { hit, score: 0, retrievers: [] }
      existing.score += 1 / (k + rank + 1)
      existing.retrievers.push(names[listIndex] ?? `list${listIndex}`)
      // Keep whichever copy has a populated _source; a knn hit and a lexical hit
      // for the same document carry the same fields, but only one is retained.
      if (!existing.hit?._source && hit._source) existing.hit = hit
      scores.set(key, existing)
    }
  }
  return [...scores.values()].sort((left, right) => right.score - left.score)
}

export class SearchQueries {
  constructor({ pool, client, segmenter, indexSet, chunkIndexSet = null, logger = console }) {
    this.pool = pool
    this.client = client
    this.segmenter = segmenter
    this.indexSet = indexSet
    this.chunkIndexSet = chunkIndexSet
    this.logger = logger
  }

  get available() {
    return Boolean(this.client)
  }

  async searchCapabilities({ audience = 'admin' } = {}) {
    let activeIndexSchema = null
    let readinessError = null
    try {
      activeIndexSchema = await this.#activeContentIndexSchema()
    } catch (error) {
      readinessError = 'search_projection_unavailable'
      this.logger?.warn?.(`[search] unable to inspect content read alias: ${error.message}`)
    }
    return {
      ...profileSearchCapabilities({ audience, activeIndexSchema }),
      readinessError,
    }
  }

  async #activeContentIndexSchema() {
    if (!this.client) return null
    if (typeof this.client.getAlias !== 'function') return null
    try {
      const aliases = await this.client.getAlias(this.indexSet.readAlias)
      return activeContentIndexSchema(this.indexSet.readAlias, aliases)
    } catch (error) {
      if (error?.status === 404) return null
      throw error
    }
  }

  async #assertProfileIndexReady(profile) {
    const requiredIndexSchema = searchProfileRequiredIndexSchema(profile)
    if (!requiredIndexSchema) return
    const activeIndexSchema = await this.#activeContentIndexSchema()
    if (activeIndexSchema !== requiredIndexSchema) {
      throw new AppError(
        503,
        'search_profile_unavailable',
        `Search profile ${profile.id} requires ${requiredIndexSchema}, but the active read index is ${activeIndexSchema || 'not ready'}`,
        { searchProfile: profile.id, requiredIndexSchema, activeIndexSchema },
      )
    }
  }

  /**
   * Search authors by partial name.
   *
   * `mode` in the response is part of the contract, not a debug field: a caller
   * that gets `postgres` knows results are substring-exact and unranked, and can
   * decide whether that is good enough rather than silently trusting a degraded
   * ordering.
   */
  async searchAuthors(term, {
    platform = null,
    datasetId = null,
    objectType = null,
    size = DEFAULT_SIZE,
  } = {}) {
    const limit = clampSize(size)
    if (!this.client) return this.#searchAuthorsPostgres(term, { platform, datasetId, objectType, limit })
    try {
      const tokens = await this.segmenter.segment(term)
      const response = await this.client.search(this.indexSet.readAlias, {
        size: 0,
        query: {
          bool: {
            must: [authorNameQuery(term, tokens)],
            ...((platform || datasetId || objectType) ? {
              filter: [
                ...(platform ? [{ term: { platform } }] : []),
                ...(datasetId ? [{ term: { datasetId } }] : []),
                ...(objectType ? [{ term: { objectType } }] : []),
              ],
            } : {}),
          },
        },
        aggs: {
          authors: {
            terms: { field: 'authorExternalId', size: limit, order: { relevance: 'desc' } },
            aggs: {
              relevance: { max: { script: { source: '_score' } } },
              name: {
                top_hits: {
                  size: 1,
                  _source: ['authorName', 'authorHandle', 'authorExternalId', 'platform', 'authorAvatarUrl'],
                },
              },
              posts: { value_count: { field: 'id' } },
            },
          },
        },
      })
      const buckets = response.aggregations?.authors?.buckets || []
      return {
        mode: 'elasticsearch',
        authors: buckets.map((bucket) => {
          const source = bucket.name?.hits?.hits?.[0]?._source || {}
          return {
            authorExternalId: bucket.key,
                authorName: source.authorName ?? null,
                username: source.authorHandle ?? null,
            platform: source.platform ?? null,
            avatarUrl: source.authorAvatarUrl ?? null,
            postCount: bucket.posts?.value ?? bucket.doc_count,
            score: bucket.relevance?.value ?? null,
          }
        }),
      }
    } catch (error) {
      if (error instanceof ElasticsearchUnavailableError) {
        this.logger?.warn?.('[search] Elasticsearch unavailable; falling back to PostgreSQL author search')
        return this.#searchAuthorsPostgres(term, { platform, datasetId, objectType, limit })
      }
      throw error
    }
  }

  // Trigram similarity ranking. `%` uses the pg_trgm similarity threshold and is
  // index-backed by canonical_records_author_name_trgm_idx; ILIKE alone would be
  // too, but similarity gives an ordering rather than an arbitrary one.
  async #searchAuthorsPostgres(term, { platform, datasetId, objectType, limit }) {
    const { rows } = await this.pool.query(
      `SELECT author_external_id,
              max(author_name) AS author_name,
              max(stable_fields #>> '{author,handle}') AS username,
              max(platform) AS platform,
              count(*)::int AS post_count,
              greatest(
                max(similarity(coalesce(author_name, ''), $1)),
                max(similarity(coalesce(stable_fields #>> '{author,handle}', ''), $1))
              ) AS score
         FROM core.canonical_records
        WHERE deleted_at IS NULL
          AND author_external_id IS NOT NULL
          AND (
            author_name ILIKE '%' || $1 || '%'
            OR author_name % $1
            OR (stable_fields #>> '{author,handle}') ILIKE '%' || $1 || '%'
            OR (stable_fields #>> '{author,handle}') % $1
          )
          AND ($2::text IS NULL OR platform = $2)
          AND ($3::text IS NULL OR dataset_id = $3)
          AND ($4::text IS NULL OR object_type = $4)
        GROUP BY author_external_id
        ORDER BY score DESC NULLS LAST, post_count DESC
        LIMIT $5`,
      [term, platform, datasetId, objectType, limit],
    )
    return {
      mode: 'postgres',
      authors: rows.map((row) => ({
        authorExternalId: row.author_external_id,
        authorName: row.author_name,
        username: row.username,
        platform: row.platform,
        avatarUrl: null,
        postCount: row.post_count,
        score: row.score,
      })),
    }
  }

  /** Telegram chat title/username lookup with the same ES -> PG degradation contract. */
  async searchTelegramChats(term, { datasetId = 'telegram.monitor.chats.v1', size = DEFAULT_SIZE } = {}) {
    const limit = clampSize(size)
    if (!this.client) return this.#searchTelegramChatsPostgres(term, { datasetId, limit })
    try {
      const tokens = await this.segmenter.segment(term)
      const response = await this.client.search(this.indexSet.readAlias, {
        size: limit,
        query: {
          bool: {
            filter: [
              { term: { platform: 'telegram' } },
              { term: { datasetId } },
              { term: { objectType: 'chat' } },
            ],
            should: [
              { term: { externalId: { value: term, boost: 12 } } },
              { term: { 'username.keyword': { value: term, boost: 10 } } },
              { match_phrase: { 'username.prefix': { query: term, boost: 6 } } },
              // Prefix matching misses a Chinese substring that starts after
              // the first character (for example 文频 in 中文频道).
              { match: { 'username.bigram': { query: term, operator: 'and', boost: 5 } } },
              { match: { usernameHanlp: { query: toPresegmentedText(tokens), operator: 'and', boost: 4 } } },
              { wildcard: { usernameSubstring: { value: wildcardSubstring(term), case_insensitive: true, boost: 4 } } },
              { match_phrase: { 'title.keyword': { query: term, boost: 8 } } },
              { match_phrase: { title: { query: term, boost: 3 } } },
            ],
            minimum_should_match: 1,
          },
        },
        _source: ['externalId', 'title', 'username', 'url', 'metrics', 'eventTime', 'collectedAt'],
      })
      return {
        mode: 'elasticsearch',
        chats: (response.hits?.hits || []).map((hit) => ({
          id: hit._source?.externalId,
          title: hit._source?.title ?? null,
          username: hit._source?.username ?? null,
          url: hit._source?.url ?? null,
          memberCount: hit._source?.metrics?.members ?? null,
          eventTime: hit._source?.eventTime ?? null,
          collectedAt: hit._source?.collectedAt ?? null,
          score: hit._score ?? null,
        })),
      }
    } catch (error) {
      if (error instanceof ElasticsearchUnavailableError) {
        this.logger?.warn?.('[search] Elasticsearch unavailable; falling back to PostgreSQL Telegram chat search')
        return this.#searchTelegramChatsPostgres(term, { datasetId, limit })
      }
      throw error
    }
  }

  async #searchTelegramChatsPostgres(term, { datasetId, limit }) {
    const { rows } = await this.pool.query(
      `SELECT external_id, title, url, event_time, collected_at, stable_fields,
              greatest(
                similarity(coalesce(title, ''), $1),
                similarity(coalesce(stable_fields #>> '{attributes,username}', ''), $1)
              ) AS score
         FROM core.canonical_records
        WHERE deleted_at IS NULL
          AND dataset_id = $2
          AND platform = 'telegram'
          AND object_type = 'chat'
          AND (
            external_id = $1
            OR title ILIKE '%' || $1 || '%'
            OR title % $1
            OR (stable_fields #>> '{attributes,username}') ILIKE '%' || $1 || '%'
            OR (stable_fields #>> '{attributes,username}') % $1
          )
        ORDER BY (external_id = $1) DESC, score DESC NULLS LAST, title
        LIMIT $3`,
      [term, datasetId, limit],
    )
    return {
      mode: 'postgres',
      chats: rows.map((row) => ({
        id: row.external_id,
        title: row.title,
        username: row.stable_fields?.attributes?.username ?? null,
        url: row.url,
        memberCount: row.stable_fields?.metrics?.members ?? null,
        eventTime: row.event_time,
        collectedAt: row.collected_at,
        score: row.score,
      })),
    }
  }

  /**
   * Full-text content search over the projection.
   *
   * Queries raw text as a phrase and pre-segmented text as an AND conjunction.
   * The two branches are alternatives: an exact source substring survives a
   * tokenizer-version change, while order-insensitive word matches retain
   * recall without admitting a document that shares only one CJK character.
   */
  async searchContent(query, {
    platform = null,
    platforms = null,
    datasetId = null,
    datasetIds = null,
    objectType = null,
    authorExternalId = null,
    chatId = null,
    fromTime = null,
    toTime = null,
    size = DEFAULT_SIZE,
    cursor = null,
    offset = null,
    searchProfile = null,
    strictRelevance = undefined,
    trackTotalHits = false,
    sort = 'relevance',
  } = {}) {
    const limit = clampSize(size)
    const normalizedOffset = normalizeOffset(offset)
    // `strictRelevance:false` was an internal diagnostic switch before named
    // profiles existed. Keep that exact behaviour available to old callers,
    // while every omitted/true call resolves to the stable public default.
    const requestedProfile = resolveSearchProfile(
      searchProfile ?? (strictRelevance === false ? 'canonical.legacy-or.v1' : DEFAULT_SEARCH_PROFILE),
      { audience: 'admin' },
    )
    if (cursor && normalizedOffset != null) {
      throw new AppError(400, 'incompatible_search_pagination', 'Search cursor and offset cannot be used together')
    }
    if (!this.client && cursor?.mode === 'elasticsearch') {
      throw new AppError(503, 'search_cursor_unavailable', 'Elasticsearch is unavailable; retry the same cursor later')
    }
    if (!this.client || cursor?.mode === 'postgres') {
      return this.#searchContentPostgres(query, {
        platform, platforms, datasetId, datasetIds, objectType, authorExternalId, chatId,
        fromTime, toTime, limit, cursor, offset: normalizedOffset,
        includeTotal: trackTotalHits || normalizedOffset != null,
        requestedProfile,
      })
    }
    let pitId = cursor?.pitId ?? null
    try {
      if (!pitId) await this.#assertProfileIndexReady(requestedProfile)
      const restoredAnalysis = restoreAnalysisState(cursor?.analysisState, requestedProfile)
      let segmentMetadata = null
      let tokens = []
      let queryAnalysis = null
      let appliedProfile = requestedProfile
      if (restoredAnalysis) {
        tokens = restoredAnalysis.tokens
        queryAnalysis = restoredAnalysis.queryAnalysis
        appliedProfile = restoredAnalysis.appliedProfile
      } else if (searchProfileNeedsSegmentation(requestedProfile)) {
        if (typeof this.segmenter.segmentWithMeta === 'function') {
          segmentMetadata = await this.segmenter.segmentWithMeta(query)
          if (segmentMetadata?.degraded) {
            const evidence = boundedDegradedTokenEvidence(segmentMetadata?.tokens)
            tokens = evidence.tokens
            queryAnalysis = boundedQueryAnalysis(segmentMetadata, tokens, evidence)
          } else {
            tokens = analysisTokens(segmentMetadata?.tokens || [])
          }
        } else {
          tokens = analysisTokens(await this.segmenter.segment(query))
        }
      }
      queryAnalysis ??= boundedQueryAnalysis(segmentMetadata, tokens)
      const segmentationDegraded = searchProfileNeedsSegmentation(requestedProfile)
        && queryAnalysis.degraded
      if (!restoredAnalysis && segmentationDegraded) {
        appliedProfile = resolveSearchProfile(SEGMENTATION_DEGRADED_PROFILE, { audience: 'admin' })
      }
      const executionWarning = segmentationDegraded
        ? degradedSegmentationWarning(queryAnalysis)
        : undefined
      const cursorAnalysisState = analysisState({ appliedProfile, tokens, queryAnalysis })
      const segmented = toPresegmentedText(tokens)
      const plan = buildContentSearchPlan({ profile: appliedProfile, query, segmented })
      if (!pitId) {
        const opened = await this.client.request(
          'POST',
          `/${encodeURIComponent(this.indexSet.readAlias)}/_pit?keep_alive=${SEARCH_PIT_KEEP_ALIVE}`,
        )
        pitId = opened?.id
        if (!pitId) throw new Error('Elasticsearch did not return a point-in-time id')
      }
      const filter = [
        ...(platform ? [{ term: { platform } }] : []),
        ...(Array.isArray(platforms) && platforms.length > 0 ? [{ terms: { platform: platforms } }] : []),
        ...(datasetId ? [{ term: { datasetId } }] : []),
        ...(Array.isArray(datasetIds) && datasetIds.length > 0 ? [{ terms: { datasetId: datasetIds } }] : []),
        ...(objectType ? [{ term: { objectType } }] : []),
        ...(authorExternalId ? [{ term: { authorExternalId } }] : []),
        ...(chatId ? [{ term: { chatId } }] : []),
        ...((fromTime || toTime) ? [{
          range: {
            eventTime: {
              ...(fromTime ? { gte: fromTime } : {}),
              ...(toTime ? { lte: toTime } : {}),
            },
          },
        }] : []),
      ]
      const response = await this.client.request('POST', '/_search', {
        size: normalizedOffset == null ? limit + 1 : limit,
        ...((trackTotalHits || normalizedOffset != null) ? { track_total_hits: true } : {}),
        pit: { id: pitId, keep_alive: SEARCH_PIT_KEEP_ALIVE },
        ...(cursor?.searchAfter ? { search_after: cursor.searchAfter } : {}),
        ...(normalizedOffset != null ? { from: normalizedOffset } : {}),
        track_scores: true,
        // `id` always terminates the sort so every ordering is total: a tie on
        // score or on timestamp must still page deterministically, or
        // search_after silently skips or repeats rows across pages.
        sort: sortClause(sort),
        query: {
          bool: {
            should: plan.should,
            minimum_should_match: 1,
            ...(filter.length ? { filter } : {}),
          },
        },
        highlight: {
          fields: {
            title: {}, body: {}, chatUsername: {}, titleHanlp: {}, bodyHanlp: {}, chatUsernameHanlp: {},
          },
        },
        _source: { excludes: ['titleHanlp', 'bodyHanlp', 'chatUsernameHanlp', 'tokens'] },
      })
      const hits = response.hits?.hits || []
      const total = response.hits?.total?.value ?? 0
      const pageHits = hits.slice(0, limit)
      const allowedBranches = knownMatchBranches(appliedProfile)
      const evidence = pageHits.map((hit) => safeMatchEvidence(hit, allowedBranches))
      const hasMore = normalizedOffset == null
        ? hits.length > limit
        : normalizedOffset + pageHits.length < total
      const currentPitId = response.pit_id ?? pitId
      // Offset pages do not hand the PIT back to the caller, so always close
      // their one-request snapshot instead of leaking it until the TTL.
      if (normalizedOffset != null || !hasMore) await this.#closeSearchPit(currentPitId)
      return {
        mode: 'elasticsearch',
        total,
        totalRelation: response.hits?.total?.relation ?? 'eq',
        hasMore,
        nextCursor: hasMore && normalizedOffset == null ? {
          mode: 'elasticsearch',
          pitId: currentPitId,
          searchAfter: pageHits.at(-1)?.sort,
          analysisState: cursorAnalysisState,
        } : null,
        searchExecution: searchExecution({
          requestedProfile,
          appliedProfile,
          queryAnalysis,
          matchedBranches: evidence.flat(),
          warning: executionWarning,
        }),
        items: pageHits.map((hit, index) => ({
          ...hit._source,
          score: hit._score,
          highlight: hit.highlight ?? null,
          matchEvidence: evidence[index],
        })),
      }
    } catch (error) {
      if (cursor?.mode === 'elasticsearch') {
        if (isExpiredSearchPit(error)) {
          throw new AppError(410, 'search_cursor_expired', 'The search cursor expired; restart from the first page')
        }
        if (error instanceof ElasticsearchUnavailableError) {
          throw new AppError(503, 'search_cursor_unavailable', 'Elasticsearch is unavailable; retry the same cursor later')
        }
        throw error
      }
      if (error instanceof ElasticsearchUnavailableError) {
        this.logger?.warn?.('[search] Elasticsearch unavailable; falling back to PostgreSQL content search')
        return this.#searchContentPostgres(query, {
          platform, platforms, datasetId, datasetIds, objectType, authorExternalId, chatId,
          fromTime, toTime, limit, cursor: null, offset: normalizedOffset,
          includeTotal: trackTotalHits || normalizedOffset != null,
          requestedProfile,
        })
      }
      throw error
    }
  }

  /**
   * Hybrid retrieval over chunks: BM25 and kNN, fused with Reciprocal Rank
   * Fusion.
   *
   * RRF rather than a weighted score blend because BM25 scores and cosine
   * similarities are not on a comparable scale — BM25 is unbounded and corpus
   * dependent, cosine is [-1, 1] — so any fixed weighting silently favours one
   * retriever as the corpus grows. RRF uses only the RANK from each list, which
   * needs no tuning and cannot drift.
   *
   * The constant k=60 is the standard damping term: it flattens the difference
   * between ranks 1 and 2 enough that a document found by both retrievers
   * outranks one found first by only one of them, which is the whole point of
   * fusing.
   */
  async semanticSearch(query, { platform = null, datasetId = null, size = 10, embed, k = 60 } = {}) {
    if (!this.client || !this.chunkIndexSet) {
      throw new AppError(503, 'semantic_search_unavailable', 'The chunk index is not configured')
    }
    const filter = [
      ...(platform ? [{ term: { platform } }] : []),
      ...(datasetId ? [{ term: { datasetId } }] : []),
    ]
    const candidateSize = Math.max(size * 4, 40)

    const tokens = await this.segmenter.segment(query)
    // Both retrievers run over a wider candidate set than the caller asked for:
    // fusion can only promote a document that at least one list returned, so
    // truncating each list to `size` before fusing defeats the purpose.
    const lexicalPromise = this.client.search(this.chunkIndexSet.readAlias, {
      size: candidateSize,
      query: {
        bool: {
          should: [
            { match: { content: { query, operator: 'and' } } },
            { match: { contentHanlp: { query: toPresegmentedText(tokens), operator: 'and' } } },
          ],
          minimum_should_match: 1,
          ...(filter.length ? { filter } : {}),
        },
      },
      _source: { excludes: ['embedding', 'contentHanlp'] },
    })

    let vectorPromise = Promise.resolve(null)
    if (embed) {
      const { vectors } = await embed([query])
      vectorPromise = this.client.search(this.chunkIndexSet.readAlias, {
        size: candidateSize,
        knn: {
          field: 'embedding',
          query_vector: vectors[0],
          k: candidateSize,
          // Explore more candidates than requested so recall does not collapse
          // on a filtered search, where many nearest neighbours are excluded.
          num_candidates: Math.max(candidateSize * 4, 100),
          ...(filter.length ? { filter } : {}),
        },
        _source: { excludes: ['embedding', 'contentHanlp'] },
      })
    }

    const [lexical, vector] = await Promise.all([lexicalPromise, vectorPromise])
    const fused = reciprocalRankFusion(
      [lexical?.hits?.hits ?? [], vector?.hits?.hits ?? []],
      { k },
    )

    return {
      mode: vector ? 'hybrid' : 'lexical-only',
      // Says plainly when only half the retrieval ran, rather than returning
      // degraded results that look complete.
      degraded: !vector ? 'no embedding provider; vector recall is unavailable' : null,
      items: fused.slice(0, size).map((entry) => ({
        ...entry.hit._source,
        rrfScore: Math.round(entry.score * 10_000) / 10_000,
        retrievers: entry.retrievers,
      })),
    }
  }

  async #searchContentPostgres(query, {
    platform,
    platforms,
    datasetId,
    datasetIds,
    objectType,
    authorExternalId,
    chatId,
    fromTime,
    toTime,
    limit,
    cursor,
    offset,
    includeTotal,
    requestedProfile,
  }) {
    const { rows } = await this.pool.query(
      `WITH matching AS (
         SELECT id, dataset_id, platform, object_type, external_id, url, title, body,
                author_external_id, author_name,
                event_time, collected_at, stable_fields
                ${includeTotal ? ', count(*) OVER () AS total_count' : ''}
           FROM core.canonical_records
          WHERE deleted_at IS NULL
            AND (
              title ILIKE '%' || $1 || '%'
              OR body ILIKE '%' || $1 || '%'
              OR (stable_fields #>> '{attributes,chatUsername}') ILIKE '%' || $1 || '%'
            )
            AND ($2::text IS NULL OR platform = $2)
            AND ($3::text IS NULL OR dataset_id = $3)
            AND ($4::text[] IS NULL OR dataset_id = ANY($4::text[]))
            AND ($5::text IS NULL OR object_type = $5)
            AND ($6::text IS NULL OR author_external_id = $6)
            AND ($7::text IS NULL OR (stable_fields #>> '{relations,chatId}') = $7)
            AND ($8::timestamptz IS NULL OR event_time >= $8::timestamptz)
            AND ($9::timestamptz IS NULL OR event_time <= $9::timestamptz)
            AND ($12::text[] IS NULL OR platform = ANY($12::text[]))
       )
       SELECT *
         FROM matching
        WHERE (
            $10::uuid IS NULL
            OR (
              $11::timestamptz IS NULL
              AND event_time IS NULL
              AND id < $10::uuid
            )
            OR (
              $11::timestamptz IS NOT NULL
              AND (
                event_time IS NULL
                OR event_time < $11::timestamptz
                OR (event_time = $11::timestamptz AND id < $10::uuid)
              )
            )
          )
        ORDER BY event_time DESC NULLS LAST, id DESC
        LIMIT $13
        ${offset != null ? 'OFFSET $14' : ''}`,
      [
        query, platform, datasetId, datasetIds, objectType, authorExternalId, chatId,
        fromTime, toTime, cursor?.searchAfter?.[1] ?? null, cursor?.searchAfter?.[0] ?? null,
        Array.isArray(platforms) && platforms.length > 0 ? platforms : null,
        offset == null ? limit + 1 : limit,
        ...(offset != null ? [offset] : []),
      ],
    )
    let exactTotal = null
    if (includeTotal) {
      exactTotal = rows.length > 0
        ? Number(rows[0].total_count)
        : await this.#countContentPostgres(query, {
            platform, platforms, datasetId, datasetIds, objectType,
            authorExternalId, chatId, fromTime, toTime,
          })
    }
    const pageRows = rows.slice(0, limit)
    const hasMore = offset == null
      ? rows.length > limit
      : offset + pageRows.length < exactTotal
    const last = pageRows.at(-1)
    const appliedProfile = postgresSearchProfile()
    return {
      mode: 'postgres',
      ...(includeTotal ? {
        total: exactTotal,
        totalRelation: 'eq',
      } : {}),
      hasMore,
      nextCursor: hasMore && offset == null ? {
        mode: 'postgres',
        pitId: null,
        searchAfter: [last.event_time ? new Date(last.event_time).toISOString() : null, last.id],
      } : null,
      searchExecution: searchExecution({
        requestedProfile,
        appliedProfile,
        queryAnalysis: boundedQueryAnalysis({
          backendUsed: null,
          degraded: true,
          errorCode: 'search_projection_degraded',
        }, []),
        matchedBranches: pageRows.length > 0 ? ['postgres_substring'] : [],
      }),
      items: pageRows.map((row) => ({
        id: row.id,
        datasetId: row.dataset_id,
        platform: row.platform,
        objectType: row.object_type,
        externalId: row.external_id,
        url: row.url,
        title: row.title,
        body: row.body,
        authorExternalId: row.author_external_id,
        authorName: row.author_name,
        eventTime: row.event_time,
        collectedAt: row.collected_at,
        metrics: row.stable_fields?.metrics ?? {},
        score: null,
        highlight: null,
        matchEvidence: ['postgres_substring'],
      })),
    }
  }

  async #countContentPostgres(query, {
    platform,
    platforms,
    datasetId,
    datasetIds,
    objectType,
    authorExternalId,
    chatId,
    fromTime,
    toTime,
  }) {
    const { rows } = await this.pool.query(
      `SELECT count(*)::bigint AS total_count
         FROM core.canonical_records
        WHERE deleted_at IS NULL
          AND (
            title ILIKE '%' || $1 || '%'
            OR body ILIKE '%' || $1 || '%'
            OR (stable_fields #>> '{attributes,chatUsername}') ILIKE '%' || $1 || '%'
          )
          AND ($2::text IS NULL OR platform = $2)
          AND ($3::text IS NULL OR dataset_id = $3)
          AND ($4::text[] IS NULL OR dataset_id = ANY($4::text[]))
          AND ($5::text IS NULL OR object_type = $5)
          AND ($6::text IS NULL OR author_external_id = $6)
          AND ($7::text IS NULL OR (stable_fields #>> '{relations,chatId}') = $7)
          AND ($8::timestamptz IS NULL OR event_time >= $8::timestamptz)
          AND ($9::timestamptz IS NULL OR event_time <= $9::timestamptz)
          AND ($10::text[] IS NULL OR platform = ANY($10::text[]))`,
      [
        query, platform, datasetId, datasetIds, objectType, authorExternalId,
        chatId, fromTime, toTime,
        Array.isArray(platforms) && platforms.length > 0 ? platforms : null,
      ],
    )
    return Number(rows[0]?.total_count ?? 0)
  }

  async #closeSearchPit(pitId) {
    if (!pitId) return
    try {
      await this.client.request('DELETE', '/_pit', { id: pitId })
    } catch (error) {
      this.logger?.warn?.({ error }, '[search] failed to close completed Elasticsearch PIT; TTL will reclaim it')
    }
  }
}

function isExpiredSearchPit(error) {
  if (!(error instanceof ElasticsearchError)) return false
  const detail = JSON.stringify(error.body || {})
  return error.status === 404 || /search_context_missing_exception|no search context found/i.test(detail)
}
