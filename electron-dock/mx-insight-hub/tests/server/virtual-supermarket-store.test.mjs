import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  publicVirtualSupermarketProduct,
  VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID,
} from '../../server/data/virtual-supermarket.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'

const RECORD_ID = '71000000-0000-4000-8000-000000000001'
const PUBLICATION_ID = '72000000-0000-4000-8000-000000000001'
const CATEGORY_ID = '73000000-0000-4000-8000-000000000001'
const CONFLICTING_CATEGORY_ID = '73000000-0000-4000-8000-000000000002'

function categoryInput({
  categoryKey = 'laundry-care',
  displayName = '洗护用品',
  department = { key: 'home', name: '家居馆', sortOrder: 10 },
  aisle = { key: 'cleaning', name: '清洁通道', sortOrder: 20 },
  shelf = { key: 'laundry', name: '洗衣货架', sortOrder: 30 },
  sortOrder = 40,
} = {}) {
  return { categoryKey, displayName, department, aisle, shelf, sortOrder }
}

function postgresCategoryRow(overrides = {}) {
  return {
    id: CATEGORY_ID,
    category_key: 'laundry-care',
    display_name: '洗护用品',
    department_key: 'home',
    department_name: '家居馆',
    department_sort_order: 10,
    aisle_key: 'cleaning',
    aisle_name: '清洁通道',
    aisle_sort_order: 20,
    shelf_key: 'laundry',
    shelf_name: '洗衣货架',
    shelf_sort_order: 30,
    sort_order: 40,
    revision: 1,
    archived_at: null,
    created_at: new Date('2026-09-01T00:00:00.000Z'),
    updated_at: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  }
}

function canonicalRecord() {
  return {
    id: RECORD_ID,
    datasetId: 'mobile-commerce.collected-items.v1',
    platform: 'mobile_commerce',
    objectType: 'commerce_capture',
    externalId: 'capture-1',
    title: '来源商品',
    authorName: '来源店铺',
    currentRevision: 4,
    projectionRevision: 11,
    collectedAt: '2026-09-01T00:00:00.000Z',
    deletedAt: null,
    stableFields: {
      commerce: {
        captureId: 'capture-1',
        product: { title: '来源商品', price: '10.00', goodsId: null, resolution: 'capture-only' },
        shop: { name: '来源店铺' },
        signals: { sales: '已售1件', tagsText: '内部混合标签' },
        marketplace: { status: 'mapped', sourceValue: '快手小店', entryId: null },
      },
    },
  }
}

function postgresJoinedRow({ status = 'on_shelf', revision = 1 } = {}) {
  const record = canonicalRecord()
  return {
    id: record.id,
    external_id: record.externalId,
    title: record.title,
    author_name: record.authorName,
    collected_at: new Date(record.collectedAt),
    current_revision: record.currentRevision,
    stable_fields: record.stableFields,
    listing_explicit: true,
    publication_id: PUBLICATION_ID,
    listing_status: status,
    listing_category_id: VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID,
    display_title: null,
    specification: null,
    price_amount: null,
    currency: null,
    shelf_position: null,
    listing_revision: revision,
    created_by: 'pg-test',
    updated_by: 'pg-test',
    listing_created_at: new Date('2026-09-01T01:00:00.000Z'),
    listing_updated_at: new Date('2026-09-01T01:00:00.000Z'),
    category_id: VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID,
    category_key: 'uncategorized',
    category_display_name: '待分类',
    department_key: 'uncategorized',
    department_name: '待分类区',
    department_sort_order: 1_000_000,
    aisle_key: 'uncategorized',
    aisle_name: '待整理通道',
    aisle_sort_order: 1_000_000,
    shelf_key: 'uncategorized',
    shelf_name: '待整理货架',
    shelf_sort_order: 1_000_000,
    category_sort_order: 1_000_000,
    category_revision: 1,
    category_archived_at: null,
    category_created_at: new Date('2026-09-01T00:00:00.000Z'),
    category_updated_at: new Date('2026-09-01T00:00:00.000Z'),
    effective_title: '来源商品',
    effective_price: '10.00',
  }
}

