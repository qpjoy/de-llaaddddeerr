import { toPresegmentedText } from '@qpjoy/mx-common/segmenter'
import { ElasticsearchUnavailableError } from '@qpjoy/mx-common/elasticsearch'
import { AppError } from '../core/errors.mjs'

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

function clampSize(size) {
  return Math.min(Math.max(Number(size) || DEFAULT_SIZE, 1), MAX_SIZE)
}

/**
 * Fuzzy author-name lookup.
 *
 * Deliberately avoids `fuzzy` and `wildcard`. Both scan the term dictionary and
 * degrade with corpus size; neither handles Chinese, where the useful notion of
 * "similar" is a shared substring rather than an edit distance. Instead this
 * fans out over the four sub-fields built in mx-common's `nameField`:
 *
 *   authorName          segmented tokens   "美丽的 AI 搬运工" matches "搬运工"
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
        { match: { authorName: { query: toPresegmentedText(tokens), boost: 3 } } },
        { match: { 'authorName.bigram': { query: term, boost: 2 } } },
        { match_phrase: { 'authorHandle.prefix': { query: term, boost: 4 } } },
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

  /**
   * Search authors by partial name.
   *
   * `mode` in the response is part of the contract, not a debug field: a caller
   * that gets `postgres` knows results are substring-exact and unranked, and can
   * decide whether that is good enough rather than silently trusting a degraded
   * ordering.
   */
  async searchAuthors(term, { platform = null, size = DEFAULT_SIZE } = {}) {
    const limit = clampSize(size)
    if (!this.client) return this.#searchAuthorsPostgres(term, { platform, limit })
    try {
      const tokens = await this.segmenter.segment(term)
      const response = await this.client.search(this.indexSet.readAlias, {
        size: 0,
        query: {
          bool: {
            must: [authorNameQuery(term, tokens)],
            ...(platform ? { filter: [{ term: { platform } }] } : {}),
          },
        },
        aggs: {
          authors: {
            terms: { field: 'authorExternalId', size: limit, order: { relevance: 'desc' } },
            aggs: {
              relevance: { max: { script: { source: '_score' } } },
              name: { top_hits: { size: 1, _source: ['authorName', 'authorExternalId', 'platform', 'authorAvatarUrl'] } },
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
        return this.#searchAuthorsPostgres(term, { platform, limit })
      }
      throw error
    }
  }

  // Trigram similarity ranking. `%` uses the pg_trgm similarity threshold and is
  // index-backed by canonical_records_author_name_trgm_idx; ILIKE alone would be
  // too, but similarity gives an ordering rather than an arbitrary one.
  async #searchAuthorsPostgres(term, { platform, limit }) {
    const { rows } = await this.pool.query(
      `SELECT author_external_id,
              max(author_name) AS author_name,
              max(platform) AS platform,
              count(*)::int AS post_count,
              max(similarity(author_name, $1)) AS score
         FROM core.canonical_records
        WHERE author_name IS NOT NULL
          AND author_external_id IS NOT NULL
          AND (author_name ILIKE '%' || $1 || '%' OR author_name % $1)
          AND ($2::text IS NULL OR platform = $2)
        GROUP BY author_external_id
        ORDER BY score DESC NULLS LAST, post_count DESC
        LIMIT $3`,
      [term, platform, limit],
    )
    return {
      mode: 'postgres',
      authors: rows.map((row) => ({
        authorExternalId: row.author_external_id,
        authorName: row.author_name,
        platform: row.platform,
        avatarUrl: null,
        postCount: row.post_count,
        score: row.score,
      })),
    }
  }

  /**
   * Full-text content search over the projection.
   *
   * Queries the raw and pre-segmented fields together: `best_fields` takes the
   * single strongest match rather than summing, so a document is not rewarded
   * merely for having the term in both the raw and segmented copy of the same
   * text.
   */
  async searchContent(query, { platform = null, authorExternalId = null, size = DEFAULT_SIZE, from = 0 } = {}) {
    const limit = clampSize(size)
    if (!this.client) return this.#searchContentPostgres(query, { platform, authorExternalId, limit })
    try {
      const tokens = await this.segmenter.segment(query)
      const segmented = toPresegmentedText(tokens)
      const filter = [
        ...(platform ? [{ term: { platform } }] : []),
        ...(authorExternalId ? [{ term: { authorExternalId } }] : []),
      ]
      const response = await this.client.search(this.indexSet.readAlias, {
        size: limit,
        from,
        query: {
          bool: {
            should: [
              { multi_match: { query, fields: ['title^3', 'body'], type: 'best_fields' } },
              { multi_match: { query: segmented, fields: ['titleHanlp^3', 'bodyHanlp'], type: 'best_fields' } },
            ],
            minimum_should_match: 1,
            ...(filter.length ? { filter } : {}),
          },
        },
        highlight: { fields: { title: {}, body: {}, titleHanlp: {}, bodyHanlp: {} } },
        _source: { excludes: ['titleHanlp', 'bodyHanlp', 'tokens'] },
      })
      return {
        mode: 'elasticsearch',
        total: response.hits?.total?.value ?? 0,
        items: (response.hits?.hits || []).map((hit) => ({
          ...hit._source,
          score: hit._score,
          highlight: hit.highlight ?? null,
        })),
      }
    } catch (error) {
      if (error instanceof ElasticsearchUnavailableError) {
        this.logger?.warn?.('[search] Elasticsearch unavailable; falling back to PostgreSQL content search')
        return this.#searchContentPostgres(query, { platform, authorExternalId, limit })
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
            { match: { content: { query } } },
            { match: { contentHanlp: { query: toPresegmentedText(tokens) } } },
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

  async #searchContentPostgres(query, { platform, authorExternalId, limit }) {
    const { rows } = await this.pool.query(
      `SELECT id, platform, external_id, url, title, body, author_external_id, author_name,
              event_time, collected_at, stable_fields
         FROM core.canonical_records
        WHERE (title ILIKE '%' || $1 || '%' OR body ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR platform = $2)
          AND ($3::text IS NULL OR author_external_id = $3)
        ORDER BY event_time DESC NULLS LAST
        LIMIT $4`,
      [query, platform, authorExternalId, limit],
    )
    return {
      mode: 'postgres',
      total: rows.length,
      items: rows.map((row) => ({
        id: row.id,
        platform: row.platform,
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
      })),
    }
  }
}
