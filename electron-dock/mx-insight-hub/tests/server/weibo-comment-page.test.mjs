import test from 'node:test'
import assert from 'node:assert/strict'
import { parseTikHubWeiboCommentPage } from '../../server/contracts/weibo-comment-page.mjs'
const postId = '5283919831764022'
const row = (id = '100000000000000001', extra = {}) => ({ id: Number(id), idstr: id, mid: id, rootid: Number(postId), rootidstr: postId,
  created_at: '2026-11-02 12:00:00 +0800', text: '<p>display</p>', text_raw: 'raw text', like_counts: 3, total_number: 2,
  user: { id: 123, idstr: '123', screen_name: 'author', profile_url: 'https://weibo.com/u/123' }, ...extra })
const payload = (rows = [row()], max_id = '') => ({ code: 200, params: { id: postId, count: '20', max_id: '' }, data: { ok: 1, data: rows, max_id } })
test('projects first-level rows and preserves raw text priority', () => { const result = parseTikHubWeiboCommentPage(payload([row()]), postId)
  assert.equal(result.comments.length, 1); assert.equal(result.comments[0].values.commentId, '100000000000000001'); assert.equal(result.comments[0].values.text, 'raw text'); assert.equal(result.comments[0].values.parentRelationship, 'unknown'); assert.equal(result.providerPage.hasMore, false) })
test('validates every row, prefers string aliases, and ignores unsafe numeric aliases', () => { const rows = Array.from({ length: 22 }, (_, i) => row(String(100000000000000001 + i), { id: 1e25 }))
  const result = parseTikHubWeiboCommentPage(payload(rows), postId); assert.equal(result.comments.length, 22); assert.equal(result.diagnostics.contextRootCount, 22) })
test('rejects target, identity, author, text, time and alias conflicts', () => {
  for (const patch of [{ rootidstr: '9' }, { idstr: '2', mid: '3' }, { user: { idstr: '1', id: 2, screen_name: 'a' } }, { text_raw: null, text: null }, { created_at: '2026-11-02' }, { user: { idstr: '1' } }]) {
    assert.throws(() => parseTikHubWeiboCommentPage(payload([row('100000000000000001', patch)]), postId), /invalid_upstream_contract/u)
  }
  assert.throws(() => parseTikHubWeiboCommentPage({ ...payload(), params: { id: '9' } }), /invalid_upstream_contract/u)
})
test('uses only safe advancing max_id; empty is exhausted and zero/unsafe stays unknown', () => {
  assert.deepEqual(parseTikHubWeiboCommentPage(payload([row()], '123'), postId).providerPage, { hasMore: true, nextParams: { max_id: '123' }, nextPage: null })
  assert.equal(parseTikHubWeiboCommentPage(payload([row()], ''), postId).providerPage.hasMore, false)
  assert.equal(parseTikHubWeiboCommentPage(payload([row()], 0), postId).providerPage.hasMore, null)
  assert.equal(parseTikHubWeiboCommentPage(payload([row()], 1e30), postId).providerPage.hasMore, null)
})
test('nested comments remain previews and are not projected as root comments', () => { const result = parseTikHubWeiboCommentPage(payload([row('100000000000000001', { comments: [row('2'), row('3')] })]), postId)
  assert.equal(result.comments.length, 1); assert.equal(result.diagnostics.previewCommentCount, 2) })
