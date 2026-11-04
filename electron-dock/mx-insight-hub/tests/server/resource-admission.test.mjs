import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { ResourceAdmission, RESOURCE_DEFAULTS } from '../../server/core/resource-admission.mjs'
import { ResourcePolicy } from '../../server/core/resource-policy.mjs'
import { resourceCatalog } from '../../server/core/resource-catalog.mjs'
import { PUBLIC_OPENAPI_DOCUMENT } from '../../server/public-docs.mjs'
const LCY = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
const resources = resourceCatalog(PUBLIC_OPENAPI_DOCUMENT)
const limits = { maxConcurrency: 2, maxKeyConcurrency: 1, requestsPerSecond: 10, keyRequestsPerSecond: 5 }
function setup() {
  let now = 0
  const policy = new ResourcePolicy({ catalog: resources.catalog })
  const admission = new ResourceAdmission({ policy, classify: resources.classify, clock: () => now })
  return { policy, admission, tick: ms => { now += ms }, enter: (keyId = LCY, pathname = '/api/v1/data/wechat/self-hosted/jobs') => admission.acquire({ method: 'POST', pathname, keyId }) }
}
const save = (policy, config) => policy.save({ expectedRevision: policy.value.revision, defaults: RESOURCE_DEFAULTS, rules: [], reason: 'Resource protection', ...config }, { actor: 'admin-token', requestId: randomUUID() })

test('all keys, including exempt LCY, obey independently scoped product and API protection', async () => {
  const f = setup(), target = resources.classify('POST', '/api/v1/data/wechat/self-hosted/jobs')
  await save(f.policy, { rules: [{ id: randomUUID(), kind: 'product', target: target.product, keyId: '*', limits }] })
  const first = f.enter()
  assert.throws(() => f.enter(), { code: 'resource_admission_limited' })
  const other = f.enter(randomUUID())
  assert.throws(() => f.enter(randomUUID()), error => error.details.reason === 'concurrency')
  const unrelated = f.enter(LCY, '/api/v1/data/search'); unrelated()
  first(); first(); other()
  assert.equal(f.admission.snapshot().active, 0)
  await save(f.policy, { rules: [{ id: randomUUID(), kind: 'api', target: target.api, keyId: LCY, limits }] })
  const a = f.enter(), b = f.enter('ordinary'), c = f.enter('ordinary')
  assert.throws(() => f.enter(), { code: 'resource_admission_limited' })
  a(); b(); c()
})

test('token bucket refills, rejections do not debit unrelated counters, busy updates preserve active slots', async () => {
  const f = setup()
  await save(f.policy, { defaults: { ...limits, keyRequestsPerSecond: 2 } })
  const first = f.enter()
  for (let i = 0; i < 10; i++) assert.throws(() => f.enter())
  first(); f.enter()()
  assert.throws(() => f.enter(), error => error.details.reason === 'rate' && error.details.retryAfterMs === 500)
  f.tick(500); const active = f.enter()
  await save(f.policy, { defaults: { ...limits, keyRequestsPerSecond: 2 } })
  assert.throws(() => f.enter(), error => error.details.reason === 'concurrency')
  active(); f.tick(1000); f.enter()()
  assert.equal(f.admission.snapshot().active, 0)
})

test('catalog normalizes paths and dynamic IDs, keeps login/payments outside resource protection', () => {
  for (const path of ['/auth/sso/login', '/api/v1/usage', '/internal/v1/admin/data-pressure', '/health/ready']) assert.equal(resources.classify('GET', path), null)
  const a = resources.classify('GET', '/api/v1/data/wechat/self-hosted/jobs/123')
  const b = resources.classify('GET', '/api/v1//data/wechat/self-hosted/jobs/456/')
  assert.deepEqual(a, b)
  assert.equal(resources.classify('POST', '/api/v1/search/crawl').api, 'POST /api/v1/search/crawl')
  assert.equal(resources.catalog.apis.some(row => row.id.includes('{operation}')), false)
  assert.equal(resources.classify('POST', '/api/v1/night-all/search/crawl').product, '/data-products/strategy-search')
  assert.equal(resources.classify('POST', '/api/v2/data/search').product, '/data-products/strategy-search')
  assert.equal(resources.classify('POST', '/api/v1/data/native/j.facebook_post_search_v1').product, '/data-products/social-content')
})

test('policy saves require admin, revision, valid bounds and registered scopes', async () => {
  const f = setup()
  await assert.rejects(f.policy.save({}, { actor: 'launcher-user' }), { status: 403 })
  await assert.rejects(save(f.policy, { defaults: { ...limits, maxKeyConcurrency: 3 } }), { status: 400 })
  await assert.rejects(save(f.policy, { rules: [{ id: randomUUID(), kind: 'api', target: 'arbitrary', keyId: '*', limits }] }), { status: 400 })
  await save(f.policy, {})
  await assert.rejects(save(f.policy, { expectedRevision: 0 }), { status: 409 })
  assert.equal(f.policy.events.length, 1)
})

test('cached policy adds no database calls per admission, fails closed on stale snapshots, refresh is single-flight', async () => {
  let reads = 0, now = 1, fail = false
  const pool = { async query() { reads++; if (fail) throw Error('db offline'); return { rows: [{ revision: 0, configuration: { defaults: RESOURCE_DEFAULTS, rules: [] } }] } } }
  const policy = new ResourcePolicy({ pool, catalog: resources.catalog, clock: () => now })
  try {
    await policy.refresh()
    const initial = reads, admission = new ResourceAdmission({ policy, classify: resources.classify })
    for (let i = 0; i < 50; i++) admission.acquire({ method: 'POST', pathname: '/api/v1/data/search', keyId: LCY })()
    assert.equal(reads, initial)
    await Promise.all([policy.refresh(), policy.refresh(), policy.refresh()]); assert.equal(reads, initial + 1)
    fail = true; now += 31000
    assert.throws(() => policy.current(), { code: 'resource_policy_unavailable' })
    await assert.rejects(policy.refresh())
    fail = false; await policy.refresh(); assert.equal(policy.current().revision, 0)
  } finally { policy.close() }
})

const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('PostgreSQL migration, CAS, readback and immutable audit', { skip: !modulePath }, async t => {
  const { PGlite } = await import(pathToFileURL(modulePath).href), db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  await db.exec(await readFile(new URL('../../migrations/171_resource_admission.sql', import.meta.url), 'utf8'))
  const client = { query: (...args) => db.query(...args), release() {} }
  const pool = { query: client.query, async connect() { return client } }
  const policy = new ResourcePolicy({ pool, catalog: resources.catalog }); t.after(() => policy.close())
  await policy.refresh()
  const saved = await save(policy, { defaults: limits })
  assert.equal(saved.revision, 1); assert.deepEqual(saved.defaults, limits)
  await assert.rejects(save(policy, { expectedRevision: 0 }), { status: 409 })
  assert.equal((await db.query('SELECT count(*)::int AS n FROM control.resource_admission_events')).rows[0].n, 1)
  await assert.rejects(db.query('DELETE FROM control.resource_admission_events'), /immutable/)
})
