import { defineIndexSet, nameField, vectorField } from '@qpjoy/mx-common/elasticsearch'

export const PRODUCT_ID = 'mx-insight-hub'

// Bump only for a mapping change Elasticsearch cannot apply in place (a changed
// field type, a changed analyzer on an existing field). Adding a field is
// additive and does not need a version bump.
export const CONTENT_SCHEMA_VERSION = 2
export const CHUNK_SCHEMA_VERSION = 1

/**
 * Customer-safe content projection.
 *
 * `dynamic: strict` is kept from the original design and is load-bearing: an
 * unmapped field is rejected at index time instead of being silently guessed,
 * so upstream drift shows up as a projector error with a name attached rather
 * than as a mapping explosion nobody notices until a cluster restart.
 *
 * Everything unmapped that upstream sends still reaches the index, but only
 * through `extensions`, which is `flattened` — one field in the mapping no
 * matter how many keys arrive.
 */
export function contentIndex({ numberOfReplicas = 0 } = {}) {
  const definition = defineIndexSet({
    productId: PRODUCT_ID,
    name: 'content',
    schemaVersion: CONTENT_SCHEMA_VERSION,
    numberOfReplicas,
    meta: { owner: 'mx-insight-hub', purpose: 'rebuildable customer-safe content search projection' },
    properties: {
      id: { type: 'keyword' },
      datasetId: { type: 'keyword' },
      dataVersion: { type: 'keyword' },
      schemaVersion: { type: 'keyword' },
      // Written as the document version so an out-of-order delivery cannot
      // overwrite newer content; see projector.mjs.
      projectionRevision: { type: 'long' },

      platform: { type: 'keyword' },
      objectType: { type: 'keyword' },
      contentType: { type: 'keyword' },
      externalId: { type: 'keyword' },
      url: { type: 'keyword' },

      // Raw title/body keep the standard analyzer for Latin text and exact
      // phrases; the *Hanlp twins carry the pre-segmented Chinese tokens that
      // `mx_presegmented` indexes verbatim. Querying both and taking the best
      // field is what makes mixed zh/en content searchable with one query.
      title: {
        type: 'text',
        fields: { keyword: { type: 'keyword', ignore_above: 256 } },
      },
      body: { type: 'text' },
      titleHanlp: { type: 'text', analyzer: 'mx_presegmented', search_analyzer: 'mx_presegmented_search' },
      bodyHanlp: { type: 'text', analyzer: 'mx_presegmented', search_analyzer: 'mx_presegmented_search' },

      // Author fields. The original template had none at all, which combined
      // with `dynamic: strict` meant any document carrying an author would have
      // been rejected outright.
      authorExternalId: { type: 'keyword' },
      authorName: nameField(),
      authorHandle: {
        type: 'keyword',
        fields: {
          prefix: { type: 'text', analyzer: 'mx_edge_ngram', search_analyzer: 'mx_edge_ngram_search' },
        },
      },
      authorAvatarUrl: { type: 'keyword', index: false },
      username: nameField(),
      chatId: { type: 'keyword' },
      messageId: { type: 'keyword' },

      tokens: { type: 'keyword', ignore_above: 256 },
      entityIds: { type: 'keyword' },
      tags: { type: 'keyword' },
      language: { type: 'keyword' },

      // Engagement counters, flattened into typed fields so they can be sorted,
      // ranged and aggregated. Kept as a nested object rather than top-level
      // names to leave room for platform-specific counters under `extensions`.
      metrics: {
        properties: {
          likes: { type: 'long' },
          comments: { type: 'long' },
          shares: { type: 'long' },
          views: { type: 'long' },
          bookmarks: { type: 'long' },
          members: { type: 'long' },
        },
      },
      mediaCount: { type: 'integer' },
      hasVideo: { type: 'boolean' },

      location: { type: 'geo_point', ignore_malformed: true },
      countryCode: { type: 'keyword' },
      admin1Code: { type: 'keyword' },
      admin2Code: { type: 'keyword' },

      eventTime: { type: 'date' },
      collectedAt: { type: 'date' },
      publishedAt: { type: 'date' },
      firstSeenAt: { type: 'date' },
      lastSeenAt: { type: 'date' },

      source: {
        properties: {
          connectorId: { type: 'keyword' },
          streamId: { type: 'keyword' },
          sourceKey: { type: 'keyword' },
          payloadSha256: { type: 'keyword' },
        },
      },
      extensions: { type: 'flattened' },
    },
  })
  // Content is a mutable current-state projection, not an append-only time
  // series. ILM rollover would allow the same `_id` to survive in several
  // backing indices, where an edit/delete against the write alias cannot remove
  // the older copy. Keep one schema-versioned concrete index instead.
  delete definition.settings['index.lifecycle.name']
  delete definition.settings['index.lifecycle.rollover_alias']
  definition.currentIndex = `${definition.writeAlias}-current`
  definition.bootstrapIndex = definition.currentIndex
  return definition
}

/**
 * Chunk + embedding projection for retrieval.
 *
 * Separate index, not extra fields on `content`, for three reasons: the unit of
 * retrieval is a chunk rather than a post; `dims` is fixed at mapping time and
 * therefore couples the index to one embedding model; and re-embedding with a
 * new model then becomes a schema-version bump on a small index instead of a
 * reindex of the whole corpus.
 *
 * Returns null when no embedding model is configured, so a deploy without one
 * simply does not create the index.
 */
export function chunkIndex({ dimensions, numberOfReplicas = 0 } = {}) {
  if (!dimensions) return null
  const definition = defineIndexSet({
    productId: PRODUCT_ID,
    name: 'chunk',
    schemaVersion: CHUNK_SCHEMA_VERSION,
    numberOfReplicas,
    meta: { owner: 'mx-insight-hub', purpose: 'retrieval chunks and embeddings', dimensions },
    properties: {
      id: { type: 'keyword' },
      recordId: { type: 'keyword' },
      chunkIndex: { type: 'integer' },
      datasetId: { type: 'keyword' },
      platform: { type: 'keyword' },
      externalId: { type: 'keyword' },
      url: { type: 'keyword' },
      title: { type: 'text' },
      // Both raw and segmented text are indexed so hybrid retrieval can score
      // BM25 and kNN over the same chunk and fuse the two rankings.
      content: { type: 'text' },
      contentHanlp: { type: 'text', analyzer: 'mx_presegmented', search_analyzer: 'mx_presegmented_search' },
      embedding: vectorField(dimensions),
      embeddingModel: { type: 'keyword' },
      embeddingVersion: { type: 'integer' },
      chunkerVersion: { type: 'keyword' },
      sourceRevision: { type: 'long' },
      eventTime: { type: 'date' },
      createdAt: { type: 'date' },
    },
  })
  // Chunks are also mutable current state: edits can replace or shorten their
  // set, and a deleted record must disappear from retrieval. Keep one concrete
  // index so an old ILM backing cannot retain an otherwise invisible copy.
  delete definition.settings['index.lifecycle.name']
  delete definition.settings['index.lifecycle.rollover_alias']
  definition.currentIndex = `${definition.writeAlias}-current`
  definition.bootstrapIndex = definition.currentIndex
  return definition
}
