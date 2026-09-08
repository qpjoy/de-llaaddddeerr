import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { TikHubAdapter, TikHubUpstreamError } from '../../server/adapters/tikhub.mjs'
import { createApp } from '../../server/app.mjs'
import {
  isTikHubXiaohongshuUnavailable,
  redactTikHubEnvelope,
  TIKHUB_PROVIDER_KEY,
  TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
  TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
  XIAOHONGSHU_POST_OPERATION,
} from '../../server/contracts/tikhub-xiaohongshu.mjs'
import { TikHubGateway } from '../../server/external-platforms/tikhub-gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const PEPPER = 'tikhub-xiaohongshu-test-pepper-with-entropy'
const PROVIDER_KEY = 'provider-key-used-only-by-the-fake-fetch'
const NOTE_ID = '697c0eee000000000a03c308'
const OTHER_NOTE_ID = '697c0eee000000000a03c309'
const POST_PATH = '/api/v1/data/post'
const LEGACY_POST_PATH = '/api/v1/xiaohongshu/app/get_note_info'

function noteUrl(noteId = NOTE_ID) {
  return `https://www.xiaohongshu.com/explore/${noteId}`
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function successEnvelope({
  xsecToken = 'private-xsec-token',
  token = 'private-response-token',
  avatarUrl = 'https://media.example.test/avatar.webp',
  mediaUrl = 'https://media.example.test/note.webp',
  desc = '一篇完整的小红书图文笔记',
} = {}) {
  return {
    code: 200,
    request_id: 'tikhub-request-1',
    message: 'Request successful. This request will incur a charge.',
    data: {
      data: [{
        note_list: [{
          note_id: NOTE_ID,
          title: '便携相机实拍',
          desc,
          timestamp: 1_782_212_583,
          xsec_token: xsecToken,
          token,
          user: {
            user_id: 'xhs-user-1',
            nickname: '相机研究员',
            avatar: avatarUrl,
          },
          interact_info: {
            liked_count: '123',
            collected_count: '45',
            comment_count: '6',
            share_count: '7',
          },
          tag_list: [{ name: '摄影' }, { tag_name: '便携相机' }],
          image_list: [{
            url_default: mediaUrl,
            xsec_token: xsecToken,
          }],
        }],
      }],
    },
  }
}

function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xDC00 || next > 0xDFFF) return true
      index += 1
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
      return true
    }
  }
  return false
}

function unavailableEnvelope() {
  return {
    code: 200,
    request_id: 'tikhub-unavailable-request',
    message: 'Request successful. This request will incur a charge.',
    data: '服务异常：笔记不存在',
  }
}

function gatewayConfig(overrides = {}) {
  return {
    configured: true,
    contractVerified: true,
    dispatchEnabled: true,
    configurationError: null,
    freshTtlMs: 60_000,
    staleTtlMs: 86_400_000,
    unknownFingerprintCooldownMs: 60_000,
    maxConcurrency: 8,
    maxConsumerConcurrency: 2,
    circuitFailureThreshold: 10,
    circuitOpenMs: 60_000,
    billing: {
      source: 'manual',
      currency: 'CNY',
      pricingAsOf: '2026-09-07T00:00:00.000Z',
      unitCostMinor: 5,
      monthlyBudgetMinor: null,
    },
    ...overrides,
  }
}

async function gatewayFixture({ fetchImpl, config = gatewayConfig(), externalImageLoader = null }) {
  const usageStore = new MemoryStore()
  const service = new HubService({
    store: usageStore,
    adapter: {},
    apiKeyPepper: PEPPER,
    externalImageLoader,
  })
  const tenant = await service.createTenant({ name: 'TikHub Tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'TikHub Consumer' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 1,
  })
  await service.putCapabilityConfiguration(XIAOHONGSHU_POST_OPERATION, {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 1_000,
    windowSeconds: 3_600,
  })
  // Snapshot-mode keys inherit only grants that exist when the key is issued.
  const apiKey = await service.createApiKey({ consumerId: consumer.id, name: 'TikHub Key' })
  const context = await service.authenticate(apiKey.secret)
  const adapter = new TikHubAdapter({ apiKey: PROVIDER_KEY, fetchImpl })
  const platformStore = new MemoryExternalPlatformStore({
    usageStore,
    providerKey: TIKHUB_PROVIDER_KEY,
    authorizationPlatform: 'xiaohongshu',
    circuitFailureThreshold: config.circuitFailureThreshold,
    circuitOpenMs: config.circuitOpenMs,
    uncertainCooldownMs: config.unknownFingerprintCooldownMs,
  })
  const gateway = new TikHubGateway({
    usageStore,
    platformStore,
    adapter,
    config,
    reservationLeaseMs: 150_000,
    logger: { warn() {}, error() {} },
  })
  return { usageStore, service, apiKey, context, adapter, platformStore, gateway }
}

