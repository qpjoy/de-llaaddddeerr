import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { TIKHUB_PROVIDER_KEY } from '../../server/contracts/tikhub-xiaohongshu.mjs'
import {
  buildXiaohongshuUserInfoPlan,
  normalizeTikHubXiaohongshuSearchUsersResponse,
  normalizeTikHubXiaohongshuUserInfoResponse,
  toNightAllXiaohongshuUserInfoEnvelope,
  TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
  TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
  XIAOHONGSHU_USER_INFO_OPERATION,
} from '../../server/contracts/tikhub-xiaohongshu-user-info.mjs'
import {
  normalizeTikHubXiaohongshuUserPostsResponse,
  normalizeXiaohongshuCrawlRequest,
  toNightAllXiaohongshuCrawlEnvelope,
  TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
  XIAOHONGSHU_CRAWL_OPERATION,
} from '../../server/contracts/tikhub-xiaohongshu-user-posts.mjs'
import { createExternalPlatformCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { TikHubUserInfoGateway } from '../../server/external-platforms/tikhub-user-info-gateway.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const USER_ID = '61b46d790000000010008153'
const NOTE_ID = '675d277d000000000600e655'
const CAPTURED_AT = '2026-09-09T01:02:03.000Z'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('XHS user-info plan accepts one bounded identifier and resolves usernames explicitly', () => {
  const plan = buildXiaohongshuUserInfoPlan({
    platform: 'xiaohongshu',
    username: 'love1imagine1dragons',
    count: 20,
  })

  assert.deepEqual(plan.identifiers, [{ kind: 'username', value: 'love1imagine1dragons' }])
  assert.deepEqual(plan.calls, [{
    role: 'resolve',
    endpointPath: TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
    query: { keyword: 'love1imagine1dragons', page: '1' },
  }])
  assert.throws(
    () => buildXiaohongshuUserInfoPlan({
      platform: 'xiaohongshu', userIds: [USER_ID], usernames: ['love1imagine1dragons'],
    }),
    (error) => error?.code === 'multiple_user_identifiers_not_supported',
  )
})

test('XHS user-info plan sends an official profile share link as share_text without resolving', () => {
  const plan = buildXiaohongshuUserInfoPlan({
    platform: 'xiaohongshu',
    profileUrl: 'https://www.xiaohongshu.com/user/profile/61b46d790000000010008153?xsec_token=signed',
  })
  assert.deepEqual(plan.calls, [{
    role: 'profile',
    endpointPath: TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
    query: {
      share_text: 'https://www.xiaohongshu.com/user/profile/61b46d790000000010008153?xsec_token=signed',
    },
  }])
})

test('search-users resolver only accepts the documented data.data.users path', () => {
  const result = normalizeTikHubXiaohongshuSearchUsersResponse({
    code: 200,
    data: {
      data: {
        users: [{
          id: USER_ID,
          red_id: '4909083829',
          name: 'love1imagine1dragons',
          image: 'https://sns-avatar-qc.xhscdn.com/avatar.webp?token=volatile',
        }],
      },
    },
  }, 'love1imagine1dragons')

  assert.deepEqual(result, {
    userId: USER_ID,
    username: '4909083829',
    displayName: 'love1imagine1dragons',
    avatarUrl: 'https://sns-avatar-qc.xhscdn.com/avatar.webp?token=volatile',
  })
  assert.throws(
    () => normalizeTikHubXiaohongshuSearchUsersResponse({ code: 200, users: [{ id: USER_ID }] }, 'name'),
    (error) => error?.code === 'invalid_upstream_contract',
  )
  assert.throws(
    () => normalizeTikHubXiaohongshuSearchUsersResponse({
      code: 200,
      data: { data: { users: [{ id: USER_ID, name: 'different-user' }] } },
    }, 'name'),
    (error) => error?.code === 'upstream_user_unavailable',
  )
  assert.throws(
    () => normalizeTikHubXiaohongshuSearchUsersResponse({
      code: 200,
      data: { data: { users: [
        { id: USER_ID, name: 'name' },
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', red_id: 'name' },
      ] } },
    }, 'name'),
    (error) => error?.code === 'upstream_user_ambiguous',
  )
})

test('user avatar URL projection removes nested encoded provider credentials', () => {
  const providerCredential = 'Tik/user-key+space ?&'
  const lowerInner = encodeURIComponent(providerCredential).replace(
    /%[0-9A-F]{2}/gu,
    (escape) => escape.toLowerCase(),
  )
  const reflected = encodeURIComponent(lowerInner)
  const result = normalizeTikHubXiaohongshuSearchUsersResponse({
    code: 200,
    data: { data: { users: [{
      id: USER_ID,
      name: 'alice',
      image: `https://avatar.example.test/u.webp?credential=${reflected}&signature=business`,
    }] } },
  }, 'alice', { providerCredential })

  assert.equal(result.avatarUrl.includes(providerCredential), false)
  assert.equal(result.avatarUrl.includes(reflected), false)
  assert.match(result.avatarUrl, /REDACTED/u)
  assert.match(result.avatarUrl, /signature=business/u)
})

test('user-info normalizer preserves provider business fields without exposing raw control fields', () => {
  const profile = normalizeTikHubXiaohongshuUserInfoResponse({
    code: 200,
    request_id: 'provider-request-private',
    data: {
      data: {
        user_id: USER_ID,
        red_id: '4909083829',
        nickname: 'Imagine Dragons',
        desc: 'official profile bio',
        images: 'https://sns-avatar-qc.xhscdn.com/avatar.webp?token=volatile',
        fans: '1234',
        follows: 88,
        interaction: 999,
        note_count: 42,
        ip_location: '上海',
      },
    },
  }, { expectedUserId: USER_ID, capturedAt: CAPTURED_AT })

  assert.deepEqual(profile, {
    user_id: USER_ID,
    user_name: '4909083829',
    platform_name: 'xiaohongshu',
    name: 'Imagine Dragons',
    description: 'official profile bio',
    location: '上海',
    followers_count: 1234,
    following_count: 88,
    verified: false,
    blue_verified: false,
    profile_image_url: 'https://sns-avatar-qc.xhscdn.com/avatar.webp?token=volatile',
    url: `https://www.xiaohongshu.com/user/profile/${USER_ID}`,
    original_url: `https://www.xiaohongshu.com/user/profile/${USER_ID}`,
    created_at: null,
    created_time: null,
    updated_time: null,
    crawled_at: 1788915723,
    metrics: { interactions: 999, notes: 42 },
  })
  assert.equal(JSON.stringify(profile).includes('provider-request-private'), false)
  assert.throws(
    () => normalizeTikHubXiaohongshuUserInfoResponse({
      code: 200,
      data: { data: { nickname: 'Profile without identity' } },
    }, { expectedUserId: USER_ID, capturedAt: CAPTURED_AT }),
    (error) => error?.code === 'invalid_upstream_contract',
  )
})

test('legacy user-info envelope keeps raw_info/raw_data and nine-field page contract', () => {
  const plan = buildXiaohongshuUserInfoPlan({
    platform: 'xiaohongshu', userId: USER_ID, count: 20,
  })
  const profile = normalizeTikHubXiaohongshuUserInfoResponse({
    code: 200,
    data: { user_id: USER_ID, nickname: 'Alice' },
  }, { expectedUserId: USER_ID, capturedAt: CAPTURED_AT })
  const envelope = toNightAllXiaohongshuUserInfoEnvelope([profile], plan.page, {
    providerCalls: 1,
    durationMs: 12,
  })

  assert.equal(JSON.parse(envelope.data.raw_info).length, 1)
  assert.deepEqual(JSON.parse(envelope.data.raw_data), [])
  assert.deepEqual(Object.keys(envelope.data.page), [
    'page', 'pageSize', 'returnedCount', 'hasMore', 'nextCursor',
    'providerCursor', 'nextParams', 'nextPage', 'paginationMode',
  ])
  assert.equal(envelope.data.meta.rawInfoCount, 1)
  assert.equal(envelope.data.meta.providerCalls, 1)
})

test('XHS crawl accepts one identity and binds an opaque continuation to it', () => {
  const codec = createExternalPlatformCursorCodec('crawl-contract-secret', 'consumer-one')
  const first = normalizeXiaohongshuCrawlRequest({
    platform: 'xiaohongshu', userId: USER_ID, count: 20,
  }, { decodeCursor: codec.decode, maxPageSize: 100 })
  const normalized = normalizeTikHubXiaohongshuUserPostsResponse({
    code: 200,
    data: {
      data: {
        has_more: true,
        notes: [{
          note_id: NOTE_ID,
          display_title: '完整正文测试',
          desc: '这是一段超过六十个字符且必须原样保留的正文内容，用来确认用户主页笔记列表不会被 Hub 主动截断，也不会把提供商游标泄露到兼容响应中。',
          cursor: 'provider-cursor-page-2',
          user: { user_id: USER_ID, nickname: 'Alice' },
          interact_info: { liked_count: '3' },
        }],
      },
    },
  }, first, {
    capturedAt: new Date(CAPTURED_AT),
    encodeCursor: codec.encode,
    resolvedUserId: USER_ID,
  })
  const next = normalizeXiaohongshuCrawlRequest({
    platform: 'xiaohongshu', userId: USER_ID, count: 20,
    cursor: normalized.page.nextCursor,
  }, { decodeCursor: codec.decode, maxPageSize: 100 })

  assert.equal(first.page, 1)
  assert.deepEqual(first.identity, { kind: 'user_id', value: USER_ID })
  assert.equal(normalized.items[0].externalId, NOTE_ID)
  assert.equal(normalized.items[0].text.includes('提供商游标泄露'), true)
  assert.equal(normalized.page.nextCursor.startsWith('mxec2.'), true)
  assert.equal(normalized.page.nextCursor.includes('provider-cursor-page-2'), false)
  assert.equal(next.page, 2)
  assert.equal(next.providerCursor, 'provider-cursor-page-2')
  assert.equal(next.resolvedUserId, USER_ID)
})

test('XHS crawl rejects batches and stalled provider continuations before another page is exposed', () => {
  assert.throws(
    () => normalizeXiaohongshuCrawlRequest({
      platform: 'xiaohongshu', userId: USER_ID, count: 10,
    }),
    (error) => error?.code === 'unsupported_page_size',
  )
  assert.throws(
    () => normalizeXiaohongshuCrawlRequest({
      platform: 'xiaohongshu', userIds: [USER_ID, 'aaaaaaaaaaaaaaaaaaaaaaaa'], count: 20,
    }),
    (error) => error?.code === 'multiple_user_identifiers_not_supported',
  )

  const request = normalizeXiaohongshuCrawlRequest({
    platform: 'xiaohongshu', userId: USER_ID, count: 20,
  })
  assert.throws(
    () => normalizeTikHubXiaohongshuUserPostsResponse({
      code: 200,
      data: { data: { has_more: true, notes: [{ note_id: NOTE_ID, desc: '正文', cursor: 'same-cursor' }] } },
    }, { ...request, page: 2, providerCursor: 'same-cursor' }, {
      resolvedUserId: USER_ID,
      encodeCursor: () => 'opaque',
    }),
    (error) => error?.code === 'invalid_upstream_pagination',
  )

  const terminal = normalizeTikHubXiaohongshuUserPostsResponse({
    code: 200,
    data: { data: { has_more: true, notes: [{ note_id: NOTE_ID, desc: '正文', cursor: 'page-16' }] } },
  }, { ...request, page: 15, providerCursor: 'page-15' }, {
    resolvedUserId: USER_ID,
    encodeCursor: () => 'must-not-be-used',
  })
  assert.equal(terminal.page.hasMore, false)
  assert.equal(terminal.page.nextCursor, null)
  assert.equal(terminal.warnings[0].code, 'PAGE_LIMIT_REACHED')
})

test('XHS crawl uses the same count/pageSize/limit precedence as the legacy facade', () => {
  const countWins = normalizeXiaohongshuCrawlRequest({
    platform: 'xiaohongshu', userId: USER_ID, count: 20, pageSize: 10, limit: 5,
  })
  const pageSizeWins = normalizeXiaohongshuCrawlRequest({
    platform: 'xiaohongshu', userId: USER_ID, pageSize: 20, limit: 5,
  })

  assert.equal(countWins.pageSize, 20)
  assert.equal(pageSizeWins.pageSize, 20)
  assert.throws(
    () => normalizeXiaohongshuCrawlRequest({
      platform: 'xiaohongshu', userId: USER_ID, count: 10, pageSize: 20, limit: 20,
    }),
    (error) => error?.code === 'unsupported_page_size',
  )
})

test('legacy crawl envelope returns profile and posts without provider cursor leakage', () => {
  const request = normalizeXiaohongshuCrawlRequest({
    platform: 'xiaohongshu', userId: USER_ID, count: 20,
  })
  const profile = normalizeTikHubXiaohongshuUserInfoResponse({
    code: 200, data: { data: { user_id: USER_ID, nickname: 'Alice' } },
  }, { expectedUserId: USER_ID, capturedAt: CAPTURED_AT })
  const posts = normalizeTikHubXiaohongshuUserPostsResponse({
    code: 200,
    data: { data: { has_more: false, notes: [{ note_id: NOTE_ID, desc: '正文', cursor: 'terminal' }] } },
  }, request, { resolvedUserId: USER_ID, capturedAt: CAPTURED_AT, encodeCursor: () => 'unused' })
  const envelope = toNightAllXiaohongshuCrawlEnvelope(profile, posts, { providerCalls: 2, durationMs: 9 })

  assert.equal(JSON.parse(envelope.data.raw_info)[0].user_id, USER_ID)
  assert.equal(JSON.parse(envelope.data.raw_data)[0].content_id, NOTE_ID)
  assert.equal(JSON.parse(envelope.data.raw_data)[0].full_text, '正文')
  assert.equal(envelope.data.page.providerCursor, null)
  assert.equal(JSON.stringify(envelope).includes('terminal'), false)
})

test('TikHub adapter resolves username, profile and posted notes through pinned App V2 paths', async () => {
  const calls = []
  const postedNotesBody = {
    code: 200,
    request_id: 'posts-upstream-request',
    cache_url: 'https://provider.example/posts-cache?token=private',
    params: { search_id: 'provider-business-search-id' },
    data: {
      data: {
        search_session_id: 'provider-business-session-id',
        has_more: false,
        notes: [{
          note_id: NOTE_ID,
          desc: '正文业务内容 token=这不是认证凭据，必须原样归档',
          xsec_token: 'signed-media-business-token',
          image_list: [{ url: 'https://sns-img.example/image.webp?signature=business' }],
        }],
      },
    },
  }
  const adapter = new TikHubAdapter({
    apiKey: 'provider-key-must-never-be-archived',
    fetchImpl: async (url, options) => {
      calls.push({ url: new URL(url), options })
      if (url.includes('/search_users')) {
        return jsonResponse({
          code: 200,
          request_id: 'resolve-upstream-request',
          params: { authorization: 'provider-key-must-never-be-archived' },
          data: { data: { users: [{ id: USER_ID, name: 'Alice', red_id: 'alice-red' }] } },
        })
      }
      if (url.includes('/get_user_posted_notes')) {
        return jsonResponse(postedNotesBody)
      }
      return jsonResponse({
        code: 200,
        request_id: 'profile-upstream-request',
        cache_url: 'https://provider.example/cache?token=private',
        data: { data: { user_id: USER_ID, nickname: 'Alice', fans: 3 } },
      })
    },
  })

  const resolved = await adapter.searchXiaohongshuUsers('alice', {
    credential: 'provider-key-must-never-be-archived',
    capturedAt: new Date(CAPTURED_AT),
  })
  const profile = await adapter.getXiaohongshuUserInfo({ user_id: resolved.user.userId }, {
    credential: 'provider-key-must-never-be-archived',
    capturedAt: new Date(CAPTURED_AT),
  })
  const request = normalizeXiaohongshuCrawlRequest({
    platform: 'xiaohongshu', userId: USER_ID, count: 20,
  })
  const posts = await adapter.getXiaohongshuUserPostedNotes({ user_id: USER_ID }, request, {
    credential: 'provider-key-must-never-be-archived',
    capturedAt: new Date(CAPTURED_AT),
    encodeCursor: () => 'unused',
  })

  assert.equal(calls.length, 3)
  assert.equal(calls[0].url.pathname, TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH)
  assert.equal(calls[0].url.searchParams.get('keyword'), 'alice')
  assert.equal(calls[0].url.searchParams.get('page'), '1')
  assert.equal(calls[1].url.pathname, TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH)
  assert.equal(calls[1].url.searchParams.get('user_id'), USER_ID)
  assert.equal(calls[2].url.pathname, TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH)
  assert.equal(calls[2].url.searchParams.get('user_id'), USER_ID)
  assert.equal(calls[2].url.searchParams.has('cursor'), false)
  assert.equal(calls[0].options.headers.authorization, 'Bearer provider-key-must-never-be-archived')
  assert.equal(resolved.user.userId, USER_ID)
  assert.equal(profile.profile.user_id, USER_ID)
  assert.equal(profile.profile.name, 'Alice')
  assert.equal(posts.posts.items[0].externalId, NOTE_ID)
  assert.equal(posts.posts.items[0].media[0].url.includes('signature=business'), true)
  assert.equal(
    posts.restrictedResponseArchive.bodySha256,
    createHash('sha256').update(JSON.stringify(postedNotesBody), 'utf8').digest('hex'),
  )
  assert.equal(posts.restrictedResponseArchive.jsonParsed, true)
  assert.deepEqual(posts.restrictedResponseArchive.parsedPayload, postedNotesBody)
  assert.equal(posts.restrictedResponseArchive.bodyText, JSON.stringify(postedNotesBody))
  assert.equal(Object.keys(posts).includes('restrictedResponseArchive'), false)
  const archives = JSON.stringify([
    resolved.responseArchive,
    resolved.archiveObjects,
    profile.responseArchive,
    profile.archiveObjects,
    posts.responseArchive,
    posts.archiveObjects,
  ])
  assert.equal(archives.includes('provider-key-must-never-be-archived'), false)
  assert.equal(archives.includes('cache_url'), true)
  assert.equal(archives.includes('provider-business-search-id'), true)
  assert.equal(archives.includes('provider-business-session-id'), true)
  assert.equal(resolved.restrictedResponseArchive.bodyText.includes('provider-key-must-never-be-archived'), true)
})

test('restricted TikHub evidence hashes exact UTF-8 bytes including a BOM', async () => {
  const payload = {
    code: 200,
    data: { data: { user_id: USER_ID, nickname: 'BOM profile' } },
  }
  const bytes = Buffer.concat([
    Buffer.from([0xEF, 0xBB, 0xBF]),
    Buffer.from(JSON.stringify(payload), 'utf8'),
  ])
  const adapter = new TikHubAdapter({
    apiKey: 'provider-key',
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })

  const result = await adapter.getXiaohongshuUserInfo({ user_id: USER_ID }, {
    capturedAt: new Date(CAPTURED_AT),
  })

  assert.equal(result.profile.name, 'BOM profile')
  assert.equal(result.restrictedResponseArchive.bodySize, bytes.byteLength)
  assert.equal(
    result.restrictedResponseArchive.bodySha256,
    createHash('sha256').update(bytes).digest('hex'),
  )
  assert.equal(result.restrictedResponseArchive.bodyBytes.equals(bytes), true)
  assert.equal(result.restrictedResponseArchive.bodyText.codePointAt(0), 0xFEFF)
  assert.equal(result.restrictedResponseArchive.jsonParsed, true)
  assert.deepEqual(result.restrictedResponseArchive.parsedPayload, payload)
})

test('restricted TikHub evidence retains bounded invalid UTF-8 bytes without inventing a text view', async () => {
  const bytes = Buffer.from([0x7B, 0x22, 0x78, 0x22, 0x3A, 0x22, 0xC3, 0x28, 0x22, 0x7D])
  const adapter = new TikHubAdapter({
    apiKey: 'provider-key',
    fetchImpl: async () => new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  })

  const error = await adapter.getXiaohongshuUserInfo({ user_id: USER_ID }).then(
    () => null,
    (caught) => caught,
  )
  assert.equal(error?.evidence?.errorCode, 'invalid_upstream_encoding')
  assert.equal(error.restrictedResponseArchive.bodyBytes.equals(bytes), true)
  assert.equal(error.restrictedResponseArchive.bodySize, bytes.byteLength)
  assert.equal(error.restrictedResponseArchive.bodyText, null)
  assert.equal(error.restrictedResponseArchive.jsonParsed, false)
  assert.equal(error.restrictedResponseArchive.parsedPayload, null)
})

async function gatewayFixture(fetchImpl, {
  monthlyBudgetMinor = 1_000,
  monthlySubsidyBudgetMinor = 1_000,
} = {}) {
  const usageStore = new MemoryStore()
  const service = new HubService({
    store: usageStore,
    adapter: {},
    apiKeyPepper: 'user-info-gateway-test-pepper-with-entropy',
  })
  const tenant = await service.createTenant({ name: 'Profile Tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Profile Consumer' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 1_000,
    windowSeconds: 3_600,
    maxPageSize: 20,
  })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Profile Key' })
  const context = await service.authenticate(key.secret)
  const adapter = new TikHubAdapter({ apiKey: 'fake-provider-key', fetchImpl })
  const platformStore = new MemoryExternalPlatformStore({
    usageStore,
    providerKey: TIKHUB_PROVIDER_KEY,
    authorizationPlatform: 'xiaohongshu',
  })
  const gateway = new TikHubUserInfoGateway({
    usageStore,
    platformStore,
    adapter,
    apiKeyPepper: 'user-info-gateway-test-pepper-with-entropy',
    reservationLeaseMs: 150_000,
    logger: { warn() {}, error() {} },
    config: {
      userActivityContractVerified: true,
      maxConcurrency: 8,
      maxConsumerConcurrency: 4,
      maxRequestsPerMinute: 120,
      freshTtlMs: 60_000,
      staleTtlMs: 86_400_000,
      billing: {
        currency: 'CNY',
        monthlyBudgetMinor,
        monthlySubsidyBudgetMinor,
        unitCostMinor: 5,
        unitCostMinorByEndpoint: {
          'xiaohongshu.app-v2.search-users.v1': 7,
          'xiaohongshu.app-v2.get-user-info.v1': 11,
          'xiaohongshu.app-v2.get-user-posted-notes.v1': 13,
        },
      },
    },
  })
  return { context, usageStore, platformStore, gateway }
}

test('Hub-native user-info persists invalid UTF-8 as restricted failure evidence', async () => {
  const bytes = Buffer.from([0x7B, 0x22, 0x78, 0x22, 0x3A, 0x22, 0xC3, 0x28, 0x22, 0x7D])
  const state = await gatewayFixture(async () => new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))

  await assert.rejects(
    state.gateway.legacyUserInfo(state.context, {
      body: { platform: 'xiaohongshu', userId: USER_ID },
      idempotencyKey: 'xhs-invalid-utf8-evidence',
      path: '/api/v1/search/user-info',
    }),
    (error) => error?.code === 'external_platform_response_unusable'
      && error?.details?.normalizationCode === 'invalid_upstream_encoding',
  )
  assert.equal(state.platformStore.calls.size, 1)
  assert.equal(state.platformStore.responseArchives.size, 1)
  const [ordinaryArchive] = state.platformStore.responseArchives.values()
  assert.match(ordinaryArchive.payloadSha256, /^[a-f0-9]{64}$/u)
  assert.equal(ordinaryArchive.rawPayload, null)
  assert.equal(state.platformStore.restrictedResponseArchives.size, 1)
  const [archive] = state.platformStore.restrictedResponseArchives.values()
  assert.equal(archive.bodyBytes.equals(bytes), true)
  assert.equal(archive.bodyText, null)
  assert.equal(archive.jsonParsed, false)
})

