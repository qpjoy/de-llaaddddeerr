import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { projectPostCommentPage, POST_COMMENT_PROJECTION_PLATFORMS } from '../../server/contracts/post-comment-projection.mjs'
import { canonicalJson } from '../../server/ingest/normalizers.mjs'
import { normalizePostCommentsRequest, buildPostCommentsDispatch } from '../../server/contracts/post-comments.mjs'

const capturedAt = '2026-11-02T00:00:00.000Z'
const note = '675d277d000000000600e655'
const step = (platform, postId, options = {}) => ({ provider: 'tikhub', postComments: {
  request: { platform, postId, includeRaw: false, ...options.request }, continuation: options.continuation } })
const project = (data, dispatch) => projectPostCommentPage({ code: 200, data }, dispatch, { capturedAt })
const instagram = { pk: '18000000000000001', media_id: '3440000000000000001',
  text: '  完整评论😀\n第二行  ', created_at: 1791777600, comment_like_count: 0, child_comment_count: 1,
  user: { pk: 1234567890, id: '1234567890', username: 'fixture_commenter' },
  preview_child_comments: [{ pk: 'child1', text: 'not a top-level comment' }],
  has_more_head_child_comments: true, has_more_tail_child_comments: false }

test('Instagram observed terminal shape preserves full comment and canonical parent identity', () => {
  const data = { status: 'ok', comments: [instagram], has_more_comments: false, comment_count: 2,
    caption: { pk: 'caption', text: 'original post, not a comment' } }
  const result = project(data, step('instagram', 'fixtureCode'))
  const row = result.projected.acquiredItems[0], record = result.records[0]
  assert.equal(result.projected.acquiredItems.length, 1)
  assert.equal(row.commentId, instagram.pk)
  assert.equal(row.content_id, instagram.pk)
  assert.equal(row.postId, 'fixtureCode')
  assert.equal(row.contentId, 'fixtureCode')
  assert.equal(row.full_text, instagram.text)
  assert.equal(row.like_count, 0)
  assert.equal(row.reply_count, 1)
  assert.equal(row.author.id, '1234567890')
  assert.equal(row.repliesIncluded, false)
  assert.equal(Object.hasOwn(row, 'raw'), false)
  assert.equal(record.body, instagram.text)
  assert.equal(record.objectType, 'comment')
  assert.equal(record.contentType, 'comment')
  assert.equal(record.stableFields.attributes.parentExternalId, 'fixtureCode')
  assert.deepEqual(record.rawItem, instagram)
  assert.equal(record.rawPayloadSha256, createHash('sha256').update(canonicalJson(instagram)).digest('hex'))
  assert.deepEqual(result.projected.providerPage, { hasMore: false, nextParams: null, nextPage: null })
})

test('Instagram JSON cursor remains opaque and repeated or absent continuation is explicitly unknown', () => {
  const cursor = '{"cached_comments_cursor":"next+/==&page=2","bifilter_token":"opaque\\token"}'
  const data = { status: 'ok', comments: [instagram], has_more_comments: true, next_min_id: cursor }
  assert.deepEqual(project(data, step('instagram', 'fixtureCode')).projected.providerPage.nextParams, { min_id: cursor })
  for (const [payload, dispatch] of [[data, step('instagram', 'fixtureCode', { continuation: { min_id: cursor } })],
    [{ ...data, next_min_id: null }, step('instagram', 'fixtureCode')]]) {
    const page = project(payload, dispatch).projected.providerPage
    assert.equal(page.hasMore, false)
    assert.equal(page.stopReason, 'continuation_unproven')
  }
  assert.equal(project({ ...data, has_more_comments: false }, step('instagram', 'fixtureCode')).projected.providerPage.nextParams, null)
})

test('Instagram invalid success envelopes and unsafe IDs fail instead of returning false empty success', () => {
  for (const data of [{ status: 'fail', comments: [] }, { status: 'ok', comments: 'comments' },
    { status: 'ok', comments: [{ ...instagram, pk: 9007199254740992 }] },
    { status: 'ok', comments: [{ ...instagram, user: { pk: 9007199254740992 } }] }]) {
    assert.throws(() => project(data, step('instagram', 'fixtureCode')), { code: 'invalid_upstream_contract' })
  }
})

