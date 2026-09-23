// Public business metadata. Supplier coordinates never belong in this module.
export const XIAOHONGSHU_CAPABILITIES = Object.freeze([
  { key: 'social.posts.search', label: '搜索笔记', path: '/api/v1/data/search', keywordSearch: true },
  { key: 'social.posts.resolve', label: '正文与标签', path: '/api/v1/data/post' },
  { key: 'social.users.resolve', label: '用户资料', path: '/api/v1/search/user-info' },
  { key: 'social.users.posts', label: '用户笔记', path: '/api/v1/search/crawl' },
  { key: 'social.posts.analytics', label: '详情与阅读量', path: '/api/v1/data/xiaohongshu/notes/detail' },
  { key: 'social.comments.list', label: '笔记评论', path: '/api/v1/data/xiaohongshu/notes/comments' },
])

export const PRODUCT_BUNDLES = Object.freeze([
  { key: 'xiaohongshu', version: 2, name: '小红书笔记画卷', platforms: ['xiaohongshu'],
    capabilities: XIAOHONGSHU_CAPABILITIES.map(row => row.key),
    optionalCapabilities: ['compat.xiaohongshu.app_v2'], featureKey: 'xiaohongshu',
    href: '/data-products/xiaohongshu-note', catalogKeys: ['source-catalog-0004'] },
  { key: 'ip-risk', version: 1, name: 'IP 风险画像', platforms: ['ip_risk'],
    capabilities: ['ip.risk.query'], optionalCapabilities: [], featureKey: 'ip-risk', href: '/data-products/ip-risk', catalogKeys: [] },
  { key: 'qixin', version: 1, name: '企业数据', platforms: ['enterprise'],
    capabilities: ['enterprise.query'], optionalCapabilities: [], featureKey: 'qixin', href: '/data-products/enterprise', catalogKeys: ['source-catalog-0175'] },
])

// UI selection only. The existing server grant checks remain authoritative.
export function withProductScopes(form, key, allowed) {
  const product = PRODUCT_BUNDLES.find(row => row.key === key)
  if (!product) throw new Error('Unknown product')
  return { ...form,
    platforms: [...new Set([...form.platforms, ...product.platforms.filter(scope => !allowed || allowed.platforms.includes(scope))])],
    capabilities: [...new Set([...form.capabilities, ...[...product.capabilities, ...product.optionalCapabilities]
      .filter(scope => !allowed || allowed.capabilities.includes(scope))])],
  }
}
