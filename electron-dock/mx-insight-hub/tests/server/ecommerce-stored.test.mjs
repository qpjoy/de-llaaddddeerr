import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { storedEcommerceQuery } from '../../server/contracts/ecommerce-stored.mjs'
const secret = 'stored-ecommerce-test-pepper-at-least-32'
function seed(store, consumerId, id, marketplace, count = 12) {
  store.requests.set(id, { id, consumerId, platform: 'ecommerce', status: 'committed', responseStatus: 200, createdAt: '2026-01-01T00:00:00.000Z', responseBody: { contractVersion: 'mx-insight-hub.ecommerce-products.v1', data: { items: Array.from({ length: count }, (_, index) => ({ id: `${index}`, marketplace, title: `相机 ${index}`, pricing: { current: String(index) }, images: ['https://example.com/a.jpg'] })) } } })
}
test('stored pagination exceeds ten items, preserves batch order and consumer isolation', async () => {
  const store = new MemoryStore()
  seed(store, 'owner', '00000000-0000-4000-8000-000000000001', 'taobao')
  seed(store, 'other', '00000000-0000-4000-8000-000000000002', 'xianyu')
  let query = storedEcommerceQuery({ pageSize: '5' }, 'owner', secret)
  let page = query.page(await store.listStoredEcommerceItems(query))
  assert.deepEqual(page.items.map(row => row.product.id), ['0', '1', '2', '3', '4'])
  const cursor = page.pageInfo.nextCursor
  for (const input of [{ marketplace: 'xianyu', pageSize: '5', cursor }, { pageSize: '6', cursor }, { pageSize: '5', cursor: cursor + 'x' }]) assert.throws(() => storedEcommerceQuery(input, 'owner', secret))
  assert.throws(() => storedEcommerceQuery({ pageSize: '5', cursor }, 'other', secret))
  query = storedEcommerceQuery({ pageSize: '5', cursor }, 'owner', secret)
  page = query.page(await store.listStoredEcommerceItems(query))
  assert.deepEqual(page.items.map(row => row.ordinal), [6, 7, 8, 9, 10])
  query = storedEcommerceQuery({ pageSize: '5', cursor: page.pageInfo.nextCursor }, 'owner', secret)
  page = query.page(await store.listStoredEcommerceItems(query))
  assert.equal(page.items.length, 2)
  assert.equal(page.pageInfo.nextCursor, null)
  assert.throws(() => storedEcommerceQuery({ refresh: 'true' }, 'owner', secret))
})
test('stored service enforces grants, meters reads and never calls an upstream adapter', async () => {
  const store = new MemoryStore()
  const service = new HubService({ store, apiKeyPepper: secret, adapter: new Proxy({}, { get() { throw new Error('upstream must not be touched') } }) })
  const tenant = await service.createTenant({ name: 'Stored test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Owner' })
  await service.putPlatformConfiguration('ecommerce', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Reader', platforms: ['ecommerce'] })
  const context = await service.authenticate(key.secret)
  seed(store, consumer.id, '00000000-0000-4000-8000-000000000003', 'xianyu')
  const result = await service.ecommerceStoredItems(context, { marketplace: 'all' })
  assert.equal(result.items.length, 10)
  assert.equal(result.sourceMode, 'stored_inventory')
  assert.equal([...store.requests.values()].filter(row => row.status === 'committed').length, 2)
  const denied = await service.createApiKey({ consumerId: consumer.id, name: 'No scope', platforms: [] })
  await assert.rejects(service.ecommerceStoredItems(await service.authenticate(denied.secret), {}), error => error.code === 'platform_not_granted')
})

test('PostgreSQL stored pagination preserves timestamp precision and ordinal boundaries', { skip: !process.env.MX_ECOMMERCE_TEST_DATABASE_URL }, async () => {
  const { default: pg } = await import('pg')
  const { PostgresStore } = await import('../../server/stores/postgres-store.mjs')
  const pool = new pg.Pool({ connectionString: process.env.MX_ECOMMERCE_TEST_DATABASE_URL, max: 1 })
  try {
    await pool.query('CREATE TEMP TABLE usage_requests (id uuid, consumer_id uuid, platform text, status text, response_status int, response_body jsonb, created_at timestamptz)')
    const owner = '00000000-0000-4000-8000-000000000099'
    const body = { contractVersion: 'mx-insight-hub.ecommerce-products.v1', data: { items: Array.from({ length: 12 }, (_, i) => ({ id: `${i}`, marketplace: 'taobao', pricing: {current:String(i)}, title: `相机 ${i}` })) } }
    await pool.query('INSERT INTO usage_requests VALUES ($1,$2,\'ecommerce\',\'committed\',200,$3,$4)', ['00000000-0000-4000-8000-000000000001', owner, body, '2026-01-01T00:00:00.123456Z'])
    const store = new PostgresStore(pool)
    let query = storedEcommerceQuery({ pageSize: '5' }, owner, secret)
    let result = query.page(await store.listStoredEcommerceItems(query))
    assert.equal(result.items.length, 5)
    assert.match(result.items[0].recordedAt, /123456/)
    query = storedEcommerceQuery({ pageSize: '5', cursor: result.pageInfo.nextCursor }, owner, secret)
    result = query.page(await store.listStoredEcommerceItems(query))
    assert.deepEqual(result.items.map(row => row.ordinal), [6,7,8,9,10])
    query = storedEcommerceQuery({ pageSize: '5', cursor: result.pageInfo.nextCursor }, owner, secret)
    result = query.page(await store.listStoredEcommerceItems(query))
    assert.deepEqual(result.items.map(row => row.ordinal), [11,12])
    assert.equal(result.pageInfo.nextCursor, null)
    query = storedEcommerceQuery({ minPrice:'3',maxPrice:'5',from:'2026-01-01T00:00:00Z',to:'2026-01-02T00:00:00Z' }, owner, secret)
    assert.deepEqual(query.page(await store.listStoredEcommerceItems(query)).items.map(row=>row.product.id), ['3','4','5'])
  } finally { await pool.end() }
})

test('history filters bind cursor and preserve media provenance', async () => {
  const store = new MemoryStore()
  seed(store, 'owner', '00000000-0000-4000-8000-000000000001', 'taobao')
  const input = { marketplace: 'taobao', minPrice: '3', maxPrice: '8', from: '2025-12-31T00:00:00Z', to: '2026-01-02T00:00:00Z', pageSize: '2' }
  const query = storedEcommerceQuery(input, 'owner', secret)
  const page = query.page(await store.listStoredEcommerceItems(query))
  assert.deepEqual(page.items.map(row => row.product.id), ['3','4'])
  assert.equal(page.items[0].media[0].externalFeeStatus, 'unknown')
  assert.equal(page.items[0].media[0].originalUrl, 'https://example.com/a.jpg')
  for (const changed of [{ minPrice: '4' }, { to: '2026-01-03T00:00:00Z' }])
    assert.throws(() => storedEcommerceQuery({ ...input, ...changed, cursor: page.pageInfo.nextCursor }, 'owner', secret))
  const outside = storedEcommerceQuery({ from: '2026-02-01T00:00:00Z' }, 'owner', secret)
  assert.equal((await store.listStoredEcommerceItems(outside)).length, 0)
})
