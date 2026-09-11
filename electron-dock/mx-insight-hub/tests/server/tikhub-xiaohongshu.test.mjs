import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { TikHubAdapter, TikHubUpstreamError } from '../../server/adapters/tikhub.mjs'
import { createApp } from '../../server/app.mjs'
import {
  isTikHubXiaohongshuUnavailable,
  normalizeTikHubXiaohongshuNoteResult,
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
const PLATFORM_PATH = '/api/v1/xiaohongshu/app/get_note_info'

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
      monthlyBudgetMinor: 100_000,
      monthlySubsidyBudgetMinor: 100_000,
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
  // Snapshot-mode keys explicitly bind both authorization axes at issuance.
  const apiKey = await service.createApiKey({
    consumerId: consumer.id,
    name: 'TikHub Key',
    platforms: ['xiaohongshu'],
    capabilities: [XIAOHONGSHU_POST_OPERATION],
  })
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
  const apiKey = await state.service.createApiKey({
    consumerId: state.context.consumer.id,
    name,
    platforms: ['xiaohongshu'],
    capabilities: [XIAOHONGSHU_POST_OPERATION],
  })
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

test('App V2 preserves provider business fields while isolating the active provider credential', async () => {
  const xsecToken = 'signed-business-xsec-token'
  const responseToken = 'provider-business-response-token'
  let dispatched
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async (url, options) => {
      dispatched = { url: new URL(url), options }
      return jsonResponse(successEnvelope({
        xsecToken,
        token: responseToken,
        mediaUrl: `https://media.example.test/note.webp?xsec_token=${xsecToken}`,
      }))
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
    url: `https://media.example.test/note.webp?xsec_token=${xsecToken}`,
  }])
  assert.equal(result.records[0].externalId, NOTE_ID)
  assert.equal(result.responseArchive.contractState, 'accepted')
  assert.equal(result.responseArchive.businessCode, 200)
  assert.match(JSON.stringify(result), new RegExp(`${xsecToken}|${responseToken}`, 'u'))

  const businessEnvelope = {
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
  }
  assert.deepEqual(redactTikHubEnvelope(businessEnvelope), businessEnvelope)
})

