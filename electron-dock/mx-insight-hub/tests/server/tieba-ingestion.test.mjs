import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTiebaSearchResult, normalizeTiebaIngestion, TIEBA_DATASET_ID, TIEBA_PLATFORM } from '../../server/ingest/tieba.mjs'
import { applyMapping } from '../../server/ingest/external/mapping.mjs'
import { CRAWLER_FIELD_MAP, crawlerSourceSpec } from '../../server/ingest/crawler/source-contract.mjs'
import { enrichCrawlerRecord } from '../../server/ingest/crawler/record.mjs'

const input = { query: '测试', maxResults: 2, page: 1, maxPages: 1 }
const options = { input, taskId: 31, runId: 42, capturedAt: new Date('2026-11-18T01:00:00Z') }
function thread(overrides = {}) {
  return { record_type: 'tieba.thread', source_id: '9007199254740999', source_url: 'https://tieba.baidu.com/p/9007199254740999',
    title: '真实帖子标题', text: '源搜索结果中的正文片段', author: { id: '9007199254740997', name: '发帖作者', cookies: 'private-secret' },
    published_at: '2026-11-18T08:01:02+08:00', metrics: { likes: 0, replies: 12, shares: 3, privateMetric: 'private-secret' },
    media: [{ type: 'image', url: 'https://tiebapic.baidu.com/forum/test.jpg', extra: 'private-secret' }],
    attributes: { query: '测试', page: 1, forum: '测试吧', forum_id: '1234', secret: 'private-secret' },
    raw: { secret: 'private-secret' }, ...overrides }
}
function native(items = [thread()], collection = {}) {
  return { items, cursor: null, metrics: { count: items.length, collection: {
    requested: input.maxResults, returned: items.length, complete: true, stop_reason: 'end_of_results', ...collection,
  } } }
}
const invalid = fn => assert.throws(fn, error => error.code === 'invalid_tieba_result')

test('Tieba query bounds use Unicode code points like the collection catalog', () => {
  const query = '𠀀'.repeat(200)
  const nativeResult = native([thread({ attributes: { query, page: 1 } })])
  const projected = projectTiebaSearchResult(nativeResult, { ...options, input: { ...input, query } })
  assert.equal(projected.itemCount, 1)
  assert.equal(normalizeTiebaIngestion(projected.ingestion).length, 1)
  const tooLong = `${query}𠀀`
  invalid(() => projectTiebaSearchResult(native([thread({ attributes: { query: tooLong, page: 1 } })]),
    { ...options, input: { ...input, query: tooLong } }))
  invalid(() => normalizeTiebaIngestion({ ...projected.ingestion, input: { ...input, query: tooLong } }))
})

test('Tieba search projects reviewed thread fields and retains exact opaque source IDs without public raw evidence', () => {
  const response = native()
  const projected = projectTiebaSearchResult(response, options)
  assert.equal(projected.dataStatus, 'success')
  assert.equal(projected.itemCount, 1)
  assert.deepEqual(projected.result.items[0], {
    id: '9007199254740999', contentType: 'tieba.thread', url: 'https://tieba.baidu.com/p/9007199254740999',
    title: '真实帖子标题', body: '源搜索结果中的正文片段', author: { id: '9007199254740997', name: '发帖作者' },
    forum: { id: '1234', name: '测试吧' }, metrics: { likes: 0, comments: 12, shares: 3 },
    media: { images: ['https://tiebapic.baidu.com/forum/test.jpg'] }, publishedAt: '2026-11-18T00:01:02.000Z',
  })
  assert.deepEqual(projected.result.completeness, { scope: 'request', complete: true, requested: 2, returned: 1, stopReason: 'end_of_results' })
  assert.doesNotMatch(JSON.stringify(projected.result), /private-secret|taskId|runId|cookies|"raw"|auth_used/)
  assert.deepEqual(projected.ingestion.items, response.items)
  response.items[0].title = 'mutated after projection'
  assert.equal(projected.ingestion.items[0].title, '真实帖子标题')
})

