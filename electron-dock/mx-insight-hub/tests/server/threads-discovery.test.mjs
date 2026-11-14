import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createApp } from '../../server/app.mjs'
import { threadsSearchRecipe } from '../../server/contracts/threads-search.mjs'
import { StrategySearchRoutingStore } from '../../server/external-platforms/strategy-search-routing.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { publicDocsHtmlForPath, tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

test('Threads management saves from the browser client and public discovery follows the saved route without acquisition', async t => {
  const store = new MemoryStore(), routing = new StrategySearchRoutingStore()
  const rapid = `native.${threadsSearchRecipe('threads', 'rapidapi').key}`, tik = `native.${threadsSearchRecipe('threads', 'tikhub').key}`
  const checks = []
  const service = new HubService({ store, apiKeyPepper: 'threads-discovery-local-test-pepper', strategySearchRoutingStore: routing,
    externalDataSearch: () => assert.fail('discovery cannot dispatch'),
    externalNativeCapabilities: async ({ consumerId, operationKeys }) => {
      checks.push({ consumerId, operationKeys })
      return Object.fromEntries(operationKeys.map(key => [key, key === tik]))
    } })
  const tenant = await service.createTenant({ name: 'Offline Threads' }), consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Reader' })
  await store.setPlatformGrant(consumer.id, 'threads', true)
  await store.setPlatformGrant(consumer.id, 'twitter', true)
  const issueKey = (name, platforms, environment) => service.createApiKey({ consumerId: consumer.id, name, platforms, capabilities: [], environment })
  const key = await issueKey('Threads', ['threads'], 'live'), other = await issueKey('Other', ['twitter'], 'live')
  const testKey = await issueKey('Test', ['threads'], 'test')
  const adminToken = 'offline-test-admin'
  const server = createServer(createApp({ store, service, strategySearchRoutingStore: routing, adminToken, logger: { error() {} } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  const { outputFiles } = await build({ entryPoints: [fileURLToPath(new URL('../../src/api.js', import.meta.url))], bundle: true,
    platform: 'node', format: 'esm', write: false, define: { 'import.meta.env': JSON.stringify({ VITE_MX_INSIGHT_API_BASE: origin }) } })
  const { adminApi } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`)
  const discovery = async credential => {
    const response = await fetch(origin + '/api/v1/data/capabilities', { headers: { authorization: 'Bearer ' + credential.secret } })
    assert.equal(response.status, 200)
    return (await response.json()).data
  }
  const threads = data => data.platforms.find(row => row.platform === 'threads')
  const original = await discovery(key)
  assert.deepEqual(threads(original), { platform: 'threads', source: 'hub', servingMode: 'live_only', ready: false,
    search: { source: 'hub', servingMode: 'live_only', ready: false, contractVersion: 'night-all.data-search.v1' } })
  assert.equal(original.legacySearch, null)
  assert.equal(threads(await discovery(other)), undefined)
  assert.equal(threads(await discovery(testKey)).ready, false)
  assert.deepEqual(checks, [{ consumerId: consumer.id, operationKeys: ['native.r.threads_scraper_search_posts'] }])
  const policy = (mode, expectedRevision, primaryProvider = 'rapidapi') => ({
    mode, primaryProvider, fallbackProvider: null, expectedRevision, reason: 'Offline route verification',
  })
  for (const op of ['search', 'crawl', 'user-info', 'post-detail', 'post-comments', 'comment-replies']) {
    const update = await adminApi.updateCommentRoute(adminToken, op, 'threads', policy('paused', 1))
    assert.equal(update.mode, 'paused', op)
    assert.equal(update.revision, 2, op)
  }
  assert.equal(threads(await discovery(key)).ready, false)
  assert.equal(checks.length, 1, 'paused search does not check either operation')
  await adminApi.updateCommentRoute(adminToken, 'search', 'threads', policy('fixed', 2))
  assert.equal(threads(await discovery(key)).ready, false)
  assert.deepEqual(checks.at(-1).operationKeys, [rapid])
  await adminApi.updateCommentRoute(adminToken, 'search', 'threads', policy('fixed', 3, 'tikhub'))
  assert.equal(threads(await discovery(key)).ready, true)
  assert.deepEqual(checks.at(-1).operationKeys, [tik])
  await adminApi.updateCommentRoute(adminToken, 'search', 'threads', policy('fixed', 4, 'rapidapi-threads-scraper'))
  assert.equal(threads(await discovery(key)).ready, false, 'the new listing has its own readiness')
  assert.deepEqual(checks.at(-1).operationKeys, ['native.r.threads_scraper_search_posts'])
  assert.throws(() => adminApi.updateCommentRoute(adminToken, 'crawl', 'twitter', policy('paused', 1)))
  for (const op of ['crawl','user-info','post-detail']) {
    const updated = await adminApi.updateCommentRoute(adminToken, op, 'threads', policy('fixed', 2, 'rapidapi-threads-scraper'))
    assert.equal(updated.primaryProvider, 'rapidapi-threads-scraper')
  }
  assert.throws(() => adminApi.updateCommentRoute(adminToken, 'post-detail', 'twitter', policy('paused', 1)))
})

test('Threads tenant documentation describes only authorized standard and WeChat v1 contracts', () => {
  const threads = { platforms: ['threads'], capabilities: [] }
  const wechat = { platforms: ['social'], capabilities: ['native.wechat.search.search'] }
  const operation = scopes => tenantOpenApiDocument(scopes).paths['/data/search']?.post
  const schema = operation => operation.requestBody.content['application/json'].schema
  const doc = tenantOpenApiDocument([threads]), op = doc.paths['/data/search'].post
  assert.deepEqual(schema(op).properties.platform.enum, ['threads'])
  assert.equal(schema(op).additionalProperties, false)
  assert.equal(schema(op).properties.params, undefined)
  assert.equal(op.responses[200].content['application/json'].schema.$ref, '#/components/schemas/SearchEnvelope')
  assert.equal(doc.paths['/data/social/post-comments'], undefined)
  assert.equal(doc.paths['/data/social/crawl'], undefined)
  const guide = publicDocsHtmlForPath('/docs/strategy-search', { tenant: true, scopes: [threads] }).match(/<main>([\s\S]*?)<\/main>/)[1]
  assert.match(guide, /POST \/api\/v1\/data\/search/)
  assert.match(guide, /POST \/api\/v2\/data\/search/)
  assert.doesNotMatch(guide, /\/api\/v1\/search\/raw|微信搜索|\/api\/v1\/data\/social\/crawl/)
  assert.deepEqual(operation([wechat])['x-mx-required-capabilities'], ['native.wechat.search.search'])
  assert.deepEqual(schema(operation([threads, wechat])).oneOf.map(value => value.properties.platform.enum),
    [['threads'], ['wechat_search', 'wechat_mp', 'wechat', 'weixin']])
  assert.equal(operation([{ platforms: ['social'], capabilities: [] }, { platforms: ['twitter'], capabilities: wechat.capabilities }]), undefined)
  assert.equal(operation([{ platforms: ['instagram'], capabilities: [] }]), undefined)
  assert.equal(publicDocsHtmlForPath('/docs/strategy-search', { tenant: true, scopes: [] }), null)
})
