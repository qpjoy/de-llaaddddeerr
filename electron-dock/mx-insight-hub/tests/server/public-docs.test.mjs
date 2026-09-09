import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createApp } from '../../server/app.mjs'
import { PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'

const FORBIDDEN_PUBLIC_DOC_DETAILS = /x-mx-insight-admin-token|adminToken|launcherSession|availabilityMode|dsnEnv|password|\/internal\/|tikhub|rapidapi|justone/i
const FORBIDDEN_PROVIDER_NEUTRAL_CONTRACT_DETAILS = /tikhub|rapidapi|justone/i
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
const EXTERNAL_OPERATION_CONTROL_ERROR_CODES = [
  'external_platform_operation_disabled',
  'external_platform_operation_shadow',
  'external_platform_operation_paused',
  'external_platform_operation_canary',
  'external_platform_operation_blocked',
]
const NIGHT_ALL_COMPATIBILITY_EXAMPLES = {
  raw: { value: { platform: 'xiaohongshu', keyword: 'AI Agent', count: 20 } },
  crawl: { value: { platform: 'twitter', username: 'openai', count: 20 } },
  userInfo: { value: { platform: 'twitter', username: 'openai' } },
}
const NIGHT_ALL_COMPATIBILITY_ERROR_CODES = {
  400: [
    'invalid_request', 'invalid_query', 'invalid_cursor', 'invalid_page_size',
    'cursor_scope_mismatch', 'invalid_platform', 'page_size_exceeded',
    'work_budget_exceeded', 'unsupported_fields', 'business_id_mismatch',
    'idempotency_key_required', 'invalid_idempotency_key',
    'invalid_user_profile_url', 'cursor_page_mismatch',
    'platform_operation_unsupported', 'night_all_rejected',
  ],
  401: ['api_key_required', 'invalid_api_key'],
  403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
  404: ['not_found', 'user_not_found', 'night_all_rejected'],
  409: [
    'request_in_progress', 'idempotency_conflict', 'request_outcome_unknown',
    'external_platform_response_unusable', 'night_all_rejected',
  ],
  422: ['night_all_rejected'],
  429: [
    'quota_exceeded', 'external_platform_busy', 'external_platform_rate_limited',
    'external_platform_capacity_exceeded', 'external_platform_cost_budget_exhausted',
    'external_platform_subsidy_budget_exhausted', 'night_all_rejected',
  ],
  502: [
    'night_all_rejected', 'upstream_outcome_unknown',
    'external_platform_response_unusable', 'external_platform_outcome_unknown',
    'external_platform_rejected',
  ],
  503: [
    'platform_operation_unavailable',
    'compatibility_capabilities_unavailable',
    'compatibility_store_unavailable',
    'external_platform_unavailable',
    'external_platform_not_configured',
    'external_platform_contract_unverified',
    'external_platform_circuit_open',
    'external_platform_capacity_unavailable',
    'external_platform_cost_control_unavailable',
    'external_platform_cost_evidence_incomplete',
    ...EXTERNAL_OPERATION_CONTROL_ERROR_CODES,
  ],
}

const XIAOHONGSHU_SEARCH_ERROR_CODES = {
  400: [
    'invalid_request', 'invalid_platform', 'invalid_query', 'invalid_cursor',
    'invalid_page_size', 'cursor_scope_mismatch', 'page_size_exceeded',
    'unsupported_fields', 'unsupported_match_mode', 'invalid_result_type', 'idempotency_key_required',
    'invalid_idempotency_key', 'platform_operation_unsupported',
  ],
  401: ['api_key_required', 'invalid_api_key'],
  403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
  409: [
    'request_in_progress', 'idempotency_conflict', 'request_outcome_unknown',
    'external_platform_response_unusable',
  ],
  410: ['search_cursor_expired'],
  429: [
    'quota_exceeded', 'external_platform_busy', 'external_platform_rate_limited',
    'external_platform_capacity_exceeded', 'external_platform_cost_budget_exhausted',
    'external_platform_subsidy_budget_exhausted',
  ],
  502: [
    'night_all_rejected', 'upstream_outcome_unknown',
    'external_platform_response_unusable', 'external_platform_outcome_unknown',
    'external_platform_rejected',
  ],
  503: [
    'stored_search_unavailable', 'search_cursor_unavailable',
    'external_platform_unavailable', 'external_platform_not_configured',
    'external_platform_contract_unverified', 'external_platform_circuit_open',
    'external_platform_capacity_unavailable', 'external_platform_cost_control_unavailable',
    'external_platform_cost_evidence_incomplete',
    ...EXTERNAL_OPERATION_CONTROL_ERROR_CODES,
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
  assert.equal(schema.properties.page.oneOf[0].maximum, 15)
  assert.match('15', new RegExp(schema.properties.page.oneOf[1].pattern))
  assert.doesNotMatch('16', new RegExp(schema.properties.page.oneOf[1].pattern))
  assert.equal(schema.properties.cacheMaxAgeHours.minimum, 0)
  assert.equal(schema.properties.cacheMaxAgeHours.maximum, 720)
  assert.equal(schema.properties.maxEnrichItems.oneOf[0].maximum, 20)
  assert.equal(schema.properties.enrichConcurrency.oneOf[0].maximum, 5)
}

function resolveSchema(document, schema) {
  if (!schema?.$ref) return schema
  return document.components.schemas[schema.$ref.split('/').at(-1)]
}

function assertExternalCommerceContract(document) {
  const operation = document.paths['/data/ecommerce/products/search']?.post
  assert.ok(operation)
  assert.equal(operation.operationId, 'searchExternalCommerceProducts')
  assert.equal(operation['x-mx-required-platform'], 'ecommerce')
  assert.deepEqual(operation['x-mx-required-capabilities'], ['ecommerce.products.search'])
  assert.doesNotMatch(JSON.stringify(operation), /tikhub|rapidapi|justone/i)
  assert.deepEqual(operation['x-mx-error-codes'], {
    400: [
      'invalid_request', 'invalid_marketplace', 'unsupported_marketplace',
      'invalid_query', 'invalid_page', 'invalid_cursor', 'invalid_pagination',
      'cursor_scope_mismatch', 'continuation_required', 'unsupported_sort',
      'invalid_price', 'unsupported_price_filter', 'unsupported_request_field',
      'invalid_delivery_mode', 'idempotency_key_required', 'invalid_idempotency_key',
      'invalid_uncertain_retry',
    ],
    401: ['api_key_required', 'invalid_api_key'],
    403: ['platform_not_granted', 'capability_not_granted', 'test_key_not_supported'],
    404: ['stored_snapshot_not_found'],
    409: [
      'request_in_progress', 'idempotency_conflict', 'request_outcome_unknown',
      'external_platform_response_unusable', 'uncertain_retry_not_allowed',
    ],
    413: ['payload_too_large'],
    429: [
      'quota_exceeded', 'external_platform_busy', 'external_platform_rate_limited',
      'external_platform_capacity_exceeded',
      'external_platform_cost_budget_exhausted', 'external_platform_subsidy_budget_exhausted',
    ],
    502: [
      'external_platform_response_unusable', 'external_platform_outcome_unknown',
      'external_platform_rejected',
    ],
    503: [
      'external_platform_unavailable', 'external_platform_not_configured',
      'external_platform_circuit_open', 'external_platform_capacity_unavailable',
      'external_platform_cost_control_unavailable', 'external_platform_cost_evidence_incomplete',
      ...EXTERNAL_OPERATION_CONTROL_ERROR_CODES,
    ],
  })
  assert.deepEqual(
    Object.keys(operation.responses).map(Number).sort((left, right) => left - right),
    [200, 400, 401, 403, 404, 409, 413, 429, 502, 503],
  )

  assert.equal(operation.parameters.length, 2)
  const idempotency = operation.parameters[0]
  assert.equal(idempotency.name, 'Idempotency-Key')
  assert.equal(idempotency.in, 'header')
  assert.equal(idempotency.required, false)
  assert.match(idempotency.description, /next-page request changes the body and must use a new Idempotency-Key/i)
  assert.match(idempotency.description, /every HTTP call receives a unique internal key/i)
  assert.match(idempotency.description, /distinct metered Hub request/i)
  assert.equal(idempotency.schema.minLength, 8)
  assert.equal(idempotency.schema.maxLength, 128)
  const uncertainRepeat = operation.parameters[1]
  assert.equal(uncertainRepeat.name, 'X-MX-Insight-Retry-Of')
  assert.equal(uncertainRepeat.in, 'header')
  assert.equal(uncertainRepeat.required, false)
  assert.equal(uncertainRepeat.schema.format, 'uuid')
  assert.match(uncertainRepeat.description, /one intentionally new refresh/i)
  assert.match(uncertainRepeat.description, /never bypasses reserved state/i)

  const requestRef = operation.requestBody.content['application/json'].schema
  assert.equal(requestRef.$ref, '#/components/schemas/ExternalCommerceProductSearchRequest')
  const request = resolveSchema(document, requestRef)
  assert.equal(request.type, 'object')
  assert.equal(request.additionalProperties, false)
  assert.deepEqual(request.required, ['marketplace', 'query'])
  assert.deepEqual(request.not, { required: ['page', 'cursor'] })
  assert.deepEqual(Object.keys(request.properties), [
    'marketplace', 'query', 'deliveryMode', 'page', 'cursor', 'sort', 'price',
  ])
  assert.equal(request.properties.pageSize, undefined)
  assert.deepEqual(request.properties.marketplace.enum, [
    'taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu',
  ])
  assert.equal(request.properties.query.maxLength, 200)
  assert.deepEqual(request.properties.deliveryMode.enum, ['cache_only', 'cache_first', 'refresh'])
  assert.equal(request.properties.deliveryMode.default, 'cache_first')
  assert.equal(request.properties.page.default, 1)
  assert.equal(request.properties.page.maximum, 1000)
  assert.equal(request.properties.cursor.maxLength, 4096)
  assert.equal(request.properties.price.additionalProperties, false)
  assert.deepEqual(Object.keys(request.properties.price.properties), ['min', 'max'])
  for (const field of ['min', 'max']) {
    const amount = request.properties.price.properties[field]
    assert.equal(amount.type, 'string', field)
    assert.equal(amount.oneOf, undefined, field)
    const decimal = new RegExp(amount.pattern)
    assert.match('0', decimal, field)
    assert.match('999999999999.12345678', decimal, field)
    assert.doesNotMatch('01', decimal, field)
    assert.doesNotMatch('1e2', decimal, field)
  }

  const responseRef = operation.responses[200].content['application/json'].schema
  assert.equal(responseRef.$ref, '#/components/schemas/ExternalCommerceProductSearchEnvelope')
  assert.deepEqual(
    operation.responses[200].headers['x-mx-insight-source-mode'].schema.enum,
    ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
  )
  for (const header of [
    'x-mx-insight-request-id', 'idempotent-replay', 'x-mx-insight-source-mode',
    'x-mx-insight-captured-at', 'Age', 'Warning',
  ]) assert.ok(operation.responses[200].headers[header], header)

  const envelope = resolveSchema(document, responseRef)
  assert.equal(envelope.additionalProperties, false)
  assert.deepEqual(envelope.required, ['contractVersion', 'data', 'meta', 'requestId'])
  assert.equal(
    envelope.properties.contractVersion.const,
    'mx-insight-hub.ecommerce-products.v1',
  )
  assert.deepEqual(envelope.properties.data.required, ['items', 'page'])
  assert.equal(
    envelope.properties.data.properties.items.items.$ref,
    '#/components/schemas/ExternalCommerceProduct',
  )
  const meta = envelope.properties.meta
  assert.deepEqual(meta.required, ['capturedAt', 'servedAt', 'sourceMode', 'ageSeconds'])
  assert.deepEqual(meta.properties.sourceMode.enum, [
    'live', 'fresh_cache', 'stored_fallback', 'idempotent_replay',
  ])
  assert.equal(meta.properties.ageSeconds.minimum, 0)

  const product = document.components.schemas.ExternalCommerceProduct
  assert.equal(product.additionalProperties, false)
  assert.deepEqual(Object.keys(product.properties), [
    'id', 'marketplace', 'title', 'url', 'pricing', 'shop', 'images', 'signals', 'attributes',
  ])
  assert.deepEqual(product.properties.pricing.required, ['current', 'original', 'currency'])
  assert.deepEqual(product.properties.shop.required, ['id', 'name'])
  assert.equal(product.properties.images.maxItems, 20)

  const page = document.components.schemas.ExternalCommerceProductSearchPage
  assert.deepEqual(page.properties.hasMore.type, ['boolean', 'null'])
  assert.deepEqual(page.properties.nextCursor.type, ['string', 'null'])
  assert.equal(page.properties.nextCursor.maxLength, 4096)

  const media = document.paths['/data/ecommerce/products/media']?.get
  assert.ok(media)
  assert.equal(media.operationId, 'getExternalCommerceProductMedia')
  assert.doesNotMatch(JSON.stringify(media), /provider|tikhub|rapidapi|justone/i)
  assert.deepEqual(media.parameters.map(({ name }) => name), [
    'requestId', 'itemId', 'imageIndex',
  ])
  assert.equal(media.parameters.every(({ required }) => required), true)
  assert.equal(media.parameters[0].schema.format, 'uuid')
  assert.equal(media.parameters[1].schema.maxLength, 512)
  assert.equal(media.parameters[2].schema.minimum, 0)
  assert.equal(media.parameters[2].schema.maximum, 19)
  assert.deepEqual(
    Object.keys(media.responses).map(Number).sort((left, right) => left - right),
    [200, 400, 401, 403, 404, 413, 415, 422, 429, 502, 503, 504],
  )
  assert.deepEqual(
    Object.keys(media.responses[200].content).sort(),
    ['image/jpeg', 'image/png', 'image/webp'],
  )
  for (const response of Object.values(media.responses[200].content)) {
    assert.equal(response.schema.type, 'string')
    assert.equal(response.schema.format, 'binary')
  }
  assert.match(media.description, /creates no Hub usage record/i)
  assert.match(media.description, /never accepts an arbitrary URL/i)
  assert.deepEqual(media['x-mx-error-codes'][403], ['platform_not_granted', 'test_key_not_supported'])

  const capabilitiesContent = document.paths['/data/capabilities'].get.responses[200]
    .content['application/json']
  assert.match(
    document.paths['/data/capabilities'].get.description,
    /Xiaohongshu remains in the legacy matrix.*multi-query.*multi-identifier/is,
  )
  const capabilitiesEnvelope = resolveSchema(document, capabilitiesContent.schema)
  const platformProperties = capabilitiesEnvelope.properties.data.properties.platforms.items.properties
  assert.deepEqual(platformProperties.servingMode.enum, ['stored', 'live_with_stored_fallback'])
  assert.deepEqual(platformProperties.freshnessModes.items.enum, [
    'live', 'fresh_cache', 'stored_fallback', 'idempotent_replay',
  ])
  assert.deepEqual(platformProperties.deliveryModes.items.enum, [
    'cache_only', 'cache_first', 'refresh',
  ])
  const ecommerce = capabilitiesContent.example.data.platforms
    .find(({ platform }) => platform === 'ecommerce')
  assert.deepEqual(ecommerce, {
    platform: 'ecommerce',
    ready: true,
    capabilities: ['product_search'],
    source: 'hub',
    servingMode: 'live_with_stored_fallback',
    contractVersion: 'mx-insight-hub.ecommerce-products.v1',
    marketplaces: ['taobao', 'tmall', 'jd', 'xiaohongshu_ec', 'xianyu'],
    pagination: 'opaque_cursor',
    idempotencyKey: 'optional',
    deliveryModes: ['cache_only', 'cache_first', 'refresh'],
    freshnessModes: ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
  })
}

function assertExternalSocialPostContract(document) {
  const canonical = document.paths['/data/post']?.post
  const compatibilityGet = document.paths['/xiaohongshu/app/get_note_info']?.get
  const appV2 = Object.fromEntries([
    'get_image_note_detail', 'search_notes', 'search_users',
    'get_user_info', 'get_user_posted_notes',
  ].map((name) => [name, document.paths[`/xiaohongshu/app_v2/${name}`]?.get]))
  const appV2Get = appV2.get_image_note_detail
  const platformPost = document.paths['/xiaohongshu/app/get_note_info']?.post
  const media = document.paths['/data/posts/media']?.get
  assert.ok(canonical)
  assert.ok(compatibilityGet)
  assert.ok(appV2Get)
  assert.ok(platformPost)
  assert.ok(media)
  assert.equal(canonical.operationId, 'resolveExternalSocialPost')
  assert.equal(compatibilityGet.operationId, 'getXiaohongshuNoteInfoCompatibility')
  assert.equal(appV2Get.operationId, 'getXiaohongshuImageNoteDetailOfficial')
  assert.equal(appV2.search_notes.operationId, 'searchXiaohongshuNotesOfficial')
  assert.equal(appV2.search_users.operationId, 'searchXiaohongshuUsersOfficial')
  assert.equal(appV2.get_user_info.operationId, 'getXiaohongshuUserInfoOfficial')
  assert.equal(appV2.get_user_posted_notes.operationId, 'getXiaohongshuUserPostedNotesOfficial')
  assert.equal(platformPost.operationId, 'getXiaohongshuNoteInfo')
  assert.equal(compatibilityGet.deprecated, undefined)
  assert.equal(platformPost.deprecated, undefined)
  assert.equal(canonical['x-mx-canonical-operation'], '/data/post')
  assert.equal(compatibilityGet['x-mx-canonical-operation'], '/data/post')
  assert.equal(appV2Get['x-mx-canonical-operation'], undefined)
  assert.equal(platformPost['x-mx-canonical-operation'], '/data/post')
  assert.doesNotMatch(
    JSON.stringify({ canonical, compatibilityGet, platformPost, media }),
    FORBIDDEN_PROVIDER_NEUTRAL_CONTRACT_DETAILS,
  )
  assert.deepEqual(canonical['x-mx-error-codes'][403], [
    'platform_not_granted', 'capability_not_granted', 'test_key_not_supported',
  ])
  assert.deepEqual(canonical['x-mx-error-codes'][429], [
    'quota_exceeded', 'external_platform_busy', 'external_platform_rate_limited',
    'external_platform_capacity_exceeded',
    'external_platform_cost_budget_exhausted', 'external_platform_subsidy_budget_exhausted',
  ])
  assert.ok(canonical['x-mx-error-codes'][503].includes('external_platform_contract_unverified'))
  for (const code of EXTERNAL_OPERATION_CONTROL_ERROR_CODES) {
    assert.ok(canonical['x-mx-error-codes'][503].includes(code), code)
  }
  assert.deepEqual(compatibilityGet['x-mx-error-codes'], canonical['x-mx-error-codes'])
  assert.deepEqual(platformPost['x-mx-error-codes'], canonical['x-mx-error-codes'])
  assert.equal(
    canonical.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/XiaohongshuPostRequest',
  )
  assert.equal(
    platformPost.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/XiaohongshuPostCompatibilityRequest',
  )
  assert.equal(compatibilityGet.requestBody, undefined)
  assert.equal(appV2Get.requestBody, undefined)
  assert.deepEqual(compatibilityGet.parameters.map(({ name }) => name), [
    'note_id', 'share_text', 'delivery_mode', 'Idempotency-Key', 'X-MX-Insight-Retry-Of',
  ])
  assert.deepEqual(appV2Get.parameters.map(({ name }) => name), [
    'note_id', 'share_text', 'Idempotency-Key',
  ])
  assert.deepEqual(appV2.search_notes.parameters.map(({ name }) => name), [
    'keyword', 'page', 'sort_type', 'note_type', 'time_filter', 'search_id',
    'search_session_id', 'source', 'ai_mode', 'Idempotency-Key',
  ])
  assert.deepEqual(appV2.search_users.parameters.map(({ name }) => name), [
    'keyword', 'page', 'search_id', 'source', 'Idempotency-Key',
  ])
  assert.deepEqual(appV2.get_user_info.parameters.map(({ name }) => name), [
    'user_id', 'share_text', 'Idempotency-Key',
  ])
  assert.deepEqual(appV2.get_user_posted_notes.parameters.map(({ name }) => name), [
    'user_id', 'share_text', 'cursor', 'Idempotency-Key',
  ])
  assert.match(
    appV2Get.parameters[0].description,
    /Either note_id or share_text is required; note_id takes precedence when both are present/i,
  )
  for (const operation of [appV2.get_user_info, appV2.get_user_posted_notes]) {
    assert.match(
      operation.parameters[0].description,
      /Either user_id or share_text is required; user_id takes precedence when both are present/i,
    )
  }
  assert.equal(appV2.search_notes.parameters[1].schema.maximum, 15)
  assert.equal(appV2.search_users.parameters[1].schema.maximum, 15)
  const parameterSchema = (operation, name) => (
    operation.parameters.find((parameter) => parameter.name === name).schema
  )
  assert.deepEqual(parameterSchema(appV2.search_notes, 'sort_type'), {
    type: 'string',
    enum: ['general', 'time_descending', 'popularity_descending', 'comment_descending', 'collect_descending', 'english_preferred'],
    default: 'general',
  })
  assert.deepEqual(parameterSchema(appV2.search_notes, 'note_type'), {
    type: 'string', enum: ['不限', '视频笔记', '普通笔记', '直播笔记'], default: '不限',
  })
  assert.deepEqual(parameterSchema(appV2.search_notes, 'time_filter'), {
    type: 'string', enum: ['不限', '一天内', '一周内', '半年内'], default: '不限',
  })
  assert.equal(parameterSchema(appV2.search_notes, 'search_id').maxLength, 2048)
  assert.equal(parameterSchema(appV2.search_notes, 'search_session_id').maxLength, 2048)
  assert.equal(parameterSchema(appV2.search_notes, 'source').maxLength, 8192)
  assert.equal(parameterSchema(appV2.search_notes, 'source').default, 'explore_feed')
  assert.equal(parameterSchema(appV2.search_users, 'search_id').maxLength, 2048)
  assert.equal(parameterSchema(appV2.search_users, 'source').maxLength, 8192)
  assert.equal(parameterSchema(appV2.search_users, 'source').default, 'explore_feed')
  assert.match(appV2.get_user_posted_notes.parameters[2].description, /opaque Hub cursor|不透明 Hub cursor/i)
  const appV2RequiredCapabilities = {
    get_image_note_detail: ['compat.xiaohongshu.app_v2', 'social.posts.resolve'],
    search_notes: ['compat.xiaohongshu.app_v2', 'social.posts.search'],
    search_users: ['compat.xiaohongshu.app_v2', 'social.users.resolve'],
    get_user_info: ['compat.xiaohongshu.app_v2', 'social.users.resolve'],
    get_user_posted_notes: ['compat.xiaohongshu.app_v2', 'social.users.posts'],
  }
  for (const [name, operation] of Object.entries(appV2)) {
    assert.equal(operation['x-mx-required-platform'], 'xiaohongshu')
    assert.deepEqual(operation['x-mx-required-capabilities'], appV2RequiredCapabilities[name])
  }
  for (const operation of Object.values(appV2)) {
    assert.ok(operation)
    assert.equal(operation.parameters.at(-1).name, 'Idempotency-Key')
    assert.equal(operation.parameters.at(-1).required, false)
    assert.match(operation.parameters.at(-1).description, /every HTTP call receives a unique internal key/i)
    assert.match(operation.parameters.at(-1).description, /metered separately/i)
    assert.equal(operation.responses[200].content['application/json'].schema.type, 'object')
    assert.equal(operation.responses[200].content['application/json'].schema.additionalProperties, true)
    assert.match(operation.description, /15/)
    assert.match(operation.description, /business fields remain intact|Business fields.*intact/i)
    for (const code of ['invalid_sort_type', 'invalid_note_type', 'invalid_time_filter']) {
      assert.ok(operation['x-mx-error-codes'][400].includes(code))
    }
    assert.ok(!operation['x-mx-error-codes'][400].includes('invalid_upstream_pagination'))
    assert.ok(operation['x-mx-error-codes'][403].includes('capability_not_granted'))
    assert.ok(operation['x-mx-error-codes'][429].includes('external_platform_cost_budget_exhausted'))
    assert.ok(operation['x-mx-error-codes'][503].includes('external_platform_cost_control_unavailable'))
    for (const code of EXTERNAL_OPERATION_CONTROL_ERROR_CODES) {
      assert.ok(operation['x-mx-error-codes'][503].includes(code), code)
    }
  }
  assert.match(compatibilityGet.parameters[0].schema.pattern, /\{24\}/u)
  assert.deepEqual(compatibilityGet.parameters[2].schema.enum, ['cache_only', 'cache_first', 'refresh'])
  for (const operation of [canonical, platformPost]) {
    assert.deepEqual(operation.parameters.map(({ name }) => name), [
      'Idempotency-Key', 'X-MX-Insight-Retry-Of',
    ])
  }
  for (const operation of [canonical, compatibilityGet, platformPost]) {
    assert.equal(
      operation.responses[200].content['application/json'].schema.$ref,
      '#/components/schemas/ExternalSocialPostEnvelope',
    )
    assert.deepEqual(
      operation.responses[200].headers['x-mx-insight-source-mode'].schema.enum,
      ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay'],
    )
    assert.match(
      operation.parameters.find(({ name }) => name === 'Idempotency-Key').description,
      /every HTTP call receives a unique internal key/i,
    )
  }

  const request = document.components.schemas.XiaohongshuPostRequest
  const compatibilityRequest = document.components.schemas.XiaohongshuPostCompatibilityRequest
  const post = document.components.schemas.ExternalSocialPost
  const envelope = document.components.schemas.ExternalSocialPostEnvelope
  assert.equal(request.additionalProperties, false)
  assert.deepEqual(request.required, ['platform', 'url'])
  assert.deepEqual(Object.keys(request.properties), ['platform', 'url', 'deliveryMode'])
  assert.equal(request.properties.platform.const, 'xiaohongshu')
  assert.deepEqual(request.properties.deliveryMode.enum, ['cache_only', 'cache_first', 'refresh'])
  assert.equal(compatibilityRequest.additionalProperties, false)
  assert.deepEqual(compatibilityRequest.required, ['url'])
  assert.equal(post.additionalProperties, false)
  assert.deepEqual(Object.keys(post.properties), [
    'id', 'externalId', 'platform', 'contentType', 'url', 'title', 'text', 'tags',
    'author', 'metrics', 'media', 'publishedAt', 'collectedAt',
  ])
  assert.equal(post.properties.url.maxLength, undefined)
  assert.equal(post.properties.title.maxLength, undefined)
  assert.equal(post.properties.tags.maxItems, undefined)
  assert.equal(post.properties.tags.items.maxLength, undefined)
  assert.equal(post.properties.author.properties.id.maxLength, undefined)
  assert.equal(post.properties.author.properties.name.maxLength, undefined)
  assert.equal(post.properties.author.properties.avatarUrl.maxLength, undefined)
  assert.equal(post.properties.media.maxItems, undefined)
  assert.equal(
    post.properties.media.items.$ref,
    '#/components/schemas/ExternalSocialPostMedia',
  )
  const socialMedia = document.components.schemas.ExternalSocialPostMedia
  assert.deepEqual(socialMedia.required, ['type', 'url'])
  assert.equal(socialMedia.properties.url.format, 'uri')
  assert.equal(socialMedia.properties.url.maxLength, undefined)
  assert.match(socialMedia.properties.url.description, /preserved without Hub filtering/i)
  assert.equal(socialMedia.properties.hubRelayUrl.format, 'uri-reference')
  assert.match(socialMedia.properties.hubRelayUrl.pattern, /\/api\/v1\/data\/posts\/media/)
  assert.match(socialMedia.properties.hubRelayUrl.description, /indexes 0\.\.19/i)
  assert.match(post.properties.author.properties.avatarUrl.description, /preserved as business data/i)
  assert.match(canonical.description, /Business content is not desensitized or filtered/i)
  assert.equal(envelope.properties.contractVersion.const, 'mx-insight-hub.social-post.v1')
  assert.deepEqual(envelope.properties.data.required, ['item'])
  assert.equal(
    envelope.properties.data.properties.item.$ref,
    '#/components/schemas/ExternalSocialPost',
  )

  assert.equal(media.operationId, 'getExternalSocialPostMedia')
  assert.deepEqual(media.parameters.map(({ name }) => name), ['requestId', 'mediaIndex'])
  assert.equal(media.parameters.every(({ required }) => required), true)
  assert.equal(media.parameters[0].schema.format, 'uuid')
  assert.equal(media.parameters[1].schema.minimum, 0)
  assert.equal(media.parameters[1].schema.maximum, 19)
  assert.deepEqual(Object.keys(media.responses[200].content).sort(), [
    'image/jpeg', 'image/png', 'image/webp',
  ])
  assert.deepEqual(media['x-mx-error-codes'][429], [
    'external_media_rate_limited', 'external_media_busy',
  ])
  assert.deepEqual(media['x-mx-error-codes'][502], [
    'external_media_unavailable', 'external_media_redirect_rejected',
    'external_media_source_throttled',
  ])
  assert.match(media.description, /Multiple (?:image )?reads (?:may|can) run concurrently/i)
  assert.match(media.description, /creates no Hub usage/i)

  const capabilitiesContent = document.paths['/data/capabilities'].get.responses[200]
    .content['application/json']
  const xiaohongshu = capabilitiesContent.example.data.platforms
    .find(({ platform }) => platform === 'xiaohongshu')
  assert.deepEqual(xiaohongshu.capabilities, ['search_posts', 'post_detail'])
  assert.deepEqual(xiaohongshu.search, {
    ready: true,
    source: 'hub',
    servingMode: 'live_with_stored_fallback',
    contractVersion: 'night-all.data-search.v1',
  })
  assert.equal(xiaohongshu.postDetail.contractVersion, 'mx-insight-hub.social-post.v1')
  assert.equal(xiaohongshu.postDetail.servingMode, 'live_with_stored_fallback')
  assert.deepEqual(xiaohongshu.postDetail.deliveryModes, [
    'cache_only', 'cache_first', 'refresh',
  ])
  assert.deepEqual(
    capabilitiesContent.example.data.capabilities.find(
      ({ capability }) => capability === 'social.posts.resolve',
    ),
    { capability: 'social.posts.resolve', ready: true },
  )
}

function assertXiaohongshuSearchContract(document) {
  const operation = document.paths['/data/search']?.post
  assert.ok(operation)
  assert.deepEqual(operation['x-mx-error-codes'], XIAOHONGSHU_SEARCH_ERROR_CODES)
  assert.deepEqual(operation['x-mx-required-capabilities-by-platform'], {
    xiaohongshu: 'social.posts.search',
  })
  assert.match(operation.description, /xiaohongshu/i)
  assert.match(operation.description, /exactly 20|page size is exactly 20/i)
  assert.match(operation.description, /historical cursor/i)
  assert.match(operation.description, /bounded detail/i)
  assert.match(operation.description, /independent rollout gate/i)
  assert.match(operation.description, /never selects|never.*provider/i)

  const request = resolveSchema(
    document,
    operation.requestBody.content['application/json'].schema,
  )
  assert.equal(request.additionalProperties, false)
  assert.deepEqual(request.required, ['platform', 'query'])
  assert.equal(request.properties.pageSize.default, 20)
  assert.match(request.properties.pageSize.description, /exactly 20/i)
  assert.deepEqual(request.properties.type.enum, ['fresh', 'stable'])
  assert.equal(request.properties.type.default, 'fresh')
  assert.match(request.properties.cursor.description, /same path, platform, query and pageSize/i)

  const headers = operation.responses[200].headers
  for (const header of [
    'x-mx-insight-request-id', 'idempotent-replay', 'x-mx-insight-source-mode',
    'x-mx-insight-captured-at', 'Age', 'Warning',
  ]) assert.ok(headers[header], header)
  assert.deepEqual(headers['x-mx-insight-source-mode'].schema.enum, [
    'live', 'stale', 'fresh_cache', 'stored_fallback', 'idempotent_replay',
  ])

  const capabilitiesContent = document.paths['/data/capabilities'].get.responses[200]
    .content['application/json']
  const capabilitiesEnvelope = resolveSchema(document, capabilitiesContent.schema)
  const platformProperties = capabilitiesEnvelope.properties.data.properties.platforms.items.properties
  assert.deepEqual(platformProperties.search.required, [
    'ready', 'source', 'servingMode', 'contractVersion',
  ])
  assert.equal(platformProperties.search.properties.source.const, 'hub')
  assert.match(platformProperties.search.description, /independent first-page rollout gate/i)
  assert.equal(
    platformProperties.search.properties.contractVersion.const,
    'night-all.data-search.v1',
  )
  assert.match(platformProperties.search.description, /post_detail.*independently/i)
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

function assertCanonicalTimelineContract(document) {
  const route = document.paths['/data/canonical/items/{id}/timeline']?.get
  assert.ok(route)
  assert.equal(route.operationId, 'getCanonicalMessageTimeline')
  assert.deepEqual(route['x-mx-allowed-query-fields'], ['before', 'after', 'cursor'])
  assert.deepEqual(route['x-mx-error-codes']['400'], [
    'invalid_request', 'invalid_cursor', 'page_size_exceeded', 'unsupported_fields',
  ])
  assert.deepEqual(route['x-mx-error-codes']['409'], ['context_not_supported'])
  assert.deepEqual(route['x-mx-error-codes']['503'], [
    'stored_data_unavailable', 'serving_indexes_unavailable',
  ])
  assert.deepEqual(
    Object.keys(route.responses).map(Number).sort((left, right) => left - right),
    [200, 400, 401, 403, 404, 409, 429, 503],
  )
  assert.deepEqual(route.parameters.map(({ name }) => name), ['id', 'before', 'after', 'cursor'])
  for (const field of ['before', 'after']) {
    const parameter = route.parameters.find(({ name }) => name === field)
    assert.equal(parameter.schema.default, 10)
    assert.equal(parameter.schema.minimum, 0)
    assert.equal(parameter.schema.maximum, 50)
  }
  assert.equal(route.parameters.find(({ name }) => name === 'cursor').schema.maxLength, 2048)
  assert.equal(
    route.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/CanonicalTimelineEnvelope',
  )

  const data = document.components.schemas.CanonicalTimelineEnvelope.properties.data
  assert.equal(data.additionalProperties, false)
  assert.equal(data.properties.contractVersion.const, 'mx-insight-hub.canonical-timeline.v1')
  assert.equal(data.properties.consistency.const, 'live-keyset')
  assert.deepEqual(data.properties.anchorIndex.type, ['integer', 'null'])
  assert.equal(data.properties.items.minItems, 0)
  assert.equal(data.properties.items.maxItems, 101)
  assert.equal(data.properties.pageInfo.$ref, '#/components/schemas/CanonicalTimelinePageInfo')
  assert.deepEqual(data.properties.ordering.properties.fields.const, ['eventTime', 'canonicalId'])
  assert.ok(data.required.includes('upstreamCompleteness'))

  const pageInfo = document.components.schemas.CanonicalTimelinePageInfo
  assert.deepEqual(pageInfo.required, ['mode', 'direction', 'returnedCount', 'older', 'newer'])
  assert.deepEqual(pageInfo.properties.mode.enum, ['initial', 'continuation'])
  assert.deepEqual(pageInfo.properties.direction.enum, [null, 'older', 'newer'])
  const direction = document.components.schemas.CanonicalTimelineDirectionPage
  assert.deepEqual(direction.required, ['hasMore', 'cursor'])
  assert.deepEqual(direction.properties.cursor.type, ['string', 'null'])
  assert.match(direction.description, /newer cursor is retained/u)

  const capability = document.components.schemas.CanonicalTimelineCapability
  assert.equal(capability.properties.contractVersion.const, 'mx-insight-hub.canonical-timeline.v1')
  assert.equal(capability.properties.consistency.const, 'live-keyset')
  assert.deepEqual(capability.properties.cursor.properties.directions.const, ['older', 'newer'])
  assert.equal(capability.properties.cursor.properties.newerPolling.const, true)
  const capabilitiesEnvelope = resolveSchema(
    document,
    document.paths['/data/capabilities'].get.responses[200].content['application/json'].schema,
  )
  assert.equal(
    capabilitiesEnvelope.properties.data.properties.platforms.items.properties.timeline.$ref,
    '#/components/schemas/CanonicalTimelineCapability',
  )
}

function resolveParameter(document, parameter) {
  if (!parameter?.$ref) return parameter
  return document.components.parameters[parameter.$ref.split('/').at(-1)]
}

function assertDataProductPublicContract(document, telegramOperationIds = {
  chats: 'listTelegramChats',
  messages: 'listTelegramMessages',
  search: 'searchTelegram',
}) {
  for (const path of [
    '/data/source-catalog',
    '/data/source-catalog/{id}',
    '/data/source-catalog/metadata',
    '/data/public-opinion/funnel',
    '/data/public-opinion/records',
    '/data/public-opinion/records/{id}',
  ]) assert.ok(document.paths[path]?.get, path)

  const catalog = document.paths['/data/source-catalog'].get
  assert.equal(catalog.operationId, 'listSourceCatalogEntries')
  assert.deepEqual(catalog.parameters.map(({ name }) => name).sort(), [
    'query', 'sourceKind', 'majorCategory', 'scenario', 'region', 'ownerId', 'tag',
    'coverageStatus', 'deliveryStatus', 'reviewStatus', 'runtimeStatus', 'priority',
    'pageSize', 'cursor',
  ].sort())
  assert.equal(catalog.parameters.find(({ name }) => name === 'pageSize').schema.default, 50)
  assert.deepEqual(catalog['x-mx-allowed-query-fields'], [
    'query', 'sourceKind', 'majorCategory', 'scenario', 'region', 'coverageStatus',
    'deliveryStatus', 'reviewStatus', 'runtimeStatus', 'priority', 'ownerId', 'tag',
    'pageSize', 'cursor',
  ])
  assert.equal(
    catalog.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/SourceCatalogPageEnvelope',
  )
  const catalogEntry = document.components.schemas.SourceCatalogEntry
  assert.ok(catalogEntry.required.includes('redactedFields'))
  assert.equal(catalogEntry.properties.redactedFields.items.type, 'string')
  assert.equal(
    document.components.schemas.SourceCatalogPageEnvelope.properties.data
      .properties.contractVersion.const,
    'source-catalog.public.v1',
  )
  assert.ok(document.components.schemas.SourceCatalogPageInfo.required.includes('totalCount'))

  const catalogMetadata = document.paths['/data/source-catalog/metadata'].get
  assert.deepEqual(catalogMetadata['x-mx-allowed-query-fields'], [])
  assert.deepEqual(catalogMetadata['x-mx-error-codes'][400], ['unsupported_fields'])
  assert.ok(catalogMetadata.responses[400])

  const catalogDetail = document.paths['/data/source-catalog/{id}'].get
  assert.equal(catalogDetail.operationId, 'getSourceCatalogEntry')
  assert.deepEqual(catalogDetail.parameters.map(({ name }) => name), ['id'])
  assert.equal(catalogDetail.parameters[0].required, true)
  assert.equal(catalogDetail.parameters[0].schema.format, 'uuid')
  assert.deepEqual(catalogDetail['x-mx-allowed-query-fields'], [])
  assert.deepEqual(catalogDetail['x-mx-error-codes'][400], [
    'invalid_source_catalog_id', 'unsupported_fields',
  ])
  assert.deepEqual(catalogDetail['x-mx-error-codes'][404], ['source_catalog_entry_not_found'])
  assert.equal(
    catalogDetail.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/SourceCatalogDetailEnvelope',
  )
  assert.equal(
    document.components.schemas.SourceCatalogDetailEnvelope.properties.data
      .properties.contractVersion.const,
    'source-catalog.public.v1',
  )
  assert.equal(
    document.components.schemas.SourceCatalogDetailEnvelope.properties.data
      .properties.item.$ref,
    '#/components/schemas/SourceCatalogEntry',
  )

  const catalogSummary = document.components.schemas.SourceCatalogSummary
  const catalogFacets = document.components.schemas.SourceCatalogFacets
  assert.equal(catalogSummary.additionalProperties, false)
  assert.equal(catalogFacets.additionalProperties, false)
  assert.deepEqual(catalogSummary.required.sort(), [
    'blocked', 'categories', 'complete', 'coverage', 'coverageRate', 'covered',
    'delivery', 'exploring', 'inProgress', 'partial', 'priorities', 'review',
    'total', 'unassigned', 'uncovered', 'unknownCoverage',
  ].sort())
  assert.deepEqual(catalogFacets.required.sort(), [
    'connectorHints', 'majorCategories', 'owners', 'regions', 'scenarios', 'tags',
  ].sort())
  assert.equal(
    document.components.schemas.SourceCatalogMetadataEnvelope.properties.data
      .properties.summary.$ref,
    '#/components/schemas/SourceCatalogSummary',
  )
  assert.equal(
    document.components.schemas.SourceCatalogMetadataEnvelope.properties.data
      .properties.facets.$ref,
    '#/components/schemas/SourceCatalogFacets',
  )

  const sourceCatalogCapability = document.paths['/data/capabilities']
    .get.responses[200].content['application/json'].example.data.platforms
    .find(({ platform }) => platform === 'source_catalog')
  assert.deepEqual(sourceCatalogCapability.capabilities, [
    'catalog_entries', 'catalog_metadata', 'catalog_detail', 'filtered_browse',
  ])

  const diagnostics = document.paths['/data/public-opinion/records'].get
  assert.equal(diagnostics.operationId, 'listPublicOpinionDiagnosticRecords')
  assert.equal(diagnostics.parameters.find(({ name }) => name === 'pageSize').schema.default, 50)
  assert.equal(diagnostics.parameters.find(({ name }) => name === 'cursor').schema.maxLength, 2048)
  const diagnosticDetailEnvelope = document.components.schemas.PublicOpinionDiagnosticsRecordEnvelope
  assert.equal(
    diagnosticDetailEnvelope.properties.data.$ref,
    '#/components/schemas/PublicOpinionDiagnosticRecordDetail',
  )
  const diagnosticRecord = document.components.schemas.PublicOpinionDiagnosticRecord
  const diagnosticDetail = document.components.schemas.PublicOpinionDiagnosticRecordDetail
  assert.equal(diagnosticRecord.unevaluatedProperties, false)
  assert.equal(diagnosticDetail.unevaluatedProperties, false)
  assert.equal(
    diagnosticDetail.allOf[0].$ref,
    '#/components/schemas/PublicOpinionDiagnosticRecordFields',
  )
  assert.deepEqual(diagnosticDetail.allOf[1].required, ['contractVersion', 'sourceScope', 'window'])
  const capabilitiesEnvelope = resolveSchema(
    document,
    document.paths['/data/capabilities'].get.responses[200]
      .content['application/json'].schema,
  )
  assert.deepEqual(
    capabilitiesEnvelope.properties.data.properties.capabilities
      .items.properties.capability.enum,
    [
      'compat.xiaohongshu.app_v2', 'ecommerce.products.search', 'nlp.tokenize',
      'public_opinion.all_ingested.read', 'public_opinion.diagnostics.read',
      'social.posts.resolve', 'social.posts.search', 'social.users.resolve',
      'social.users.posts',
    ],
  )

  const chats = document.paths['/data/telegram/chats'].get
  const messages = document.paths['/data/telegram/messages'].get
  assert.equal(chats.operationId, telegramOperationIds.chats)
  assert.equal(messages.operationId, telegramOperationIds.messages)
  const chatParameters = chats.parameters.map((parameter) => resolveParameter(document, parameter))
  const messageParameters = messages.parameters.map((parameter) => resolveParameter(document, parameter))
  assert.deepEqual(chatParameters.map(({ name }) => name), [
    'sourceScope', 'kind', 'query', 'chatId', 'from', 'to', 'pageSize', 'cursor',
  ])
  assert.deepEqual(messageParameters.map(({ name }) => name), ['sourceScope', 'chatId', 'from', 'to', 'pageSize', 'cursor'])
  assert.equal(chatParameters.find(({ name }) => name === 'sourceScope').schema.default, 'monitor')
  assert.deepEqual(chatParameters.find(({ name }) => name === 'kind').schema.enum, ['all', 'channel', 'group', 'unknown'])
  assert.equal(messageParameters.find(({ name }) => name === 'cursor').schema.maxLength, 2048)
  assert.ok(messages['x-mx-error-codes'][400].includes('source_scope_mismatch'))
  assert.deepEqual(messages['x-mx-error-codes'][404], ['chat_not_found'])
  assert.ok(messages.responses[404])
  assert.equal(document.paths['/data/telegram/search'].post.operationId, telegramOperationIds.search)
  assert.equal(document.components.schemas.TelegramSearchRequest.properties.sourceScope.default, 'monitor')
  for (const field of ['canonicalId', 'sourceScope', 'chatKey', 'kind']) {
    assert.ok(document.components.schemas.TelegramRecord.properties[field], field)
  }
  assert.ok(document.components.schemas.TelegramRecord.required.includes('canonicalId'))
  for (const field of ['contractVersion', 'sourceScope', 'filters', 'items', 'pageInfo']) {
    assert.ok(document.components.schemas.TelegramPageEnvelope.properties.data.required.includes(field), field)
  }
}

function assertNightAllPublicContract(document) {
  const compatibility = document.paths['/night-all/search/{operation}'].post
  const historicalAlias = document.paths['/search/{operation}'].post
  const compatibilityContent = compatibility.requestBody.content['application/json']
  assert.equal(compatibilityContent.schema.$ref, '#/components/schemas/NightAllLegacyRequest')
  assert.deepEqual(compatibilityContent.examples, NIGHT_ALL_COMPATIBILITY_EXAMPLES)
  assert.deepEqual(compatibility['x-mx-error-codes'], NIGHT_ALL_COMPATIBILITY_ERROR_CODES)
  assert.deepEqual(compatibility['x-mx-required-capabilities-by-platform-operation'], {
    xiaohongshu: {
      raw: 'social.posts.search',
      crawl: 'social.users.posts',
      'user-info': 'social.users.resolve',
    },
  })
  assert.equal(historicalAlias['x-mx-canonical-operation'], '/night-all/search/{operation}')
  assert.deepEqual(historicalAlias['x-mx-error-codes'], compatibility['x-mx-error-codes'])
  assert.deepEqual(historicalAlias.parameters, compatibility.parameters)
  assert.deepEqual(historicalAlias.requestBody, compatibility.requestBody)
  assert.deepEqual(historicalAlias.responses, compatibility.responses)
  assert.deepEqual(
    Object.keys(compatibility.responses).map(Number).sort((left, right) => left - right),
    [200, 400, 401, 403, 404, 409, 422, 429, 502, 503],
  )
  assert.equal(compatibility.responses[410], undefined)
  assert.match(historicalAlias.description, /same Hub service and paid-operation fingerprint/i)
  assert.ok(compatibility.responses[422])
  assert.ok(compatibility.responses[503])
  assert.match(compatibility.description, /data\.legacySearch/)
  assert.match(compatibility.description, /telegram/i)
  assert.match(compatibility.description, /Hub-pinned/i)
  assert.match(compatibility.description, /grant-filtered/i)
  assert.match(compatibility.description, /not fetched from Night-All at request time/i)
  assert.match(compatibility.description, /does not prove current Night-All handler, endpoint, provider, credential, or upstream health/i)
  assert.match(compatibility.description, /exactly one scalar keyword or query/i)
  assert.match(compatibility.description, /effective page size 20/i)
  assert.match(compatibility.description, /independent rollout gate/i)
  assert.match(compatibility.description, /includeDetails=false\/includeComments=false/i)
  assert.match(compatibility.description, /durable Hub.*body requestId.*x-mx-insight-request-id/is)
  assert.match(compatibility.responses[200].description, /not masked|retain|remain unchanged/i)
  assert.deepEqual(
    compatibility.responses[200].headers['x-mx-insight-source-mode'].schema.enum,
    ['live', 'stale'],
  )
  assert.match(
    document.components.schemas.NightAllLegacyEnvelope
      .properties.data.properties.raw_data.description,
    /Hub-native Xiaohongshu raw.*same type/i,
  )

  assertNightAllCompatibilityRequestSchema(document.components.schemas.NightAllLegacyRequest)
  const availability = document.components.schemas.NightAllLegacyOperationAvailability
  assert.deepEqual(availability.required, ['supportedPlatforms', 'readyPlatforms'])
  assert.equal(availability.additionalProperties, false)
  assert.equal(availability.properties.supportedPlatforms.uniqueItems, true)
  assert.equal(availability.properties.readyPlatforms.uniqueItems, true)
  assert.match(availability.description, /subset of supportedPlatforms/)
  assert.match(availability.description, /Hub-pinned/i)
  assert.match(availability.description, /deployed Hub contract permits historical dispatch/i)
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
  assert.match(discoveryProperty.description, /does not remove non-direct shapes from legacy dispatch/i)
  assert.match(discoveryProperty.description, /Null fails closed/i)

  const platformProperties = dataSchema.properties.platforms.items.properties
  assert.deepEqual(platformProperties.source.enum, ['hub'])
  assert.deepEqual(platformProperties.servingMode.enum, ['stored', 'live_with_stored_fallback'])

  const capabilitiesExample = capabilitiesContent.example
  const telegram = capabilitiesExample.data.platforms.find(({ platform }) => platform === 'telegram')
  assert.equal(telegram.source, 'hub')
  assert.equal(telegram.servingMode, 'stored')
  const xiaohongshu = capabilitiesExample.data.platforms
    .find((candidate) => candidate.platform === 'xiaohongshu')
  assert.deepEqual(xiaohongshu.capabilities, ['search_posts', 'post_detail'])
  assert.equal(xiaohongshu.source, undefined)
  assert.equal(xiaohongshu.servingMode, undefined)
  assert.equal(xiaohongshu.search.ready, true)
  assert.equal(xiaohongshu.search.source, 'hub')
  assert.equal(xiaohongshu.search.servingMode, 'live_with_stored_fallback')
  assert.equal(xiaohongshu.search.contractVersion, 'night-all.data-search.v1')
  const twitter = capabilitiesExample.data.platforms
    .find((candidate) => candidate.platform === 'twitter')
  assert.equal(twitter.capabilities, undefined)
  assert.equal(
    capabilitiesExample.data.legacySearch.contractVersion,
    NIGHT_ALL_LEGACY_SEARCH_CONTRACT_VERSION,
  )
  for (const operation of ['raw', 'crawl', 'user-info']) {
    const operationExample = capabilitiesExample.data.legacySearch.operations[operation]
    assert.deepEqual(operationExample.supportedPlatforms, ['twitter', 'xiaohongshu'])
    assert.deepEqual(operationExample.readyPlatforms, ['twitter', 'xiaohongshu'])
    assert.equal(operationExample.supportedPlatforms.includes('telegram'), false)
    assert.equal(operationExample.readyPlatforms.includes('telegram'), false)
    assert.equal(operationExample.supportedPlatforms.includes('xiaohongshu'), true)
    assert.equal(operationExample.readyPlatforms.includes('xiaohongshu'), true)
  }
}

function assertPublicOpinionContract(document) {
  const capabilitiesExample = document.paths['/data/capabilities']
    ?.get.responses[200].content['application/json'].example
  const publicOpinionCapability = capabilitiesExample?.data.platforms
    ?.find((entry) => entry.platform === 'public_opinion')
  const feed = document.paths['/data/public-opinion/provinces/{province}/items']?.get
  const regions = document.paths['/data/public-opinion/regions']?.get
  const regionFeed = document.paths['/data/public-opinion/regions/{regionCode}/items']?.get
  const coverage = document.paths['/data/public-opinion/province-coverage']?.get
  const detail = document.paths['/data/public-opinion/items/{id}']?.get
  assert.ok(feed)
  assert.ok(regions)
  assert.ok(regionFeed)
  assert.ok(coverage)
  assert.ok(detail)
  assert.deepEqual(publicOpinionCapability?.capabilities, [
    'province_feed', 'province_coverage', 'region_catalog', 'region_feed',
    'item_detail', 'stored_search', 'diagnostics',
  ])
  assert.deepEqual(regions.parameters.map((parameter) => parameter.name), [
    'parentCode', 'level',
  ])
  assert.deepEqual(regionFeed.parameters.map((parameter) => parameter.name), [
    'regionCode', 'visibility', 'sort', 'from', 'to', 'pageSize', 'cursor',
  ])
  assert.equal(regions.parameters[0].schema.const, 'CN')
  assert.equal(regions.parameters[1].schema.const, 'province')
  assert.equal(regionFeed.parameters[1].required, true)
  assert.equal(regionFeed.parameters[1].schema.const, 'all_ingested')
  assert.equal(regionFeed.parameters[2].schema.const, 'latest')
  assert.equal(regionFeed.parameters[3].required, true)
  assert.equal(regionFeed.parameters[4].required, true)
  assert.equal(regionFeed.parameters[5].schema.maximum, 100)
  assert.equal(regionFeed.parameters[6].schema.maxLength, 8192)
  assert.deepEqual(feed.parameters.map((parameter) => parameter.name), [
    'province', 'sort', 'from', 'to', 'includeCandidates', 'minQualityScore', 'pageSize', 'cursor',
  ])
  assert.deepEqual(detail.parameters.map((parameter) => parameter.name), [
    'id', 'includeCandidates', 'minQualityScore',
  ])
  assert.deepEqual(coverage.parameters.map((parameter) => parameter.name), [
    'from', 'to', 'includeCandidates', 'minQualityScore', 'targetPerProvince',
  ])
  assert.equal(coverage.parameters[0].required, true)
  assert.equal(coverage.parameters[1].required, true)
  assert.deepEqual(feed.parameters[4].schema.enum, ['false', 'true', 'qualified', 'all'])
  assert.equal(feed.parameters[5].schema.minimum, 0)
  assert.equal(feed.parameters[5].schema.maximum, 100)
  assert.equal(
    feed.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/PublicOpinionPageEnvelope',
  )
  assert.equal(
    detail.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/PublicOpinionItemEnvelope',
  )
  assert.equal(
    coverage.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/PublicOpinionCoverageEnvelope',
  )
  assert.equal(
    regions.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/PublicOpinionRegionsEnvelope',
  )
  assert.equal(
    regionFeed.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/PublicOpinionRegionFeedEnvelope',
  )
  assert.ok(feed['x-mx-error-codes'][400].includes('invalid_province'))
  assert.ok(feed['x-mx-error-codes'][403].includes('platform_not_granted'))
  assert.ok(feed['x-mx-error-codes'][503].includes('serving_indexes_unavailable'))
  assert.match(feed.description, /effective sort time/i)
  assert.match(feed.description, /candidate rows.*collectedAt/i)
  assert.match(feed.description, /includeCandidates=false/i)
  assert.match(feed.description, /includeCandidates=all.*requires both from and to/i)
  assert.ok(detail['x-mx-error-codes'][404].includes('item_not_found'))
  assert.match(detail.description, /does not require a time window/i)
  assert.match(coverage.description, /full stable province taxonomy/i)
  assert.ok(regionFeed['x-mx-error-codes'][403].includes('platform_not_granted'))
  assert.ok(regionFeed['x-mx-error-codes'][403].includes('capability_not_granted'))
  assert.match(regionFeed.description, /public_opinion\.all_ingested\.read/)
  assert.match(regionFeed.description, /canonical_current_safe/)
  assert.match(regionFeed.description, /includes formal and candidate items regardless of score, status or geography verification/i)
  assert.match(regionFeed.description, /Every returned item includes its safe quality summary/i)
  assert.match(regions.description, /all 34 stable province-level regions/i)
  assert.match(regions.description, /City taxonomy and city selectors are not exposed/i)

  const capabilities = resolveSchema(
    document,
    document.paths['/data/capabilities'].get.responses[200]
      .content['application/json'].schema,
  ).properties.data.properties.capabilities.items.properties.capability
  assert.deepEqual(capabilities.enum, [
    'compat.xiaohongshu.app_v2', 'ecommerce.products.search', 'nlp.tokenize',
    'public_opinion.all_ingested.read', 'public_opinion.diagnostics.read',
    'social.posts.resolve', 'social.posts.search', 'social.users.resolve',
    'social.users.posts',
  ])
  assert.deepEqual(
    capabilitiesExample.data.capabilities.find(
      (entry) => entry.capability === 'public_opinion.all_ingested.read',
    ),
    { capability: 'public_opinion.all_ingested.read', ready: true },
  )

  const item = document.components.schemas.PublicOpinionItem
  assert.equal(item.additionalProperties, false)
  assert.deepEqual(item.required, [
    'id', 'title', 'summary', 'url', 'publishedAt', 'collectedAt',
    'province', 'heatScore', 'origin',
  ])
  assert.deepEqual(Object.keys(item.properties), [...item.required, 'quality', 'location'])
  assert.equal(document.components.schemas.PublicOpinionOrigin.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionQuality.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionLocation.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionPageEnvelope.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionCoverageEnvelope.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionCoverageProvince.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionCoverageTotals.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionRegionsEnvelope.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionRegionFeedEnvelope.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionRegionFeedItem.additionalProperties, false)
  assert.equal(document.components.schemas.PublicOpinionRegionVisibility.additionalProperties, false)
  assert.equal(
    document.components.schemas.PublicOpinionRegionsEnvelope
      .properties.data.properties.contractVersion.const,
    'mx-insight-hub.public-opinion.regions.v1',
  )
  assert.equal(
    document.components.schemas.PublicOpinionRegionsEnvelope
      .properties.data.properties.regions.minItems,
    34,
  )
  const regionFeedData = document.components.schemas.PublicOpinionRegionFeedEnvelope.properties.data
  assert.equal(regionFeedData.properties.contractVersion.const, 'mx-insight-hub.public-opinion.region-feed.v1')
  assert.equal(regionFeedData.properties.sort.const, 'latest')
  assert.equal(regionFeedData.properties.timeBasis.const, 'effective')
  const visibility = document.components.schemas.PublicOpinionRegionVisibility
  assert.equal(visibility.properties.mode.const, 'all_ingested')
  assert.equal(visibility.properties.qualityFiltered.const, false)
  assert.equal(visibility.properties.corpusDefinition.const, 'canonical_current_safe')
  assert.ok(document.components.schemas.PublicOpinionRegionFeedItem.required.includes('quality'))
  assert.deepEqual(
    document.components.schemas.PublicOpinionCoverageEnvelope
      .properties.data.properties.includeCandidates.oneOf[0],
    { type: 'boolean', const: false },
  )
  assert.doesNotMatch(
    JSON.stringify({
      item: Object.keys(item.properties),
      origin: Object.keys(document.components.schemas.PublicOpinionOrigin.properties),
      quality: Object.keys(document.components.schemas.PublicOpinionQuality.properties),
      location: Object.keys(document.components.schemas.PublicOpinionLocation.properties),
      coverage: Object.keys(document.components.schemas.PublicOpinionCoverageProvince.properties),
      regionFeedItem: Object.keys(document.components.schemas.PublicOpinionRegionFeedItem.properties),
    }),
    /raw_payload|strategy_id|run_id|llm_reason|extensions|source_item_id|lineage|business_?id|credential|endpoint_?id|provider_?id|availability/i,
  )
}

function assertPublicOpinionSearchContract(document) {
  const capabilitiesOperation = document.paths['/data/capabilities'].get
  assert.match(
    capabilitiesOperation.description,
    /data_center_saved_records_<source_type>.*source=hub.*servingMode=stored.*stored_search.*canonical_search/is,
  )
  assert.match(
    capabilitiesOperation.description,
    /exact fixed leaf source.*active.*search layer.*configured.*never enter data\.legacySearch/is,
  )
  const crawlerCapability = capabilitiesOperation.responses[200].content['application/json']
    .example.data.platforms.find(({ platform }) => platform === 'data_center_saved_records_news')
  assert.deepEqual(crawlerCapability, {
    platform: 'data_center_saved_records_news',
    ready: false,
    capabilities: ['stored_search', 'canonical_search'],
    source: 'hub',
    servingMode: 'stored',
  })

  const requestFields = [
    'includeCandidates', 'minQualityScore', 'province', 'countryCode', 'location', 'from', 'to',
  ]
  for (const schemaName of ['StoredSearchRequest', 'CanonicalSearchRequest']) {
    const properties = document.components.schemas[schemaName].properties
    for (const field of requestFields) assert.ok(properties[field], `${schemaName}.${field}`)
    assert.deepEqual(properties.includeCandidates.enum, ['qualified', 'all'])
    assert.equal(properties.minQualityScore.minimum, 0)
    assert.equal(properties.minQualityScore.maximum, 100)
    assert.equal(properties.countryCode.pattern, '^[A-Za-z]{2}$')
    assert.equal(properties.location.maxLength, 160)
    assert.equal(properties.from.format, 'date-time')
    assert.equal(properties.to.format, 'date-time')
    assert.deepEqual(properties.type.enum, ['fresh', 'stable'])
  }
  const storedCursor = document.components.schemas.StoredSearchRequest.properties.cursor
  assert.deepEqual(
    Object.keys(storedCursor).sort(),
    ['description', 'maxLength', 'minLength', 'type'],
  )
  assert.match(storedCursor.description, /page size/i)
  assert.match(
    storedCursor.description,
    /data_center_saved_records_\* publication-visibility contract/i,
  )
  const canonicalCursor = document.components.schemas.CanonicalSearchRequest.properties.cursor
  assert.deepEqual(
    Object.keys(canonicalCursor).sort(),
    ['description', 'maxLength', 'minLength', 'type'],
  )
  assert.match(
    canonicalCursor.description,
    /data_center_saved_records_\* publication-visibility contract/i,
  )
  assert.deepEqual(
    document.components.schemas.CanonicalSearchRequest.properties.sort.enum,
    ['newest', 'oldest', 'relevance'],
  )

  const stored = document.paths['/data/stored/search'].post
  const canonical = document.paths['/data/canonical/search'].post
  for (const operation of [stored, canonical]) {
    assert.match(operation.description, /formal-only/i)
    assert.match(operation.description, /includeCandidates=all.*from.*to.*province.*countryCode.*location/i)
    assert.match(operation.description, /new Idempotency-Key/i)
    assert.match(operation.description, /candidate author\/contentType/i)
    assert.match(operation.description, /data_center_saved_records_\*.*candidate/i)
    assert.match(operation.description, /content-v6.*PostgreSQL/i)
    assert.match(operation.description, /pre-visibility crawler cursor.*400 invalid_cursor.*restart/i)
    assert.match(
      operation.description,
      /current-contract Elasticsearch cursor.*503 search_cursor_unavailable.*retry/i,
    )
  }
  assert.match(canonical.description, /other platform.*unchanged/i)
  assert.match(
    document.paths['/data/search'].post.description,
    /data_center_saved_records_\*.*rejected.*\/data\/stored\/search.*\/data\/canonical\/search/i,
  )

  for (const envelopeName of ['StoredSearchEnvelope', 'CanonicalSearchEnvelope']) {
    const filters = document.components.schemas[envelopeName]
      .properties.data.properties.filters.properties
    for (const field of requestFields) assert.ok(filters[field], `${envelopeName}.filters.${field}`)
    assert.deepEqual(filters.includeCandidates.oneOf[0], { type: 'boolean', const: false })
    assert.deepEqual(filters.includeCandidates.oneOf[1].enum, ['qualified', 'all'])
  }

  const item = document.components.schemas.StoredSearchItem
  assert.equal(item.properties.quality.$ref, '#/components/schemas/PublicOpinionSearchQuality')
  assert.equal(item.properties.location.$ref, '#/components/schemas/PublicOpinionSearchLocation')
  const quality = document.components.schemas.PublicOpinionSearchQuality
  const location = document.components.schemas.PublicOpinionSearchLocation
  assert.equal(quality.additionalProperties, false)
  assert.equal(location.additionalProperties, false)
  assert.deepEqual(Object.keys(quality.properties), [
    'stage', 'status', 'score', 'geographyVerified',
  ])
  assert.deepEqual(Object.keys(location.properties), [
    'provinceCode', 'label', 'type', 'country', 'countryCode',
  ])
  assert.doesNotMatch(
    JSON.stringify({ quality: quality.properties, location: location.properties }),
    /flags|reason|provider|raw|sourceName|author|contentType/i,
  )
}

const VIRTUAL_SUPERMARKET_QUERY_FIELDS = [
  'categoryId', 'department', 'aisle', 'shelf', 'marketplace', 'query', 'sort', 'pageSize', 'cursor',
]

const PUBLIC_DATA_PRODUCT_MIRROR_PATHS = [
  '/data/canonical/items/{id}/timeline',
  '/data/mobile-commerce/items',
  '/data/source-catalog/{id}/items',
  '/data/virtual-supermarket/metadata',
  '/data/virtual-supermarket/products',
  '/data/virtual-supermarket/products/{id}',
  '/data/virtual-supermarket/search',
]

const PUBLIC_DATA_PRODUCT_MIRROR_SCHEMAS = [
  'CanonicalTimelineCapability', 'CanonicalTimelineDirectionPage',
  'CanonicalTimelinePageInfo', 'CanonicalTimelineEnvelope',
  'MobileCommerceMarketplace', 'MobileCommerceItem', 'MobileCommercePage',
  'MobileCommercePageEnvelope', 'SourceCatalogItemsEnvelope',
  'VirtualSupermarketPlacementPart', 'VirtualSupermarketCategory',
  'VirtualSupermarketShelf', 'VirtualSupermarketAisle',
  'VirtualSupermarketDepartment', 'VirtualSupermarketMetadata',
  'VirtualSupermarketMetadataEnvelope', 'VirtualSupermarketMarketplace',
  'VirtualSupermarketPrice', 'VirtualSupermarketProduct',
  'VirtualSupermarketFilters', 'VirtualSupermarketPage',
  'VirtualSupermarketPageEnvelope', 'VirtualSupermarketDetail',
  'VirtualSupermarketDetailEnvelope',
]

function assertVirtualSupermarketContract(document) {
  const metadata = document.paths['/data/virtual-supermarket/metadata']?.get
  const products = document.paths['/data/virtual-supermarket/products']?.get
  const detail = document.paths['/data/virtual-supermarket/products/{id}']?.get
  const search = document.paths['/data/virtual-supermarket/search']?.get
  for (const operation of [metadata, products, detail, search]) assert.ok(operation)

  assert.equal(metadata.operationId, 'getVirtualSupermarketMetadata')
  assert.deepEqual(metadata['x-mx-allowed-query-fields'], [])
  assert.deepEqual(metadata['x-mx-error-codes'][400], ['unsupported_fields'])
  assert.equal(
    metadata.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/VirtualSupermarketMetadataEnvelope',
  )
  assert.equal(products.operationId, 'listVirtualSupermarketProducts')
  assert.equal(search.operationId, 'searchVirtualSupermarketProducts')
  assert.deepEqual(products['x-mx-allowed-query-fields'], VIRTUAL_SUPERMARKET_QUERY_FIELDS)
  assert.deepEqual(search['x-mx-allowed-query-fields'], VIRTUAL_SUPERMARKET_QUERY_FIELDS)
  assert.deepEqual(products.parameters.map(({ name }) => name), VIRTUAL_SUPERMARKET_QUERY_FIELDS)
  assert.equal(products.parameters.find(({ name }) => name === 'query').required, false)
  assert.equal(search.parameters.find(({ name }) => name === 'query').required, true)
  assert.equal(products.parameters.find(({ name }) => name === 'pageSize').schema.default, 24)
  assert.deepEqual(products.parameters.find(({ name }) => name === 'sort').schema.enum, [
    'newest', 'title_asc', 'price_asc', 'price_desc',
  ])
  assert.deepEqual(products['x-mx-error-codes'][409], ['storefront_revision_changed'])
  assert.deepEqual(search['x-mx-error-codes'][409], ['storefront_revision_changed'])
  assert.deepEqual(detail['x-mx-error-codes'][404], ['virtual_supermarket_product_not_found'])
  assert.ok(detail['x-mx-error-codes'][400].includes('unsupported_fields'))
  assert.equal(
    detail.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/VirtualSupermarketDetailEnvelope',
  )

  const metadataSchema = document.components.schemas.VirtualSupermarketMetadata
  assert.equal(metadataSchema.properties.contractVersion.const, 'mx-insight-hub.data-products.virtual-supermarket.v1')
  assert.equal(metadataSchema.properties.platform.const, 'virtual_supermarket')
  assert.ok(metadataSchema.required.includes('storefrontRevision'))
  assert.ok(metadataSchema.required.includes('departments'))
  assert.deepEqual(metadataSchema.properties.supportedSorts.const, [
    'newest', 'title_asc', 'price_asc', 'price_desc',
  ])

  const product = document.components.schemas.VirtualSupermarketProduct
  assert.match(product.properties.id.description, /independently allocated/u)
  assert.match(product.properties.id.description, /never the mobile-commerce capture\/canonical row UUID/u)
  assert.equal(product.additionalProperties, false)
  assert.deepEqual(Object.keys(product.properties).sort(), [
    'category', 'collectedAt', 'dataVersion', 'id', 'listing', 'marketplace',
    'placement', 'product', 'shop', 'signals',
  ])
  assert.deepEqual(Object.keys(product.properties.placement.properties), [
    'department', 'aisle', 'shelf', 'position',
  ])
  assert.equal(product.properties.listing.properties.status.const, 'on_shelf')
  assert.deepEqual(Object.keys(product.properties.product.properties), [
    'title', 'specification', 'price', 'provenance',
  ])
  assert.deepEqual(Object.keys(product.properties.shop.properties), ['name'])
  assert.deepEqual(Object.keys(document.components.schemas.VirtualSupermarketMarketplace.properties), ['id', 'name'])
  assert.deepEqual(document.components.schemas.VirtualSupermarketMarketplace.required, ['id', 'name'])
  assert.deepEqual(Object.keys(document.components.schemas.VirtualSupermarketPrice.properties), [
    'amount', 'currency', 'display', 'provenance',
  ])
  assert.deepEqual(document.components.schemas.VirtualSupermarketPrice.properties.currency.type, ['string', 'null'])
  assert.match(document.components.schemas.VirtualSupermarketPrice.properties.currency.description, /Source prices keep null/u)
  assert.doesNotMatch(JSON.stringify(product), /goodsId|shopId|sourceValue|mappingStatus|catalogEntryId|canonicalName|catalogSourceKey|captureId|task|run|campaign|raw|metadata|device|is_reported|brand|media/i)
  assert.doesNotMatch(
    JSON.stringify(document.components.schemas.MobileCommerceItem.properties.id),
    /publication UUID/u,
  )
  assert.ok(document.components.schemas.VirtualSupermarketPage.required.includes('storefrontRevision'))
  assert.ok(document.components.schemas.VirtualSupermarketDetail.required.includes('storefrontRevision'))

  const capability = document.paths['/data/capabilities'].get.responses[200]
    .content['application/json'].example.data.platforms
    .find(({ platform }) => platform === 'virtual_supermarket')
  assert.deepEqual(capability, {
    platform: 'virtual_supermarket',
    ready: true,
    capabilities: [
      'metadata', 'products', 'product_detail', 'stored_search',
      'category_filter', 'department_filter', 'aisle_filter',
      'shelf_filter', 'marketplace_filter',
    ],
    source: 'hub',
    servingMode: 'stored',
  })
}

function publicOperationMirrorShape(operation) {
  return {
    operationId: operation.operationId,
    allowedQueryFields: operation['x-mx-allowed-query-fields'] ?? null,
    errorCodes: operation['x-mx-error-codes'] ?? null,
    requiredPlatform: operation['x-mx-required-platform'] ?? null,
    requiredCapabilities: operation['x-mx-required-capabilities'] ?? null,
    parameters: (operation.parameters || []).map(({ name, in: location, required, schema }) => ({
      name, in: location, required, schema,
    })),
    responseSchema: operation.responses[200]?.content?.['application/json']?.schema ?? null,
  }
}

function assertPublicDataProductMirror(dynamicDocument, staticDocument) {
  for (const path of PUBLIC_DATA_PRODUCT_MIRROR_PATHS) {
    assert.deepEqual(
      publicOperationMirrorShape(staticDocument.paths[path].get),
      publicOperationMirrorShape(dynamicDocument.paths[path].get),
      `${path} static/dynamic operation contract drifted`,
    )
  }
  for (const name of PUBLIC_DATA_PRODUCT_MIRROR_SCHEMAS) {
    assert.deepEqual(
      staticDocument.components.schemas[name],
      dynamicDocument.components.schemas[name],
      `${name} static/dynamic schema drifted`,
    )
  }
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
    const pagePaths = [
      '/docs', '/docs/auth', '/docs/source-catalog', '/docs/ecommerce-treasure-box', '/docs/xiaohongshu-note', '/docs/virtual-supermarket', '/docs/search', '/docs/telegram',
      '/docs/public-opinion', '/docs/night-all', '/docs/tools', '/docs/evidence', '/docs/errors',
    ]
    const pages = await Promise.all(pagePaths.map(async (path) => {
      const response = await fetch(`${baseUrl}${path}`)
      return { path, response, html: await response.text() }
    }))
    const response = pages[0].response
    const html = pages.map((page) => page.html).join('\n')
    const ecommerceHtml = pages.find((page) => page.path === '/docs/ecommerce-treasure-box').html
    const xiaohongshuHtml = pages.find((page) => page.path === '/docs/xiaohongshu-note').html
    const nightAllHtml = pages.find((page) => page.path === '/docs/night-all').html
    const errorsHtml = pages.find((page) => page.path === '/docs/errors').html

    assert.ok(pages.every((page) => page.response.status === 200))
    assert.match(response.headers.get('content-type'), /^text\/html/)
    assert.match(response.headers.get('content-security-policy'), /default-src 'none'/)
    assert.match(html, /MX Insight Hub/)
    assert.match(html, /\/api\/v1\/data\/search/)
    assert.match(html, /\/api\/v1\/data\/ecommerce\/products\/search/)
    assert.match(html, /mx-insight-hub\.ecommerce-products\.v1/)
    assert.match(xiaohongshuHtml, /\/api\/v1\/data\/post/)
    assert.match(xiaohongshuHtml, /\/api\/v1\/xiaohongshu\/app\/get_note_info/)
    assert.match(xiaohongshuHtml, /GET[\s\S]*?share_text/u)
    assert.match(xiaohongshuHtml, /note_id[\s\S]*?优先/u)
    assert.match(xiaohongshuHtml, /user_id[\s\S]*?优先/u)
    assert.match(xiaohongshuHtml, /\/api\/v1\/data\/posts\/media/)
    assert.match(xiaohongshuHtml, /mx-insight-hub\.social-post\.v1/)
    assert.match(xiaohongshuHtml, /data\.item/)
    assert.match(xiaohongshuHtml, /immutable snapshot/)
    assert.match(xiaohongshuHtml, /tenant[\s\S]*?consumer[\s\S]*?membership/u)
    assert.match(xiaohongshuHtml, /Launcher 会话[\s\S]*?API Keys[\s\S]*?Live Key/u)
    assert.match(xiaohongshuHtml, /compat\.xiaohongshu\.app_v2/u)
    assert.match(xiaohongshuHtml, /social\.posts\.search/u)
    assert.match(xiaohongshuHtml, /social\.users\.resolve/u)
    assert.match(xiaohongshuHtml, /social\.users\.posts/u)
    for (const code of ['invalid_user_profile_url', 'cursor_page_mismatch', 'user_not_found']) {
      assert.match(nightAllHtml, new RegExp(code), code)
    }
    assert.match(nightAllHtml, /不返回[\s\S]*410 search_cursor_expired/u)
    assert.match(html, /新 Key 默认是零权限 snapshot/u)
    assert.match(xiaohongshuHtml, /套餐与配额[\s\S]*?余额[\s\S]*?扣费/u)
    assert.match(errorsHtml, /正价 enforced 按次计费 wallet hold/u)
    assert.match(errorsHtml, /paid-ready 请求不会因 Hub 月度采购或补贴上限被拒/u)
    assert.match(errorsHtml, /共享供应方限流[\s\S]*?全局与单 consumer 并发[\s\S]*?熔断/u)
    assert.match(errorsHtml, /external_platform_cost_budget_exhausted/u)
    assert.match(errorsHtml, /external_platform_subsidy_budget_exhausted/u)
    assert.doesNotMatch(xiaohongshuHtml, /deprecated alias/iu)
    assert.match(html, /电商数据百宝箱/)
    assert.doesNotMatch(ecommerceHtml, FORBIDDEN_PROVIDER_NEUTRAL_CONTRACT_DETAILS)
    assert.match(html, /同一把 Hub Public API Key/u)
    assert.match(html, /当前发布只有一个私有合格候选，尚未启用多供应商运行时路由或自动故障转移/u)
    assert.match(html, /第二个候选通过合同验证后/u)
    assert.match(html, /相同 <code>Idempotency-Key<\/code>/u)
    assert.match(html, /Hub customer|Hub 客户计价/u)
    assert.match(html, /fresh_cache/)
    assert.match(html, /stored_fallback/)
    assert.match(html, /相同 <code>Idempotency-Key<\/code> 只重放已提交的原 502，不再次调用上游/u)
    assert.match(ecommerceHtml, /主搜索按钮是唯一入口/u)
    assert.match(ecommerceHtml, /没有额外核对按钮/u)
    assert.match(ecommerceHtml, /X-MX-Insight-Retry-Of/u)
    assert.match(ecommerceHtml, /只有明确 <code>unknown<\/code>/u)
    assert.match(ecommerceHtml, /<code>reserved<\/code>、网络失败、路由\/版本不匹配和 succeeded-unusable 隔离继续阻止外部调用/u)
    assert.match(html, /未解决的实时请求不会阻塞本地安全演示或 <code>cache_only<\/code> 存量浏览/u)
    assert.match(html, /不会锁死筛选条件/u)
    assert.match(html, /200 且 <code>items=\[\]<\/code>/u)
    assert.match(html, /href="\/docs\/night-all"/)
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
    assert.match(html, /\/api\/v1\/data\/canonical\/items\/\{id\}\/timeline/)
    assert.match(html, /storedWindow\.hasMoreStoredBefore\/After/)
    assert.match(html, /pageInfo\.older\/newer\.cursor/)
    assert.match(html, /consistency=live-keyset/)
    assert.match(html, /不提供 changes feed/)
    assert.match(html, /外部会话应用复刻流程/)
    assert.match(html, /canonicalId/)
    assert.match(html, /保持用户当前视口/)
    assert.match(html, /upstreamCompleteness/)
    assert.match(html, /context_not_supported/)
    assert.match(html, /\/api\/v1\/data\/telegram\/search/)
    assert.match(html, /\/api\/v1\/data\/telegram\/messages/)
    assert.match(html, /\/api\/v1\/data\/source-catalog/)
    assert.match(html, /\/api\/v1\/data\/source-catalog\/metadata/)
    assert.match(html, /\/api\/v1\/data\/source-catalog\/\{id\}\/items/)
    assert.match(html, /\/api\/v1\/data\/mobile-commerce\/items/)
    assert.match(html, /\/api\/v1\/data\/virtual-supermarket\/metadata/)
    assert.match(html, /\/api\/v1\/data\/virtual-supermarket\/products\/\{id\}/)
    assert.match(html, /\/api\/v1\/data\/virtual-supermarket\/search/)
    assert.match(html, /virtual_supermarket/)
    assert.match(html, /逛超市/)
    assert.match(html, /超市全景/)
    assert.match(html, /目录模式/)
    assert.match(html, /全景只是客户端 renderer/)
    assert.match(html, /department \/ aisle \/ shelf \/ position/)
    assert.match(html, /storefrontRevision/)
    assert.match(html, /storefront_revision_changed/)
    assert.match(html, /外部复刻流程/)
    assert.match(html, /currency=null/)
    assert.match(html, /不能猜成 CNY/)
    assert.match(html, /approved mapping/)
    assert.match(html, /外部手机采集执行器/)
    assert.match(html, /Elasticsearch/)
    assert.match(html, /source-catalog\.public\.v1/)
    assert.match(html, /source_catalog/)
    assert.match(html, /\/api\/v1\/data\/public-opinion\/provinces\/\{province\}\/items/)
    assert.match(html, /\/api\/v1\/data\/public-opinion\/regions\?parentCode=CN&amp;level=province/)
    assert.match(html, /\/api\/v1\/data\/public-opinion\/regions\/\{regionCode\}\/items/)
    assert.match(html, /\/api\/v1\/data\/public-opinion\/province-coverage/)
    assert.match(html, /\/api\/v1\/data\/public-opinion\/items\/\{id\}/)
    assert.match(html, /includeCandidates/)
    assert.match(html, /minQualityScore/)
    assert.match(html, /countryCode/)
    assert.match(html, /候选 author、contentType/)
    assert.match(html, /旧值会返回.*idempotency_conflict/)
    assert.match(html, /featuredProvinceCodes/)
    assert.match(html, /public_opinion/)
    assert.match(html, /public_opinion\.all_ingested\.read/)
    assert.match(html, /canonical_current_safe/)
    assert.match(html, /province=null/)
    assert.match(html, /P1 不发布市级代码/)
    assert.match(html, /两个 curated province-feed 索引都有效/)
    assert.match(html, /region feed 专用的全局 latest 索引/)
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
    const sourceCatalogHtml = pages.find((page) => page.path === '/docs/source-catalog').html
    assert.match(sourceCatalogHtml, /export HUB_URL=/)
    assert.match(sourceCatalogHtml, /MX_INSIGHT_API_KEY/)
    assert.match(sourceCatalogHtml, /管理台的“开放能力”/)
    assert.match(sourceCatalogHtml, /新增授权则要签发并显式选择该范围的新 Key/u)
    assert.match(sourceCatalogHtml, /\/api\/v1\/data\/capabilities/)
    assert.match(sourceCatalogHtml, /\/api\/v1\/data\/source-catalog\/metadata/)
    assert.match(sourceCatalogHtml, /SOURCE_ID/)
    assert.match(sourceCatalogHtml, /nextCursor/)
    for (const code of [
      'invalid_source_catalog_id', 'source_catalog_entry_not_found',
      'platform_not_granted', 'quota_exceeded', 'stored_data_unavailable',
    ]) assert.match(sourceCatalogHtml, new RegExp(code))
    assert.equal((html.match(/<script>/g) || []).length, 1)
    assert.match(response.headers.get('content-security-policy'), /script-src 'sha256-/)
    assert.doesNotMatch(html, /https?:\/\/(?:cdn|unpkg|jsdelivr)\./i)
    assert.doesNotMatch(html, FORBIDDEN_PUBLIC_DOC_DETAILS)
    assert.doesNotMatch(html, /mih_(?:live|test)_[A-Za-z0-9_-]+/i)
  })
})

test('public documentation navigation uses stable page routes and keeps legacy anchors predictable', async () => {
  await withServer('public', async (baseUrl) => {
    const pages = [
      ['/docs/auth', 'rules', '认证与调用规则'],
      ['/docs/source-catalog', 'source-catalog', '数据源目录'],
      ['/docs/ecommerce-treasure-box', 'ecommerce-treasure-box', '电商数据百宝箱'],
      ['/docs/xiaohongshu-note', 'xiaohongshu-note', '小红书笔记'],
      ['/docs/virtual-supermarket', 'virtual-supermarket', '虚拟超市'],
      ['/docs/search', 'search', '通用搜索'],
      ['/docs/telegram', 'telegram', 'Telegram 会话'],
      ['/docs/public-opinion', 'public-opinion', '全国省级舆情'],
      ['/docs/night-all', 'night-all', 'Night-All 兼容层'],
      ['/docs/tools', 'tools', '通用工具'],
      ['/docs/evidence', 'discovery', '能力、请求状态与用量'],
      ['/docs/errors', 'errors', '错误与重试'],
    ]

    for (const [path, key, heading] of pages) {
      const response = await fetch(`${baseUrl}${path}`)
      const html = await response.text()
      assert.equal(response.status, 200, path)
      assert.match(html, new RegExp(`href="${path}" class="active" aria-current="page"`), path)
      assert.match(html, new RegExp(`data-doc-page="${key}"`), path)
      assert.match(html, new RegExp(heading), path)
      assert.equal((html.match(/class="doc-page"/g) || []).length, 1, path)
      assert.doesNotMatch(html, /href="#[^"]+"/, path)
    }

    const evidenceResponse = await fetch(`${baseUrl}/docs/evidence`)
    const evidenceHtml = await evidenceResponse.text()
    assert.equal(evidenceResponse.status, 200)
    assert.match(evidenceHtml, /\/api\/v1\/acquisitions\/\{requestId\}/)
    assert.match(evidenceHtml, /delivered\.responseBody/)
    assert.match(evidenceHtml, /sha256-canonical-json-v1/)
    assert.match(evidenceHtml, /customerCharge/)
    assert.match(evidenceHtml, /canonical lineage/)
    assert.match(evidenceHtml, /不创建 usage，也绝不重新派发或运行上游请求/)
    assert.match(evidenceHtml, /curl -sS.*\/api\/v1\/acquisitions\/\$ACQUISITION_REQUEST_ID/s)

    const trailingSlash = await fetch(`${baseUrl}/docs/telegram/`)
    assert.equal(trailingSlash.status, 200)
    assert.match(await trailingSlash.text(), /data-doc-page="telegram"/)

    const legacyEntry = await fetch(`${baseUrl}/docs`)
    const legacyHtml = await legacyEntry.text()
    assert.equal(legacyEntry.status, 200)
    assert.equal((legacyHtml.match(/class="doc-page"/g) || []).length, 1)
    assert.match(legacyHtml, /location\.hash\.slice\(1\)/)
    assert.match(legacyHtml, /'public-opinion':'\/docs\/public-opinion'/)
    assert.match(legacyHtml, /'virtual-supermarket':'\/docs\/virtual-supermarket'/)
    assert.match(legacyHtml, /'ecommerce-treasure-box':'\/docs\/ecommerce-treasure-box'/)
    assert.match(legacyHtml, /'xiaohongshu-note':'\/docs\/xiaohongshu-note'/)
    assert.match(legacyHtml, /telegram:'\/docs\/telegram'/)
    assert.match(legacyHtml, /class="nav-section">数据产品<\/span>/)

    for (const [alias, canonical] of [
      ['/docs/authentication', '/docs/auth'],
      ['/docs/operations', '/docs/evidence'],
    ]) {
      const redirect = await fetch(`${baseUrl}${alias}`, { redirect: 'manual' })
      assert.equal(redirect.status, 308)
      assert.equal(redirect.headers.get('location'), canonical)
    }

    const unknown = await fetch(`${baseUrl}/docs/unknown-page`)
    assert.equal(unknown.status, 404)
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
      '/acquisitions/{requestId}',
      '/data/canonical/items/{id}/context',
      '/data/canonical/items/{id}/timeline',
      '/data/canonical/search',
      '/data/capabilities',
      '/data/ecommerce/products/media',
      '/data/ecommerce/products/search',
      '/data/mobile-commerce/items',
      '/data/post',
      '/data/posts/media',
      '/data/public-opinion/funnel',
      '/data/public-opinion/items/{id}',
      '/data/public-opinion/province-coverage',
      '/data/public-opinion/provinces/{province}/items',
      '/data/public-opinion/records',
      '/data/public-opinion/records/{id}',
      '/data/public-opinion/regions',
      '/data/public-opinion/regions/{regionCode}/items',
      '/data/search',
      '/data/source-catalog',
      '/data/source-catalog/metadata',
      '/data/source-catalog/{id}',
      '/data/source-catalog/{id}/items',
      '/data/stored/search',
      '/data/telegram/chats',
      '/data/telegram/entities/search',
      '/data/telegram/messages',
      '/data/telegram/search',
      '/data/virtual-supermarket/metadata',
      '/data/virtual-supermarket/products',
      '/data/virtual-supermarket/products/{id}',
      '/data/virtual-supermarket/search',
      '/night-all/search/{operation}',
      '/requests/by-idempotency-key',
      '/requests/{requestId}',
      '/search/{operation}',
      '/tools/tokenize',
      '/usage',
      '/xiaohongshu/app/get_note_info',
      '/xiaohongshu/app_v2/get_image_note_detail',
      '/xiaohongshu/app_v2/get_user_info',
      '/xiaohongshu/app_v2/get_user_posted_notes',
      '/xiaohongshu/app_v2/search_notes',
      '/xiaohongshu/app_v2/search_users',
    ])
    assert.deepEqual(Object.keys(document.components.securitySchemes).sort(), ['apiKeyHeader', 'bearerKey'])

    const serialized = JSON.stringify(document)
    assert.doesNotMatch(serialized, FORBIDDEN_PUBLIC_DOC_DETAILS)
    assert.doesNotMatch(serialized, FORBIDDEN_PROVIDER_NEUTRAL_CONTRACT_DETAILS)
    assert.doesNotMatch(serialized, /mih_(?:live|test)_[A-Za-z0-9_-]+/i)
    assert.match(serialized, /Idempotency-Key/)
    assert.match(serialized, /opaque nextCursor/i)
    const lookup = document.paths['/requests/by-idempotency-key'].get
    assert.equal(lookup.parameters[0].name, 'Idempotency-Key')
    assert.equal(lookup.parameters[0].in, 'header')
    assert.equal(lookup.parameters[0].required, true)
    assert.match(lookup.description, /creates no usage/i)
    assert.match(lookup.description, /another consumer receives request_not_found/i)
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
    assert.equal(document.components.schemas.MobileCommerceItem.additionalProperties, false)
    assert.equal(
      document.paths['/data/source-catalog/{id}/items'].get
        .responses[200].content['application/json'].schema.$ref,
      '#/components/schemas/SourceCatalogItemsEnvelope',
    )
    assert.deepEqual(
      document.components.schemas.MobileCommercePage.properties.acquisition.properties.executionPlane,
      { type: 'string', const: 'external-mobile-collector' },
    )
    assertPublicOpinionContract(document)
    assertPublicOpinionSearchContract(document)
    assertNightAllPublicContract(document)
    assertCanonicalContextContract(document)
    assertCanonicalTimelineContract(document)
    assertDataProductPublicContract(document)
    assertVirtualSupermarketContract(document)
    assertExternalCommerceContract(document)
    assertExternalSocialPostContract(document)
    assertXiaohongshuSearchContract(document)
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

test('public OpenAPI documents paid-ready financial bypass and retained technical protections once', () => {
  const policy = PUBLIC_OPENAPI_DOCUMENT['x-mx-external-platform-admission']

  assert.match(policy.paidReady.definition, /positive enforced per-request customer charge/u)
  assert.match(policy.paidReady.definition, /wallet hold was successfully reserved/u)
  assert.equal(policy.paidReady.rejectedByHubMonthlyProcurementOrSubsidyCaps, false)
  assert.deepEqual(policy.subsidizedTraffic.possibleFinancialCapErrors, [
    'external_platform_cost_budget_exhausted',
    'external_platform_subsidy_budget_exhausted',
  ])
  assert.match(policy.subsidizedTraffic.definition, /without that positive enforced per-request wallet hold/u)
  assert.equal(policy.procurementEvidence.currentEndpointAndRequestRequiredForPaidReady, true)
  assert.equal(policy.procurementEvidence.unrelatedHistoricalAnomaliesRejectPaidReady, false)
  assert.equal(policy.technicalProtections.applyToPaidReady, true)
  assert.deepEqual(policy.technicalProtections.controls, [
    'api_key_and_plan_quota',
    'shared_provider_rate_limit',
    'global_and_consumer_concurrency',
    'circuit_breaker',
    'contract_credential_idempotency_and_dispatch_safety',
  ])
})

test('static OpenAPI YAML mirrors dynamic Night-All and public data-product contracts', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../docs/contracts/openapi.yaml', import.meta.url)),
    'utf8',
  )
  assert.doesNotMatch(source, /tikhub|rapidapi|justone/i)
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
  assert.deepEqual(
    document['x-mx-external-platform-admission'],
    PUBLIC_OPENAPI_DOCUMENT['x-mx-external-platform-admission'],
  )
  assertNightAllPublicContract(document)
  assertPublicOpinionContract(document)
  assertPublicOpinionSearchContract(document)
  assertCanonicalContextContract(document)
  assertCanonicalTimelineContract(document)
  assertDataProductPublicContract(document, {
    chats: 'listTelegramMonitorChats',
    messages: 'listTelegramMonitorMessages',
    search: 'searchStoredTelegram',
  })
  assertVirtualSupermarketContract(document)
  assertExternalCommerceContract(document)
  assertExternalSocialPostContract(document)
  assertXiaohongshuSearchContract(document)
  assertPublicDataProductMirror(PUBLIC_OPENAPI_DOCUMENT, document)
})

test('public curl guide defines the legacy matrix as Hub-pinned dispatch policy', async () => {
  const guide = await readFile(
    fileURLToPath(new URL('../../docs/public-api-curl.md', import.meta.url)),
    'utf8',
  )
  assert.match(guide, /Hub-pinned/)
  assert.match(guide, /不会在请求时从\s*Night-All `\/api\/v1\/search\/capabilities` 实时发现/)
  assert.match(guide, /readyPlatforms[^。]*仅表示 Hub 在当前固定(?:历史)?兼容契约下允许 dispatch/)
  assert.match(guide, /不证明 handler、endpoint、provider、credential/)
  assert.doesNotMatch(guide, /默认 provider 已启用且配置了凭据/)
  assert.doesNotMatch(guide, /存在可执行 handler 或 endpoint candidate/)
  assert.match(guide, /\/api\/v1\/data\/canonical\/items\/\{id\}\/context/)
  assert.match(guide, /\/api\/v1\/data\/canonical\/items\/\{id\}\/timeline/)
  assert.match(guide, /storedWindow\.hasMoreStoredBefore\/After/)
  assert.match(guide, /pageInfo\.older\.cursor/)
  assert.match(guide, /live-keyset/)
  assert.match(guide, /每个搜索下一页[^。]*新的 `Idempotency-Key`/)
  assert.match(guide, /新增高度补偿到 scrollTop/)
  assert.match(guide, /upstreamCompleteness/)
  assert.match(guide, /public_opinion.*formal/is)
  assert.match(guide, /includeCandidates=all.*province.*countryCode.*location/is)
  assert.match(guide, /升级前.*409 idempotency_conflict/s)
  assert.match(guide, /source_catalog/)
  assert.match(guide, /\/api\/v1\/data\/source-catalog\/metadata/)
  assert.match(guide, /\/api\/v1\/data\/source-catalog\/\$\{SOURCE_ID\}/)
  assert.match(guide, /nextCursor/)
  assert.match(guide, /source_catalog_entry_not_found/)
  assert.match(guide, /\/api\/v1\/data\/post/)
  assert.match(guide, /\/api\/v1\/xiaohongshu\/app\/get_note_info/)
  assert.match(guide, /\/api\/v1\/data\/posts\/media/)
  assert.match(guide, /social\.posts\.resolve/)
  assert.match(guide, /search_posts/)
  assert.match(guide, /search\.ready=true/)
  assert.match(guide, /不会把小红书从 `legacySearch` 移除/)
  assert.match(guide, /pageSize[^。]*20[^。]*direct external-data connector/)
  assert.match(guide, /独立[^。]*rollout gate[^。]*首屏|首屏[^。]*独立 rollout gate/)
  assert.match(guide, /长度恰好为 60[^。]*内部详情补全/)
  assert.match(guide, /includeDetails:false[^。]*includeComments:false[^。]*no-op/)
  assert.match(guide, /body[^。]*requestId[^。]*x-mx-insight-request-id[^。]*durable Hub UUID/)
  assert.match(guide, /external_platform_rate_limited/)
})

test('public curl guide hides deployment topology and documents the Xiaohongshu canonical idempotency exception', async () => {
  const guide = await readFile(
    fileURLToPath(new URL('../../docs/public-api-curl.md', import.meta.url)),
    'utf8',
  )
  const introduction = guide.slice(0, guide.indexOf('## 1. Shell 环境'))

  assert.match(introduction, /\$HUB_URL/)
  assert.match(introduction, /内部路由、部署拓扑与供应方选择不属于公开合同/)
  assert.doesNotMatch(
    guide,
    /Domestic Nginx|WireGuard|Internal Nginx|10\.88\.88\.88|127\.0\.0\.1:(?:18150|18151|13141)|public listener `18150`|admin listener/,
  )
  assert.match(guide, /共三个 Hub 投影入口共享一个 canonical 幂等 namespace/)
  assert.match(guide, /不能仅因 method 或入口路径写法变化而生成新的 `Idempotency-Key`/)
  assert.match(guide, /复用 key 后改变 `deliveryMode` 会返回 `409 idempotency_conflict`/)
  assert.match(guide, /App V2-compatible GET[^。]*独立兼容合同与幂等域/)
  assert.match(guide, /不能跨 endpoint 复用 key/)
})

test('crawler public contract guide mirrors discovery and visibility boundaries', async () => {
  const contract = await readFile(
    fileURLToPath(new URL('../../docs/contracts/public-api-v1.md', import.meta.url)),
    'utf8',
  )

  assert.match(contract, /data_center_saved_records_news[\s\S]*stored_search[\s\S]*canonical_search/u)
  assert.match(contract, /data_center_saved_records_<source_type>[\s\S]*never enter `data\.legacySearch`/u)
  assert.match(contract, /data_center_saved_records_\*[\s\S]*rejected[\s\S]*\/data\/stored\/search/u)
  assert.match(contract, /publication[\s\S]*exactly `candidate`/u)
  assert.match(contract, /content-v6[\s\S]*400[\s\S]*invalid_cursor[\s\S]*503[\s\S]*search_cursor_unavailable/u)
  assert.match(contract, /visibility contract[\s\S]*idempotency fingerprint/u)
})

test('external data platform public contract and internal operations guidance stay aligned', async () => {
  const [contract, curlGuide, staticOpenApi, adr, operations] = await Promise.all([
    readFile(fileURLToPath(new URL('../../docs/contracts/public-api-v1.md', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../docs/public-api-curl.md', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../docs/contracts/openapi.yaml', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../docs/adr/0013-external-data-platform-gateway.md', import.meta.url)), 'utf8'),
    readFile(fileURLToPath(new URL('../../docs/operations/external-data-platforms.md', import.meta.url)), 'utf8'),
  ])

  for (const source of [contract, curlGuide, staticOpenApi]) {
    assert.doesNotMatch(source, /tikhub|rapidapi|justone/i)
    for (const code of EXTERNAL_OPERATION_CONTROL_ERROR_CODES) {
      assert.match(source, new RegExp(code), code)
    }
  }
  for (const code of EXTERNAL_OPERATION_CONTROL_ERROR_CODES) {
    assert.match(operations, new RegExp(code), code)
  }
  for (const source of [contract, curlGuide]) {
    assert.match(source, /\/api\/v1\/data\/ecommerce\/products\/search/)
    assert.match(source, /mx-insight-hub\.ecommerce-products\.v1/)
    assert.match(source, /marketplace.*query.*page.*cursor.*sort.*price/is)
    assert.match(source, /(?:no|没有) `?pageSize`?/i)
    assert.match(source, /page.*cursor.*mutually exclusive|page.*cursor.*互斥/is)
    assert.match(source, /next.*new.*Idempotency-Key|下一页.*新的.*Idempotency-Key/is)
    for (const mode of ['live', 'fresh_cache', 'stored_fallback', 'idempotent_replay']) {
      assert.match(source, new RegExp(mode))
    }
    for (const field of ['capturedAt', 'servedAt', 'sourceMode', 'ageSeconds']) {
      assert.match(source, new RegExp(field))
    }
  }

  for (const source of [contract, curlGuide]) {
    assert.match(source, /\/api\/v1\/data\/post/)
    assert.match(source, /\/api\/v1\/xiaohongshu\/app\/get_note_info/)
    assert.match(source, /\/api\/v1\/data\/posts\/media/)
    assert.match(source, /mx-insight-hub\.social-post\.v1/)
    assert.match(source, /social\.posts\.resolve/)
    assert.match(source, /data.*item/is)
    assert.match(source, /search_posts/)
    assert.match(source, /night-all\.data-search\.v1/)
    assert.match(source, /pageSize.*exactly 20|pageSize.*恰好.*20/is)
    assert.match(source, /60-character provider\s+preview boundary|长度恰好为 60/is)
    assert.match(source, /external_platform_rate_limited/)
    assert.match(source, /note_id[\s\S]{0,300}(?:takes\s+precedence|优先)/i)
    assert.match(source, /user_id[\s\S]{0,300}(?:takes\s+precedence|为准|优先)/i)
    for (const code of ['invalid_user_profile_url', 'cursor_page_mismatch', 'user_not_found']) {
      assert.match(source, new RegExp(code), code)
    }
    for (const [endpoint, capability] of [
      ['get_image_note_detail', 'social.posts.resolve'],
      ['search_notes', 'social.posts.search'],
      ['search_users', 'social.users.resolve'],
      ['get_user_info', 'social.users.resolve'],
      ['get_user_posted_notes', 'social.users.posts'],
    ]) {
      assert.match(source, new RegExp(`${endpoint}[\\s\\S]{0,500}${capability.replaceAll('.', '\\.')}|${capability.replaceAll('.', '\\.')}[\\s\\S]{0,500}${endpoint}`))
    }
    for (const [operation, capability] of [
      ['raw', 'social.posts.search'],
      ['crawl', 'social.users.posts'],
      ['user-info', 'social.users.resolve'],
    ]) {
      assert.match(source, new RegExp(`${operation}[\\s\\S]{0,500}${capability.replaceAll('.', '\\.')}`))
    }
  }

  assert.match(adr, /JustOne/)
  assert.match(operations, /JustOne/)
  for (const capability of [
    'search_intent', 'search_post_detail', 'search_post_comments', 'youtube_channel_comments',
  ]) assert.match(adr, new RegExp(capability))
  assert.match(adr, /capability-gap inventory/i)
  assert.match(adr, /unknown is never displayed or aggregated as zero/i)
  assert.match(adr, /justone\/\{marketplace\}\/product-search\/\{endpointVersion\}/)
  assert.match(operations, /gateway_requests.*Hub demand/is)
  assert.match(operations, /provider_calls.*actual JustOne dispatches/is)
  assert.match(operations, /next-page request.*new.*Idempotency-Key|下一页.*新的.*Idempotency-Key/is)
  assert.match(operations, /Launcher.*MX-H2I/is)
  assert.match(operations, /065_lock_usage_authorization_scope_set\.sql/)
  assert.match(operations, /complete multi-axis authorization snapshot/)
  assert.match(operations, /non-expandable index projection/)
})

test('admin-only listener does not expose public documentation', async () => {
  await withServer('admin', async (baseUrl) => {
    for (const path of ['/docs', '/docs/auth', '/docs/authentication', '/docs/ecommerce-treasure-box', '/docs/virtual-supermarket', '/docs/telegram', '/docs/public-opinion', '/docs/openapi.json']) {
      const response = await fetch(`${baseUrl}${path}`)
      const payload = await response.json()
      assert.equal(response.status, 404)
      assert.equal(payload.error.code, 'not_found')
    }
  })
})
