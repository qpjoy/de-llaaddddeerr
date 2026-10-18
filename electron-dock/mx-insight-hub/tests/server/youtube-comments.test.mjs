import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { normalizeYoutubeCommentsRequest, buildYoutubeCommentsDispatch, projectYoutubeCommentsPage,
  YOUTUBE_COMMENT_PATHS } from '../../server/contracts/youtube-comments.mjs'

const PEPPER = 'offline-youtube-comment-regression-long-pepper'
const SECRET = 'synthetic-youtube-comment-provider-credential'
const VIDEO = 'dQw4w9WgXcQ', VIDEO2 = '9bZkp7q19f0', CHANNEL = 'UC' + 'a'.repeat(22)
const comment = id => ({ comment_id: id, content: `完整评论 ${id}`, published_time: '2 days ago',
  like_count: '0', reply_count: '3', reply_continuation_token: 'not-automatically-fetched',
  author: { channel_id: CHANNEL, display_name: '作者', channel_url: `https://www.youtube.com/channel/${CHANNEL}` } })
const comments = (ids, continuation_token = null) => ({ code: 200, data: { comments: ids.map(comment), continuation_token } })
const videos = (ids, continuation_token = null) => ({ code: 200, data: { videos: ids.map(video_id => ({ video_id, title: `视频 ${video_id}` })), continuation_token } })

async function harness({ fetchImpl, grant = true, controlsEnabled = true, maxPageSize = 100 } = {}) {
  const calls = [], store = new MemoryStore()
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: {
    async legacySearch() { throw new Error('Night-All must never be called') }, async search() { throw new Error('Night-All must never be called') },
  } })
  const tenant = await service.createTenant({ name: 'Offline YouTube' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Comments caller' })
  await store.setPlatformGrant(consumer.id, 'youtube', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'youtube', maxRequests: 10000, windowSeconds: 3600, maxPageSize, maxCrawlWork: 1000 })
  await service.putCapabilityConfiguration('social.comments.list', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic comments key', platforms: ['youtube'], capabilities: grant ? ['social.comments.list'] : [] })
  const context = await service.authenticate(key.secret)
  const config = { configured: true, contractVerified: true, nativeForwardingVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 1000, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  for (const endpoint of NATIVE_FORWARDING_ENDPOINTS.filter(row => row.provider === 'tikhub' && ['/api/v1/youtube/web_v2/get_channel_id', '/api/v1/youtube/web_v2/get_channel_videos', '/api/v1/youtube/web_v2/get_video_comments'].includes(row.path))) {
    if (controlsEnabled) await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Synthetic comments regression',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-17T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
        unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } }, { runtime: { config, credentialConfigured: true } })
  }
  const adapter = new TikHubAdapter({ apiKey: SECRET, timeoutMs: 100, fetchImpl: async (url, options) => {
    const parsed = new URL(url), call = { path: parsed.pathname, params: Object.fromEntries(parsed.searchParams), options }
    calls.push(call)
    return fetchImpl ? fetchImpl(call, calls.length) : Response.json(comments(['1']))
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'youtube' })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub', apiKeyPepper: PEPPER,
    reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  const invoke = (body = { videoId: VIDEO }, idempotencyKey = 'youtube-comments-first-page', kind = 'video', activeContext = context) => gateway.youtubeComments(activeContext,
    { kind, body, idempotencyKey, path: YOUTUBE_COMMENT_PATHS[kind] })
  return { calls, store, service, controls, platformStore, gateway, context, invoke }
}

