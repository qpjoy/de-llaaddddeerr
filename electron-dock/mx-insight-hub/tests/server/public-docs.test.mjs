import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../../server/app.mjs'

const FORBIDDEN_PUBLIC_DOC_DETAILS = /x-mx-insight-admin-token|adminToken|launcherSession|availabilityMode|dsnEnv|password|\/internal\/|tikhub|rapidapi|justone/i
const NIGHT_ALL_COMMON_FIELDS = [
  'businessId', 'business_id', 'platform', 'count', 'pageSize', 'limit', 'page',
  'cursor', 'concurrency', 'params', 'includeRaw',
]
const NIGHT_ALL_OPERATION_FIELDS = {
  raw: [
    'keyword', 'query', 'keywords', 'queries', 'disableAutoDetails',
    'includeDetails', 'includeComments', 'commentLimit', 'cacheMaxAgeHours',
    'maxEnrichItems', 'commentCursor', 'enrichConcurrency',
  ],
  crawl: [
    'username', 'usernames', 'userId', 'userIds', 'user_id', 'uid',
    'channelUrl', 'channel_url', 'channelId', 'channel_id', 'url', 'urls',
    'activityTypes', 'cacheMaxAgeHours',
  ],
  'user-info': [
    'username', 'usernames', 'userId', 'userIds', 'user_id', 'uid',
    'url', 'profileUrl', 'profile_url', 'urls',
  ],
}
const NIGHT_ALL_REJECTED_PARAMS = [
  'provider', 'endpoint', 'credential', 'token/auth', 'timeout', 'capability',
  'moduleCode', 'archive', 'fullArchive', 'allTweets', 'archiveLimit',
  'totalCount', 'max*Pages', 'pageCount', 'chunkSize', 'budget', 'crawlDepth',
  'count', 'limit', 'pageSize', 'page', 'pageNumber', 'pageNo', 'concurrency',
  'includeDetails', 'includeComments', 'disableAutoDetails', 'commentLimit',
  'maxEnrichItems', 'enrichConcurrency', 'cacheMaxAgeHours',
]
const NIGHT_ALL_LEGACY_SEARCH_CONTRACT_VERSION = 'night-all.legacy-search-capabilities.v1'
const NIGHT_ALL_COMPATIBILITY_EXAMPLES = {
  raw: { value: { platform: 'xiaohongshu', keyword: 'AI Agent', count: 20 } },
  crawl: { value: { platform: 'twitter', username: 'openai', count: 20 } },
  userInfo: { value: { platform: 'twitter', username: 'openai' } },
}
const NIGHT_ALL_COMPATIBILITY_ERROR_CODES = {
  400: [
    'invalid_request', 'invalid_cursor', 'invalid_platform', 'page_size_exceeded',
    'work_budget_exceeded', 'unsupported_fields', 'business_id_mismatch',
    'idempotency_key_required', 'invalid_idempotency_key',
    'platform_operation_unsupported', 'night_all_rejected',
  ],
  401: ['api_key_required', 'invalid_api_key'],
  403: ['platform_not_granted'],
  404: ['not_found', 'night_all_rejected'],
  409: ['request_in_progress', 'idempotency_conflict', 'request_outcome_unknown', 'night_all_rejected'],
  422: ['night_all_rejected'],
  429: ['quota_exceeded', 'night_all_rejected'],
  502: ['night_all_rejected', 'upstream_outcome_unknown'],
  503: [
    'platform_operation_unavailable',
    'compatibility_capabilities_unavailable',
    'compatibility_store_unavailable',
  ],
}

