import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeJustOneProductSearchRequest } from '../../server/contracts/justone.mjs'
import { canonicalJson, observationHash, sha256 } from '../../server/ingest/normalizers.mjs'
import {
  JUSTONE_DATASET_ID,
  JUSTONE_MARKETPLACE_CATALOG,
  JUSTONE_PARSER_VERSION,
  normalizeJustOneProductSearchPayload,
  prepareJustOneArchiveObjects,
  rehydrateJustOneQueuedRecords,
} from '../../server/ingest/justone.mjs'
import { buildContentDocument } from '../../server/search/document.mjs'

function envelope(items, extra = {}) {
  return {
    code: 0,
    message: null,
    data: { items, hasMore: false, ...extra },
    recordTime: '2026-09-03T00:00:00Z',
    requestId: 'request-1',
  }
}

function product(id, title = '商品') {
  return {
    itemId: id,
    title,
    itemUrl: `https://example.invalid/items/${id}`,
    shopId: 'shop-1',
    shopName: '示例店铺',
    price: '88.00',
    originalPrice: '99.00',
    commentCount: '12',
    sales: '100+',
    imageUrls: ['https://example.invalid/image.jpg'],
  }
}

test('canonical identity never uses page or result index and duplicates collapse', () => {
  const firstRequest = normalizeJustOneProductSearchRequest({
    marketplace: 'taobao', query: '面霜', page: 1,
  })
  const first = normalizeJustOneProductSearchPayload(
    envelope([product('same-id'), product('same-id')]),
    firstRequest,
    { capturedAt: '2026-09-03T00:00:00Z' },
  )
  assert.equal(first.records.length, 1)
  assert.equal(first.duplicates, 1)
  assert.equal(first.records[0].externalId, 'taobao:same-id')

  const laterRequest = normalizeJustOneProductSearchRequest({
    marketplace: 'taobao', query: '另一个关键词', page: 9,
  })
  const later = normalizeJustOneProductSearchPayload(
    envelope([product('other-id'), product('same-id')]),
    laterRequest,
    { capturedAt: '2026-09-04T00:00:00Z' },
  )
  assert.equal(later.records[1].externalId, first.records[0].externalId)
  assert.equal(later.records[1].payloadSha256, first.records[0].payloadSha256)
  assert.equal(later.records[1].rawPayloadSha256, first.records[0].rawPayloadSha256)
  assert.notEqual(later.records[1].rank, first.records[0].rank)
  assert.notEqual(later.records[1].collectedAt.toISOString(), first.records[0].collectedAt.toISOString())
})

test('an item without a source product ID is skipped instead of receiving a positional ID', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '手机' })
  const normalized = normalizeJustOneProductSearchPayload(envelope([
    { title: '没有 ID', page: 1, index: 0 },
    { skuId: 'jd-1', title: '有 ID' },
  ]), request)
  assert.equal(normalized.records.length, 1)
  assert.equal(normalized.skipped, 1)
  assert.equal(normalized.records[0].externalId, 'jd:jd-1')
  assert.doesNotMatch(normalized.records[0].externalId, /page|index/iu)
})

