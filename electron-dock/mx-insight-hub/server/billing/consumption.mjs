import { AppError } from '../core/errors.mjs'

export function consumptionQuery(input, tenantId) {
  if (Object.keys(input).some(key => !['cursor', 'limit'].includes(key))) throw new AppError(400, 'invalid_request', 'Unsupported consumption query')
  const limit = input.limit == null ? 20 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError(400, 'invalid_request', 'limit must be 1–100')
  let before = null
  if (input.cursor != null) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 512) throw new Error()
      const value = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
      if (value.tenantId !== tenantId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.id) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error()
      before = { id: value.id, createdAt: value.createdAt }
    } catch { throw new AppError(400, 'invalid_cursor', 'Invalid consumption cursor') }
  }
  return { limit, before }
}

export function consumptionPage(rows, tenantId, limit) {
  const page = rows.slice(0, limit)
  const last = page.at(-1)
  const items = page.map(({ cursorTime: _, ...row }) => row)
  return { items, pageInfo: { hasMore: rows.length > limit, nextCursor: rows.length > limit
    ? Buffer.from(JSON.stringify({ tenantId, id: last.id, createdAt: last.cursorTime || last.createdAt })).toString('base64url') : null } }
}

// Explicitly allowlisted for both administrator and tenant usage readers.
export function consumptionItem(charge, { consumerName = null, platform = null, events = [] } = {}) {
  return {
    id: charge.id, requestId: charge.usageRequestId, consumerId: charge.consumerId, consumerName,
    apiKeyId: charge.apiKeyId, platform, meterKey: charge.meterKey, status: charge.status,
    enforcementMode: charge.enforcementMode, currency: charge.currency,
    quotedMinor: charge.quotedMinor, chargedMinor: charge.chargedMinor,
    priceBookKey: charge.priceBookKey, priceBookVersion: charge.priceBookVersion,
    createdAt: charge.createdAt, settledAt: charge.settledAt,
    events: events.map(row => ({ id: row.id, kind: row.kind, createdAt: row.createdAt,
      amountMinor: row.amountMinor, availableDeltaMinor: row.availableDeltaMinor, heldDeltaMinor: row.heldDeltaMinor })),
  }
}