test('XHS uses released full fields and compound pagination while archiving embedded replies', () => {
  const raw = { id: 'comment1', note_id: note, content: '长正文'.repeat(1000), create_time: 1791777600,
    like_count: '12', sub_comment_count: 1, user_info: { user_id: 'author', nickname: '作者' },
    pictures: [{ url: 'https://example.invalid/photo.jpg?signature=retained' }],
    sub_comments: [{ id: 'reply1', content: 'nested', note_id: note }] }
  const result = project({ code: 0, success: true, data: { comments: [raw], has_more: true,
    cursor: 'next-token', index: 2, pageArea: 'ALL' } }, step('xiaohongshu', note))
  const row = result.projected.acquiredItems[0]
  assert.equal(result.records.length, 1, 'only top-level acquired comments enter this operation')
  assert.equal(row.content.length, 3000)
  assert.equal(row.media[0].url, raw.pictures[0].url)
  assert.equal(row.author.id, 'author')
  assert.equal(row.like_count, 12)
  assert.deepEqual(result.records[0].rawItem.sub_comments, raw.sub_comments)
  assert.deepEqual(result.projected.providerPage.nextParams, { cursor: 'next-token', index: '2', pageArea: 'ALL' })
  assert.equal(result.records[0].stableFields.attributes.rootExternalId, note)
})

test('XHS missing continuation remains unknown and unrelated note identity fails', () => {
  const data = { code: 0, data: { comments: [{ id: 'comment', content: 'body' }], has_more: true, cursor: 'next' } }
  assert.equal(project(data, step('xiaohongshu', note)).projected.providerPage.stopReason, 'continuation_unproven')
  data.data.comments[0].note_id = '675d277d000000000600e656'
  assert.throws(() => project(data, step('xiaohongshu', note)), { code: 'invalid_upstream_contract' })
})

test('YouTube preserves relative publication evidence without inventing a timestamp', () => {
  const raw = { comment_id: 'comment1', content: 'body', published_time: '2 days ago', like_count: '0',
    reply_count: 3, author: { channel_id: 'UC' + 'a'.repeat(22), display_name: '作者' } }
  const result = project({ comments: [raw], continuation_token: 'opaque+/==' }, step('youtube', 'dQw4w9WgXcQ', { request: { includeRaw: true } }))
  const row = result.projected.acquiredItems[0]
  assert.equal(row.publishedAt, null)
  assert.equal(row.publishedTime, '2 days ago')
  assert.equal(row.postId, 'dQw4w9WgXcQ')
  assert.equal(row.videoId, 'dQw4w9WgXcQ')
  assert.deepEqual(row.raw, raw)
  assert.deepEqual(result.projected.providerPage.nextParams, { continuation_token: 'opaque+/==' })
  assert.equal(result.records[0].objectType, 'comment')
  assert.equal(project({ comments: [], continuation_token: null }, step('youtube', 'dQw4w9WgXcQ')).projected.providerPage.hasMore, false)
  assert.equal(project({ comments: [] }, step('youtube', 'dQw4w9WgXcQ')).projected.providerPage.stopReason, 'continuation_unproven')
})

test('complete paid page remains available for buffering instead of truncating to client count', () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({ ...instagram, pk: String(index) }))
  const result = project({ status: 'ok', comments: rows, has_more_comments: false },
    step('instagram', 'fixtureCode', { request: { count: 20 } }))
  assert.equal(result.projected.acquiredItems.length, 25)
  assert.equal(result.records.length, 25)
})

test('unknown platform and cross-provider success shapes fail closed', () => {
  assert.equal(POST_COMMENT_PROJECTION_PLATFORMS.length, 13)
  assert.throws(() => project({ comments: [] }, step('unknown', 'post')), { code: 'external_platform_contract_unverified' })
  assert.throws(() => project({ timeline: [] }, step('twitter', 'post')), { code: 'invalid_upstream_contract' })
})