test('App V2 removes equivalent encoded provider credentials from public and operational payloads', async () => {
  const providerCredential = "Tik/key+space ?&=!*'()"
  const lowerPercentHex = (value) => value.replace(
    /%[0-9A-F]{2}/gu,
    (escape) => escape.toLowerCase(),
  )
  const innerLowerThenDoubleEncoded = encodeURIComponent(
    lowerPercentHex(encodeURIComponent(providerCredential)),
  )
  const strictEncoded = lowerPercentHex(encodeURIComponent(providerCredential).replace(
    /[!'()*]/gu,
    (character) => `%${character.codePointAt(0).toString(16).toUpperCase()}`,
  ))
  const raw = {
    code: 200,
    data: {
      echoed: `before-${innerLowerThenDoubleEncoded}-after`,
      strictEchoed: `before-${strictEncoded}-after`,
      [innerLowerThenDoubleEncoded]: 'credential-in-key',
    },
  }
  const adapter = new TikHubAdapter({
    apiKey: providerCredential,
    fetchImpl: async () => jsonResponse(raw),
  })

  const result = await adapter.getXiaohongshuAppV2(
    TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
    { note_id: NOTE_ID },
  )
  const ordinary = JSON.stringify({
    payload: result.payload,
    responseArchive: result.responseArchive,
    archiveObjects: result.archiveObjects,
  })

  assert.equal(ordinary.includes(providerCredential), false)
  assert.equal(ordinary.includes(innerLowerThenDoubleEncoded), false)
  assert.equal(ordinary.includes(strictEncoded), false)
  assert.match(ordinary, /\[REDACTED\]/u)
  assert.equal(result.restrictedResponseArchive.bodyText.includes(innerLowerThenDoubleEncoded), true)
})

test('detail URL projection removes a nested percent-encoded provider credential only', () => {
  const providerCredential = 'Tik/key+space ?&'
  const lowerInner = encodeURIComponent(providerCredential).replace(
    /%[0-9A-F]{2}/gu,
    (escape) => escape.toLowerCase(),
  )
  const reflected = encodeURIComponent(lowerInner)
  const businessToken = 'signed-business-token'
  const normalized = normalizeTikHubXiaohongshuNoteResult(successEnvelope({
    avatarUrl: `https://avatar.example.test/u.webp?credential=${reflected}&xsec_token=${businessToken}`,
    mediaUrl: `https://media.example.test/note.webp?credential=${reflected}&xsec_token=${businessToken}`,
  }), { providerCredential })
  const serialized = JSON.stringify(normalized)

  assert.equal(serialized.includes(providerCredential), false)
  assert.equal(serialized.includes(reflected), false)
  assert.match(serialized, /REDACTED/u)
  assert.match(serialized, new RegExp(businessToken, 'u'))
})

test('detail bodies preserve complete acquired text beyond the former field limit', async () => {
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
  assert.equal('safetyLimited' in exact, false)
  assert.equal(exact.records[0].extensions.bodyCompleteness, undefined)
  assert.equal('safetyLimited' in exact.publicBody.data.item, false)

  const limited = await adapter.getXiaohongshuPost(request)
  assert.equal([...limited.publicBody.data.item.text].length, 50_001)
  assert.equal(limited.publicBody.data.item.text, '汉'.repeat(50_001))
  assert.equal('safetyLimited' in limited, false)
  assert.equal(limited.records[0].extensions.bodyCompleteness, undefined)
  assert.equal('safetyLimited' in limited.publicBody.data.item, false)

  const emojiBoundary = await adapter.getXiaohongshuPost(request)
  assert.equal([...emojiBoundary.publicBody.data.item.text].length, 50_001)
  assert.equal(emojiBoundary.publicBody.data.item.text.endsWith('😀尾'), true)
  assert.equal('safetyLimited' in emojiBoundary, false)
  assert.equal(emojiBoundary.records[0].extensions.bodyCompleteness, undefined)
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
        monthlyBudgetMinor: 100_000,
        monthlySubsidyBudgetMinor: 100_000,
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

test('standalone detail budget rejection occurs before consuming provider RPM or dispatching', async () => {
  let fetchCalls = 0
  const state = await gatewayFixture({
    fetchImpl: async () => {
      fetchCalls += 1
      return jsonResponse(successEnvelope())
    },
    config: gatewayConfig({
      billing: {
        source: 'manual',
        currency: 'CNY',
        pricingAsOf: '2026-09-08T00:00:00.000Z',
        unitCostMinor: 5,
        monthlyBudgetMinor: 0,
        monthlySubsidyBudgetMinor: 100_000,
      },
    }),
  })
  const acquireRateLimit = state.platformStore.acquireProviderRateLimit.bind(state.platformStore)
  let providerRateAdmissions = 0
  state.platformStore.acquireProviderRateLimit = async (input) => {
    providerRateAdmissions += 1
    return acquireRateLimit(input)
  }

  const error = await captureError(() => state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'detail-budget-exhausted-01',
    path: POST_PATH,
  }))

  assert.equal(error?.code, 'external_platform_cost_budget_exhausted')
  assert.equal(providerRateAdmissions, 0)
  assert.equal(fetchCalls, 0)
  assert.equal(state.platformStore.calls.size, 0)
})

test('customer delivery preserves business media fields and adds an authorized Hub relay locator', async () => {
  const marker = 'signed-source-business-marker'
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
  assert.equal(live.body.data.item.media[0].url, mediaUrl)
  assert.equal(live.body.data.item.media[0].hubRelayUrl, locator)
  assert.equal(live.body.data.item.author.avatarUrl, avatarUrl)
  assert.match(JSON.stringify(live.body), new RegExp(marker, 'u'))
  assert.deepEqual(state.usageStore.requests.get(live.requestId)?.responseBody, live.body)

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
  assert.deepEqual(replay.body, live.body)
  assert.equal(replay.body.data.item.media[0].url, mediaUrl)
  assert.equal(replay.body.data.item.media[0].hubRelayUrl, locator)
  assert.equal(replay.body.data.item.author.avatarUrl, avatarUrl)

  await new Promise((resolve) => setTimeout(resolve, 5))
  const fallback = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_only' },
    idempotencyKey: 'public-projection-stale-01',
    path: POST_PATH,
  })
  assert.equal(fallback.sourceMode, 'stored_fallback')
  assert.equal(fallback.body.data.item.media[0].url, mediaUrl)
  assert.equal(
    fallback.body.data.item.media[0].hubRelayUrl,
    `/api/v1/data/posts/media?requestId=${fallback.requestId}&mediaIndex=0`,
  )
  assert.equal(fallback.body.data.item.author.avatarUrl, avatarUrl)
  assert.deepEqual(state.usageStore.requests.get(fallback.requestId)?.responseBody, fallback.body)

  const fallbackReplay = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_only' },
    idempotencyKey: 'public-projection-stale-01',
    path: POST_PATH,
  })
  assert.equal(fallbackReplay.sourceMode, 'idempotent_replay')
  assert.equal(fallbackReplay.originSourceMode, 'stale')
  assert.deepEqual(fallbackReplay.body, fallback.body)
})

