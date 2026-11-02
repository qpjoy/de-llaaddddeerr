import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parseTikHubKuaishouCommentPage } from '../../server/contracts/kuaishou-comment-page.mjs'

const postId = 'fixturePhoto123'
// Synthetic values follow the archived App shape, not private production IDs.
const comment = (overrides = {}) => ({ comment_id: 112233445566, author_id: 22334455, user_id: 99887766,
  photo_id: 9007199254740992, reply_to: 12345, author_name: '作者', headurl: 'https://example.invalid/avatar.png',
  content: '  完整正文😀\n保留空白  ', time: '刚刚', timestamp: 1793602800000,
  likedCount: 0, subCommentCount: 8, unreviewedMedia: [{ url: 'https://example.invalid/preview.jpg' }], ...overrides })
const envelope = (overrides = {}) => ({ code: 200, params: { photo_id: postId }, data: { result: 1,
  rootComments: [comment()], pcursor: 'opaque+/==cursor', subCommentsMap: {
    '112233445566': { pcursor: 'reply-only-cursor', subComments: [comment({ comment_id: 445566778899 })] },
  }, ...overrides } })
const parse = (payload = envelope(), continuation = null) => parseTikHubKuaishouCommentPage(payload, postId, continuation)
const fails = (payload, reason, continuation = null) => assert.throws(() => parse(payload, continuation), error => {
  assert.equal(error.code, 'invalid_upstream_contract'); assert.equal(error.message, 'invalid_upstream_contract')
  assert.equal(error.reason, reason); return true
})

test('candidate maps only root comments with complete text, exact author ID, timestamp, metrics and root relationship', () => {
  const payload = envelope(), before = JSON.stringify(payload), result = parse(payload), row = result.comments[0]
  assert.equal(result.comments.length, 1)
  assert.equal(row.raw, payload.data.rootComments[0])
  assert.deepEqual(row.values, { commentId: '112233445566', text: payload.data.rootComments[0].content,
    publishedAt: '2026-11-02T07:00:00.000Z', publishedTime: '刚刚',
    author: { id: '22334455', name: '作者', avatarUrl: 'https://example.invalid/avatar.png' },
    likes: 0, replies: 8, parentExternalId: postId, parentCommentId: null, parentRelationship: 'post', url: null })
  assert.deepEqual(result.diagnostics, { previewRootCount: 1, previewCommentCount: 1, cursorState: 'advancing' })
  assert.equal(JSON.stringify(payload), before)
  assert.equal(Object.hasOwn(row.values, 'photo_id'), false)
  assert.equal(Object.hasOwn(row.values, 'media'), false)
})

test('all eleven root rows are validated; reply previews stay out and their cursors never become root continuation', () => {
  const roots = Array.from({ length: 11 }, (_, index) => comment({ comment_id: 112233445566 + index }))
  const result = parse(envelope({ rootComments: roots, subCommentsMap: {
    '112233445566': { pcursor: 'reply-cursor-one', subComments: [comment()] },
    '112233445567': { pcursor: 'reply-cursor-two', subComments: [comment()] },
  } }))
  assert.equal(result.comments.length, 11)
  assert.equal(new Set(result.comments.map(row => row.values.commentId)).size, 11)
  assert.equal(result.comments.at(-1).raw, roots.at(-1))
  assert.deepEqual(result.diagnostics, { previewRootCount: 2, previewCommentCount: 2, cursorState: 'advancing' })
  assert.deepEqual(result.providerPage, { hasMore: null, nextParams: { pcursor: 'opaque+/==cursor' }, nextPage: null })
  roots[10] = comment({ content: null })
  fails(envelope({ rootComments: roots }), 'comment_text')
  const empty = parse(envelope({ rootComments: [] }))
  assert.deepEqual(empty.comments, [])
  assert.equal(empty.providerPage.hasMore, null)
})

test('missing optional metrics remain null; preview counts and page total are never substituted', () => {
  const raw = comment(); delete raw.likedCount; delete raw.subCommentCount; delete raw.headurl
  const result = parse(envelope({ rootComments: [raw], commentCount: 555 }))
  assert.equal(result.comments[0].values.likes, null)
  assert.equal(result.comments[0].values.replies, null)
  assert.equal(result.comments[0].values.author.avatarUrl, null)
  assert.equal(result.diagnostics.previewCommentCount, 1)
  const stringMetrics = parse(envelope({ rootComments: [comment({ likedCount: '12', subCommentCount: '0' })] })).comments[0].values
  assert.equal(stringMetrics.likes, 12); assert.equal(stringMetrics.replies, 0)
})

test('unsafe mapped numeric IDs are rejected, while exact decimal strings and unrelated numeric metadata are preserved', () => {
  for (const key of ['comment_id', 'author_id']) {
    for (const value of [9007199254740992, 0, -1, 1.5, NaN, Infinity, '', ' 12 ', '12e3', {}, true]) {
      fails(envelope({ rootComments: [comment({ [key]: value })] }), key === 'comment_id' ? 'comment_identity' : 'author_identity')
    }
  }
  const raw = comment({ comment_id: '9007199254740993', author_id: '9007199254740995', photo_id: 9007199254740992,
    user_id: 9007199254740992, reply_to: 9007199254740992 })
  const row = parse(envelope({ rootComments: [raw] })).comments[0]
  assert.equal(row.values.commentId, '9007199254740993')
  assert.equal(row.values.author.id, '9007199254740995')
  assert.equal(row.values.parentExternalId, postId)
  assert.equal(row.raw, raw)
})