// Anonymous shapes from the 2026-11-02 official JustOne documentation examples,
// GET https://api.justoneapi.com/status/api-example/detail?api=<endpoint path>.
// These represent observed field layout, not a paid Hub production verification.
const justoneShapes = {
  weibo: { ok: 1, data: [{ idstr: '456', text_raw: '完整评论', text: '<p>完整评论</p>',
    created_at: 'Wed Mar 18 09:53:26 +0800 2026', user: { idstr: '123456', screen_name: '作者' },
    like_counts: 0, total_number: 3, comments: [{ text: '预览回复' }] }], max_id: 5277493566112993 },
  douyin: { status_code: 0, comments: [{ cid: '456', aweme_id: '123', text: '完整评论', create_time: 1791777600,
    digg_count: 1, reply_comment_total: 4, user: { uid: 'author', nickname: '作者' } }], cursor: 20, has_more: 1 },
  tiktok: { status_code: 0, comments: [{ cid: '456', aweme_id: '123', text: '完整评论', create_time: 1791777600,
    digg_count: 1, reply_comment_total: 4, user: { uid: 'author', nickname: '作者' } }], cursor: 20, has_more: 1 },
  zhihu: { data: [{ id: '456', content: '<p>完整评论</p>', created_time: 1791777600,
    author: { id: 'author', name: '作者' }, like_count: 1, child_comment_count: 3, dislike_count: 2 }],
    paging: { is_end: false, next: 'https://www.zhihu.com/api/v4/comment_v5/answers/123/root_comment?offset=opaque-next' } },
  linkedin: { data: [{ text: '完整评论', created_at: 1732655923782, replies: [], thread_urn: null,
    commenter: { urn: 'author', name: '作者' },
    permalink: 'https://www.linkedin.com/feed/update/urn:li:activity:123?commentUrn=urn%3Ali%3Acomment%3A%28activity%3A123%2C456%29' }],
    pagination_token: 'next', total: 1 },
  bilibili: { code: 0, data: { replies: [{ rpid_str: '456', oid_str: '123', content: { message: '完整评论' },
    member: { mid: 'author', uname: '作者' }, ctime: 1791777600, like: 1, rcount: 2 }],
    cursor: { is_end: false, pagination_reply: { next_offset: 'next' } } } },
  facebook: { results: [{ type: 'comment', comment_id: 'encoded-comment', legacy_comment_id: '456',
    depth: 0, parent_comment_id: null, message: '完整评论', created_time: 1791777600,
    author: { id: 'author', name: '作者' }, reactions_count: '0', replies_count: 1 }], cursor: 'next' },
}
const expectedNext = { weibo: { max_id: '5277493566112993' }, douyin: { page: 2 }, tiktok: { cursor: '20' }, zhihu: { offset: 'opaque-next' },
  linkedin: { page: 2, paginationToken: 'next' }, bilibili: { cursor: 'next' }, facebook: { cursor: 'next' } }
// Weibo (2026-11-03) and Zhihu (2026-11-05) moved to TikHub, which relays the
// same platform page inside its ResponseModel envelope and request echo.
const tikHubSwitched = {
  weibo: data => ({ code: 200, params: { id: '123' }, data: { ok: 1,
    data: data.data.map(row => ({ ...row, rootidstr: row.rootidstr ?? '123', rootid: row.rootid ?? 123 })), max_id: data.max_id } }),
  zhihu: data => ({ code: 200, router: '/api/v1/zhihu/web/fetch_comment_v5', params: { answer_id: '123', order_by: 'score', limit: '20', offset: '' }, data }),
}
const supplierOf = platform => tikHubSwitched[platform] ? 'tikhub' : 'justone'
const supplierPayload = (platform, data) => tikHubSwitched[platform] ? tikHubSwitched[platform](data) : { code: 0, data }
function justoneProject(platform, data = justoneShapes[platform], options = {}) {
  const dispatch = step(platform, '123', options)
  dispatch.provider = supplierOf(platform)
  return projectPostCommentPage(supplierPayload(platform, data), dispatch, { capturedAt })
}
for (const platform of Object.keys(justoneShapes)) {
  test(`${platform} official sample shape produces stable comment fields and provider-specific continuation`, () => {
    const result = justoneProject(platform), row = result.projected.acquiredItems[0], record = result.records[0]
    assert.equal(result.projected.acquiredItems.length, 1)
    assert.equal(row.postId, '123')
    assert.equal(row.contentId, '123')
    assert.ok(row.commentId)
    assert.equal(row.content_id, row.commentId)
    assert.equal(row.author.name, '作者')
    assert.equal(row.full_text.includes('完整评论'), true)
    assert.ok(row.publishedAt)
    assert.equal(record.objectType, 'comment')
    assert.equal(record.stableFields.connectorId, `external-platform:${supplierOf(platform)}`)
    assert.equal(record.stableFields.attributes.rootExternalId, '123')
    assert.deepEqual(result.projected.providerPage.nextParams, expectedNext[platform])
  })
}