test('business media beyond the bounded relay window remains intact without a dead locator', async () => {
  const upstream = successEnvelope()
  upstream.data.data[0].note_list[0].image_list = Array.from({ length: 21 }, (_, index) => ({
    url_default: `https://media.example.test/note-${index}.webp?signature=business-${index}`,
  }))
  const state = await gatewayFixture({
    fetchImpl: async () => jsonResponse(upstream),
  })

  const live = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'public-projection-many-media-01',
    path: POST_PATH,
  })

  assert.equal(live.body.data.item.media.length, 21)
  assert.match(live.body.data.item.media[0].hubRelayUrl, /mediaIndex=0$/u)
  assert.match(live.body.data.item.media[19].hubRelayUrl, /mediaIndex=19$/u)
  assert.equal(live.body.data.item.media[20].url, upstream.data.data[0].note_list[0].image_list[20].url_default)
  assert.equal(live.body.data.item.media[20].hubRelayUrl, undefined)
})

test('canonical ingest preserves business URL queries and maps tags and bookmarks to stable fields', async () => {
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
  assert.equal(record.stableFields.author.avatarUrl, `https://media.example.test/avatar.webp?signature=${marker}`)
  assert.deepEqual(record.stableFields.media.images, [
    `https://media.example.test/note.webp?xsec_token=${marker}&width=1080`,
  ])
  assert.match(JSON.stringify(record), new RegExp(marker, 'u'))
  assert.match(JSON.stringify(result.archiveObjects), new RegExp(marker, 'u'))
  assert.equal(
    result.archiveObjects.find((archive) => archive.kind === 'item')?.rawPayload?.media?.[0]?.url,
    `https://media.example.test/note.webp?xsec_token=${marker}&width=1080`,
  )
})

test('headerless note calls are separately metered while snapshots remain shared by the consumer', async () => {
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
  const cachedSameKey = await state.gateway.getPost(state.context, request)
  const cachedSecondKey = await state.gateway.getPost(second.context, request)

  assert.equal(live.sourceMode, 'live')
  assert.equal(cachedSameKey.sourceMode, 'fresh_cache')
  assert.equal(cachedSecondKey.sourceMode, 'fresh_cache')
  assert.equal(upstreamCalls, 1)
  assert.equal(state.usageStore.requests.size, 3)
  assert.deepEqual(
    [...state.usageStore.requests.values()].map((entry) => entry.apiKeyId).sort(),
    [state.apiKey.id, state.apiKey.id, second.apiKey.id].sort(),
  )
  assert.equal(
    cachedSameKey.body.data.item.media[0].hubRelayUrl,
    `/api/v1/data/posts/media?requestId=${cachedSameKey.requestId}&mediaIndex=0`,
  )
  assert.equal(cachedSameKey.body.data.item.media[0].url, 'https://media.example.test/note.webp')
  assert.deepEqual(
    state.usageStore.requests.get(cachedSameKey.requestId)?.responseBody,
    cachedSameKey.body,
  )
  assert.deepEqual(
    state.usageStore.requests.get(cachedSecondKey.requestId)?.responseBody,
    cachedSecondKey.body,
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

test('delivery mode is idempotency-bound while every mode shares one note snapshot', async () => {
  let upstreamCalls = 0
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse(successEnvelope())
    },
  })
  const cacheFirst = {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_first' },
    idempotencyKey: 'delivery-mode-binding-01',
    path: POST_PATH,
  }

  const initial = await state.gateway.getPost(state.context, cacheFirst)
  const conflict = await captureError(() => state.gateway.getPost(state.context, {
    ...cacheFirst,
    body: { ...cacheFirst.body, deliveryMode: 'refresh' },
  }))

  assert.equal(initial.sourceMode, 'live')
  assert.equal(conflict.status, 409)
  assert.equal(conflict.code, 'idempotency_conflict')
  assert.equal(upstreamCalls, 1, 'a changed delivery intent must not reuse or dispatch under the old key')

  const refreshed = await state.gateway.getPost(state.context, {
    body: { ...cacheFirst.body, deliveryMode: 'refresh' },
    idempotencyKey: 'delivery-mode-binding-02',
    path: POST_PATH,
  })
  const cached = await state.gateway.getPost(state.context, {
    body: { ...cacheFirst.body, deliveryMode: 'cache_only' },
    idempotencyKey: 'delivery-mode-binding-03',
    path: POST_PATH,
  })

  assert.equal(refreshed.sourceMode, 'live')
  assert.equal(cached.sourceMode, 'fresh_cache')
  assert.equal(upstreamCalls, 2)
  assert.equal(state.platformStore.calls.size, 2)
  const [initialCall, refreshCall] = [...state.platformStore.calls.values()]
  assert.notEqual(
    initialCall.fingerprint,
    refreshCall.fingerprint,
    'provider-call request fingerprints must bind the delivery intent',
  )
  assert.equal(
    initialCall.dispatchFingerprint,
    refreshCall.dispatchFingerprint,
    'provider dispatches must retain one note-identity fingerprint across delivery intents',
  )
  assert.equal(state.platformStore.snapshots.size, 1, 'delivery modes must share the note-identity snapshot')
})

