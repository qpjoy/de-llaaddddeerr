import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID } from '../../server/data/virtual-supermarket.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'virtual-supermarket-admin-token'
const PEPPER = 'virtual-supermarket-test-pepper-with-enough-entropy'
const SECRET_SOURCE_TITLE = 'SECRET_SOURCE_TITLE'
const SECRET_SOURCE_AUTHOR = 'SECRET_SOURCE_AUTHOR'
const PRIVATE_VALUES = [
  'copy-open-app-secret',
  'private-device-serial',
  'metadata-private-token',
  'internal-source-key',
  '规格混合原始标签',
  'source-goods-123',
  'source-shop-456',
  '快手原始别名',
  SECRET_SOURCE_TITLE,
  SECRET_SOURCE_AUTHOR,
]

function canonicalProduct(id, collectedAt, { title = SECRET_SOURCE_TITLE, price = '12.30' } = {}) {
  return {
    id,
    datasetId: 'mobile-commerce.collected-items.v1',
    platform: 'mobile_commerce',
    objectType: 'commerce_capture',
    contentType: 'commerce_item',
    externalId: `capture-${id}`,
    title,
    authorName: SECRET_SOURCE_AUTHOR,
    currentRevision: 3,
    projectionRevision: 9,
    collectedAt,
    deletedAt: null,
    stableFields: {
      attributes: { deviceSerial: 'private-device-serial' },
      commerce: {
        captureId: `capture-${id}`,
        product: {
          goodsId: 'source-goods-123',
          title,
          price,
          shareText: 'copy-open-app-secret',
          resolution: 'capture-only',
        },
        shop: {
          id: 'source-shop-456',
          name: '来源店铺',
          shareText: 'copy-open-app-secret',
        },
        signals: { sales: '已售10件', tagsText: '规格混合原始标签' },
        marketplace: {
          status: 'mapped',
          sourceValue: '快手原始别名',
          entryId: '60000000-0000-4000-8000-000000000001',
          sourceKey: 'internal-source-key',
          canonicalName: '快手小店',
        },
        metadata: { token: 'metadata-private-token' },
      },
    },
  }
}

async function call(baseUrl, path, {
  token,
  method = 'GET',
  body,
} = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { response, payload: await response.json() }
}