function assertNightAllCompatibilityRequestSchema(schema) {
  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false)
  assert.deepEqual(schema.required, ['platform'])
  assert.deepEqual(schema['x-mx-common-fields'], NIGHT_ALL_COMMON_FIELDS)
  assert.deepEqual(schema['x-mx-operation-fields'], NIGHT_ALL_OPERATION_FIELDS)
  assert.deepEqual(schema['x-mx-rejected-params'], NIGHT_ALL_REJECTED_PARAMS)
  assert.equal(schema['x-mx-params-limits'].maxDepth, 8)
  assert.equal(schema['x-mx-params-limits'].maxNodes, 1000)
  assert.equal(schema['x-mx-params-limits'].maxStringLength, 8192)
  assert.equal(schema['x-mx-work-budget'].maxRawQueries, 50)
  assert.equal(schema['x-mx-work-budget'].maxCrawlIdentifiers, 50)
  assert.match(schema['x-mx-work-budget'].raw, /queryCount \* effective pageSize/)
  assert.match(schema['x-mx-work-budget'].crawl, /identifierCount \* effective pageSize \* activityTypeCount/)

  const expectedProperties = [...new Set([
    ...NIGHT_ALL_COMMON_FIELDS,
    ...Object.values(NIGHT_ALL_OPERATION_FIELDS).flat(),
  ])].sort()
  assert.deepEqual(Object.keys(schema.properties).sort(), expectedProperties)

  assert.equal(schema.properties.keyword.type, 'string')
  assert.equal(schema.properties.query.type, 'string')
  assert.deepEqual(schema.properties.includeRaw.enum, [false])
  for (const field of ['keywords', 'queries', 'usernames', 'userIds', 'urls']) {
    assert.equal(schema.properties[field].type, 'array', field)
    assert.equal(schema.properties[field].items.type, 'string', field)
    assert.equal(schema.properties[field].maxItems, 100, field)
  }
  for (const field of ['username', 'userId', 'user_id', 'uid', 'channelId', 'channel_id']) {
    assert.deepEqual(schema.properties[field].type, ['string', 'number'], field)
  }
  for (const field of ['channelUrl', 'channel_url', 'url', 'profileUrl', 'profile_url', 'commentCursor']) {
    assert.equal(schema.properties[field].type, 'string', field)
  }

  for (const field of [
    'count', 'pageSize', 'limit', 'page', 'concurrency', 'commentLimit',
    'maxEnrichItems', 'enrichConcurrency',
  ]) {
    assert.deepEqual(schema.properties[field].oneOf.map((entry) => entry.type), ['integer', 'string'], field)
    assert.ok(new RegExp(schema.properties[field].oneOf[1].pattern).test('1'), field)
  }
  assert.equal(schema.properties.commentLimit.oneOf[0].minimum, 1)
  assert.equal(schema.properties.commentLimit.oneOf[0].maximum, 100)
  assert.match('100', new RegExp(schema.properties.commentLimit.oneOf[1].pattern))
  assert.doesNotMatch('101', new RegExp(schema.properties.commentLimit.oneOf[1].pattern))
  assert.equal(schema.properties.cacheMaxAgeHours.minimum, 0)
  assert.equal(schema.properties.cacheMaxAgeHours.maximum, 720)
  assert.equal(schema.properties.maxEnrichItems.oneOf[0].maximum, 20)
  assert.equal(schema.properties.enrichConcurrency.oneOf[0].maximum, 5)
}

function resolveSchema(document, schema) {
  if (!schema?.$ref) return schema
  return document.components.schemas[schema.$ref.split('/').at(-1)]
}

function assertCanonicalContextContract(document) {
  const route = document.paths['/data/canonical/items/{id}/context']?.get
  assert.ok(route)
  assert.equal(route.operationId, 'getCanonicalMessageContext')
  assert.deepEqual(route['x-mx-error-codes']['409'], ['context_not_supported'])
  assert.deepEqual(route['x-mx-error-codes']['503'], [
    'stored_data_unavailable',
    'serving_indexes_unavailable',
  ])
  assert.deepEqual(
    Object.keys(route.responses).map(Number).sort((left, right) => left - right),
    [200, 400, 401, 403, 404, 409, 429, 503],
  )
  const before = route.parameters.find((parameter) => parameter.name === 'before')
  const after = route.parameters.find((parameter) => parameter.name === 'after')
  for (const parameter of [before, after]) {
    assert.equal(parameter.schema.default, 10)
    assert.equal(parameter.schema.minimum, 0)
    assert.equal(parameter.schema.maximum, 50)
  }
  assert.equal(
    route.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/CanonicalContextEnvelope',
  )

  const data = document.components.schemas.CanonicalContextEnvelope.properties.data
  assert.equal(data.additionalProperties, false)
  assert.equal(data.properties.contractVersion.const, 'mx-insight-hub.canonical-context.v1')
  assert.equal(data.properties.items.maxItems, 101)
  assert.equal(data.properties.anchorIndex.maximum, 50)
  assert.deepEqual(data.properties.ordering.properties.fields.const, ['eventTime', 'canonicalId'])
  assert.ok(data.required.includes('storedWindow'))
  assert.ok(data.required.includes('upstreamCompleteness'))

  const completeness = document.components.schemas.CanonicalContextCompleteness
  assert.deepEqual(completeness.properties.status.enum, ['unknown', 'bounded', 'attested_complete'])
  const capability = document.components.schemas.CanonicalContextCapability
  assert.equal(capability.properties.defaultBefore.const, 10)
  assert.equal(capability.properties.maxAfter.const, 50)
}

