import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { loadConfig } from '../../server/config.mjs'
import { createRuntime } from '../../server/index.mjs'
import { normalizeThreadsPostDetail, THREADS_POST_DETAIL_PATH, THREADS_POST_DETAIL_CAPABILITY } from '../../server/contracts/threads-post-detail.mjs'
import { tenantOpenApiDocument, publicDocsHtmlForPath } from '../../server/public-docs.mjs'
import { servicePriceDefinition } from '../../server/contracts/service-pricing.mjs'
import sample from '../fixtures/threads-scraper-live-shapes.json' with { type: 'json' }

const post = sample.detail.data.post
const url = `https://www.threads.com/@${post.username}/post/${post.code}`
const body = { platform: 'threads', contentId: post.id }
const capability = THREADS_POST_DETAIL_CAPABILITY
const shortPath = THREADS_POST_DETAIL_PATH.slice('/api/v1'.length)

test('Threads detail request identity is shared by the two channels and grant-scoped docs', () => {
  const request = normalizeThreadsPostDetail(body)
  assert.equal(request.code, post.code)
  assert.deepEqual(normalizeThreadsPostDetail({ platform: 'threads', url }), request)
  assert.deepEqual(normalizeThreadsPostDetail({ platform: 'threads', contentId: post.code }), request)
  for (const invalid of [null, { ...body, platform: 'instagram' }, { ...body, url }, { ...body, code: 'inject' },
    { ...body, contentId: 123 }, { ...body, contentId: '18446744073709551616' }, { platform: 'threads', url: 'https://other.test/@test/post/' + post.code }]) {
    assert.throws(() => normalizeThreadsPostDetail(invalid), { status: 400 })
  }
  const scopes = [{ platforms: ['threads'], capabilities: [capability] }]
  const path = tenantOpenApiDocument(scopes).paths[shortPath].post
  assert.equal(path.responses[200].content['application/json'].schema.properties.data.properties.item.$ref, '#/components/schemas/SearchItem')
  assert.deepEqual(servicePriceDefinition(THREADS_POST_DETAIL_PATH), { platform: 'threads', capabilities: [capability], meterKey: capability })
  assert.equal(tenantOpenApiDocument([{ platforms: ['threads'], capabilities: [] }, { platforms: [], capabilities: [capability] }]).paths[shortPath], undefined)
  assert.match(publicDocsHtmlForPath('/docs/strategy-search', { tenant: true, scopes }), /POST \/api\/v1\/data\/social\/post-detail/)
})