test('Hub-native user-info accounts for resolver/profile calls and queues canonical PG ingest', async () => {
  const fetchCalls = []
  const state = await gatewayFixture(async (url) => {
    fetchCalls.push(new URL(url))
    if (url.includes('/search_users')) {
      return jsonResponse({
        code: 200,
        request_id: 'resolve-paid-call',
        data: { data: { users: [{ id: USER_ID, name: 'Alice', red_id: 'alice-red' }] } },
      })
    }
    return jsonResponse({
      code: 200,
      request_id: 'profile-paid-call',
      data: { data: { user_id: USER_ID, nickname: 'Alice', fans: 3 } },
    })
  })

  const request = {
    body: { platform: 'xiaohongshu', username: 'alice', count: 20 },
    idempotencyKey: 'xhs-user-info-request-01',
    path: '/api/v1/night-all/search/user-info',
  }
  const first = await state.gateway.legacyUserInfo(state.context, request)
  const replay = await state.gateway.legacyUserInfo(state.context, request)
  const profileRows = JSON.parse(first.body.data.raw_info)
  const calls = [...state.platformStore.calls.values()]

  assert.equal(first.status, 200)
  assert.equal(first.sourceMode, 'live')
  assert.equal(profileRows[0].user_id, USER_ID)
  assert.equal(profileRows[0].name, 'Alice')
  assert.equal(first.body.requestId, first.requestId)
  assert.equal(replay.replay, true)
  assert.equal(replay.requestId, first.requestId)
  assert.equal(fetchCalls.length, 2, 'idempotent replay must not redispatch either paid endpoint')
  assert.deepEqual(calls.map(({ endpointKey, callOrdinal, callRole, billed, costMinor, outcome }) => ({
    endpointKey, callOrdinal, callRole, billed, costMinor, outcome,
  })), [
    {
      endpointKey: 'xiaohongshu.app-v2.search-users.v1',
      callOrdinal: 0,
      callRole: 'primary',
      billed: true,
      costMinor: 7,
      outcome: 'succeeded',
    },
    {
      endpointKey: 'xiaohongshu.app-v2.get-user-info.v1',
      callOrdinal: 1,
      callRole: 'enrichment',
      billed: true,
      costMinor: 11,
      outcome: 'succeeded',
    },
  ])
  assert.equal(state.platformStore.responseArchives.size, 2)
  assert.equal(state.platformStore.ingestJobs.length, 2)
  assert.equal(state.platformStore.ingestJobs[0].payload.kind, 'external-platform-result')
  assert.equal(state.platformStore.ingestJobs[0].payload.providerKey, 'tikhub')
  assert.deepEqual(
    state.platformStore.ingestJobs.map((job) => job.payload.records[0].objectType),
    ['profile', 'profile'],
  )
  const usage = state.usageStore.requests.get(first.requestId)
  assert.equal(usage.unitsReserved, 1)
  assert.equal(usage.unitsActual, 1, 'username resolution must not change the legacy customer unit')
  assert.equal(usage.billingMeterKey, XIAOHONGSHU_USER_INFO_OPERATION)
})

