import assert from 'node:assert/strict'
import test from 'node:test'
import {
  normalizeMobileCommerceQuery,
  publicMobileCommerceItem,
  publicMobileCommercePage,
} from '../../server/data/mobile-commerce.mjs'
import {
  applyMapping,
  refreshMappedPayloadSha256,
  validateFieldMap,
} from '../../server/ingest/external/mapping.mjs'
import {
  enrichMobileCommerceRecord,
  classifyMobileMarketplace,
  createMobileMarketplaceClassifier,
} from '../../server/ingest/mobile-commerce/record.mjs'
import {
  MobileCommercePipeline,
} from '../../server/ingest/mobile-commerce/pipeline.mjs'
import {
  MOBILE_COMMERCE_COLUMNS,
  MOBILE_COMMERCE_DATASET_ID,
  MOBILE_COMMERCE_MAPPING_ID,
  MOBILE_COMMERCE_MAPPING_VERSION,
  MOBILE_COMMERCE_OBJECT_TYPE,
  MOBILE_COMMERCE_PLATFORM,
  MOBILE_COMMERCE_SOURCE_KEY,
  MOBILE_COMMERCE_SOURCE_LOCATOR,
  mobileCommerceColumnIssues,
  mobileCommerceCursorIsFinite,
  mobileCommerceProbeIssues,
  mobileCommerceSourceContractIssues,
} from '../../server/ingest/mobile-commerce/source-contract.mjs'

const CURSOR_SECRET = 'mobile-commerce-test-cursor-secret'
const FIRST_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'

function expectAppError(callback, code, status = 400) {
  assert.throws(
    callback,
    (error) => error?.status === status && error?.code === code,
  )
}

function validColumns() {
  const required = new Set(['id', 'platform', 'title', 'collected_at'])
  return MOBILE_COMMERCE_COLUMNS.map((name) => ({
    name,
    databaseType: name === 'id'
      ? 'int8'
      : name === 'collected_at'
        ? 'timestamp'
        : name === 'is_reported'
          ? 'bool'
          : name === 'metadata_json'
            ? 'jsonb'
            : 'text',
    nullable: !required.has(name),
  }))
}

function cursorRow(id, sortTime) {
  return {
    id,
    external_id: id,
    sort_time: sortTime,
    collected_at: sortTime,
    current_revision: 1,
    stable_fields: {
      commerce: {
        captureId: id,
        product: { title: '测试商品', resolution: 'capture-only' },
        marketplace: { status: 'unmapped', sourceValue: '未知平台' },
      },
    },
  }
}

test('mobile-commerce queries validate filters, time bounds, page size and reserved refresh mode', () => {
  const normalized = normalizeMobileCommerceQuery({
    sourcePlatform: ' 快手小店 ',
    keyword: ' 老爸评测 ',
    brand: ' 日常监测 ',
    taskId: '7',
    from: '2026-08-19T00:00:00+08:00',
    to: '2026-08-20T00:00:00+08:00',
    pageSize: '25',
    refresh: 'stored',
  }, 500, CURSOR_SECRET)

  assert.deepEqual(normalized.filters, {
    sourcePlatform: '快手小店',
    catalogEntryId: null,
    keyword: '老爸评测',
    brand: '日常监测',
    taskId: '7',
    from: '2026-08-18T16:00:00.000Z',
    to: '2026-08-19T16:00:00.000Z',
  })
  assert.equal(normalized.pageSize, 25)
  assert.equal(normalized.refresh, 'stored')
  assert.equal(normalized.cursor, null)

  expectAppError(() => normalizeMobileCommerceQuery({ sql: 'select *' }), 'unsupported_fields')
  expectAppError(() => normalizeMobileCommerceQuery({ keyword: ['one', 'two'] }), 'invalid_request')
  expectAppError(() => normalizeMobileCommerceQuery({ from: '2026-08-19 00:00:00' }), 'invalid_request')
  expectAppError(() => normalizeMobileCommerceQuery({
    from: '2026-08-20T00:00:00Z',
    to: '2026-08-19T00:00:00Z',
  }), 'invalid_request')
  expectAppError(() => normalizeMobileCommerceQuery({ pageSize: '101' }, 500), 'page_size_exceeded')
  expectAppError(
    () => normalizeMobileCommerceQuery({ refresh: 'remote' }),
    'remote_fetch_unavailable',
    409,
  )
})

