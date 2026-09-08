import { AppError } from '../core/errors.mjs'

export const BILLING_METER_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/u
export const PRICE_BOOK_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u
export const PLAN_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/u
export const BILLING_PROFILE_MODES = Object.freeze(['disabled', 'shadow', 'enforced'])
export const BILLING_UNITS = Object.freeze(['request'])

function assert(condition, status, code, message, details) {
  if (!condition) throw new AppError(status, code, message, details)
}

function plainObject(value, message = 'JSON object is required') {
  assert(value && typeof value === 'object' && !Array.isArray(value), 400, 'invalid_request', message)
  return value
}

function strictFields(value, allowed, label) {
  const unsupported = Object.keys(value).filter((field) => !allowed.includes(field))
  assert(
    unsupported.length === 0,
    400,
    'unsupported_fields',
    `Unsupported ${label} fields: ${unsupported.join(', ')}`,
  )
}

function boundedInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (optional && (value == null || value === '')) return null
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    400,
    'invalid_request',
    `${name} must be an integer between ${min} and ${max}`,
  )
  return value
}

function safeText(value, name, maxLength) {
  assert(typeof value === 'string', 400, 'invalid_request', `${name} is required`)
  const normalized = value.normalize('NFKC').trim()
  assert(
    normalized.length > 0
      && normalized.length <= maxLength
      && !/[\u0000-\u001f\u007f]/u.test(normalized),
    400,
    'invalid_request',
    `${name} must contain 1-${maxLength} safe characters`,
  )
  return normalized
}

function currencyCode(value) {
  const currency = String(value || '').trim().toUpperCase()
  assert(/^[A-Z]{3}$/u.test(currency), 400, 'invalid_request', 'currency must be a three-letter ISO code')
  return currency
}

export function normalizePlanLimits(input = {}) {
  const value = plainObject(input, 'limits must be an object')
  strictFields(
    value,
    ['monthlyRequests', 'maxRequests', 'windowSeconds', 'maxPageSize', 'burstRps'],
    'plan limit',
  )
  assert(
    Object.hasOwn(value, 'maxRequests') === Object.hasOwn(value, 'windowSeconds'),
    400,
    'invalid_request',
    'maxRequests and windowSeconds must be supplied together',
  )
  const result = {}
  for (const [field, max] of [
    ['monthlyRequests', 2_147_483_647],
    ['maxRequests', 2_147_483_647],
    ['windowSeconds', 31_536_000],
    ['maxPageSize', 1_000],
    ['burstRps', 100_000],
  ]) {
    if (Object.hasOwn(value, field)) result[field] = boundedInteger(value[field], field, { min: 1, max })
  }
  return result
}

export function normalizeCustomerPriceBook(input) {
  const value = plainObject(input, 'priceBook must be an object')
  strictFields(value, ['key', 'currency', 'defaultMultiplierPpm', 'entries'], 'price book')
  const key = String(value.key || '').trim().toLowerCase()
  assert(PRICE_BOOK_KEY_PATTERN.test(key), 400, 'invalid_request', 'priceBook.key is invalid')
  const entries = Array.isArray(value.entries) ? value.entries : null
  assert(entries && entries.length > 0 && entries.length <= 256, 400, 'invalid_request', 'priceBook.entries must contain 1-256 rates')
  const seen = new Set()
  const normalizedEntries = entries.map((entry, index) => {
    const candidate = plainObject(entry, `priceBook.entries[${index}] must be an object`)
    strictFields(candidate, ['meterKey', 'unitPriceMinor', 'billingUnit'], `priceBook.entries[${index}]`)
    const meterKey = String(candidate.meterKey || '').trim().toLowerCase()
    assert(BILLING_METER_PATTERN.test(meterKey), 400, 'invalid_request', `priceBook.entries[${index}].meterKey is invalid`)
    assert(!seen.has(meterKey), 400, 'invalid_request', `Duplicate price meter: ${meterKey}`)
    seen.add(meterKey)
    const billingUnit = candidate.billingUnit || 'request'
    assert(BILLING_UNITS.includes(billingUnit), 400, 'invalid_request', 'Only request billing is supported in this release')
    return {
      meterKey,
      billingUnit,
      unitPriceMinor: boundedInteger(candidate.unitPriceMinor, 'unitPriceMinor', { min: 0 }),
    }
  })
  return {
    key,
    currency: currencyCode(value.currency),
    defaultMultiplierPpm: boundedInteger(
      value.defaultMultiplierPpm ?? 1_000_000,
      'defaultMultiplierPpm',
      { min: 0, max: 100_000_000 },
    ),
    entries: normalizedEntries.sort((left, right) => left.meterKey.localeCompare(right.meterKey)),
  }
}

export function normalizePublishedPlan(input) {
  const value = plainObject(input)
  strictFields(value, ['key', 'name', 'limits', 'priceBook'], 'plan')
  const key = String(value.key || '').trim().toLowerCase()
  assert(PLAN_KEY_PATTERN.test(key), 400, 'invalid_request', 'key must be a stable lowercase identifier')
  return {
    key,
    name: safeText(value.name, 'name', 128),
    limits: normalizePlanLimits(value.limits || {}),
    priceBook: normalizeCustomerPriceBook(value.priceBook),
  }
}

export function normalizeBillingProfile(input) {
  const value = plainObject(input)
  strictFields(value, ['mode', 'multiplierPpm', 'expectedRevision'], 'billing profile')
  const mode = String(value.mode || '').trim().toLowerCase()
  assert(BILLING_PROFILE_MODES.includes(mode), 400, 'invalid_request', 'mode must be disabled, shadow, or enforced')
  return {
    mode,
    multiplierPpm: value.multiplierPpm == null
      ? null
      : boundedInteger(value.multiplierPpm, 'multiplierPpm', { min: 0, max: 100_000_000 }),
    expectedRevision: value.expectedRevision == null
      ? null
      : boundedInteger(value.expectedRevision, 'expectedRevision', { min: 1, max: 2_147_483_647 }),
  }
}

export function normalizeCreditAdjustment(input) {
  const value = plainObject(input)
  strictFields(value, ['amountMinor', 'currency', 'reason', 'externalReference'], 'credit adjustment')
  return {
    amountMinor: boundedInteger(value.amountMinor, 'amountMinor', { min: 1 }),
    currency: currencyCode(value.currency),
    reason: safeText(value.reason, 'reason', 256),
    externalReference: value.externalReference == null
      ? null
      : safeText(value.externalReference, 'externalReference', 256),
  }
}

export function usageMeterKey({ meterKey, capability, platform }) {
  const value = String(meterKey || capability || platform || '').trim().toLowerCase()
  assert(BILLING_METER_PATTERN.test(value), 500, 'invalid_usage_meter', 'Usage meter key is invalid')
  return value
}

export function quotedMinor(unitPriceMinor, multiplierPpm) {
  const price = BigInt(unitPriceMinor)
  const multiplier = BigInt(multiplierPpm)
  return Number((price * multiplier + 999_999n) / 1_000_000n)
}