function assertNightAllPublicContract(document) {
  const compatibility = document.paths['/night-all/search/{operation}'].post
  const compatibilityContent = compatibility.requestBody.content['application/json']
  assert.equal(compatibilityContent.schema.$ref, '#/components/schemas/NightAllLegacyRequest')
  assert.deepEqual(compatibilityContent.examples, NIGHT_ALL_COMPATIBILITY_EXAMPLES)
  assert.deepEqual(compatibility['x-mx-error-codes'], NIGHT_ALL_COMPATIBILITY_ERROR_CODES)
  assert.ok(compatibility.responses[422])
  assert.ok(compatibility.responses[503])
  assert.match(compatibility.description, /data\.legacySearch/)
  assert.match(compatibility.description, /telegram/i)
  assert.match(compatibility.description, /Hub-pinned/i)
  assert.match(compatibility.description, /grant-filtered/i)
  assert.match(compatibility.description, /not fetched from Night-All at request time/i)
  assert.match(compatibility.description, /does not prove current Night-All handler, endpoint, provider, credential, or upstream health/i)
  assert.match(compatibility.responses[200].description, /not masked|retain/i)

  assertNightAllCompatibilityRequestSchema(document.components.schemas.NightAllLegacyRequest)
  const availability = document.components.schemas.NightAllLegacyOperationAvailability
  assert.deepEqual(availability.required, ['supportedPlatforms', 'readyPlatforms'])
  assert.equal(availability.additionalProperties, false)
  assert.equal(availability.properties.supportedPlatforms.uniqueItems, true)
  assert.equal(availability.properties.readyPlatforms.uniqueItems, true)
  assert.match(availability.description, /subset of supportedPlatforms/)
  assert.match(availability.description, /Hub-pinned/i)
  assert.match(availability.description, /deployed Hub contract permits dispatch/i)
  assert.match(availability.description, /not populated by live Night-All discovery/i)
  assert.match(availability.description, /does not prove handler, endpoint, provider, credential, or upstream health/i)
  assert.doesNotMatch(availability.description, /executable handler or endpoint candidate/i)

  const legacySearch = document.components.schemas.NightAllLegacySearchCapabilities
  assert.equal(legacySearch.properties.contractVersion.const, NIGHT_ALL_LEGACY_SEARCH_CONTRACT_VERSION)
  assert.deepEqual(legacySearch.properties.operations.required, ['raw', 'crawl', 'user-info'])
  for (const operation of ['raw', 'crawl', 'user-info']) {
    assert.equal(
      legacySearch.properties.operations.properties[operation].$ref,
      '#/components/schemas/NightAllLegacyOperationAvailability',
    )
  }

  const capabilitiesContent = document.paths['/data/capabilities'].get.responses[200]
    .content['application/json']
  const capabilitiesEnvelope = resolveSchema(document, capabilitiesContent.schema)
  const dataSchema = capabilitiesEnvelope.properties.data
  assert.ok(dataSchema.required.includes('legacySearch'))
  const discoveryProperty = dataSchema.properties.legacySearch
  assert.equal(
    discoveryProperty.oneOf[0].$ref,
    '#/components/schemas/NightAllLegacySearchCapabilities',
  )
  assert.deepEqual(discoveryProperty.oneOf[1], { type: 'null' })
  assert.match(discoveryProperty.description, /Hub-pinned/i)
  assert.match(discoveryProperty.description, /authoritative only for Hub routing/i)
  assert.match(discoveryProperty.description, /not a live Night-All capability or provider-readiness result/i)
  assert.match(discoveryProperty.description, /Null fails closed/i)

  const platformProperties = dataSchema.properties.platforms.items.properties
  assert.deepEqual(platformProperties.source.enum, ['hub'])
  assert.deepEqual(platformProperties.servingMode.enum, ['stored'])

  const capabilitiesExample = capabilitiesContent.example
  const telegram = capabilitiesExample.data.platforms.find(({ platform }) => platform === 'telegram')
  assert.equal(telegram.source, 'hub')
  assert.equal(telegram.servingMode, 'stored')
  for (const platform of ['xiaohongshu', 'twitter']) {
    const entry = capabilitiesExample.data.platforms.find((candidate) => candidate.platform === platform)
    assert.equal(entry.capabilities, undefined)
  }
  assert.equal(
    capabilitiesExample.data.legacySearch.contractVersion,
    NIGHT_ALL_LEGACY_SEARCH_CONTRACT_VERSION,
  )
  for (const operation of ['raw', 'crawl', 'user-info']) {
    const operationExample = capabilitiesExample.data.legacySearch.operations[operation]
    assert.ok(operationExample.supportedPlatforms.includes('twitter'))
    assert.ok(operationExample.readyPlatforms.includes('twitter'))
    assert.equal(operationExample.supportedPlatforms.includes('telegram'), false)
    assert.equal(operationExample.readyPlatforms.includes('telegram'), false)
  }
}