// Anonymous App layout verified against all eleven saved TikHub root comments.
const kuaishouPostId = 'fixturePhoto123'
const kuaishouShape = { result: 1, rootComments: Array.from({ length: 11 }, (_, index) => ({
  comment_id: 123400 + index, content: `  完整评论${index}😀\n第二行  `, timestamp: 1793577600000,
  author_id: 456700 + index, user_id: 987600 + index, author_name: `作者${index}`,
  likedCount: index, subCommentCount: index < 2 ? 3 : 0,
  headurl: 'https://example.invalid/avatar.jpg?signature=retained',
  photo_id: 9007199254740992, reply_to: 112233,
})), pcursor: 'next-root+/==&page=2', subCommentsMap: {
  123400: { subComments: [{ comment_id: 880011, content: '预览回复一' }], pcursor: 'preview-cursor-one' },
  123401: { subComments: [{ comment_id: 880022, content: '预览回复二' }], pcursor: 'preview-cursor-two' },
} }
const kuaishouProject = (data = kuaishouShape, options = {}) => projectPostCommentPage(
  { code: 200, params: { photo_id: kuaishouPostId }, data }, step('kuaishou', kuaishouPostId, options), { capturedAt })

// Anonymous Reddit forest layout validated against saved TikHub evidence.
const redditShape = { postInfoById: { id: 't3_123', commentForest: { pageInfo: { hasNextPage: true }, trees: [
    { depth: 0, parentId: null, childCount: 1, more: null, node: { __typename: 'Comment', id: 't1_456',
      content: { markdown: '完整评论', preview: '短预览' }, authorInfo: { id: 't2_author', name: '作者' },
      createdAt: '2026-01-10T15:21:49.595000+0000', score: 1, permalink: '/r/test/comments/123/title/456/' } },
    { node: null, more: { cursor: 'next' }, depth: 0, parentId: null, childCount: 2 },
  ] } } }

test('supplier-returned descendant keeps its real parent while contentId remains root post', () => {
  const reddit = structuredClone(redditShape)
  reddit.postInfoById.commentForest.trees[0].parentId = 't1_other'
  const result = project(reddit, step('reddit', 't3_123'))
  assert.equal(result.projected.acquiredItems[0].parentCommentId, 't1_other')
  assert.equal(result.records[0].stableFields.attributes.parentExternalId, 't1_other')
  assert.equal(result.projected.acquiredItems[0].contentId, 't3_123')
  assert.equal(result.projected.acquiredItems[0].repliesIncluded, true)
  reddit.postInfoById.commentForest.trees[0].parentId = 't3_123'
  assert.equal(project(reddit, step('reddit', 't3_123')).projected.acquiredItems[0].parentCommentId, null)
})

test('Twitter, Reddit, Kuaishou and Zhihu reject old JustOne projections after switching to fixed TikHub recipes', () => {
  const zhihuStep = step('zhihu', '123')
  assert.throws(() => projectPostCommentPage({ code: 0, data: justoneShapes.zhihu }, zhihuStep, { capturedAt }),
    { code: 'invalid_upstream_contract' }, 'a JustOne envelope is not a TikHub page')
  assert.throws(() => projectPostCommentPage({ code: 0, data: justoneShapes.zhihu }, { ...zhihuStep, provider: 'justone' }, { capturedAt }),
    { code: 'invalid_upstream_contract' }, 'a JustOne dispatch cannot settle a TikHub-routed platform')
  assert.throws(() => justoneProject('kuaishou', kuaishouShape), { code: 'invalid_upstream_contract' })
  assert.throws(() => justoneProject('reddit', redditShape), { code: 'invalid_upstream_contract' })
  assert.throws(() => justoneProject('twitter', { status: 'ok', timeline: [], next_cursor: null }),
    { code: 'invalid_upstream_contract' })
})

