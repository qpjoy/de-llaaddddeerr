import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
const invalid = () => { throw new AppError(400, 'invalid_stored_query', 'Invalid stored ecommerce query or cursor') }
export function storedEcommerceQuery(input, consumerId, secret, maxPageSize = 100) {
  if (Object.keys(input).some(key => !['marketplace', 'query', 'pageSize', 'cursor', 'minPrice', 'maxPrice', 'from', 'to'].includes(key))) invalid()
  const marketplace = input.marketplace || 'all'
  const query = String(input.query || '').normalize('NFKC').trim()
  const pageSize = Number(input.pageSize || Math.min(10, maxPageSize))
  if (!['all', 'taobao', 'tmall', 'jd', 'xianyu', 'xiaohongshu_ec'].includes(marketplace) || query.length > 200 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > Math.min(100, maxPageSize)) invalid()
  const amount = value => {
    if (value == null || value === '') return null
    if (typeof value !== 'string' || !/^\d{1,12}(?:\.\d{1,2})?$/.test(value)) invalid()
    return value
  }
  const minPrice = amount(input.minPrice), maxPrice = amount(input.maxPrice)
  const timestamp = value => {
    if (!value) return null
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) invalid()
    return new Date(value).toISOString()
  }
  const from = timestamp(input.from), to = timestamp(input.to)
  if ((minPrice !== null && maxPrice !== null && Number(minPrice) > Number(maxPrice)) || (from && to && from > to)) invalid()
  const scope = JSON.stringify(['ecommerce-stored-v2', consumerId, marketplace, query, pageSize, minPrice, maxPrice, from, to])
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url')
  let cursor = null
  if (input.cursor) {
    try {
      if (input.cursor.length > 4096) invalid()
      const [body, signature, extra] = input.cursor.split('.')
      const expected = sign(body)
      if (extra || !signature || signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) invalid()
      cursor = JSON.parse(Buffer.from(body, 'base64url').toString())
      if (cursor.scope !== scope || !Number.isFinite(Date.parse(cursor.asOf)) || !Number.isFinite(Date.parse(cursor.time)) || !/^[0-9a-f-]{36}$/i.test(cursor.id) || !Number.isInteger(cursor.ordinal) || cursor.ordinal < 1) invalid()
    } catch { invalid() }
  }
  const asOf = cursor?.asOf || new Date().toISOString()
  return { consumerId, marketplace, query, pageSize, cursor, asOf, minPrice, maxPrice, from, to,
    page(rows) {
      const items = rows.slice(0, pageSize).map(row => ({ ...row, media: (row.product.images || []).map((originalUrl, imageIndex) => ({ originalUrl,
        hubUrl: consumerId === 'admin-ecommerce'
          ? `/internal/v1/admin/data-products/ecommerce/media?requestId=${encodeURIComponent(row.requestId)}&ordinal=${row.ordinal}&imageIndex=${imageIndex}`
          : `/api/v1/data/ecommerce/products/media?requestId=${encodeURIComponent(row.requestId)}&itemId=${encodeURIComponent(row.product.id)}&imageIndex=${imageIndex}`,
        externalFeeStatus: 'unknown', storage: 'memory_relay', retrievalPolicy: 'cache_first', staticUrl: null,
      })) }))
      const last = items.at(-1)
      const body = last && Buffer.from(JSON.stringify({ scope, asOf, time: last.recordedAt, id: last.requestId, ordinal: last.ordinal })).toString('base64url')
      return { items, pageInfo: { returnedCount: items.length, hasMore: rows.length > pageSize, nextCursor: rows.length > pageSize ? `${body}.${sign(body)}` : null, asOf }, sourceMode: 'stored_inventory' }
    },
  }
}

export function matchesStoredEcommerceFilters(row, { minPrice = null, maxPrice = null, from = null, to = null }) {
  const raw = row.product.pricing?.current
  const price = typeof raw === 'string' && /^\d{1,12}(?:\.\d{1,2})?$/.test(raw) ? Number(raw) : null
  const time = Date.parse(row.recordedAt)
  return (minPrice == null || (price !== null && price >= Number(minPrice)))
    && (maxPrice == null || (price !== null && price <= Number(maxPrice)))
    && (!from || time >= Date.parse(from)) && (!to || time <= Date.parse(to))
}
