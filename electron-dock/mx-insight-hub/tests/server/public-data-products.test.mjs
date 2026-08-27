import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'

import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const ADMIN_TOKEN = 'admin-secret'
const PEPPER = 'public-data-products-pepper-with-enough-entropy'
const FIRST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'

async function withServer(app, callback) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    return await callback(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, { headers = {} } = {}) {
  const response = await fetch(`${baseUrl}${path}`, { headers })
  return { response, payload: await response.json() }
}

function diagnosticRow(id, sortTime) {
  return {
    id,
    title: '未归属记录',
    body: '可供归纳的安全摘要',
    url: 'https://example.test/item',
    content_type: 'article',
    author_name: 'Reporter',
    event_time: new Date(sortTime),
    collected_at: new Date(sortTime),
    heat_score: null,
    stable_fields: {
      attributes: { sourceType: 'news', sourcePlatform: 'example' },
      raw: { password: 'must-not-leak' },
    },
    publication_record_id: null,
    source_stage: null,
    quality_status: null,
    quality_score: null,
    qualification_threshold: null,
    geography_verified: false,
    geo_scope: 'unknown',
    country_code: 'CN',
    country_name: '中国',
    location_label: null,
    location_type: null,
    quality_flags: ['missing_province'],
    rejection_codes: [],
    sort_time: new Date(sortTime),
    raw_payload: { apiKey: 'must-not-leak' },
  }
}

