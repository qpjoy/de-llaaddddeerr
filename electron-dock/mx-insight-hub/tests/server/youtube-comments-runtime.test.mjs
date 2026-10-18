import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { createRuntime } from '../../server/index.mjs'
import { loadConfig } from '../../server/config.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { YOUTUBE_COMMENT_PATHS, YOUTUBE_COMMENTS_CAPABILITY } from '../../server/contracts/youtube-comments.mjs'

const VIDEO = 'dQw4w9WgXcQ', CHANNEL = 'UC' + 'a'.repeat(22)
const PROVIDER_PATHS = ['/api/v1/youtube/web_v2/get_channel_id',
  '/api/v1/youtube/web_v2/get_channel_videos', '/api/v1/youtube/web_v2/get_video_comments']
const BODY = {
  video: { videoId: VIDEO, maxComments: 5 },
  channel: { channelUrl: 'https://www.youtube.com/@fixture', maxVideos: 1, maxComments: 5 },
}

async function serve(t, app) {
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}

async function harness(t) {
  const localFetch = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'Runtime tests must never contact suppliers')
    return localFetch(url, options)
  })
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'youtube-runtime-fixture-pepper-at-least-32-characters',
    MX_INSIGHT_TIKHUB_API_KEY: 'synthetic-youtube-runtime-credential',
    MX_INSIGHT_TIKHUB_MAX_REQUESTS_PER_MINUTE: '1000', MX_INSIGHT_TIKHUB_RATE_LIMIT_BURST: '10' }))
  t.after(async () => { runtime.agent.close(); await runtime.store.close() })
  const calls = [], gateways = []
  const adapter = new TikHubAdapter({ apiKey: 'synthetic-youtube-runtime-credential', fetchImpl: async url => {
    const parsed = new URL(url)
    calls.push({ path: parsed.pathname, params: Object.fromEntries(parsed.searchParams) })
    assert(PROVIDER_PATHS.includes(parsed.pathname))
    if (parsed.pathname.endsWith('get_channel_id')) return Response.json({ code: 200, data: { channel_id: CHANNEL } })
    if (parsed.pathname.endsWith('get_channel_videos')) return Response.json({ code: 200,
      data: { videos: [{ video_id: VIDEO, title: 'Synthetic video' }], continuation_token: null } })
    return Response.json({ code: 200, data: { comments: [{ comment_id: 'synthetic-comment-1', content: 'Synthetic comment',
      author: { channel_id: CHANNEL, display_name: 'Synthetic author' } }], continuation_token: null } })
  } })
  // Memory runtimes deliberately omit provider adapters. Supply only transport;
  // leave the app's actual gateway selection, stores and workflow unchanged.
  const youtubeComments = ExternalPlatformGateway.prototype.youtubeComments
  t.mock.method(ExternalPlatformGateway.prototype, 'youtubeComments', function (context, input) {
    this.adapter = adapter
    gateways.push(this)
    return youtubeComments.call(this, context, input)
  })
  const { service, store, externalPlatformControlStore: controls } = runtime
  const tenant = await service.createTenant({ name: 'Synthetic YouTube runtime' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Synthetic comments caller' })
  await store.setPlatformGrant(consumer.id, 'youtube', true)
  await service.putCapabilityConfiguration(YOUTUBE_COMMENTS_CAPABILITY, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Comments', platforms: ['youtube'], capabilities: [YOUTUBE_COMMENTS_CAPABILITY] })
  const deniedKey = await service.createApiKey({ consumerId: consumer.id, name: 'No comments', platforms: ['youtube'], capabilities: [] })
  const config = runtime.socialAccountDataGateways.youtube.config
  for (const endpoint of NATIVE_FORWARDING_ENDPOINTS.filter(row => row.provider === 'tikhub' && PROVIDER_PATHS.includes(row.path))) {
    await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Synthetic runtime regression',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-17T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
        unitCostMinorByEndpoint: { [endpoint.endpointKey]: 2 } } }, { runtime: { config, credentialConfigured: true } })
  }
  const base = await serve(t, runtime.app)
  const post = async (kind, { secret = key.secret, origin = base, idempotencyKey = `youtube-runtime-${kind}` } = {}) => {
    const response = await fetch(origin + YOUTUBE_COMMENT_PATHS[kind], { method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(BODY[kind]) })
    return { response, body: await response.json() }
  }
  return { runtime, calls, gateways, key, deniedKey, post }
}

