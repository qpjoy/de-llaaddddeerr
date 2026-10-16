import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { nativeForwardingEndpoint, normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { YOUTUBE_COMMENT_PATHS, YOUTUBE_COMMENTS_CAPABILITY } from '../../server/contracts/youtube-comments.mjs'
import { servicePriceDefinition } from '../../server/contracts/service-pricing.mjs'
import { PUBLIC_OPENAPI_DOCUMENT, tenantOpenApiDocument, publicDocsHtmlForPath } from '../../server/public-docs.mjs'
import { classifyExternalPlatformIngest } from '../../server/workers/ingest.mjs'
import { productAllowed } from '../../shared/product-access.mjs'
import { implementedRoutes } from '../../server/data/source-connections.mjs'
import { PROVISIONING_OPERATIONS } from '../../server/commercial/catalog.mjs'

test('reviewed YouTube native contract resolves only the documented comment sort enum', () => {
  const key = 't.api_4a6f21264dc0b4a1'
  assert.equal(nativeForwardingEndpoint(key).path, '/api/v1/youtube/web_v2/get_video_comments')
  for (const sort_by of ['top', 'newest']) {
    assert.equal(normalizeNativeForwardingRequest(key, { params: { video_id: 'dQw4w9WgXcQ', sort_by } }).upstreamQuery.sort_by, sort_by)
  }
  assert.throws(() => normalizeNativeForwardingRequest(key, { params: { video_id: 'dQw4w9WgXcQ', sort_by: 'latest' } }), { status: 400 })
  assert.throws(() => normalizeNativeForwardingRequest(key, { params: { video_id: 'dQw4w9WgXcQ', api_key: 'bad' } }), { status: 400 })
})

test('YouTube migration registers disabled procurement once and preserves operator changes', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control; CREATE TABLE control.external_platform_provider_price_books (
    provider_key text, version bigint, PRIMARY KEY(provider_key,version));
    INSERT INTO control.external_platform_provider_price_books VALUES ('tikhub',0);`)
  const original = await readFile(new URL('../../migrations/060_external_platform_operation_control.sql', import.meta.url), 'utf8')
  await db.exec(original.slice(original.indexOf('CREATE TABLE IF NOT EXISTS control.external_platform_operation_releases'),
    original.indexOf('CREATE OR REPLACE FUNCTION control.reject_external_platform_append_only_mutation')))
  const migration = await readFile(new URL('../../migrations/155_youtube_comments.sql', import.meta.url), 'utf8')
  await db.exec(migration); await db.exec(migration)
  assert.deepEqual((await db.query('SELECT provider_key,operation_key,desired_state,control_source FROM control.external_platform_operation_policies')).rows,
    [{ provider_key: 'tikhub', operation_key: 'native.t.api_4a6f21264dc0b4a1', desired_state: 'disabled', control_source: 'database' }])
  assert.equal((await db.query('SELECT * FROM control.external_platform_operation_policy_events')).rows.length, 1)
  await db.exec("UPDATE control.external_platform_operation_policies SET desired_state='paused',revision=2,updated_by='operator'")
  await db.exec(migration)
  assert.equal((await db.query('SELECT desired_state FROM control.external_platform_operation_policies')).rows[0].desired_state, 'paused')
  assert.equal((await db.query('SELECT * FROM control.external_platform_operation_policy_events')).rows.length, 1)
})

test('comment docs, product visibility and quotes require one matching platform/capability scope', () => {
  const granted = [{ platforms: ['youtube'], capabilities: [YOUTUBE_COMMENTS_CAPABILITY] }]
  const ungranted = [{ platforms: ['youtube'], capabilities: [] }, { platforms: ['xiaohongshu'], capabilities: [YOUTUBE_COMMENTS_CAPABILITY] }]
  for (const path of Object.values(YOUTUBE_COMMENT_PATHS)) {
    const short = path.slice('/api/v1'.length)
    assert.ok(PUBLIC_OPENAPI_DOCUMENT.paths[short].post.requestBody.content['application/json'].schema.additionalProperties === false)
    assert.ok(tenantOpenApiDocument(granted).paths[short])
    assert.equal(tenantOpenApiDocument(ungranted).paths[short], undefined)
    assert.deepEqual(servicePriceDefinition(path), { platform: 'youtube', capabilities: [YOUTUBE_COMMENTS_CAPABILITY], meterKey: YOUTUBE_COMMENTS_CAPABILITY })
  }
  assert.ok(productAllowed('/data-products/social-content', granted))
  assert.equal(productAllowed('/data-products/social-content', ungranted), false)
  assert.match(publicDocsHtmlForPath('/docs/social-content', { tenant: true, scopes: granted }), /\/api\/v1\/data\/youtube\/comments/)
  assert.ok(tenantOpenApiDocument(granted).paths['/data/services/pricing'])
  const inventory = implementedRoutes()
  assert.equal(inventory.filter(row => row.platform === 'youtube' && row.operation === YOUTUBE_COMMENTS_CAPABILITY).length, 2)
  assert.equal(inventory.some(row => row.path === '/api/v1/data/search' && row.provider === 'night-all'), false)
  const xhs = PROVISIONING_OPERATIONS.find(row => row.id === 'tikhub:social.comments.list')
  assert.equal(xhs.platform, 'xiaohongshu')
  assert.ok(!xhs.paths.some(path => Object.values(YOUTUBE_COMMENT_PATHS).includes(path)))
  assert.ok(!xhs.catalogKeys.includes('source-catalog-0089'))
  assert.ok(PROVISIONING_OPERATIONS.some(row => row.id === 'tikhub:native.t.api_4a6f21264dc0b4a1'))
})

test('worker accepts only reviewed YouTube comments and standard search acquisition tuples', () => {
  const payload = { kind: 'external-platform-result', providerKey: 'tikhub', platform: 'youtube', datasetId: 'social.comments.v1', records: [] }
  assert.equal(classifyExternalPlatformIngest(payload).hubRaw, true)
  for (const providerKey of ['night-all', 'rapidapi', 'justone']) assert.throws(() => classifyExternalPlatformIngest({ ...payload, providerKey }), /pinned contract/)
  for (const datasetId of ['social.comments.v2', 'enterprise.responses.v1']) assert.throws(() => classifyExternalPlatformIngest({ ...payload, datasetId }), /pinned contract/)
  for (const platform of ['bilibili', 'douyin', 'kuaishou', 'zhihu', 'reddit', 'youtube', 'tiktok']) {
    assert.equal(classifyExternalPlatformIngest({ ...payload, platform, datasetId: 'night-all.search.v1' }).hubRaw, true)
  }
})

test('both public comment routes authenticate, reject query injection and dispatch only their fixed kind', async t => {
  const store = new MemoryStore(), seen = []
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'youtube-http-test-at-least-32-bytes' })
  const tenant = await service.createTenant({ name: 'comments-test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'comments-test' })
  await store.setPlatformGrant(consumer.id, 'youtube', true)
  await service.putCapabilityConfiguration(YOUTUBE_COMMENTS_CAPABILITY, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'K', platforms: ['youtube'], capabilities: [YOUTUBE_COMMENTS_CAPABILITY] })
  const app = createApp({ service, store, adapter: {}, listenerMode: 'public', logger: { error() {} },
    socialAccountTikHubGateway: { async youtubeComments(context, input) {
      seen.push({ consumerId: context.consumer.id, kind: input.kind, path: input.path, body: input.body, idempotencyKey: input.idempotencyKey })
      return { status: 200, body: { data: { items: [] } }, replay: true, sourceMode: 'idempotent_replay', requestId: '11111111-1111-4111-8111-111111111111' }
    } },
  })
  const server = createServer(app)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'youtube-http-page-one' }
  for (const [kind, path] of Object.entries(YOUTUBE_COMMENT_PATHS)) {
    const body = kind === 'video' ? { videoId: 'dQw4w9WgXcQ', maxComments: 50 } : { channelUrl: 'https://www.youtube.com/@example', maxVideos: 5, maxComments: 50 }
    assert.equal((await fetch(base + path, { method: 'POST', body: JSON.stringify(body) })).status, 401)
    assert.equal((await fetch(base + path + '?provider=night-all', { method: 'POST', headers, body: JSON.stringify(body) })).status, 400)
    const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('idempotent-replay'), 'true')
    assert.equal(response.headers.get('x-mx-insight-source-mode'), 'idempotent_replay')
    assert.deepEqual(seen.at(-1), { consumerId: consumer.id, kind, path, body, idempotencyKey: headers['idempotency-key'] })
  }
  assert.equal(seen.length, 2)
})