test('migration 050 keeps source truth separate and installs publication audit plus storefront revision', async () => {
  const sql = await readFile(new URL('../../migrations/050_virtual_supermarket.sql', import.meta.url), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS serving\.virtual_supermarket_storefront/u)
  assert.match(sql, /inventory_revision bigint NOT NULL DEFAULT 1/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS serving\.virtual_supermarket_categories/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS serving\.virtual_supermarket_listing_state/u)
  assert.match(sql, /publication_id uuid UNIQUE/u)
  assert.match(sql, /publication_id IS NULL OR publication_id <> record_id/u)
  assert.match(sql, /status <> 'on_shelf' OR publication_id IS NOT NULL/u)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS serving\.virtual_supermarket_events/u)
  assert.match(sql, /status IN \('on_shelf', 'off_shelf'\)/u)
  assert.match(sql, /REFERENCES core\.canonical_records\(id\) ON DELETE RESTRICT/u)
  assert.match(sql, /UNIQUE \(aggregate_type, aggregate_id, to_revision\)/u)
  assert.match(sql, /CREATE TRIGGER virtual_supermarket_canonical_change/u)
  assert.match(sql, /CREATE TRIGGER virtual_supermarket_inventory_insert\s+AFTER INSERT ON core\.canonical_records\s+REFERENCING NEW TABLE AS inserted_rows\s+FOR EACH STATEMENT/us)
  assert.match(sql, /CREATE TRIGGER virtual_supermarket_inventory_update\s+AFTER UPDATE ON core\.canonical_records\s+REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows\s+FOR EACH STATEMENT/us)
  assert.match(sql, /CREATE TRIGGER virtual_supermarket_inventory_delete\s+AFTER DELETE ON core\.canonical_records\s+REFERENCING OLD TABLE AS deleted_rows\s+FOR EACH STATEMENT/us)
  assert.match(sql, /inventory_revision = inventory_revision \+ 1/u)
  assert.match(sql, /changed\.dataset_id = 'mobile-commerce\.collected-items\.v1'/u)
  assert.match(sql, /changed\.platform = 'mobile_commerce'/u)
  assert.match(sql, /changed\.object_type = 'commerce_capture'/u)
  assert.match(sql, /listing\.status = 'on_shelf'/u)
  assert.match(sql, /virtual_supermarket_events_no_row_mutation/u)
  assert.match(sql, /virtual_supermarket_events_no_truncate/u)
  assert.match(sql, /virtual_supermarket_events is append-only/u)
  assert.doesNotMatch(sql, /UPDATE\s+core\.canonical_records/iu)
  assert.doesNotMatch(sql, /DELETE\s+FROM/iu)
  assert.doesNotMatch(sql, /checkpoint/iu)
})