test('mobile-commerce cursors are signed and bound to every filter and page size', () => {
  const base = {
    sourcePlatform: '快手小店',
    keyword: '评测',
    brand: '日常监测',
    taskId: '7',
    from: '2026-08-18T00:00:00Z',
    to: '2026-08-20T00:00:00Z',
    pageSize: '1',
  }
  const query = normalizeMobileCommerceQuery(base, 100, CURSOR_SECRET)
  const page = publicMobileCommercePage([
    cursorRow(FIRST_ID, '2026-08-19T00:03:25.000Z'),
    cursorRow(SECOND_ID, '2026-08-18T00:03:25.000Z'),
  ], query, CURSOR_SECRET)
  const cursor = page.pageInfo.nextCursor

  assert.equal(page.pageInfo.hasMore, true)
  assert.equal(typeof cursor, 'string')
  assert.deepEqual(
    normalizeMobileCommerceQuery({ ...base, cursor }, 100, CURSOR_SECRET).cursor,
    { sortTime: '2026-08-19T00:03:25.000Z', id: FIRST_ID },
  )

  const changedQueries = [
    { ...base, sourcePlatform: '淘宝' },
    { ...base, keyword: '其他关键词' },
    { ...base, brand: '其他标签' },
    { ...base, taskId: '8' },
    { ...base, from: '2026-08-17T00:00:00Z' },
    { ...base, to: '2026-08-21T00:00:00Z' },
    { ...base, pageSize: '2' },
  ]
  for (const changed of changedQueries) {
    expectAppError(
      () => normalizeMobileCommerceQuery({ ...changed, cursor }, 100, CURSOR_SECRET),
      'invalid_cursor',
    )
  }

  const payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
  payload.s = `${payload.s.startsWith('A') ? 'B' : 'A'}${payload.s.slice(1)}`
  const tampered = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  expectAppError(
    () => normalizeMobileCommerceQuery({ ...base, cursor: tampered }, 100, CURSOR_SECRET),
    'invalid_cursor',
  )
  expectAppError(
    () => normalizeMobileCommerceQuery({ ...base, cursor }, 100, 'wrong-secret'),
    'invalid_cursor',
  )
})