test('concurrent cache_first and refresh intents share the note dispatch lease', async () => {
  let releaseDispatch
  let markStarted
  let upstreamCalls = 0
  const dispatchStarted = new Promise((resolve) => { markStarted = resolve })
  const dispatchRelease = new Promise((resolve) => { releaseDispatch = resolve })
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      markStarted()
      await dispatchRelease
      return jsonResponse(successEnvelope())
    },
  })
  const first = state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_first' },
    idempotencyKey: 'shared-note-lease-01',
    path: POST_PATH,
  })

  try {
    await dispatchStarted
    const blocked = await captureError(() => state.gateway.getPost(state.context, {
      body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'refresh' },
      idempotencyKey: 'shared-note-lease-02',
      path: POST_PATH,
    }))
    assert.equal(blocked.status, 409)
    assert.equal(blocked.code, 'request_in_progress')
    assert.equal(upstreamCalls, 1)
  } finally {
    releaseDispatch()
  }

  assert.equal((await first).sourceMode, 'live')
  assert.equal(state.platformStore.calls.size, 1)
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

test('deep valid JSON still retains exact restricted TikHub response bytes', async () => {
  const depth = 12_000
  const bodyText = `{"code":400,"data":${'{"nested":'.repeat(depth)}null${'}'.repeat(depth)}}`
  const bodyBytes = Buffer.from(bodyText, 'utf8')
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async () => new Response(bodyBytes, {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }),
  })

  const error = await captureError(() => adapter.getXiaohongshuPost({
    platform: 'xiaohongshu',
    url: noteUrl(),
  }))

  assert.ok(error instanceof TikHubUpstreamError)
  assert.equal(error.responseArchive.rawPayload, null)
  assert.match(error.responseArchive.payloadSha256, /^[a-f0-9]{64}$/u)
  assert.equal(error.archiveObjects.length, 1)
  assert.equal(error.archiveObjects[0].rawPayload, null)
  assert.equal(error.archiveObjects[0].payloadSha256, error.responseArchive.payloadSha256)
  assert.equal(error.restrictedResponseArchive.bodyBytes.equals(bodyBytes), true)
  assert.equal(error.restrictedResponseArchive.bodyText, bodyText)
  assert.equal(error.restrictedResponseArchive.jsonParsed, true)
  assert.equal(error.restrictedResponseArchive.parsedPayload, null)
})

