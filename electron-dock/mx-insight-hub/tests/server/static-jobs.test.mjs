import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enqueueStaticMedia, archiveStaticMedia } from '../../server/external-platforms/static-jobs.mjs'
import { withStaticArchive } from '../../server/external-platforms/static-client.mjs'
import { buildJustOneResourceDispatch } from '../../server/contracts/justone-resources.mjs'
test('media jobs persist each distinct URL with tenant scope and never dispatch acquisition', async () => {
  const jobs = []
  await enqueueStaticMedia({ enqueue: (...args) => jobs.push(args) }, { consumerId: 'tenant', records: [{ stableFields: { media: { images: ['https://cdn/a', 'https://cdn/a', 'https://cdn/b'] } } }] })
  assert.equal(jobs.length, 2)
  assert.equal(jobs[0][0], 'static-media')
  assert.match(jobs[0][1].scope, /^[a-f0-9]{64}$/)
  let request
  await archiveStaticMedia(jobs[0][1], { baseUrl: 'http://static', token: 'private', fetchImpl: async (...args) => { request = args; return new Response('{}') } })
  assert.match(request[0], /\/static\/v1\/projects\/mx-insight-hub\/ingest$/)
  assert.equal(JSON.parse(request[1].body).mode, 'cache_first')
})
test('optional archive outage falls back to the existing media loader', async () => {
  const expected = { body: Buffer.from('test'), contentType: 'image/png' }
  let options
  const load = withStaticArchive(async (_, passed) => { options = passed; return expected }, { baseUrl: 'http://static', token: 'private', fetchImpl: async () => { throw Error('offline') } })
  assert.equal(await load('https://cdn/a', { cacheScope: 'tenant' }), expected)
  assert.equal(options.cacheScope, 'tenant')
})
test('shop pagination and sort match each upstream version', () => {
  const resource = 'taobao-tmall.shop-products'
  for (const [version, sort, ids] of [['v1', '_sale', { userId: '123' }], ['v2', 'sales-des', { userId: '123', shopId: '456' }]]) {
    const result = buildJustOneResourceDispatch(resource, { version, sort, page: 2, ...ids })
    assert.deepEqual(result.query, { ...ids, sort, page: 2 })
  }
  assert.throws(() => buildJustOneResourceDispatch(resource, { version: 'v1', userId: '123', sort: 'sales-des' }))
  assert.throws(() => buildJustOneResourceDispatch(resource, { version: 'v4', sellerId: '123', sort: '_sale' }))
})
test('durably accepted media does not fall back to a duplicate upstream request', async () => {
  let fallback = 0
  const load = withStaticArchive(async () => { fallback++; throw Error('should not run') }, {
    baseUrl: 'http://static', token: 'private', fetchImpl: async () => new Response('{"state":"queued"}', { status: 202 }),
  })
  await assert.rejects(load('https://cdn/a', { cacheScope: 'tenant' }), { status: 503, code: 'external_media_pending' })
  assert.equal(fallback, 0)
})
test('Hub memory cache is tenant scoped and expires back to the archive path', async () => {
  let calls = 0
  const value = { body: Buffer.from('bytes'), contentType: 'image/png' }
  const load = withStaticArchive(async () => { calls++; return value }, {
    baseUrl: 'http://static', token: 'private', cacheTtlMs: 20, fetchImpl: async () => { throw Error('offline') },
  })
  await load('https://cdn/a', { cacheScope: 'one' }); await load('https://cdn/a', { cacheScope: 'one' })
  assert.equal(calls, 1)
  await load('https://cdn/a', { cacheScope: 'two' }); assert.equal(calls, 2)
  await new Promise(resolve => setTimeout(resolve, 25))
  await load('https://cdn/a', { cacheScope: 'one' }); assert.equal(calls, 3)
})
