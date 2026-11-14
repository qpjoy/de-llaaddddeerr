import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { projectPage } from '../../server/external-platforms/social-account-workflow.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { normalizePostCommentsRequest, buildPostCommentsDispatch, POST_COMMENTS_TRAVERSAL, POST_COMMENTS_PATH } from '../../server/contracts/post-comments.mjs'
import { normalizeCommentRepliesRequest, buildCommentRepliesDispatch, COMMENT_REPLIES_TRAVERSAL, COMMENT_REPLIES_PATH } from '../../server/contracts/comment-replies.mjs'

const { payload } = JSON.parse(readFileSync(new URL('../fixtures/threads-tikhub-comment-edges.json', import.meta.url), 'utf8'))
const [root, first, second] = payload.data.edges
const rootId = root.node.id, commentId = first.node.id, childId = second.node.id
const capturedAt = '2026-11-14T00:00:00.000Z'
const ended = { hasMore: false, nextParams: null, nextPage: null }

function project(body, { replies = false, targetId = replies ? commentId : rootId } = {}) {
  const request = replies
    ? normalizeCommentRepliesRequest({ platform: 'threads', commentId: targetId, contentId: rootId }, { provider: 'tikhub' })
    : normalizePostCommentsRequest({ platform: 'threads', contentId: targetId }, { provider: 'tikhub' })
  const step = replies ? buildCommentRepliesDispatch(request) : buildPostCommentsDispatch(request)
  assert.equal(step.key, 't.api_fe58186e16adc3bb')
  assert.deepEqual(step.upstreamQuery, { post_id: targetId })
  return projectPage(body, step, request.operation, capturedAt, replies ? COMMENT_REPLIES_TRAVERSAL : POST_COMMENTS_TRAVERSAL)
}

// The observed archive is a post-comment response. These explicit synthetic
// ancestor/parent relationships exercise reply semantics; they are not a live
// reply sample. Focus is the second item in each contextual source thread.
function replyPayload() {
  const target = structuredClone(first), child = structuredClone(second)
  target.node.thread_items[0].post.replied_to = { id: rootId }
  target.node.thread_items[0].post.root_post = { id: rootId }
  target.node.thread_items.unshift(structuredClone(root.node.thread_items[0]))
  const reply = child.node.thread_items[0].post
  reply.replied_to = { id: commentId }
  reply.root_post = { id: rootId }
  reply.text_post_app_info.reply_to_author = { username: 'fixture_commenter', id: '102' }
  child.node.thread_items.unshift(structuredClone(first.node.thread_items[0]))
  return { code: 200, data: { edges: [target, structuredClone(root), child], page_info: structuredClone(payload.data.page_info) } }
}

test('TikHub source edges pass the full comment projection and preserve counts, text and canonical records', () => {
  const result = project(payload), rows = result.projected.acquiredItems
  assert.deepEqual(rows.map(row => row.commentId), [commentId, childId])
  assert.deepEqual(result.projected.profiles, [])
  assert.deepEqual(result.projected.providerPage, ended)
  const row = rows[0]
  assert.equal(row.text, '合成评论第一行\n第二行')
  assert.equal(row.full_text, row.text)
  assert.equal(row.contentId, rootId)
  assert.equal(row.parentExternalId, rootId)
  assert.equal(row.parentCommentId, null)
  assert.equal(row.author.id, '102')
  assert.equal(row.author.handle, 'fixture_commenter')
  assert.equal(row.author.avatarUrl, 'https://example.invalid/avatar.png')
  assert.equal(row.publishedAt, '2023-11-14T22:13:21.000Z')
  assert.equal(row.likeCount, 0)
  assert.equal(row.replyCount, 1)
  assert.deepEqual(row.metrics, { likes: 0, replies: 1, shares: 0, quotes: 2, views: null, bookmarks: null })
  assert.equal(result.records.length, 2)
  assert.equal(result.records[0].body, row.text)
  assert.equal(result.records[0].stableFields.connectorId, 'external-platform:tikhub')
  assert.equal(result.records[0].stableFields.attributes.postId, rootId)
  assert.equal(result.records[0].rawItem.pk, commentId)
  const commentsOnly = structuredClone(payload)
  commentsOnly.data.edges.shift()
  assert.deepEqual(project(commentsOnly).projected.acquiredItems, rows, 'TikHub may omit the requested post context')
})