test('mobile-commerce public projection is allowlisted and withholds collector/internal fields', () => {
  const projected = publicMobileCommerceItem({
    id: FIRST_ID,
    external_id: 'capture-4',
    title: '回退标题',
    author_name: '回退店铺',
    collected_at: new Date('2026-08-19T00:03:25.000Z'),
    current_revision: 3,
    metadata_json: { credential: 'raw-metadata-secret' },
    device_serial: 'device-secret',
    is_reported: true,
    raw_item: { private: 'raw-row-secret' },
    extensions: { private: 'extension-secret' },
    stable_fields: {
      commerce: {
        captureId: 'capture-4',
        task: { id: '7', keyword: '老爸评测', sourceBrandLabel: '老爸评测-日常监测' },
        product: {
          goodsId: null,
          title: '清洁剂',
          shareText: 'App 内复制的商品分享文案',
          price: '29.90',
          resolution: 'capture-only',
        },
        shop: { id: null, name: '测试小店', shareText: '店铺分享文案', level: null },
        signals: { sales: '100+', commentCount: '8', goodRate: '98%', tagsText: '日化' },
        marketplace: {
          status: 'mapped',
          sourceValue: '快手小店',
          entryId: 'ad537bbb-4eb0-5297-bcae-bd9d7a533d77',
          sourceKey: 'source-catalog-0063',
          revision: 1,
          canonicalName: '快手小店',
          majorCategory: '国内电商与本地生活',
          scenarios: ['内容电商'],
          regions: ['中国大陆'],
          privateCredential: 'catalog-secret',
        },
        metadata: { credential: 'typed-metadata-secret' },
        deviceSerial: 'nested-device-secret',
        isReported: true,
      },
    },
  })

  assert.deepEqual(Object.keys(projected).sort(), [
    'captureId', 'collectedAt', 'dataVersion', 'id', 'marketplace', 'product', 'shop', 'signals', 'task',
  ])
  assert.equal(projected.captureId, 'capture-4')
  assert.equal('shareText' in projected.product, false)
  assert.equal('shareText' in projected.shop, false)
  assert.equal(projected.product.resolution, 'capture-only')
  assert.equal(projected.marketplace.catalogSourceKey, 'source-catalog-0063')
  assert.equal(projected.collectedAt, '2026-08-19T00:03:25.000Z')
  const serialized = JSON.stringify(projected)
  for (const secret of [
    'raw-metadata-secret', 'device-secret', 'raw-row-secret', 'extension-secret',
    'typed-metadata-secret', 'nested-device-secret', 'catalog-secret',
    'App 内复制的商品分享文案', '店铺分享文案',
  ]) {
    assert.equal(serialized.includes(secret), false, secret)
  }
  assert.equal('isReported' in projected, false)
})

test('the fixed mobile-commerce source contract requires its identity and physical locator', () => {
  const source = {
    sourceKey: MOBILE_COMMERCE_SOURCE_KEY,
    sourceKind: 'database',
    datasetId: MOBILE_COMMERCE_DATASET_ID,
    platform: MOBILE_COMMERCE_PLATFORM,
    objectType: MOBILE_COMMERCE_OBJECT_TYPE,
    connection: { ...MOBILE_COMMERCE_SOURCE_LOCATOR },
  }
  assert.deepEqual(mobileCommerceSourceContractIssues(source), [])
  assert.deepEqual(mobileCommerceSourceContractIssues({
    ...source,
    platform: '快手小店',
    connection: { ...source.connection, table: 'other_table', token: 'not-allowed' },
  }), [
    `Fixed mobile-commerce source platform must be ${MOBILE_COMMERCE_PLATFORM}`,
    'Fixed mobile-commerce source connection.table must be mb_collected_items',
    'Fixed mobile-commerce source connection field token is not allowed',
  ])
})

test('mobile-commerce pipeline status never returns an inline database password', async () => {
  const source = {
    id: 'mobile-source-id',
    sourceKey: MOBILE_COMMERCE_SOURCE_KEY,
    sourceKind: 'database',
    datasetId: MOBILE_COMMERCE_DATASET_ID,
    platform: MOBILE_COMMERCE_PLATFORM,
    objectType: MOBILE_COMMERCE_OBJECT_TYPE,
    displayName: '手机端商家商品采集',
    status: 'paused',
    databaseConnectionId: null,
    connection: {
      host: 'database.internal',
      database: 'night_all',
      username: 'mobile_reader',
      password: 'inline-password-must-not-leak',
      sslMode: 'disable',
      ...MOBILE_COMMERCE_SOURCE_LOCATOR,
    },
    syncIntervalSeconds: 300,
  }
  const mapping = {
    id: MOBILE_COMMERCE_MAPPING_ID,
    version: MOBILE_COMMERCE_MAPPING_VERSION,
    sourceId: source.id,
    fieldMap: { externalId: { from: 'id' } },
  }
  const pipeline = new MobileCommercePipeline({
    store: {
      getExternalSource: async () => source,
      getActiveMapping: async () => null,
      listSourceMappings: async () => [mapping],
      listImportRuns: async () => [],
      getLatestPipelineWriterContractAttestation: async () => null,
    },
    queue: { getCursor: async () => null },
    databasePuller: {
      resolveConnectionCandidate: async () => ({ connection: source.connection }),
    },
  })

  const result = await pipeline.get()
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('inline-password-must-not-leak'), false)
  assert.equal('password' in result.connection, false)
  assert.equal(result.connection.passwordConfigured, true)
  assert.equal('password' in result.task.source.connection, false)
  assert.equal(result.task.source.connection.passwordConfigured, true)
  await assert.rejects(
    () => pipeline.configure({ databaseConnectionId: 'not-a-uuid' }),
    (error) => error?.status === 400 && error?.code === 'invalid_database_connection_id',
  )
  source.connection = { dsnEnv: 'MOBILE_DATABASE_URL', ...MOBILE_COMMERCE_SOURCE_LOCATOR }
  const dsnConfiguration = await pipeline.get()
  assert.equal(dsnConfiguration.configured, false)
  assert.ok(dsnConfiguration.configurationIssues.some((issue) => issue.includes('dsnEnv')))
})

