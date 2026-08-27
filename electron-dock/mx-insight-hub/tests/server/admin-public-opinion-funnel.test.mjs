import assert from 'node:assert/strict'
import test from 'node:test'
import {
  adminPublicOpinionBrowseResponse,
  adminPublicOpinionFunnelResponse,
  demoAdminPublicOpinionBrowseRows,
  demoAdminPublicOpinionFunnel,
  normalizeAdminPublicOpinionBrowseQuery,
  normalizeAdminPublicOpinionFunnelQuery,
} from '../../server/data/admin-data-products.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const NOW = new Date('2026-08-27T12:00:00.000Z')
const FROM = '2026-07-28T12:00:00.000Z'
const TO = NOW.toISOString()

test('Admin opinion funnel has live, reconcilable partitions over one selected window', () => {
  const query = normalizeAdminPublicOpinionFunnelQuery({}, NOW)
  const response = adminPublicOpinionFunnelResponse(demoAdminPublicOpinionFunnel(query), query, {
    demoMode: true,
  })

  assert.deepEqual(response.window, { from: FROM, to: TO })
  assert.equal(response.canonical.active,
    response.publication.withState + response.publication.missingState)
  assert.equal(response.canonical.active,
    response.time.withEventTime + response.time.missingEventTime)
  assert.equal(response.time.withEventTime,
    response.time.withinWindow + response.time.outsideWindow)
  assert.equal(response.canonical.active,
    response.geography.withProvince + response.geography.withoutProvince)
  assert.equal(response.canonical.active,
    response.heat.withScore + response.heat.missingScore)
  assert.ok(response.visibility.coverageVisible >= response.visibility.hotVisible)
  assert.equal(response.reasons.missingPublicationState, response.publication.missingState)
  assert.equal(response.demoMode, true)
})

test('Admin opinion browse pages every current status and explains why a row is not displayed', () => {
  const firstQuery = normalizeAdminPublicOpinionBrowseQuery({ pageSize: '2' }, NOW)
  const first = adminPublicOpinionBrowseResponse(
    demoAdminPublicOpinionBrowseRows(firstQuery),
    firstQuery,
    { demoMode: true },
  )
  assert.equal(first.items.length, 2)
  assert.equal(first.pageInfo.hasMore, true)
  assert.ok(first.pageInfo.nextCursor)

  const secondQuery = normalizeAdminPublicOpinionBrowseQuery({
    pageSize: '2', cursor: first.pageInfo.nextCursor,
  }, NOW)
  const second = adminPublicOpinionBrowseResponse(
    demoAdminPublicOpinionBrowseRows(secondQuery),
    secondQuery,
    { demoMode: true },
  )
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 4)

  const missingProvinceQuery = normalizeAdminPublicOpinionBrowseQuery({
    reason: 'missing_province', province: 'missing', pageSize: '100',
  }, NOW)
  const missingProvince = adminPublicOpinionBrowseResponse(
    demoAdminPublicOpinionBrowseRows(missingProvinceQuery),
    missingProvinceQuery,
    { demoMode: true },
  )
  assert.ok(missingProvince.items.length > 0)
  assert.ok(missingProvince.items.every((item) => (
    item.provinceCode === null && item.diagnostics.reasons.includes('missing_province')
  )))
  assert.ok(missingProvince.items.some((item) => item.sourceStage === 'candidate'))
})

