// "邮箱库": a published list of e-mail addresses (one per source line).
//
// PostgreSQL only (schema account_dictionary). Queries answer "is this
// address in the list", local-part prefix, all addresses at a domain, and
// substring/similar-spelling on the local part.
import { AppError } from '../../core/errors.mjs'
import { fileDataset } from '../../../shared/file-datasets.mjs'

export const PRODUCT = fileDataset('email-directory')
export const DATASET_KEY = PRODUCT.key
export const PLATFORM = PRODUCT.platform
export const SEARCH_CAPABILITY = PRODUCT.searchCapability
export const CONTRACT_VERSION = 'mx-insight-hub.email-directory.v1'
export const PARSER_VERSION = 'text-lines.email.v1'
export const PARTITION_COUNT = 4
export const MAX_EMAIL_CHARS = 320
export const MAX_DOMAIN_CHARS = 253

export const QUERY_LIMITS = Object.freeze({
  defaultLimit: 20,
  maxLimit: 50,
  maxQueryChars: 320,
  prefixMinChars: 3,
  containsMinChars: 4,
  fuzzyMinChars: 4,
  fuzzyMaxChars: 64,
  fuzzyThreshold: 0.45,
  // Estimated candidate rows across the version (sampled trigram counts).
  containsMaxCandidates: 4_000_000,
  fuzzyMaxCandidates: 1_000_000,
  fastStatementTimeoutMs: 3_000,
  slowStatementTimeoutMs: 2_000,
  slowLaneSlots: 4,
  slowLaneWaitMs: 1_500,
})

export const MODES = Object.freeze(['email', 'prefix', 'domain', 'contains', 'fuzzy'])
// Modes that page with an opaque `after` cursor.
export const CURSOR_MODES = Object.freeze(['domain'])

export const FLAG_DOMAIN_CASE = 1
export const FLAG_VALUE_TRIMMED = 2

export const QUARANTINE_REASONS = Object.freeze({
  nul_character: '含 NUL 字符',
  invalid_text: '非法 UTF-8',
  empty_line: '空行',
  email_too_long: '邮箱超长',
  missing_at: '没有 @',
  empty_local: '@ 前为空',
  empty_domain: '@ 后为空',
  invalid_local: '@ 前含空白或控制字符',
  invalid_domain: '域名含空白或控制字符',
})

const INVALID_PART = /[\s\u0000-\u001f\u007f]/

/** Classify one source line `{ text, issue }` from the line reader. */
export function classifyEmailLine(line) {
  if (line.issue) return { reason: line.issue }
  const trimmed = line.text.trim()
  if (trimmed === '') return { reason: 'empty_line' }
  if (trimmed.length > MAX_EMAIL_CHARS) return { reason: 'email_too_long' }
  const at = trimmed.lastIndexOf('@')
  if (at < 0) return { reason: 'missing_at' }
  const local = trimmed.slice(0, at)
  const rawDomain = trimmed.slice(at + 1)
  if (local === '') return { reason: 'empty_local' }
  if (rawDomain === '') return { reason: 'empty_domain' }
  if (INVALID_PART.test(local)) return { reason: 'invalid_local' }
  const domain = rawDomain.toLowerCase()
  if (domain.length > MAX_DOMAIN_CHARS || INVALID_PART.test(domain)) return { reason: 'invalid_domain' }
  let flags = 0
  if (domain !== rawDomain) flags |= FLAG_DOMAIN_CASE
  if (trimmed !== line.text) flags |= FLAG_VALUE_TRIMMED
  return { local, domain, flags }
}

export function maskLocal(local) {
  const chars = [...local]
  const keep = chars.length <= 3 ? 1 : 2
  return `${chars.slice(0, keep).join('')}***`
}

function invalid(message) {
  return new AppError(400, 'invalid_request', message)
}

function normalizeDomain(value) {
  if (typeof value !== 'string') throw invalid('domain must be a string')
  const domain = value.trim().toLowerCase().replace(/^@/, '')
  if (!domain || domain.length > MAX_DOMAIN_CHARS || INVALID_PART.test(domain) || domain.includes('@')) throw invalid('domain is invalid')
  return domain
}