test('public-opinion diagnostics require API Key, platform and step-up grants, then meter safe pages', async () => {
  const store = new MemoryStore()
  const browseQueries = []
  const first = diagnosticRow(FIRST_ID, '2026-08-25T10:00:00Z')
  const second = diagnosticRow(SECOND_ID, '2026-08-25T09:00:00Z')
  store.getAdminPublicOpinionFunnel = async () => ({
    canonical_total: 2,
    active_count: 2,
    deleted_count: 0,
    missing_publication_state_count: 2,
    missing_event_time_count: 0,
    outside_window_count: 0,
    without_province_count: 2,
    missing_heat_score_count: 2,
  })
  store.listAdminPublicOpinionBrowseRecords = async (query) => {
    browseQueries.push(query)
    return query.cursor ? [second] : [first, second]
  }
  store.getAdminPublicOpinionBrowseRecord = async (id) => id === FIRST_ID ? first : null
  store.listPublicOpinionRecords = async () => []
  store.getPublicOpinionServingIndexStatus = async () => ({ ready: true })
  store.getExternalSource = async () => ({ status: 'active' })

  const adapter = { capabilities: async () => ({ data: { platforms: [] } }) }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Diagnostics tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Diagnostics consumer' })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Diagnostics key' })
  const app = createApp({ service, store, adapter, adminToken: ADMIN_TOKEN })

  await withServer(app, async (baseUrl) => {
    const apiHeaders = { authorization: `Bearer ${key.secret}` }
    const noPlatform = await call(baseUrl, '/api/v1/data/public-opinion/funnel', {
      headers: apiHeaders,
    })
    assert.equal(noPlatform.response.status, 403)
    assert.equal(noPlatform.payload.error.code, 'platform_not_granted')

    await service.putPlatformConfiguration('public_opinion', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 20,
      windowSeconds: 3600,
      maxPageSize: 2,
    })
    const noStepUp = await call(baseUrl, '/api/v1/data/public-opinion/funnel', {
      headers: apiHeaders,
    })
    assert.equal(noStepUp.response.status, 403)
    assert.equal(noStepUp.payload.error.code, 'capability_not_granted')

    await service.putCapabilityConfiguration('public_opinion.diagnostics.read', {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 4,
      windowSeconds: 3600,
    })

    for (const headers of [
      { 'x-mx-insight-admin-token': ADMIN_TOKEN },
      { authorization: 'Bearer launcher-platform-token' },
    ]) {
      const rejected = await call(baseUrl, '/api/v1/data/public-opinion/funnel', { headers })
      assert.equal(rejected.response.status, 401)
    }

    const capabilities = await call(baseUrl, '/api/v1/data/capabilities', { headers: apiHeaders })
    assert.deepEqual(
      capabilities.payload.data.capabilities.find(
        ({ capability }) => capability === 'public_opinion.diagnostics.read',
      ),
      { capability: 'public_opinion.diagnostics.read', ready: true },
    )

    const funnel = await call(baseUrl, '/api/v1/data/public-opinion/funnel', {
      headers: apiHeaders,
    })
    assert.equal(funnel.response.status, 200)
    assert.equal(
      funnel.payload.data.contractVersion,
      'mx-insight-hub.data-products.public-opinion-funnel.v1',
    )
    assert.equal(funnel.payload.data.reasons.missingProvince, 2)

    const tooLarge = await call(
      baseUrl,
      '/api/v1/data/public-opinion/records?reason=missing_province&pageSize=3',
      { headers: apiHeaders },
    )
    assert.equal(tooLarge.response.status, 400)
    assert.equal(tooLarge.payload.error.code, 'page_size_exceeded')

    const browsePath = '/api/v1/data/public-opinion/records'
      + '?from=2026-08-01T00%3A00%3A00Z&to=2026-08-26T00%3A00%3A00Z'
      + '&reason=missing_province&pageSize=1'
    const records = await call(
      baseUrl,
      browsePath,
      { headers: apiHeaders },
    )
    assert.equal(records.response.status, 200)
    assert.equal(records.payload.data.items.length, 1)
    assert.equal(records.payload.data.items[0].id, FIRST_ID)
    assert.equal(records.payload.data.pageInfo.hasMore, true)
    assert.ok(records.payload.data.pageInfo.nextCursor)
    assert.equal(browseQueries[0].reason, 'missing_province')
    assert.equal(JSON.stringify(records.payload).includes('must-not-leak'), false)

    const next = await call(
      baseUrl,
      `${browsePath}&cursor=${encodeURIComponent(records.payload.data.pageInfo.nextCursor)}`,
      { headers: apiHeaders },
    )
    assert.equal(next.response.status, 200)
    assert.equal(next.payload.data.items[0].id, SECOND_ID)
    assert.equal(next.payload.data.pageInfo.hasMore, false)
    assert.deepEqual(browseQueries[1].cursor, {
      sortTime: '2026-08-25T10:00:00.000Z',
      id: FIRST_ID,
    })

    const changedFilters = [
      '&reason=missing_heat',
      '&stage=candidate',
      '&status=pending',
      '&province=CN-JS',
      '&scope=unknown',
      '&time=within',
      '&heat=missing',
      '&query=other',
      '&from=2026-08-02T00%3A00%3A00Z',
      '&to=2026-08-25T00%3A00%3A00Z',
      '&pageSize=2',
    ]
    for (const changed of changedFilters) {
      const changedUrl = new URL(`${baseUrl}${browsePath}`)
      const [name, value] = changed.slice(1).split('=')
      changedUrl.searchParams.set(name, decodeURIComponent(value))
      changedUrl.searchParams.set('cursor', records.payload.data.pageInfo.nextCursor)
      const rejected = await call('', changedUrl.toString(), { headers: apiHeaders })
      assert.equal(rejected.response.status, 400, changed)
      assert.equal(rejected.payload.error.code, 'invalid_cursor', changed)
    }
    const cursor = records.payload.data.pageInfo.nextCursor
    const tamperedCursor = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`
    const tampered = await call(
      baseUrl,
      `${browsePath}&cursor=${encodeURIComponent(tamperedCursor)}`,
      { headers: apiHeaders },
    )
    assert.equal(tampered.response.status, 400)
    assert.equal(tampered.payload.error.code, 'invalid_cursor')

    const detail = await call(
      baseUrl,
      `/api/v1/data/public-opinion/records/${FIRST_ID}`,
      { headers: apiHeaders },
    )
    assert.equal(detail.response.status, 200)
    assert.equal(detail.payload.data.id, FIRST_ID)
    assert.equal(JSON.stringify(detail.payload).includes('must-not-leak'), false)

    const limited = await call(baseUrl, '/api/v1/data/public-opinion/funnel', {
      headers: apiHeaders,
    })
    assert.equal(limited.response.status, 429)
    assert.equal(limited.payload.error.code, 'quota_exceeded')
  })
})