async function issueApiKey(state, name) {
  const apiKey = await state.service.createApiKey({ consumerId: state.context.consumer.id, name })
  return { apiKey, context: await state.service.authenticate(apiKey.secret) }
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  })
}

async function captureError(operation) {
  try {
    await operation()
  } catch (error) {
    return error
  }
  assert.fail('operation must reject')
}

test('App V2 nested note_list is normalized and private xsec/token fields are redacted', async () => {
  const xsecToken = 'xsec-value-that-must-not-leak'
  const responseToken = 'response-token-that-must-not-leak'
  let dispatched
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async (url, options) => {
      dispatched = { url: new URL(url), options }
      return jsonResponse(successEnvelope({ xsecToken, token: responseToken }))
    },
  })

  const result = await adapter.getXiaohongshuPost({
    platform: 'xiaohongshu',
    url: noteUrl(),
  }, { capturedAt: '2026-09-07T01:02:03.000Z' })

  assert.equal(dispatched.url.pathname, TIKHUB_XIAOHONGSHU_ENDPOINT_PATH)
  assert.equal(dispatched.url.searchParams.get('note_id'), NOTE_ID)
  assert.equal(dispatched.url.searchParams.has('share_text'), false)
  assert.equal(dispatched.options.headers.authorization, `Bearer ${PROVIDER_KEY}`)
  assert.equal(result.publicBody.data.item.externalId, NOTE_ID)
  assert.equal(result.publicBody.data.item.url, noteUrl())
  assert.deepEqual(result.publicBody.data.item.tags, ['摄影', '便携相机'])
  assert.deepEqual(result.publicBody.data.item.media, [{
    type: 'image',
    url: 'https://media.example.test/note.webp',
  }])
  assert.equal(result.records[0].externalId, NOTE_ID)
  assert.equal(result.responseArchive.contractState, 'accepted')
  assert.equal(result.responseArchive.businessCode, 200)
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${xsecToken}|${responseToken}`, 'u'))

  const redacted = redactTikHubEnvelope({
    token: responseToken,
    nested: {
      xsec_token: xsecToken,
      sign: 'nested-signature-that-must-not-leak',
      auth_key: 'nested-auth-key-that-must-not-leak',
      session: 'nested-session-that-must-not-leak',
      setCookie: 'nested-cookie-that-must-not-leak',
    },
    url: `https://media.example.test/file.webp?xsec_token=${xsecToken}&safe=1`,
    signedUrl: 'https://cdn.example.test/a?sign=url-signature-that-must-not-leak&sig=url-sig-that-must-not-leak&safe=1#private-fragment',
    diagnostic: [
      'auth_key=plain-auth-key-that-must-not-leak',
      'set-cookie=set-cookie-that-must-not-leak',
      'cookie=cookie-that-must-not-leak',
      'authorization=Basic authorization-that-must-not-leak',
      'client_secret=client-secret-that-must-not-leak',
      'password=password-that-must-not-leak',
      'secret=secret-that-must-not-leak',
      'status=ok',
    ].join('; '),
    serializedDiagnostic: 'prefix {"token":"json-token-that-must-not-leak","status":"ok"} suffix',
    escapedSerializedDiagnostic: 'prefix {\\"client_secret\\":\\"escaped-secret-that-must-not-leak\\"} suffix',
  })
  assert.equal('token' in redacted, false)
  assert.equal('xsec_token' in redacted.nested, false)
  assert.equal('sign' in redacted.nested, false)
  assert.equal('auth_key' in redacted.nested, false)
  assert.equal('session' in redacted.nested, false)
  assert.equal('setCookie' in redacted.nested, false)
  assert.equal(new URL(redacted.url).searchParams.get('xsec_token'), '[REDACTED]')
  assert.equal(new URL(redacted.url).searchParams.get('safe'), '1')
  assert.equal(new URL(redacted.signedUrl).searchParams.get('sign'), '[REDACTED]')
  assert.equal(new URL(redacted.signedUrl).searchParams.get('sig'), '[REDACTED]')
  assert.equal(new URL(redacted.signedUrl).searchParams.get('safe'), '1')
  assert.equal(new URL(redacted.signedUrl).hash, '')
  assert.doesNotMatch(JSON.stringify(redacted), /must-not-leak/u)
})

