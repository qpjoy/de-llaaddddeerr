import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'

export const VIRTUAL_SUPERMARKET_PLATFORM = 'virtual_supermarket'
export const VIRTUAL_SUPERMARKET_PUBLIC_CONTRACT = 'mx-insight-hub.data-products.virtual-supermarket.v1'
export const VIRTUAL_SUPERMARKET_ADMIN_CONTRACT = 'mx-insight-hub.admin-data-products.virtual-supermarket.v1'
export const VIRTUAL_SUPERMARKET_DEFAULT_CATEGORY_ID = '50000000-0000-4000-8000-000000000001'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u
const CURRENCY_PATTERN = /^[A-Z]{3}$/u
const PRICE_PATTERN = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/u
const SORTS = new Set(['newest', 'title_asc', 'price_asc', 'price_desc'])
const ADMIN_STATUSES = new Set(['all', 'on_shelf', 'off_shelf'])
const QUERY_FIELDS = new Set([
  'aisle', 'categoryId', 'cursor', 'department', 'marketplace', 'pageSize', 'query', 'shelf', 'sort', 'status',
])
const PUBLIC_QUERY_FIELDS = new Set([...QUERY_FIELDS].filter((field) => field !== 'status'))
const CURSOR_VERSION = 1

function own(object, field) {
  return Object.prototype.hasOwnProperty.call(object, field)
}

function objectValue(value, message = 'Request body must be a JSON object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'invalid_request', message)
  }
  return value
}

function rejectUnsupported(value, allowed, label) {
  const unsupported = Object.keys(value).filter((field) => !allowed.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported ${label} fields: ${unsupported.join(', ')}`)
  }
}

function optionalText(value, field, maximum = 240, { nullable = true } = {}) {
  if (value == null) {
    if (nullable) return null
    throw new AppError(400, 'invalid_request', `${field} is required`)
  }
  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_request', `${field} must be text`)
  }
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > maximum) {
    throw new AppError(400, 'invalid_request', `${field} must be between 1 and ${maximum} characters`)
  }
  return normalized
}

function optionalInteger(value, field, { minimum = 0, maximum = 1_000_000, nullable = true } = {}) {
  if (value == null) {
    if (nullable) return null
    throw new AppError(400, 'invalid_request', `${field} is required`)
  }
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new AppError(400, 'invalid_request', `${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function keyValue(value, field) {
  const normalized = optionalText(value, field, 128, { nullable: false }).toLowerCase()
  if (!KEY_PATTERN.test(normalized)) {
    throw new AppError(400, 'invalid_request', `${field} must use lowercase letters, numbers, dots, underscores or hyphens`)
  }
  return normalized
}

function uuidValue(value, field, { nullable = false } = {}) {
  if (value == null && nullable) return null
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new AppError(400, 'invalid_request', `${field} must be a UUID`)
  }
  return value.toLowerCase()
}

function revisionValue(value, field = 'expectedRevision') {
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError(400, 'invalid_request', `${field} must be a non-negative integer`)
  }
  return value
}

function placementPart(value, field) {
  const item = objectValue(value, `${field} must be an object`)
  rejectUnsupported(item, new Set(['key', 'name', 'sortOrder']), field)
  return {
    key: keyValue(item.key, `${field}.key`),
    name: optionalText(item.name, `${field}.name`, 160, { nullable: false }),
    sortOrder: optionalInteger(item.sortOrder ?? 0, `${field}.sortOrder`, { nullable: false }),
  }
}

function optionalPlacementPart(value, field) {
  if (value === undefined) return undefined
  return placementPart(value, field)
}

export function normalizeVirtualSupermarketCategoryCreate(input) {
  const value = objectValue(input)
  rejectUnsupported(value, new Set(['aisle', 'department', 'key', 'name', 'shelf', 'sortOrder']), 'category')
  return {
    categoryKey: keyValue(value.key, 'key'),
    displayName: optionalText(value.name, 'name', 160, { nullable: false }),
    department: placementPart(value.department, 'department'),
    aisle: placementPart(value.aisle, 'aisle'),
    shelf: placementPart(value.shelf, 'shelf'),
    sortOrder: optionalInteger(value.sortOrder ?? 0, 'sortOrder', { nullable: false }),
  }
}

export function normalizeVirtualSupermarketCategoryPatch(input) {
  const value = objectValue(input)
  rejectUnsupported(value, new Set(['aisle', 'department', 'expectedRevision', 'name', 'shelf', 'sortOrder']), 'category patch')
  const patch = {
    ...(own(value, 'name') ? { displayName: optionalText(value.name, 'name', 160, { nullable: false }) } : {}),
    ...(own(value, 'department') ? { department: optionalPlacementPart(value.department, 'department') } : {}),
    ...(own(value, 'aisle') ? { aisle: optionalPlacementPart(value.aisle, 'aisle') } : {}),
    ...(own(value, 'shelf') ? { shelf: optionalPlacementPart(value.shelf, 'shelf') } : {}),
    ...(own(value, 'sortOrder')
      ? { sortOrder: optionalInteger(value.sortOrder, 'sortOrder', { nullable: false }) }
      : {}),
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, 'empty_virtual_supermarket_category_patch', 'At least one editable category field is required')
  }
  return { expectedRevision: revisionValue(value.expectedRevision), patch }
}