test('Postgres listing mutation writes only serving state, storefront revision and append-only audit', async () => {
  const calls = []
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT id FROM core.canonical_records')) return { rows: [{ id: RECORD_ID }], rowCount: 1 }
      if (sql.includes('SELECT * FROM serving.virtual_supermarket_listing_state')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT id FROM serving.virtual_supermarket_categories')) {
        return { rows: [{ id: VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO serving.virtual_supermarket_listing_state')) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE serving.virtual_supermarket_storefront')) {
        return { rows: [{ revision: 2 }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO serving.virtual_supermarket_events')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM core.canonical_records record')) {
        return { rows: [postgresJoinedRow()], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  const result = await store.updateVirtualSupermarketProduct(
    RECORD_ID,
    { status: 'on_shelf' },
    { expectedRevision: 0, actor: 'pg-test', eventType: 'publish', reason: 'reviewed' },
  )
  assert.equal(result.storefrontRevision, 2)
  assert.equal(result.item.listing.status, 'on_shelf')
  assert.equal(result.item.listing.revision, 1)
  assert.equal(result.item.listing.publicationId, PUBLICATION_ID)
  const sql = calls.map((call) => call.sql).join('\n')
  assert.match(sql, /INSERT INTO serving\.virtual_supermarket_listing_state/u)
  assert.match(sql, /UPDATE serving\.virtual_supermarket_storefront/u)
  assert.match(sql, /INSERT INTO serving\.virtual_supermarket_events/u)
  assert.doesNotMatch(sql, /UPDATE\s+core\.canonical_records/iu)
  assert.doesNotMatch(sql, /UPDATE\s+catalog\.external_sources/iu)
  assert.doesNotMatch(sql, /checkpoint/iu)
  const listingWrite = calls.find((call) => call.sql.includes('INSERT INTO serving.virtual_supermarket_listing_state'))
  assert.match(listingWrite.sql, /WHERE serving\.virtual_supermarket_listing_state\.revision = \$12/u)
  assert.notEqual(listingWrite.values[1], RECORD_ID)
  assert.match(listingWrite.values[1], /^[0-9a-f-]{36}$/u)
  assert.equal(listingWrite.values[11], 0)
  const event = calls.find((call) => call.sql.includes('INSERT INTO serving.virtual_supermarket_events'))
  assert.equal(event.values[2], 'publish')
  assert.equal(event.values[6], 2)
  assert.equal(event.values[7], 'reviewed')
})

test('Postgres first-publish upsert reports an optimistic conflict after a concurrent insert', async () => {
  const calls = []
  const client = {
    async query(sql) {
      calls.push(sql)
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT id FROM core.canonical_records')) return { rows: [{ id: RECORD_ID }], rowCount: 1 }
      if (sql.includes('SELECT * FROM serving.virtual_supermarket_listing_state')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT id FROM serving.virtual_supermarket_categories')) {
        return { rows: [{ id: VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO serving.virtual_supermarket_listing_state')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT revision FROM serving.virtual_supermarket_listing_state')) {
        return { rows: [{ revision: 1 }], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const store = new PostgresStore({ connect: async () => client })
  await assert.rejects(
    store.updateVirtualSupermarketProduct(
      RECORD_ID,
      { status: 'on_shelf' },
      { expectedRevision: 0, actor: 'pg-test', eventType: 'publish' },
    ),
    (error) => (
      error?.status === 409
      && error?.code === 'virtual_supermarket_listing_revision_conflict'
      && error?.details?.currentRevision === 1
    ),
  )
  assert.ok(calls.includes('ROLLBACK'))
  assert.equal(calls.some((sql) => sql.includes('UPDATE serving.virtual_supermarket_storefront')), false)
  assert.equal(calls.some((sql) => sql.includes('INSERT INTO serving.virtual_supermarket_events')), false)
})

test('virtual-supermarket inventory fingerprints detect canonical inserts and updates without advancing storefront', async () => {
  const memory = new MemoryStore()
  const storefrontRevision = await memory.getVirtualSupermarketStorefrontRevision()
  const emptyRevision = await memory.getVirtualSupermarketInventoryRevision()
  memory.canonicalRecords.set(RECORD_ID, canonicalRecord())
  const insertedRevision = await memory.getVirtualSupermarketInventoryRevision()
  assert.notEqual(insertedRevision, emptyRevision)
  memory.canonicalRecords.get(RECORD_ID).currentRevision += 1
  const updatedRevision = await memory.getVirtualSupermarketInventoryRevision()
  assert.notEqual(updatedRevision, insertedRevision)
  assert.equal(await memory.getVirtualSupermarketStorefrontRevision(), storefrontRevision)

  const calls = []
  const postgres = new PostgresStore({
    async query(sql) {
      calls.push(sql)
      return { rows: [{ inventory_revision: '42' }], rowCount: 1 }
    },
  })
  assert.equal(
    await postgres.getVirtualSupermarketInventoryRevision(),
    'revision:42',
  )
  assert.match(calls[0], /^SELECT inventory_revision FROM serving\.virtual_supermarket_storefront WHERE id = true$/u)
  assert.doesNotMatch(calls[0], /core\.canonical_records|string_agg|md5/iu)
  assert.doesNotMatch(calls[0], /UPDATE serving\.virtual_supermarket_storefront/u)
})

test('Memory category hierarchy keeps scoped keys bound across active and archived categories', async () => {
  const store = new MemoryStore()
  const { item: first } = await store.createVirtualSupermarketCategory(categoryInput())
  await store.createVirtualSupermarketCategory(categoryInput({
    categoryKey: 'folding-tools',
    displayName: '收纳工具',
    shelf: { key: 'folding', name: '收纳货架', sortOrder: 31 },
    sortOrder: 41,
  }))
  await store.createVirtualSupermarketCategory(categoryInput({
    categoryKey: 'electronics-cleaning',
    displayName: '电子清洁',
    department: { key: 'electronics', name: '数码馆', sortOrder: 11 },
    aisle: { key: 'cleaning', name: '数码清洁通道', sortOrder: 21 },
    shelf: { key: 'laundry', name: '清洁耗材货架', sortOrder: 32 },
    sortOrder: 42,
  }))
  await store.createVirtualSupermarketCategory(categoryInput({
    categoryKey: 'pantry-laundry-key',
    displayName: '厨房清洁',
    aisle: { key: 'pantry', name: '厨房通道', sortOrder: 22 },
    shelf: { key: 'laundry', name: '厨房耗材货架', sortOrder: 33 },
    sortOrder: 43,
  }))

  await assert.rejects(
    store.createVirtualSupermarketCategory(categoryInput({
      categoryKey: 'bad-department',
      department: { key: 'home', name: '另一个家居馆', sortOrder: 10 },
    })),
    (error) => error?.code === 'virtual_supermarket_category_hierarchy_conflict'
      && error?.details?.level === 'department',
  )
  await assert.rejects(
    store.createVirtualSupermarketCategory(categoryInput({
      categoryKey: 'bad-aisle',
      aisle: { key: 'cleaning', name: '另一个清洁通道', sortOrder: 20 },
    })),
    (error) => error?.code === 'virtual_supermarket_category_hierarchy_conflict'
      && error?.details?.level === 'aisle',
  )
  await assert.rejects(
    store.createVirtualSupermarketCategory(categoryInput({
      categoryKey: 'bad-shelf',
      shelf: { key: 'laundry', name: '另一个洗衣货架', sortOrder: 30 },
    })),
    (error) => error?.code === 'virtual_supermarket_category_hierarchy_conflict'
      && error?.details?.level === 'shelf',
  )

  const { item: legacy } = await store.createVirtualSupermarketCategory(categoryInput({
    categoryKey: 'legacy-category',
    department: { key: 'legacy', name: '旧馆', sortOrder: 90 },
    aisle: { key: 'legacy', name: '旧通道', sortOrder: 90 },
    shelf: { key: 'legacy', name: '旧货架', sortOrder: 90 },
    sortOrder: 90,
  }))
  store.virtualSupermarketCategories.get(legacy.id).archivedAt = '2026-09-02T00:00:00.000Z'
  await assert.rejects(
    store.createVirtualSupermarketCategory(categoryInput({
      categoryKey: 'legacy-reuse',
      department: { key: 'legacy', name: '重用旧馆', sortOrder: 90 },
      aisle: { key: 'new-aisle', name: '新通道', sortOrder: 91 },
      shelf: { key: 'new-shelf', name: '新货架', sortOrder: 91 },
      sortOrder: 91,
    })),
    (error) => error?.code === 'virtual_supermarket_category_hierarchy_conflict'
      && error?.details?.conflictingCategoryId === legacy.id,
  )

  const storefrontBeforeConflict = await store.getVirtualSupermarketStorefrontRevision()
  await assert.rejects(
    store.updateVirtualSupermarketCategory(first.id, {
      department: { key: 'home', name: '冲突家居馆', sortOrder: 10 },
    }, { expectedRevision: 1 }),
    (error) => error?.code === 'virtual_supermarket_category_hierarchy_conflict',
  )
  assert.equal((await store.getVirtualSupermarketCategory(first.id)).departmentName, '家居馆')
  assert.equal(await store.getVirtualSupermarketStorefrontRevision(), storefrontBeforeConflict)
  const homeCategories = (await store.listVirtualSupermarketCategories({ includeArchived: true }))
    .filter((category) => category.departmentKey === 'home')
  assert.ok(homeCategories.every((category) => (
    category.departmentName === '家居馆' && category.departmentSortOrder === 10
  )))
})

test('Postgres category writes lock hierarchy metadata and fail conflicts before mutation', async () => {
  const createCalls = []
  const createClient = {
    async query(sql, values = []) {
      createCalls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: 0 }
      if (sql.startsWith('LOCK TABLE serving.virtual_supermarket_categories')) return { rows: [], rowCount: 0 }
      if (sql.includes('WHERE category_key = $1 LIMIT 1')) return { rows: [], rowCount: 0 }
      if (sql.includes('END AS conflict_level')) return { rows: [], rowCount: 0 }
      if (sql.includes('INSERT INTO serving.virtual_supermarket_categories')) {
        return { rows: [postgresCategoryRow({ id: values[0] })], rowCount: 1 }
      }
      if (sql.includes('UPDATE serving.virtual_supermarket_storefront')) {
        return { rows: [{ revision: 2 }], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO serving.virtual_supermarket_events')) return { rows: [], rowCount: 1 }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {},
  }
  const created = await new PostgresStore({ connect: async () => createClient })
    .createVirtualSupermarketCategory(categoryInput(), { actor: 'pg-test' })
  assert.equal(created.storefrontRevision, 2)
  assert.equal(created.item.categoryKey, 'laundry-care')
  const lockIndex = createCalls.findIndex(({ sql }) => sql.startsWith('LOCK TABLE'))
  const hierarchyIndex = createCalls.findIndex(({ sql }) => sql.includes('END AS conflict_level'))
  const insertIndex = createCalls.findIndex(({ sql }) => sql.includes('INSERT INTO serving.virtual_supermarket_categories'))
  assert.ok(lockIndex >= 0 && lockIndex < hierarchyIndex && hierarchyIndex < insertIndex)
  assert.doesNotMatch(createCalls[hierarchyIndex].sql, /archived_at/u)
  assert.match(createCalls[hierarchyIndex].sql, /category\.department_key = \$1 AND category\.aisle_key = \$4/u)
  assert.match(createCalls[hierarchyIndex].sql, /category\.shelf_key = \$7/u)

  const updateCalls = []
  const updateClient = {
    async query(sql, values = []) {
      updateCalls.push({ sql, values })
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 }
      if (sql.startsWith('LOCK TABLE serving.virtual_supermarket_categories')) return { rows: [], rowCount: 0 }
      if (sql.includes('SELECT * FROM serving.virtual_supermarket_categories')) {
        return { rows: [postgresCategoryRow()], rowCount: 1 }
      }
      if (sql.includes('END AS conflict_level')) {
        return { rows: [{ id: CONFLICTING_CATEGORY_ID, conflict_level: 'shelf' }], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    },
    release() {},
  }
  await assert.rejects(
    new PostgresStore({ connect: async () => updateClient }).updateVirtualSupermarketCategory(
      CATEGORY_ID,
      { shelf: { key: 'laundry', name: '冲突货架', sortOrder: 30 } },
      { expectedRevision: 1, actor: 'pg-test' },
    ),
    (error) => error?.code === 'virtual_supermarket_category_hierarchy_conflict'
      && error?.details?.level === 'shelf'
      && error?.details?.conflictingCategoryId === CONFLICTING_CATEGORY_ID,
  )
  const updateLockIndex = updateCalls.findIndex(({ sql }) => sql.startsWith('LOCK TABLE'))
  const selectIndex = updateCalls.findIndex(({ sql }) => sql.includes('SELECT * FROM serving.virtual_supermarket_categories'))
  assert.ok(updateLockIndex >= 0 && updateLockIndex < selectIndex)
  assert.equal(updateCalls.some(({ sql }) => sql.includes('UPDATE serving.virtual_supermarket_categories')), false)
  assert.equal(updateCalls.at(-1).sql, 'ROLLBACK')
})

test('listing placement edits preserve overrides and explicit null clears them', async () => {
  const store = new MemoryStore()
  const record = canonicalRecord()
  record.authorName = 'SECRET_SOURCE_AUTHOR'
  record.stableFields.commerce.shop.name = 'PUBLIC_SHOP'
  store.canonicalRecords.set(RECORD_ID, record)
  const { item: published } = await store.updateVirtualSupermarketProduct(RECORD_ID, { status: 'on_shelf' }, {
    expectedRevision: 0,
    actor: 'override-test',
    eventType: 'publish',
  })
  const publicationId = published.listing.publicationId
  const { item: curated } = await store.updateVirtualSupermarketProduct(RECORD_ID, {
    displayTitle: '人工标题',
    specification: '2L',
    price: { amount: '19.90', currency: 'CNY' },
  }, { expectedRevision: 1, actor: 'override-test' })
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', query: '来源商品',
  })).length, 0)
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', query: '来源商品', includeGovernanceEvidence: true,
  })).length, 1)
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', query: 'SECRET_SOURCE_AUTHOR',
  })).length, 0)
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', query: 'SECRET_SOURCE_AUTHOR', includeGovernanceEvidence: true,
  })).length, 1)
  assert.equal((await store.listVirtualSupermarketProducts({
    status: 'on_shelf', query: 'PUBLIC_SHOP',
  })).length, 1)
  const { item: placementOnly } = await store.updateVirtualSupermarketProduct(RECORD_ID, {
    categoryId: VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID,
    shelfPosition: 8,
  }, { expectedRevision: 2, actor: 'override-test' })
  assert.equal(placementOnly.listing.publicationId, publicationId)
  assert.equal(placementOnly.listing.displayTitle, curated.listing.displayTitle)
  assert.equal(placementOnly.listing.specification, curated.listing.specification)
  assert.equal(placementOnly.listing.priceAmount, curated.listing.priceAmount)
  assert.equal(placementOnly.listing.currency, curated.listing.currency)
  const { item: cleared } = await store.updateVirtualSupermarketProduct(RECORD_ID, {
    displayTitle: null,
    specification: null,
    price: null,
  }, { expectedRevision: 3, actor: 'override-test' })
  assert.equal(cleared.listing.publicationId, publicationId)
  assert.equal(cleared.listing.displayTitle, null)
  assert.equal(cleared.listing.specification, null)
  assert.equal(cleared.listing.priceAmount, null)
  assert.equal(cleared.listing.currency, null)
})

