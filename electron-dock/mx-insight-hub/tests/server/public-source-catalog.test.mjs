import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import {
  normalizeSourceCatalogCreate,
  normalizeSourceCatalogOwnerCreate,
} from '../../server/data/source-catalog.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'public-source-catalog-admin-token'
const PEPPER = 'public-source-catalog-test-pepper-with-enough-entropy'

async function call(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, payload: await response.json() }
}

function catalogInput({ sourceKey, legacySequence, canonicalName, ownerId }) {
  return normalizeSourceCatalogCreate({
    sourceKey,
    legacySequence,
    canonicalName,
    aliases: [`${canonicalName}别名`],
    sourceKind: 'platform',
    majorCategory: '公共目录测试分类',
    scenarios: ['测试场景'],
    regions: ['海外'],
    entryModules: ['搜索入口'],
    monitorableContent: ['标题', '正文'],
    extractableClues: ['公开链接'],
    trackingFields: ['主体名称'],
    suggestedAccess: ['公开 API'],
    complianceBoundary: '仅处理授权数据',
    priority: 'P1',
    coverageStatus: 'covered',
    deliveryStatus: 'doing',
    reviewStatus: 'verified',
    runtimeStatus: 'healthy',
    ownerId,
    connectorHints: ['connector-label'],
    notes: '内部关键词与对外进度说明',
    tags: ['公共标签'],
    evidenceRefs: [{ type: 'document', key: 'docs/private-evidence.md' }],
    customFields: { internalEndpoint: 'postgres://private-host/private-db' },
    importedFrom: 'private-import-batch',
  })
}

