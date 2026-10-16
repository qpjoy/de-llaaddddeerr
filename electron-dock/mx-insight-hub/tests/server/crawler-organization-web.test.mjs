import assert from 'node:assert/strict'
import test from 'node:test'
import { applyMapping, refreshMappedPayloadSha256 } from '../../server/ingest/external/mapping.mjs'
import { CRAWLER_FIELD_MAP, crawlerSourceSpec } from '../../server/ingest/crawler/source-contract.mjs'
import { createCrawlerCatalogClassifier, enrichCrawlerRecord } from '../../server/ingest/crawler/record.mjs'
import { newsFields } from '../../server/data/news-record.mjs'
import { publicNewsArticle, normalizeNewsQuery, newsWhere } from '../../server/data/news-discovery.mjs'

function mapped({ sourceType = 'news', attributes = {}, ...overrides } = {}, classifyCatalog) {
  const spec = crawlerSourceSpec(sourceType)
  const raw = {
    id: 123, source_type: sourceType, connector_id: 'organization-web',
    record_key: 'stable-record-key', source_id: 'url:source-version',
    record_type: sourceType === 'web' ? 'web.page' : 'news.article',
    source_url: 'https://example.org/article', title: '公开文章', text: '已存内容',
    published_at: null, first_seen_at: '2026-10-16T03:00:00Z', last_seen_at: '2026-10-16T03:00:00Z',
    created_at: '2026-10-16T03:00:00Z', tag: 'maidanglao',
    attributes: {
      site_id: 'example.org', site_name: '示例研究机构', site_domain: 'example.org',
      source_categories: ['智库', 'NGO', '智库'], content_extent: 'listing', body_status: 'feed_summary',
      published_at_raw: '2026-10-15', published_at_precision: 'date', ...attributes,
    }, ...overrides,
  }
  const record = applyMapping(raw, CRAWLER_FIELD_MAP, { ...spec, source: spec }).record
  enrichCrawlerRecord(record, raw, spec, { classifyCatalog })
  refreshMappedPayloadSha256(record)
  return { raw, record, spec }
}

test('organization website identity and source labels survive the fixed mapping without becoming authorization categories', () => {
  const { raw, record, spec } = mapped()
  assert.equal(record.externalId, raw.record_key)
  assert.equal(record.platform, spec.platform)
  assert.equal(record.stableFields.attributes.sourceType, 'news')
  assert.deepEqual(record.stableFields.website, {
    contractVersion: 'organization-website.v1', siteId: 'example.org', siteName: '示例研究机构',
    siteDomain: 'example.org', sourceCategories: ['智库', 'NGO'], bodyStatus: 'feed_summary',
    contentExtent: 'listing', editionVersion: null, dateUnknown: null,
    publishedAtRaw: '2026-10-15', publishedAtPrecision: 'date',
  })
  assert.deepEqual(record.stableFields.tags, [])
  assert.deepEqual(record.stableFields.news.topics, [])
  assert.equal(record.stableFields.news.contentExtent, 'summary')
  assert.equal(record.stableFields.sourceCatalog.publisher.status, 'unresolved')
  assert.equal(record.stableFields.sourceCatalog.publisher.sourceValue, 'example.org')
  assert.equal(record.stableFields.crawler.lineage.publisher.code, 'example.org')
  assert.equal(record.eventTime, null)
  assert.equal(record.extensions?.tag, undefined)
  assert.equal(record.rawItem.tag, 'maidanglao')
  const otherTag = mapped({ tag: 'another-batch' }).record
  assert.equal(record.payloadSha256, otherTag.payloadSha256)
  assert.notEqual(record.rawPayloadSha256, otherTag.rawPayloadSha256)
})

