import { toPresegmentedText } from '@qpjoy/mx-common/segmenter'

/** Build the strict-mapping Elasticsearch document for one embedded chunk. */
export function buildChunkDocument(row, { tokens, createdAt }) {
  return {
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
    sourceRevision: Number(row.source_revision),
    eventTime: row.event_time,
    createdAt,
  }
}
