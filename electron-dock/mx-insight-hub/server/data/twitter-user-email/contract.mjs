// Twitter username/email dictionary: public contract, limits and validation.
//
// Stored in PostgreSQL only (schema account_dictionary). Nothing here writes
// canonical records, the outbox, Elasticsearch, HanLP or embeddings.
import { AppError } from '../../core/errors.mjs'

export const DATASET_KEY = 'twitter-user-email'
export const PIPELINE_KEY = 'twitter-user-email'
export const PRODUCT_LABEL = 'Twitter 用户邮箱'
export const PIPELINE_LABEL = 'Twitter 用户清洗计划'
export const PLATFORM = 'twitter_user_email'
export const SEARCH_CAPABILITY = 'twitter.user_email.search'
export const REVEAL_CAPABILITY = 'twitter.user_email.reveal'
export const SEARCH_PATH = '/api/v1/data/twitter-user-email/search'
export const METADATA_PATH = '/api/v1/data/twitter-user-email/metadata'
export const PRODUCT_PATH = '/data-products/twitter-user-email'
export const CONTRACT_VERSION = 'mx-insight-hub.twitter-user-email.v1'
export const PARSER_VERSION = 'json-object-string-pairs.v1'

// Built-in tuning (no env keys). Measured on a 12.5M-row synthetic partition;
// see docs/architecture/twitter-user-email-dictionary.md.
export const PARTITION_COUNT = 16
export const IMPORT_BATCH_PAIRS = 50_000
export const IMPORT_READ_CHUNK_BYTES = 8 * 1024 * 1024
export const IMPORT_TARGET_ROWS_PER_SECOND = 25_000
export const IMPORT_SLOW_COMMIT_MS = 3_000
export const SHA_MAX_BYTES_PER_SECOND = 200 * 1024 * 1024
export const MAX_USERNAME_CHARS = 256
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
  // Upper bounds of estimated candidate rows across the whole version. Above
  // these, the query is refused as too broad before touching the indexes.
  containsMaxCandidates: 20_000_000,
  fuzzyMaxCandidates: 3_000_000,
  fastStatementTimeoutMs: 3_000,
  slowStatementTimeoutMs: 2_000,
  // Contains/fuzzy queries share these slots across every Hub process.
  slowLaneSlots: 4,
  slowLaneWaitMs: 1_500,
})

export const MODES = Object.freeze(['username', 'email', 'prefix', 'contains', 'fuzzy'])
export const FIELDS = Object.freeze(['username', 'email_local'])

// Flags stored per mapping row.
export const FLAG_DOMAIN_CASE = 1
export const FLAG_VALUE_TRIMMED = 2

export const QUARANTINE_REASONS = Object.freeze({
  nul_character: '含 NUL 字符',
  invalid_text: '非法 Unicode 或转义',
  non_string_value: '值不是字符串',
  empty_username: '用户名为空',
  username_too_long: '用户名超长',
  email_too_long: '邮箱超长',
  missing_at: '值里没有 @',
  empty_local: '@ 前为空',
  empty_domain: '@ 后为空',
  invalid_domain: '域名含空白或控制字符',
})

const DOMAIN_INVALID = /[\s\u0000-\u001f\u007f]/

/**
 * Classify one decoded source pair.
 * `key`/`value` are { text, issue } from the JSON scanner; `value.nonString`
 * marks a non-string JSON value.
 */
export function classifyPair(key, value) {
  if (key.issue) return { reason: key.issue }
  if (value.nonString) return { reason: 'non_string_value' }
  if (value.issue) return { reason: value.issue }
  const username = key.text
  if (username.trim() === '') return { reason: 'empty_username' }
  if (username.length > MAX_USERNAME_CHARS) return { reason: 'username_too_long' }
  const trimmed = value.text.trim()
  if (trimmed.length > MAX_EMAIL_CHARS) return { reason: 'email_too_long' }
  const at = trimmed.lastIndexOf('@')
  if (at < 0) return { reason: 'missing_at' }
  const local = trimmed.slice(0, at)
  const rawDomain = trimmed.slice(at + 1)
  if (local === '') return { reason: 'empty_local' }
  if (rawDomain === '') return { reason: 'empty_domain' }
  const domain = rawDomain.toLowerCase()
  if (domain.length > MAX_DOMAIN_CHARS || DOMAIN_INVALID.test(domain)) return { reason: 'invalid_domain' }
  let flags = 0
  if (domain !== rawDomain) flags |= FLAG_DOMAIN_CASE
  if (trimmed !== value.text) flags |= FLAG_VALUE_TRIMMED
  return { username, local, domain, flags }
}

