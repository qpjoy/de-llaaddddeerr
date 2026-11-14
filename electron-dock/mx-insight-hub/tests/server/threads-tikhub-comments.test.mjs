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

async function deliveryHarness(t, { fetchResponse, signal, enforced = false, reservationLeaseMs = 150000 } = {}) {
  const store = new MemoryStore(), calls = []
  t.after(() => store.close())
  const pepper = 'threads-tikhub-comments-fixture-pepper', secret = 'synthetic-tikhub-comment-credential'
  const service = new HubService({ store, apiKeyPepper: pepper, adapter: { async legacySearch() { throw new Error('No legacy purchase') } } })
  const tenant = await service.createTenant({ name: 'Offline Threads TikHub comments' })
  if (enforced) {
    await service.setTenantBillingProfile(tenant.id, { mode: 'enforced', defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'fixture')
    await service.addTenantCredit(tenant.id, { amountMinor: 10, currency: 'CNY', reason: 'Offline retry regression' },
      { idempotencyKey: 'threads-comments-fixture-credit', actor: 'fixture' })
  }
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
    const call = { path: url.pathname, target, at: performance.now() }
    calls.push(call)
    return fetchResponse ? fetchResponse(call, calls.length) : Response.json(target === rootId ? payload : replyPayload())
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'threads' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub',
    apiKeyPepper: pepper, reservationLeaseMs, operationControlStore: controls, logger: { warn() {} } })
  for (const route of ['post-comments', 'comment-replies']) await gateway.strategySearchRoutingStore.update(route, 'threads', {
    mode: 'fixed', primaryProvider: 'tikhub', fallbackProvider: null, expectedRevision: 1, reason: 'Offline TikHub regression' })
  return { calls, platformStore, store, gateway, controls, context, invoke: (replies, body, idempotencyKey, requestSignal = signal) => gateway[replies ? 'commentReplies' : 'postComments'](context,
    { platform: 'threads', path: replies ? COMMENT_REPLIES_PATH : POST_COMMENTS_PATH, body: { platform: 'threads', ...body }, idempotencyKey, signal: requestSignal }) }
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

// Exact supplier rejection observed in the restricted archive. The wording is
// retry evidence only: its claim must never change billed:null into billed:false.
const noChargeClaim = "Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support. You won't be charged for this request."
const retryRefusal = (nested = true) => Response.json(nested
  ? { detail: { code: 400, message: noChargeClaim } } : { code: 400, message: noChargeClaim }, { status: 400 })
const retryBody = replies => replies ? { commentId, contentId: rootId, count: 20 } : { contentId: rootId, count: 20 }
const providerCalls = h => [...h.platformStore.calls.values()].sort((a, b) => a.callOrdinal - b.callOrdinal)

async function rejectionOf(promise, outcome = 'rejected') {
  let saved
  await assert.rejects(promise, error => {
    assert.equal(error.details.outcome, outcome)
    assert.ok(error.details.requestId)
    saved = { status: error.status, code: error.code, message: error.message, details: structuredClone(error.details) }
    return true
  })
  return saved
}

function assertReleasedCapacity(h) {
  assert.equal(h.gateway.active, 0)
  assert.equal(h.platformStore.leases.size, 0)
}

test('Threads comments and replies retry only their refused source page with bounded exponential delays and one customer charge', { concurrency: true }, async t => {
  await Promise.all([false, true].map(replies => t.test(replies ? 'replies' : 'comments', async t => {
    const h = await deliveryHarness(t, { enforced: true, fetchResponse: (call, ordinal) => ordinal < 3
      ? retryRefusal(ordinal === 1) : Response.json(call.target === rootId ? payload : replyPayload()) })
    const body = retryBody(replies), key = `threads-retry-success-${replies}`
    const result = await h.invoke(replies, body, key)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.deepEqual(result.body.data.items.map(row => row.commentId), replies ? [childId] : [commentId, childId])
    assert.equal(result.body.data.meta.providerCalls, 3)
    assert.equal(result.body.data.meta.upstreamPages, 1, 'rejected attempts are not additional source pages')
    const calls = providerCalls(h)
    assert.deepEqual(calls.map(call => [call.callOrdinal, call.callRole, call.outcome, call.billed]),
      [[0, 'primary', 'rejected', null], [1, 'retry', 'rejected', null], [2, 'retry', 'succeeded', true]])
    assert.deepEqual([...new Set(calls.map(call => call.usageRequestId))], [result.requestId])
    assert.deepEqual(h.calls.map(call => call.target), Array(3).fill(replies ? commentId : rootId))
    for (let index = 1; index < h.calls.length; index++) {
      const elapsed = h.calls[index].at - h.calls[index - 1].at
      assert.ok(elapsed >= index * 1000 - 10, `attempt ${index + 1} waited ${elapsed} ms`)
      // Allow scheduler overhead while guarding an accidental unbounded wait.
      assert.ok(elapsed < index * 1000 + 2000, `attempt ${index + 1} waited ${elapsed} ms`)
    }
    assert.equal(h.platformStore.restrictedResponseArchives.size, 3)
    for (const [index, call] of calls.entries()) {
      const archive = h.platformStore.restrictedResponseArchives.get(call.id)
      assert.ok(archive)
      const raw = JSON.parse(archive.bodyBytes.toString('utf8'))
      assert.equal(index < 2 ? (raw.detail ?? raw).message : raw.code, index < 2 ? noChargeClaim : 200)
    }
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.equal(h.store.requests.size, 1)
    assert.equal(h.store.requests.get(result.requestId).status, 'committed')
    assert.equal(h.store.customerCharges.size, 1)
    const charge = structuredClone(h.store.customerCharges.get(result.requestId))
    assert.equal(charge.status, 'captured')
    assert.equal(charge.chargedMinor, 1)
    const replay = await h.invoke(replies, body, key)
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, result.body)
    assert.equal(h.calls.length, 3)
    assert.deepEqual(h.store.customerCharges.get(result.requestId), charge)
    assertReleasedCapacity(h)
  })))
})