test('official App V2 scrubs a deep public payload without losing exact evidence', async () => {
  const depth = 12_000
  const bodyText = `{"code":200,"data":${'{"nested":'.repeat(depth)}"terminal"${'}'.repeat(depth)}}`
  const bodyBytes = Buffer.from(bodyText, 'utf8')
  const adapter = new TikHubAdapter({
    apiKey: PROVIDER_KEY,
    fetchImpl: async () => new Response(bodyBytes, {
      headers: { 'content-type': 'application/json' },
    }),
  })

  const result = await adapter.getXiaohongshuAppV2(
    TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
    { note_id: NOTE_ID },
  )

  assert.equal(result.payload.code, 200)
  let nested = result.payload.data
  for (let index = 0; index < depth; index += 1) nested = nested.nested
  assert.equal(nested, 'terminal')
  assert.equal(result.responseArchive.rawPayload, null)
  assert.match(result.responseArchive.payloadSha256, /^[a-f0-9]{64}$/u)
  assert.equal(result.archiveObjects.length, 1)
  assert.equal(result.archiveObjects[0].rawPayload, null)
  assert.equal(result.archiveObjects[0].payloadSha256, result.responseArchive.payloadSha256)
  assert.equal(result.restrictedResponseArchive.bodyBytes.equals(bodyBytes), true)
  assert.equal(result.restrictedResponseArchive.bodyText, bodyText)
  assert.equal(result.restrictedResponseArchive.jsonParsed, true)
  assert.equal(result.restrictedResponseArchive.parsedPayload, null)
})