test('Hub-native crawl resolves one user and follows only its encrypted TikHub cursor', async () => {
  const fetchCalls = []
  const state = await gatewayFixture(async (url) => {
    const parsed = new URL(url)
    fetchCalls.push(parsed)
    if (parsed.pathname.endsWith('/search_users')) {
      return jsonResponse({
        code: 200,
        request_id: 'resolve-paid-call',
        data: { data: { users: [{ id: USER_ID, name: 'alice', red_id: 'alice-red' }] } },
      })
    }
    if (parsed.pathname.endsWith('/get_user_info')) {
      return jsonResponse({
        code: 200,
        request_id: 'profile-paid-call',
        data: { data: { user_id: USER_ID, nickname: 'Alice', fans: 3 } },
      })
    }
    const continuation = parsed.searchParams.get('cursor')
    return jsonResponse({
      code: 200,
      request_id: continuation ? 'posts-page-2' : 'posts-page-1',
      params: { search_session_id: 'business-session-must-be-restricted-raw' },
      data: {
        data: {
          has_more: continuation == null,
          notes: [{
            note_id: continuation ? 'aaaaaaaaaaaaaaaaaaaaaaaa' : NOTE_ID,
            display_title: continuation ? '第二页' : '第一页',
            desc: continuation
              ? '第二页完整正文'
              : '这是一段明显超过六十个字符的完整正文，用于验证 crawl 的兼容接口不会主动截断正文，同时上游游标只会封装在 Hub 的加密游标中。',
            cursor: continuation ? 'terminal-provider-cursor' : 'provider-cursor-page-2',
            user: { user_id: USER_ID, nickname: 'Alice' },
          }],
        },
      },
    })
  })

  const firstRequest = {
    body: { platform: 'xiaohongshu', username: 'alice', count: 20 },
    idempotencyKey: 'xhs-crawl-request-page-01',
    path: '/api/v1/search/crawl',
  }
  const first = await state.gateway.legacyCrawl(state.context, firstRequest)
  const replay = await state.gateway.legacyCrawl(state.context, firstRequest)
  const firstRows = JSON.parse(first.body.data.raw_data)
  const nextCursor = first.body.data.page.nextCursor
  const second = await state.gateway.legacyCrawl(state.context, {
    body: { platform: 'xiaohongshu', username: 'alice', count: 20, cursor: nextCursor },
    idempotencyKey: 'xhs-crawl-request-page-02',
    path: '/api/v1/night-all/search/crawl',
  })

  assert.equal(first.status, 200)
  assert.equal(firstRows[0].full_text.length > 60, true)
  assert.equal(nextCursor.startsWith('mxec2.'), true)
  assert.equal(JSON.stringify(first.body).includes('provider-cursor-page-2'), false)
  assert.equal(replay.replay, true)
  assert.equal(second.body.data.page.page, 2)
  assert.equal(second.body.data.page.hasMore, false)
  assert.equal(fetchCalls.length, 5, 'replay and page-two continuation must not repeat username resolution')
  assert.deepEqual(fetchCalls.map((url) => url.pathname), [
    TIKHUB_XIAOHONGSHU_SEARCH_USERS_ENDPOINT_PATH,
    TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
    TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
    TIKHUB_XIAOHONGSHU_USER_INFO_ENDPOINT_PATH,
    TIKHUB_XIAOHONGSHU_USER_POSTS_ENDPOINT_PATH,
  ])
  assert.equal(fetchCalls[4].searchParams.get('cursor'), 'provider-cursor-page-2')
  assert.deepEqual([...state.platformStore.calls.values()].map((call) => ({
    endpointKey: call.endpointKey,
    costMinor: call.costMinor,
    outcome: call.outcome,
  })), [
    { endpointKey: 'xiaohongshu.app-v2.search-users.v1', costMinor: 7, outcome: 'succeeded' },
    { endpointKey: 'xiaohongshu.app-v2.get-user-info.v1', costMinor: 11, outcome: 'succeeded' },
    { endpointKey: 'xiaohongshu.app-v2.get-user-posted-notes.v1', costMinor: 13, outcome: 'succeeded' },
    { endpointKey: 'xiaohongshu.app-v2.get-user-info.v1', costMinor: 11, outcome: 'succeeded' },
    { endpointKey: 'xiaohongshu.app-v2.get-user-posted-notes.v1', costMinor: 13, outcome: 'succeeded' },
  ])
  assert.equal(state.platformStore.ingestJobs.length, 5)
  assert.deepEqual(
    state.platformStore.ingestJobs.map((job) => job.payload.records.map((record) => record.objectType)),
    [['profile'], ['profile'], ['post'], ['profile'], ['post']],
  )
  assert.equal(state.usageStore.requests.get(first.requestId).unitsActual, 1)
  assert.equal(state.usageStore.requests.get(second.requestId).unitsActual, 1)
  assert.equal(state.usageStore.requests.get(first.requestId).billingMeterKey, XIAOHONGSHU_CRAWL_OPERATION)
  assert.equal(state.usageStore.requests.get(second.requestId).billingMeterKey, XIAOHONGSHU_CRAWL_OPERATION)
  assert.equal([...state.platformStore.costReservations.values()].every((row) => row.status === 'released'), true)
})