async function withFixture(run, { maxRequests = 100, maxPageSize = 2 } = {}) {
  const store = new MemoryStore()
  const adapterCalls = []
  const adapter = {
    capabilities: async (platforms) => {
      adapterCalls.push(platforms)
      return { data: { platforms: [], legacySearch: null } }
    },
    dependencies: async () => ({ status: 'up' }),
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Source catalog tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Source catalog consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Source catalog key' })
  const noGrantConsumer = await service.createConsumer({ tenantId: tenant.id, name: 'No grant consumer' })
  const noGrantKey = await service.createApiKey({ consumerId: noGrantConsumer.id, name: 'No grant key' })
  await service.putPlatformConfiguration('source_catalog', {
    tenantId: tenant.id,
    consumerId: consumer.id,
    enabled: true,
    maxRequests,
    windowSeconds: 3_600,
    maxPageSize,
  })

  const owner = await store.createSourceCatalogOwner(normalizeSourceCatalogOwnerCreate({
    ownerKey: 'public-owner',
    displayName: '目录负责人',
    description: '负责公共目录测试',
    linkedAccountId: 'private-login-account',
  }))
  const first = await store.createSourceCatalogEntry(catalogInput({
    sourceKey: 'public-catalog-a',
    legacySequence: 1_001,
    canonicalName: '公共平台 A',
    ownerId: owner.id,
  }))
  const second = await store.createSourceCatalogEntry(catalogInput({
    sourceKey: 'public-catalog-b',
    legacySequence: 1_002,
    canonicalName: '公共平台 B',
    ownerId: owner.id,
  }))
  const archived = await store.createSourceCatalogEntry(catalogInput({
    sourceKey: 'public-catalog-archived',
    legacySequence: 1_003,
    canonicalName: '已归档公共平台',
    ownerId: owner.id,
  }))
  await store.archiveSourceCatalogEntry(archived.id, { expectedRevision: 1, actor: 'test' })

  const server = createServer(createApp({
    service,
    store,
    adapter,
    adminToken: ADMIN_TOKEN,
    logger: { error() {} },
  }))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      store,
      service,
      tenant,
      consumer,
      key,
      noGrantKey,
      owner,
      first,
      second,
      adapterCalls,
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('public source catalog requires API Key and an explicit source_catalog grant', async () => {
  await withFixture(async ({ baseUrl, key, noGrantKey, adapterCalls }) => {
    const anonymous = await call(baseUrl, '/api/v1/data/source-catalog')
    assert.equal(anonymous.response.status, 401)

    const adminToken = await call(baseUrl, '/api/v1/data/source-catalog', {
      headers: { 'x-mx-insight-admin-token': ADMIN_TOKEN },
    })
    assert.equal(adminToken.response.status, 401)

    const launcherStyleBearer = await call(baseUrl, '/api/v1/data/source-catalog', {
      headers: { authorization: 'Bearer launcher-session-token-not-an-api-key' },
    })
    assert.equal(launcherStyleBearer.response.status, 401)

    const forbidden = await call(baseUrl, '/api/v1/data/source-catalog', {
      headers: { authorization: `Bearer ${noGrantKey.secret}` },
    })
    assert.equal(forbidden.response.status, 403)
    assert.equal(forbidden.payload.error.code, 'platform_not_granted')

    const capabilities = await call(baseUrl, '/api/v1/data/capabilities', {
      headers: { authorization: `Bearer ${key.secret}` },
    })
    assert.equal(capabilities.response.status, 200)
    assert.deepEqual(
      capabilities.payload.data.platforms.find((entry) => entry.platform === 'source_catalog'),
      {
        platform: 'source_catalog',
        ready: true,
        source: 'hub',
        servingMode: 'stored',
        capabilities: ['catalog_entries', 'catalog_metadata', 'filtered_browse'],
      },
    )
    assert.deepEqual(adapterCalls, [])

    const noPublicWrite = await call(baseUrl, '/api/v1/data/source-catalog', {
      method: 'POST',
      headers: { authorization: `Bearer ${key.secret}` },
      body: { canonicalName: '不能写入' },
    })
    assert.equal(noPublicWrite.response.status, 404)
  })
})

test('public source catalog exposes a safe, filterable keyset-paged business projection', async () => {
  await withFixture(async ({ baseUrl, store, key, owner, first, second }) => {
    const headers = { authorization: `Bearer ${key.secret}` }
    const params = new URLSearchParams({
      majorCategory: '公共目录测试分类',
      scenario: '测试场景',
      region: '海外',
      coverageStatus: 'covered',
      deliveryStatus: 'doing',
      reviewStatus: 'verified',
      runtimeStatus: 'healthy',
      priority: 'P1',
      ownerId: owner.id,
      tag: '公共标签',
      pageSize: '1',
    })
    const firstPage = await call(baseUrl, `/api/v1/data/source-catalog?${params}`, { headers })
    assert.equal(firstPage.response.status, 200)
    assert.equal(firstPage.payload.data.contractVersion, 'source-catalog.public.v1')
    assert.equal(firstPage.payload.data.pageInfo.totalCount, 2)
    assert.equal(firstPage.payload.data.pageInfo.returnedCount, 1)
    assert.equal(firstPage.payload.data.pageInfo.hasMore, true)
    assert.ok(firstPage.payload.data.pageInfo.nextCursor)
    assert.equal(firstPage.payload.data.items[0].id, first.id)
    assert.equal(firstPage.payload.data.items[0].coverageStatus, 'covered')
    assert.equal(firstPage.payload.data.items[0].deliveryStatus, 'doing')
    assert.equal(firstPage.payload.data.items[0].owner, '目录负责人')
    assert.deepEqual(firstPage.payload.data.items[0].connectorHints, ['connector-label'])
    assert.equal(firstPage.payload.data.items[0].notes, '内部关键词与对外进度说明')

    const serialized = JSON.stringify(firstPage.payload)
    for (const forbidden of [
      'evidenceRefs', 'customFields', 'importedFrom', 'private-evidence',
      'private-host', 'revision', 'createdAt', 'updatedAt', 'archivedAt',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `public item exposed ${forbidden}`)
    }

    await store.createSourceCatalogEntry(catalogInput({
      sourceKey: 'public-catalog-inserted-before-cursor',
      legacySequence: 1_000,
      canonicalName: '并发插入平台',
      ownerId: owner.id,
    }))
    params.set('cursor', firstPage.payload.data.pageInfo.nextCursor)
    const secondPage = await call(baseUrl, `/api/v1/data/source-catalog?${params}`, { headers })
    assert.equal(secondPage.response.status, 200)
    assert.deepEqual(secondPage.payload.data.items.map((item) => item.id), [second.id])
    assert.equal(secondPage.payload.data.pageInfo.hasMore, false)

    params.set('coverageStatus', 'not_covered')
    const rebound = await call(baseUrl, `/api/v1/data/source-catalog?${params}`, { headers })
    assert.equal(rebound.response.status, 400)
    assert.equal(rebound.payload.error.code, 'invalid_cursor')

    const searched = await call(
      baseUrl,
      '/api/v1/data/source-catalog?query=%E5%86%85%E9%83%A8%E5%85%B3%E9%94%AE%E8%AF%8D&pageSize=2',
      { headers },
    )
    assert.equal(searched.response.status, 200)
    assert.equal(searched.payload.data.items.length, 2)
    assert.equal(searched.payload.data.items.some((item) => item.canonicalName === '已归档公共平台'), false)

    const archived = await call(baseUrl, '/api/v1/data/source-catalog?includeArchived=true', { headers })
    assert.equal(archived.response.status, 400)
    assert.equal(archived.payload.error.code, 'unsupported_fields')

    const tooLarge = await call(baseUrl, '/api/v1/data/source-catalog?pageSize=3', { headers })
    assert.equal(tooLarge.response.status, 400)
    assert.equal(tooLarge.payload.error.code, 'page_size_exceeded')
  })
})

test('public source catalog metadata reconstructs fields, statuses, facets and safe owners', async () => {
  await withFixture(async ({ baseUrl, key, owner }) => {
    const result = await call(baseUrl, '/api/v1/data/source-catalog/metadata', {
      headers: { 'x-api-key': key.secret },
    })
    assert.equal(result.response.status, 200)
    assert.equal(result.payload.data.contractVersion, 'source-catalog.public.v1')
    assert.ok(result.payload.data.fields.some((field) => field.key === 'coverageStatus'))
    assert.ok(result.payload.data.fields.some((field) => field.key === 'deliveryStatus'))
    assert.ok(result.payload.data.enums.coverageStatuses.includes('covered'))
    assert.ok(result.payload.data.enums.deliveryStatuses.includes('doing'))
    assert.ok(result.payload.data.facets.majorCategories.includes('公共目录测试分类'))
    assert.equal(result.payload.data.summary.total, 217)
    assert.equal(Object.hasOwn(result.payload.data.summary, 'archived'), false)
    assert.equal(Object.hasOwn(result.payload.data, 'items'), false)

    const page = await call(baseUrl, '/api/v1/data/source-catalog?pageSize=1', {
      headers: { 'x-api-key': key.secret },
    })
    assert.equal(page.response.status, 200)
    assert.deepEqual(
      result.payload.data.fields.map((field) => field.key).sort(),
      Object.keys(page.payload.data.items[0]).sort(),
    )

    const publicOwner = result.payload.data.owners.find((entry) => entry.id === owner.id)
    assert.deepEqual(publicOwner, {
      id: owner.id,
      displayName: '目录负责人',
      description: '负责公共目录测试',
      usageCount: 2,
    })
    const serialized = JSON.stringify(result.payload)
    for (const forbidden of ['linkedAccountId', 'private-login-account', 'normalizedName', 'archivedAt']) {
      assert.equal(serialized.includes(forbidden), false, `public metadata exposed ${forbidden}`)
    }

    const unsupported = await call(
      baseUrl,
      '/api/v1/data/source-catalog/metadata?includeArchived=true',
      { headers: { 'x-api-key': key.secret } },
    )
    assert.equal(unsupported.response.status, 400)
    assert.equal(unsupported.payload.error.code, 'unsupported_fields')
  })
})

test('public source catalog redacts credentials accidentally pasted into governed text fields', async () => {
  await withFixture(async ({ baseUrl, store, key, owner, first }) => {
    await store.updateSourceCatalogEntry(first.id, {
      suggestedAccess: ['公开 API', 'postgresql://reader:must-not-leak-secret@10.0.0.8/catalog'],
      complianceBoundary: 'Authorization: Bearer must-not-leak-secret',
      connectorHints: ['connector-label', 'host=10.0.0.8;password=must-not-leak-secret'],
      notes: 'apiKey=must-not-leak-secret',
    }, { expectedRevision: 1, actor: 'test' })
    await store.updateSourceCatalogOwner(owner.id, {
      description: 'token=must-not-leak-secret',
    }, { expectedRevision: 1, actor: 'test' })

    const headers = { authorization: `Bearer ${key.secret}` }
    const page = await call(
      baseUrl,
      '/api/v1/data/source-catalog?query=%E5%85%AC%E5%85%B1%E5%B9%B3%E5%8F%B0%20A&pageSize=2',
      { headers },
    )
    assert.equal(page.response.status, 200)
    assert.equal(page.payload.data.items.length, 1)
    const item = page.payload.data.items[0]
    assert.deepEqual(item.suggestedAccess, ['公开 API'])
    assert.equal(item.complianceBoundary, null)
    assert.deepEqual(item.connectorHints, ['connector-label'])
    assert.equal(item.notes, null)
    assert.deepEqual(item.redactedFields, [
      'complianceBoundary', 'connectorHints', 'notes', 'suggestedAccess',
    ])
    assert.equal(JSON.stringify(page.payload).includes('must-not-leak-secret'), false)

    const secretSearch = await call(
      baseUrl,
      '/api/v1/data/source-catalog?query=must-not-leak-secret&pageSize=2',
      { headers },
    )
    assert.equal(secretSearch.response.status, 200)
    assert.equal(secretSearch.payload.data.items.length, 0)

    const metadata = await call(baseUrl, '/api/v1/data/source-catalog/metadata', { headers })
    assert.equal(metadata.response.status, 200)
    assert.equal(JSON.stringify(metadata.payload).includes('must-not-leak-secret'), false)
    assert.equal(metadata.payload.data.facets.connectorHints.includes('connector-label'), true)
    assert.equal(metadata.payload.data.facets.connectorHints.some((value) => value.includes('10.0.0.8')), false)
    const publicOwner = metadata.payload.data.owners.find((entry) => entry.id === owner.id)
    assert.equal(publicOwner.description, null)
    assert.deepEqual(publicOwner.redactedFields, ['description'])
  })
})

test('public source catalog GETs share the consumer platform quota', async () => {
  await withFixture(async ({ baseUrl, key }) => {
    const headers = { authorization: `Bearer ${key.secret}` }
    const first = await call(baseUrl, '/api/v1/data/source-catalog?pageSize=1', { headers })
    assert.equal(first.response.status, 200)
    const limited = await call(baseUrl, '/api/v1/data/source-catalog/metadata', { headers })
    assert.equal(limited.response.status, 429)
    assert.equal(limited.payload.error.code, 'quota_exceeded')
  }, { maxRequests: 1, maxPageSize: 2 })
})
