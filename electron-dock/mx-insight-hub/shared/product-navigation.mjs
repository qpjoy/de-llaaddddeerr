// Business navigation, shared with the public catalogue projection. No supplier
// identifiers, execution topology or authorization decisions belong here.
export const PRODUCT_CATEGORIES = [
  { key: 'discovery', label: '发现与检索', paths: ['/source-catalog', '/data-products/search'] },
  { key: 'services', label: '数据服务', paths: ['/data-products/enterprise', '/data-products/ip-risk', '/data-products/social-content', '/data-products/ecommerce-treasure-box', '/data-products/wechat-mp', '/data-products/wechat-channels', '/data-products/wechat-search', '/data-products/xiaohongshu-note', '/data-products/xiaohongshu-hot-notes', '/data-products/xiaohongshu-inspiration'] },
  { key: 'applications', label: '场景应用', paths: ['/data-products/news', '/data-products/telegram', '/data-products/public-opinion', '/data-products/virtual-supermarket', '/data-products/topic-insights'] },
]
export const productCategory = path => PRODUCT_CATEGORIES.find(category => category.paths.includes(path))
export const productNavigationOrder = path => {
  const index = PRODUCT_CATEGORIES.findIndex(category => category.paths.includes(path))
  return index < 0 ? 1000 : index * 100 + PRODUCT_CATEGORIES[index].paths.indexOf(path)
}
