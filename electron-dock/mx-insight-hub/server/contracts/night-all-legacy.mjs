export const NIGHT_ALL_LEGACY_OPERATIONS = new Set(['raw', 'crawl', 'user-info'])

export function parseNightAllLegacyArray(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The three compatibility routes share Night-All's documented standard raw
 * envelope. Keep this validator deliberately structural: platform-specific
 * item fields are allowed to evolve, while the two JSON-string collections
 * and the pagination/metadata containers remain stable.
 */
export function isNightAllLegacyEnvelope(payload) {
  const data = payload?.data
  return Boolean(
    data
    && typeof data === 'object'
    && !Array.isArray(data)
    && parseNightAllLegacyArray(data.raw_info)
    && parseNightAllLegacyArray(data.raw_data)
    && data.page
    && typeof data.page === 'object'
    && !Array.isArray(data.page)
    && data.meta
    && typeof data.meta === 'object'
    && !Array.isArray(data.meta),
  )
}