test('records use the ecommerce canonical shape with catalog mapping and lineage', () => {
  for (const marketplace of Object.keys(JUSTONE_MARKETPLACE_CATALOG)) {
    const request = normalizeJustOneProductSearchRequest({ marketplace, query: 'test' })
    const idField = marketplace === 'jd' ? 'skuId'
      : marketplace === 'xiaohongshu_ec' ? 'goodsId'
        : 'itemId'
    const normalized = normalizeJustOneProductSearchPayload(envelope([{
      [idField]: `${marketplace}-1`, title: `${marketplace} 商品`,
    }]), request, { capturedAt: '2026-09-03T00:00:00Z' })
    const record = normalized.records[0]
    const catalog = JUSTONE_MARKETPLACE_CATALOG[marketplace]
    assert.equal(record.platform, 'ecommerce')
    assert.equal(record.objectType, 'product')
    assert.equal(record.parserVersion, JUSTONE_PARSER_VERSION)
    assert.equal(record.stableFields.commerce.marketplace.entryId, catalog.entryId)
    assert.equal(record.stableFields.commerce.marketplace.sourceKey, catalog.sourceKey)
    assert.equal(record.stableFields.attributes.sourceCatalogEntryId, catalog.entryId)
    assert.deepEqual(record.stableFields.source, {
      connectorId: 'external-platform:justone',
      operation: 'ecommerce.products.search',
      connectorContractVersion: request.endpointContractVersion,
      endpointKey: request.endpointKey,
      endpointVersion: 'v1',
    })
    assert.equal(
      record.stableFields.source.connectorContractVersion,
      ['taobao', 'tmall'].includes(marketplace)
        ? 'justone.product-search.v2'
        : 'justone.product-search.v1',
    )
    assert.match(record.rawPayloadSha256, /^[a-f0-9]{64}$/u)
    assert.match(record.payloadSha256, /^[a-f0-9]{64}$/u)
    assert.equal(normalized.archiveObjects.length, 2)
    const responseArchive = normalized.archiveObjects.find((object) => object.kind === 'response')
    const itemArchive = normalized.archiveObjects.find((object) => object.kind === 'item')
    assert.equal(responseArchive.marketplace, marketplace)
    assert.equal(responseArchive.endpointVersion, 'v1')
    assert.equal(responseArchive.sourceKey, catalog.sourceKey)
    assert.equal(responseArchive.rawPayload.kind, 'provider_call_evidence')
    assert.equal(responseArchive.rawPayload.response.requestId, 'request-1')
    assert.match(
      responseArchive.archivePath,
      new RegExp(`^justone/${marketplace}/product-search/v1/2026-09-03/responses/[a-f0-9]{64}\\.json$`, 'u'),
    )
    assert.equal(itemArchive.marketplace, marketplace)
    assert.equal(itemArchive.endpointVersion, 'v1')
    assert.equal(itemArchive.sourceKey, catalog.sourceKey)
    assert.equal(itemArchive.payloadSha256, record.rawPayloadSha256)
    assert.deepEqual(itemArchive.rawPayload, itemArchive.rawItem)
    assert.equal(itemArchive.rawPointer, '$')
    assert.equal(itemArchive.envelopePointer, '$.data.items[0]')
    assert.equal(record.sourcePointer, '$')
    assert.match(
      itemArchive.archivePath,
      new RegExp(`^justone/${marketplace}/product-search/v1/2026-09-03/items/[a-f0-9]{64}\\.json$`, 'u'),
    )
  }
})

test('an empty page still produces one store-ready response archive and no fake skipped item', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '不存在的商品' })
  const normalized = normalizeJustOneProductSearchPayload(envelope([]), request, {
    capturedAt: '2026-09-03T00:00:00Z',
    httpStatus: 200,
    bodySha256: 'b'.repeat(64),
    bodySize: 128,
    contentType: 'application/json',
  })
  assert.equal(normalized.records.length, 0)
  assert.equal(normalized.skipped, 0)
  assert.equal(normalized.archiveObjects.length, 1)
  const [archive] = normalized.archiveObjects
  assert.equal(archive.kind, 'response')
  assert.equal(archive.rawPayload.response.envelope.data.items.length, 0)
  assert.equal(archive.rawPayload.response.bodySize, 128)
  assert.equal(archive.rawPayload.response.contentType, 'application/json')
  assert.equal(archive.rawPayload.response.contractState, 'accepted')
  assert.match(archive.archivePath, /\/responses\/[a-f0-9]{64}\.json$/u)
})

test('archive capturedDate and directory date are derived in UTC', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '相机' })
  const [archive] = prepareJustOneArchiveObjects([{
    kind: 'response',
    rawPayloadSha256: 'a'.repeat(64),
    rawItem: { code: 0, data: { items: [] } },
  }], request, { capturedAt: '2026-09-03T00:30:00+08:00' })

  assert.equal(archive.capturedDate, '2026-09-02')
  assert.match(archive.archivePath, /\/2026-09-02\/responses\//u)
})