test('Threads comments and replies exhaust exactly three attempts and replay the last definite refusal', { concurrency: true }, async t => {
  await Promise.all([false, true].map(replies => t.test(replies ? 'replies' : 'comments', async t => {
    const h = await deliveryHarness(t, { fetchResponse: () => retryRefusal() })
    const body = retryBody(replies), key = `threads-retry-exhausted-${replies}`
    const failure = await rejectionOf(h.invoke(replies, body, key))
    assert.equal(failure.code, 'external_platform_rejected')
    assert.deepEqual(failure.details.upstream, { httpStatus: 400, businessCode: 400 })
    assert.equal(h.calls.length, 3)
    assert.deepEqual(providerCalls(h).map(call => [call.callOrdinal, call.callRole, call.outcome, call.billed]),
      [[0, 'primary', 'rejected', null], [1, 'retry', 'rejected', null], [2, 'retry', 'rejected', null]])
    assert.equal(h.platformStore.restrictedResponseArchives.size, 3)
    assert.equal(h.platformStore.ingestJobs.length, 0)
    assert.equal(h.store.requests.size, 1)
    assert.equal(h.store.requests.get(failure.details.requestId).status, 'committed')
    assert.deepEqual(await rejectionOf(h.invoke(replies, body, key)), failure)
    assert.equal(h.calls.length, 3)
    assertReleasedCapacity(h)
  })))
})

test('ordinary errors, modified no-charge claims and paid unusable pages do not acquire another Threads page', { concurrency: true }, async t => {
  const cases = [
    ['ordinary-400', () => Response.json({ detail: { code: 400, message: 'Invalid post_id' } }, { status: 400 }), 'rejected'],
    ['modified-claim', () => Response.json({ detail: { code: 400, message: `${noChargeClaim} extra` } }, { status: 400 }), 'rejected'],
    ['unauthorized', () => Response.json({ detail: { code: 401, message: noChargeClaim } }, { status: 401 }), 'rejected'],
    ['server-error', () => Response.json({ detail: { code: 400, message: noChargeClaim } }, { status: 503 }), 'unknown'],
    ['transport', () => { throw new TypeError('Synthetic connection loss') }, 'unknown'],
    ['unusable', () => Response.json({ code: 200, data: {} }), 'succeeded_unusable'],
  ]
  await Promise.all(cases.map(([name, fetchResponse, outcome]) => t.test(name, async t => {
    const h = await deliveryHarness(t, { fetchResponse })
    const failure = await rejectionOf(h.invoke(false, retryBody(false), `threads-no-retry-${name}`), outcome)
    assert.equal(h.calls.length, 1)
    assert.equal(providerCalls(h).length, 1)
    assert.equal(providerCalls(h)[0].outcome, outcome)
    assert.equal(h.store.requests.get(failure.details.requestId).status, outcome === 'unknown' ? 'unknown' : 'committed')
    assert.equal(h.platformStore.ingestJobs.length, 0)
    assertReleasedCapacity(h)
  })))
})

test('cancellation, paused routes and an insufficient deadline preserve the last refusal without another dispatch', { concurrency: true }, async t => {
  await Promise.all(['cancelled', 'paused', 'deadline'].map(reason => t.test(reason, async t => {
    const controller = new AbortController()
    let h, timer
    t.after(() => clearTimeout(timer))
    h = await deliveryHarness(t, { signal: controller.signal, reservationLeaseMs: reason === 'deadline' ? 5600 : 150000,
      fetchResponse: async () => {
        if (reason === 'cancelled') timer = setTimeout(() => controller.abort(), 25)
        if (reason === 'paused') await h.gateway.strategySearchRoutingStore.update('post-comments', 'threads', {
          mode: 'paused', primaryProvider: 'tikhub', fallbackProvider: null, expectedRevision: 2, reason: 'Paused during the first supplier call' })
        return retryRefusal()
      } })
    const key = `threads-retry-stopped-${reason}`, body = retryBody(false)
    const failure = await rejectionOf(h.invoke(false, body, key))
    assert.equal(failure.code, 'external_platform_rejected')
    assert.equal(h.calls.length, 1)
    assert.equal(h.store.requests.get(failure.details.requestId).status, 'committed')
    assert.deepEqual(providerCalls(h).map(call => [call.outcome, call.billed]), [['rejected', null]])
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
    assert.deepEqual(await rejectionOf(h.invoke(false, body, key, new AbortController().signal)), failure)
    assert.equal(h.calls.length, 1)
    assertReleasedCapacity(h)
  })))
})

test('an unknown second attempt replaces the earlier refusal and is never retried again', async t => {
  const h = await deliveryHarness(t, { fetchResponse: (_call, ordinal) => {
    if (ordinal === 1) return retryRefusal()
    throw new TypeError('Synthetic connection loss after retry')
  } })
  const failure = await rejectionOf(h.invoke(false, retryBody(false), 'threads-retry-became-unknown'), 'unknown')
  assert.equal(h.calls.length, 2)
  assert.deepEqual(providerCalls(h).map(call => [call.callRole, call.outcome, call.billed]),
    [['primary', 'rejected', null], ['retry', 'unknown', null]])
  assert.equal(h.store.requests.get(failure.details.requestId).status, 'unknown')
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1, 'a lost transport response has no invented archive')
  assertReleasedCapacity(h)
})