function priceOverride(value) {
  if (value == null) return null
  const price = objectValue(value, 'price must be an object or null')
  rejectUnsupported(price, new Set(['amount', 'currency']), 'price')
  const amount = optionalText(price.amount, 'price.amount', 32, { nullable: false })
  const currency = optionalText(price.currency, 'price.currency', 3, { nullable: false }).toUpperCase()
  if (!PRICE_PATTERN.test(amount)) {
    throw new AppError(400, 'invalid_request', 'price.amount must be a non-negative decimal with at most two fractional digits')
  }
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new AppError(400, 'invalid_request', 'price.currency must be a three-letter ISO currency code')
  }
  return { amount, currency }
}

export function normalizeVirtualSupermarketProductPatch(input) {
  const value = objectValue(input)
  rejectUnsupported(
    value,
    new Set(['categoryId', 'expectedRevision', 'price', 'reason', 'shelfPosition', 'specification', 'title']),
    'product patch',
  )
  const patch = {
    ...(own(value, 'categoryId') ? { categoryId: uuidValue(value.categoryId, 'categoryId', { nullable: true }) } : {}),
    ...(own(value, 'title') ? { displayTitle: value.title == null ? null : optionalText(value.title, 'title', 512) } : {}),
    ...(own(value, 'specification')
      ? { specification: value.specification == null ? null : optionalText(value.specification, 'specification', 1_000) }
      : {}),
    ...(own(value, 'price') ? { price: priceOverride(value.price) } : {}),
    ...(own(value, 'shelfPosition')
      ? { shelfPosition: optionalInteger(value.shelfPosition, 'shelfPosition') }
      : {}),
  }
  if (Object.keys(patch).length === 0) {
    throw new AppError(400, 'empty_virtual_supermarket_product_patch', 'At least one editable product field is required')
  }
  return {
    expectedRevision: revisionValue(value.expectedRevision),
    patch,
    reason: own(value, 'reason') && value.reason != null ? optionalText(value.reason, 'reason', 500) : null,
  }
}

export function normalizeVirtualSupermarketPublication(input) {
  const value = input == null ? {} : objectValue(input)
  rejectUnsupported(value, new Set(['expectedRevision', 'reason']), 'publication')
  return {
    expectedRevision: revisionValue(value.expectedRevision),
    reason: own(value, 'reason') && value.reason != null ? optionalText(value.reason, 'reason', 500) : null,
  }
}