test('the mobile-commerce probe enforces all 25 fixed columns, required nullability and scalar types', () => {
  const columns = validColumns()
  assert.equal(MOBILE_COMMERCE_COLUMNS.length, 25)
  assert.deepEqual(mobileCommerceColumnIssues(columns), [])
  assert.deepEqual(
    mobileCommerceColumnIssues([...columns, { name: 'new_unreviewed_field', databaseType: 'text', nullable: true }]),
    ['unexpected mobile-commerce column new_unreviewed_field requires mapping review'],
  )
  assert.equal(mobileCommerceCursorIsFinite(new Date('2026-08-19T00:03:25Z')), true)
  assert.equal(mobileCommerceCursorIsFinite('2026-08-19T00:03:25Z'), true)
  for (const cursor of ['infinity', '-infinity', Number.POSITIVE_INFINITY, new Date(Number.NaN)]) {
    assert.equal(mobileCommerceCursorIsFinite(cursor), false)
  }

  for (const name of MOBILE_COMMERCE_COLUMNS) {
    assert.deepEqual(
      mobileCommerceColumnIssues(columns.filter((column) => column.name !== name)),
      [`required mobile-commerce column ${name} is missing`],
      name,
    )
  }

  for (const name of ['id', 'platform', 'title', 'collected_at']) {
    const nullable = columns.map((column) => column.name === name ? { ...column, nullable: true } : column)
    assert.ok(mobileCommerceColumnIssues(nullable).includes(`required mobile-commerce column ${name} must be non-null`))
  }
  const wrongTypes = columns.map((column) => {
    if (column.name === 'id') return { ...column, databaseType: 'jsonb' }
    if (column.name === 'collected_at') return { ...column, databaseType: 'text' }
    return column
  })
  assert.deepEqual(mobileCommerceColumnIssues(wrongTypes), [
    'collected_at must be timestamp or timestamptz',
    'id must be an integer, UUID, or text scalar',
  ])

  assert.deepEqual(mobileCommerceProbeIssues({
    issues: ['writer contract is not attested', 'required mobile-commerce column title is missing'],
    columns: columns.filter((column) => column.name !== 'title'),
  }), [
    'writer contract is not attested',
    'required mobile-commerce column title is missing',
  ])
})

test('mobile marketplace values map through the governed source catalog and keep unknowns explicit', () => {
  const expected = new Map([
    ['快手小店', ['source-catalog-0063', '快手小店']],
    ['抖音小店', ['source-catalog-0062', '抖音电商']],
    ['淘宝', ['source-catalog-0058', '淘宝']],
    ['闲鱼', ['source-catalog-0073', '闲鱼']],
  ])
  for (const [sourceValue, [sourceKey, canonicalName]] of expected) {
    const classified = classifyMobileMarketplace(` ${sourceValue} `)
    assert.equal(classified.status, 'mapped', sourceValue)
    assert.equal(classified.sourceKey, sourceKey, sourceValue)
    assert.equal(classified.canonicalName, canonicalName, sourceValue)
    assert.equal(classified.sourceValue, sourceValue, sourceValue)
    assert.equal(classified.majorCategory, '国内电商与本地生活', sourceValue)
  }

  assert.deepEqual(classifyMobileMarketplace('未来平台'), {
    status: 'unmapped',
    sourceValue: '未来平台',
    entryId: null,
    sourceKey: null,
    revision: null,
    canonicalName: null,
    majorCategory: null,
    scenarios: [],
    regions: [],
  })
})