async function withServer(callback) {
  const store = new MemoryStore()
  const firstId = '70000000-0000-4000-8000-000000000001'
  const secondId = '70000000-0000-4000-8000-000000000002'
  store.canonicalRecords.set(firstId, canonicalProduct(firstId, '2026-09-01T10:00:00.000Z'))
  store.canonicalRecords.set(secondId, canonicalProduct(secondId, '2026-09-01T09:00:00.000Z', {
    title: '第二件商品',
    price: '8.00',
  }))
  store.listMobileCommerceItems = async ({ pageSize = 100 } = {}) => (
    [...store.canonicalRecords.values()]
      .sort((left, right) => right.collectedAt.localeCompare(left.collectedAt) || right.id.localeCompare(left.id))
      .slice(0, pageSize + 1)
  )
  const canonicalBefore = structuredClone([...store.canonicalRecords.entries()])
  const adapter = {
    async capabilities() { return { data: { platforms: [], legacySearch: null } } },
    async dependencies() { return { status: 'up' } },
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Virtual supermarket tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Granted consumer' })
  const publicKey = await service.createApiKey({ consumerId: consumer.id, name: 'Public key' })
  await service.putPlatformConfiguration('virtual_supermarket', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 100,
    windowSeconds: 3600,
    maxPageSize: 25,
  })
  await service.putPlatformConfiguration('mobile_commerce', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests: 100,
    windowSeconds: 3600,
    maxPageSize: 25,
  })
  const noGrantConsumer = await service.createConsumer({ tenantId: tenant.id, name: 'No grant' })
  const noGrantKey = await service.createApiKey({ consumerId: noGrantConsumer.id, name: 'No grant key' })
  const identity = {
    enabled: true,
    async resolve(token) {
      return {
        kind: token === 'launcher-admin' ? 'launcher-admin' : 'launcher-user',
        memberId: token,
        displayName: token,
        platformAdmin: token === 'launcher-admin',
        tenantIds: null,
        capabilities: [],
        memberships: [],
      }
    },
  }
  const server = createServer(createApp({
    service,
    store,
    adapter,
    identity,
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await callback({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      store,
      firstId,
      secondId,
      publicKey: publicKey.secret,
      noGrantKey: noGrantKey.secret,
      canonicalBefore,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('virtual supermarket keeps canonical truth separate while governing safe publication', async () => {
  await withServer(async ({
    baseUrl,
    store,
    firstId,
    secondId,
    publicKey,
    noGrantKey,
    canonicalBefore,
  }) => {
    const publicHeaders = { authorization: `Bearer ${publicKey}` }
    const admin = ADMIN_TOKEN

    const anonymousAdmin = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/products',
    )
    assert.equal(anonymousAdmin.response.status, 401)
    assert.equal(anonymousAdmin.payload.error.code, 'admin_auth_required')
    for (const token of ['launcher-user', 'launcher-admin']) {
      const forbidden = await call(
        baseUrl,
        '/internal/v1/admin/data-products/virtual-supermarket/products',
        { token },
      )
      assert.equal(forbidden.response.status, 403)
      assert.equal(forbidden.payload.error.code, 'admin_token_required')
    }

    const anonymousPublic = await call(baseUrl, '/api/v1/data/virtual-supermarket/products')
    assert.equal(anonymousPublic.response.status, 401)
    const ungranted = await call(baseUrl, '/api/v1/data/virtual-supermarket/products', {
      token: noGrantKey,
    })
    assert.equal(ungranted.response.status, 403)
    assert.equal(ungranted.payload.error.code, 'platform_not_granted')

    const capabilities = await call(baseUrl, '/api/v1/data/capabilities', { token: publicKey })
    const capability = capabilities.payload.data.platforms.find((entry) => entry.platform === 'virtual_supermarket')
    assert.equal(capability.source, 'hub')
    assert.equal(capability.ready, true)
    assert.ok(capability.capabilities.includes('stored_search'))
    assert.ok(capability.capabilities.includes('aisle_filter'))
    const storefrontRevisionProbe = store.getVirtualSupermarketStorefrontRevision.bind(store)
    store.getVirtualSupermarketStorefrontRevision = async () => {
      throw new Error('migration unavailable')
    }
    const degradedCapabilities = await call(baseUrl, '/api/v1/data/capabilities', { token: publicKey })
    assert.equal(
      degradedCapabilities.payload.data.platforms.find((entry) => entry.platform === 'virtual_supermarket').ready,
      false,
    )
    store.getVirtualSupermarketStorefrontRevision = storefrontRevisionProbe
    const unsupportedMetadataQuery = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/metadata?unexpected=1',
      { token: publicKey },
    )
    assert.equal(unsupportedMetadataQuery.response.status, 400)
    assert.equal(unsupportedMetadataQuery.payload.error.code, 'unsupported_fields')

    const initialAdmin = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/products',
      { token: admin },
    )
    assert.equal(initialAdmin.response.status, 200)
    const initialInventoryRevision = initialAdmin.payload.data.inventoryRevision
    assert.equal(initialAdmin.payload.data.items.length, 2)
    assert.ok(initialAdmin.payload.data.items.every((item) => (
      item.listing.status === 'off_shelf'
      && item.listing.revision === 0
      && item.listing.explicit === false
    )))

    const initialPublic = await call(baseUrl, '/api/v1/data/virtual-supermarket/products', {
      token: publicKey,
    })
    assert.equal(initialPublic.response.status, 200)
    assert.deepEqual(initialPublic.payload.data.items, [])
    const hiddenDetail = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products/${firstId}`,
      { token: publicKey },
    )
    assert.equal(hiddenDetail.response.status, 404)
    assert.equal(hiddenDetail.payload.error.code, 'virtual_supermarket_product_not_found')

    const category = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/categories',
      {
        token: admin,
        method: 'POST',
        body: {
          key: 'laundry-care',
          name: '洗护用品',
          department: { key: 'home', name: '家居馆', sortOrder: 10 },
          aisle: { key: 'cleaning', name: '清洁通道', sortOrder: 20 },
          shelf: { key: 'laundry', name: '洗衣货架', sortOrder: 30 },
          sortOrder: 40,
        },
      },
    )
    assert.equal(category.response.status, 201)
    assert.equal(category.payload.data.item.aisle.key, 'cleaning')
    const categoryId = category.payload.data.item.id

    const siblingCategory = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/categories',
      {
        token: admin,
        method: 'POST',
        body: {
          key: 'laundry-refills',
          name: '洗护补充装',
          department: { key: 'home', name: '家居馆', sortOrder: 10 },
          aisle: { key: 'cleaning', name: '清洁通道', sortOrder: 20 },
          shelf: { key: 'laundry', name: '洗衣货架', sortOrder: 30 },
          sortOrder: 41,
        },
      },
    )
    assert.equal(siblingCategory.response.status, 201)
    const hierarchyConflict = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/categories',
      {
        token: admin,
        method: 'POST',
        body: {
          key: 'conflicting-home',
          name: '冲突分类',
          department: { key: 'home', name: '另一个家居馆', sortOrder: 10 },
          aisle: { key: 'other', name: '其他通道', sortOrder: 50 },
          shelf: { key: 'other', name: '其他货架', sortOrder: 50 },
          sortOrder: 50,
        },
      },
    )
    assert.equal(hierarchyConflict.response.status, 409)
    assert.equal(hierarchyConflict.payload.error.code, 'virtual_supermarket_category_hierarchy_conflict')
    assert.equal(hierarchyConflict.payload.error.details.level, 'department')

    const categoryConflict = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/categories/${categoryId}`,
      {
        token: admin,
        method: 'PATCH',
        body: { expectedRevision: 0, name: '冲突名称' },
      },
    )
    assert.equal(categoryConflict.response.status, 409)
    assert.equal(categoryConflict.payload.error.code, 'virtual_supermarket_category_revision_conflict')

    const categoryUpdate = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/categories/${categoryId}`,
      {
        token: admin,
        method: 'PATCH',
        body: { expectedRevision: 1, name: '家庭洗护用品' },
      },
    )
    assert.equal(categoryUpdate.response.status, 200)
    assert.equal(categoryUpdate.payload.data.item.revision, 2)

    const categoryList = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/categories',
      { token: admin },
    )
    assert.equal(categoryList.response.status, 200)
    const listedCategory = categoryList.payload.data.items.find((item) => item.id === categoryId)
    assert.equal(listedCategory.name, '家庭洗护用品')
    assert.equal(listedCategory.revision, 2)
    const categoryMetadata = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/metadata',
      { token: admin },
    )
    assert.equal(categoryMetadata.response.status, 200)
    assert.ok(categoryMetadata.payload.data.storefrontRevision >= categoryUpdate.payload.data.storefrontRevision)
    assert.ok(categoryMetadata.payload.data.categories.some((item) => item.id === categoryId))
    const metadataCategory = categoryMetadata.payload.data.categories.find((item) => item.id === categoryId)
    const metadataSibling = categoryMetadata.payload.data.categories.find(
      (item) => item.id === siblingCategory.payload.data.item.id,
    )
    assert.deepEqual(metadataSibling.department, metadataCategory.department)
    assert.deepEqual(metadataSibling.aisle, metadataCategory.aisle)
    assert.deepEqual(metadataSibling.shelf, metadataCategory.shelf)

    const published = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}/publish`,
      {
        token: admin,
        method: 'POST',
        body: { expectedRevision: 0, reason: '首批上架' },
      },
    )
    assert.equal(published.response.status, 200)
    assert.equal(published.payload.data.item.listing.status, 'on_shelf')
    assert.equal(published.payload.data.item.listing.revision, 1)
    const publicationId = published.payload.data.item.publicationId
    assert.match(publicationId, /^[0-9a-f-]{36}$/u)
    assert.notEqual(publicationId, firstId)

    const revisionConflict = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}`,
      {
        token: admin,
        method: 'PATCH',
        body: { expectedRevision: 0, title: '过期写入' },
      },
    )
    assert.equal(revisionConflict.response.status, 409)
    assert.equal(revisionConflict.payload.error.code, 'virtual_supermarket_listing_revision_conflict')

    const curated = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}`,
      {
        token: admin,
        method: 'PATCH',
        body: {
          expectedRevision: 1,
          categoryId,
          title: '无香洗衣液 2L',
          specification: '2L / 瓶',
          price: { amount: '19.90', currency: 'CNY' },
          shelfPosition: 7,
          reason: '人工复核商品展示字段',
        },
      },
    )
    assert.equal(curated.response.status, 200)
    assert.equal(curated.payload.data.item.listing.revision, 2)
    assert.equal(curated.payload.data.item.placement.position, 7)
    assert.equal(curated.payload.data.item.sourceEvidence.goodsId, 'source-goods-123')
    assert.equal(curated.payload.data.item.sourceEvidence.shopId, 'source-shop-456')
    assert.deepEqual(curated.payload.data.item.fieldState.displayTitle, {
      source: SECRET_SOURCE_TITLE, override: '无香洗衣液 2L', effective: '无香洗衣液 2L', provenance: 'curated',
    })
    assert.deepEqual(curated.payload.data.item.fieldState.price, {
      source: '12.30', override: '19.90', effective: '19.90', provenance: 'curated',
    })

    const publicPage = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/products?department=home&aisle=cleaning&shelf=laundry&sort=price_asc',
      { token: publicKey },
    )
    assert.equal(publicPage.response.status, 200)
    assert.equal(publicPage.payload.data.items.length, 1)
    const item = publicPage.payload.data.items[0]
    assert.equal(item.id, publicationId)
    assert.equal(item.product.title, '无香洗衣液 2L')
    assert.equal(item.product.specification, '2L / 瓶')
    assert.deepEqual(item.product.price, {
      amount: '19.90', currency: 'CNY', display: '19.90', provenance: 'curated',
    })
    assert.equal(item.placement.position, 7)
    assert.equal(item.product.provenance.title, 'curated')
    assert.equal('explicit' in item.listing, false)
    assert.deepEqual(item.marketplace, {
      id: '60000000-0000-4000-8000-000000000001',
      name: '快手小店',
    })
    assert.equal('goodsId' in item.product, false)
    assert.equal('id' in item.shop, false)
    const serialized = JSON.stringify(publicPage.payload)
    for (const secret of PRIVATE_VALUES) assert.equal(serialized.includes(secret), false, secret)
    for (const forbiddenField of ['catalogSourceKey', 'tagsText', 'sourceEvidence', 'shareText', 'metadata']) {
      assert.equal(serialized.includes(forbiddenField), false, forbiddenField)
    }
    assert.equal(serialized.includes(firstId), false)

    const mobileCommerce = await call(baseUrl, '/api/v1/data/mobile-commerce/items', {
      token: publicKey,
    })
    assert.equal(mobileCommerce.response.status, 200)
    assert.equal(mobileCommerce.payload.data.items.some((entry) => entry.id === firstId), true)
    assert.equal(mobileCommerce.payload.data.items.some((entry) => entry.id === publicationId), false)
    const canonicalIdCannotReadPublication = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products/${firstId}`,
      { token: publicKey },
    )
    assert.equal(canonicalIdCannotReadPublication.response.status, 404)
    const publicationDetail = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products/${publicationId}`,
      { token: publicKey },
    )
    assert.equal(publicationDetail.response.status, 200)
    assert.equal(publicationDetail.payload.data.item.id, publicationId)
    assert.equal(JSON.stringify(publicationDetail.payload).includes(firstId), false)
    for (const privateValue of PRIVATE_VALUES) {
      assert.equal(JSON.stringify(publicationDetail.payload).includes(privateValue), false, privateValue)
    }
    const unsupportedDetailQuery = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products/${publicationId}?unexpected=1`,
      { token: publicKey },
    )
    assert.equal(unsupportedDetailQuery.response.status, 400)
    assert.equal(unsupportedDetailQuery.payload.error.code, 'unsupported_fields')

    const publicMarketplace = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/products?marketplace=%E5%BF%AB%E6%89%8B%E5%B0%8F%E5%BA%97',
      { token: publicKey },
    )
    assert.deepEqual(publicMarketplace.payload.data.items.map((entry) => entry.id), [publicationId])
    const publicMarketplaceId = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/products?marketplace=60000000-0000-4000-8000-000000000001',
      { token: publicKey },
    )
    assert.deepEqual(publicMarketplaceId.payload.data.items.map((entry) => entry.id), [publicationId])
    const rawMarketplaceOracle = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/products?marketplace=%E5%BF%AB%E6%89%8B%E5%8E%9F%E5%A7%8B%E5%88%AB%E5%90%8D',
      { token: publicKey },
    )
    assert.deepEqual(rawMarketplaceOracle.payload.data.items, [])
    const privateMarketplaceOracle = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/products?marketplace=internal-source-key',
      { token: publicKey },
    )
    assert.deepEqual(privateMarketplaceOracle.payload.data.items, [])
    const privateSearchOracle = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/search?query=%E8%A7%84%E6%A0%BC%E6%B7%B7%E5%90%88%E5%8E%9F%E5%A7%8B%E6%A0%87%E7%AD%BE',
      { token: publicKey },
    )
    assert.deepEqual(privateSearchOracle.payload.data.items, [])
    const adminGovernanceSearch = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/products?status=on_shelf&query=%E8%A7%84%E6%A0%BC%E6%B7%B7%E5%90%88%E5%8E%9F%E5%A7%8B%E6%A0%87%E7%AD%BE',
      { token: admin },
    )
    assert.deepEqual(adminGovernanceSearch.payload.data.items.map((entry) => entry.id), [firstId])
    const adminGovernanceMarketplace = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/products?status=on_shelf&marketplace=internal-source-key',
      { token: admin },
    )
    assert.deepEqual(adminGovernanceMarketplace.payload.data.items.map((entry) => entry.id), [firstId])

    const hiddenSourceTitleSearch = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/search?query=${encodeURIComponent(SECRET_SOURCE_TITLE)}`,
      { token: publicKey },
    )
    assert.deepEqual(hiddenSourceTitleSearch.payload.data.items, [])
    const hiddenSourceAuthorSearch = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/search?query=${encodeURIComponent(SECRET_SOURCE_AUTHOR)}`,
      { token: publicKey },
    )
    assert.deepEqual(hiddenSourceAuthorSearch.payload.data.items, [])
    const adminHiddenSourceTitleSearch = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products?status=on_shelf&query=${encodeURIComponent(SECRET_SOURCE_TITLE)}`,
      { token: admin },
    )
    assert.deepEqual(adminHiddenSourceTitleSearch.payload.data.items.map((entry) => entry.id), [firstId])
    const adminHiddenSourceAuthorSearch = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products?status=on_shelf&query=${encodeURIComponent(SECRET_SOURCE_AUTHOR)}`,
      { token: admin },
    )
    assert.deepEqual(adminHiddenSourceAuthorSearch.payload.data.items.map((entry) => entry.id), [firstId])

    const search = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/search?query=%E6%97%A0%E9%A6%99%E6%B4%97%E8%A1%A3',
      { token: publicKey },
    )
    assert.equal(search.response.status, 200)
    assert.deepEqual(search.payload.data.items.map((entry) => entry.id), [publicationId])
    const missingSearchQuery = await call(baseUrl, '/api/v1/data/virtual-supermarket/search', {
      token: publicKey,
    })
    assert.equal(missingSearchQuery.response.status, 400)
    const publicStatusFilter = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/products?status=off_shelf',
      { token: publicKey },
    )
    assert.equal(publicStatusFilter.response.status, 400)
    assert.equal(publicStatusFilter.payload.error.code, 'unsupported_fields')

    const adminInventoryPage = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/products?pageSize=1',
      { token: admin },
    )
    assert.equal(adminInventoryPage.response.status, 200)
    assert.equal(adminInventoryPage.payload.data.pageInfo.hasMore, true)
    assert.match(adminInventoryPage.payload.data.inventoryRevision, /^sha256:/u)
    assert.equal(adminInventoryPage.payload.data.inventoryRevision, initialInventoryRevision)
    const adminInventoryCursor = adminInventoryPage.payload.data.pageInfo.nextCursor
    const storefrontBeforeInventoryInsert = await store.getVirtualSupermarketStorefrontRevision()
    const thirdId = '70000000-0000-4000-8000-000000000003'
    store.canonicalRecords.set(thirdId, canonicalProduct(thirdId, '2026-09-01T11:00:00.000Z', {
      title: '持续写入的新商品',
      price: '6.00',
    }))
    const staleInventoryCursor = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products?pageSize=1&cursor=${encodeURIComponent(adminInventoryCursor)}`,
      { token: admin },
    )
    assert.equal(staleInventoryCursor.response.status, 409)
    assert.equal(staleInventoryCursor.payload.error.code, 'virtual_supermarket_inventory_changed')
    assert.equal(await store.getVirtualSupermarketStorefrontRevision(), storefrontBeforeInventoryInsert)
    const refreshedInventoryPage = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/products?pageSize=1',
      { token: admin },
    )
    assert.notEqual(refreshedInventoryPage.payload.data.inventoryRevision, initialInventoryRevision)
    store.canonicalRecords.delete(thirdId)

    const adminUpdatePage = await call(
      baseUrl,
      '/internal/v1/admin/data-products/virtual-supermarket/products?pageSize=1',
      { token: admin },
    )
    const adminUpdateCursor = adminUpdatePage.payload.data.pageInfo.nextCursor
    store.canonicalRecords.get(secondId).currentRevision += 1
    const staleUpdatedInventoryCursor = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products?pageSize=1&cursor=${encodeURIComponent(adminUpdateCursor)}`,
      { token: admin },
    )
    assert.equal(staleUpdatedInventoryCursor.response.status, 409)
    assert.equal(staleUpdatedInventoryCursor.payload.error.code, 'virtual_supermarket_inventory_changed')
    store.canonicalRecords.get(secondId).currentRevision -= 1

    const secondPublished = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${secondId}/publish`,
      { token: admin, method: 'POST', body: { expectedRevision: 0 } },
    )
    assert.equal(secondPublished.response.status, 200)
    const secondPublicationId = secondPublished.payload.data.item.publicationId
    assert.notEqual(secondPublicationId, secondId)
    const firstPage = await call(
      baseUrl,
      '/api/v1/data/virtual-supermarket/products?pageSize=1',
      { token: publicKey },
    )
    assert.equal(firstPage.payload.data.pageInfo.hasMore, true)
    const cursor = firstPage.payload.data.pageInfo.nextCursor
    const revisionBeforeChange = firstPage.payload.data.storefrontRevision
    const changed = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${secondId}`,
      {
        token: admin,
        method: 'PATCH',
        body: { expectedRevision: 1, shelfPosition: 2 },
      },
    )
    assert.equal(changed.response.status, 200)
    assert.ok(changed.payload.data.storefrontRevision > revisionBeforeChange)
    const staleCursor = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products?pageSize=1&cursor=${encodeURIComponent(cursor)}`,
      { token: publicKey },
    )
    assert.equal(staleCursor.response.status, 409)
    assert.equal(staleCursor.payload.error.code, 'storefront_revision_changed')

    const archivedCategory = store.virtualSupermarketCategories.get(VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID)
    archivedCategory.archivedAt = '2026-09-02T00:00:00.000Z'
    store.virtualSupermarketStorefrontRevision += 1
    const archivedList = await call(baseUrl, '/api/v1/data/virtual-supermarket/products', {
      token: publicKey,
    })
    assert.equal(archivedList.payload.data.items.some((entry) => entry.id === secondPublicationId), false)
    const archivedDetail = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products/${secondPublicationId}`,
      { token: publicKey },
    )
    assert.equal(archivedDetail.response.status, 404)
    assert.equal(archivedDetail.payload.error.code, 'virtual_supermarket_product_not_found')
    const archivedAdminDetail = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${secondId}`,
      { token: admin },
    )
    assert.equal(archivedAdminDetail.response.status, 200)

    const placementOnly = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}`,
      {
        token: admin,
        method: 'PATCH',
        body: { expectedRevision: 2, categoryId, shelfPosition: 8 },
      },
    )
    assert.equal(placementOnly.response.status, 200)
    assert.equal(placementOnly.payload.data.item.listing.displayTitle, '无香洗衣液 2L')
    assert.deepEqual(placementOnly.payload.data.item.listing.price, { amount: '19.90', currency: 'CNY' })
    assert.equal(placementOnly.payload.data.item.fieldState.displayTitle.override, '无香洗衣液 2L')
    assert.equal(placementOnly.payload.data.item.fieldState.price.override, '19.90')

    const clearedOverrides = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}`,
      {
        token: admin,
        method: 'PATCH',
        body: { expectedRevision: 3, title: null, specification: null, price: null },
      },
    )
    assert.equal(clearedOverrides.response.status, 200)
    assert.equal(clearedOverrides.payload.data.item.listing.displayTitle, null)
    assert.equal(clearedOverrides.payload.data.item.listing.specification, null)
    assert.equal(clearedOverrides.payload.data.item.listing.price, null)
    assert.deepEqual(clearedOverrides.payload.data.item.fieldState.displayTitle, {
      source: SECRET_SOURCE_TITLE, override: null, effective: SECRET_SOURCE_TITLE, provenance: 'source',
    })
    assert.deepEqual(clearedOverrides.payload.data.item.fieldState.price, {
      source: '12.30', override: null, effective: '12.30', provenance: 'source',
    })
    assert.deepEqual(clearedOverrides.payload.data.item.fieldState.currency, {
      source: null, override: null, effective: null, provenance: 'missing',
    })
    const sourceRestored = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products/${publicationId}`,
      { token: publicKey },
    )
    assert.equal(sourceRestored.payload.data.item.product.title, SECRET_SOURCE_TITLE)
    assert.equal(sourceRestored.payload.data.item.product.price.amount, '12.30')
    assert.equal(sourceRestored.payload.data.item.product.price.currency, null)

    const unpublished = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}/unpublish`,
      {
        token: admin,
        method: 'POST',
        body: { expectedRevision: 4, reason: '人工下架' },
      },
    )
    assert.equal(unpublished.response.status, 200)
    assert.equal(unpublished.payload.data.item.listing.status, 'off_shelf')
    const removed = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products/${publicationId}`,
      { token: publicKey },
    )
    assert.equal(removed.response.status, 404)
    const republished = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}/publish`,
      { token: admin, method: 'POST', body: { expectedRevision: 5, reason: '重新上架' } },
    )
    assert.equal(republished.response.status, 200)
    assert.equal(republished.payload.data.item.publicationId, publicationId)
    const restored = await call(
      baseUrl,
      `/api/v1/data/virtual-supermarket/products/${publicationId}`,
      { token: publicKey },
    )
    assert.equal(restored.response.status, 200)
    assert.equal(restored.payload.data.item.id, publicationId)

    const events = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}/events`,
      { token: admin },
    )
    assert.equal(events.response.status, 200)
    assert.deepEqual(events.payload.data.items.map((event) => event.eventType), [
      'publish', 'unpublish', 'update', 'update', 'update', 'publish',
    ])
    assert.ok(events.payload.data.items.every((event) => event.storefrontRevision > 1))

    assert.deepEqual([...store.canonicalRecords.entries()], canonicalBefore)
    assert.equal(store.canonicalRecords.get(firstId).currentRevision, 3)
    assert.equal(store.canonicalRecords.get(firstId).projectionRevision, 9)
  })
})

test('virtual-supermarket mutation responses retain their transaction storefront revision', async () => {
  await withServer(async ({ baseUrl, store, firstId, secondId }) => {
    const initialRevision = await store.getVirtualSupermarketStorefrontRevision()
    const originalUpdate = store.updateVirtualSupermarketProduct.bind(store)
    let injected = false
    let concurrentResult = null
    store.updateVirtualSupermarketProduct = async (...args) => {
      const result = await originalUpdate(...args)
      if (!injected && args[0] === firstId) {
        injected = true
        concurrentResult = await originalUpdate(secondId, { status: 'on_shelf' }, {
          expectedRevision: 0,
          actor: 'concurrent-test',
          eventType: 'publish',
        })
      }
      return result
    }

    const firstResponse = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}/publish`,
      {
        token: ADMIN_TOKEN,
        method: 'POST',
        body: { expectedRevision: 0 },
      },
    )
    assert.equal(firstResponse.response.status, 200)
    assert.equal(firstResponse.payload.data.item.id, firstId)
    assert.equal(firstResponse.payload.data.item.listing.revision, 1)
    assert.equal(firstResponse.payload.data.storefrontRevision, initialRevision + 1)
    assert.equal(concurrentResult.storefrontRevision, initialRevision + 2)
    assert.equal(await store.getVirtualSupermarketStorefrontRevision(), initialRevision + 2)
    const [firstEvent] = await store.listVirtualSupermarketProductEvents(firstId)
    assert.equal(firstEvent.storefrontRevision, firstResponse.payload.data.storefrontRevision)

    const originalEvents = store.listVirtualSupermarketProductEvents.bind(store)
    let eventReadMutationInjected = false
    store.listVirtualSupermarketProductEvents = async (id, ...args) => {
      if (!eventReadMutationInjected) {
        eventReadMutationInjected = true
        await store.updateVirtualSupermarketProduct(firstId, { status: 'off_shelf' }, {
          expectedRevision: 1,
          actor: 'concurrent-event-read-test',
          eventType: 'unpublish',
        })
      }
      return originalEvents(id, ...args)
    }
    const mixedEventSnapshot = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}/events`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(mixedEventSnapshot.response.status, 409)
    assert.equal(mixedEventSnapshot.payload.error.code, 'storefront_revision_changed')
    store.listVirtualSupermarketProductEvents = originalEvents
    const stableEvents = await call(
      baseUrl,
      `/internal/v1/admin/data-products/virtual-supermarket/products/${firstId}/events`,
      { token: ADMIN_TOKEN },
    )
    assert.equal(stableEvents.response.status, 200)
    assert.ok(stableEvents.payload.data.items.every((event) => (
      event.storefrontRevision <= stableEvents.payload.data.storefrontRevision
    )))
  })
})

test('virtual-supermarket MemoryStore exposes append-only revisions without physical deletion', async () => {
  const store = new MemoryStore()
  const id = randomUUID()
  store.canonicalRecords.set(id, canonicalProduct(id, '2026-09-01T10:00:00.000Z'))
  const initial = await store.getVirtualSupermarketProduct(id)
  assert.equal(initial.listing.status, 'off_shelf')
  assert.equal(initial.listing.revision, 0)
  const { item: published } = await store.updateVirtualSupermarketProduct(id, { status: 'on_shelf' }, {
    expectedRevision: 0,
    actor: 'memory-test',
    eventType: 'publish',
  })
  assert.equal(published.listing.revision, 1)
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', marketplace: 'internal-source-key',
  })).length, 0)
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', query: '规格混合原始标签',
  })).length, 0)
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', marketplace: 'internal-source-key', includeGovernanceEvidence: true,
  })).length, 1)
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', query: '规格混合原始标签', includeGovernanceEvidence: true,
  })).length, 1)
  await store.updateVirtualSupermarketProduct(id, { status: 'off_shelf' }, {
    expectedRevision: 1,
    actor: 'memory-test',
    eventType: 'unpublish',
  })
  assert.equal(store.canonicalRecords.has(id), true)
  assert.equal((await store.listVirtualSupermarketProductEvents(id)).length, 2)
})

test('virtual-supermarket MemoryStore hides archived categories from public detail', async () => {
  const store = new MemoryStore()
  const id = randomUUID()
  store.canonicalRecords.set(id, canonicalProduct(id, '2026-09-01T10:00:00.000Z'))
  await store.updateVirtualSupermarketProduct(id, { status: 'on_shelf' }, {
    expectedRevision: 0,
    actor: 'memory-test',
    eventType: 'publish',
  })
  store.virtualSupermarketCategories.get(VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID).archivedAt = new Date().toISOString()
  assert.equal(await store.getVirtualSupermarketProduct(id, { onShelfOnly: true }), null)
  assert.equal((await store.getVirtualSupermarketProduct(id)).id, id)
})
