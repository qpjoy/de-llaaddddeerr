import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { projectPostCommentPage } from '../../server/contracts/post-comment-projection.mjs'
import { parseTikHubTwitterCommentPage } from '../../server/contracts/twitter-comment-page.mjs'
import { canonicalJson } from '../../server/ingest/normalizers.mjs'

const capturedAt = '2026-11-02T08:00:00.000Z'
const rootId = '2117082385997250001', targetReplyId = '2117082385997250767'
const replyId = '2117082385997250768', authorId = '2117082385997000001'
// Synthetic values follow the observed empty and 36-entry TikHub shapes. No
// private scalar values from either production archive are retained here.
const comment = (overrides = {}) => ({ id: replyId, conversation_id: rootId,
  text: '  完整正文😀\n第二行  ', display_text: 'different display representation',
  created_at: 'Mon Nov 02 07:00:00 +0000 2026', status: 'observed-status',
  likes: 0, replies: 2, retweets: 3, bookmarks: 4, quotes: 5, views: '1234',
  author: { rest_id: authorId, name: '作者', screen_name: 'fixture_author',
    description: null, unknown_avatar_field: 'https://example.invalid/avatar.png' },
  media: { unknown_media_list: [{ id: 'private-media', url: 'https://example.invalid/media.jpg' }] },
  ...overrides })
const envelope = (overrides = {}) => ({ code: 200, data: { id: rootId, conversation_id: rootId,
  text: 'Original post, never a comment', author: { rest_id: authorId, name: '原作者' },
  replies: 36, thread: [comment()], cursor: 'opaque+/==next', ...overrides } })
const step = ({ postId = rootId, includeRaw = false, continuation = null, provider = 'tikhub' } = {}) => ({
  provider, postComments: { request: { platform: 'twitter', postId, includeRaw }, continuation },
})
const project = (payload = envelope(), options = {}) => projectPostCommentPage(payload, step(options), { capturedAt })

test('TikHub thread maps observed comment fields and preserves complete text and restricted raw data', () => {
  const raw = comment()
  const result = project(envelope({ thread: [{ id: rootId }, raw] }))
  const row = result.projected.acquiredItems[0], record = result.records[0]
  assert.equal(result.projected.acquiredItems.length, 1)
  assert.equal(row.commentId, replyId)
  assert.equal(row.content_id, replyId)
  assert.equal(row.contentId, rootId)
  assert.equal(row.postId, rootId)
  assert.equal(row.conversationId, rootId)
  assert.equal(row.text, raw.text)
  assert.equal(row.full_text, raw.text)
  assert.equal(row.publishedAt, '2026-11-02T07:00:00.000Z')
  assert.equal(row.publishedTime, raw.created_at)
  assert.equal(row.author.id, authorId)
  assert.equal(row.author.name, '作者')
  assert.equal(row.author.handle, 'fixture_author')
  assert.equal(row.author.avatarUrl, null)
  assert.deepEqual(row.metrics, { likes: 0, replies: 2, shares: 3, views: 1234, bookmarks: 4, quotes: 5 })
  assert.equal(row.url, `https://x.com/i/status/${replyId}`)
  assert.equal(row.parentCommentId, null)
  assert.equal(row.parentExternalId, null)
  assert.equal(row.parentRelationship, 'unknown')
  assert.equal(row.repliesIncluded, null)
  assert.equal(Object.hasOwn(row, 'media'), false)
  assert.equal(Object.hasOwn(row, 'raw'), false)
  assert.equal(record.body, raw.text)
  assert.equal(record.objectType, 'comment')
  assert.equal(record.stableFields.connectorId, 'external-platform:tikhub')
  assert.equal(record.stableFields.attributes.parentExternalId, null)
  assert.equal(record.stableFields.attributes.parentRelationship, 'unknown')
  assert.equal(record.stableFields.attributes.conversationId, rootId)
  assert.deepEqual(record.rawItem, raw)
  assert.equal(record.rawPayloadSha256, createHash('sha256').update(canonicalJson(raw)).digest('hex'))
  const withRaw = project(envelope({ thread: [raw] }), { includeRaw: true }).projected.acquiredItems[0]
  assert.deepEqual(withRaw.raw, raw)
  withRaw.raw.author.name = 'changed-copy'
  assert.equal(raw.author.name, '作者')
})

test('a sampled 36-entry thread projects all paid rows rather than the three diagnostic samples', () => {
  const thread = Array.from({ length: 36 }, (_, index) => comment({ id: String(BigInt(replyId) + BigInt(index)) }))
  const result = project(envelope({ thread }))
  assert.equal(result.projected.acquiredItems.length, 36)
  assert.equal(result.records.length, 36)
  assert.equal(result.projected.acquiredItems.at(-1).commentId, thread.at(-1).id)
  assert.deepEqual(result.projected.providerPage, { hasMore: null, nextParams: { cursor: 'opaque+/==next' }, nextPage: null })
})

test('the observed empty reply-target shape remains empty despite its root object and nonempty cursor', () => {
  const result = project(envelope({ id: targetReplyId, replies: 0, thread: [] }), { postId: targetReplyId })
  assert.deepEqual(result.projected.acquiredItems, [])
  assert.deepEqual(result.records, [])
  assert.deepEqual(result.projected.providerPage, { hasMore: null, nextParams: { cursor: 'opaque+/==next' }, nextPage: null })
})

