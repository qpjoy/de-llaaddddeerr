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
  'user-info': ['username', 'usernames', 'userId', 'userIds', 'user_id', 'uid'],
}
const NIGHT_ALL_REJECTED_PARAMS = [
  'provider', 'endpoint', 'credential', 'token/auth', 'timeout', 'capability',
  'moduleCode', 'archive', 'fullArchive', 'allTweets', 'archiveLimit',
  'totalCount', 'max*Pages', 'pageCount', 'chunkSize', 'budget', 'crawlDepth',
  'count', 'limit', 'pageSize', 'page', 'pageNumber', 'pageNo', 'concurrency',
  'includeDetails', 'includeComments', 'disableAutoDetails', 'commentLimit',
  'maxEnrichItems', 'enrichConcurrency', 'cacheMaxAgeHours',
]

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
  for (const field of ['channelUrl', 'channel_url', 'url', 'commentCursor']) {
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
    assert.match(html, /\/api\/v1\/night-all\/search\/\{raw\|crawl\|user-info\}/)
    assert.match(html, /\/api\/v1\/data\/stored\/search/)
    assert.match(html, /\/api\/v1\/data\/canonical\/search/)
    assert.match(html, /\/api\/v1\/data\/telegram\/search/)
    assert.match(html, /\/api\/v1\/data\/telegram\/messages/)
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
      '/data/canonical/search',
      '/data/capabilities',
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
    assertNightAllCompatibilityRequestSchema(document.components.schemas.NightAllLegacyRequest)
    assert.equal(
      document.paths['/night-all/search/{operation}'].post.requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/NightAllLegacyRequest',
    )
    assert.match(
      document.paths['/night-all/search/{operation}'].post.responses[200].description,
      /not masked|retain/i,
    )
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
  assertNightAllCompatibilityRequestSchema(document.components.schemas.NightAllLegacyRequest)
  assert.equal(
    document.paths['/night-all/search/{operation}'].post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/NightAllLegacyRequest',
  )
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