test('virtual-supermarket projection renders structured source prices without exposing JSON', async () => {
  const store = new MemoryStore()
  const record = canonicalRecord()
  record.stableFields.commerce.product.price = JSON.stringify({
    origin: 3990,
    integer: '39',
    decimal: '9',
    suffix: '',
  })
  store.canonicalRecords.set(RECORD_ID, record)
  const { item } = await store.updateVirtualSupermarketProduct(
    RECORD_ID,
    { status: 'on_shelf' },
    { expectedRevision: 0, actor: 'price-shape', eventType: 'publish' },
  )
  const product = publicVirtualSupermarketProduct(item)
  assert.deepEqual(product.product.price, {
    amount: '39.9',
    currency: null,
    display: '39.9',
    provenance: 'source',
  })
  assert.doesNotMatch(JSON.stringify(product), /(?:origin|integer|decimal|suffix)/u)

  item.stableFields.commerce.product.price = JSON.stringify({
    origin: 3991,
    integer: '39',
    decimal: '9',
    suffix: '',
  })
  assert.deepEqual(publicVirtualSupermarketProduct(item).product.price, {
    amount: null,
    currency: null,
    display: null,
    provenance: 'source',
  })
})

test('Memory and Postgres product reads expose the same governed listing shape', async () => {
  const memory = new MemoryStore()
  memory.canonicalRecords.set(RECORD_ID, canonicalRecord())
  const { item: memoryItem } = await memory.updateVirtualSupermarketProduct(
    RECORD_ID,
    { status: 'on_shelf' },
    { expectedRevision: 0, actor: 'parity', eventType: 'publish' },
  )

  const calls = []
  const postgres = new PostgresStore({
    async query(sql, values) {
      calls.push({ sql, values })
      return { rows: [postgresJoinedRow()] }
    },
  })
  const postgresItems = await postgres.listVirtualSupermarketProducts({
    status: 'on_shelf',
    department: 'uncategorized',
    aisle: 'uncategorized',
    shelf: 'uncategorized',
    marketplace: '快手小店',
    query: '来源',
    sort: 'price_asc',
    pageSize: 10,
    offset: 0,
  })
  assert.equal(postgresItems.length, 1)
  const postgresItem = postgresItems[0]
  assert.equal(postgresItem.listing.publicationId, PUBLICATION_ID)
  assert.notEqual(memoryItem.listing.publicationId, RECORD_ID)
  assert.deepEqual(
    {
      id: postgresItem.id,
      currentRevision: postgresItem.currentRevision,
      listing: {
        status: postgresItem.listing.status,
        categoryId: postgresItem.listing.categoryId,
        revision: postgresItem.listing.revision,
      },
      category: {
        id: postgresItem.category.id,
        categoryKey: postgresItem.category.categoryKey,
        departmentKey: postgresItem.category.departmentKey,
        aisleKey: postgresItem.category.aisleKey,
        shelfKey: postgresItem.category.shelfKey,
      },
    },
    {
      id: memoryItem.id,
      currentRevision: memoryItem.currentRevision,
      listing: {
        status: memoryItem.listing.status,
        categoryId: memoryItem.listing.categoryId,
        revision: memoryItem.listing.revision,
      },
      category: {
        id: memoryItem.category.id,
        categoryKey: memoryItem.category.categoryKey,
        departmentKey: memoryItem.category.departmentKey,
        aisleKey: memoryItem.category.aisleKey,
        shelfKey: memoryItem.category.shelfKey,
      },
    },
  )
  assert.match(calls[0].sql, /coalesce\(listing\.status, 'off_shelf'\) = \$1/u)
  assert.match(calls[0].sql, /category\.department_key = \$2/u)
  assert.match(calls[0].sql, /category\.aisle_key = \$3/u)
  assert.match(calls[0].sql, /category\.shelf_key = \$4/u)
  assert.match(calls[0].sql, /stable_fields #>> '\{commerce,marketplace,status\}' = 'mapped'/u)
  assert.match(calls[0].sql, /stable_fields #>> '\{commerce,marketplace,entryId\}'/u)
  assert.doesNotMatch(calls[0].sql, /stable_fields #>> '\{commerce,marketplace,(?:sourceKey|sourceValue)\}'/u)
  assert.doesNotMatch(calls[0].sql, /stable_fields #>> '\{commerce,signals,tagsText\}'/u)
  assert.doesNotMatch(calls[0].sql, /OR coalesce\(record\.title, ''\) ILIKE/u)
  assert.doesNotMatch(calls[0].sql, /OR coalesce\(record\.author_name, ''\) ILIKE/u)
  assert.match(calls[0].sql, /effective_price ASC NULLS LAST/u)

  await postgres.listVirtualSupermarketProducts({
    status: 'on_shelf',
    marketplace: 'internal-source-key',
    query: '规格混合原始标签',
    includeGovernanceEvidence: true,
  })
  assert.match(calls[1].sql, /stable_fields #>> '\{commerce,marketplace,entryId\}'/u)
  assert.match(calls[1].sql, /stable_fields #>> '\{commerce,marketplace,sourceKey\}'/u)
  assert.match(calls[1].sql, /stable_fields #>> '\{commerce,signals,tagsText\}'/u)
  assert.match(calls[1].sql, /OR coalesce\(record\.title, ''\) ILIKE/u)
  assert.match(calls[1].sql, /OR coalesce\(record\.author_name, ''\) ILIKE/u)

  await postgres.getVirtualSupermarketProduct(RECORD_ID, { onShelfOnly: true })
  assert.match(calls[2].sql, /listing\.status = 'on_shelf' AND category\.archived_at IS NULL/u)
  await postgres.getVirtualSupermarketProductByPublicationId(PUBLICATION_ID)
  assert.match(calls[3].sql, /listing\.publication_id = \$1::uuid/u)
  assert.deepEqual(calls[3].values, [PUBLICATION_ID])
})