test('Admin opinion browse projection excludes raw, credentials and model traces', () => {
  const query = normalizeAdminPublicOpinionBrowseQuery({}, NOW)
  const response = adminPublicOpinionBrowseResponse([{
    id: '40000000-0000-4000-8000-000000000001',
    title: 'Business title', body: 'Business summary',
    url: 'https://example.invalid/item?token=opinion-secret-sentinel&view=1',
    content_type: 'news', author_name: 'Source', event_time: NOW,
    collected_at: NOW, heat_score: '72', publication_record_id: null,
    has_publication_state: false, source_stage: null, quality_status: null,
    stable_fields: {
      attributes: { sourceType: 'news', sourcePlatform: 'public-web' },
      credentials: { password: 'opinion-secret-sentinel' },
      raw: { modelReasoning: 'opinion-secret-sentinel' },
    },
    extensions: { connectionString: 'opinion-secret-sentinel' },
    sort_time: NOW,
  }], query)
  const serialized = JSON.stringify(response)
  assert.doesNotMatch(serialized, /opinion-secret-sentinel|credentials|password|modelReasoning|connectionString/)
  assert.equal(response.items[0].source.platform, 'public-web')
  assert.match(response.items[0].url, /[?]view=1/)
  assert.deepEqual(response.items[0].diagnostics.reasons.sort(), [
    'missing_province', 'missing_publication_state',
  ])
})

test('PostgreSQL funnel is unbounded and browse uses stable parameterized keyset pagination', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [] }
    },
  })

  await store.getAdminPublicOpinionFunnel({ from: FROM, to: TO })
  await store.listAdminPublicOpinionBrowseRecords({
    from: FROM,
    to: TO,
    pageSize: 25,
    cursor: {
      sortTime: '2026-08-20T00:00:00.000Z',
      id: '40000000-0000-4000-8000-000000000002',
    },
    query: '江苏',
    reason: 'missing_province',
    stage: 'candidate',
    status: 'rejected',
    province: 'missing',
    scope: 'unknown',
    time: 'outside',
    heat: 'missing',
  })

  assert.doesNotMatch(calls[0].sql, /\bLIMIT\b/i)
  assert.match(calls[0].sql, /LEFT JOIN core\.public_opinion_current_state/)
  assert.match(calls[0].sql, /publication\.canonical_revision = record\.current_revision/)
  assert.deepEqual(calls[0].values, [FROM, TO])

  const browse = calls[1]
  assert.match(browse.sql, /record\.deleted_at IS NULL/)
  assert.match(browse.sql, /coalesce\(record\.event_time, record\.collected_at, to_timestamp\(0\)\), record\.id\) </)
  assert.match(browse.sql, /ORDER BY coalesce\(record\.event_time, record\.collected_at, to_timestamp\(0\)\) DESC/)
  assert.match(browse.sql, /LIMIT \$\d+/)
  assert.equal(browse.values.at(-1), 26)
  assert.ok(browse.values.includes('%江苏%'))
  assert.ok(browse.values.includes('candidate'))
  assert.ok(browse.values.includes('rejected'))
  assert.doesNotMatch(browse.sql, /raw_payload|normalized_payload|model_reasoning|credentials|connection_string/i)
})

test('PostgreSQL browse types its default window even when the selected reason does not use it', async () => {
  const calls = []
  const store = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [] }
    },
  })

  await store.listAdminPublicOpinionBrowseRecords({
    from: FROM,
    to: TO,
    pageSize: 25,
    reason: 'missing_province',
  })

  const browse = calls[0]
  assert.match(browse.sql, /\$1::timestamptz <= \$2::timestamptz/)
  assert.match(browse.sql, /publication\.display_admin1_code IS NULL/)
  assert.deepEqual(browse.values, [FROM, TO, 26])
  const referencedParameters = new Set(
    [...browse.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])),
  )
  assert.deepEqual([...referencedParameters].sort((left, right) => left - right), [1, 2, 3])
})

test('Admin opinion browse validates filters and requires paired window boundaries', () => {
  assert.throws(
    () => normalizeAdminPublicOpinionBrowseQuery({ from: FROM }, NOW),
    (error) => error?.code === 'invalid_request',
  )
  assert.throws(
    () => normalizeAdminPublicOpinionBrowseQuery({ reason: 'invented' }, NOW),
    (error) => error?.code === 'invalid_request',
  )
  assert.equal(
    normalizeAdminPublicOpinionBrowseQuery({ province: 'cn-js' }, NOW).province,
    'CN-JS',
  )
})