test('YouTube input normalizes safe video aliases and rejects conflicts, arbitrary URLs and unbounded requests', () => {
  const request = normalizeYoutubeCommentsRequest('video', { videoId: VIDEO, url: `https://youtu.be/${VIDEO}`, count: 10 })
  assert.equal(request.videoId, VIDEO); assert.equal(request.maxComments, 10)
  for (const body of [{ videoId: VIDEO, postId: VIDEO2 }, { url: 'https://evil.test/watch?v=' + VIDEO }, { videoId: VIDEO, maxComments: 1000 },
    { videoId: VIDEO, params: { endpoint: '/arbitrary' } }, { videoId: VIDEO, maxComments: 5, count: 10 }, { videoId: VIDEO, params: { sortBy: 'newest' }, sort_by: 'top' }]) {
    assert.throws(() => normalizeYoutubeCommentsRequest('video', body), { code: 'invalid_youtube_comments_request' })
  }
  assert.throws(() => normalizeYoutubeCommentsRequest('channel', { channelUrl: `https://www.youtube.com/watch?v=${VIDEO}` }), { code: 'invalid_youtube_comments_request' })
  assert.throws(() => normalizeYoutubeCommentsRequest('channel', { channelId: CHANNEL, channelUrl: 'https://www.youtube.com/@different' }), { code: 'invalid_youtube_comments_request' })
  assert.deepEqual(normalizeYoutubeCommentsRequest('channel', { channelId: CHANNEL }).fingerprintBody,
    normalizeYoutubeCommentsRequest('channel', { channelUrl: `https://www.youtube.com/channel/${CHANNEL}` }).fingerprintBody)
})

test('single-video comments use one reviewed TikHub request, complete evidence, true comment records and immutable replay', async () => {
  const h = await harness()
  const first = await h.invoke({ postId: VIDEO, maxComments: 5 })
  assert.equal(first.status, 200); assert.equal(first.body.data.items[0].content, '完整评论 1')
  assert.equal(first.body.data.items[0].likeCount, 0); assert.equal(first.body.data.items[0].publishedAt, null)
  assert.equal(h.calls[0].path, '/api/v1/youtube/web_v2/get_video_comments')
  assert.equal(h.calls[0].params.video_id, VIDEO); assert.equal(h.calls[0].params.need_format, 'true')
  assert.equal(h.calls.length, 1); assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  const receipt = [...h.platformStore.restrictedResponseArchives.values()][0]
  assert.equal(receipt.bodySha256, createHash('sha256').update(receipt.bodyBytes).digest('hex'))
  const jobs = h.platformStore.ingestJobs
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].payload.datasetId, 'social.comments.v1')
  assert.equal(jobs[0].payload.records[0].objectType, 'comment')
  assert.equal(jobs[0].payload.records[0].stableFields.attributes.parentExternalId, VIDEO)
  assert.equal(jobs[0].payload.records[0].rawItem.reply_continuation_token, 'not-automatically-fetched')
  assert.deepEqual((await h.invoke({ postId: VIDEO, maxComments: 5 })).body, first.body)
  assert.equal(h.calls.length, 1)
})

test('includeRaw only changes public presentation, never the canonical comment identity or revision', () => {
  const payload = comments(['stable']), capturedAt = '2026-10-17T00:00:00.000Z'
  const project = includeRaw => {
    const request = normalizeYoutubeCommentsRequest('video', { videoId: VIDEO, includeRaw })
    return projectYoutubeCommentsPage(payload, buildYoutubeCommentsDispatch(request, {}), { capturedAt })
  }
  const plain = project(false), withRaw = project(true)
  assert.equal(plain.projected.acquiredItems[0].raw, undefined)
  assert.deepEqual(withRaw.projected.acquiredItems[0].raw, payload.data.comments[0])
  assert.deepEqual(withRaw.records, plain.records)
})

test('paid comment overflow drains across identity-scoped cursors without repurchase or lost rows', async () => {
  const h = await harness({ fetchImpl: () => Response.json(comments(['1', '2', '3', '4', '5'])) })
  const body = { videoId: VIDEO, maxComments: 2 }
  const first = await h.invoke(body), second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'youtube-page-two')
  const third = await h.invoke({ ...body, cursor: second.body.data.page.nextCursor }, 'youtube-page-three')
  assert.deepEqual([first, second, third].flatMap(row => row.body.data.items.map(item => item.commentId)), ['1', '2', '3', '4', '5'])
  assert.equal(h.calls.length, 1); assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(third.body.data.page.hasMore, false)
  await assert.rejects(h.invoke({ ...body, videoId: VIDEO2, cursor: first.body.data.page.nextCursor }, 'youtube-wrong-scope'), { code: 'invalid_cursor' })
  await assert.rejects(h.invoke({ ...body, maxComments: 3, cursor: first.body.data.page.nextCursor }, 'youtube-wrong-limit'), { code: 'invalid_cursor' })
})