test('username crawl reserves the complete provider cost before its first paid call', async () => {
  let releaseFirstCall
  let notifyFirstCall
  const firstCallStarted = new Promise((resolve) => { notifyFirstCall = resolve })
  const firstCallGate = new Promise((resolve) => { releaseFirstCall = resolve })
  const fetchCalls = []
  const state = await gatewayFixture(async (url) => {
    const parsed = new URL(url)
    fetchCalls.push(parsed)
    if (fetchCalls.length === 1) {
      notifyFirstCall()
      await firstCallGate
    }
    if (parsed.pathname.endsWith('/search_users')) {
      const username = parsed.searchParams.get('keyword')
      return jsonResponse({
        code: 200,
        data: { data: { users: [{ id: USER_ID, name: username, red_id: `${username}-red` }] } },
      })
    }
    if (parsed.pathname.endsWith('/get_user_info')) {
      return jsonResponse({ code: 200, data: { data: { user_id: USER_ID, nickname: 'Alice' } } })
    }
    return jsonResponse({
      code: 200,
      data: { data: { has_more: false, notes: [{ note_id: NOTE_ID, desc: '正文', cursor: 'done' }] } },
    })
  }, { monthlyBudgetMinor: 31, monthlySubsidyBudgetMinor: 31 })

  const first = state.gateway.legacyCrawl(state.context, {
    body: { platform: 'xiaohongshu', username: 'alice', count: 20 },
    idempotencyKey: 'xhs-cost-workflow-first',
    path: '/api/v1/search/crawl',
  })
  await firstCallStarted
  const second = state.gateway.legacyCrawl(state.context, {
    body: { platform: 'xiaohongshu', username: 'bob', count: 20 },
    idempotencyKey: 'xhs-cost-workflow-second',
    path: '/api/v1/search/crawl',
  })
  const rejected = await second.then(
    () => null,
    (error) => error,
  )
  assert.equal(rejected?.code, 'external_platform_cost_budget_exhausted')
  assert.equal(fetchCalls.length, 1, 'losing workflow must make zero provider calls')

  releaseFirstCall()
  const delivered = await first
  assert.equal(delivered.status, 200)
  assert.equal(fetchCalls.length, 3)
  assert.equal([...state.platformStore.calls.values()].length, 3)
  assert.equal([...state.platformStore.costReservations.values()].every((row) => row.status === 'released'), true)
})

