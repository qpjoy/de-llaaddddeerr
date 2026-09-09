import { requestFingerprint } from '../core/crypto.mjs'
import { AppError } from '../core/errors.mjs'
import { NIGHT_ALL_COMPATIBILITY_MAX_PAGE } from './night-all-compat.mjs'

export const NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX = 'mxnc1.'

const CURSOR_CONTRACT = 'mx-insight-hub.night-all-compatibility-cursor.v1'
const CONTINUATION_KEYS = new Set([
  'cursor', 'pcursor', 'after', 'maxid', 'endcursor', 'continuationtoken',
  'nextmaxid', 'ranktoken', 'searchid', 'searchsessionid', 'searchhashid',
  'backtrace', 'offset', 'nextoffset', 'start', 'paginationtoken',
  'pagetoken', 'nextpagetoken',
])

function invalidCursor(message = 'Night-All compatibility cursor is invalid') {
  throw new AppError(400, 'invalid_cursor', message)
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizedKey(value) {
  return String(value).replace(/[_-]/gu, '').toLowerCase()
}

function hasContinuationParams(value) {
  if (Array.isArray(value)) return value.some(hasContinuationParams)
  if (!record(value)) return false
  return Object.entries(value).some(([key, nested]) => (
    CONTINUATION_KEYS.has(normalizedKey(key)) || hasContinuationParams(nested)
  ))
}

function scopeFingerprint(operation, upstreamBody) {
  const scopeBody = structuredClone(upstreamBody)
  // Continuation state is authenticated inside the Hub cursor. The stable
  // query/account/page-size fields remain here to prevent reuse with another
  // request. Provider-specific params are excluded because a composite next
  // page replaces them with the upstream's complete nextParams object.
  delete scopeBody.cursor
  delete scopeBody.params
  delete scopeBody.page
  return requestFingerprint({
    method: 'POST',
    path: `/internal/night-all-compatibility/${operation}`,
    body: scopeBody,
  })
}

function decodedState(codec, cursor) {
  try {
    return codec.decode(cursor)
  } catch {
    invalidCursor()
  }
}

function validatedContinuation(state, { operation, platform, scope }) {
  if (
    !record(state)
    || state.contract !== CURSOR_CONTRACT
    || state.operation !== operation
    || state.platform !== platform
    || state.scope !== scope
    || !Number.isInteger(state.page)
    || state.page < 2
    || state.page > NIGHT_ALL_COMPATIBILITY_MAX_PAGE
    || !record(state.continuation)
  ) invalidCursor()

  if (state.continuation.type === 'cursor') {
    const value = state.continuation.value
    if (typeof value !== 'string' || !value || value.length > 8_192) invalidCursor()
    const params = state.continuation.params
    if (params != null && (!record(params) || hasContinuationParams(params))) invalidCursor()
    return {
      page: state.page,
      type: 'cursor',
      value,
      params: params == null ? null : structuredClone(params),
    }
  }
  if (state.continuation.type === 'params') {
    const value = state.continuation.value
    if (!record(value) || Object.keys(value).length === 0) invalidCursor()
    const requestPage = state.continuation.requestPage
    if (
      requestPage != null
      && (!Number.isInteger(requestPage)
        || requestPage < 2
        || requestPage > NIGHT_ALL_COMPATIBILITY_MAX_PAGE)
    ) invalidCursor()
    return {
      page: state.page,
      type: 'params',
      value: structuredClone(value),
      requestPage: requestPage ?? null,
    }
  }
  if (state.continuation.type === 'page') {
    const value = state.continuation.value
    if (
      !Number.isInteger(value)
      || value < 2
      || value > NIGHT_ALL_COMPATIBILITY_MAX_PAGE
    ) invalidCursor()
    return { page: state.page, type: 'page', value }
  }
  invalidCursor()
}

/**
 * Decode only Hub-issued compatibility continuations. Raw historical provider
 * cursors have no trustworthy page number, so accepting them would let a
 * caller bypass the 15-page acquisition boundary with fresh idempotency keys.
 */
export function prepareNightAllCompatibilityTraversal({
  operation,
  platform,
  upstreamBody,
  codec,
}) {
  const body = structuredClone(upstreamBody)
  const scope = scopeFingerprint(operation, body)
  const topCursor = typeof body.cursor === 'string' ? body.cursor : null
  const paramsKeys = record(body.params) ? Object.keys(body.params) : []
  const paramsCursor = paramsKeys.length === 1 && paramsKeys[0] === 'cursor'
    && typeof body.params.cursor === 'string'
    ? body.params.cursor
    : null
  const wrappedTop = topCursor?.startsWith(NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX)
    ? topCursor
    : null
  const wrappedParams = paramsCursor?.startsWith(NIGHT_ALL_COMPATIBILITY_CURSOR_PREFIX)
    ? paramsCursor
    : null

  if (wrappedTop && wrappedParams) invalidCursor()
  if (topCursor && !wrappedTop) {
    invalidCursor('Historical provider cursors cannot prove the 15-page boundary; restart from page 1')
  }
  if (!wrappedParams && hasContinuationParams(body.params)) {
    invalidCursor('Historical provider continuation params cannot prove the 15-page boundary; restart from page 1')
  }

  const wrapped = wrappedTop || wrappedParams
  if (!wrapped) {
    return {
      upstreamBody: body,
      page: body.page ?? 1,
      scope,
    }
  }

  const continuation = validatedContinuation(decodedState(codec, wrapped), {
    operation,
    platform,
    scope,
  })
  delete body.cursor
  delete body.params
  delete body.page
  if (continuation.type === 'cursor') {
    body.cursor = continuation.value
    if (continuation.params) body.params = continuation.params
  } else if (continuation.type === 'params') {
    body.params = continuation.value
    if (continuation.requestPage != null) body.page = continuation.requestPage
  } else {
    body.page = continuation.value
  }
  return { upstreamBody: body, page: continuation.page, scope }
}

function addPageLimitWarning(data) {
  const warnings = Array.isArray(data.warnings) ? [...data.warnings] : []
  if (!warnings.some((warning) => warning?.code === 'page_limit_reached')) {
    warnings.push({
      code: 'page_limit_reached',
      message: `Compatibility pagination is limited to ${NIGHT_ALL_COMPATIBILITY_MAX_PAGE} pages`,
    })
  }
  data.warnings = warnings
}

function stopPagination(data, page, { warn = false } = {}) {
  const advertisedContinuation = page.hasMore === true
    || page.nextCursor != null
    || page.providerCursor != null
    || page.nextParams != null
    || page.nextPage != null
  page.hasMore = false
  page.nextCursor = null
  page.providerCursor = null
  page.nextParams = null
  page.nextPage = null
  if (warn && advertisedContinuation) addPageLimitWarning(data)
}

function encodeContinuation(codec, state) {
  try {
    return codec.encode(state)
  } catch {
    return null
  }
}

/**
 * Replace only pagination-control material. raw_info/raw_data and every other
 * acquired business field remain byte-for-byte equivalent in the JSON value.
 * Historical ingestion separately receives the complete pre-projection parsed
 * JSON object; Hub-native provider transports additionally retain exact bytes.
 */
export function capNightAllCompatibilityTraversal(payload, {
  operation,
  platform,
  page: currentPage,
  scope,
  codec,
  upstreamBody = null,
}) {
  const response = structuredClone(payload)
  const data = response?.data
  const page = data?.page
  if (!record(data) || !record(page)) return response

  // An explicit terminal signal from Night-All wins even when the provider
  // leaves a stale cursor/token in its response. Never advertise another paid
  // acquisition after the upstream has said traversal is complete.
  if (page.hasMore === false) {
    stopPagination(data, page)
    return response
  }

  if (currentPage >= NIGHT_ALL_COMPATIBILITY_MAX_PAGE) {
    stopPagination(data, page, { warn: true })
    return response
  }

  const nextPage = Number.isInteger(page.nextPage) ? page.nextPage : null
  const mode = typeof page.paginationMode === 'string'
    ? page.paginationMode.toLowerCase()
    : 'unknown'
  const upstreamCursor = [page.nextCursor, page.providerCursor]
    .find((value) => typeof value === 'string' && value)
  const upstreamParams = record(page.nextParams) && Object.keys(page.nextParams).length > 0
    ? page.nextParams
    : null

  if (nextPage != null && nextPage > NIGHT_ALL_COMPATIBILITY_MAX_PAGE) {
    stopPagination(data, page, { warn: true })
    return response
  }

  let continuation = null
  let responseField = null
  if (mode === 'composite' && upstreamParams) {
    continuation = {
      type: 'params',
      value: upstreamParams,
      ...(nextPage == null ? {} : { requestPage: nextPage }),
    }
    responseField = 'params'
  } else if (upstreamCursor) {
    const stableParams = record(upstreamBody?.params) && !hasContinuationParams(upstreamBody.params)
      ? structuredClone(upstreamBody.params)
      : null
    continuation = {
      type: 'cursor',
      value: upstreamCursor,
      ...(stableParams ? { params: stableParams } : {}),
    }
    responseField = 'cursor'
  } else if (upstreamParams) {
    continuation = {
      type: 'params',
      value: upstreamParams,
      ...(nextPage == null ? {} : { requestPage: nextPage }),
    }
    responseField = 'params'
  } else if (nextPage != null) {
    continuation = { type: 'page', value: nextPage }
    responseField = 'cursor'
  }

  if (!continuation) return response
  const wrapped = encodeContinuation(codec, {
    contract: CURSOR_CONTRACT,
    operation,
    platform,
    scope,
    page: currentPage + 1,
    continuation,
  })
  if (!wrapped) {
    // An oversized provider token cannot safely cross the public boundary.
    // Keep the successful page and terminate traversal without another call.
    stopPagination(data, page)
    return response
  }

  if (responseField === 'cursor') {
    page.nextCursor = wrapped
    page.providerCursor = wrapped
    page.nextParams = null
    page.nextPage = null
    page.paginationMode = 'cursor'
  } else {
    page.nextCursor = null
    page.providerCursor = null
    page.nextParams = { cursor: wrapped }
    page.nextPage = null
    page.paginationMode = 'composite'
  }
  return response
}

/**
 * `/api/v1/data/search` has a deliberately strict Night-All v1 pageInfo
 * schema. Keep its wrapper separate from the legacy `data.page` projection so
 * pagination enforcement cannot add compatibility-only fields to pageInfo.
 */
export function capNightAllDataSearchTraversal(payload, {
  platform,
  page: currentPage,
  scope,
  codec,
}) {
  const response = structuredClone(payload)
  const data = response?.data
  const pageInfo = data?.pageInfo
  if (!record(data) || !record(pageInfo)) return response

  const stop = ({ warn = false } = {}) => {
    const advertisedContinuation = pageInfo.hasMore === true || pageInfo.nextCursor != null
    pageInfo.hasMore = false
    pageInfo.nextCursor = null
    pageInfo.cursorType = 'none'
    if (warn && advertisedContinuation) addPageLimitWarning(data)
  }

  if (pageInfo.hasMore === false) {
    stop()
    return response
  }
  if (currentPage >= NIGHT_ALL_COMPATIBILITY_MAX_PAGE) {
    stop({ warn: true })
    return response
  }

  const upstreamCursor = typeof pageInfo.nextCursor === 'string' && pageInfo.nextCursor
    ? pageInfo.nextCursor
    : null
  if (!upstreamCursor) {
    stop()
    return response
  }

  const wrapped = encodeContinuation(codec, {
    contract: CURSOR_CONTRACT,
    operation: 'data-search',
    platform,
    scope,
    page: currentPage + 1,
    continuation: { type: 'cursor', value: upstreamCursor },
  })
  if (!wrapped) {
    stop()
    return response
  }

  pageInfo.nextCursor = wrapped
  pageInfo.cursorType = 'opaque'
  return response
}