test('channel screenshot shape resolves once, archives full video page and enforces maxComments across selected videos', async () => {
  const h = await harness({ fetchImpl: call => Response.json(call.path.endsWith('get_channel_id') ? { code: 200, data: { channel_id: CHANNEL } }
    : call.path.endsWith('get_channel_videos') ? videos([VIDEO, VIDEO2, 'abcdefghijk'])
      : comments(call.params.video_id === VIDEO ? ['a', 'b'] : ['c', 'd'])) })
  const body = { channelUrl: 'https://www.youtube.com/@fixture', maxVideos: 2, maxComments: 3 }
  const first = await h.invoke(body, 'youtube-channel-one', 'channel')
  assert.deepEqual(first.body.data.items.map(row => row.commentId), ['a', 'b', 'c'])
  assert.equal(first.body.data.results.length, 2); assert.equal(first.body.data.page.hasMore, true)
  assert.equal(JSON.parse(first.body.data.raw_data).length, 3)
  assert.equal(h.calls.length, 4)
  assert.equal(first.body.data.meta.channelHasMoreVideos, true)
  assert.equal(h.platformStore.ingestJobs[1].payload.records.length, 3)
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'youtube-channel-two', 'channel')
  assert.deepEqual(second.body.data.items.map(row => row.commentId), ['d'])
  assert.equal(h.calls.length, 4); assert.equal(second.body.data.page.hasMore, false)
})

test('empty channel is a retained successful discovery and never fabricates a comment call', async () => {
  const h = await harness({ fetchImpl: () => Response.json(videos([])) })
  const result = await h.invoke({ channelId: CHANNEL, maxVideos: 5, maxComments: 50 }, 'youtube-empty-channel', 'channel')
  assert.deepEqual(result.body.data.items, []); assert.equal(result.body.data.page.hasMore, false)
  assert.equal(h.calls.length, 1)
})

test('repeated comment cursors stop while preserving acquired rows; hard data-page cap is fifteen', async () => {
  let pages = 0
  const h = await harness({ fetchImpl: () => Response.json(comments([String(++pages)], 'repeat')) })
  const result = await h.invoke({ videoId: VIDEO, maxComments: 100 })
  assert.equal(h.calls.length, 2); assert.equal(result.body.data.items.length, 2)
  assert.equal(result.body.data.page.hasMore, false)
  const cap = await harness({ fetchImpl: (_call, n) => Response.json(comments([String(n)], 'token-' + n)) })
  const bounded = await cap.invoke({ videoId: VIDEO, maxComments: 100 })
  assert.equal(cap.calls.length, 15); assert.equal(bounded.body.data.items.length, 15)
  assert.ok(bounded.body.data.warnings.some(row => row.code === 'upstream_page_limit_reached'))
})

test('grants and disabled constituent operation reject before paid dispatch; unknown transport is never retried', async () => {
  const denied = await harness({ grant: false })
  await assert.rejects(denied.invoke(), { code: 'capability_not_granted' }); assert.equal(denied.calls.length, 0)
  const disabled = await harness({ controlsEnabled: false })
  await assert.rejects(disabled.invoke()); assert.equal(disabled.calls.length, 0)
  const unknown = await harness({ fetchImpl: () => { throw new TypeError('offline transport lost') } })
  await assert.rejects(unknown.invoke(), { code: 'upstream_outcome_unknown' })
  await assert.rejects(unknown.invoke()); assert.equal(unknown.calls.length, 1)
})

