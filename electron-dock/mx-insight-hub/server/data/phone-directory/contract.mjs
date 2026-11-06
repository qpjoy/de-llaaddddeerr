// "手机号库": a published list of international phone numbers (one per line).
//
// PostgreSQL only (schema account_dictionary). Numbers are stored as E.164
// digits without "+"; queries are exact, prefix (country/area code) and
// suffix (last digits). There is no substring search: with ten symbols,
// digit trigrams cannot narrow a 12M-row list.
import { AppError } from '../../core/errors.mjs'
import { fileDataset } from '../../../shared/file-datasets.mjs'

export const PRODUCT = fileDataset('phone-directory')
export const DATASET_KEY = PRODUCT.key
export const PLATFORM = PRODUCT.platform
export const SEARCH_CAPABILITY = PRODUCT.searchCapability
export const CONTRACT_VERSION = 'mx-insight-hub.phone-directory.v1'
export const PARSER_VERSION = 'text-lines.phone-e164.v1'
export const PARTITION_COUNT = 4
// E.164: country code (never starting with 0) + subscriber number, <= 15 digits.
export const MIN_DIGITS = 6
export const MAX_DIGITS = 15

export const QUERY_LIMITS = Object.freeze({
  defaultLimit: 20,
  maxLimit: 50,
  prefixMinDigits: 4,
  suffixMinDigits: 4,
  fastStatementTimeoutMs: 3_000,
})

export const MODES = Object.freeze(['exact', 'prefix', 'suffix'])
export const CURSOR_MODES = Object.freeze(['prefix', 'suffix'])

export const FLAG_NO_PLUS = 1
export const FLAG_FORMATTED = 2

export const QUARANTINE_REASONS = Object.freeze({
  nul_character: '含 NUL 字符',
  invalid_text: '非法 UTF-8',
  empty_line: '空行',
  invalid_phone: '含数字以外的字符',
  phone_length: '位数不在 6–15 之间',
  invalid_country_code: '国家码以 0 开头',
})

const SEPARATORS = /[\s\-().]/g

/** Classify one source line `{ text, issue }` from the line reader. */
export function classifyPhoneLine(line) {
  if (line.issue) return { reason: line.issue }
  const trimmed = line.text.trim()
  if (trimmed === '') return { reason: 'empty_line' }
  let flags = 0
  let rest = trimmed
  if (rest.startsWith('+')) rest = rest.slice(1)
  else flags |= FLAG_NO_PLUS
  const digits = rest.replace(SEPARATORS, '')
  if (digits !== rest) flags |= FLAG_FORMATTED
  if (!/^\d+$/.test(digits)) return { reason: 'invalid_phone' }
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return { reason: 'phone_length' }
  if (digits[0] === '0') return { reason: 'invalid_country_code' }
  return { digits, flags }
}

export function maskPhone(digits) {
  if (digits.length <= 6) return `+${digits.slice(0, 2)}****`
  return `+${digits.slice(0, 3)}${'*'.repeat(digits.length - 5)}${digits.slice(-2)}`
}

function invalid(message) {
  return new AppError(400, 'invalid_request', message)
}

/** "+1 (415) 555-0123" -> "14155550123"; null when anything else is left. */
export function queryDigits(value) {
  const digits = value.trim().replace(/^\+/, '').replace(SEPARATORS, '')
  return /^\d+$/.test(digits) ? digits : null
}

const REQUEST_FIELDS = new Set(['mode', 'query', 'limit', 'after', 'reveal'])

/** Validate a public search body; never echoes the query into errors. */
export function normalizePhoneSearchRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('Request body must be a JSON object')
  const unsupported = Object.keys(body).filter(key => !REQUEST_FIELDS.has(key))
  if (unsupported.length) throw new AppError(400, 'unsupported_fields', `Unsupported fields: ${unsupported.join(', ')}`)
  const mode = body.mode ?? 'exact'
  if (!MODES.includes(mode)) throw invalid(`mode must be one of ${MODES.join(', ')}`)
  if (typeof body.query !== 'string' || body.query.length > 64) throw invalid('query must be a string of at most 64 characters')
  const digits = queryDigits(body.query)
  if (!digits) throw invalid('query must be a phone number or digits (spaces, -, (, ), . and a leading + are ignored)')
  if (digits.length > MAX_DIGITS) throw invalid(`query has more than ${MAX_DIGITS} digits`)
  if (mode === 'exact' && digits.length < MIN_DIGITS) throw invalid(`exact needs a full number of at least ${MIN_DIGITS} digits including the country code`)
  if (mode === 'prefix' && digits.length < QUERY_LIMITS.prefixMinDigits) throw invalid(`prefix needs at least ${QUERY_LIMITS.prefixMinDigits} digits including the country code`)
  if (mode === 'suffix' && digits.length < QUERY_LIMITS.suffixMinDigits) throw invalid(`suffix needs at least ${QUERY_LIMITS.suffixMinDigits} digits`)
  let limit = QUERY_LIMITS.defaultLimit
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > QUERY_LIMITS.maxLimit) {
      throw invalid(`limit must be an integer between 1 and ${QUERY_LIMITS.maxLimit}`)
    }
    limit = body.limit
  }
  if (body.reveal !== undefined && typeof body.reveal !== 'boolean') throw invalid('reveal must be a boolean')
  let after = null
  if (body.after !== undefined && body.after !== null) {
    if (!CURSOR_MODES.includes(mode)) throw invalid('after applies only to prefix and suffix modes')
    if (typeof body.after !== 'string' || !/^\d{1,15}$/.test(body.after)) throw invalid('after must be a cursor returned by a previous page')
    after = body.after
  }
  return { mode, query: digits, limit, after, reveal: body.reveal !== false }
}