test('comment source threads focus node.id instead of returning an ancestor or the author continuation', () => {
  const body = structuredClone(payload)
  body.data.edges[1].node.thread_items.unshift(structuredClone(root.node.thread_items[0]))
  body.data.edges[1].node.thread_items.push({ post: { pk: '777', caption: { text: 'Synthetic self-thread continuation' } } })
  assert.deepEqual(project(body).projected.acquiredItems.map(row => row.commentId), [commentId, childId])
})

test('TikHub replies share the full projection while excluding the requested comment and its ancestors', () => {
  const result = project(replyPayload(), { replies: true })
  assert.deepEqual(result.projected.providerPage, ended)
  assert.deepEqual(result.projected.acquiredItems.map(row => [row.commentId, row.type, row.parentCommentId, row.rootCommentId, row.contentId]),
    [[childId, 'reply', commentId, commentId, rootId]])
  assert.equal(result.records.length, 1)
  assert.equal(result.records[0].stableFields.attributes.parentCommentId, commentId)
  assert.equal(result.records[0].stableFields.attributes.postId, rootId)
  assert.equal(result.records[0].rawItem.pk, childId)
})

test('explicitly contradictory Threads parent, root and focus identities reject both business projections', () => {
  for (const replies of [false, true]) {
    for (const [label, mutate] of Object.entries({
      parent: post => { post.replied_to = { id: '999' } },
      root: post => { post.root_post = { id: '999' } },
      replyFlag: post => { post.text_post_app_info.is_reply = false },
      parentHandle: post => { post.text_post_app_info.reply_to_author = { username: 'unrelated_author' } },
    })) {
      const body = replies ? replyPayload() : structuredClone(payload)
      mutate(body.data.edges.at(-1).node.thread_items.at(-1).post)
      assert.throws(() => project(body, { replies }), { code: 'invalid_upstream_contract' }, `${replies ? 'replies' : 'comments'} ${label}`)
    }
    const missingFocus = replies ? replyPayload() : structuredClone(payload)
    missingFocus.data.edges.at(-1).node.id = '999'
    assert.throws(() => project(missingFocus, { replies }), { code: 'invalid_upstream_contract' })
  }
})

test('every source edge is validated beyond the three rows sampled by structural diagnostics', () => {
  const body = structuredClone(payload)
  body.data.edges.push(structuredClone(first), { node: { id: '888', thread_items: [{ post: { caption: { text: 'No stable identity' } } }] } })
  assert.throws(() => project(body), { code: 'invalid_upstream_contract' })
})

test('empty edges and legacy TikHub comments remain valid, while missing/error collections fail closed', () => {
  for (const replies of [false, true]) {
    assert.deepEqual(project({ code: 200, data: { edges: [], page_info: { has_next_page: true, end_cursor: null } } }, { replies }).projected.acquiredItems, [])
    for (const body of [{ code: 400, data: { edges: [] } }, { code: 200, data: {} },
      { code: 200, data: { edges: null } }, { code: 200, data: { edges: [], status: 'error' } }]) {
      assert.throws(() => project(body, { replies }), { code: 'invalid_upstream_contract' })
    }
  }
  const legacy = { code: 200, data: { comments: [structuredClone(first.node.thread_items[0].post)] } }
  assert.deepEqual(project(legacy).projected.acquiredItems.map(row => row.commentId), [commentId])
  const noSupplierPagination = structuredClone(payload)
  noSupplierPagination.data.page_info.end_cursor = 'synthetic-source-token-not-supported-by-tikhub'
  assert.deepEqual(project(noSupplierPagination).projected.providerPage, ended)
})