function queryText(value, field, maximum = 240) {
  if (value == null || value === '') return null
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new AppError(400, 'invalid_request', `${field} must be a single text value`)
  }
  return optionalText(value, field, maximum)
}

function queryPageSize(value, maxPageSize) {
  const maximum = Math.min(100, Math.max(1, Number(maxPageSize) || 100))
  if (value == null || value === '') return Math.min(24, maximum)
  if (Array.isArray(value) || !/^\d+$/u.test(String(value))) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  const pageSize = Number(value)
  if (pageSize < 1 || pageSize > maximum) {
    throw new AppError(400, 'page_size_exceeded', `pageSize must be between 1 and ${maximum}`)
  }
  return pageSize
}

function cursorSignature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Virtual-supermarket cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function signaturesEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

function decodeCursor(value, binding, storefrontRevision, inventoryRevision, secret) {
  if (!value) return 0
  try {
    if (typeof value !== 'string' || value.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new Error('invalid cursor token')
    }
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const payload = {
      v: parsed?.v,
      binding: parsed?.binding,
      storefrontRevision: parsed?.storefrontRevision,
      inventoryRevision: parsed?.inventoryRevision,
      offset: parsed?.offset,
    }
    if (
      Object.keys(parsed || {}).sort().join(',') !== 'binding,inventoryRevision,offset,s,storefrontRevision,v'
      || parsed.v !== CURSOR_VERSION
      || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0
      || !Number.isSafeInteger(parsed.storefrontRevision)
      || parsed.storefrontRevision < 1
      || (parsed.inventoryRevision !== null && typeof parsed.inventoryRevision !== 'string')
      || !signaturesEqual(parsed.s, cursorSignature(payload, secret))
    ) throw new Error('invalid cursor payload')
    if (parsed.storefrontRevision !== storefrontRevision) {
      throw new AppError(
        409,
        'storefront_revision_changed',
        'Virtual-supermarket publication changed; restart pagination from the first page',
        { cursorRevision: parsed.storefrontRevision, storefrontRevision },
      )
    }
    if (parsed.inventoryRevision !== inventoryRevision) {
      throw new AppError(
        409,
        'virtual_supermarket_inventory_changed',
        'Virtual-supermarket inventory changed; restart pagination from the first page',
        { cursorInventoryRevision: parsed.inventoryRevision, inventoryRevision },
      )
    }
    if (parsed.binding !== binding) throw new Error('invalid cursor binding')
    return parsed.offset
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid for this virtual-supermarket query')
  }
}

function encodeCursor(offset, binding, storefrontRevision, inventoryRevision, secret) {
  const payload = { v: CURSOR_VERSION, binding, storefrontRevision, inventoryRevision, offset }
  return Buffer.from(JSON.stringify({ ...payload, s: cursorSignature(payload, secret) }), 'utf8').toString('base64url')
}

