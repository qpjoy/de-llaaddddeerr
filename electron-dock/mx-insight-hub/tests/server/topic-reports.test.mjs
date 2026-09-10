import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import {
  TOPIC_REPORT_CONTRACT_VERSION,
  buildTopicReport,
  normalizeTopicReportRequest,
} from '../../server/insights/topic-reports.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const NEWS = 'data_center_saved_records_news'
const FINANCE = 'data_center_saved_records_finance'
const ADMIN_TOKEN = 'topic-report-admin-token'
const PEPPER = 'topic-report-test-pepper-with-enough-entropy'

async function withServer(app, run) {
  const server = createServer(app)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await run(`http://127.0.0.1:${server.address().port}`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function call(baseUrl, path, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { response, payload: await response.json() }
}

test('topic report request freezes the granted platform scope and bounded window', () => {
  const request = normalizeTopicReportRequest({
    topic: ' 人工智能 与 资本市场 ',
    range: '7d',
    sourceScope: 'all_granted',
    sampleLimit: 120,
  }, {
    allowedPlatforms: [NEWS, FINANCE],
    now: new Date('2026-09-10T08:00:00.000Z'),
  })

  assert.deepEqual(request, {
    topic: '人工智能 与 资本市场',
    language: 'zh-CN',
    range: '7d',
    rangeStart: '2026-09-03T08:00:00.000Z',
    rangeEnd: '2026-09-10T08:00:00.000Z',
    sourceScope: 'all_granted',
    platforms: [FINANCE, NEWS],
    sampleLimit: 120,
  })
})

test('topic report request rejects an ungranted platform and unsupported fields', () => {
  assert.throws(
    () => normalizeTopicReportRequest({
      topic: '人工智能',
      sourceScope: 'selected',
      platforms: [FINANCE],
    }, { allowedPlatforms: [NEWS] }),
    (error) => error.status === 403 && error.code === 'platform_not_granted',
  )
  assert.throws(
    () => normalizeTopicReportRequest({ topic: '人工智能', provider: 'internal-source' }),
    (error) => error.status === 400 && error.code === 'unsupported_fields',
  )
})

test('topic report result is public-safe, deterministic, and carries evidence associations', () => {
  const claim = {
    topic: '人工智能产业发展',
    language: 'zh-CN',
    range_start: '2026-09-03T00:00:00.000Z',
    range_end: '2026-09-10T00:00:00.000Z',
    sample_limit: 240,
  }
  const report = buildTopicReport(claim, {
    terms: ['人工智能', '产业发展'],
    rows: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        dataset_id: 'data-center.saved-records.news.v1',
        platform: NEWS,
        title: '人工智能产业政策密集发布',
        body: '多地发布人工智能产业政策，算力与应用场景成为关注重点。',
        url: 'https://example.test/news/1?token=must-not-leak&lang=zh',
        author_name: '示例新闻社',
        country_code: 'CN',
        admin1_code: 'CN-JS',
        sort_time: '2026-09-08T09:00:00.000Z',
        total_matches: '3',
        stable_fields: {
          tags: ['人工智能', '产业政策'],
          location: { label: '江苏' },
          raw: { provider: 'must-not-leak' },
        },
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        dataset_id: 'data-center.saved-records.finance.v1',
        platform: FINANCE,
        title: 'AI 产业投资热度上升',
        body: '资本市场持续关注算力基础设施与企业服务。',
        url: 'https://example.test/finance/2',
        author_name: '财经观察',
        country_code: 'CN',
        admin1_code: null,
        sort_time: '2026-09-09T02:00:00.000Z',
        total_matches: '3',
        stable_fields: {
          attributes: { tags: ['人工智能', '资本市场'], location: '全国' },
          connector: { id: 'must-not-leak' },
        },
      },
    ],
  }, { generatedAt: new Date('2026-09-10T01:00:00.000Z') })

  assert.equal(report.contractVersion, TOPIC_REPORT_CONTRACT_VERSION)
  assert.deepEqual(report.coverage, {
    matchedRecords: 3,
    analyzedRecords: 2,
    evidenceRecords: 2,
    categoryCount: 2,
    truncated: true,
  })
  assert.deepEqual(report.timeline, [
    { date: '2026-09-08', count: 1 },
    { date: '2026-09-09', count: 1 },
  ])
  assert.equal(report.dimensions.categories[0].count, 1)
  assert.ok(report.associations.nodes.some((node) => node.id === 'tag:人工智能'))
  assert.ok(report.associations.edges.some((edge) => edge.from === 'topic'))
  assert.equal(report.evidence[0].url, 'https://example.test/news/1?lang=zh')
  assert.equal(report.methodology.dataBasis, 'postgresql_canonical_truth')
  assert.equal(report.methodology.projectionDependency, 'none')

  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /must-not-leak/u)
  assert.equal(Object.hasOwn(report.evidence[0], 'raw'), false)
  assert.equal(Object.hasOwn(report.evidence[0], 'connector'), false)
  assert.equal(Object.hasOwn(report.evidence[0], 'provider'), false)
})