function assertPublicOpinionContract(document) {
  const feed = document.paths['/data/public-opinion/provinces/{province}/items']?.get
  const detail = document.paths['/data/public-opinion/items/{id}']?.get
  assert.ok(feed)
  assert.ok(detail)
  assert.deepEqual(feed.parameters.map((parameter) => parameter.name), [
    'province', 'sort', 'from', 'to', 'pageSize', 'cursor',
  ])
  assert.equal(
    feed.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/PublicOpinionPageEnvelope',
  )
  assert.equal(
    detail.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/PublicOpinionItemEnvelope',
  )
  assert.ok(feed['x-mx-error-codes'][400].includes('invalid_province'))
  assert.ok(feed['x-mx-error-codes'][403].includes('platform_not_granted'))
  assert.ok(feed['x-mx-error-codes'][503].includes('serving_indexes_unavailable'))
  assert.match(feed.description, /effective sort time/i)
  assert.match(feed.description, /publishedAt is null/i)
  assert.ok(detail['x-mx-error-codes'][404].includes('item_not_found'))

  const item = document.components.schemas.PublicOpinionItem
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(item.required, [
    'id', 'title', 'summary', 'url', 'publishedAt', 'collectedAt',
    'province', 'heatScore', 'origin',
  ])
  assert.deepEqual(Object.keys(item.properties), item.required)
  assert.equal(document.components.schemas.PublicOpinionOrigin.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionPageEnvelope.additionalProperties, false)
  assert.doesNotMatch(
    JSON.stringify({
      item: Object.keys(item.properties),
      origin: Object.keys(document.components.schemas.PublicOpinionOrigin.properties),
    }),
    /raw_payload|strategy_id|run_id|llm_reason|extensions|source_item_id|lineage/i,
  )
}

