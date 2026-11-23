import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { normalizeJobRequest } from '../../server/collect/catalog.mjs'
import { nativeContract } from '../../server/collect/contracts/native.mjs'

const key = 'collect.ecommerce.shopify.search'
const sample = { domain: 'www.deathwishcoffee.com', keyword: 'coffee', maxItems: 1 }
const item = { id: 'gid://shopify/Product/263612097', title: 'Dark Roast Coffee', handle: 'death-wish-coffee',
  onlineStoreUrl: 'https://www.deathwishcoffee.com/products/death-wish-coffee', priceRange: { minVariantPrice: { amount: '19.99', currencyCode: 'USD' } } }
const publicAnswer = async () => [{ address: '93.184.215.14', family: 4 }]
const searchResponse = (nodes, hasNextPage, endCursor) => ({ data: { search: { nodes, pageInfo: { hasNextPage, endCursor } } } })
async function dispatch(input, fetchImpl, lookup = publicAnswer) {
  const { definition, item: job } = normalizeJobRequest({ capability: key, input })
  return (await nativeContract.dispatch({ job, definition, fetchImpl, deps: { lookup } })).outcome
}

test('Shopify search validates a bare shop hostname, bounded inputs and an opaque optional cursor', () => {
  const normalized = normalizeJobRequest({ capability: key, input: { domain: 'WWW.DeathWishCoffee.com', keyword: ' coffee ' } })
  assert.deepEqual(normalized.item.input, { ...sample, maxItems: 20 })
  assert.ok(normalized.definition.sync)
  for (const patch of [{ domain: '127.0.0.1' }, { domain: 'public.internal' }, { domain: 'store.com#fragment' },
    { domain: 'https://store.com' }, { domain: 'public.com/path' }, { maxItems: 51 }, { keyword: ' ' }, { after: 'a'.repeat(2049) }, { token: 'bad' }]) {
    assert.throws(() => normalizeJobRequest({ capability: key, input: { ...sample, ...patch } }), { code: 'invalid_collect_request' })
  }
})

test('Shopify dispatch queries products on the selected store and passes the cursor back to that same endpoint', async () => {
  const cursor = 'page-cursor-1='
  const seen = []
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body)
    assert.equal(url.href, 'https://www.deathwishcoffee.com/api/2026-10/graphql.json')
    assert.equal(init.method, 'POST')
    assert.equal(init.redirect, 'error')
    assert.ok(init.dispatcher)
    assert.deepEqual(Object.keys(init.headers).sort(), ['accept', 'content-type'])
    assert.match(request.query, /search\(query: \$keyword, types: \[PRODUCT\], first: \$first, after: \$after\)/)
    seen.push(request.variables)
    return Response.json(seen.length === 1 ? searchResponse([item], true, cursor) : searchResponse([], false, null))
  }
  const first = await dispatch(sample, fetchImpl)
  assert.deepEqual(first.result, { domain: sample.domain, keyword: sample.keyword, items: [item], pageInfo: { hasNextPage: true, endCursor: cursor } })
  assert.deepEqual([first.dataStatus, first.itemCount], ['success', 1])
  const next = await dispatch({ ...sample, after: first.result.pageInfo.endCursor }, fetchImpl)
  assert.deepEqual([next.status, next.dataStatus, next.itemCount], ['succeeded', 'no_data', 0])
  assert.deepEqual(seen, [{ keyword: 'coffee', first: 1, after: null }, { keyword: 'coffee', first: 1, after: cursor }])
})

test('private DNS answers and store failures do not become an empty or charged success', async () => {
  let calls = 0
  const blocked = await dispatch(sample, async () => { calls++ }, async () => [...await publicAnswer(), { address: '127.0.0.1', family: 4 }])
  assert.equal(calls, 0)
  assert.deepEqual([blocked.status, blocked.charge], ['failed', false])
  for (const response of [Response.json({}, { status: 429 }), Response.redirect('https://other.example.org'),
    Response.json({ errors: [{ message: 'Access denied' }], ...searchResponse([], false, null) }),
    new Response('<html>password protected</html>'), Response.json(searchResponse([{}], false, null)),
    Response.json(searchResponse([], true, null))]) {
    const outcome = await dispatch(sample, async () => response)
    assert.deepEqual([outcome.status, outcome.charge, outcome.result], ['failed', false, undefined])
  }
})

const pgModule = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
test('migration 196 adds the route once to an existing standard native engine and preserves operator routing', {
  skip: !pgModule && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for isolated PostgreSQL execution',
}, async t => {
  const { PGlite } = await import(pathToFileURL(pgModule).href)
  const db = new PGlite()
  t.after(() => db.close())
  const migration = filename => readFile(new URL(`../../migrations/${filename}.sql`, import.meta.url), 'utf8')
  await db.exec(await migration('183_collect_engines'))
  const install = await migration('196_collect_shopify_search')
  const routes = () => db.query('SELECT capability, engine_id FROM collect.routes ORDER BY capability')
  const engine = (id, kind) => db.query(`INSERT INTO collect.engines
    (id,kind,display_name,capacity,queue_limit,consumer_open_limit,queue_wait_ms,run_timeout_ms,updated_by,update_reason)
    VALUES ($1,$2,'test',1,5,1,60000,15000,'test','seed')`, [id, kind])
  await db.exec(install)
  await engine('native.main', 'runner')
  await db.exec(install)
  assert.deepEqual((await routes()).rows, [])
  await db.exec("UPDATE collect.engines SET kind = 'native' WHERE id = 'native.main'")
  await engine('native.other', 'native')
  await db.query("INSERT INTO collect.routes(capability, engine_id, updated_by) VALUES ($1,'native.other','operator')", [key])
  await db.exec(install)
  assert.deepEqual((await routes()).rows, [{ capability: key, engine_id: 'native.other' }])
  await db.query('DELETE FROM collect.routes WHERE capability = $1', [key])
  await db.exec(install)
  await db.exec(install)
  assert.deepEqual((await routes()).rows, [{ capability: key, engine_id: 'native.main' }])
  assert.deepEqual((await db.query("SELECT revision, enabled, billing_enabled FROM collect.engines WHERE id='native.main'")).rows,
    [{ revision: 1, enabled: false, billing_enabled: false }])
  assert.equal((await db.query('SELECT * FROM collect.engine_events')).rows.length, 1)
})