test('public topic report HTTP flow freezes ownership, meters once, and replays safely', async () => {
  const store = new MemoryStore()
  const created = []
  const reports = new Map()
  const topicReports = {
    async create(input, { id, owner }) {
      const report = {
        id,
        contractVersion: TOPIC_REPORT_CONTRACT_VERSION,
        topic: input.topic,
        language: input.language,
        range: { from: input.rangeStart, to: input.rangeEnd },
        sourceScope: { mode: input.sourceScope, platforms: input.platforms, categories: [] },
        sampleLimit: input.sampleLimit,
        status: 'queued',
        phase: 'queued',
        progress: 0,
        result: null,
        error: null,
        createdAt: '2026-09-10T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
      }
      created.push({ input, owner })
      reports.set(id, { report, owner })
      return report
    },
    async get(id, { consumerId }) {
      const entry = reports.get(id)
      return entry?.owner?.consumerId === consumerId ? entry.report : null
    },
  }
  const adapter = {
    capabilities: async () => ({ data: { platforms: [] } }),
    dependencies: async () => ({ status: 'up' }),
  }
  const service = new HubService({ store, adapter, apiKeyPepper: PEPPER, topicReports })
  const tenant = await service.createTenant({ name: 'Topic report tenant' })
  const owner = await service.createConsumer({ tenantId: tenant.id, name: 'Topic owner' })
  const stranger = await service.createConsumer({ tenantId: tenant.id, name: 'Other consumer' })
  for (const consumer of [owner, stranger]) {
    await service.putPlatformConfiguration(NEWS, {
      tenantId: tenant.id,
      consumerId: consumer.id,
      enabled: true,
      maxRequests: 10,
      windowSeconds: 3_600,
      maxPageSize: 100,
    })
  }
  const ownerKey = await service.createApiKey({ consumerId: owner.id, name: 'Owner key', platforms: [NEWS] })
  const strangerKey = await service.createApiKey({ consumerId: stranger.id, name: 'Other key', platforms: [NEWS] })
  const app = createApp({ service, store, adapter, adminToken: ADMIN_TOKEN, logger: { error() {} } })

  await withServer(app, async (baseUrl) => {
    const headers = {
      authorization: `Bearer ${ownerKey.secret}`,
      'idempotency-key': 'topic-report-http-0001',
    }
    const body = { topic: '人工智能产业发展', range: '7d' }
    const accepted = await call(baseUrl, '/api/v1/data/topic-reports', { method: 'POST', headers, body })
    assert.equal(accepted.response.status, 202, JSON.stringify(accepted.payload))
    assert.equal(accepted.response.headers.get('idempotent-replay'), 'false')
    assert.equal(accepted.payload.data.id, accepted.payload.requestId)
    assert.deepEqual(accepted.payload.data.sourceScope.platforms, [NEWS])
    assert.deepEqual(created[0].owner, {
      tenantId: tenant.id,
      consumerId: owner.id,
      apiKeyId: ownerKey.id,
    })

    const replay = await call(baseUrl, '/api/v1/data/topic-reports', { method: 'POST', headers, body })
    assert.equal(replay.response.status, 202)
    assert.equal(replay.response.headers.get('idempotent-replay'), 'true')
    assert.equal(replay.payload.data.id, accepted.payload.data.id)
    assert.equal(created.length, 1)

    const detail = await call(baseUrl, `/api/v1/data/topic-reports/${accepted.payload.data.id}`, {
      headers: { authorization: `Bearer ${ownerKey.secret}` },
    })
    assert.equal(detail.response.status, 200)
    assert.equal(detail.payload.data.id, accepted.payload.data.id)

    const hidden = await call(baseUrl, `/api/v1/data/topic-reports/${accepted.payload.data.id}`, {
      headers: { authorization: `Bearer ${strangerKey.secret}` },
    })
    assert.equal(hidden.response.status, 404)
    assert.equal(hidden.payload.error.code, 'topic_report_not_found')

    const conflict = await call(baseUrl, '/api/v1/data/topic-reports', {
      method: 'POST', headers, body: { topic: '不同主题', range: '7d' },
    })
    assert.equal(conflict.response.status, 409)
    assert.equal(conflict.payload.error.code, 'idempotency_conflict')
  })
})
