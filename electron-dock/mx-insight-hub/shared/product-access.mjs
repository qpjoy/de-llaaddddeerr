import { WECHAT_PRODUCTS, wechatServices } from './wechat.mjs'
// Console visibility follows current consumer grants, independent of key issue/binding dates.
import nativeServiceCapabilities from './native-service-access.json' with { type: 'json' }
import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../server/contracts/night-all-legacy.mjs'

// Match aggregateSourceCatalog's stored-search domain. Live operations still
// enforce their own capability grants; a product entry never grants API access.
const searchablePlatforms = new Set([
  ...NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.raw,
  'wechat_mp', 'wechat_search',
  'telegram', 'public_opinion', 'ecommerce', 'social', 'mobile_commerce',
])
const savedRecordCategory = platform => /^data_center_saved_records_[a-z][a-z0-9_]*$/.test(platform)
export const PRODUCT_ACCESS = {
  '/data-products/web-search': {platform:'web_search',any:['web.search'],docs:'web-search'},
  ...Object.fromEntries(WECHAT_PRODUCTS.map(product => [`/data-products/${product.key}`, { platform: 'social', any: wechatServices(product).map(row => row.operation), docs: product.key } ])),
  '/data-products/search': { domain: 'search', docs: 'aggregate-search' },
  '/data-products/news': { domain: 'news', docs: 'news-discovery' },
  '/data-products/social-content': { platform: 'social', any: ['social.accounts.search', ...nativeServiceCapabilities.social], docs:'social-content' },
  '/data-products/xiaohongshu-hot-notes': { platform: 'xiaohongshu', any: ['social.posts.hot_search'], docs: 'xiaohongshu-hot-notes' },
  '/data-products/xiaohongshu-inspiration': { platform: 'xiaohongshu', any: ['social.inspiration.list'], docs: 'xiaohongshu-inspiration' },
  '/data-products/enterprise': { platform: 'enterprise', any: ['enterprise.query'], docs: 'enterprise' },
  '/data-products/ip-risk': { platform: 'ip_risk', any: ['ip.risk.query', 'ip.risk.query.v2'], docs: 'ip-risk' },
  '/source-catalog': { platform: 'source_catalog', docs: 'source-catalog' },
  '/data-products/telegram': { platform: 'telegram', docs: 'telegram' },
  '/data-products/ecommerce-treasure-box': { platform: 'ecommerce', any: ['ecommerce.products.search', ...nativeServiceCapabilities.ecommerce], docs: 'ecommerce-treasure-box' },
  '/data-products/xiaohongshu-note': { platform: 'xiaohongshu', any: ['social.posts.resolve', 'social.posts.search', 'social.users.posts', 'social.posts.analytics', 'social.comments.list'], docs: 'xiaohongshu-note' },
  '/data-products/virtual-supermarket': { platform: 'virtual_supermarket', docs: 'virtual-supermarket' },
  '/data-products/public-opinion': { platform: 'public_opinion', docs: 'public-opinion' },
  '/data-products/topic-insights': { platform: 'topic_reports', docs: 'topic-reports' },
}
export function productAllowed(path, scopes = []) {
  if (path === '/data-products/web-search') return scopes.some(s=>s.platforms?.includes('web_search') && s.capabilities?.includes('web.search') && s.capabilities.some(c=>c.startsWith('web.search.provider.')))

  if (path === '/data-products/social-content' && scopes.some(scope => scope.platforms?.includes('twitter') && ['social.content.search', 'social.content.crawl', 'social.profile.get'].some(capability => scope.capabilities?.includes(capability)))) return true
  const rule = PRODUCT_ACCESS[path]
  if (rule?.domain) return scopes.some(scope => scope.platforms?.some(platform =>
    savedRecordCategory(platform) || (rule.domain === 'search' && searchablePlatforms.has(platform))))
  return !!rule && scopes.some(scope => scope.platforms?.includes(rule.platform) && (!rule.any || rule.any.some(value => scope.capabilities?.includes(value))))
}

// Explicit UI preset only: callers still submit through the audited grant APIs.
export function withIpRiskProductScopes(form) {
  return { ...form,
    platforms: [...new Set([...form.platforms, 'ip_risk'])],
    capabilities: [...new Set([...form.capabilities, 'ip.risk.query'])],
  }
}

export function withEnterpriseProductScopes(form) {
  return { ...form,
    platforms: [...new Set([...form.platforms, 'enterprise'])],
    capabilities: [...new Set([...form.capabilities, 'enterprise.query'])],
  }
}