test('mobile marketplace classification uses the current governed catalog snapshot', () => {
  const catalogEntry = {
    id: 'ad537bbb-4eb0-5297-bcae-bd9d7a533d77',
    sourceKey: 'source-catalog-0063',
    revision: 7,
    canonicalName: '快手电商',
    aliases: ['快手商城'],
    majorCategory: '国内电商与本地生活',
    scenarios: ['内容电商'],
    regions: ['中国大陆'],
    archivedAt: null,
  }
  const classify = createMobileMarketplaceClassifier([catalogEntry])

  assert.equal(classify('快手商城').revision, 7)
  assert.equal(classify('快手').canonicalName, '快手电商')
  assert.equal(classify('淘宝').status, 'unmapped')
  assert.equal(createMobileMarketplaceClassifier([{ ...catalogEntry, archivedAt: '2026-09-01T00:00:00Z' }])('快手').status, 'unmapped')
})

test('mobile enrichment treats a missing goods_id as capture-only identity', () => {
  const record = {
    stableFields: { attributes: { existing: 'kept' } },
  }
  const raw = {
    id: 4,
    platform: '快手小店',
    task_id: 7,
    keyword: '老爸评测',
    brand: '老爸评测-日常监测',
    title: '清洁剂',
    product_link: 'App 内商品分享文案',
    shop_name: '测试小店',
    shop_link: 'App 内店铺分享文案',
    goods_id: null,
    shop_id: null,
    price: '29.90',
    tags: '日化，测评;清洁',
    metadata_json: '{"collectorVersion":"1.2.3"}',
    device_serial: 'private-device',
    is_reported: false,
  }

  const enriched = enrichMobileCommerceRecord(record, raw, { sourceKey: MOBILE_COMMERCE_SOURCE_KEY })
  assert.equal(enriched, record)
  assert.equal(enriched.stableFields.attributes.existing, 'kept')
  assert.equal(enriched.stableFields.attributes.sourceCatalogSourceKey, 'source-catalog-0063')
  assert.equal(enriched.stableFields.commerce.captureId, '4')
  assert.equal(enriched.stableFields.commerce.product.goodsId, null)
  assert.equal(enriched.stableFields.commerce.product.resolution, 'capture-only')
  assert.equal(enriched.stableFields.commerce.product.shareText, 'App 内商品分享文案')
  assert.equal(enriched.stableFields.commerce.task.sourceBrandLabel, '老爸评测-日常监测')
  assert.deepEqual(enriched.stableFields.commerce.metadata, { collectorVersion: '1.2.3' })
  assert.deepEqual(enriched.stableFields.tags, ['日化', '测评', '清洁'])
  assert.equal(JSON.stringify(enriched.stableFields.commerce).includes('private-device'), false)
  assert.equal('isReported' in enriched.stableFields.commerce, false)

  const withGoodsId = enrichMobileCommerceRecord(
    { stableFields: {} },
    { ...raw, goods_id: 'goods-99' },
    { sourceKey: MOBILE_COMMERCE_SOURCE_KEY },
  )
  assert.equal(withGoodsId.stableFields.commerce.product.goodsId, 'goods-99')
  assert.equal(withGoodsId.stableFields.commerce.product.resolution, 'source-goods-id')

  const unrelated = { stableFields: {} }
  assert.equal(enrichMobileCommerceRecord(unrelated, raw, { sourceKey: 'another-source' }), unrelated)
  assert.deepEqual(unrelated, { stableFields: {} })
})

