import { parseNightAllLegacyArray } from './night-all-legacy.mjs'

export const NIGHT_ALL_COUNT_AUDIT_CONTRACT = 'mx-insight-hub.night-all-count-audit.v1'

// A declared count that contradicts the delivered collection is a data-quality
// fact about the envelope, not a transport or billing failure. It is reported
// with its own code so an existing `partial` business outcome, stale-fallback
// window and billing unit calculation keep their current meaning.
export const NIGHT_ALL_COUNT_MISMATCH_WARNING = 'COUNT_DECLARATION_MISMATCH'

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// Only a non-negative safe integer is a declaration. `null`, absent and
// malformed values mean "the producer said nothing" and are never a mismatch.
function declaredInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

/**
 * Reconcile the counts a Night-All standard raw envelope declares against the
 * rows its JSON-string collections actually carry.
 *
 * Pure and read-only: it works the same on a live upstream payload and on an
 * archived response body, so historical deliveries can be audited without any
 * migration or re-dispatch. Returns null when the payload is not a legacy
 * envelope at all (an error body, a modern projection, a stored fallback of a
 * different shape) rather than inventing a discrepancy.
 */
export function nightAllLegacyCountAudit(payload) {
  const data = payload?.data
  if (!record(data)) return null
  const rawData = parseNightAllLegacyArray(data.raw_data)
  const rawInfo = parseNightAllLegacyArray(data.raw_info)
  if (!rawData || !rawInfo) return null

  const page = record(data.page) ? data.page : {}
  const meta = record(data.meta) ? data.meta : {}
  // The envelope carries content rows in raw_data and identity rows in
  // raw_info. Mirror Night-All's own `rawDataRows.length || rawInfoRows.length`
  // resolution so a user-info delivery is not judged against an empty
  // content collection.
  const primaryCount = rawData.length > 0 || rawInfo.length === 0
    ? rawData.length
    : rawInfo.length
  const expected = {
    'page.returnedCount': primaryCount,
    'meta.resultCount': primaryCount,
    'meta.rawDataCount': rawData.length,
    'meta.rawInfoCount': rawInfo.length,
  }
  const declared = {
    'page.returnedCount': declaredInteger(page.returnedCount),
    'meta.resultCount': declaredInteger(meta.resultCount),
    'meta.rawDataCount': declaredInteger(meta.rawDataCount),
    'meta.rawInfoCount': declaredInteger(meta.rawInfoCount),
  }
  const mismatches = Object.entries(declared).flatMap(([field, value]) => (
    value == null || value === expected[field]
      ? []
      : [{ field, declared: value, actual: expected[field] }]
  ))

  return Object.freeze({
    contractVersion: NIGHT_ALL_COUNT_AUDIT_CONTRACT,
    actual: Object.freeze({
      rawDataCount: rawData.length,
      rawInfoCount: rawInfo.length,
      primaryCount,
    }),
    declared: Object.freeze({
      returnedCount: declared['page.returnedCount'],
      resultCount: declared['meta.resultCount'],
      rawDataCount: declared['meta.rawDataCount'],
      rawInfoCount: declared['meta.rawInfoCount'],
    }),
    mismatches: Object.freeze(mismatches.map((entry) => Object.freeze(entry))),
    consistent: mismatches.length === 0,
  })
}

export function nightAllLegacyCountMismatchMessage(audit) {
  return audit.mismatches
    .map((entry) => `${entry.field}=${entry.declared} but the delivered rows are ${entry.actual}`)
    .join('; ')
}

/**
 * Append the mismatch warning without touching any acquired business field.
 * The original payload is never mutated and a consistent envelope is returned
 * unchanged, so a correct delivery stays byte-for-byte what upstream produced.
 */
export function withNightAllLegacyCountWarning(payload, audit = nightAllLegacyCountAudit(payload)) {
  if (!audit || audit.consistent) return payload
  const warnings = Array.isArray(payload.data.warnings) ? payload.data.warnings : []
  if (warnings.some((entry) => entry?.code === NIGHT_ALL_COUNT_MISMATCH_WARNING)) return payload
  return {
    ...payload,
    data: {
      ...payload.data,
      warnings: [...warnings, {
        code: NIGHT_ALL_COUNT_MISMATCH_WARNING,
        message: nightAllLegacyCountMismatchMessage(audit),
      }],
    },
  }
}
