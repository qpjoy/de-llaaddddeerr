// Standard analysis settings for MX indices.
//
// Chinese segmentation happens *before* Elasticsearch, in the projector, using
// HanLP (see src/segmenter). The index therefore only needs a whitespace
// tokenizer over already-segmented text. That choice is what keeps every MX
// cluster on the stock elasticsearch image: an in-cluster analyzer plugin (IK,
// HanLP-ES) would pin us to a custom image that must be rebuilt for every ES
// patch release and reinstalled before any node can restart.
//
// The tradeoff is real and worth stating: changing the segmenter changes the
// tokens, so it requires a reindex. That is acceptable because every MX search
// index is a rebuildable projection of PostgreSQL (ADR-0005), never a source of
// truth.

export const MX_ANALYSIS = Object.freeze({
  analyzer: {
    // Indexing analyzer for pre-segmented Chinese text. Input arrives as
    // "人工智能 智能体 教程"; whitespace keeps exactly the segmentation HanLP chose.
    mx_presegmented: {
      type: 'custom',
      tokenizer: 'whitespace',
      filter: ['lowercase'],
    },
    // Search-time twin. Kept separate so query-side filters can diverge from
    // index-side ones later without a reindex.
    mx_presegmented_search: {
      type: 'custom',
      tokenizer: 'whitespace',
      filter: ['lowercase'],
    },
    // Substring matching for short identifier-like fields (author names,
    // handles, titles in autocomplete). edge_ngram at index time + plain
    // keyword-ish lowercase at search time is the standard pairing: applying
    // the ngram filter to the query too would match on any shared prefix and
    // destroy precision.
    mx_edge_ngram: {
      type: 'custom',
      tokenizer: 'mx_char_tokenizer',
      filter: ['lowercase', 'mx_edge_ngram_filter'],
    },
    mx_edge_ngram_search: {
      type: 'custom',
      tokenizer: 'mx_char_tokenizer',
      filter: ['lowercase'],
    },
    // CJK bigrams give usable substring recall on raw (un-segmented) Chinese
    // without any plugin. Used as a companion field so a query still matches
    // when HanLP segmented a name differently than the user types it.
    mx_cjk_bigram: {
      type: 'custom',
      tokenizer: 'standard',
      filter: ['lowercase', 'cjk_bigram'],
    },
  },
  tokenizer: {
    // Single-token-per-character-run tokenizer: CJK has no spaces, so the
    // standard tokenizer would split a name into unusable unigrams before the
    // edge_ngram filter ever sees the whole string.
    mx_char_tokenizer: {
      type: 'keyword',
    },
  },
  filter: {
    mx_edge_ngram_filter: {
      type: 'edge_ngram',
      min_gram: 1,
      max_gram: 12,
    },
  },
})

/**
 * Multi-field definition for a human-facing name (author name, handle, entity
 * name). One source field answers four different query shapes:
 *
 *   authorName             -> pre-segmented full text, relevance ranking
 *   authorName.keyword     -> exact match, terms aggregation, sorting
 *   authorName.prefix      -> "type-ahead" / leading-substring match
 *   authorName.bigram      -> arbitrary substring match on raw CJK
 *
 * Query them together with a `multi_match` of type `best_fields`; do not reach
 * for `wildcard` or `fuzzy`, which cannot use the index and scan every term.
 */
export function nameField({ analyzer = 'mx_presegmented' } = {}) {
  return {
    type: 'text',
    analyzer,
    search_analyzer: `${analyzer}_search`,
    fields: {
      keyword: { type: 'keyword', ignore_above: 256 },
      prefix: {
        type: 'text',
        analyzer: 'mx_edge_ngram',
        search_analyzer: 'mx_edge_ngram_search',
      },
      bigram: { type: 'text', analyzer: 'mx_cjk_bigram' },
    },
  }
}

/**
 * Dense vector field for semantic retrieval.
 *
 * `index: true` + HNSW is required for kNN; without it the field is stored but
 * only usable through a script_score brute-force scan. `similarity: cosine`
 * matches the normalized embeddings every mainstream embedding API returns.
 */
export function vectorField(dimensions, { similarity = 'cosine', quantization = 'int8' } = {}) {
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error('vector dimensions must be a positive integer')
  }
  // Quantization is the difference between a corpus that fits in memory and one
  // that does not. HNSW graphs are searched from the page cache, so raw float32
  // vectors set a hard ceiling: 1M x 1024 dims x 4 bytes is ~4GB before any
  // index overhead. `int8_hnsw` cuts that ~4x with a small recall cost, and
  // `bbq_hnsw` ~32x for corpora large enough that the alternative is not
  // searching at all. Pass quantization: null to keep full precision.
  const type = quantization === null ? 'hnsw' : `${quantization}_hnsw`
  return {
    type: 'dense_vector',
    dims: dimensions,
    index: true,
    similarity,
    index_options: { type, m: 16, ef_construction: 100 },
  }
}
