export const NIGHT_ALL_LEGACY_OPERATIONS = new Set(['raw', 'crawl', 'user-info'])

export const NIGHT_ALL_LEGACY_SEARCH_CAPABILITIES_VERSION = 'night-all.legacy-search-capabilities.v1'

// Compatibility is pinned to the handlers in the currently deployed
// Night-All contract. This is a Hub routing boundary, not a claim that an
// upstream credential or provider is healthy at this instant.
export const NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS = Object.freeze({
  raw: Object.freeze([
    'bilibili', 'douyin', 'facebook', 'instagram', 'kuaishou', 'reddit',
    'tiktok', 'twitter', 'wechat_mp', 'wechat_search', 'weibo',
    'xiaohongshu', 'youtube', 'zhihu',
  ]),
  crawl: Object.freeze([
    'douyin', 'facebook', 'instagram', 'linkedin', 'reddit', 'tiktok',
    'twitter', 'weibo', 'xiaohongshu', 'youtube',
  ]),
  'user-info': Object.freeze([
    'douyin', 'facebook', 'instagram', 'linkedin', 'twitter', 'weibo',
    'xiaohongshu', 'zhihu',
  ]),
})

export function buildNightAllLegacySearchCapabilities(allowedPlatforms) {
  const allow = new Set((allowedPlatforms || []).map((platform) => String(platform).trim()))
  const operations = {}
  for (const operation of NIGHT_ALL_LEGACY_OPERATIONS) {
    const supportedPlatforms = NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS[operation]
      .filter((platform) => allow.has(platform))
    operations[operation] = {
      supportedPlatforms,
      // In this Hub-pinned contract, ready means "allowed to dispatch". The
      // old Night-All has no operation-specific readiness endpoint, so actual
      // provider availability remains a runtime upstream result.
      readyPlatforms: [...supportedPlatforms],
    }
  }
  return {
    contractVersion: NIGHT_ALL_LEGACY_SEARCH_CAPABILITIES_VERSION,
    operations,
  }
}

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
