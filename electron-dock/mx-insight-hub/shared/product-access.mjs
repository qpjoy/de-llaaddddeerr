// Console visibility follows current consumer grants, independent of key issue/binding dates.
export const PRODUCT_ACCESS = {
  '/data-products/ip-risk': { platform: 'ip_risk', any: ['ip.risk.query'], docs: 'ip-risk' },
  '/source-catalog': { platform: 'source_catalog', docs: 'source-catalog' },
  '/data-products/telegram': { platform: 'telegram', docs: 'telegram' },
  '/data-products/ecommerce-treasure-box': { platform: 'ecommerce', any: ['ecommerce.products.search'], docs: 'ecommerce-treasure-box' },
  '/data-products/xiaohongshu-note': { platform: 'xiaohongshu', any: ['social.posts.resolve', 'social.posts.search', 'social.users.posts'], docs: 'xiaohongshu-note' },
  '/data-products/virtual-supermarket': { platform: 'virtual_supermarket', docs: 'virtual-supermarket' },
  '/data-products/public-opinion': { platform: 'public_opinion', docs: 'public-opinion' },
  '/data-products/topic-insights': { platform: 'topic_reports', docs: 'topic-reports' },
}
export function productAllowed(path, scopes = []) {
  const rule = PRODUCT_ACCESS[path]
  return !!rule && scopes.some(scope => scope.platforms?.includes(rule.platform) && (!rule.any || rule.any.some(value => scope.capabilities?.includes(value))))
}

// Explicit UI preset only: callers still submit through the audited grant APIs.
export function withIpRiskProductScopes(form) {
  return { ...form,
    platforms: [...new Set([...form.platforms, 'ip_risk'])],
    capabilities: [...new Set([...form.capabilities, 'ip.risk.query'])],
  }
}