test('website projection is bounded and does not publish arbitrary source attributes or invent catalog entries', () => {
  const { record } = mapped({ attributes: {
    site_name: { secret: 'private-value' }, site_domain: 'x'.repeat(300),
    source_categories: [null, { secret: 'private-value' }, '智库', ' ', 'x'.repeat(201)],
    edition_version: 'not-a-content-hash', published_at_raw: 'x'.repeat(129),
    published_at_precision: 'invented', date_unknown: 'true',
    cookies: 'private-value', authorization: 'private-value',
    original_url: 'https://example.org/?token=private-value',
  } })
  assert.equal(record.stableFields.website.siteName, null)
  assert.equal(record.stableFields.website.siteDomain, null)
  assert.deepEqual(record.stableFields.website.sourceCategories, ['智库'])
  assert.equal(record.stableFields.website.editionVersion, null)
  assert.equal(record.stableFields.website.dateUnknown, null)
  assert.equal(record.stableFields.website.publishedAtRaw, null)
  assert.equal(record.stableFields.website.publishedAtPrecision, null)
  assert.doesNotMatch(JSON.stringify(record.stableFields), /private-value|cookies|authorization|original_url/)
})

test('homepage snapshots retain web identity and version evidence without being promoted to full news articles', () => {
  const { record } = mapped({ sourceType: 'web', source_id: 'homepage:version-identity', attributes: {
    body_status: 'homepage_snapshot', edition_version: 'a'.repeat(64), date_unknown: true,
    published_at_raw: null, published_at_precision: 'unknown',
  } })
  assert.equal(record.platform, 'data_center_saved_records_web')
  assert.equal(record.contentType, 'web.page')
  assert.equal(record.externalId, 'stable-record-key')
  assert.equal(record.stableFields.website.editionVersion, 'a'.repeat(64))
  assert.equal(record.stableFields.website.dateUnknown, true)
  assert.equal(record.stableFields.website.contentExtent, 'listing')
  assert.equal(record.stableFields.news.contentExtent, 'reference')
  assert.notEqual(record.stableFields.crawler.publication.eligibility, 'candidate')
  assert.equal(record.eventTime, null)
})

test('organization content extent reflects source evidence and does not change other collectors', () => {
  for (const [body_status, content_extent, expected] of [
    ['full_text', 'full_text', 'full_text'], ['feed_summary', 'listing', 'summary'],
    ['feed_metadata', 'listing', 'reference'], ['pdf_link_only', 'listing', 'reference'],
    ['paywall_metadata', 'listing', 'reference'], ['homepage_snapshot', 'listing', 'reference'],
    ['full_text', 'listing', 'unknown'], ['future-status', 'full_text', 'unknown'],
  ]) {
    assert.equal(newsFields({ connector_id: 'organization-web', attributes: { body_status, content_extent } }).contentExtent, expected)
  }
  assert.equal(newsFields({ connector_id: 'another-collector', attributes: { body_status: 'feed_summary' } }).contentExtent, 'unknown')
  assert.equal(newsFields({ connector_id: 'another-collector', attributes: { body_status: 'full_text' } }).contentExtent, 'full_text')
  const { record } = mapped({ connector_id: 'another-collector' })
  assert.equal(record.stableFields.website, undefined)
  assert.equal(record.stableFields.crawler.lineage.publisher.code, null)
})

test('existing news source filters can identify newly cleaned websites while unmapped publishers stay reviewable', () => {
  const { record } = mapped()
  const item = publicNewsArticle({
    id: 'record-id', platform: record.platform, stable_fields: record.stableFields,
    title: record.title, body: record.body, collected_at: record.collectedAt,
  })
  assert.deepEqual(item.source, { catalogEntryId: null, name: '示例研究机构', code: 'example.org', bindingStatus: 'unmapped' })
  assert.equal(item.contentExtent, 'summary')
  const query = normalizeNewsQuery({ sourceCodes: ['example.org'] }, {
    platforms: [record.platform], identity: ['consumer', 'key'], secret: 'test-only',
  })
  assert.ok(newsWhere(query).values.some(value => Array.isArray(value) && value.includes('example.org')))
  assert.throws(() => normalizeNewsQuery({ categories: ['ngo'] }, {
    platforms: [record.platform], identity: ['consumer', 'key'], secret: 'test-only',
  }), { status: 403 })
  const entry = { id: 'reviewed-publisher-id', sourceKey: 'reviewed-site', revision: 1,
    canonicalName: '已登记机构', aliases: ['example.org'], majorCategory: '智库' }
  const classified = mapped({}, createCrawlerCatalogClassifier([entry])).record
  assert.equal(classified.stableFields.sourceCatalog.publisher.entryId, entry.id)
  assert.equal(classified.platform, record.platform)
})
