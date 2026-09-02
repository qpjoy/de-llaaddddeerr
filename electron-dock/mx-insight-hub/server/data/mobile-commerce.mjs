import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import {
  MOBILE_COMMERCE_DATASET_ID,
  MOBILE_COMMERCE_OBJECT_TYPE,
  MOBILE_COMMERCE_PLATFORM,
} from '../ingest/mobile-commerce/source-contract.mjs'

export {
  MOBILE_COMMERCE_DATASET_ID,
  MOBILE_COMMERCE_OBJECT_TYPE,
  MOBILE_COMMERCE_PLATFORM,
}

export const MOBILE_COMMERCE_PUBLIC_CONTRACT = 'mx-insight-hub.data-products.mobile-commerce-items.v1'

const ALLOWED_QUERY_FIELDS = new Set([
  'brand', 'catalogEntryId', 'cursor', 'from', 'keyword', 'pageSize', 'refresh', 'sourcePlatform', 'taskId', 'to',
])
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const CURSOR_VERSION = 1

function singleValue(value, field, maximum = 240) {
  if (value == null || value === '') return null
  if (Array.isArray(value) || typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new AppError(400, 'invalid_request', `${field} must be a non-blank string of at most ${maximum} characters`)
  }
  return value.normalize('NFKC').trim()
}

function timestampValue(value, field) {
  const text = singleValue(value, field, 64)
  if (!text) return null
  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime()) || !/T/u.test(text) || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(text)) {
    throw new AppError(400, 'invalid_request', `${field} must be an ISO date-time with an explicit offset`)
  }
  return parsed.toISOString()
}

function pageSizeValue(value, maxPageSize) {
  const maximum = Math.min(100, Math.max(1, Number(maxPageSize) || 100))
  if (value == null || value === '') return Math.min(50, maximum)
  if (Array.isArray(value) || !/^\d+$/u.test(String(value))) {
    throw new AppError(400, 'invalid_request', 'pageSize must be a positive integer')
  }
  const pageSize = Number(value)
  if (pageSize < 1 || pageSize > maximum) {
    throw new AppError(400, 'page_size_exceeded', `pageSize must be between 1 and ${maximum}`)
  }
  return pageSize
}

function bindingOf(filters, pageSize) {
  return createHash('sha256')
    .update(JSON.stringify({ v: CURSOR_VERSION, contract: MOBILE_COMMERCE_PUBLIC_CONTRACT, filters, pageSize }))
    .digest('base64url')
}

function signature(payload, secret) {
  if (typeof secret !== 'string' || !secret) {
    throw new AppError(500, 'cursor_configuration_error', 'Mobile-commerce cursor signing is not configured')
  }
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url')
}

function sameSignature(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && timingSafeEqual(a, b)
}

function decodeCursor(value, binding, secret) {
  if (!value) return null
  try {
    if (typeof value !== 'string' || value.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      throw new Error('invalid cursor token')
    }
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    const payload = { v: parsed?.v, binding: parsed?.binding, sortTime: parsed?.sortTime, id: parsed?.id }
    if (
      Object.keys(parsed || {}).sort().join(',') !== 'binding,id,s,sortTime,v'
      || parsed.v !== CURSOR_VERSION
      || parsed.binding !== binding
      || !UUID_PATTERN.test(parsed.id || '')
      || typeof parsed.sortTime !== 'string'
      || new Date(parsed.sortTime).toISOString() !== parsed.sortTime
      || typeof parsed.s !== 'string'
      || !sameSignature(parsed.s, signature(payload, secret))
    ) throw new Error('invalid cursor payload')
    return { sortTime: parsed.sortTime, id: parsed.id }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(400, 'invalid_cursor', 'cursor is invalid for this mobile-commerce query')
  }
}

function encodeCursor(position, binding, secret) {
  const payload = {
    v: CURSOR_VERSION,
    binding,
    sortTime: new Date(position.sortTime).toISOString(),
    id: position.id,
  }
  return Buffer.from(JSON.stringify({ ...payload, s: signature(payload, secret) }), 'utf8').toString('base64url')
}