test('detail bodies use a 50000-code-point safety limit without splitting emoji', async () => {
  const bodies = [
    '汉'.repeat(50_000),
    '汉'.repeat(50_001),
    `${'汉'.repeat(49_999)}😀尾`,
  ]
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async () => jsonResponse(successEnvelope({ desc: bodies.shift() })),
  })
  const request = { platform: 'xiaohongshu', url: noteUrl() }

  const exact = await adapter.getXiaohongshuPost(request)
  assert.equal([...exact.publicBody.data.item.text].length, 50_000)
  assert.equal(exact.safetyLimited, false)
  assert.equal(exact.records[0].extensions.bodyCompleteness, undefined)
  assert.equal('safetyLimited' in exact.publicBody.data.item, false)

  const limited = await adapter.getXiaohongshuPost(request)
  assert.equal([...limited.publicBody.data.item.text].length, 50_000)
  assert.equal(limited.publicBody.data.item.text, '汉'.repeat(50_000))
  assert.equal(limited.safetyLimited, true)
  assert.equal(limited.records[0].extensions.bodyCompleteness, 'safety_limited')
  assert.equal('safetyLimited' in limited.publicBody.data.item, false)

  const emojiBoundary = await adapter.getXiaohongshuPost(request)
  assert.equal([...emojiBoundary.publicBody.data.item.text].length, 50_000)
  assert.equal(emojiBoundary.publicBody.data.item.text.endsWith('😀'), true)
  assert.equal(emojiBoundary.publicBody.data.item.text.includes('尾'), false)
  assert.equal(hasLoneSurrogate(emojiBoundary.publicBody.data.item.text), false)
  assert.equal(emojiBoundary.safetyLimited, true)
  assert.equal(emojiBoundary.records[0].extensions.bodyCompleteness, 'safety_limited')
  assert.doesNotMatch(JSON.stringify(emojiBoundary.publicBody), /safetyLimited/u)
})

test('standalone detail dispatch uses its endpoint price before the legacy fallback', async () => {
  const state = await gatewayFixture({
    fetchImpl: async () => jsonResponse(successEnvelope()),
    config: gatewayConfig({
      billing: {
        source: 'manual',
        currency: 'CNY',
        pricingAsOf: '2026-09-08T00:00:00.000Z',
        unitCostMinor: 5,
        unitCostMinorByEndpoint: { [TIKHUB_XIAOHONGSHU_ENDPOINT_KEY]: 11 },
        monthlyBudgetMinor: null,
      },
    }),
  })

  await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'detail-endpoint-cost-01',
    path: POST_PATH,
  })

  const [providerCall] = [...state.platformStore.calls.values()]
  assert.equal(providerCall.costMinor, 11)
})

