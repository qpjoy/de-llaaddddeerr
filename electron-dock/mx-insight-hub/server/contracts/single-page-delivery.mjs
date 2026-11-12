import { AppError } from '../core/errors.mjs'

// Opt-in single-page delivery (2026-11-11). By default the strategy-search
// interfaces keep buying supplier pages until pageSize is filled, so one slow
// supplier page can push a request past a caller's timeout. `fillPage: false`
// returns after the first content page this request obtains: a saved overflow,
// or one new supplier page. Account lookups needed before that page, and a
// supplier switch after a definite rejection, still run. The caller continues
// with nextCursor exactly as before.
//
// Cursors stay mode-independent: the option is never part of a cursor scope,
// so a traversal may switch modes. The idempotency fingerprint records it, so
// one Idempotency-Key cannot replay a response of the other mode.
export const FILL_PAGE_FIELD = 'fillPage'

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)

// true = fill (the existing behavior, also when the field is absent).
export function fillPageOption(body) {
  if (!plain(body) || !Object.hasOwn(body, FILL_PAGE_FIELD)) return true
  if (typeof body[FILL_PAGE_FIELD] !== 'boolean') throw new AppError(400, 'invalid_fill_page', 'fillPage must be true or false')
  return body[FILL_PAGE_FIELD]
}

// Remove the option before a strict contract normalizer validates the body.
export function takeFillPage(body) {
  const fill = fillPageOption(body)
  if (!plain(body) || !Object.hasOwn(body, FILL_PAGE_FIELD)) return { body, singlePage: false }
  const { [FILL_PAGE_FIELD]: _option, ...rest } = body
  return { body: rest, singlePage: !fill }
}

export function withSinglePage(request, singlePage) {
  if (!singlePage) return request
  return { ...request, singlePage: true, fingerprintBody: { ...request.fingerprintBody, [FILL_PAGE_FIELD]: false } }
}