test('catalog enrichment participates in the canonical projection digest', () => {
  const fieldMap = {
    externalId: { from: 'id' },
    title: { from: 'title' },
  }
  const raw = { id: 4, title: '测试商品', platform: '快手' }
  const first = applyMapping(raw, fieldMap, { platform: MOBILE_COMMERCE_PLATFORM }).record
  const second = applyMapping(raw, fieldMap, { platform: MOBILE_COMMERCE_PLATFORM }).record
  const entry = {
    id: 'ad537bbb-4eb0-5297-bcae-bd9d7a533d77',
    sourceKey: 'source-catalog-0063',
    canonicalName: '快手小店',
    aliases: [],
    majorCategory: '国内电商与本地生活',
    scenarios: ['内容电商'],
    regions: ['中国大陆'],
    archivedAt: null,
  }

  enrichMobileCommerceRecord(first, raw, { sourceKey: MOBILE_COMMERCE_SOURCE_KEY }, {
    classifyMarketplace: createMobileMarketplaceClassifier([{ ...entry, revision: 1 }]),
  })
  enrichMobileCommerceRecord(second, raw, { sourceKey: MOBILE_COMMERCE_SOURCE_KEY }, {
    classifyMarketplace: createMobileMarketplaceClassifier([{ ...entry, revision: 2 }]),
  })
  refreshMappedPayloadSha256(first)
  refreshMappedPayloadSha256(second)

  assert.notEqual(first.payloadSha256, second.payloadSha256)
})

test('mapping applies Asia/Shanghai offset to naive collected_at values deterministically', () => {
  const fieldMap = {
    externalId: { from: 'id' },
    collectedAt: { from: 'collected_at', type: 'timestamp', timezoneOffsetMinutes: 480 },
  }
  assert.equal(validateFieldMap(fieldMap), true)

  const naive = applyMapping({
    id: 4,
    collected_at: '2026-08-19 00:03:25.125',
  }, fieldMap, { platform: MOBILE_COMMERCE_PLATFORM }).record
  assert.equal(naive.collectedAt.toISOString(), '2026-08-18T16:03:25.125Z')

  const explicit = applyMapping({
    id: 5,
    collected_at: '2026-08-19T00:03:25+08:00',
  }, fieldMap, { platform: MOBILE_COMMERCE_PLATFORM }).record
  assert.equal(explicit.collectedAt.toISOString(), '2026-08-18T16:03:25.000Z')

  const invalidCalendarDate = applyMapping({
    id: 6,
    collected_at: '2026-02-31 00:03:25',
  }, {
    externalId: { from: 'id' },
    eventTime: { from: 'collected_at', type: 'timestamp', timezoneOffsetMinutes: 480 },
  }, { platform: MOBILE_COMMERCE_PLATFORM }).record
  assert.equal(invalidCalendarDate.eventTime, null)

  const leapDay = applyMapping({
    id: 7,
    collected_at: '2024-02-29 00:03:25',
  }, fieldMap, { platform: MOBILE_COMMERCE_PLATFORM }).record
  assert.equal(leapDay.collectedAt.toISOString(), '2024-02-28T16:03:25.000Z')

  const microseconds = applyMapping({
    id: 8,
    collected_at: '2026-08-19 00:03:25.125987',
  }, fieldMap, { platform: MOBILE_COMMERCE_PLATFORM }).record
  assert.equal(microseconds.collectedAt.toISOString(), '2026-08-18T16:03:25.125Z')

  assert.throws(
    () => validateFieldMap({
      externalId: { from: 'id' },
      title: { from: 'title', timezoneOffsetMinutes: 480 },
    }),
    /supported only for timestamp targets/,
  )
  for (const timezoneOffsetMinutes of [480.5, -841, 841]) {
    assert.throws(
      () => validateFieldMap({
        externalId: { from: 'id' },
        collectedAt: { from: 'collected_at', timezoneOffsetMinutes },
      }),
      /must be an integer between -840 and 840/,
    )
  }
})