test('canonical, PG-bound and ES projections retain JustOne business fields but not the request credential', async () => {
  const secret = 'top-secret-token'
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'xianyu', query: '相机' })
  const raw = envelope([{
    ...product('xy-1'),
    itemUrl: 'https://example.invalid/items/xy-1?signature=business-signature&search_id=business-search#session_id=business-session',
    signature: 'business-signature',
    search_id: 'business-search',
    session_id: 'business-session',
    token: secret,
    provider: 'justone-business-source',
    billing: { units: 1 },
    nested: {
      credential: secret,
      callback: `https://example.invalid/callback?signature=business-signature&token=${secret}#business-fragment`,
    },
  }], {
    search_id: 'response-business-search',
    search_session_id: 'response-business-session',
    signedUrl: 'https://example.invalid/next?signature=response-business-signature#response-fragment',
    token: secret,
  })
  raw.provider = 'justone-response-source'
  raw.billing = { units: 2 }
  const normalized = normalizeJustOneProductSearchPayload(raw, request, { secret })
  const record = normalized.records[0]
  const serialized = JSON.stringify(record)
  assert.doesNotMatch(serialized, /top-secret-token/u)
  assert.equal(record.url, 'https://example.invalid/items/xy-1?signature=business-signature&search_id=business-search#session_id=business-session')
  assert.equal(record.rawItem.signature, 'business-signature')
  assert.equal(record.rawItem.search_id, 'business-search')
  assert.equal(record.rawItem.session_id, 'business-session')
  assert.equal(record.rawItem.token, '[REDACTED]')
  assert.equal(record.rawItem.nested.credential, '[REDACTED]')
  assert.equal(
    record.rawItem.nested.callback,
    'https://example.invalid/callback?signature=business-signature&token=[REDACTED]#business-fragment',
  )
  // `extensions` is the value passed unchanged to PostgreSQL's canonical row.
  assert.deepEqual(record.extensions.sourceItem, record.rawItem)
  assert.equal(record.extensions.sourceItem.provider, 'justone-business-source')
  assert.deepEqual(record.extensions.sourceItem.billing, { units: 1 })
  assert.equal(record.extensions.sourceResponse.provider, 'justone-response-source')
  assert.deepEqual(record.extensions.sourceResponse.billing, { units: 2 })
  assert.equal(record.extensions.sourceResponse.data.search_id, 'response-business-search')
  assert.equal(record.extensions.sourceResponse.data.search_session_id, 'response-business-session')
  assert.deepEqual(record.extensions.sourceResponse.data.items, [])
  assert.equal(record.extensions.sourceResponse.data.token, '[REDACTED]')
  assert.equal(
    record.rawPayloadSha256,
    sha256(canonicalJson(record.rawItem)),
  )

  const document = await buildContentDocument({
    id: 'justone-record-1',
    dataset_id: JUSTONE_DATASET_ID,
    schema_version: 'external.v1',
    current_revision: 1,
    projection_revision: 1,
    payload_sha256: record.payloadSha256,
    platform: record.platform,
    object_type: record.objectType,
    external_id: record.externalId,
    content_type: record.contentType,
    url: record.url,
    title: record.title,
    body: record.body,
    author_external_id: record.authorExternalId,
    author_name: record.authorName,
    event_time: record.eventTime,
    collected_at: record.collectedAt,
    country_code: record.countryCode,
    admin1_code: record.admin1Code,
    admin2_code: record.admin2Code,
    stable_fields: record.stableFields,
    extensions: record.extensions,
  }, {
    segmenter: { segment: async (text) => text ? [text] : [] },
  })
  assert.equal(document.extensions.sourceItem.signature, 'business-signature')
  assert.equal(document.extensions.sourceItem.search_id, 'business-search')
  assert.equal(document.extensions.sourceItem.session_id, 'business-session')
  assert.equal(document.extensions.sourceItem.provider, 'justone-business-source')
  assert.deepEqual(document.extensions.sourceItem.billing, { units: 1 })
  assert.equal(document.extensions.sourceResponse.data.search_id, 'response-business-search')
  assert.equal(document.extensions.sourceResponse.data.search_session_id, 'response-business-session')
  assert.match(document.extensions.sourceResponse.data.signedUrl, /#response-fragment$/u)
  assert.equal(document.extensions.sourceResponse.data.token, '[REDACTED]')
  assert.match(document.extensions.sourceItem.itemUrl, /signature=business-signature/u)
  assert.match(document.extensions.sourceItem.itemUrl, /#session_id=business-session$/u)
  assert.equal(document.extensions.sourceItem.token, '[REDACTED]')
  assert.doesNotMatch(JSON.stringify(document), /top-secret-token/u)

  const changedBusinessEvidence = normalizeJustOneProductSearchPayload(envelope([{
    ...product('xy-1'),
    token: secret,
    provider: 'different-business-source',
    signature: 'different-business-signature',
    nested: {
      credential: secret,
      callback: `https://example.invalid/callback?token=${secret}`,
    },
  }]), request, { secret }).records[0]
  assert.notEqual(record.rawPayloadSha256, changedBusinessEvidence.rawPayloadSha256)
  assert.notEqual(record.payloadSha256, changedBusinessEvidence.payloadSha256)
})