// Cursor: base64url JSON [lower(local), first_ordinal] of the last row.
export function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.local_key, String(row.first_ordinal)])).toString('base64url')
}

function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 1024) throw invalid('after must be a cursor returned by a previous page')
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && /^\d{1,19}$/.test(parsed[1])) {
      return { localKey: parsed[0], ordinal: parsed[1] }
    }
  } catch {}
  throw invalid('after must be a cursor returned by a previous page')
}

const REQUEST_FIELDS = new Set(['mode', 'query', 'domain', 'limit', 'after', 'reveal'])

/** Validate a public search body; never echoes the query into errors. */
export function normalizeEmailSearchRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object')
  const unsupported = Object.keys(body).filter(key => !REQUEST_FIELDS.has(key))
  if (unsupported.length) throw new AppError(400, 'unsupported_fields', `Unsupported fields: ${unsupported.join(', ')}`)
  const mode = body.mode ?? 'email'
  if (!MODES.includes(mode)) throw invalid(`mode must be one of ${MODES.join(', ')}`)
  if (typeof body.query !== 'string') throw invalid('query must be a string')
  const query = body.query.trim()
  if (!query) throw invalid('query is required')
  if (query.includes('\u0000')) throw invalid('query contains an invalid character')
  const chars = [...query].length
  if (chars > QUERY_LIMITS.maxQueryChars) throw invalid(`query must be at most ${QUERY_LIMITS.maxQueryChars} characters`)
  let limit = QUERY_LIMITS.defaultLimit
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > QUERY_LIMITS.maxLimit) {
      throw invalid(`limit must be an integer between 1 and ${QUERY_LIMITS.maxLimit}`)
    }
    limit = body.limit
  }
  if (body.reveal !== undefined && typeof body.reveal !== 'boolean') throw invalid('reveal must be a boolean')
  const hasDomain = body.domain !== undefined && body.domain !== null && body.domain !== ''
  if (body.after !== undefined && body.after !== null && !CURSOR_MODES.includes(mode)) throw invalid('after applies only to domain mode')
  const normalized = { mode, query, domain: null, limit, after: null, reveal: body.reveal !== false }
  if (mode === 'email') {
    if (hasDomain) throw invalid('email mode takes the domain from the query')
    const at = query.lastIndexOf('@')
    const local = at > 0 ? query.slice(0, at) : ''
    const domain = at > 0 ? query.slice(at + 1).toLowerCase() : ''
    if (!local || !domain || INVALID_PART.test(domain)) throw invalid('email mode needs a complete address such as name@example.com')
    normalized.local = local
    normalized.domain = domain
    return normalized
  }
  if (mode === 'domain') {
    if (hasDomain) throw invalid('domain mode takes the domain from the query')
    normalized.domain = normalizeDomain(query)
    normalized.query = normalized.domain
    if (body.after !== undefined && body.after !== null) normalized.after = decodeCursor(body.after)
    return normalized
  }
  if (query.includes('@')) throw invalid('prefix, contains and fuzzy search the part before @; pass the domain separately')
  if (hasDomain) normalized.domain = normalizeDomain(body.domain)
  if (mode === 'prefix' && chars < QUERY_LIMITS.prefixMinChars) throw invalid(`prefix needs at least ${QUERY_LIMITS.prefixMinChars} characters`)
  if (mode === 'contains' && chars < QUERY_LIMITS.containsMinChars) throw invalid(`contains needs at least ${QUERY_LIMITS.containsMinChars} characters`)
  if (mode === 'fuzzy') {
    if (chars < QUERY_LIMITS.fuzzyMinChars) throw invalid(`fuzzy needs at least ${QUERY_LIMITS.fuzzyMinChars} characters`)
    if (chars > QUERY_LIMITS.fuzzyMaxChars) throw invalid(`fuzzy accepts at most ${QUERY_LIMITS.fuzzyMaxChars} characters`)
  }
  return normalized
}