test('known terminal fields override residual tokens while missing and repeated tokens remain unknown', () => {
  assert.equal(justoneProject('tiktok', { ...justoneShapes.tiktok, has_more: 0 }).projected.providerPage.hasMore, false)
  assert.equal(justoneProject('weibo', { ...justoneShapes.weibo, max_id: 0 }).projected.providerPage.hasMore, null)
  const missing = structuredClone(redditShape)
  delete missing.postInfoById.commentForest.pageInfo
  missing.postInfoById.commentForest.trees.pop()
  assert.equal(project(missing, step('reddit', 't3_123')).projected.providerPage.stopReason, 'continuation_unproven')
})

test('post mismatches and foreign continuation destinations fail', () => {
  const reddit = structuredClone(redditShape)
  reddit.postInfoById.id = 't3_wrong-post'
  assert.throws(() => project(reddit, step('reddit', 't3_123')), { code: 'invalid_upstream_contract' })
  const zhihu = structuredClone(justoneShapes.zhihu)
  zhihu.paging.next = 'https://attacker.invalid/api?offset=next'
  assert.throws(() => justoneProject('zhihu', zhihu), { code: 'invalid_upstream_contract' })
})

test('Facebook sticker-only comment has an explicit null body and retained media', () => {
  const data = structuredClone(justoneShapes.facebook)
  Object.assign(data.results[0], { message: null, is_sticker: true,
    sticker: { image: { uri: 'https://example.invalid/sticker.webp?signed=preserved', width: 160, height: 160 } } })
  const result = justoneProject('facebook', data)
  assert.equal(result.projected.acquiredItems[0].content, null)
  assert.equal(result.projected.acquiredItems[0].media[0].url, data.results[0].sticker.image.uri)
  assert.equal(result.records[0].body, null)
  assert.equal(result.projected.acquiredItems[0].like_count, null)
  assert.equal(result.projected.acquiredItems[0].metrics.reactions, 0, 'all reactions are not relabeled as likes')

})

for (const platform of Object.keys(justoneShapes)) {
  test(`${platform} projected continuation rebuilds the fixed native request`, () => {
    const request = normalizePostCommentsRequest({ platform, postId: '123' })
    const first = buildPostCommentsDispatch(request)
    const result = projectPostCommentPage(supplierPayload(platform, justoneShapes[platform]), first, { capturedAt })
    const next = buildPostCommentsDispatch(request, { providerCursor: result.projected.providerPage.nextParams })
    assert.equal(next.provider, supplierOf(platform))
    assert.equal(next.endpointPath, first.endpointPath)
    for (const [field, value] of Object.entries(expectedNext[platform])) assert.equal(String(next.upstreamQuery[field]), String(value))
  })
}

test('Reddit signed score survives canonical projection without becoming likes', () => {
  const data = structuredClone(redditShape)
  const forest = data.postInfoById.commentForest
  forest.pageInfo.hasNextPage = false
  forest.trees = [forest.trees[0]]
  forest.trees[0].childCount = 0
  forest.trees[0].node.score = -3
  const result = project(data, step('reddit', 't3_123'))
  const row = result.projected.acquiredItems[0], record = result.records[0]
  assert.equal(row.metrics.score, -3)
  assert.equal(row.like_count, null)
  assert.equal(row.parentExternalId, null)
  assert.equal(row.parentRelationship, 'unknown')
  assert.equal(record.metrics.score, -3)
  assert.equal(record.stableFields.metrics.score, -3)
  assert.equal(record.stableFields.connectorId, 'external-platform:tikhub')
  assert.equal(result.projected.providerPage.hasMore, false)
  forest.trees[0].node.isScoreHidden = true
  const hidden = project(data, step('reddit', 't3_123'))
  assert.equal(hidden.records[0].metrics.score, null)
  assert.notEqual(hidden.records[0].payloadSha256, record.payloadSha256)
})