test('customer delivery exposes only Hub media locators while the authorized relay retains the source URL', async () => {
  const marker = 'signed-source-marker-that-must-not-leak'
  const mediaUrl = `https://media.example.test/note.webp?xsec_token=${marker}&width=1080`
  const avatarUrl = `https://media.example.test/avatar.webp?signature=${marker}`
  const loadedSources = []
  const state = await gatewayFixture({
    fetchImpl: async () => jsonResponse(successEnvelope({ mediaUrl, avatarUrl })),
    config: gatewayConfig({ freshTtlMs: 1 }),
    externalImageLoader: async (sourceUrl) => {
      loadedSources.push(sourceUrl)
      return { body: Buffer.from('relayed-image'), contentType: 'image/webp' }
    },
  })

  const live = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'public-projection-live-01',
    path: POST_PATH,
  })
  const locator = `/api/v1/data/posts/media?requestId=${live.requestId}&mediaIndex=0`
  assert.equal(live.body.data.item.media[0].url, locator)
  assert.equal(live.body.data.item.author.avatarUrl, null)
  assert.doesNotMatch(JSON.stringify(live.body), new RegExp(`${marker}|media\\.example\\.test`, 'u'))

  const retained = await state.usageStore.getCommittedSocialPostMediaSource({
    requestId: live.requestId,
    consumerId: state.context.consumer.id,
    mediaIndex: 0,
  })
  assert.equal(retained, mediaUrl)
  const relayed = await state.service.socialPostImage(state.context, {
    requestId: live.requestId,
    mediaIndex: 0,
  })
  assert.equal(relayed.contentType, 'image/webp')
  assert.deepEqual(loadedSources, [mediaUrl])

  const replay = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'public-projection-live-01',
    path: POST_PATH,
  })
  assert.equal(replay.sourceMode, 'idempotent_replay')
  assert.equal(replay.body.data.item.media[0].url, locator)
  assert.doesNotMatch(JSON.stringify(replay.body), new RegExp(`${marker}|media\\.example\\.test`, 'u'))

  await new Promise((resolve) => setTimeout(resolve, 5))
  const fallback = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_only' },
    idempotencyKey: 'public-projection-stale-01',
    path: POST_PATH,
  })
  assert.equal(fallback.sourceMode, 'stored_fallback')
  assert.equal(
    fallback.body.data.item.media[0].url,
    `/api/v1/data/posts/media?requestId=${fallback.requestId}&mediaIndex=0`,
  )
  assert.doesNotMatch(JSON.stringify(fallback.body), new RegExp(`${marker}|media\\.example\\.test`, 'u'))

  const fallbackReplay = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_only' },
    idempotencyKey: 'public-projection-stale-01',
    path: POST_PATH,
  })
  assert.equal(fallbackReplay.sourceMode, 'idempotent_replay')
  assert.equal(fallbackReplay.originSourceMode, 'stale')
  assert.equal(fallbackReplay.body.data.item.media[0].url, fallback.body.data.item.media[0].url)
})

test('canonical ingest strips URL queries and maps tags and bookmarks to stable fields', async () => {
  const marker = 'canonical-secret-query-marker'
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async () => jsonResponse(successEnvelope({
      mediaUrl: `https://media.example.test/note.webp?xsec_token=${marker}&width=1080`,
      avatarUrl: `https://media.example.test/avatar.webp?signature=${marker}`,
    })),
  })

  const result = await adapter.getXiaohongshuPost({
    platform: 'xiaohongshu',
    url: noteUrl(),
  }, { capturedAt: '2026-09-07T01:02:03.000Z' })
  const [record] = result.records

  assert.deepEqual(record.stableFields.tags, ['摄影', '便携相机'])
  assert.equal(record.stableFields.attributes.tags, undefined)
  assert.equal(record.extensions.tags, undefined)
  assert.deepEqual(record.metrics, { likes: 123, comments: 6, shares: 7, bookmarks: 45 })
  assert.deepEqual(record.stableFields.metrics, record.metrics)
  assert.equal(record.stableFields.author.avatarUrl, 'https://media.example.test/avatar.webp')
  assert.deepEqual(record.stableFields.media.images, ['https://media.example.test/note.webp'])
  assert.doesNotMatch(JSON.stringify(record), new RegExp(marker, 'u'))
  assert.doesNotMatch(JSON.stringify(result.archiveObjects), new RegExp(marker, 'u'))
  assert.equal(
    result.archiveObjects.find((archive) => archive.kind === 'item')?.rawPayload?.media?.[0]?.url,
    'https://media.example.test/note.webp',
  )
})

test('automatic idempotency is API-key scoped while snapshots remain shared by the consumer', async () => {
  let upstreamCalls = 0
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse(successEnvelope())
    },
  })
  const second = await issueApiKey(state, 'Second TikHub Key')
  const request = {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_first' },
    path: POST_PATH,
  }

  const live = await state.gateway.getPost(state.context, request)
  const cached = await state.gateway.getPost(second.context, request)

  assert.equal(live.sourceMode, 'live')
  assert.equal(cached.sourceMode, 'fresh_cache')
  assert.equal(upstreamCalls, 1)
  assert.equal(state.usageStore.requests.size, 2)
  assert.deepEqual(
    [...state.usageStore.requests.values()].map((entry) => entry.apiKeyId).sort(),
    [state.apiKey.id, second.apiKey.id].sort(),
  )
  assert.equal(
    cached.body.data.item.media[0].url,
    `/api/v1/data/posts/media?requestId=${cached.requestId}&mediaIndex=0`,
  )
})

