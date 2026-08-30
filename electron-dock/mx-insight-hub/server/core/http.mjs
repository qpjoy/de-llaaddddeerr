import { AppError } from './errors.mjs'

export async function readJson(request, limitBytes = 1_048_576) {
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

/**
 * Read a raw binary body, for file imports.
 *
 * File uploads deliberately do NOT use multipart/form-data. Multipart needs its
 * own parser for attacker-controlled input — boundary handling, header
 * injection, part-count exhaustion — and this path already accepts untrusted
 * spreadsheets. A raw body with the filename in a query parameter carries the
 * same information with no parser at all.
 */
export async function readBuffer(request, limitBytes = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limitBytes) {
      throw new AppError(413, 'payload_too_large', `Upload exceeds ${limitBytes} bytes`)
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) throw new AppError(400, 'empty_body', 'Request body is empty')
  return Buffer.concat(chunks)
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

export function bearerToken(request) {
  const value = request.headers.authorization
  if (!value || !value.startsWith('Bearer ')) return null
  return value.slice('Bearer '.length).trim() || null
}

export function publicApiKey(request) {
  const headerValue = request.headers['x-api-key']
  return (typeof headerValue === 'string' && headerValue.trim()) || bearerToken(request)
}

export function routeMatch(pathname, pattern) {
  const pathParts = pathname.split('/').filter(Boolean)
  const patternParts = pattern.split('/').filter(Boolean)
  if (pathParts.length !== patternParts.length) return null
  const params = {}
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index]
    const actual = pathParts[index]
    if (expected.startsWith(':')) {
      try {
        params[expected.slice(1)] = decodeURIComponent(actual)
      } catch {
        return null
      }
    }
    else if (expected !== actual) return null
  }
  return params
}
