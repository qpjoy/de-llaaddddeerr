import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NIGHT_ALL_COUNT_MISMATCH_WARNING,
  nightAllLegacyCountAudit,
  withNightAllLegacyCountWarning,
} from '../../server/contracts/night-all-count-audit.mjs'
import {
  nightAllCompatibilityBusinessOutcome,
  nightAllCompatibilityItemCount,
} from '../../server/data/night-all-compat.mjs'
import { toNightAllXiaohongshuRawEnvelope } from '../../server/contracts/tikhub-xiaohongshu-search-projection.mjs'

function rows(count, prefix = 'row') {
  return Array.from({ length: count }, (_, index) => ({
    content_id: `${prefix}-${index}`,
    url: `https://www.xiaohongshu.com/explore/${prefix}-${index}`,
  }))
}

function envelope({ dataRows = 11, infoRows = 0, page = {}, meta = {}, warnings = null } = {}) {
  return {
    data: {
      platform: 'xiaohongshu',
      raw_info: JSON.stringify(rows(infoRows, 'user')),
      raw_data: JSON.stringify(rows(dataRows)),
      page: { page: 1, pageSize: 20, hasMore: true, ...page },
      meta: { responseShape: 'standard_raw_payload', ...meta },
      ...(warnings ? { warnings } : {}),
    },
  }
}

test('a declared page count that survived upstream de-duplication is reported', () => {
  const audit = nightAllLegacyCountAudit(envelope({
    dataRows: 11,
    page: { returnedCount: 20 },
    meta: { resultCount: 11, rawDataCount: 11, rawInfoCount: 0 },
  }))
  assert.equal(audit.consistent, false)
  assert.equal(audit.actual.rawDataCount, 11)
  assert.equal(audit.actual.primaryCount, 11)
  assert.deepEqual([...audit.mismatches], [
    { field: 'page.returnedCount', declared: 20, actual: 11 },
  ])
})

test('an internally consistent envelope reports no mismatch and is returned unchanged', () => {
  const payload = envelope({
    dataRows: 11,
    page: { returnedCount: 11 },
    meta: { resultCount: 11, rawDataCount: 11, rawInfoCount: 0 },
  })
  const audit = nightAllLegacyCountAudit(payload)
  assert.equal(audit.consistent, true)
  assert.equal(audit.mismatches.length, 0)
  assert.equal(withNightAllLegacyCountWarning(payload), payload)
})

test('an identity delivery is judged against raw_info instead of an empty raw_data', () => {
  const audit = nightAllLegacyCountAudit(envelope({
    dataRows: 0,
    infoRows: 3,
    page: { returnedCount: 3 },
    meta: { resultCount: 3, rawDataCount: 0, rawInfoCount: 3 },
  }))
  assert.equal(audit.consistent, true)
  assert.equal(audit.actual.primaryCount, 3)
})

test('absent or malformed declarations are not treated as a mismatch', () => {
  for (const page of [{}, { returnedCount: null }, { returnedCount: -1 }, { returnedCount: '11' }]) {
    assert.equal(nightAllLegacyCountAudit(envelope({ dataRows: 11, page })).consistent, true)
  }
})

test('a body that is not a legacy envelope has nothing to reconcile', () => {
  for (const payload of [
    null,
    {},
    { error: { code: 'external_platform_rejected' }, requestId: 'r' },
    { data: { items: [], pageInfo: { returnedCount: 0 } } },
  ]) {
    assert.equal(nightAllLegacyCountAudit(payload), null)
    assert.equal(withNightAllLegacyCountWarning(payload), payload)
  }
})

test('the warning is appended without mutating or dropping any acquired field', () => {
  const payload = envelope({
    dataRows: 11,
    page: { returnedCount: 20 },
    warnings: [{ code: 'UPSTREAM_PARTIAL_FAILURE', message: 'existing' }],
  })
  const before = JSON.parse(JSON.stringify(payload))
  const delivered = withNightAllLegacyCountWarning(payload)
  assert.deepEqual(payload, before)
  assert.equal(delivered.data.raw_data, payload.data.raw_data)
  assert.equal(delivered.data.page.returnedCount, 20)
  assert.deepEqual(delivered.data.warnings[0], { code: 'UPSTREAM_PARTIAL_FAILURE', message: 'existing' })
  assert.equal(delivered.data.warnings[1].code, NIGHT_ALL_COUNT_MISMATCH_WARNING)
  assert.match(delivered.data.warnings[1].message, /page\.returnedCount=20 but the delivered rows are 11/)
  // A replayed archive already carries the warning; it is never duplicated.
  assert.equal(withNightAllLegacyCountWarning(delivered), delivered)
})

test('the audit warning never reclassifies the delivery or its billed units', () => {
  const clean = envelope({ dataRows: 11, page: { returnedCount: 20 } })
  assert.equal(nightAllCompatibilityBusinessOutcome(clean), 'complete')
  const delivered = withNightAllLegacyCountWarning(clean)
  assert.equal(nightAllCompatibilityBusinessOutcome(delivered), 'complete')
  assert.equal(nightAllCompatibilityItemCount(delivered), nightAllCompatibilityItemCount(clean))
  // A genuine upstream warning still marks the delivery partial.
  assert.equal(nightAllCompatibilityBusinessOutcome(withNightAllLegacyCountWarning(envelope({
    dataRows: 11,
    page: { returnedCount: 20 },
    warnings: [{ code: 'UPSTREAM_PARTIAL_FAILURE', message: 'existing' }],
  }))), 'partial')
})

test('the Hub-direct TikHub projection cannot declare a count it did not deliver', () => {
  const items = Array.from({ length: 11 }, (_, index) => ({
    id: `id-${index}`,
    externalId: `${index}`.padStart(24, '0'),
    platform: 'xiaohongshu',
    contentType: 'note',
    url: `https://www.xiaohongshu.com/explore/${`${index}`.padStart(24, '0')}`,
    title: `note ${index}`,
    text: 'body',
    publishedAt: '2026-09-17T00:00:00.000Z',
    collectedAt: '2026-09-17T00:00:00.000Z',
    author: { id: 'author', name: 'author', avatarUrl: null },
    metrics: { likes: 0, comments: 0, shares: 0, views: null, bookmarks: 0 },
    media: { coverUrl: null, images: [], videos: [] },
    source: { provider: null, endpointId: null },
  }))
  const projection = {
    data: {
      contractVersion: 'night-all.data-search.v1',
      platform: 'xiaohongshu',
      query: '旅游',
      items,
      pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: items.length, hasMore: true, nextCursor: 'mxec2.next', cursorType: 'opaque' },
      status: 'ok',
      warnings: [],
      meta: { capability: 'search_posts', capabilityStatus: 'ready', paginationMode: 'cursor', sourceProvider: null, endpointId: null, providerCalls: 1 },
    },
  }
  const audit = nightAllLegacyCountAudit(toNightAllXiaohongshuRawEnvelope(projection, { requestId: 'req' }))
  assert.equal(audit.consistent, true)
  assert.equal(audit.actual.rawDataCount, 11)
  assert.equal(audit.declared.returnedCount, 11)
  assert.equal(audit.declared.resultCount, 11)
  assert.equal(audit.declared.rawDataCount, 11)
})