test('reply-target comments use the returned conversation identity without inventing their immediate parent', () => {
  const payload = envelope({ id: targetReplyId, thread: [{ id: targetReplyId }, { id: rootId }, comment()] })
  const result = project(payload, { postId: targetReplyId })
  assert.equal(result.projected.acquiredItems.length, 1)
  const row = result.projected.acquiredItems[0]
  assert.equal(row.postId, targetReplyId)
  assert.equal(row.conversationId, rootId)
  assert.equal(row.parentExternalId, null)
  assert.equal(row.parentCommentId, null)
  assert.throws(() => project(envelope({ id: targetReplyId,
    thread: [comment({ conversation_id: targetReplyId })] }), { postId: targetReplyId }), { code: 'invalid_upstream_contract' })
})

test('cursor absence, empty values and repetition cannot claim exhausted or trigger automatic continuation', () => {
  const withoutCursor = envelope(); delete withoutCursor.data.cursor
  for (const [payload, options] of [
    [withoutCursor, {}], [envelope({ cursor: null }), {}], [envelope({ cursor: '' }), {}],
    [envelope(), { continuation: { cursor: 'opaque+/==next' } }],
    [envelope({ thread: [], replies: 0 }), { continuation: { cursor: 'opaque+/==next' } }],
  ]) {
    assert.deepEqual(project(payload, options).projected.providerPage,
      { hasMore: null, nextParams: null, nextPage: null, stopReason: 'continuation_unproven' })
  }
  assert.deepEqual(project(envelope({ cursor: 'next-2' }), { continuation: { cursor: 'next-1' } }).projected.providerPage,
    { hasMore: null, nextParams: { cursor: 'next-2' }, nextPage: null })
})

test('Twitter rejects wrong roots, unsafe IDs, malformed comments and invalid success envelopes', () => {
  const invalid = [
    { code: 0, data: envelope().data }, { code: 200, data: null }, envelope({ id: '123' }),
    envelope({ id: Number(rootId) }), envelope({ conversation_id: Number(rootId) }), envelope({ conversation_id: null }),
    envelope({ thread: null }), envelope({ thread: 'comments' }), envelope({ thread: Array(1001).fill(comment()) }),
    envelope({ thread: [null] }), envelope({ thread: [comment({ id: Number(replyId) })] }),
    envelope({ thread: [comment({ id: 'not-a-twitter-id' })] }),
    envelope({ thread: [comment({ conversation_id: '123' })] }),
    envelope({ thread: [comment({ text: null })] }), envelope({ thread: [comment({ created_at: 1793602800 })] }),
    envelope({ thread: [comment({ created_at: 'not-a-date' })] }),
    envelope({ thread: [comment({ author: null })] }),
    envelope({ thread: [comment({ author: { rest_id: Number(authorId), name: '作者' } })] }),
    envelope({ thread: [comment({ author: { rest_id: authorId, name: null } })] }),
    envelope({ cursor: 1 }), envelope({ cursor: {} }), envelope({ cursor: 'x'.repeat(8193) }), envelope({ cursor: 'x\0y' }),
  ]
  for (const payload of invalid) assert.throws(() => project(payload), { code: 'invalid_upstream_contract' })
  assert.throws(() => project(envelope(), { provider: 'justone' }), { code: 'invalid_upstream_contract' })
})

test('explicit unknown parent support does not change other platforms root-parent mapping', () => {
  const result = projectPostCommentPage({ code: 200, data: { status: 'ok', has_more_comments: false,
    comments: [{ pk: '123', text: 'instagram', created_at: 1793602800, user: { pk: '456', username: 'author' } }] } },
  { provider: 'tikhub', postComments: { request: { platform: 'instagram', postId: 'fixtureCode', includeRaw: false } } }, { capturedAt })
  const row = result.projected.acquiredItems[0]
  assert.equal(row.parentExternalId, 'fixtureCode')
  assert.equal(row.repliesIncluded, false)
  assert.equal(Object.hasOwn(row, 'parentRelationship'), false)
  assert.equal(result.records[0].stableFields.attributes.parentExternalId, 'fixtureCode')
})

test('saved-archive parser is standalone, leaves evidence unchanged and returns only a fixed validation error', async () => {
  const source = await readFile(new URL('../../server/contracts/twitter-comment-page.mjs', import.meta.url), 'utf8')
  // These inspector-style top-level names deliberately overlap local helper
  // names. Concatenation must not require imports or create name collisions.
  const standalone = await import(`data:text/javascript;base64,${Buffer.from(source + '\nconst object = null, count = null, timestamp = null;').toString('base64')}`)
  const payload = envelope(), before = JSON.stringify(payload)
  const parsed = standalone.parseTikHubTwitterCommentPage(payload, rootId)
  assert.equal(JSON.stringify(payload), before)
  assert.equal(parsed.comments[0].raw, payload.data.thread[0])
  assert.equal(parsed.comments[0].values.text, payload.data.thread[0].text)
  assert.deepEqual(parsed, parseTikHubTwitterCommentPage(payload, rootId))
  assert.deepEqual(parsed.providerPage, project(payload).projected.providerPage)
  for (const [badPayload, postId] of [[{ code: 200, data: 'private-payload-secret' }, rootId],
    [payload, Number(rootId)], [payload, 'private-request-secret']]) {
    assert.throws(() => standalone.parseTikHubTwitterCommentPage(badPayload, postId), error => {
      assert.equal(error.code, 'invalid_upstream_contract')
      assert.equal(error.message, 'invalid_upstream_contract')
      assert.equal(JSON.stringify(error).includes('private'), false)
      return true
    })
  }
})