test('provider token exhaustion prevents a second TikHub dispatch and serves an exact stored fallback', async () => {
  let upstreamCalls = 0
  const state = await gatewayFixture({
    config: gatewayConfig({ maxRequestsPerMinute: 1 }),
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse(successEnvelope())
    },
  })
  await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'tikhub-rate-warm-01',
    path: POST_PATH,
  })

  const fallback = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'refresh' },
    idempotencyKey: 'tikhub-rate-refresh-01',
    path: POST_PATH,
  })
  assert.equal(fallback.sourceMode, 'stored_fallback')
  assert.equal(fallback.body.meta.fallbackReason, 'provider_rate_limit')
  assert.equal(upstreamCalls, 1)
  assert.equal(state.platformStore.calls.size, 1)

  const miss = await captureError(() => state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(OTHER_NOTE_ID) },
    idempotencyKey: 'tikhub-rate-miss-01',
    path: POST_PATH,
  }))
  assert.equal(miss.status, 429)
  assert.equal(miss.code, 'external_platform_rate_limited')
  assert.ok(miss.details.retryAfterMs > 0)
  assert.equal(upstreamCalls, 1)
})

test('a caller-supplied idempotency key still cannot cross API-key attribution', async () => {
  let upstreamCalls = 0
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse(successEnvelope())
    },
  })
  const second = await issueApiKey(state, 'Second explicit-key caller')
  const request = {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'shared-explicit-key-01',
    path: POST_PATH,
  }

  await state.gateway.getPost(state.context, request)
  const conflict = await captureError(() => state.gateway.getPost(second.context, request))

  assert.equal(conflict.status, 409)
  assert.equal(conflict.code, 'idempotency_conflict')
  assert.equal(upstreamCalls, 1)
})

test('HTTP 401 HTML and HTTP 429 oversized bodies retain status-first classifications', async () => {
  const cases = [
    {
      status: 401,
      body: '<html>credential rejected</html>',
      maxResponseBytes: 1_024,
      errorCode: 'upstream_auth_or_balance_unavailable',
      archiveState: 'provider_rejected_invalid_json',
    },
    {
      status: 429,
      body: 'x'.repeat(128),
      maxResponseBytes: 32,
      errorCode: 'upstream_rate_limited',
      archiveState: 'provider_rejected_response_too_large',
    },
  ]

  for (const expected of cases) {
    const adapter = new TikHubAdapter({
      apiKey: PROVIDER_KEY,
      maxResponseBytes: expected.maxResponseBytes,
      fetchImpl: async () => new Response(expected.body, {
        status: expected.status,
        headers: {
          'content-type': 'text/html',
          'content-length': String(Buffer.byteLength(expected.body)),
        },
      }),
    })
    const error = await captureError(() => adapter.getXiaohongshuPost({
      platform: 'xiaohongshu',
      url: noteUrl(),
    }))

    assert.ok(error instanceof TikHubUpstreamError)
    assert.deepEqual(error.evidence, {
      outcome: 'rejected',
      httpStatus: expected.status,
      businessCode: null,
      billed: null,
      errorCode: expected.errorCode,
      affectsCircuit: true,
      retryable: false,
    })
    assert.equal(error.responseArchive.contractState, expected.archiveState)
  }
})

test('an unknown HTTP 200 envelope quarantines the endpoint contract across fingerprints', async () => {
  let upstreamCalls = 0
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse({
        code: 200,
        request_id: `invalid-contract-${upstreamCalls}`,
        data: { unexpected_shape: true },
      })
    },
  })

  const first = await captureError(() => state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(NOTE_ID) },
    idempotencyKey: 'unknown-contract-01',
    path: POST_PATH,
  }))
  assert.ok(first instanceof AppError)
  assert.equal(first.status, 502)
  assert.equal(first.code, 'external_platform_response_unusable')
  assert.equal([...state.platformStore.calls.values()][0].errorCode, 'invalid_upstream_contract')

  const blocked = await captureError(() => state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(OTHER_NOTE_ID) },
    idempotencyKey: 'unknown-contract-02',
    path: POST_PATH,
  }))
  assert.equal(blocked.status, 409)
  assert.equal(blocked.code, 'external_platform_response_unusable')
  assert.equal(upstreamCalls, 1, 'endpoint quarantine must suppress a second paid dispatch')
})