export function normalizeVirtualSupermarketQuery(input = {}, {
  admin = false,
  cursorSecret,
  maxPageSize = 100,
  requireQuery = false,
  storefrontRevision,
  inventoryRevision = null,
} = {}) {
  const value = objectValue(input, 'Virtual-supermarket query must be an object')
  rejectUnsupported(value, admin ? QUERY_FIELDS : PUBLIC_QUERY_FIELDS, 'virtual-supermarket query')
  if (!Number.isSafeInteger(storefrontRevision) || storefrontRevision < 1) {
    throw new AppError(500, 'storefront_revision_unavailable', 'Virtual-supermarket storefront revision is unavailable')
  }
  if (admin && (typeof inventoryRevision !== 'string' || !inventoryRevision)) {
    throw new AppError(500, 'inventory_revision_unavailable', 'Virtual-supermarket inventory revision is unavailable')
  }
  const status = admin ? (queryText(value.status, 'status', 32) || 'all') : 'on_shelf'
  if (!ADMIN_STATUSES.has(status)) {
    throw new AppError(400, 'invalid_request', 'status must be all, on_shelf or off_shelf')
  }
  const sort = queryText(value.sort, 'sort', 32) || 'newest'
  if (!SORTS.has(sort)) {
    throw new AppError(400, 'invalid_request', `sort must be one of ${[...SORTS].join(', ')}`)
  }
  const filters = {
    status,
    categoryId: value.categoryId == null || value.categoryId === ''
      ? null
      : uuidValue(queryText(value.categoryId, 'categoryId', 36), 'categoryId'),
    department: queryText(value.department, 'department', 128)?.toLowerCase() ?? null,
    aisle: queryText(value.aisle, 'aisle', 128)?.toLowerCase() ?? null,
    shelf: queryText(value.shelf, 'shelf', 128)?.toLowerCase() ?? null,
    marketplace: queryText(value.marketplace, 'marketplace', 160),
    query: queryText(value.query, 'query', 240),
  }
  if (requireQuery && !filters.query) {
    throw new AppError(400, 'invalid_request', 'query is required for virtual-supermarket search')
  }
  const pageSize = queryPageSize(value.pageSize, maxPageSize)
  const binding = createHash('sha256')
    .update(JSON.stringify({ v: CURSOR_VERSION, admin, filters, sort, pageSize }))
    .digest('base64url')
  const cursorToken = queryText(value.cursor, 'cursor', 2_048)
  return {
    filters,
    sort,
    pageSize,
    cursorToken,
    cursorBinding: binding,
    storefrontRevision,
    inventoryRevision: admin ? inventoryRevision : null,
    offset: decodeCursor(
      cursorToken,
      binding,
      storefrontRevision,
      admin ? inventoryRevision : null,
      cursorSecret,
    ),
  }
}

