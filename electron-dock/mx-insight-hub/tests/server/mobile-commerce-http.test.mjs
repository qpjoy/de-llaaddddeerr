import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'mobile-commerce-http-admin-token'
const PEPPER = 'mobile-commerce-http-pepper-with-enough-entropy'
const RECORD_ID = '11111111-1111-4111-8111-111111111111'
const UNKNOWN_CATALOG_ID = '00000000-0000-4000-8000-000000000099'
const PRIVATE_VALUES = [
  'raw-row-must-not-leak',
  'metadata-must-not-leak',
  'device-must-not-leak',
]

async function call(baseUrl, path, { headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers })
  return { response, payload: await response.json() }
}

function mobileRow(catalogEntry) {
  return {
    id: RECORD_ID,
    external_id: 'capture-4',
    title: '安全回退标题',
    author_name: '安全回退店铺',
    collected_at: new Date('2026-08-19T00:03:25.000Z'),
    sort_time: new Date('2026-08-19T00:03:25.000Z'),
    current_revision: 3,
    raw_payload: { secret: PRIVATE_VALUES[0] },
    metadata_json: { secret: PRIVATE_VALUES[1] },
    device_serial: PRIVATE_VALUES[2],
    is_reported: true,
    stable_fields: {
      commerce: {
        captureId: 'capture-4',
        task: { id: '7', keyword: '老爸评测', sourceBrandLabel: '日常监测' },
        product: {
          goodsId: null,
          title: '清洁剂',
          shareText: '手机 App 商品分享文案',
          price: '29.90',
          resolution: 'capture-only',
        },
        shop: { id: null, name: '测试小店', shareText: '店铺分享文案', level: null },
        signals: { sales: '100+', shipFrom: '杭州', commentCount: '8', goodRate: '98%' },
        marketplace: {
          status: 'mapped',
          sourceValue: '快手小店',
          entryId: catalogEntry.id,
          sourceKey: catalogEntry.sourceKey,
          revision: catalogEntry.revision,
          canonicalName: catalogEntry.canonicalName,
          majorCategory: catalogEntry.majorCategory,
          scenarios: catalogEntry.scenarios,
          regions: catalogEntry.regions,
        },
        metadata: { secret: PRIVATE_VALUES[1] },
        deviceSerial: PRIVATE_VALUES[2],
        isReported: true,
      },
    },
  }
}

async function createConsumerFixture(service, tenant, name, platforms = []) {
  const consumer = await service.createConsumer({ tenantId: tenant.id, name })
  const key = await service.createApiKey({ consumerId: consumer.id, name: `${name} key` })
  for (const platform of platforms) {
    await service.putPlatformConfiguration(platform, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 100,
      windowSeconds: 3_600,
      maxPageSize: 50,
    })
  }
  return { consumer, key }
}

