import { AppError } from './errors.mjs'

export async function readJson(request, limitBytes = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) {
      throw new AppError(413, 'payload_too_large', 'Request body is too large')
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new AppError(400, 'invalid_json', 'Request body must be valid JSON')
  }
}

export function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...headers,
  })
  response.end(body)
}

export const SESSION_COOKIE = 'mxt_session'

function cookieValue(request, name) {
  const header = request.headers.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim()) || null
    }
  }
  return null
}

/**
 * The caller's credential, from the Authorization header or the session cookie.
 *
 * The cookie is not a convenience: a `<video src>` or an `<img src>` cannot
 * carry an Authorization header, so recordings and screenshots would be
 * unviewable without it. Putting the token in the query string instead would
 * leak it into access logs, browser history and Referer headers.
 */
export function bearerToken(request) {
  const value = request.headers.authorization
  if (value && value.startsWith('Bearer ')) {
    return value.slice('Bearer '.length).trim() || null
  }
  return cookieValue(request, SESSION_COOKIE)
}

export function sessionCookie(token, { secure, maxAgeSeconds = 43_200 }) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Lax rather than Strict: a report link pasted into chat should still open
    // logged in. It is a GET-only relaxation; every mutating route is POST.
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

/**
 * Match a pathname against a pattern with `:name` segments.
 *
 * A trailing `:verb` on the last pattern segment (`/runs/:runId:complete`) is an
 * action suffix, not a parameter: it must appear literally in the path. This is
 * the shape the API contract uses for non-CRUD operations.
 *
 * A trailing `*` captures the remaining path into `params['*']`, for artifact
 * paths that legitimately contain slashes (`videos/smoke/auth.cy.ts.mp4`).
 */
export function routeMatch(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean)
  const patternParts = pattern.split('/').filter(Boolean)
  const params = {}

  if (patternParts.at(-1) === '*') {
    const head = patternParts.slice(0, -1)
    if (pathParts.length <= head.length) return null
    const matched = routeMatch(`/${pathParts.slice(0, head.length).join('/')}`, `/${head.join('/')}`)
    if (!matched) return null
    return {
      ...matched,
      '*': pathParts
        .slice(head.length)
        .map((part) => decodeURIComponent(part))
        .join('/'),
    }
  }

  if (pathParts.length !== patternParts.length) return null
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]
    const actual = pathParts[index]
    if (!expected.startsWith(':')) {
      if (expected !== actual) return null
      continue
    }
    const suffixAt = expected.indexOf(':', 1)
    if (suffixAt === -1) {
      params[expected.slice(1)] = decodeURIComponent(actual)
      continue
    }
    // `:runId:complete` — the action suffix is literal, the prefix is the value.
    const action = expected.slice(suffixAt)
    if (!actual.endsWith(action) || actual.length === action.length) return null
    params[expected.slice(1, suffixAt)] = decodeURIComponent(actual.slice(0, -action.length))
  }
  return params
}

export function requiredString(body, name, { maxLength = 300 } = {}) {
  const value = body?.[name]
  if (typeof value !== 'string' || !value.trim()) {
    throw new AppError(400, 'invalid_request', `${name} is required`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new AppError(400, 'invalid_request', `${name} exceeds ${maxLength} characters`)
  }
  return trimmed
}

export function optionalString(body, name, { maxLength = 300 } = {}) {
  const value = body?.[name]
  if (value == null || value === '') return null
  if (typeof value !== 'string') {
    throw new AppError(400, 'invalid_request', `${name} must be a string`)
  }
  const trimmed = value.trim()
  if (trimmed.length > maxLength) {
    throw new AppError(400, 'invalid_request', `${name} exceeds ${maxLength} characters`)
  }
  return trimmed || null
}

export function enumValue(body, name, allowed, fallback) {
  const value = body?.[name]
  if (value == null || value === '') {
    if (fallback === undefined) {
      throw new AppError(400, 'invalid_request', `${name} is required`)
    }
    return fallback
  }
  if (!allowed.includes(value)) {
    throw new AppError(400, 'invalid_request', `${name} must be one of ${allowed.join(', ')}`)
  }
  return value
}

export function stringArray(value, { maxItems = 200, maxLength = 240 } = {}) {
  if (value == null) return []
  if (!Array.isArray(value)) {
    throw new AppError(400, 'invalid_request', 'Expected an array of strings')
  }
  return value
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .slice(0, maxItems)
    .map((entry) => entry.trim().slice(0, maxLength))
}