test('Tieba ingestion uses a separate product, preserves evidence and has stable content revisions across observations', () => {
  const projected = projectTiebaSearchResult(native(), options)
  const [record] = normalizeTiebaIngestion({ ...projected.ingestion, jobId: 'job-1', resultSha256: 'a'.repeat(64) })
  assert.equal(TIEBA_DATASET_ID, 'tieba.posts.v1')
  assert.equal(record.platform, TIEBA_PLATFORM)
  assert.equal(record.objectType, 'post')
  assert.equal(record.externalId, '9007199254740999')
  assert.equal(record.contentType, 'tieba.thread')
  assert.equal(record.authorExternalId, '9007199254740997')
  assert.deepEqual(record.stableFields.relations, { threadId: '9007199254740999' })
  assert.deepEqual(record.stableFields.forum, { id: '1234', name: '测试吧' })
  assert.deepEqual(record.metrics, { likes: 0, comments: 12, shares: 3 })
  assert.equal(record.eventTime.toISOString(), '2026-11-18T00:01:02.000Z')
  assert.equal(record.collectedAt.toISOString(), '2026-11-18T01:00:00.000Z')
  assert.deepEqual(record.extensions, {})
  assert.equal(record.rawItem.item.raw.secret, 'private-secret')
  assert.equal(record.rawItem.source.runId, 42)
  assert.doesNotMatch(JSON.stringify(record.stableFields), /private-secret|taskId|runId|"raw"/)
  const [again] = normalizeTiebaIngestion({ ...projected.ingestion, runId: 43, capturedAt: '2026-11-18T02:00:00Z' })
  assert.equal(again.externalId, record.externalId)
  assert.equal(again.payloadSha256, record.payloadSha256)
  assert.notEqual(again.rawPayloadSha256, record.rawPayloadSha256)
  const second = thread({ source_id: '123', source_url: 'https://tieba.baidu.com/p/123' })
  const reordered = normalizeTiebaIngestion({ ...projected.ingestion, items: [second, thread()] })[1]
  assert.equal(reordered.rank, 2)
  assert.equal(reordered.payloadSha256, record.payloadSha256)
  const changed = projectTiebaSearchResult(native([thread({ text: '新正文片段' })]), options)
  assert.notEqual(normalizeTiebaIngestion(changed.ingestion)[0].payloadSha256, record.payloadSha256)
})

test('Tieba rejects an entire malformed or cross-entity batch instead of silently skipping billable rows', () => {
  for (const overrides of [
    { record_type: 'tieba.user' }, { record_type: 'tieba.post' }, { record_type: 'tieba.comment' },
    { source_id: '0' }, { source_id: '01' }, { source_id: 9007199254740999 },
    { source_url: 'https://tieba.baidu.com/p/99' }, { source_url: 'https://tieba.baidu.com.evil.test/p/9007199254740999' },
    { source_url: 'https://user:password@tieba.baidu.com/p/9007199254740999' },
    { source_url: 'https://tieba.baidu.com/p/9007199254740999?token=secret' },
    { title: '', text: '  ' }, { quality_status: 'rejected' },
    { attributes: { query: 'different query', page: 1 } }, { attributes: { query: '测试', page: 2 } },
    { attributes: { query: '测试', page: 1, thread_id: '99' } }, { raw: { value: '\u0000' } },
  ]) invalid(() => projectTiebaSearchResult(native([thread(overrides)]), options))
  invalid(() => projectTiebaSearchResult(native([thread(), thread({ source_id: '123', source_url: 'https://tieba.baidu.com/p/123', record_type: 'tieba.user' })]), options))
  invalid(() => projectTiebaSearchResult(native([thread(), thread()]), options))
})