for (const kind of ['video', 'channel']) test(`runtime ${kind} comments preserve YouTube usage, procurement and evidence scopes`, async t => {
  const h = await harness(t)
  const first = await h.post(kind)
  if (first.response.status !== 200) t.diagnostic(JSON.stringify({ error: first.body.error,
    calls: h.calls.length, requests: [...h.runtime.store.requests.values()].map(({ platform, status, responseStatus, errorCode }) => ({ platform, status, responseStatus, errorCode })) }))
  assert.equal(first.response.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.data.items.length, 1, JSON.stringify(first.body))
  assert.equal(first.body.data.items[0].commentId, 'synthetic-comment-1')
  const expectedCalls = kind === 'video' ? 1 : 3
  assert.equal(h.calls.length, expectedCalls)
  const gateway = h.gateways[0], platformStore = gateway.platformStore
  assert.equal(gateway, h.runtime.socialAccountDataGateways.youtube)
  assert.equal(platformStore.authorizationPlatform, 'youtube')
  const usage = h.runtime.store.requests.get(first.body.requestId)
  assert.equal(usage.platform, 'youtube')
  assert.equal(usage.status, 'committed')
  assert.equal(platformStore.calls.size, expectedCalls)
  assert.equal(platformStore.restrictedResponseArchives.size, expectedCalls)
  assert.equal(platformStore.costReservations.size, expectedCalls)
  assert.equal(platformStore.ingestJobs.length, expectedCalls)
  for (const call of platformStore.calls.values()) {
    assert.equal(call.usageRequestId, usage.id)
    assert.equal(call.providerKey, 'tikhub')
    assert.equal(call.outcome, 'succeeded')
    const archive = platformStore.restrictedResponseArchives.get(call.id)
    assert.equal(archive.bodySha256, createHash('sha256').update(archive.bodyBytes).digest('hex'))
  }
  for (const reservation of platformStore.costReservations.values()) assert.equal(reservation.usageRequestId, usage.id)
  for (const job of platformStore.ingestJobs) assert.equal(job.payload.platform, 'youtube')
  const replay = await h.post(kind)
  assert.equal(replay.response.status, 200)
  assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
  assert.deepEqual(replay.body, first.body)
  assert.equal(h.calls.length, expectedCalls)
})

test('runtime comments deny a Key without the capability before provider dispatch', async t => {
  const h = await harness(t)
  for (const kind of ['video', 'channel']) {
    const result = await h.post(kind, { secret: h.deniedKey.secret })
    assert.equal(result.response.status, 403)
    assert.equal(result.body.error.code, 'capability_not_granted')
  }
  assert.equal(h.calls.length, 0)
  assert.equal(h.runtime.socialAccountDataGateways.youtube.platformStore.costReservations.size, 0)
})

test('missing dedicated comments gateway fails closed without using the generic social gateway', async t => {
  const h = await harness(t)
  let socialCalls = 0
  const origin = await serve(t, createApp({ service: h.runtime.service, store: h.runtime.store,
    adapter: h.runtime.adapter, listenerMode: 'public', logger: { error() {} },
    socialAccountTikHubGateway: { async youtubeComments() {
      socialCalls++
      return { status: 200, body: {}, replay: false, requestId: '11111111-1111-4111-8111-111111111111', sourceMode: 'live' }
    } },
  }))
  for (const kind of ['video', 'channel']) {
    const result = await h.post(kind, { origin })
    assert.equal(result.response.status, 503)
    assert.equal(result.body.error.code, 'external_platform_unavailable')
  }
  assert.equal(socialCalls, 0)
  assert.equal(h.calls.length, 0)
})

test('a proven pre-dispatch scope failure can reuse its released key after correcting the gateway', async t => {
  const h = await harness(t), { runtime } = h
  const correct = runtime.socialAccountDataGateways.youtube
  const wrong = new ExternalPlatformGateway({ usageStore: runtime.store,
    platformStore: new MemoryExternalPlatformStore({ usageStore: runtime.store, providerKey: 'tikhub', authorizationPlatform: 'social' }),
    config: correct.config, providerKey: 'tikhub', apiKeyPepper: correct.apiKeyPepper, reservationLeaseMs: correct.reservationLeaseMs,
    operationControlStore: runtime.externalPlatformControlStore, credentialStore: runtime.tikHubCredentialStore })
  const origin = await serve(t, createApp({ service: runtime.service, store: runtime.store, adapter: runtime.adapter,
    listenerMode: 'public', logger: { error() {} }, youtubeCommentsGateway: wrong }))
  const failed = await h.post('channel', { origin })
  assert.equal(failed.response.status, 409)
  assert.equal(failed.body.error.code, 'external_platform_usage_scope_mismatch')
  assert.equal(h.calls.length, 0)
  assert.equal(wrong.platformStore.calls.size, 0)
  assert.equal(wrong.platformStore.costReservations.size, 0)
  const original = structuredClone(runtime.store.requests.get(failed.body.requestId))
  assert.equal(original.status, 'released')
  assert.equal(original.responseStatus, null)
  assert.equal(original.errorCode, 'external_platform_pre_dispatch_failed')

  const recovered = await h.post('channel')
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.body))
  assert.notEqual(recovered.body.requestId, original.id)
  assert.equal(h.calls.length, 3)
  assert.deepEqual(runtime.store.requests.get(original.id), original, 'Recovery must preserve the original failure evidence')
  assert.deepEqual((await h.post('channel')).body, recovered.body)
  assert.equal(h.calls.length, 3)
})