function iso(value) {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function categoryView(category) {
  return {
    id: category.id,
    key: category.categoryKey,
    name: category.displayName,
    sortOrder: Number(category.sortOrder || 0),
    department: {
      key: category.departmentKey,
      name: category.departmentName,
      sortOrder: Number(category.departmentSortOrder || 0),
    },
    aisle: {
      key: category.aisleKey,
      name: category.aisleName,
      sortOrder: Number(category.aisleSortOrder || 0),
    },
    shelf: {
      key: category.shelfKey,
      name: category.shelfName,
      sortOrder: Number(category.shelfSortOrder || 0),
    },
    revision: Number(category.revision || 1),
    archivedAt: iso(category.archivedAt),
    createdAt: iso(category.createdAt),
    updatedAt: iso(category.updatedAt),
  }
}

export function virtualSupermarketCategoryResponse(category, { admin = false } = {}) {
  const item = categoryView(category)
  return admin ? item : Object.fromEntries(Object.entries(item).filter(([key]) => !['archivedAt', 'createdAt'].includes(key)))
}

function priceFrom(item, commerce) {
  if (item.listing.priceAmount != null) {
    const amount = String(item.listing.priceAmount)
    return {
      amount,
      currency: item.listing.currency,
      display: amount,
      provenance: 'curated',
    }
  }
  const source = commerce.product?.price == null ? null : String(commerce.product.price).trim()
  if (source && PRICE_PATTERN.test(source)) {
    return { amount: source, currency: null, display: source, provenance: 'source' }
  }
  return { amount: null, currency: null, display: source, provenance: source ? 'source' : 'missing' }
}

function marketplaceView(value = {}) {
  const mapped = value.status === 'mapped'
  return {
    id: mapped ? value.entryId ?? null : null,
    name: mapped ? value.canonicalName ?? null : null,
  }
}

function adminMarketplaceView(value = {}) {
  return {
    ...marketplaceView(value),
    sourceValue: value.sourceValue ?? null,
    mappingStatus: value.status === 'mapped' ? 'mapped' : 'unmapped',
    catalogEntryId: value.entryId ?? null,
    canonicalName: value.canonicalName ?? null,
    catalogSourceKey: value.sourceKey ?? null,
  }
}

export function publicVirtualSupermarketProduct(item) {
  const stableFields = item.stableFields || {}
  const commerce = stableFields.commerce || {}
  const sourceProduct = commerce.product || {}
  const sourceShop = commerce.shop || {}
  const signals = commerce.signals || {}
  const category = categoryView(item.category)
  const title = item.listing.displayTitle ?? sourceProduct.title ?? item.title ?? null
  const specification = item.listing.specification ?? null
  const price = priceFrom(item, commerce)
  return {
    id: item.listing.publicationId,
    dataVersion: `${Number(item.currentRevision || 1)}:${Number(item.listing.revision || 0)}`,
    listing: {
      status: item.listing.status,
      revision: Number(item.listing.revision || 0),
    },
    placement: {
      department: category.department,
      aisle: category.aisle,
      shelf: category.shelf,
      position: item.listing.shelfPosition == null ? null : Number(item.listing.shelfPosition),
    },
    category: {
      id: category.id,
      key: category.key,
      name: category.name,
      sortOrder: category.sortOrder,
    },
    marketplace: marketplaceView(commerce.marketplace),
    product: {
      title,
      specification,
      price,
      provenance: {
        title: item.listing.displayTitle != null ? 'curated' : title != null ? 'source' : 'missing',
        specification: item.listing.specification != null ? 'curated' : 'missing',
        price: price.provenance,
      },
    },
    shop: {
      name: sourceShop.name ?? item.authorName ?? null,
    },
    signals: {
      sales: signals.sales ?? null,
    },
    collectedAt: iso(item.collectedAt),
  }
}

export function adminVirtualSupermarketProduct(item) {
  const publicItem = publicVirtualSupermarketProduct(item)
  const commerce = item.stableFields?.commerce || {}
  const sourcePrice = commerce.product?.price == null ? null : String(commerce.product.price).trim()
  const sourceCurrency = null
  return {
    ...publicItem,
    id: item.id,
    recordId: item.id,
    publicationId: item.listing.publicationId,
    contractVersion: VIRTUAL_SUPERMARKET_ADMIN_CONTRACT,
    marketplace: adminMarketplaceView(commerce.marketplace),
    listing: {
      ...publicItem.listing,
      explicit: item.listing.explicit === true,
      categoryId: item.listing.categoryId,
      displayTitle: item.listing.displayTitle,
      specification: item.listing.specification,
      price: item.listing.priceAmount == null
        ? null
        : { amount: String(item.listing.priceAmount), currency: item.listing.currency },
      shelfPosition: item.listing.shelfPosition == null ? null : Number(item.listing.shelfPosition),
      updatedBy: item.listing.updatedBy ?? null,
      updatedAt: iso(item.listing.updatedAt),
    },
    sourceEvidence: {
      canonicalRevision: Number(item.currentRevision || 1),
      captureId: commerce.captureId ?? item.externalId ?? null,
      title: commerce.product?.title ?? item.title ?? null,
      price: commerce.product?.price ?? null,
      goodsId: commerce.product?.goodsId ?? null,
      shopId: commerce.shop?.id ?? null,
      productResolution: commerce.product?.resolution ?? 'capture-only',
      tagsText: commerce.signals?.tagsText ?? null,
      marketplaceCatalogSourceKey: commerce.marketplace?.sourceKey ?? null,
    },
    fieldState: {
      displayTitle: {
        source: commerce.product?.title ?? item.title ?? null,
        override: item.listing.displayTitle,
        effective: publicItem.product.title,
        provenance: publicItem.product.provenance.title,
      },
      specification: {
        source: null,
        override: item.listing.specification,
        effective: publicItem.product.specification,
        provenance: publicItem.product.provenance.specification,
      },
      price: {
        source: sourcePrice,
        override: item.listing.priceAmount == null ? null : String(item.listing.priceAmount),
        effective: publicItem.product.price.amount,
        provenance: publicItem.product.provenance.price,
      },
      currency: {
        source: sourceCurrency,
        override: item.listing.currency,
        effective: publicItem.product.price.currency,
        provenance: item.listing.currency == null ? 'missing' : 'curated',
      },
    },
  }
}

export function virtualSupermarketMetadata(categories, { admin = false, storefrontRevision } = {}) {
  const flat = categories
    .filter((category) => admin || !category.archivedAt)
    .map((category) => virtualSupermarketCategoryResponse(category, { admin }))
  const departments = new Map()
  for (const category of flat) {
    let department = departments.get(category.department.key)
    if (!department) {
      department = { ...category.department, aisles: new Map() }
      departments.set(category.department.key, department)
    }
    let aisle = department.aisles.get(category.aisle.key)
    if (!aisle) {
      aisle = { ...category.aisle, shelves: new Map() }
      department.aisles.set(category.aisle.key, aisle)
    }
    let shelf = aisle.shelves.get(category.shelf.key)
    if (!shelf) {
      shelf = { ...category.shelf, categories: [] }
      aisle.shelves.set(category.shelf.key, shelf)
    }
    shelf.categories.push({ id: category.id, key: category.key, name: category.name, sortOrder: category.sortOrder })
  }
  const tree = [...departments.values()]
    .map((department) => ({
      ...department,
      aisles: [...department.aisles.values()]
        .map((aisle) => ({
          ...aisle,
          shelves: [...aisle.shelves.values()]
            .map((shelf) => ({
              ...shelf,
              categories: shelf.categories.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN')),
            }))
            .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN')),
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN')),
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN'))
  const catalogRevision = createHash('sha256')
    .update(JSON.stringify(flat.map(({ id, revision }) => [id, revision]).sort()))
    .digest('hex')
  return {
    contractVersion: admin ? VIRTUAL_SUPERMARKET_ADMIN_CONTRACT : VIRTUAL_SUPERMARKET_PUBLIC_CONTRACT,
    platform: VIRTUAL_SUPERMARKET_PLATFORM,
    sourceMode: 'stored',
    storefrontRevision,
    catalogRevision: `sha256:${catalogRevision}`,
    categories: flat,
    departments: tree,
    supportedSorts: [...SORTS],
    ...(admin ? { listingStatuses: [...ADMIN_STATUSES] } : {}),
  }
}

export function virtualSupermarketPage(rows, query, cursorSecret, { admin = false } = {}) {
  const hasMore = rows.length > query.pageSize
  const selected = rows.slice(0, query.pageSize)
  return {
    contractVersion: admin ? VIRTUAL_SUPERMARKET_ADMIN_CONTRACT : VIRTUAL_SUPERMARKET_PUBLIC_CONTRACT,
    platform: VIRTUAL_SUPERMARKET_PLATFORM,
    sourceMode: 'stored',
    storefrontRevision: query.storefrontRevision,
    ...(admin ? { inventoryRevision: query.inventoryRevision } : {}),
    filters: { ...query.filters, sort: query.sort },
    items: selected.map((item) => admin
      ? adminVirtualSupermarketProduct(item)
      : publicVirtualSupermarketProduct(item)),
    pageInfo: {
      returnedCount: selected.length,
      hasMore,
      nextCursor: hasMore
        ? encodeCursor(
            query.offset + selected.length,
            query.cursorBinding,
            query.storefrontRevision,
            query.inventoryRevision,
            cursorSecret,
          )
        : null,
    },
  }
}

export function virtualSupermarketDetail(item, { admin = false, storefrontRevision } = {}) {
  return {
    contractVersion: admin ? VIRTUAL_SUPERMARKET_ADMIN_CONTRACT : VIRTUAL_SUPERMARKET_PUBLIC_CONTRACT,
    platform: VIRTUAL_SUPERMARKET_PLATFORM,
    sourceMode: 'stored',
    storefrontRevision,
    item: admin ? adminVirtualSupermarketProduct(item) : publicVirtualSupermarketProduct(item),
  }
}