test('TikHub PostgreSQL-unsafe payloads keep exact bytes while optional projections stay null', async () => {
  const cases = [
    {
      bodyText: '{"code":200,"data":{"text":"\\u0000"}}',
      expectedCode: 'upstream_payload_unrepresentable',
      expectedJsonParsed: true,
      expectedBodyText: '{"code":200,"data":{"text":"\\u0000"}}',
    },
    {
      bodyText: '{"code":200,"data":{"text":"\\ud800"}}',
      expectedCode: 'upstream_payload_unrepresentable',
      expectedJsonParsed: true,
      expectedBodyText: '{"code":200,"data":{"text":"\\ud800"}}',
    },
    {
      bodyText: '{"code":200,"data":{"value":1e400}}',
      expectedCode: 'upstream_payload_unrepresentable',
      expectedJsonParsed: true,
      expectedBodyText: '{"code":200,"data":{"value":1e400}}',
    },
    {
      bodyText: '{"code":200,"data":{"value":-0}}',
      expectedCode: 'upstream_payload_unrepresentable',
      expectedJsonParsed: true,
      expectedBodyText: '{"code":200,"data":{"value":-0}}',
    },
    {
      bodyText: '{"code":200,"data":"literal\0nul"}',
      expectedCode: 'invalid_upstream_json',
      expectedJsonParsed: false,
      expectedBodyText: null,
    },
  ]

  for (const expected of cases) {
    const bodyBytes = Buffer.from(expected.bodyText, 'utf8')
    const adapter = new TikHubAdapter({
      apiKey: PROVIDER_KEY,
      fetchImpl: async () => new Response(bodyBytes, {
        headers: { 'content-type': 'application/json' },
      }),
    })

    const error = await captureError(() => adapter.getXiaohongshuAppV2(
      TIKHUB_XIAOHONGSHU_ENDPOINT_KEY,
      { note_id: NOTE_ID },
    ))

    assert.ok(error instanceof TikHubUpstreamError)
    assert.equal(error.evidence.errorCode, expected.expectedCode)
    assert.match(error.responseArchive.payloadSha256, /^[a-f0-9]{64}$/u)
    assert.equal(error.responseArchive.rawPayload, null)
    assert.equal(error.archiveObjects.length, 1)
    assert.equal(error.archiveObjects[0].rawPayload, null)
    assert.equal(error.restrictedResponseArchive.bodyBytes.equals(bodyBytes), true)
    assert.equal(error.restrictedResponseArchive.bodyText, expected.expectedBodyText)
    assert.equal(error.restrictedResponseArchive.jsonParsed, expected.expectedJsonParsed)
    assert.equal(error.restrictedResponseArchive.parsedPayload, null)
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

test('Hub-projected platform GET, JSON POST, and canonical routes share one idempotency scope', async () => {
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
  const post = async (path, body, idempotencyKey = 'route-alias-key-01') => {
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
  const get = async (
    { shareText = null, noteId = null, path = PLATFORM_PATH },
    idempotencyKey = 'route-alias-key-01',
  ) => {
    const url = new URL(path, baseUrl)
    if (shareText != null) url.searchParams.set('share_text', shareText)
    if (noteId != null) url.searchParams.set('note_id', noteId)
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${state.apiKey.secret}`,
        'idempotency-key': idempotencyKey,
      },
    })
    return { response, payload: await response.json() }
  }

  try {
    const platformGet = await get({ shareText: noteUrl() })
    const noteIdPrecedence = await get({ shareText: noteUrl(OTHER_NOTE_ID), noteId: NOTE_ID })
    const platformPost = await post(PLATFORM_PATH, { url: noteUrl() })
    const canonical = await post(POST_PATH, { platform: 'xiaohongshu', url: noteUrl() })

    assert.equal(platformGet.response.status, 200)
    assert.equal(noteIdPrecedence.response.status, 200)
    assert.equal(platformPost.response.status, 200)
    assert.equal(canonical.response.status, 200)
    assert.equal(platformGet.response.headers.get('x-mx-insight-source-mode'), 'live')
    assert.equal(noteIdPrecedence.response.headers.get('x-mx-insight-source-mode'), 'idempotent_replay')
    assert.equal(platformPost.response.headers.get('x-mx-insight-source-mode'), 'idempotent_replay')
    assert.equal(canonical.response.headers.get('x-mx-insight-source-mode'), 'idempotent_replay')
    assert.equal(canonical.response.headers.get('idempotent-replay'), 'true')
    assert.equal(noteIdPrecedence.payload.requestId, platformGet.payload.requestId)
    assert.equal(platformPost.payload.requestId, platformGet.payload.requestId)
    assert.equal(canonical.payload.requestId, platformGet.payload.requestId)
    assert.equal(platformGet.payload.data.item.text, '一篇完整的小红书图文笔记')
    assert.deepEqual(platformGet.payload.data.item.tags, ['摄影', '便携相机'])
    assert.equal(platformGet.payload.data.item.media[0].url, `https://media.example.test/note.webp?xsec_token=${marker}`)
    assert.equal(
      platformGet.payload.data.item.media[0].hubRelayUrl,
      `/api/v1/data/posts/media?requestId=${platformGet.payload.requestId}&mediaIndex=0`,
    )
    assert.equal(platformGet.payload.data.item.author.avatarUrl, `https://media.example.test/avatar.webp?signature=${marker}`)
    assert.match(
      JSON.stringify([
        platformGet.payload,
        noteIdPrecedence.payload,
        platformPost.payload,
        canonical.payload,
      ]),
      new RegExp(marker, 'u'),
    )

    await new Promise((resolve) => setTimeout(resolve, 5))
    const stale = await post(
      POST_PATH,
      { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'cache_only' },
      'route-stale-key-01',
    )
    const staleReplay = await post(
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

test('platform-shaped GET rejects missing auth, Test keys, missing grants, and invalid links before dispatch', async () => {
  let upstreamCalls = 0
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse(successEnvelope())
    },
  })
  const testApiKey = await state.service.createApiKey({
    consumerId: state.context.consumer.id,
    name: 'TikHub Test Key',
    environment: 'test',
    platforms: ['xiaohongshu'],
    capabilities: [XIAOHONGSHU_POST_OPERATION],
  })
  const ungrantedConsumer = await state.service.createConsumer({
    tenantId: state.context.tenant.id,
    name: 'TikHub Ungranted Consumer',
  })
  const ungrantedApiKey = await state.service.createApiKey({
    consumerId: ungrantedConsumer.id,
    name: 'TikHub Ungranted Key',
  })
  const platformOnlyConsumer = await state.service.createConsumer({
    tenantId: state.context.tenant.id,
    name: 'TikHub Platform-only Consumer',
  })
  await state.service.putPlatformConfiguration('xiaohongshu', {
    tenantId: state.context.tenant.id,
    consumerId: platformOnlyConsumer.id,
    enabled: true,
    maxRequests: 10,
    windowSeconds: 3_600,
    maxPageSize: 1,
  })
  const platformOnlyApiKey = await state.service.createApiKey({
    consumerId: platformOnlyConsumer.id,
    name: 'TikHub Platform-only Key',
    platforms: ['xiaohongshu'],
    capabilities: [],
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
  const call = async ({ secret = null, shareText = noteUrl(), extra = {} } = {}) => {
    const url = new URL(PLATFORM_PATH, baseUrl)
    url.searchParams.set('share_text', shareText)
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value)
    const response = await fetch(url, {
      headers: secret ? { authorization: `Bearer ${secret}` } : {},
    })
    return { response, payload: await response.json() }
  }

  try {
    const missingAuth = await call()
    assert.equal(missingAuth.response.status, 401)
    assert.equal(missingAuth.payload.error.code, 'api_key_required')

    const rejectedTest = await call({ secret: testApiKey.secret })
    assert.equal(rejectedTest.response.status, 403)
    assert.equal(rejectedTest.payload.error.code, 'test_key_not_supported')

    const missingGrant = await call({ secret: ungrantedApiKey.secret })
    assert.equal(missingGrant.response.status, 403)
    assert.equal(missingGrant.payload.error.code, 'platform_not_granted')

    const missingCapability = await call({ secret: platformOnlyApiKey.secret })
    assert.equal(missingCapability.response.status, 403)
    assert.equal(missingCapability.payload.error.code, 'capability_not_granted')

    const invalidLink = await call({
      secret: state.apiKey.secret,
      shareText: 'https://example.com/not-a-xiaohongshu-note',
    })
    assert.equal(invalidLink.response.status, 400)
    assert.equal(invalidLink.payload.error.code, 'invalid_post_url')

    const invalidNoteIdUrl = new URL(PLATFORM_PATH, baseUrl)
    invalidNoteIdUrl.searchParams.set('note_id', `${NOTE_ID}?unexpected=1`)
    const invalidNoteIdResponse = await fetch(invalidNoteIdUrl, {
      headers: { authorization: `Bearer ${state.apiKey.secret}` },
    })
    assert.equal(invalidNoteIdResponse.status, 400)
    assert.equal((await invalidNoteIdResponse.json()).error.code, 'invalid_post_url')

    const unsupported = await call({ secret: state.apiKey.secret, extra: { token: 'must-not-route' } })
    assert.equal(unsupported.response.status, 400)
    assert.equal(unsupported.payload.error.code, 'unsupported_fields')

    assert.equal(upstreamCalls, 0)
    assert.equal(state.platformStore.calls.size, 0)
    const usage = await state.usageStore.usage({ consumerId: state.context.consumer.id })
    assert.equal(usage.requests, 0)
  } finally {
    await close(server)
  }
})

test('live_only refuses a stored fallback on the Xiaohongshu note contract', async () => {
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
    idempotencyKey: 'tikhub-live-warm-01',
    path: POST_PATH,
  })
  assert.equal(upstreamCalls, 1)

  // The provider rate limit is now exhausted. refresh rescues the caller from
  // the stored snapshot; live_only reports that it could not read upstream.
  const fallback = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'refresh' },
    idempotencyKey: 'tikhub-live-refresh-01',
    path: POST_PATH,
  })
  assert.equal(fallback.sourceMode, 'stored_fallback')
  assert.equal(fallback.body.meta.reason.code, 'provider_rate_limit')
  assert.equal(fallback.body.meta.reason.degraded, true)

  const strict = await captureError(() => state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'live_only' },
    idempotencyKey: 'tikhub-live-strict-01',
    path: POST_PATH,
  }))
  assert.equal(strict.code, 'external_platform_rate_limited')
  assert.equal(upstreamCalls, 1, 'no extra upstream call was made')
})