test('content and raw hashes change when the product itself changes', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'tmall', query: '面霜' })
  const before = normalizeJustOneProductSearchPayload(envelope([product('tm-1', '旧标题')]), request, {
    capturedAt: '2026-09-03T00:00:00Z',
  }).records[0]
  const after = normalizeJustOneProductSearchPayload(envelope([product('tm-1', '新标题')]), request, {
    capturedAt: '2026-09-03T00:01:00Z',
  }).records[0]
  assert.equal(before.externalId, after.externalId)
  assert.notEqual(before.rawPayloadSha256, after.rawPayloadSha256)
  assert.notEqual(before.payloadSha256, after.payloadSha256)
})

test('JSONB queued records restore canonical time fields before observation hashing', () => {
  const request = normalizeJustOneProductSearchRequest({ marketplace: 'jd', query: '相机' })
  const record = normalizeJustOneProductSearchPayload(envelope([product('jd-1')]), request, {
    capturedAt: '2026-09-03T00:00:00.123Z',
  }).records[0]
  Object.assign(record, {
    eventTime: new Date('2026-09-02T23:59:00.000Z'),
    editedAt: new Date('2026-09-03T00:00:01.000Z'),
    deletedAt: null,
    observedAt: new Date('2026-09-03T08:00:02.456+08:00'),
  })

  const roundTripped = JSON.parse(JSON.stringify([record]))
  const [hydrated] = rehydrateJustOneQueuedRecords(roundTripped)

  for (const field of ['eventTime', 'collectedAt', 'editedAt', 'observedAt']) {
    assert.ok(hydrated[field] instanceof Date, `${field} is restored as Date`)
    assert.equal(hydrated[field].toISOString(), roundTripped[0][field])
  }
  assert.equal(hydrated.deletedAt, null)
  assert.match(
    observationHash(hydrated, 'f'.repeat(64), 'provider-call-1:product:jd:jd-1'),
    /^[a-f0-9]{64}$/u,
  )
})

test('queued record timestamp hydration fails closed on missing or malformed values', () => {
  const valid = { collectedAt: '2026-09-03T00:00:00.000Z' }
  for (const record of [
    {},
    { collectedAt: null },
    { collectedAt: 1_788_393_600_000 },
    { collectedAt: '2026-09-03T00:00:00' },
    { collectedAt: '2026-02-29T00:00:00Z' },
    { ...valid, observedAt: 'not-a-timestamp' },
    { ...valid, eventTime: '2026-09-03T25:00:00Z' },
  ]) {
    assert.throws(() => rehydrateJustOneQueuedRecords([record]), /external-platform record 0/u)
  }
  assert.throws(() => rehydrateJustOneQueuedRecords([null]), /record 0 must be an object/u)
})
