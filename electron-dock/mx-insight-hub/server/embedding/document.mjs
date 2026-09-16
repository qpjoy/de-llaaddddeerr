import { toPresegmentedText } from '@qpjoy/mx-common/segmenter'

/** Build the strict-mapping Elasticsearch document for one embedded chunk. */
export function buildChunkDocument(row, { tokens, createdAt }) {
  return {
    id: row.id,
    recordId: row.record_id,
    chunkIndex: row.chunk_index,
    datasetId: row.dataset_id,
    platform: row.platform,
    objectType: row.object_type ?? null,
    contentType: row.content_type ?? null,
    accountId: (['user','account','profile'].includes(row.object_type) ? row.external_id : row.author_external_id) ?? null,
    tags: Array.isArray(row.stable_fields?.tags) ? row.stable_fields.tags.filter((v) => typeof v === 'string' && v.length <= 200) : [],
    externalId: row.external_id,
    url: row.url,
    title: row.title,
    content: row.content,
    contentHanlp: toPresegmentedText(tokens),
    embedding: row.vector,
    embeddingModel: row.embedding_model,
    embeddingSpace: row.embedding_model ? `${row.embedding_model.slice(row.embedding_model.indexOf(':') + 1)}:${row.vector?.length}` : null,
    embeddingVersion: row.embedding_version,
    chunkerVersion: row.chunker_version,
    sourceRevision: Number(row.source_revision),
    eventTime: row.event_time,
    createdAt,
  }
}