export function normalizeMobileCommerceQuery(input = {}, maxPageSize = 100, cursorSecret) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError(400, 'invalid_request', 'Mobile-commerce query must be an object')
  }
  const unsupported = Object.keys(input).filter((field) => !ALLOWED_QUERY_FIELDS.has(field))
  if (unsupported.length > 0) {
    throw new AppError(400, 'unsupported_fields', `Unsupported mobile-commerce filters: ${unsupported.join(', ')}`)
  }
  const refresh = singleValue(input.refresh, 'refresh', 32) || 'stored'
  if (refresh !== 'stored') {
    throw new AppError(
      409,
      'remote_fetch_unavailable',
      'Remote acquisition is reserved but not connected; use refresh=stored',
      { supported: ['stored'], remoteFetchAvailable: false },
    )
  }
  const filters = {
    sourcePlatform: singleValue(input.sourcePlatform, 'sourcePlatform', 120),
    catalogEntryId: singleValue(input.catalogEntryId, 'catalogEntryId', 36),
    keyword: singleValue(input.keyword, 'keyword'),
    brand: singleValue(input.brand, 'brand'),
    taskId: singleValue(input.taskId, 'taskId', 120),
    from: timestampValue(input.from, 'from'),
    to: timestampValue(input.to, 'to'),
  }
  if (filters.catalogEntryId && !UUID_PATTERN.test(filters.catalogEntryId)) {
    throw new AppError(400, 'invalid_request', 'catalogEntryId must be a UUID')
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new AppError(400, 'invalid_request', 'from must not be after to')
  }
  const pageSize = pageSizeValue(input.pageSize, maxPageSize)
  const binding = bindingOf(filters, pageSize)
  const cursorToken = singleValue(input.cursor, 'cursor', 2_048)
  return {
    filters,
    refresh,
    pageSize,
    cursorToken,
    cursorBinding: binding,
    cursor: decodeCursor(cursorToken, binding, cursorSecret),
  }
}

function publicMarketplace(value = {}) {
  return {
    sourceValue: value.sourceValue ?? null,
    mappingStatus: value.status === 'mapped' ? 'mapped' : 'unmapped',
    catalogEntryId: value.entryId ?? null,
    catalogSourceKey: value.sourceKey ?? null,
    catalogRevision: value.revision ?? null,
    canonicalName: value.canonicalName ?? null,
    majorCategory: value.majorCategory ?? null,
    scenarios: Array.isArray(value.scenarios) ? value.scenarios : [],
    regions: Array.isArray(value.regions) ? value.regions : [],
  }
}

export function publicMobileCommerceItem(row) {
  const commerce = row?.stable_fields?.commerce || row?.stableFields?.commerce || {}
  const task = commerce.task || {}
  const product = commerce.product || {}
  const shop = commerce.shop || {}
  const signals = commerce.signals || {}
  return {
    id: row.id,
    captureId: commerce.captureId ?? row.external_id ?? row.externalId ?? null,
    dataVersion: String(row.current_revision ?? row.currentRevision ?? 1),
    marketplace: publicMarketplace(commerce.marketplace),
    task: {
      id: task.id ?? null,
      keyword: task.keyword ?? null,
      // Kept under its source semantics; no claim that the source column has
      // already been normalized to a product brand.
      sourceBrandLabel: task.sourceBrandLabel ?? null,
    },
    product: {
      goodsId: product.goodsId ?? null,
      title: product.title ?? row.title ?? null,
      price: product.price ?? null,
      resolution: product.resolution === 'source-goods-id' ? 'source-goods-id' : 'capture-only',
    },
    shop: {
      id: shop.id ?? null,
      name: shop.name ?? row.author_name ?? row.authorName ?? null,
      level: shop.level ?? null,
      fans: shop.fans ?? null,
      reputation: shop.reputation ?? null,
    },
    signals: {
      sales: signals.sales ?? null,
      shipFrom: signals.shipFrom ?? null,
      commentCount: signals.commentCount ?? null,
      goodRate: signals.goodRate ?? null,
      tagsText: signals.tagsText ?? null,
    },
    collectedAt: row.collected_at instanceof Date
      ? row.collected_at.toISOString()
      : row.collected_at ?? row.collectedAt ?? null,
  }
}

export function publicMobileCommercePage(rows, query, cursorSecret) {
  const hasMore = rows.length > query.pageSize
  const selected = rows.slice(0, query.pageSize)
  const last = selected.at(-1)
  return {
    contractVersion: MOBILE_COMMERCE_PUBLIC_CONTRACT,
    sourceMode: 'stored',
    acquisition: {
      remoteFetchAvailable: false,
      remoteFetchStatus: 'reserved',
      executionPlane: 'external-mobile-collector',
      hubRole: 'asynchronous-trigger-and-data-api',
      plannedMode: 'asynchronous-command',
    },
    scope: {
      authorizationPlatform: MOBILE_COMMERCE_PLATFORM,
      datasetId: MOBILE_COMMERCE_DATASET_ID,
      objectType: MOBILE_COMMERCE_OBJECT_TYPE,
    },
    filters: { ...query.filters },
    items: selected.map(publicMobileCommerceItem),
    pageInfo: {
      returnedCount: selected.length,
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor({ sortTime: last.sort_time ?? last.sortTime, id: last.id }, query.cursorBinding, cursorSecret)
        : null,
    },
  }
}