test('Kuaishou App projects every full root comment with the public eID and canonical TikHub lineage', () => {
  const original = structuredClone(kuaishouShape)
  const result = kuaishouProject(kuaishouShape, { request: { includeRaw: true, count: 3 } })
  assert.equal(result.projected.acquiredItems.length, 11, 'retain the complete paid page for the delivery buffer')
  assert.equal(result.records.length, 11)
  for (const [index, row] of result.projected.acquiredItems.entries()) {
    const raw = kuaishouShape.rootComments[index], record = result.records[index]
    assert.equal(row.commentId, String(raw.comment_id))
    assert.equal(row.content_id, row.commentId)
    assert.equal(row.postId, kuaishouPostId)
    assert.equal(row.contentId, kuaishouPostId)
    assert.equal(row.rootExternalId, kuaishouPostId)
    assert.equal(row.parentExternalId, kuaishouPostId)
    assert.equal(row.parentRelationship, 'post')
    assert.equal(row.parentCommentId, null, 'reply_to metadata is not a parent comment ID')
    assert.equal(row.repliesIncluded, false)
    assert.equal(row.text, raw.content)
    assert.equal(row.content, raw.content)
    assert.equal(row.full_text, raw.content)
    assert.equal(row.author.id, String(raw.author_id))
    assert.notEqual(row.author.id, String(raw.user_id))
    assert.equal(row.author.name, raw.author_name)
    assert.equal(row.author.avatarUrl, raw.headurl)
    assert.equal(row.publishedAt, new Date(raw.timestamp).toISOString())
    assert.equal(row.like_count, raw.likedCount)
    assert.equal(row.reply_count, raw.subCommentCount)
    assert.equal(record.body, raw.content)
    assert.equal(record.externalId, String(raw.comment_id))
    assert.equal(record.objectType, 'comment')
    assert.equal(record.stableFields.connectorId, 'external-platform:tikhub')
    assert.equal(record.stableFields.attributes.rootExternalId, kuaishouPostId)
    assert.equal(record.stableFields.attributes.parentExternalId, kuaishouPostId)
    assert.equal(record.stableFields.attributes.parentCommentId, null)
    assert.equal(record.metrics.likes, raw.likedCount)
    assert.equal(record.metrics.comments, raw.subCommentCount)
    assert.equal(record.stableFields.metrics.likes, raw.likedCount)
    assert.equal(record.stableFields.metrics.comments, raw.subCommentCount)
    assert.deepEqual(row.raw, raw)
    assert.deepEqual(record.rawItem, raw)
    assert.equal(record.rawPayloadSha256, createHash('sha256').update(canonicalJson(raw)).digest('hex'))
  }
  assert.equal(result.projected.acquiredItems.some(row => ['880011', '880022'].includes(row.commentId)), false)
  assert.equal(result.projected.acquiredItems[0].reply_count, 3, 'preview length is not the reply count')
  assert.equal(result.records[0].rawItem.photo_id, 9007199254740992, 'unprojected internal metadata remains raw')
  assert.deepEqual(kuaishouShape, original, 'projection leaves the archived response and previews unchanged')
  assert.equal(Object.hasOwn(kuaishouProject().projected.acquiredItems[0], 'raw'), false)
  assert.deepEqual(result.projected.providerPage, { hasMore: null,
    nextParams: { pcursor: kuaishouShape.pcursor }, nextPage: null })
})

test('Kuaishou App missing, repeated and no_more cursors remain unknown without substituting preview cursors', () => {
  for (const pcursor of [undefined, null, '', 'no_more']) {
    const data = { ...kuaishouShape, pcursor }
    assert.deepEqual(kuaishouProject(data).projected.providerPage, {
      hasMore: null, nextParams: null, nextPage: null, stopReason: 'continuation_unproven',
    })
  }
  assert.deepEqual(kuaishouProject(kuaishouShape, { continuation: { pcursor: kuaishouShape.pcursor } }).projected.providerPage, {
    hasMore: null, nextParams: null, nextPage: null, stopReason: 'continuation_unproven',
  })
})