test('live_only bypasses a fresh Xiaohongshu snapshot and requires an idempotency key', async () => {
  let upstreamCalls = 0
  const state = await gatewayFixture({
    fetchImpl: async () => {
      upstreamCalls += 1
      return jsonResponse(successEnvelope())
    },
  })
  await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl() },
    idempotencyKey: 'tikhub-fresh-warm-01',
    path: POST_PATH,
  })
  assert.equal(upstreamCalls, 1)

  // cache_first would reuse the still-fresh snapshot here; live_only does not.
  const live = await state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'live_only' },
    idempotencyKey: 'tikhub-fresh-strict-01',
    path: POST_PATH,
  })
  assert.equal(live.sourceMode, 'live')
  assert.equal(live.body.meta.reason.code, 'live')
  assert.equal(upstreamCalls, 2)

  const missingKey = await captureError(() => state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'live_only' },
    path: POST_PATH,
  }))
  assert.equal(missingKey.code, 'idempotency_key_required')

  const badMode = await captureError(() => state.gateway.getPost(state.context, {
    body: { platform: 'xiaohongshu', url: noteUrl(), deliveryMode: 'live' },
    idempotencyKey: 'tikhub-fresh-bad-01',
    path: POST_PATH,
  }))
  assert.equal(badMode.code, 'invalid_delivery_mode')
})