async function withServer(listenerMode, run) {
  const app = createApp({
    service: {},
    store: {},
    adapter: {},
    listenerMode,
    logger: { error() {} },
  })
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('public listener serves self-contained public API documentation', async () => {
  await withServer('public', async (baseUrl) => {
    const response = await fetch(`${baseUrl}/docs`)
    const html = await response.text()

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^text\/html/)
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    assert.match(html, /MX Insight Hub/)
    assert.match(html, /\/api\/v1\/data\/search/)
    assert.match(html, /href="#night-all"/)
    assert.match(html, /<h2 id="night-all">Night-All 兼容层<\/h2>/)
    assert.match(html, /\/api\/v1\/night-all\/search\/raw/)
    assert.match(html, /\/api\/v1\/night-all\/search\/crawl/)
    assert.match(html, /\/api\/v1\/night-all\/search\/user-info/)
    assert.match(html, /night-all-raw-\$\(uuidgen\)/)
    assert.match(html, /night-all-crawl-\$\(uuidgen\)/)
    assert.match(html, /night-all-user-info-\$\(uuidgen\)/)
    assert.match(html, /data\.legacySearch/)
    assert.match(html, /night-all\.legacy-search-capabilities\.v1/)
    assert.match(html, /supportedPlatforms/)
    assert.match(html, /readyPlatforms/)
    assert.match(html, /Hub-pinned/)
    assert.match(html, /不会在请求时从 Night-All 的 capability 接口实时发现/)
    assert.match(html, /不证明 Night-All 当前 handler、endpoint、provider、credential 或上游健康/)
    assert.doesNotMatch(html, /默认 provider 已启用并配置凭据/)
    assert.match(html, /Telegram 不支持/)
    assert.match(html, /source=hub/)
    assert.match(html, /servingMode=stored/)
    assert.match(html, /platform_operation_unsupported/)
    assert.match(html, /platform_operation_unavailable/)
    assert.match(html, /compatibility_capabilities_unavailable/)
    assert.match(html, /compatibility_store_unavailable/)
    assert.match(html, /\/api\/v1\/data\/stored\/search/)
    assert.match(html, /\/api\/v1\/data\/canonical\/search/)
    assert.match(html, /\/api\/v1\/data\/canonical\/items\/\{id\}\/context/)
    assert.match(html, /storedWindow\.hasMoreStoredBefore\/After/)
    assert.match(html, /upstreamCompleteness/)
    assert.match(html, /context_not_supported/)
    assert.match(html, /\/api\/v1\/data\/telegram\/search/)
    assert.match(html, /\/api\/v1\/data\/telegram\/messages/)
    assert.match(html, /\/api\/v1\/data\/public-opinion\/provinces\/\{province\}\/items/)
    assert.match(html, /\/api\/v1\/data\/public-opinion\/items\/\{id\}/)
    assert.match(html, /public_opinion/)
    assert.match(html, /两个 Hub 省级舆情服务索引都有效/)
    assert.match(html, /有效排序时间优先 publishedAt/)
    assert.match(html, /\/api\/v1\/data\/capabilities/)
    assert.match(html, /\/api\/v1\/tools\/tokenize/)
    assert.match(html, /nlp\.tokenize/)
    assert.match(html, /actualBackend/)
    assert.match(html, /canonical\.balanced\.v1/)
    assert.match(html, /HanLP/)
    assert.match(html, /search_profile_degraded/)
    assert.match(html, /\/api\/v1\/requests\/\{requestId\}/)
    assert.match(html, /\/api\/v1\/usage/)
    assert.match(html, /Idempotency-Key/)
    assert.match(html, /nextCursor/)
    assert.doesNotMatch(html, /<script\b/i)
    assert.doesNotMatch(html, /https?:\/\/(?:cdn|unpkg|jsdelivr)\./i)
    assert.doesNotMatch(html, FORBIDDEN_PUBLIC_DOC_DETAILS)
    assert.doesNotMatch(html, /mih_(?:live|test)_[A-Za-z0-9_-]+/i)
  })
})