async function deliveryHarness(t) {
  const store = new MemoryStore(), calls = []
  t.after(() => store.close())
  const pepper = 'threads-tikhub-comments-fixture-pepper', secret = 'synthetic-tikhub-comment-credential'
  const service = new HubService({ store, apiKeyPepper: pepper, adapter: { async legacySearch() { throw new Error('No legacy purchase') } } })
  const tenant = await service.createTenant({ name: 'Offline Threads TikHub comments' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Fixture caller' })
  await store.setPlatformGrant(consumer.id, 'threads', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'threads', maxRequests: 1000,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Fixture key', platforms: ['threads'], capabilities: ['social.comments.list'] })
  const context = await service.authenticate(key.secret)
  const config = { configured: true, contractVerified: true, nativeForwardingVerified: true, dispatchEnabled: true,
    timeoutMs: 100, freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 1000, billing: {} }
  const controls = new MemoryExternalPlatformControlStore(), endpoint = nativeForwardingEndpoint('t.api_fe58186e16adc3bb')
  await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline structural regression',
    priceBook: { currency: 'USD', pricingAsOf: capturedAt, monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [endpoint.endpointKey]: 1 } } }, { runtime: { config, credentialConfigured: true } })
  const adapter = new TikHubAdapter({ apiKey: secret, timeoutMs: 100, fetchImpl: async input => {
    const url = new URL(input)
    assert.equal(url.pathname, '/api/v1/threads/web/fetch_post_comments')
    assert.equal(url.searchParams.has('end_cursor'), false)
    const target = url.searchParams.get('post_id')
    assert.ok([rootId, commentId].includes(target))
    calls.push({ path: url.pathname, target })
    return Response.json(target === rootId ? payload : replyPayload())
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'threads' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub',
    apiKeyPepper: pepper, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  for (const route of ['post-comments', 'comment-replies']) await gateway.strategySearchRoutingStore.update(route, 'threads', {
    mode: 'fixed', primaryProvider: 'tikhub', fallbackProvider: null, expectedRevision: 1, reason: 'Offline TikHub regression' })
  return { calls, platformStore, invoke: (replies, body, idempotencyKey) => gateway[replies ? 'commentReplies' : 'postComments'](context,
    { platform: 'threads', path: replies ? COMMENT_REPLIES_PATH : POST_COMMENTS_PATH, body: { platform: 'threads', ...body }, idempotencyKey }) }
}

test('both TikHub business deliveries buy one source page, replay it and drain paid overflow without unsupported pagination', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('External network is forbidden in this fixture test') })
  const h = await deliveryHarness(t)
  for (const replies of [false, true]) {
    const body = replies ? { commentId, contentId: rootId, count: 20 } : { contentId: rootId, count: 1 }
    const identity = replies ? 'threads-tikhub-replies' : 'threads-tikhub-comments'
    const before = h.calls.length
    const firstPage = await h.invoke(replies, body, identity)
    assert.equal(firstPage.status, 200, JSON.stringify(firstPage.body))
    assert.equal(h.calls.length, before + 1)
    assert.deepEqual(firstPage.body.data.items.map(row => row.commentId), [replies ? childId : commentId])
    const originalCall = [...h.platformStore.calls.values()].find(row => row.usageRequestId === firstPage.body.requestId)
    assert.equal(originalCall.outcome, 'succeeded')
    assert.equal(originalCall.billed, true)
    assert.equal(originalCall.operation, 'native.t.api_fe58186e16adc3bb')
    assert.ok(h.platformStore.restrictedResponseArchives.has(originalCall.id))
    const replay = await h.invoke(replies, body, identity)
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, firstPage.body)
    assert.equal(h.calls.length, before + 1)
    const lastPage = replies ? firstPage : await h.invoke(false, { ...body, cursor: firstPage.body.data.page.nextCursor }, `${identity}-buffer`)
    assert.deepEqual(lastPage.body.data.items.map(row => row.commentId), [childId])
    assert.equal(lastPage.body.data.page.nextCursor, null)
    assert.equal(lastPage.body.data.page.hasMore, false)
    assert.equal(h.calls.length, before + 1, 'Source has_next_page without usable supported pagination must not purchase another page')
  }
})
