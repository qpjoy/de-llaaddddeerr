import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { ecommerceRoutingCatalog, EcommerceRoutingStore } from '../../server/external-platforms/ecommerce-routing.mjs'
import { justOneProductAdapterId, normalizeJustOneProductSearchRequest } from '../../server/contracts/justone.mjs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { productEndpoints, productForPath } from '../../shared/product-workbenches.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

test('routing catalog separates native contracts from current compatible search adapters', () => {
  const { items } = ecommerceRoutingCatalog()
  assert.equal(items.filter(row => row.defaultRoute).length, 6)
  assert.ok(items.filter(row => row.defaultRoute).every(row => row.defaultRoute.provider === 'justone'))
  const kuaishou = items.find(row => row.marketplace === 'kuaishou_ec')
  assert.equal(kuaishou.defaultRoute, null)
  assert.equal(kuaishou.switchable, false)
  assert.equal(kuaishou.endpoints.length, 2)
  assert.ok(kuaishou.endpoints.every(row => row.provider === 'tikhub'))
  assert.equal(items.find(row => row.marketplace === 'pinduoduo').endpoints.length, 0)
  assert.ok(items.find(row => row.marketplace === 'taobao').endpoints.some(row => row.upstreamPath.endsWith('/v2')))
})

test('only explicitly granted Kuaishou commerce endpoints enter tenant ecommerce product/docs', () => {
  const key = 't.kuaishou_ecommerce_shopping_top_list'
  const document = tenantOpenApiDocument([{ platforms: ['ecommerce'], capabilities: [`native.${key}`] }])
  const product = productForPath('/data-products/ecommerce-treasure-box')
  const rows = productEndpoints(document, product)
  assert.deepEqual(rows.map(row => row.path), [`/api/v1/data/native/${key}`])
  assert.equal(rows[0]['x-mx-category'], '快手电商')
  const denied = tenantOpenApiDocument([{ platforms: ['social'], capabilities: [`native.${key}`] }])
  assert.equal(productEndpoints(denied, product).length, 0)
})

test('supplier routing inventory is admin-only and performs no acquisition', async t => {
  const store = new MemoryStore()
  const routing = new EcommerceRoutingStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'ecommerce-routing-fixture-pepper-long-enough' })
  const server = createServer(createApp({ store, service, adapter: {}, ecommerceRoutingStore: routing, adminToken: 'fixture-admin', listenerMode: 'admin', logger: { error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/internal/v1/admin/ecommerce-routing`
  assert.equal((await fetch(url)).status, 401)
  const options = { headers: { authorization: 'Bearer fixture-admin' } }
  const response = await fetch(url, options)
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data, await routing.catalog())
  assert.equal((await fetch(`${url}?provider=tikhub`, options)).status, 400)
  const save = body => fetch(`${url}/jd`, { method: 'PUT', headers: { ...options.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const change = { adapterId: justOneProductAdapterId('jd'), expectedRevision: 1, reason: 'Confirm the reviewed default' }
  assert.equal((await save(change)).status, 200)
  assert.equal((await save(change)).status, 409)
  assert.equal((await save({ ...change, expectedRevision: 2, adapterId: 'native.t.kuaishou_ecommerce_shopping_top_list' })).status, 400)
  assert.equal(routing.events.length, 1)
  assert.equal(store.requests.size, 0)
})

test('old and new cursors remain on the original product adapter when the default changes', () => {
  const body = { marketplace: 'jd', query: '手机' }
  const original = normalizeJustOneProductSearchRequest(body)
  const state = { version: 1, marketplace: 'jd', page: 2, scope: original.cursorScope, continuation: null }
  for (const saved of [state, { ...state, adapterId: original.adapterId }]) {
    const next = normalizeJustOneProductSearchRequest({ ...body, cursor: 'fixture' }, {
      decodeCursor: () => saved, defaultAdapterId: 'future-default',
    })
    assert.equal(next.adapterId, original.adapterId)
    assert.equal(next.endpointPath, original.endpointPath)
  }
  assert.throws(() => normalizeJustOneProductSearchRequest(body, { defaultAdapterId: 'native.t.example' }), { code: 'unsupported_product_adapter' })
  assert.throws(() => normalizeJustOneProductSearchRequest({ ...body, adapterId: original.adapterId }), { code: 'unsupported_request_field' })
})

test('PostgreSQL default routes are revisioned and audited atomically', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  await db.exec(await readFile(new URL('../../migrations/148_ecommerce_product_routes.sql', import.meta.url), 'utf8'))
  await db.exec(await readFile(new URL('../../migrations/167_ecommerce_supplier_routes.sql', import.meta.url), 'utf8'))
  const pool = { query: (sql, values) => db.query(sql, values), connect: async () => ({ query: (sql, values) => db.query(sql, values), release() {} }) }
  const store = new EcommerceRoutingStore(pool)
  assert.equal((await store.list()).length, 6)
  const adapterId = await store.select('jd')
  const update = { adapterId, expectedRevision: 1, reason: 'Fixture change' }
  assert.equal((await store.update('jd', update)).revision, 2)
  await assert.rejects(store.update('jd', update), { code: 'ecommerce_route_revision_conflict' })
  // Force the audit insert to fail: the configuration update must roll back.
  await db.exec(`ALTER TABLE control.ecommerce_product_route_events ADD CHECK (revision < 3)`)
  await assert.rejects(store.update('jd', { ...update, expectedRevision: 2 }))
  assert.equal((await store.list()).find(row => row.marketplace === 'jd').revision, 2)
  assert.equal((await db.query('SELECT count(*)::int AS n FROM control.ecommerce_product_route_events')).rows[0].n, 7)
})

test('Kuaishou migration seeds disabled operations without overwriting reviewed states or prices', { skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  const schema = await readFile(new URL('../../migrations/060_external_platform_operation_control.sql', import.meta.url), 'utf8')
  await db.exec('CREATE SCHEMA control')
  await db.exec(schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS control.external_platform_provider_price_books'),
    schema.indexOf('CREATE OR REPLACE FUNCTION control.reject_external_platform_append_only_mutation')))
  await db.exec(`INSERT INTO control.external_platform_provider_price_books(provider_key,version,source,status)
    VALUES('tikhub',0,'legacy_environment','inherited');
    INSERT INTO control.external_platform_provider_price_book_entries(provider_key,price_book_version,endpoint_key,unit_cost_minor)
    VALUES('tikhub',0,'native.t.api_382901fb0fa68660',7)`)
  const migration = await readFile(new URL('../../migrations/147_kuaishou_ecommerce.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  assert.deepEqual((await db.query('SELECT desired_state FROM control.external_platform_operation_policies')).rows.map(row => row.desired_state), ['disabled', 'disabled'])
  await db.exec(`UPDATE control.external_platform_operation_policies SET desired_state='paused',revision=2,updated_by='fixture-admin'
    WHERE operation_key='native.t.kuaishou_ecommerce_shopping_top_list'`)
  await db.exec(migration)
  assert.equal((await db.query(`SELECT desired_state FROM control.external_platform_operation_policies
    WHERE operation_key='native.t.kuaishou_ecommerce_shopping_top_list'`)).rows[0].desired_state, 'paused')
  assert.equal((await db.query('SELECT count(*)::int AS n FROM control.external_platform_operation_policy_events')).rows[0].n, 2)
  assert.deepEqual((await db.query('SELECT unit_cost_minor::int AS price FROM control.external_platform_provider_price_book_entries')).rows, [{ price: 7 }])
})