test('public OpenAPI document contains only implemented Open API paths', async () => {
  await withServer('public', async (baseUrl) => {
    const response = await fetch(`${baseUrl}/docs/openapi.json`)
    const document = await response.json()
    const paths = Object.keys(document.paths)

    assert.equal(response.status, 200)
    assert.equal(document.openapi, '3.1.0')
    assert.deepEqual(paths.sort(), [
      '/data/canonical/items/{id}/context',
      '/data/canonical/search',
      '/data/capabilities',
      '/data/public-opinion/items/{id}',
      '/data/public-opinion/provinces/{province}/items',
      '/data/search',
      '/data/stored/search',
      '/data/telegram/chats',
      '/data/telegram/entities/search',
      '/data/telegram/messages',
      '/data/telegram/search',
      '/night-all/search/{operation}',
      '/requests/{requestId}',
      '/tools/tokenize',
      '/usage',
    ])
    assert.deepEqual(Object.keys(document.components.securitySchemes).sort(), ['apiKeyHeader', 'bearerKey'])

    const serialized = JSON.stringify(document)
    assert.doesNotMatch(serialized, FORBIDDEN_PUBLIC_DOC_DETAILS)
    assert.doesNotMatch(serialized, /mih_(?:live|test)_[A-Za-z0-9_-]+/i)
    assert.match(serialized, /Idempotency-Key/)
    assert.match(serialized, /opaque nextCursor/i)
    assert.equal(
      document.paths['/tools/tokenize'].post.requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/TokenizeRequest',
    )
    assert.deepEqual(
      document.components.schemas.TokenizeEnvelope.properties.data.properties.actualBackend.enum,
      ['hanlp', 'jieba', 'bigram'],
    )
    assert.equal(document.components.schemas.TokenizeRequest.additionalProperties, false)
    assert.equal(document.components.schemas.StoredSearchRequest.additionalProperties, false)
    assert.equal(document.components.schemas.CanonicalSearchRequest.additionalProperties, false)
    assertPublicOpinionContract(document)
    assertNightAllPublicContract(document)
    assertCanonicalContextContract(document)
    assert.deepEqual(document.components.schemas.CanonicalSearchRequest.required, ['query'])
    assert.equal(
      document.components.schemas.CanonicalSearchRequest.properties.searchProfile.default,
      'canonical.balanced.v1',
    )
    assert.deepEqual(
      document.components.schemas.CanonicalSearchRequest.properties.searchProfile.enum,
      [
        'canonical.balanced.v1',
        'canonical.phrase.v1',
        'canonical.terms-all.v1',
        'canonical.zh-recall.v1',
        'canonical.title-prefix.v1',
      ],
    )
    assert.equal(
      document.components.schemas.StoredSearchEnvelope.properties.data.properties.source.const,
      'hub',
    )
    assert.equal(
      document.components.schemas.CanonicalSearchEnvelope.properties.data.properties.source.const,
      'hub',
    )
    assert.ok(
      document.components.schemas.CanonicalSearchEnvelope.properties.data.required.includes('search'),
    )
    assert.deepEqual(
      document.components.schemas.CanonicalSearchEnvelope.properties.data.properties.search.properties.appliedProfile.enum,
      [
        'canonical.balanced.v1',
        'canonical.phrase.v1',
        'canonical.terms-all.v1',
        'canonical.zh-recall.v1',
        'canonical.title-prefix.v1',
        'postgres.substring.v1',
      ],
    )
  })
})

test('static OpenAPI YAML parses and mirrors the dynamic Night-All compatibility schema', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../docs/contracts/openapi.yaml', import.meta.url)),
    'utf8',
  )
  const parsed = spawnSync('python3', ['-c', [
    'import json, sys',
    'import yaml',
    'json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)',
  ].join('; ')], {
    encoding: 'utf8',
    input: source,
  })
  assert.equal(parsed.status, 0, parsed.stderr)
  const document = JSON.parse(parsed.stdout)
  assert.equal(document.openapi, '3.1.0')
  assertNightAllPublicContract(document)
  assertPublicOpinionContract(document)
  assertCanonicalContextContract(document)
})

test('public curl guide defines the legacy matrix as Hub-pinned dispatch policy', async () => {
  const guide = await readFile(
    fileURLToPath(new URL('../../docs/public-api-curl.md', import.meta.url)),
    'utf8',
  )
  assert.match(guide, /Hub-pinned/)
  assert.match(guide, /不会在请求时从\s*Night-All `\/api\/v1\/search\/capabilities` 实时发现/)
  assert.match(guide, /readyPlatforms[^。]*仅表示 Hub 在当前固定兼容契约下允许 dispatch/)
  assert.match(guide, /不证明 handler、endpoint、provider、credential/)
  assert.doesNotMatch(guide, /默认 provider 已启用且配置了凭据/)
  assert.doesNotMatch(guide, /存在可执行 handler 或 endpoint candidate/)
  assert.match(guide, /\/api\/v1\/data\/canonical\/items\/\{id\}\/context/)
  assert.match(guide, /storedWindow\.hasMoreStoredBefore\/After/)
  assert.match(guide, /upstreamCompleteness/)
})

test('admin-only listener does not expose public documentation', async () => {
  await withServer('admin', async (baseUrl) => {
    for (const path of ['/docs', '/docs/openapi.json']) {
      const response = await fetch(`${baseUrl}${path}`)
      const payload = await response.json()
      assert.equal(response.status, 404)
      assert.equal(payload.error.code, 'not_found')
    }
  })
})