test('the explicit service-error sentinel is billed once and negative-cached for new idempotency keys', async () => {
  assert.equal(isTikHubXiaohongshuUnavailable(unavailableEnvelope()), true)
  assert.equal(isTikHubXiaohongshuUnavailable({ code: 200, data: null }), false)
  assert.equal(isTikHubXiaohongshuUnavailable({
    code: 200,
    data: { unreviewed_service_error_shape: true },
  }), false)

  let upstreamCalls = 0
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse(unavailableEnvelope())
    },
  })
  const request = {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'missing-note-key-01',
    path: POST_PATH,
  }

  const first = await captureError(() => state.gateway.getPost(state.context, request))
  assert.equal(first.status, 404)
  assert.equal(first.code, 'post_not_found')
  const [providerCall] = [...state.platformStore.calls.values()]
  assert.equal(providerCall.outcome, 'succeeded_unusable')
  assert.equal(providerCall.errorCode, 'upstream_note_unavailable')
  assert.equal(providerCall.billed, true)
  assert.equal(providerCall.costMinor, 5, 'legacy unitCostMinor remains the endpoint fallback')

  const replay = await captureError(() => state.gateway.getPost(state.context, request))
  assert.equal(replay.status, 404)
  assert.equal(replay.code, 'post_not_found')
  assert.equal(state.platformStore.requests.at(-1).sourceMode, 'idempotent_replay')

  const negativeHit = await captureError(() => state.gateway.getPost(state.context, {
    ...request,
    idempotencyKey: 'missing-note-key-02',
  }))
  assert.equal(negativeHit.status, 404)
  assert.equal(negativeHit.code, 'post_not_found')
  assert.equal(state.platformStore.requests.at(-1).sourceMode, 'duplicate_suppressed')
  assert.equal(upstreamCalls, 1, 'replay and negative-cache hit must not call TikHub again')
})

test('legacy get_note_info and canonical post routes share one idempotency scope', async () => {
  let upstreamCalls = 0
  const marker = 'http-response-source-marker'
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse(successEnvelope({
        mediaUrl: `https://media.example.test/note.webp?xsec_token=${marker}`,
        avatarUrl: `https://media.example.test/avatar.webp?signature=${marker}`,
      }))
    },
    config: gatewayConfig({ freshTtlMs: 1 }),
  })
  const server = createServer(createApp({
    service: state.service,
    store: state.usageStore,
    adapter: {},
    adminToken: null,
    tikHubGateway: state.gateway,
    listenerMode: 'public',
    logger: { warn() {}, error() {} },
  }))
  const baseUrl = await listen(server)
  const call = async (path, body, idempotencyKey = 'route-alias-key-01') => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${state.apiKey.secret}`,
        'content-type': 'application/json',
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify(body),
    })
    return { response, payload: await response.json() }
  }

  try {
    const legacy = await call(LEGACY_POST_PATH, { url: noteUrl() })
    const canonical = await call(POST_PATH, { platform: 'xiaohongshu', url: noteUrl() })

    assert.equal(legacy.response.status, 200)
    assert.equal(canonical.response.status, 200)
    assert.equal(legacy.response.headers.get('x-mx-insight-source-mode'), 'live')
    assert.equal(canonical.response.headers.get('x-mx-insight-source-mode'), 'idempotent_replay')
    assert.equal(canonical.response.headers.get('idempotent-replay'), 'true')
    assert.equal(canonical.payload.requestId, legacy.payload.requestId)
    assert.equal(
      legacy.payload.data.item.media[0].url,
      `/api/v1/data/posts/media?requestId=${legacy.payload.requestId}&mediaIndex=0`,
    )
    assert.equal(legacy.payload.data.item.author.avatarUrl, null)
    assert.doesNotMatch(JSON.stringify([legacy.payload, canonical.payload]), new RegExp(marker, 'u'))

    await new Promise((resolve) => setTimeout(resolve, 5))
    const stale = await call(
      POST_PATH,
      { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_only' },
      'route-stale-key-01',
    )
    const staleReplay = await call(
      POST_PATH,
      { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_only' },
      'route-stale-key-01',
    )
    assert.equal(stale.response.headers.get('x-mx-insight-source-mode'), 'stored_fallback')
    assert.equal(stale.response.headers.get('warning'), '110 - "Response is stale"')
    assert.equal(staleReplay.response.headers.get('x-mx-insight-source-mode'), 'idempotent_replay')
    assert.equal(staleReplay.response.headers.get('warning'), '110 - "Response is stale"')
    assert.equal(upstreamCalls, 1)
  } finally {
    await close(server)
  }
})
