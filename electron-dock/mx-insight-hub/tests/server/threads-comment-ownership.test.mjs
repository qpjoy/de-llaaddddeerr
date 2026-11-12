import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseThreadsCommentPage, threadsContinuation } from '../../server/contracts/threads.mjs'
import { normalizeCommentRepliesRequest, buildCommentRepliesDispatch } from '../../server/contracts/comment-replies.mjs'
import { projectCommentReplyPage } from '../../server/contracts/comment-reply-projection.mjs'
import { normalizePostCommentsRequest, buildPostCommentsDispatch } from '../../server/contracts/post-comments.mjs'
import { projectPostCommentPage } from '../../server/contracts/post-comment-projection.mjs'
import { projectDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import { socialAccountDeliveryBody } from '../../server/external-platforms/social-account-delivery.mjs'

const { postComments } = JSON.parse(readFileSync(new URL('../fixtures/threads-rapidapi-samples.json', import.meta.url), 'utf8'))
const [rootEdge, childEdge] = postComments.data.data.edges
const rootId = rootEdge.node.id, childId = childEdge.node.id, capturedAt = '2026-11-11T00:00:00Z'
const page = edges => ({ data: { data: { edges } } })

test('RapidAPI post and reply projections reject the wrong first-page root, even when the requested post is a later edge', () => {
  const request = normalizePostCommentsRequest({ platform: 'threads', contentId: childId }, { provider: 'rapidapi' })
  assert.throws(() => projectPostCommentPage(postComments, buildPostCommentsDispatch(request), { capturedAt }), { code: 'invalid_upstream_contract' })
  const reply = normalizeCommentRepliesRequest({ platform: 'threads', commentId: '999', contentId: rootId }, { provider: 'rapidapi' })
  assert.throws(() => projectCommentReplyPage(postComments, buildCommentRepliesDispatch(reply), { capturedAt }), { code: 'invalid_upstream_contract' })
})

test('a reply context can contain ancestors; continuation edges can omit the context and never return the supplied parent', () => {
  const target = structuredClone(childEdge)
  target.node.thread_items.unshift(...rootEdge.node.thread_items)
  const grandchild = structuredClone(childEdge)
  grandchild.node.id = grandchild.node.thread_items[0].post.pk = '777'
  grandchild.node.thread_items[0].post.text_post_app_info.reply_to_author.username = 'commenter'
  const options = { provider: 'rapidapi', contentId: rootId }
  for (const [response, cursor] of [[page([target, rootEdge, grandchild]), null], [page([rootEdge, grandchild]), 'next']]) {
    const { comments } = parseThreadsCommentPage(response, childId, { ...options, currentCursor: cursor })
    assert.deepEqual(comments.map(row => row.values.commentId), ['777'])
  }
  assert.throws(() => parseThreadsCommentPage(page([target]), rootId, options), /comment_target/)
  assert.deepEqual(parseThreadsCommentPage(page([]), rootId, options).comments, [])
})

test('TikHub accepts its comments-only list, including empty and single-page responses, and refuses error and unrelated envelopes', () => {
  const post = childEdge.node.thread_items[0].post, options = { provider: 'tikhub' }
  for (const list of [[], [post]]) {
    const parsed = parseThreadsCommentPage({ code: 200, data: { comments: list, has_more: true } }, rootId, options)
    assert.deepEqual(parsed.comments.map(row => row.values.commentId), list.map(row => row.pk))
    assert.deepEqual(parsed.providerPage, { hasMore: false, nextParams: null, nextPage: null })
  }
  for (const payload of [{ code: 400, data: { comments: [] } }, { code: 200, data: { users: [post] } }]) {
    assert.throws(() => parseThreadsCommentPage(payload, rootId, options))
  }
})

test('comment rows with contradictory parent or conversation IDs fail the entire page on both suppliers', () => {
  const options = { contentId: '100', currentCursor: 'continuation' }
  const good = { pk: '201', replied_to: { id: '200' }, root_post: { id: '100' } }
  for (const provider of ['rapidapi', 'tikhub']) {
    const payload = posts => provider === 'rapidapi'
      ? page(posts.map(post => ({ node: { id: post.pk, thread_items: [{ post }] } })))
      : { code: 200, data: { comments: posts } }
    const parse = (posts, extra = {}) => parseThreadsCommentPage(payload(posts), '200', { ...options, provider, ...extra })
    assert.deepEqual(parse([good]).comments.map(row => row.values.commentId), ['201'])
    assert.throws(() => parse([good, { ...good, pk: '202', replied_to: { id: '201' } }]), /comment_parent/)
    assert.throws(() => parse([good, { ...good, pk: '202', root_post: { id: '777' } }]), /comment_root/)
    assert.throws(() => parse([good], { contentId: '999' }), /comment_root/)
    assert.throws(() => parse([good, { pk: '202', is_reply: false }]), /comment_parent/)
    const optionsWithoutContentId = { contentId: null }
    assert.throws(() => parse([{ pk: '201', root_post: { id: '777' } }], optionsWithoutContentId), /comment_root/)
    assert.deepEqual(parse([good], optionsWithoutContentId).comments.map(row => row.values.commentId), ['201'])
  }
})

test('a reply target can be nested under the supplied post; an unrelated contentId contradicts the verified ancestor chain', () => {
  const post = (pk, parent, root) => ({ pk, ...(parent ? { replied_to: { id: parent } } : { is_reply: false }),
    ...(root ? { root_post: { id: root } } : {}) })
  const edge = (id, posts) => ({ node: { id, thread_items: posts.map(post => ({ post })) } })
  const target = edge('300', [post('100'), post('200', '100', '100'), post('300', '200', '100')])
  const child = post('400', '300', '100')
  const response = page([target, edge('400', [post('300', '200', '100'), child])])
  for (const contentId of ['100', '200']) {
    assert.deepEqual(parseThreadsCommentPage(response, '300', { provider: 'rapidapi', contentId }).comments.map(row => row.values.commentId), ['400'])
  }
  assert.throws(() => parseThreadsCommentPage(response, '300', { provider: 'rapidapi', contentId: '999' }), /comment_root/)
  const nested = page([target, edge('400', [{ pk: '400', root_post: { id: '100' } }])])
  assert.deepEqual(parseThreadsCommentPage(nested, '300', { provider: 'rapidapi' }).comments.map(row => row.values.commentId), ['400'])
})

test('unknown and terminal GraphQL pages retain distinct meanings in account and v2 search deliveries', () => {
  for (const info of [null, {}, { has_next_page: true }, { has_next_page: true, end_cursor: ' ' }]) {
    assert.deepEqual(threadsContinuation(info, 'rapidapi'), { hasMore: null, nextParams: null, nextPage: null })
  }
  assert.equal(threadsContinuation({ has_next_page: true, end_cursor: 'old' }, 'rapidapi', 'old').hasMore, null)
  assert.equal(threadsContinuation({ has_next_page: false }, 'rapidapi').hasMore, false)
  const request = { platform: 'threads', page: 1, pageSize: 20, jobs: [{}], operation: 'crawl', totalLimit: 20 }
  const delivery = socialAccountDeliveryBody(request, { rowsByJob: [[]], state: { jobs: [{ done: true, paginationUnproven: true }] },
    calls: 1, warnings: [{ code: 'pagination_completeness_unknown' }], deliveryId: 'receipt' })
  assert.equal(delivery.data.pageInfo.hasMore, null)
  assert.equal(delivery.data.page.nextCursor, null)
  const body = { platform: 'threads', query: 'topic', pageSize: 20, timeWindow: { from: capturedAt, to: '2026-11-12T00:00:00Z' } }
  const result = { body: { data: { ...body, items: [], pageInfo: { hasMore: null, nextCursor: null }, status: 'partial', warnings: [] } } }
  const v2 = projectDataSearchV2(result, body, { state: { page: 1 } }, {})
  assert.equal(v2.body.data.pageInfo.hasMore, null)
  assert.equal(v2.body.data.pageInfo.nextCursor, null)
  result.body.data.pageInfo.nextCursor = 'contradiction'
  assert.throws(() => projectDataSearchV2(result, body, { state: { page: 1 } }, {}), { code: 'search_v2_projection_unavailable' })
})