export function maskLocal(local) {
  const chars = [...local]
  const keep = chars.length <= 3 ? 1 : 2
  return `${chars.slice(0, keep).join('')}***`
}

export function maskEmail(local, domain) {
  return `${maskLocal(local)}@${domain}`
}

export function escapeLike(value) {
  return value.replace(/[\\%_]/g, '\\$&')
}

function invalid(message) {
  return new AppError(400, 'invalid_request', message)
}

const REQUEST_FIELDS = new Set(['mode', 'query', 'field', 'domain', 'limit', 'reveal'])

/**
 * Validate a public search body. Returns a normalized request; never echoes
 * the query into error messages.
 */
export function normalizeSearchRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object')
  const unsupported = Object.keys(body).filter(key => !REQUEST_FIELDS.has(key))
  if (unsupported.length) throw new AppError(400, 'unsupported_fields', `Unsupported fields: ${unsupported.join(', ')}`)
  const mode = body.mode ?? 'username'
  if (!MODES.includes(mode)) throw invalid(`mode must be one of ${MODES.join(', ')}`)
  if (typeof body.query !== 'string') throw invalid('query must be a string')
  const query = body.query.trim()
  if (!query) throw invalid('query is required')
  if (query.includes('\u0000')) throw invalid('query contains an invalid character')
  if ([...query].length > QUERY_LIMITS.maxQueryChars) throw invalid(`query must be at most ${QUERY_LIMITS.maxQueryChars} characters`)
  const field = body.field ?? 'username'
  if (!FIELDS.includes(field)) throw invalid(`field must be one of ${FIELDS.join(', ')}`)
  if (mode === 'username' || mode === 'email') {
    if (body.field !== undefined) throw invalid('field applies only to prefix, contains and fuzzy modes')
  }
  let domain = null
  if (body.domain !== undefined && body.domain !== null && body.domain !== '') {
    if (typeof body.domain !== 'string') throw invalid('domain must be a string')
    domain = body.domain.trim().toLowerCase().replace(/^@/, '')
    if (!domain || domain.length > MAX_DOMAIN_CHARS || DOMAIN_INVALID.test(domain) || domain.includes('@')) throw invalid('domain is invalid')
    if (mode === 'email') throw invalid('email mode takes the domain from the query')
  }
  let limit = QUERY_LIMITS.defaultLimit
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > QUERY_LIMITS.maxLimit) {
      throw invalid(`limit must be an integer between 1 and ${QUERY_LIMITS.maxLimit}`)
    }
    limit = body.limit
  }
  if (body.reveal !== undefined && typeof body.reveal !== 'boolean') throw invalid('reveal must be a boolean')
  const chars = [...query].length
  const normalized = { mode, field: mode === 'username' || mode === 'email' ? null : field, query, domain, limit, reveal: body.reveal === true }
  if (mode === 'email') {
    const at = query.lastIndexOf('@')
    const local = at > 0 ? query.slice(0, at) : ''
    const emailDomain = at > 0 ? query.slice(at + 1).toLowerCase() : ''
    if (!local || !emailDomain || DOMAIN_INVALID.test(emailDomain)) throw invalid('email mode needs a complete address such as name@example.com')
    normalized.local = local
    normalized.domain = emailDomain
  } else if (mode === 'prefix' && chars < QUERY_LIMITS.prefixMinChars) {
    throw invalid(`prefix needs at least ${QUERY_LIMITS.prefixMinChars} characters`)
  } else if (mode === 'contains' && chars < QUERY_LIMITS.containsMinChars) {
    throw invalid(`contains needs at least ${QUERY_LIMITS.containsMinChars} characters`)
  } else if (mode === 'fuzzy') {
    if (chars < QUERY_LIMITS.fuzzyMinChars) throw invalid(`fuzzy needs at least ${QUERY_LIMITS.fuzzyMinChars} characters`)
    if (chars > QUERY_LIMITS.fuzzyMaxChars) throw invalid(`fuzzy accepts at most ${QUERY_LIMITS.fuzzyMaxChars} characters`)
  }
  if (mode === 'username' && chars > MAX_USERNAME_CHARS) throw invalid(`username must be at most ${MAX_USERNAME_CHARS} characters`)
  return normalized
}
