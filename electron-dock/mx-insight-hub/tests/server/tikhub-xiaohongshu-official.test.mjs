import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { createApp } from '../../server/app.mjs'
import {
  TIKHUB_PROVIDER_KEY,
  TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
} from '../../server/contracts/tikhub-xiaohongshu.mjs'
import {
  TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
} from '../../server/contracts/tikhub-xiaohongshu-search.mjs'
import {
  TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
} from '../../server/contracts/tikhub-xiaohongshu-user-info.mjs'
import {
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
} from '../../server/contracts/tikhub-xiaohongshu-user-posts.mjs'
import {
  TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS,
  XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY,
  normalizeTikHubXiaohongshuOfficialRequest,
} from '../../server/contracts/tikhub-xiaohongshu-official.mjs'
import { ExternalPlatformAdminService } from '../../server/external-platforms/admin.mjs'
import { TikHubGateway } from '../../server/external-platforms/tikhub-gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const USER_ID = '61b46d790000000010008153'
const NOTE_ID = '675d277d000000000600e655'
const PROVIDER_CREDENTIAL = 'provider-key-must-not-enter-public-output'
const PEPPER = 'official-shaped-xiaohongshu-test-pepper-with-entropy'
const OFFICIAL_OPERATIONS = [...new Set(
  Object.values(TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS).map((endpoint) => endpoint.operation),
)]

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${server.address().port}`
}

function note(id = NOTE_ID, cursor = null) {
  return {
    note_id: id,
    display_title: '完整标题',
    desc: '业务正文 token= 是正文的一部分，不能按字段名或内容模式删除。',
    image_list: [{ url: 'https://sns-img.example/note.webp?signature=business-signed-url' }],
    user: { user_id: USER_ID, nickname: 'Alice' },
    ...(cursor ? { cursor } : {}),
  }
}

function config() {
  return {
    configured: true,
    contractVerified: true,
    searchContractVerified: true,
    userActivityContractVerified: true,
    searchCanaryConsumerIds: [],
    maxConcurrency: 8,
    maxConsumerConcurrency: 4,
    maxRequestsPerMinute: 120,
    freshTtlMs: 60_000,
    staleTtlMs: 86_400_000,
    searchFreshTtlMs: 60_000,
    searchStaleTtlMs: 86_400_000,
    billing: {
      currency: 'CNY',
      monthlyBudgetMinor: 100_000,
      monthlySubsidyBudgetMinor: 100_000,
      unitCostMinorByEndpoint: {
        'xiaohongshu.image-note-detail.v2': 5,
        'xiaohongshu.app-v2.search-notes.v1': 7,
        'xiaohongshu.app-v2.search-users.v1': 11,
        'xiaohongshu.app-v2.get-user-info.v1': 13,
        'xiaohongshu.app-v2.get-user-posted-notes.v1': 17,
      },
    },
  }
}

async function fixture(fetchImpl, {
  detailGrant = true,
  keyCapabilities = null,
  keyPlatforms = ['xiaohongshu'],
  searchCanary = 'global',
} = {}) {
  const usageStore = new MemoryStore()
  const service = new HubService({ store: usageStore, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Official Tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Official Consumer' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 100,
  })
  const consumerCapabilities = [
    XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY,
    ...OFFICIAL_OPERATIONS.filter((capability) => detailGrant || capability !== 'social.posts.resolve'),
  ]
  for (const capability of consumerCapabilities) {
    await service.putCapabilityConfiguration(capability, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 1_000,
      windowSeconds: 3_600,
    })
  }
  const key = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Official Key',
    platforms: keyPlatforms,
    capabilities: keyCapabilities ?? consumerCapabilities,
  })
  const context = await service.authenticate(key.secret)
  const adapter = new TikHubAdapter({ apiKey: PROVIDER_CREDENTIAL, fetchImpl })
  const platformStore = new MemoryExternalPlatformStore({
    usageStore,
    providerKey: TIKHUB_PROVIDER_KEY,
    authorizationPlatform: 'xiaohongshu',
  })
  const gatewayConfig = config()
  if (searchCanary === 'allowed') gatewayConfig.searchCanaryConsumerIds = [consumer.id]
  if (searchCanary === 'denied') {
    gatewayConfig.searchCanaryConsumerIds = ['00000000-0000-4000-8000-000000000000']
  }
  const gateway = new TikHubGateway({
    usageStore,
    platformStore,
    adapter,
    config: gatewayConfig,
    apiKeyPepper: PEPPER,
    reservationLeaseMs: 150_000,
    logger: { warn() {}, error() {} },
  })
  return { usageStore, platformStore, context, gateway, key, service }
}

test('official search query follows TikHub parameters and rejects page 16 before dispatch', () => {
  const request = normalizeTikHubXiaohongshuOfficialRequest('search_notes', {
    keyword: '电子签名避坑',
    page: '15',
    sort_type: 'general',
    note_type: '不限',
    time_filter: '一周内',
    search_id: 'business-search-id',
    search_session_id: 'business-session-id',
    source: 'explore_feed',
    ai_mode: '1',
  })
  assert.deepEqual(request.providerQuery, {
    keyword: '电子签名避坑',
    page: '15',
    sort_type: 'general',
    note_type: '不限',
    time_filter: '一周内',
    search_id: 'business-search-id',
    search_session_id: 'business-session-id',
    source: 'explore_feed',
    ai_mode: '1',
  })
  assert.throws(
    () => normalizeTikHubXiaohongshuOfficialRequest('search_notes', {
      keyword: 'too far', page: '16',
    }),
    (error) => error?.code === 'invalid_page',
  )

  const documentedFilters = {
    sort_type: [
      'general', 'time_descending', 'popularity_descending',
      'comment_descending', 'collect_descending', 'english_preferred',
    ],
    note_type: ['不限', '视频笔记', '普通笔记', '直播笔记'],
    time_filter: ['不限', '一天内', '一周内', '半年内'],
  }
  for (const [field, values] of Object.entries(documentedFilters)) {
    for (const value of values) {
      const accepted = normalizeTikHubXiaohongshuOfficialRequest('search_notes', {
        keyword: '官方枚举',
        [field]: value,
      })
      assert.equal(accepted.providerQuery[field], value)
    }
    assert.throws(
      () => normalizeTikHubXiaohongshuOfficialRequest('search_notes', {
        keyword: '非法枚举',
        [field]: 'unsupported-filter',
      }),
      (error) => error?.code === `invalid_${field}`,
    )
  }
})

test('TikHub Admin metadata exposes every implemented Xiaohongshu App V2 user capability', async () => {
  const admin = new ExternalPlatformAdminService({
    store: new MemoryExternalPlatformStore({
      usageStore: new MemoryStore(),
      providerKey: TIKHUB_PROVIDER_KEY,
      authorizationPlatform: 'xiaohongshu',
    }),
    config: config(),
    providerKey: TIKHUB_PROVIDER_KEY,
  })
  const overview = await admin.overview('24h')
  assert.deepEqual(overview.providers[0].capabilities, [
    'social.posts.search',
    'social.posts.resolve',
    'social.users.resolve',
    'social.users.posts',
  ])

  const detail = await admin.detail(TIKHUB_PROVIDER_KEY, '24h')
  const userResolve = detail.capabilities.find(({ capability }) => capability === 'social.users.resolve')
  assert.equal(userResolve.status, 'implemented')
  assert.equal(userResolve.upstreamEndpoint, 'search_users + get_user_info')
  assert.equal(userResolve.upstreamVersion, 'App V2')
  const userPosts = detail.capabilities.find(({ capability }) => capability === 'social.users.posts')
  assert.equal(userPosts.status, 'implemented')
  assert.equal(userPosts.upstreamEndpoint, 'get_user_posted_notes')
  assert.equal(userPosts.upstreamVersion, 'App V2')
})

test('official identity routes send only the ID when both App V2 selectors are supplied', () => {
  const shareText = 'https://www.xiaohongshu.com/explore/aaaaaaaaaaaaaaaaaaaaaaaa'
  const cases = [
    ['detail', 'note_id', NOTE_ID],
    ['get_user_info', 'user_id', USER_ID],
    ['get_user_posted_notes', 'user_id', USER_ID],
  ]

  for (const [endpointName, idField, id] of cases) {
    const normalized = normalizeTikHubXiaohongshuOfficialRequest(endpointName, {
      [idField]: id.toUpperCase(),
      share_text: shareText,
    })
    assert.deepEqual(normalized.providerQuery, { [idField]: id })
    assert.deepEqual(normalized.publicQuery, { [idField]: id })
  }
})

test('official detail requires the immutable Live Key capability before dispatch', async () => {
  let providerCalls = 0
  const state = await fixture(async () => {
    providerCalls += 1
    return jsonResponse({ code: 200, data: note() })
  }, { detailGrant: false })
  await state.service.putCapabilityConfiguration('social.posts.resolve', {
    tenantId: state.context.tenant.id,
    consumerId: state.context.consumer.id,
    enabled: true,
    maxRequests: 1_000,
    windowSeconds: 3_600,
  })

  await assert.rejects(
    state.gateway.officialXiaohongshu(state.context, {
      endpointName: 'detail',
      path: TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
      query: { note_id: NOTE_ID },
      idempotencyKey: 'official-detail-without-capability',
    }),
    (error) => error?.code === 'capability_not_granted',
  )
  assert.equal(providerCalls, 0)
  assert.equal(state.platformStore.calls.size, 0)
})

test('headerless official calls create distinct downstream usage while sharing a fresh snapshot', async () => {
  let providerCalls = 0
  const state = await fixture(async () => {
    providerCalls += 1
    return jsonResponse({ code: 200, data: note() })
  })
  const input = {
    endpointName: 'detail',
    path: TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
    query: { note_id: NOTE_ID },
  }

  const live = await state.gateway.officialXiaohongshu(state.context, input)
  const cached = await state.gateway.officialXiaohongshu(state.context, input)

  assert.equal(live.sourceMode, 'live')
  assert.equal(cached.sourceMode, 'fresh_cache')
  assert.notEqual(live.requestId, cached.requestId)
  assert.equal(providerCalls, 1)
  assert.equal(state.usageStore.requests.size, 2)
  assert.equal(state.platformStore.calls.size, 1)
  assert.equal(state.platformStore.costReservations.size, 1)
})

test('every official-shaped endpoint requires its data domain, compatibility surface, and operation', async () => {
  const endpointCases = [
    ['search_notes', TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH, { keyword: '电子签名避坑' }],
    ['search_users', TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH, { keyword: 'Alice' }],
    ['get_user_info', TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH, { user_id: USER_ID }],
    ['get_user_posted_notes', TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH, { user_id: USER_ID }],
  ]

  for (const [endpointName, path, query] of endpointCases) {
    const requiredOperation = TIKHUB_XIAOHONGSHU_OFFICIAL_ENDPOINTS[endpointName].operation
    let providerCalls = 0
    const missingOperation = await fixture(async () => {
      providerCalls += 1
      return jsonResponse({ code: 200, data: {} })
    }, {
      keyCapabilities: [
        XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY,
        ...OFFICIAL_OPERATIONS.filter((capability) => capability !== requiredOperation),
      ],
    })
    await assert.rejects(
      missingOperation.gateway.officialXiaohongshu(missingOperation.context, {
        endpointName,
        path,
        query,
        idempotencyKey: `missing-operation-${endpointName}`,
      }),
      (error) => error?.status === 403
        && error?.code === 'capability_not_granted'
        && error?.message.includes(requiredOperation),
    )
    assert.equal(providerCalls, 0)
    assert.equal(missingOperation.usageStore.requests.size, 0)
    assert.equal(missingOperation.platformStore.costReservations.size, 0)

    const missingCompat = await fixture(async () => {
      providerCalls += 1
      return jsonResponse({ code: 200, data: {} })
    }, { keyCapabilities: OFFICIAL_OPERATIONS })
    await assert.rejects(
      missingCompat.gateway.officialXiaohongshu(missingCompat.context, {
        endpointName,
        path,
        query,
        idempotencyKey: `missing-compat-${endpointName}`,
      }),
      (error) => error?.status === 403
        && error?.code === 'capability_not_granted'
        && error?.message.includes(XIAOHONGSHU_APP_V2_COMPAT_CAPABILITY),
    )
    assert.equal(providerCalls, 0)
  }

  const missingPlatform = await fixture(async () => {
    assert.fail('provider must not be called without the data-domain entitlement')
  }, { keyPlatforms: [] })
  await assert.rejects(
    missingPlatform.gateway.officialXiaohongshu(missingPlatform.context, {
      endpointName: 'search_notes',
      path: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
      query: { keyword: '无数据域' },
      idempotencyKey: 'missing-platform-search-notes',
    }),
    (error) => error?.status === 403 && error?.code === 'platform_not_granted',
  )
  assert.equal(missingPlatform.usageStore.requests.size, 0)
  assert.equal(missingPlatform.platformStore.costReservations.size, 0)
})

test('official search_notes enforces the consumer canary before reservations while other endpoints remain open', async () => {
  let deniedProviderCalls = 0
  const denied = await fixture(async (url) => {
    deniedProviderCalls += 1
    const pathname = new URL(url).pathname
    if (pathname === TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH) {
      return jsonResponse({
        code: 200,
        data: { data: { user_id: USER_ID, nickname: 'Alice' } },
      })
    }
    return jsonResponse({ code: 200, data: { data: { items: [] } } })
  }, { searchCanary: 'denied' })

  await assert.rejects(
    denied.gateway.officialXiaohongshu(denied.context, {
      endpointName: 'search_notes',
      path: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
      query: { keyword: '非灰度消费者' },
      idempotencyKey: 'official-search-canary-denied',
    }),
    (error) => error?.status === 503
      && error?.code === 'external_platform_contract_unverified',
  )
  assert.equal(deniedProviderCalls, 0)
  assert.equal(denied.usageStore.requests.size, 0)
  assert.equal(denied.platformStore.costReservations.size, 0)
  assert.equal(denied.platformStore.calls.size, 0)

  const userInfo = await denied.gateway.officialXiaohongshu(denied.context, {
    endpointName: 'get_user_info',
    path: TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
    query: { user_id: USER_ID },
    idempotencyKey: 'official-user-info-canary-independent',
  })
  assert.equal(userInfo.status, 200)
  assert.equal(deniedProviderCalls, 1)

  let allowedProviderCalls = 0
  const allowed = await fixture(async () => {
    allowedProviderCalls += 1
    return jsonResponse({ code: 200, data: { data: { items: [] } } })
  }, { searchCanary: 'allowed' })
  const search = await allowed.gateway.officialXiaohongshu(allowed.context, {
    endpointName: 'search_notes',
    path: TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH,
    query: { keyword: '灰度消费者' },
    idempotencyKey: 'official-search-canary-allowed',
  })
  assert.equal(search.status, 200)
  assert.equal(allowedProviderCalls, 1)
  assert.equal(allowed.platformStore.costReservations.size, 1)
  assert.equal(allowed.platformStore.calls.size, 1)
})

test('all five official-shaped routes preserve business envelopes and share governed storage', async () => {
  const calls = []
  const bodies = new Map([
    [TIKHUB_XIAOHONGSHU_ENDPOINT_PATH, {
      code: 200,
      request_id: 'detail-provider-request',
      credential_echo: PROVIDER_CREDENTIAL,
      data: note(),
    }],
    [TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH, {
      code: 200,
      request_id: 'search-provider-request',
      params: { search_id: 'business-search-id', search_session_id: 'business-session-id' },
      data: {
        page: 1,
        next_page: null,
        search_id: 'business-search-id',
        search_session_id: 'business-session-id',
        data: { items: [{ model_type: 'note', note: { ...note(), desc: '预'.repeat(60) } }] },
      },
    }],
    [TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH, {
      code: 200,
      request_id: 'search-users-provider-request',
      data: { data: { users: [{ id: USER_ID, name: 'Alice', red_id: 'alice-red' }] } },
    }],
    [TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH, {
      code: 200,
      request_id: 'user-info-provider-request',
      data: { data: { user_id: USER_ID, nickname: 'Alice', desc: '完整个人简介' } },
    }],
    [TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH, {
      code: 200,
      request_id: 'user-posts-provider-request',
      data: { data: { has_more: false, notes: [note()] } },
    }],
  ])
  const state = await fixture(async (url, options) => {
    const parsed = new URL(url)
    calls.push({ parsed, options })
    return jsonResponse(bodies.get(parsed.pathname))
  })
  const requests = [
    ['detail', TIKHUB_XIAOHONGSHU_ENDPOINT_PATH, { note_id: NOTE_ID }],
    ['search_notes', TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH, { keyword: '电子签名避坑' }],
    ['search_users', TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH, { keyword: 'Alice' }],
    ['get_user_info', TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH, { user_id: USER_ID }],
    ['get_user_posted_notes', TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH, { user_id: USER_ID }],
  ]
  const results = []
  for (const [endpointName, path, query] of requests) {
    try {
      results.push(await state.gateway.officialXiaohongshu(state.context, {
        endpointName,
        path,
        query,
        idempotencyKey: `official-${endpointName}-request-01`,
      }))
    } catch (error) {
      assert.fail(`${endpointName}: ${error?.code} ${JSON.stringify(error?.details || {})}`)
    }
  }
  const replay = await state.gateway.officialXiaohongshu(state.context, {
    endpointName: 'detail',
    path: TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
    query: { note_id: NOTE_ID },
    idempotencyKey: 'official-detail-request-01',
  })

  assert.equal(calls.length, 5)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, results[0].body)
  assert.equal(calls.every(({ options }) => options.headers.authorization === `Bearer ${PROVIDER_CREDENTIAL}`), true)
  assert.equal(JSON.stringify(results).includes(PROVIDER_CREDENTIAL), false)
  assert.equal(results[0].body.credential_echo, '[REDACTED]')
  assert.equal(results[0].body.data.image_list[0].url.includes('signature=business-signed-url'), true)
  assert.equal(results[0].body.data.desc.includes('token='), true)
  assert.equal(results[1].body.params.search_id, 'business-search-id')
  assert.equal(results[1].body.params.search_session_id, 'business-session-id')
  assert.equal([...state.platformStore.calls.values()].every((entry) => entry.outcome === 'succeeded'), true)
  assert.equal([...state.platformStore.calls.values()].every((entry) => entry.costMinor > 0), true)
  assert.equal(state.platformStore.restrictedResponseArchives.size, 5)
  assert.equal(
    [...state.platformStore.restrictedResponseArchives.values()]
      .some((entry) => entry.bodyText.includes(PROVIDER_CREDENTIAL)),
    true,
    'restricted archive is the exact provider response, even when the provider reflects a credential',
  )
  assert.equal(
    JSON.stringify([...state.platformStore.responseArchives.values()]).includes(PROVIDER_CREDENTIAL),
    false,
  )
  assert.equal(state.platformStore.ingestJobs.length, 5)
  assert.deepEqual(
    state.platformStore.ingestJobs.map((job) => job.payload.records[0].objectType),
    ['post', 'post', 'profile', 'profile', 'post'],
  )
  assert.equal(state.platformStore.ingestJobs[1].payload.records[0].body.length, 60)
  assert.equal(
    state.platformStore.ingestJobs[1].payload.records[0].extensions.bodyCompleteness,
    'provider_preview',
  )
  assert.equal(
    [...state.usageStore.requests.values()].every((request) => request.unitsActual === 1),
    true,
  )
})

test('official search_users marks a paid 200 envelope without data.data.users unusable', async () => {
  const state = await fixture(async () => jsonResponse({
    code: 200,
    request_id: 'search-users-invalid-envelope',
    data: { data: { items: [] } },
  }))

  await assert.rejects(
    state.gateway.officialXiaohongshu(state.context, {
      endpointName: 'search_users',
      path: TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
      query: { keyword: 'Alice' },
      idempotencyKey: 'official-search-users-invalid-envelope',
    }),
    (error) => error?.status === 502
      && error?.code === 'external_platform_response_unusable'
      && error?.details?.normalizationCode === 'invalid_upstream_contract',
  )

  assert.equal(state.platformStore.calls.size, 1)
  const [call] = state.platformStore.calls.values()
  assert.equal(call.outcome, 'succeeded_unusable')
  assert.equal(call.billed, true)
  assert.equal(state.platformStore.restrictedResponseArchives.size, 1)
  assert.equal(state.platformStore.snapshots.size, 0)
  assert.equal(state.platformStore.ingestJobs.length, 0)
})

test('deep valid App V2 JSON is staged with exact bytes before contract rejection', async () => {
  const depth = 12_000
  const bodyText = `{"code":200,"data":${'{"nested":'.repeat(depth)}"terminal"${'}'.repeat(depth)}}`
  const bodyBytes = Buffer.from(bodyText, 'utf8')
  const state = await fixture(async () => new Response(bodyBytes, {
    headers: { 'content-type': 'application/json' },
  }))

  await assert.rejects(
    state.gateway.officialXiaohongshu(state.context, {
      endpointName: 'detail',
      path: TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
      query: { note_id: NOTE_ID },
      idempotencyKey: 'official-detail-deep-invalid-contract',
    }),
    (error) => error?.status === 502
      && error?.code === 'external_platform_response_unusable'
      && error?.details?.normalizationCode === 'invalid_upstream_contract',
  )

  assert.equal(state.platformStore.calls.size, 1)
  const [call] = state.platformStore.calls.values()
  assert.equal(call.outcome, 'succeeded_unusable')
  assert.equal(call.billed, true)
  assert.equal(state.platformStore.responseArchives.size, 1)
  const [responseArchive] = state.platformStore.responseArchives.values()
  assert.equal(responseArchive.rawPayload, null)
  assert.match(responseArchive.payloadSha256, /^[a-f0-9]{64}$/u)
  assert.equal(state.platformStore.restrictedResponseArchives.size, 1)
  const [restricted] = state.platformStore.restrictedResponseArchives.values()
  assert.equal(restricted.bodyBytes.equals(bodyBytes), true)
  assert.equal(restricted.bodyText, bodyText)
  assert.equal(restricted.parsedPayload, null)
  assert.equal(state.platformStore.snapshots.size, 0)
  assert.equal(state.platformStore.ingestJobs.length, 0)
})

test('official identity routes preserve documented service-error envelopes without canonical ingest', async () => {
  const envelopes = new Map()
  const state = await fixture(async (url) => {
    const pathname = new URL(url).pathname
    const envelope = {
      code: 200,
      request_id: `service-error-${envelopes.size + 1}`,
      message: 'Request successful. This request will incur a charge.',
      data: '小红书上游服务异常',
    }
    envelopes.set(pathname, envelope)
    return jsonResponse(envelope)
  })
  const requests = [
    ['detail', TIKHUB_XIAOHONGSHU_ENDPOINT_PATH, { note_id: NOTE_ID }],
    ['get_user_info', TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH, { user_id: USER_ID }],
    ['get_user_posted_notes', TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH, { user_id: USER_ID }],
  ]

  for (const [endpointName, path, query] of requests) {
    const result = await state.gateway.officialXiaohongshu(state.context, {
      endpointName,
      path,
      query,
      idempotencyKey: `official-${endpointName}-service-error`,
    })
    assert.equal(result.status, 200)
    assert.deepEqual(result.body, envelopes.get(path))
  }

  assert.equal(state.platformStore.calls.size, 3)
  assert.equal(
    [...state.platformStore.calls.values()].every((call) => (
      call.outcome === 'succeeded' && call.billed === true && call.itemCount === 0
    )),
    true,
  )
  assert.equal(state.platformStore.restrictedResponseArchives.size, 3)
  assert.equal(state.platformStore.snapshots.size, 3)
  assert.equal(state.platformStore.ingestJobs.length, 0)
})

test('official detail keeps arbitrary code-200 text on the succeeded-unusable path', async () => {
  const state = await fixture(async () => jsonResponse({
    code: 200,
    request_id: 'detail-arbitrary-text',
    data: 'unexpected response text',
  }))

  await assert.rejects(
    state.gateway.officialXiaohongshu(state.context, {
      endpointName: 'detail',
      path: TIKHUB_XIAOHONGSHU_ENDPOINT_PATH,
      query: { note_id: NOTE_ID },
      idempotencyKey: 'official-detail-arbitrary-text',
    }),
    (error) => error?.status === 502
      && error?.code === 'external_platform_response_unusable'
      && error?.details?.normalizationCode === 'invalid_upstream_contract',
  )

  const [call] = state.platformStore.calls.values()
  assert.equal(call.outcome, 'succeeded_unusable')
  assert.equal(call.billed, true)
  assert.equal(state.platformStore.restrictedResponseArchives.size, 1)
  assert.equal(state.platformStore.snapshots.size, 0)
  assert.equal(state.platformStore.ingestJobs.length, 0)
})

test('official user-post traversal never exposes a provider cursor and stops on page 15', async () => {
  const providerCursors = []
  const state = await fixture(async (url) => {
    const parsed = new URL(url)
    const incoming = parsed.searchParams.get('cursor')
    providerCursors.push(incoming)
    const page = providerCursors.length
    return jsonResponse({
      code: 200,
      request_id: `posts-page-${page}`,
      data: {
        data: {
          has_more: true,
          notes: [note(page.toString(16).padStart(24, '0'), `provider-cursor-${page + 1}`)],
        },
      },
    })
  })
  let cursor = null
  let last
  for (let page = 1; page <= 15; page += 1) {
    last = await state.gateway.officialXiaohongshu(state.context, {
      endpointName: 'get_user_posted_notes',
      path: TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
      query: { user_id: USER_ID, ...(cursor ? { cursor } : {}) },
      idempotencyKey: `official-user-posts-page-${String(page).padStart(2, '0')}`,
    })
    cursor = last.body.data.data.notes[0].cursor
    if (page < 15) {
      assert.equal(cursor.startsWith('mxec2.'), true)
      assert.equal(JSON.stringify(last.body).includes(`provider-cursor-${page + 1}`), false)
    }
  }
  assert.deepEqual(providerCursors, [
    null,
    ...Array.from({ length: 14 }, (_value, index) => `provider-cursor-${index + 2}`),
  ])
  assert.equal(last.body.data.data.has_more, false)
  assert.equal(last.body.data.data.notes[0].cursor, null)
  assert.equal(state.platformStore.restrictedResponseArchives.size, 15)
  assert.equal(
    [...state.platformStore.restrictedResponseArchives.values()].at(-1)
      .bodyText.includes('provider-cursor-16'),
    true,
  )
})

test('HTTP App V2 detail route returns the provider business envelope under Hub governance', async () => {
  let providerCalls = 0
  const upstream = {
    code: 200,
    request_id: 'provider-visible-request-id',
    credential_echo: PROVIDER_CREDENTIAL,
    data: note(),
  }
  const state = await fixture(async () => {
    providerCalls += 1
    return jsonResponse(upstream)
  })
  const server = createServer(createApp({
    service: state.service,
    store: state.usageStore,
    adapter: {},
    tikHubGateway: state.gateway,
    adminToken: null,
    listenerMode: 'public',
    logger: { warn() {}, error() {} },
  }))
  const baseUrl = await listen(server)
  try {
    const response = await fetch(
      `${baseUrl}${TIKHUB_XIAOHONGSHU_ENDPOINT_PATH}?note_id=${NOTE_ID}`,
      {
        headers: {
          authorization: `Bearer ${state.key.secret}`,
        },
      },
    )
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-mx-insight-source-mode'), 'live')
    assert.equal(payload.code, 200)
    assert.equal(payload.request_id, upstream.request_id)
    assert.equal(payload.requestId, undefined)
    assert.equal(payload.credential_echo, '[REDACTED]')
    assert.equal(payload.data.image_list[0].url.includes('signature=business-signed-url'), true)

    const jsonHeaders = { authorization: `Bearer ${state.key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'xhs-json-replay-test' }
    const post = await fetch(`${baseUrl}${TIKHUB_XIAOHONGSHU_ENDPOINT_PATH}`, {
      method: 'POST', headers: jsonHeaders, body: JSON.stringify({ note_id: NOTE_ID }),
    })
    assert.equal(post.status, 200)
    assert.equal((await post.json()).data.desc, upstream.data.desc)
    const transportReplay = await fetch(`${baseUrl}${TIKHUB_XIAOHONGSHU_ENDPOINT_PATH}?note_id=${NOTE_ID}`, { headers: jsonHeaders })
    assert.equal(transportReplay.status, 200)
    assert.equal(transportReplay.headers.get('idempotent-replay'), 'true')
    for (const body of [[], { note_id: {} }, { note_id: NOTE_ID, endpoint: 'arbitrary' }]) {
      const rejected = await fetch(`${baseUrl}${TIKHUB_XIAOHONGSHU_ENDPOINT_PATH}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify(body) })
      assert.equal(rejected.status, 400)
    }
    const mixed = await fetch(`${baseUrl}${TIKHUB_XIAOHONGSHU_ENDPOINT_PATH}?note_id=${NOTE_ID}`, { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ note_id: NOTE_ID }) })
    assert.equal(mixed.status, 400)

    const replayResponse = await fetch(
      `${baseUrl}${TIKHUB_XIAOHONGSHU_ENDPOINT_PATH}?note_id=${NOTE_ID}`,
      { headers: { authorization: `Bearer ${state.key.secret}` } },
    )
    assert.equal(replayResponse.status, 200)
    assert.equal(
      replayResponse.headers.get('idempotent-replay'),
      'false',
      'a headerless HTTP call is a new downstream charge even when it reuses the governed snapshot',
    )

    const invalidPage = await fetch(
      `${baseUrl}${TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH}?keyword=test&page=16`,
      {
        headers: {
          authorization: `Bearer ${state.key.secret}`,
        },
      },
    )
    assert.equal(invalidPage.status, 400)
    assert.equal((await invalidPage.json()).error.code, 'invalid_page')
    for (const [field, value, code] of [
      ['sort_type', 'latest', 'invalid_sort_type'],
      ['note_type', '图文', 'invalid_note_type'],
      ['time_filter', '一个月内', 'invalid_time_filter'],
    ]) {
      const invalidFilter = await fetch(
        `${baseUrl}${TIKHUB_XIAOHONGSHU_SEARCH_ENDPOINT_PATH}?keyword=test&${field}=${encodeURIComponent(value)}`,
        { headers: { authorization: `Bearer ${state.key.secret}` } },
      )
      assert.equal(invalidFilter.status, 400)
      assert.equal((await invalidFilter.json()).error.code, code)
    }
    assert.equal(providerCalls, 1, 'invalid query values must fail before a paid dispatch')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
