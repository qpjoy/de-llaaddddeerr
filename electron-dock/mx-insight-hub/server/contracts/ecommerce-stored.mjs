import { createHmac, timingSafeEqual } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
const invalid = () => { throw new AppError(400, 'invalid_stored_query', 'Invalid stored ecommerce query or cursor') }
export function storedEcommerceQuery(input, consumerId, secret, maxPageSize = 100) {
  if (Object.keys(input).some(key => !['marketplace', 'query', 'pageSize', 'cursor'].includes(key))) invalid()
  const marketplace = input.marketplace || 'all'
  const query = String(input.query || '').normalize('NFKC').trim()
  const pageSize = Number(input.pageSize || Math.min(20, maxPageSize))
  if (!['all', 'taobao', 'tmall', 'jd', 'xianyu', 'xiaohongshu_ec'].includes(marketplace) || query.length > 200 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > Math.min(100, maxPageSize)) invalid()
  const scope = JSON.stringify(['ecommerce-stored-v1', consumerId, marketplace, query, pageSize])
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
  return { consumerId, marketplace, query, pageSize, cursor, asOf,
    page(rows) {
      const items = rows.slice(0, pageSize)
      const last = items.at(-1)
      const body = last && Buffer.from(JSON.stringify({ scope, asOf, time: last.recordedAt, id: last.requestId, ordinal: last.ordinal })).toString('base64url')
      return { items, pageInfo: { returnedCount: items.length, hasMore: rows.length > pageSize, nextCursor: rows.length > pageSize ? `${body}.${sign(body)}` : null, asOf }, sourceMode: 'stored_inventory' }
    },
  }
}