test('mobile-commerce and catalog-item HTTP reads enforce grants, stored-only execution and safe projections', async () => {
  const store = new MemoryStore()
  const catalogEntries = await store.listSourceCatalogEntries()
  const target = catalogEntries.find((entry) => entry.canonicalName === '快手小店')
  const archived = catalogEntries.find((entry) => entry.canonicalName === '淘宝')
  assert.ok(target)
  assert.ok(archived)
  await store.archiveSourceCatalogEntry(archived.id, {
    expectedRevision: archived.revision,
    actor: 'test',
  })
  await store.createExternalSource({
    sourceKey: 'mobile-commerce-collected-items',
    displayName: '手机多平台采集数据',
    sourceKind: 'database',
    datasetId: 'mobile-commerce.collected-items.v1',
    platform: 'mobile_commerce',
    objectType: 'commerce_capture',
    status: 'active',
    connection: {
      schema: 'public',
      table: 'mb_collected_items',
      cursorColumn: 'collected_at',
      idColumn: 'id',
    },
    syncIntervalSeconds: 300,
  })

  const storeQueries = []
  store.listMobileCommerceItems = async (query) => {
    storeQueries.push(query)
    return [mobileRow(target), mobileRow(target), mobileRow(target)]
  }
  const adapterCalls = []
  const adapter = {
    async capabilities(platforms) {
      adapterCalls.push(platforms)
      return { data: { platforms: [], legacySearch: null } }
    },
    async dependencies() {
      return { status: 'up' }
    },
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Mobile-commerce HTTP tenant' })
  const noGrant = await createConsumerFixture(service, tenant, 'No grant')
  const sourceOnly = await createConsumerFixture(service, tenant, 'Source only', ['source_catalog'])
  const mobileOnly = await createConsumerFixture(service, tenant, 'Mobile only', ['mobile_commerce'])
  const full = await createConsumerFixture(
    service,
    tenant,
    'Catalog and mobile',
    ['source_catalog', 'mobile_commerce'],
  )

  const server = createServer(createApp({
    service,
    store,
    adapter,
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const apiHeaders = (fixture) => ({ authorization: `Bearer ${fixture.key.secret}` })
  try {
    const anonymous = await call(baseUrl, '/api/v1/data/mobile-commerce/items')
    assert.equal(anonymous.response.status, 401)
    assert.equal(anonymous.payload.error.code, 'api_key_required')

    for (const fixture of [noGrant, sourceOnly]) {
      const forbidden = await call(baseUrl, '/api/v1/data/mobile-commerce/items', {
        headers: apiHeaders(fixture),
      })
      assert.equal(forbidden.response.status, 403)
      assert.equal(forbidden.payload.error.code, 'platform_not_granted')
    }

    const params = new URLSearchParams({
      sourcePlatform: '快手小店',
      keyword: '老爸评测',
      brand: '日常监测',
      taskId: '7',
      from: '2026-08-19T00:00:00+08:00',
      to: '2026-08-20T00:00:00+08:00',
      pageSize: '25',
      refresh: 'stored',
    })
    const direct = await call(baseUrl, `/api/v1/data/mobile-commerce/items?${params}`, {
      headers: apiHeaders(mobileOnly),
    })
    assert.equal(direct.response.status, 200)
    const serialized = JSON.stringify(direct.payload)
    assert.equal(direct.payload.data.sourceMode, 'stored')
    assert.deepEqual(direct.payload.data.acquisition, {
      remoteFetchAvailable: false,
      remoteFetchStatus: 'reserved',
      executionPlane: 'external-mobile-collector',
      hubRole: 'asynchronous-trigger-and-data-api',
      plannedMode: 'asynchronous-command',
    })
    assert.equal(direct.payload.data.scope.authorizationPlatform, 'mobile_commerce')
    assert.equal(direct.payload.data.items[0].marketplace.catalogEntryId, target.id)
    assert.equal('shareText' in direct.payload.data.items[0].product, false)
    assert.equal('shareText' in direct.payload.data.items[0].shop, false)
    assert.equal(serialized.includes('手机 App 商品分享文案'), false)
    assert.equal(serialized.includes('店铺分享文案'), false)
    assert.deepEqual(storeQueries[0], {
      sourcePlatform: '快手小店',
      catalogEntryId: null,
      keyword: '老爸评测',
      brand: '日常监测',
      taskId: '7',
      from: '2026-08-18T16:00:00.000Z',
      to: '2026-08-19T16:00:00.000Z',
      pageSize: 25,
      cursor: null,
    })
    for (const secret of PRIVATE_VALUES) assert.equal(serialized.includes(secret), false, secret)
    for (const field of ['raw_payload', 'metadata_json', 'device_serial', 'is_reported']) {
      assert.equal(serialized.includes(field), false, field)
    }

    const callsBeforeRemote = storeQueries.length
    const remote = await call(baseUrl, '/api/v1/data/mobile-commerce/items?refresh=remote', {
      headers: apiHeaders(mobileOnly),
    })
    assert.equal(remote.response.status, 409)
    assert.equal(remote.payload.error.code, 'remote_fetch_unavailable')
    assert.deepEqual(remote.payload.error.details, {
      supported: ['stored'],
      remoteFetchAvailable: false,
    })
    assert.equal(storeQueries.length, callsBeforeRemote)

    const missingMobileGrant = await call(
      baseUrl,
      `/api/v1/data/source-catalog/${target.id}/items`,
      { headers: apiHeaders(sourceOnly) },
    )
    assert.equal(missingMobileGrant.response.status, 403)
    assert.equal(missingMobileGrant.payload.error.code, 'platform_not_granted')

    const missingCatalogGrant = await call(
      baseUrl,
      `/api/v1/data/source-catalog/${target.id}/items`,
      { headers: apiHeaders(mobileOnly) },
    )
    assert.equal(missingCatalogGrant.response.status, 403)
    assert.equal(missingCatalogGrant.payload.error.code, 'platform_not_granted')

    const catalogItems = await call(
      baseUrl,
      `/api/v1/data/source-catalog/${target.id}/items?keyword=%E8%80%81%E7%88%B8%E8%AF%84%E6%B5%8B&pageSize=10`,
      { headers: apiHeaders(full) },
    )
    assert.equal(catalogItems.response.status, 200)
    assert.equal(
      catalogItems.payload.data.contractVersion,
      'mx-insight-hub.data-products.source-catalog-items.v1',
    )
    assert.equal(catalogItems.payload.data.catalogEntry.id, target.id)
    assert.equal(catalogItems.payload.data.page.sourceMode, 'stored')
    assert.equal(catalogItems.payload.data.page.items[0].marketplace.catalogEntryId, target.id)
    assert.equal(storeQueries.at(-1).catalogEntryId, target.id)
    assert.equal(storeQueries.at(-1).keyword, '老爸评测')
    assert.equal((await store.usage({ consumerId: full.consumer.id })).units, 3)
    for (const secret of PRIVATE_VALUES) {
      assert.equal(JSON.stringify(catalogItems.payload).includes(secret), false, secret)
    }

    const callsBeforeMissing = storeQueries.length
    for (const id of [UNKNOWN_CATALOG_ID, archived.id]) {
      const missing = await call(baseUrl, `/api/v1/data/source-catalog/${id}/items`, {
        headers: apiHeaders(full),
      })
      assert.equal(missing.response.status, 404, id)
      assert.equal(missing.payload.error.code, 'source_catalog_entry_not_found', id)
    }
    assert.equal(storeQueries.length, callsBeforeMissing)

    const sourceOnlyCapabilities = await call(baseUrl, '/api/v1/data/capabilities', {
      headers: apiHeaders(sourceOnly),
    })
    const sourceOnlyPlatform = sourceOnlyCapabilities.payload.data.platforms
      .find(({ platform }) => platform === 'source_catalog')
    assert.equal(sourceOnlyCapabilities.response.status, 200)
    assert.equal(sourceOnlyPlatform.capabilities.includes('catalog_data_items'), false)
    assert.equal(
      sourceOnlyCapabilities.payload.data.platforms.some(({ platform }) => platform === 'mobile_commerce'),
      false,
    )

    const fullCapabilities = await call(baseUrl, '/api/v1/data/capabilities', {
      headers: apiHeaders(full),
    })
    const fullSourceCatalog = fullCapabilities.payload.data.platforms
      .find(({ platform }) => platform === 'source_catalog')
    const fullMobile = fullCapabilities.payload.data.platforms
      .find(({ platform }) => platform === 'mobile_commerce')
    assert.equal(fullCapabilities.response.status, 200)
    assert.equal(fullSourceCatalog.capabilities.includes('catalog_data_items'), true)
    assert.deepEqual(fullMobile, {
      platform: 'mobile_commerce',
      ready: true,
      source: 'hub',
      servingMode: 'stored',
      capabilities: [
        'commerce_items',
        'marketplace_filter',
        'catalog_filter',
        'task_filter',
        'stored_refresh',
      ],
      remoteFetch: { available: false, status: 'reserved' },
    })
    delete store.listMobileCommerceItems
    const unavailableCapabilities = await call(baseUrl, '/api/v1/data/capabilities', {
      headers: apiHeaders(full),
    })
    const unavailableCatalog = unavailableCapabilities.payload.data.platforms
      .find(({ platform }) => platform === 'source_catalog')
    assert.equal(unavailableCatalog.capabilities.includes('catalog_data_items'), false)
    assert.equal(
      unavailableCapabilities.payload.data.platforms.some(({ platform }) => platform === 'mobile_commerce'),
      false,
    )
    assert.deepEqual(adapterCalls, [])
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