test('Kuaishou App rejects unsafe primary identities and mismatched request echoes', () => {
  for (const field of ['comment_id', 'author_id']) {
    const data = structuredClone(kuaishouShape)
    data.rootComments[10][field] = 9007199254740992
    assert.throws(() => kuaishouProject(data), { code: 'invalid_upstream_contract' })
  }
  assert.throws(() => projectPostCommentPage({ code: 200, params: { photo_id: 'otherPhoto' }, data: kuaishouShape },
    step('kuaishou', kuaishouPostId), { capturedAt }), { code: 'invalid_upstream_contract' })
})

test('Kuaishou App projected continuation rebuilds its fixed TikHub native request', () => {
  const request = normalizePostCommentsRequest({ platform: 'kuaishou', contentId: kuaishouPostId })
  const first = buildPostCommentsDispatch(request)
  const result = projectPostCommentPage({ code: 200, params: { photo_id: kuaishouPostId }, data: kuaishouShape }, first, { capturedAt })
  const next = buildPostCommentsDispatch(request, { providerCursor: result.projected.providerPage.nextParams })
  assert.equal(next.provider, 'tikhub')
  assert.equal(next.endpointPath, '/api/v1/kuaishou/app/fetch_video_comment')
  assert.equal(next.upstreamQuery.photo_id, kuaishouPostId)
  assert.equal(next.upstreamQuery.pcursor, kuaishouShape.pcursor)
})

// Zhihu comment_v5 root_comment page relayed by TikHub fetch_comment_v5.
// The layout is the one calibrated from JustOne's official sample of the same
// Zhihu page; only the TikHub envelope is new.
const zhihuAnswer = '89226347214'
const zhihuPage = (overrides = {}) => ({
  data: [
    { id: '11108372663', type: 'comment', resource_type: 'answer', content: '<p>完整知乎评论</p>', created_time: 1739257701,
      like_count: 12, dislike_count: 1, child_comment_count: 3, url: 'https://www.zhihu.com/answer/x/comment/11108372663',
      author: { id: 'a1b2c3', url_token: 'fixture-user', name: '知乎作者', avatar_url: 'https://example.invalid/a.jpg' },
      child_comments: [{ id: '11108372700', content: '回复预览' }] },
    { id: 11108372664, type: 'comment', content: '第二条', created_time: 1739257702, like_count: 0,
      child_comment_count: 0, author: { id: 'd4e5f6', name: '第二作者' } },
  ],
  paging: { is_end: false, is_start: true, totals: 40,
    next: `https://www.zhihu.com/api/v4/comment_v5/answers/${zhihuAnswer}/root_comment?order_by=score&limit=20&offset=1739257701_11108372663_0` },
  counts: { total_counts: 40 }, ...overrides })
const zhihuProject = (data = zhihuPage(), options = {}, envelope = {}) => projectPostCommentPage(
  { code: 200, params: { answer_id: zhihuAnswer, order_by: 'score', limit: '20', offset: '' }, data, ...envelope },
  step('zhihu', zhihuAnswer, options), { capturedAt })

test('Zhihu TikHub comment_v5 projects root comments with Zhihu offset continuation and TikHub lineage', () => {
  const original = zhihuPage()
  const result = zhihuProject(original, { request: { includeRaw: true } })
  assert.equal(result.projected.acquiredItems.length, 2)
  const [first, second] = result.projected.acquiredItems
  assert.equal(first.commentId, '11108372663')
  assert.equal(second.commentId, '11108372664', 'safe numeric IDs become strings')
  assert.equal(first.postId, zhihuAnswer)
  assert.equal(first.text, '<p>完整知乎评论</p>')
  assert.equal(first.author.id, 'a1b2c3')
  assert.equal(first.author.name, '知乎作者')
  assert.equal(first.publishedAt, new Date(1739257701000).toISOString())
  assert.equal(first.like_count, 12)
  assert.equal(first.reply_count, 3, 'child_comment_count, not the preview length')
  assert.equal(first.metrics.dislikes, 1)
  assert.equal(second.metrics.dislikes, null)
  assert.equal(result.projected.acquiredItems.some(row => row.commentId === '11108372700'), false, 'reply previews are not roots')
  assert.deepEqual(first.raw, original.data[0])
  assert.equal(result.records[0].stableFields.connectorId, 'external-platform:tikhub')
  assert.equal(result.records[0].stableFields.attributes.rootExternalId, zhihuAnswer)
  assert.deepEqual(result.projected.providerPage, { hasMore: true, nextParams: { offset: '1739257701_11108372663_0' }, nextPage: null })
})