test('malformed paid comments are archived as unusable rather than accepted as empty', async () => {
  const h = await harness({ fetchImpl: () => Response.json({ code: 200, data: { comments: [{ content: 'missing stable identity' }], continuation_token: null } }) })
  await assert.rejects(h.invoke(), { code: 'external_platform_response_unusable' })
  assert.equal(h.calls.length, 1); assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded_unusable')
})

test('rate admission after discovery returns partial and resumes comments without repeating channel calls', async () => {
  const h = await harness({ fetchImpl: call => Response.json(call.path.endsWith('get_channel_videos') ? videos([VIDEO]) : comments(['1'])) })
  const original = h.platformStore.acquireProviderRateLimit.bind(h.platformStore)
  h.platformStore.acquireProviderRateLimit = async input => h.calls.length ? { allowed: false } : original(input)
  const body = { channelId: CHANNEL, maxComments: 10, maxVideos: 1 }
  const first = await h.invoke(body, 'youtube-rate-one', 'channel')
  assert.equal(first.body.data.status, 'partial'); assert.equal(first.body.data.items.length, 0)
  assert.equal(first.body.data.page.hasMore, true); assert.equal(h.calls.length, 1)
  h.platformStore.acquireProviderRateLimit = original
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'youtube-rate-two', 'channel')
  assert.equal(second.body.data.items.length, 1); assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].path, '/api/v1/youtube/web_v2/get_video_comments')
})

test('comments buffers cannot cross Keys or resume after current grants are revoked', async () => {
  const h = await harness({ fetchImpl: () => Response.json(comments(['1', '2'])) })
  const body = { videoId: VIDEO, maxComments: 1 }, first = await h.invoke(body)
  const key = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Sibling', platforms: ['youtube'], capabilities: ['social.comments.list'] })
  const sibling = await h.service.authenticate(key.secret)
  await assert.rejects(h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'youtube-sibling', 'video', sibling), { code: 'invalid_cursor' })
  await h.store.setPlatformGrant(h.context.consumer.id, 'youtube', false)
  await assert.rejects(h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'youtube-revoked'), { code: 'platform_not_granted' })
  assert.equal(h.calls.length, 1)
})

test('credential echoes are excluded from raw items and canonical rows; unsafe archived overflow fails closed', async () => {
  const h = await harness({ fetchImpl: () => Response.json({ code: 200, data: { comments: ['1', '2'].map(id => ({ ...comment(id), content: `${SECRET}正文`, secretEcho: SECRET })), continuation_token: null } }) })
  const body = { videoId: VIDEO, maxComments: 1, includeRaw: true }, first = await h.invoke(body)
  await assert.rejects(h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'youtube-redaction-two'), { code: 'search_page_unavailable' })
  assert.ok(first.body.data.items[0].raw); assert.ok(!JSON.stringify([first.body, h.platformStore.ingestJobs]).includes(SECRET))
  assert.equal(h.calls.length, 1)
})

test('five video discovery pages bound an advancing empty channel traversal', async () => {
  const h = await harness({ fetchImpl: (_call, n) => Response.json(videos([], 'channel-' + n)) })
  const result = await h.invoke({ channelId: CHANNEL }, 'youtube-empty-advancing', 'channel')
  assert.equal(h.calls.length, 5); assert.equal(result.body.data.status, 'partial')
  assert.equal(result.body.data.page.hasMore, false)
  assert.ok(result.body.data.warnings.some(row => row.code === 'channel_video_discovery_partial'))
})

test('comment overlap is deduplicated with measured duplicate counts rather than silently shortening the page', async () => {
  const h = await harness({ fetchImpl: (_call, n) => Response.json(n === 1 ? comments(['1', '1'], 'next') : comments(['1', '2'])) })
  const result = await h.invoke({ videoId: VIDEO, maxComments: 10 })
  assert.deepEqual(result.body.data.items.map(row => row.commentId), ['1', '2'])
  assert.equal(result.body.data.page.duplicateCount, 2)
  assert.equal(result.body.data.meta.duplicateCount, 2)
})