test('user-activity rollout gate is a live-dispatch kill switch for direct routes and cursors', async () => {
  let providerCalls = 0
  const state = await gatewayFixture(async () => {
    providerCalls += 1
    return jsonResponse({ code: 200, data: { data: { user_id: USER_ID, nickname: 'Alice' } } })
  })
  state.gateway.config.userActivityContractVerified = false

  await assert.rejects(
    state.gateway.legacyUserInfo(state.context, {
      body: { platform: 'xiaohongshu', userId: USER_ID },
      idempotencyKey: 'xhs-user-info-kill-switch',
      path: '/api/v1/search/user-info',
    }),
    (error) => error?.code === 'external_platform_contract_unverified',
  )
  assert.equal(providerCalls, 0)
  assert.equal(state.platformStore.calls.size, 0)
})

test('Hub routes all gated Xiaohongshu crawl and user-info shapes before Night-All dispatch', async () => {
  const usageStore = new MemoryStore()
  const activityCalls = []
  let nightAllPreflights = 0
  const historicalCalls = []
  const service = new HubService({
    store: usageStore,
    adapter: {
      async legacySearchCapabilities() {
        nightAllPreflights += 1
        assert.fail('Historical dispatch must use the Hub-pinned local capability matrix')
      },
      async legacySearch({ operation, body }) {
        historicalCalls.push({ operation, body: structuredClone(body) })
        const payload = {
          data: {
            raw_info: '[]',
            raw_data: '[]',
            page: {
              page: 1,
              pageSize: body.count || body.pageSize || body.limit || 20,
              returnedCount: 0,
              hasMore: false,
              nextCursor: null,
            },
            meta: { resultCount: 0 },
          },
        }
        return { payload, raw: structuredClone(payload) }
      },
    },
    apiKeyPepper: 'user-activity-routing-pepper-with-entropy',
    externalSocialUserActivityEnabled: true,
    externalSocialUserActivity: async (_context, input) => {
      activityCalls.push(structuredClone(input))
      return { status: 200, body: { data: { source: 'tikhub' } }, requestId: 'direct', replay: false }
    },
  })
  const tenant = await service.createTenant({ name: 'Routing Tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Routing Consumer' })
  await service.putPlatformConfiguration('xiaohongshu', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 100,
    windowSeconds: 3_600,
    maxPageSize: 20,
  })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Routing Key' })
  const context = await service.authenticate(key.secret)
  const testKey = await service.createApiKey({
    consumerId: consumer.id,
    name: 'Routing Test Key',
    environment: 'test',
  })
  const testContext = await service.authenticate(testKey.secret)

  await service.nightAllCompatibilitySearch(context, {
    operation: 'crawl',
    body: { platform: 'xiaohongshu', username: 'alice', count: 20 },
    idempotencyKey: 'route-xhs-crawl-01',
    path: '/api/v1/night-all/search/crawl',
  })
  await service.nightAllCompatibilitySearch(context, {
    operation: 'user-info',
    body: { platform: 'xiaohongshu', userId: USER_ID },
    idempotencyKey: 'route-xhs-user-info-01',
    path: '/api/v1/night-all/search/user-info',
  })
  await service.nightAllCompatibilitySearch(context, {
    operation: 'crawl',
    body: { platform: 'xiaohongshu', username: 'alice', count: 10 },
    idempotencyKey: 'route-xhs-crawl-legacy-shape',
    path: '/api/v1/night-all/search/crawl',
  })
  await service.nightAllCompatibilitySearch(testContext, {
    operation: 'user-info',
    body: { platform: 'xiaohongshu', userId: USER_ID },
    idempotencyKey: 'route-xhs-test-key-user-info',
    path: '/api/v1/night-all/search/user-info',
  })

  assert.deepEqual(activityCalls.map(({ operation }) => operation), ['crawl', 'user-info'])
  assert.equal(activityCalls[0].body.username, 'alice')
  assert.equal(activityCalls[1].body.userId, USER_ID)
  assert.deepEqual(historicalCalls.map(({ operation }) => operation), ['crawl', 'user-info'])
  assert.equal(nightAllPreflights, 0)
})