test('Zhihu TikHub page accepts the extra data wrapper seen on Zhihu search and nothing looser', () => {
  const direct = zhihuProject()
  const wrapped = zhihuProject({ code: 0, data: zhihuPage() })
  assert.deepEqual(wrapped.projected, direct.projected)
  for (const data of [null, [], { items: [] }, { data: { items: [] } }, { data: 'not-a-list' }]) {
    assert.throws(() => zhihuProject(data), { code: 'invalid_upstream_contract' })
  }
  const badRow = zhihuPage()
  badRow.data.push(null)
  assert.throws(() => zhihuProject(badRow), { code: 'invalid_upstream_contract' })
  assert.throws(() => zhihuProject(zhihuPage({ paging: 'end' })), { code: 'invalid_upstream_contract' })
})

test('Zhihu TikHub request echo and continuation destination must match the requested answer', () => {
  assert.throws(() => zhihuProject(zhihuPage(), {}, { params: { answer_id: '1' } }), { code: 'invalid_upstream_contract' })
  assert.equal(zhihuProject(zhihuPage(), {}, { params: undefined }).projected.acquiredItems.length, 2, 'a missing echo is not a mismatch')
  for (const next of [`https://www.zhihu.com/api/v4/comment_v5/answers/1/root_comment?offset=x`,
    `https://zhihu.attacker.invalid/api/v4/comment_v5/answers/${zhihuAnswer}/root_comment?offset=x`, 'not a url']) {
    assert.throws(() => zhihuProject(zhihuPage({ paging: { is_end: false, next } })), { code: 'invalid_upstream_contract' })
  }
})

test('Zhihu TikHub is_end ends the traversal; missing or repeated offsets stay unknown', () => {
  assert.deepEqual(zhihuProject(zhihuPage({ paging: { is_end: true, next: 'https://www.zhihu.com/ignored' } })).projected.providerPage,
    { hasMore: false, nextParams: null, nextPage: null })
  assert.deepEqual(zhihuProject(zhihuPage({ paging: { is_end: false } })).projected.providerPage,
    { hasMore: false, nextParams: null, nextPage: null, stopReason: 'continuation_unproven' })
  assert.equal(zhihuProject(zhihuPage({ paging: undefined })).projected.providerPage.stopReason, 'continuation_unproven')
  assert.equal(zhihuProject(zhihuPage(), { continuation: { offset: '1739257701_11108372663_0' } }).projected.providerPage.nextParams, null)
})

test('Zhihu projected continuation rebuilds the fixed TikHub fetch_comment_v5 request', () => {
  const request = normalizePostCommentsRequest({ platform: 'zhihu', contentId: zhihuAnswer, params: { order_by: 'ts' } })
  const first = buildPostCommentsDispatch(request)
  assert.equal(first.provider, 'tikhub')
  assert.equal(first.endpointPath, '/api/v1/zhihu/web/fetch_comment_v5')
  assert.equal(first.upstreamQuery.answer_id, zhihuAnswer)
  assert.equal(first.upstreamQuery.order_by, 'ts')
  const result = projectPostCommentPage({ code: 200, params: { answer_id: zhihuAnswer }, data: zhihuPage() }, first, { capturedAt })
  const next = buildPostCommentsDispatch(request, { providerCursor: result.projected.providerPage.nextParams })
  assert.equal(next.endpointPath, first.endpointPath)
  assert.equal(next.upstreamQuery.offset, '1739257701_11108372663_0')
  assert.equal(next.upstreamQuery.order_by, 'ts', 'the sort order is part of the fixed request identity')
})