test('public Threads detail delivers one priced call on the selected host and replays across a switch or pause', async t => {
  const credential = 'local-fixture-threads-post-detail'
  const hub = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'local-fixture-pepper-for-threads-detail-tests', MX_INSIGHT_RAPIDAPI_API_KEY: credential }))
  t.after(async () => { hub.agent.close(); await hub.store.close() })
  const server = createServer(hub.app)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const gateway = hub.threadsGateways.rapidapi, calls = []
  let mismatch = false
  gateway.adapter = new RapidApiAdapter({ apiKey: credential, fetchImpl: async address => {
    calls.push(address.href)
    if (address.pathname === '/api/v1/posts/detail') return Response.json(address.searchParams.get('code') === post.code
      ? sample.detail : { status: 'error', data: null })
    const original = sample.feed.data.posts[0].node.thread_items[0].post
    return Response.json({ status: 'ok', data: { containing_thread: { thread_items: [
      { post: mismatch ? { ...original, pk: '27', id: '27' } : original },
    ] } } })
  } })
  // The memory runtime supplies credentials through the injected adapters.
  hub.threadsNativeGateway.adapter = gateway.adapter
  const originalKey = 'native.r.threads_post_detail', scraperKey = 'native.r.threads_scraper_post_detail'
  for (const [key, price] of [[originalKey, 2], [scraperKey, 3]]) await hub.externalPlatformControlStore.updatePolicy('rapidapi', key, {
    expectedRevision: 1, desiredState: 'active', reason: 'Local test',
    priceBook: { currency: 'USD', pricingAsOf: '2026-11-13T00:00:00Z', monthlyBudgetMinor: 100, monthlySubsidyBudgetMinor: 100,
      unitCostMinorByEndpoint: { [key]: price } },
  }, { runtime: { config: gateway.config, credentialConfigured: true } })
  const tenant = await hub.service.createTenant({ name: 'Local detail' }), consumer = await hub.service.createConsumer({ tenantId: tenant.id, name: 'Detail fixture' })
  await hub.store.setPlatformGrant(consumer.id, 'threads', true)
  await hub.service.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const issue = (name, caps) => hub.service.createApiKey({ consumerId: consumer.id, name, platforms: ['threads'], capabilities: caps })
  const key = await issue('Granted', [capability]), missing = await issue('Platform only', [])
  const discover = async token => (await hub.service.capabilities(await hub.service.authenticate(token.secret))).data
  const capabilities = await discover(key)
  assert.equal(capabilities.platforms.find(row => row.platform === 'threads').postDetail.ready, true)
  assert.equal(capabilities.capabilities.find(row => row.capability === capability).ready, true)
  assert.equal((await discover(missing)).platforms.find(row => row.platform === 'threads').postDetail, undefined)
  const send = async (payload, id, token = key) => {
    const resp = await fetch(`http://127.0.0.1:${server.address().port}${THREADS_POST_DETAIL_PATH}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': token.secret, 'idempotency-key': id }, body: JSON.stringify(payload) })
    return { status: resp.status, replay: resp.headers.get('idempotent-replay'), body: await resp.json() }
  }
  const change = (mode, expectedRevision) => hub.strategySearchRoutingStore.update('post-detail', 'threads', {
    mode, primaryProvider: 'rapidapi', fallbackProvider: null, expectedRevision, reason: 'Local test',
  })
  assert.equal((await send(body, 'detail-without-scope', missing)).status, 403)
  assert.equal((await send({ ...body, url }, 'detail-invalid-input')).status, 400)
  assert.equal(calls.length, 0)
  const delivered = await send(body, 'detail-scraper-attempt')
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body))
  assert.equal(delivered.body.data.item.externalId, post.id)
  assert.equal(delivered.body.data.item.text, post.text)
  assert.equal(delivered.body.data.item.metrics.likes, 0)
  assert.equal(delivered.body.data.item.metrics.comments, null)
  assert.equal(calls[0], 'https://threads-scraper.p.rapidapi.com/api/v1/posts/detail?code=' + post.code)
  await change('fixed', 1)
  const replay = await send({ platform: 'threads', url }, 'detail-scraper-attempt')
  assert.equal(replay.replay, 'true')
  assert.deepEqual(replay.body, delivered.body)
  const original = await send(body, 'detail-original-attempt')
  assert.equal(original.status, 200, JSON.stringify(original.body))
  assert.equal(original.body.data.item.externalId, post.id)
  assert.deepEqual(calls.slice(1), ['https://threads-api4.p.rapidapi.com/api/post/detail?post_id=' + post.id])
  assert.deepEqual([...gateway.platformStore.calls.values()].map(call => [call.operation, call.costMinor]), [[scraperKey, 3], [originalKey, 2]])
  mismatch = true
  const bad = await send(body, 'detail-mismatched-post')
  assert.equal(bad.status, 502)
  assert.equal([...gateway.platformStore.calls.values()].at(-1).outcome, 'succeeded_unusable')
  await change('paused', 2)
  assert.equal((await discover(key)).platforms.find(row => row.platform === 'threads').postDetail.ready, false)
  const paused = await send(body, 'detail-paused-attempt')
  assert.equal(paused.status, 503)
  assert.equal(paused.body.error.code, 'threads_acquisition_paused')
  assert.deepEqual((await send(body, 'detail-scraper-attempt')).body, delivered.body)
  assert.equal(calls.length, 3)
  await hub.strategySearchRoutingStore.update('post-detail', 'threads', {
    mode: 'fixed', primaryProvider: 'rapidapi-threads-scraper', fallbackProvider: null, expectedRevision: 3, reason: 'Restore local default',
  })
  const rejected = await send({ platform: 'threads', contentId: 'BBBBB' }, 'detail-business-rejection')
  assert.equal(rejected.status, 502)
  assert.equal(rejected.body.error.code, 'social_upstream_rejected')
  assert.equal([...gateway.platformStore.calls.values()].at(-1).outcome, 'rejected')
  assert.equal(calls.length, 4)
})