test('Tieba distinguishes request completeness, partial results and verified empty results without inventing a cursor', () => {
  const partial = projectTiebaSearchResult(native([thread()], { complete: false, stop_reason: 'page_limit' }), options)
  assert.equal(partial.dataStatus, 'partial')
  assert.equal(partial.result.completeness.complete, false)
  assert.equal(partial.result.cursor, undefined)
  assert.equal(projectTiebaSearchResult(native([]), options).dataStatus, 'no_data')
  assert.equal(projectTiebaSearchResult(native([], { complete: false, stop_reason: 'rate_limited' }), options).dataStatus, 'partial')
  assert.equal(projectTiebaSearchResult(native([thread()], { complete: false, stop_reason: 'private_token' }), options).result.completeness.stopReason, 'upstream_partial')
  for (const collection of [
    { returned: 2 }, { requested: 3 }, { complete: 'true' },
    { stop_reason: 'requested_limit' }, { complete: true, stop_reason: 'page_limit' },
    { complete: false, stop_reason: 'end_of_results' }, { stop_reason: 'secret URL https://example.test' },
  ]) invalid(() => projectTiebaSearchResult(native([thread()], collection), options))
})

test('Tieba bounds optional values and preserves unknown metrics as unknown rather than zero', () => {
  const { result, ingestion } = projectTiebaSearchResult(native([thread({
    metrics: { likes: '0', replies: Number.MAX_SAFE_INTEGER + 1, shares: -1 },
    author: { id: 'portrait:unverified', name: { private: true } }, published_at: '2026-11-18 08:00:00',
    media: [ { type: 'image', url: 'javascript:alert(1)' }, { type: 'image', url: 'http://127.0.0.1/private' },
      { type: 'image', url: 'https://tiebapic.baidu.com/image.jpg' }, { type: 'video', url: 'https://tiebapic.baidu.com/video.mp4' } ],
  })]), options)
  assert.deepEqual(result.items[0].metrics, { likes: 0, comments: null, shares: null })
  assert.deepEqual(result.items[0].author, { id: null, name: null })
  assert.equal(result.items[0].publishedAt, null)
  assert.deepEqual(result.items[0].media, { images: ['https://tiebapic.baidu.com/image.jpg'] })
  assert.deepEqual(normalizeTiebaIngestion(ingestion)[0].metrics, { likes: 0 })
})

test('Tieba queued payloads are revalidated and cannot masquerade as another product or source entity', () => {
  const { ingestion } = projectTiebaSearchResult(native(), options)
  invalid(() => normalizeTiebaIngestion({ ...ingestion, kind: 'other-result' }))
  invalid(() => normalizeTiebaIngestion({ ...ingestion, version: 2 }))
  invalid(() => normalizeTiebaIngestion({ ...ingestion, items: [thread({ record_type: 'tieba.user' })] }))
  invalid(() => normalizeTiebaIngestion({ ...ingestion, input: { ...input, query: 'forged query' } }))
  invalid(() => normalizeTiebaIngestion({ ...ingestion, runId: 0 }))
  invalid(() => projectTiebaSearchResult(native(), { ...options, capturedAt: new Date('invalid') }))
})

test('dedicated Tieba projection leaves old forum identities and news-only publication rules unchanged', () => {
  for (const [recordType, expected] of [['tieba.thread', 'internal'], ['tieba.user', 'internal'], ['tieba.post', 'internal'], ['tieba.comment', 'internal'], ['news.article', 'candidate']]) {
    const spec = crawlerSourceSpec('forum')
    const raw = { ...thread({ record_type: recordType }), record_key: 'historical-stable-key', source_type: 'forum',
      connector_id: 'tieba', first_seen_at: '2026-11-18T01:00:00Z' }
    const { record } = applyMapping(raw, CRAWLER_FIELD_MAP, { ...spec, source: spec })
    enrichCrawlerRecord(record, raw, spec)
    assert.equal(record.externalId, 'historical-stable-key')
    assert.equal(record.platform, 'data_center_saved_records_forum')
    assert.equal(record.stableFields.crawler.publication.eligibility, expected)
  }
})