test('request identity must match the exact root request echo; internal photo ID is never the target', () => {
  for (const params of [undefined, null, [], {}, { photo_id: 123 }, { photo_id: 'otherPost' }]) {
    fails({ ...envelope(), params }, 'root_id_mismatch')
  }
  for (const id of [null, 123, '', 'https://example.invalid/', 'x'.repeat(129)]) {
    assert.throws(() => parseTikHubKuaishouCommentPage(envelope(), id), { reason: 'root_id_mismatch' })
  }
})

test('timestamp uses supplied seconds or milliseconds, never relative time; invalid metrics fail explicitly', () => {
  for (const timestamp of [1793602800, 1793602800000, '1793602800000']) {
    const row = parse(envelope({ rootComments: [comment({ timestamp })] })).comments[0]
    assert.equal(row.values.publishedAt, '2026-11-02T07:00:00.000Z')
  }
  for (const timestamp of [null, undefined, 0, -1, 1.5, '刚刚', true, NaN, 9007199254740992]) {
    fails(envelope({ rootComments: [comment({ timestamp })] }), 'comment_time')
  }
  for (const value of [false, -1, 1.5, Infinity, '1e2', '', '12 likes', 9007199254740992]) {
    fails(envelope({ rootComments: [comment({ likedCount: value })] }), 'comment_metrics')
    fails(envelope({ rootComments: [comment({ subCommentCount: value })] }), 'comment_metrics')
  }
})

test('continuation is explicit and conservative, including the unverified no_more sentinel', () => {
  for (const [pcursor, cursorState, continuation] of [[undefined, 'missing', null], [null, 'null', null],
    ['', 'empty', null], ['no_more', 'sentinel_unverified', null],
    ['same-token', 'repeated', { pcursor: 'same-token' }]]) {
    const result = parse(envelope({ pcursor }), continuation)
    assert.equal(result.diagnostics.cursorState, cursorState)
    assert.deepEqual(result.providerPage, { hasMore: null, nextParams: null, nextPage: null, stopReason: 'continuation_unproven' })
  }
  assert.deepEqual(parse(envelope({ pcursor: 'second-token' }), { pcursor: 'first-token' }).providerPage,
    { hasMore: null, nextParams: { pcursor: 'second-token' }, nextPage: null })
  for (const pcursor of [123, true, {}, [], ' ', 'x\0y', 'x'.repeat(8193)]) fails(envelope({ pcursor }), 'pagination_shape')
  for (const continuation of [true, [], 'token', { cursor: 'token' }, { pcursor: 1 }]) fails(envelope(), 'continuation_shape', continuation)
})

test('preview arrays and envelopes are bounded without interpreting preview fields or collecting replies', () => {
  for (const payload of [{ code: 0, data: envelope().data }, { ...envelope(), data: null }, envelope({ result: 0 })]) fails(payload, 'invalid_envelope')
  for (const rootComments of [null, {}, Array(1001).fill(comment())]) fails(envelope({ rootComments }), 'root_comments_shape')
  for (const rootComments of [[null], [comment({ author_name: null })], [comment({ headurl: {} })]]) {
    assert.throws(() => parse(envelope({ rootComments })), { code: 'invalid_upstream_contract' })
  }
  for (const subCommentsMap of [[], 'private', { one: null }, { one: { subComments: {} } }, { one: { subComments: [null] } }]) {
    fails(envelope({ subCommentsMap }), 'preview_shape')
  }
  fails(envelope({ subCommentsMap: Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [i, { subComments: [] }])) }), 'structure_limit')
  fails(envelope({ subCommentsMap: { one: { subComments: Array(1001).fill({}) } } }), 'structure_limit')
  fails(envelope({ subCommentsMap: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [i, { subComments: Array(1000).fill({}) }])) }), 'structure_limit')
  const withoutPreviews = parse(envelope({ subCommentsMap: undefined }))
  assert.equal(withoutPreviews.diagnostics.previewCommentCount, 0)
  const unsafeAvatar = parse(envelope({ rootComments: [comment({ headurl: 'javascript:private-token' })] }))
  assert.equal(unsafeAvatar.comments[0].values.author.avatarUrl, null)
})

test('standalone candidate can be concatenated with the inspector and leaks no payload in validation errors', async () => {
  const source = await readFile(new URL('../../server/contracts/kuaishou-comment-page.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bimport\s|\bfetch\s*\(/)
  const module = await import(`data:text/javascript;base64,${Buffer.from(source + '\nconst object=null, identity=null, metric=null;').toString('base64')}`)
  assert.deepEqual(module.parseTikHubKuaishouCommentPage(envelope(), postId), parse())
  assert.throws(() => module.parseTikHubKuaishouCommentPage({ code: 200, data: 'private-body' }, postId), error => {
    assert.equal(error.message, 'invalid_upstream_contract')
    assert.equal(JSON.stringify(error).includes('private'), false)
    return true
  })
})
