import { refreshMappedPayloadSha256 } from './external/mapping.mjs'

export const isSeparatedWeiboBody = (datasetId, platform, record) =>
  ['night-all.search.v1', 'night-all.compat.v1'].includes(datasetId) && platform === 'weibo'
  && record.objectType === 'post' && record.extensions?.weiboBody?.version === 'weibo-body.v1'

const time = value => Number.isFinite(new Date(value).getTime()) ? new Date(value).getTime() : 0

// Called under the canonical identity lock. Keep the acquired rawItem untouched:
// source revisions describe the observation; canonical revisions describe the
// separately selected summary and detail. Neither is a historical API replay.
export function retainWeiboFullText(record, current) {
  const next = structuredClone(record.extensions.weiboBody)
  record.extensions.weiboBody = next
  if (current && !record.deletedAt && !current.deleted_at
    && current.author_external_id === record.authorExternalId) {
    const old = current.extensions?.weiboBody
    const repaired = ['131_weibo_long_text_and_lcy_grants.sql', '136_weibo_emotion_full_text_repair.sql']
      .includes(current.extensions?.weiboLongTextRepair?.migration)
    const oldFull = old?.fullText || (current.extensions?.rawSearch?.bodyCompleteness === 'full_text' || repaired ? current.body : null)
    const oldEvidence = old?.provenance?.fullText || (oldFull ? {
      source: 'legacy_verified', field: 'body',
      capturedAt: current.extensions?.weiboLongTextRepair?.capturedAt || current.collected_at,
      revision: current.current_revision, payloadSha256: current.payload_sha256,
      postId: record.externalId, authorId: record.authorExternalId,
    } : null)
    if (oldFull && (!next.fullText || time(oldEvidence?.capturedAt) >= time(next.provenance?.fullText?.capturedAt))) {
      next.fullText = oldFull
      next.provenance.fullText = oldEvidence
      // A comparison describes its own detail receipt, not the retained body.
      delete next.provenance.comparison
    }
    if (old?.summary != null && time(old.provenance?.summary?.capturedAt) > time(next.provenance?.summary?.capturedAt)) {
      next.summary = old.summary
      next.provenance.summary = old.provenance.summary
      if (!next.fullText) record.extensions.rawSearch.bodyCompleteness = current.extensions.rawSearch.bodyCompleteness
    }
  }
  record.body = next.fullText || next.summary || null
  record.extensions.rawSearch.bodyCompleteness = next.fullText ? 'full_text' : record.extensions.rawSearch.bodyCompleteness
  record.extensions.body_completeness = record.extensions.rawSearch.bodyCompleteness
  // Remove duplicate observation fields from extensions; weiboBody is the
  // canonical source for these fields after independent freshness selection.
  delete record.extensions.summary
  delete record.extensions.body_provenance
  // Collection timestamps are observation metadata (as is collectedAt in the
  // generic mapper). Advance freshness without reindexing/re-embedding identical
  // content on every poll; immutable source revisions retain the exact capture.
  const hashRecord = { ...record, extensions: structuredClone(record.extensions) }
  delete hashRecord.payloadSha256
  delete hashRecord.extensions.weiboBody.provenance.summary?.capturedAt
  delete hashRecord.extensions.weiboBody.provenance.fullText?.capturedAt
  refreshMappedPayloadSha256(hashRecord)
  record.payloadSha256 = hashRecord.payloadSha256
  return { ...record.rawItem, summary: next.summary, text: record.body, content: record.body,
    full_text: next.fullText, body_provenance: next.provenance,
    body_completeness: record.extensions.rawSearch.bodyCompleteness }
}
