// Product navigation and API docs share one mapping. It never grants access.
export const PRODUCT_WORKBENCHES = [
  { path: '/source-catalog', label: '数据源目录', docs: 'source-catalog', prefixes: ['/data/source-catalog'] },
  { path: '/data-products/search', label: '数据搜索', docs: 'aggregate-search', prefixes: ['/data/aggregate/'] },
  { path: '/data-products/telegram', label: 'Telegram 会话', docs: 'telegram', prefixes: ['/data/telegram/', '/data/canonical/items/'] },
  { path: '/data-products/ecommerce-treasure-box', label: '电商数据', docs: 'ecommerce-treasure-box', prefixes: ['/data/ecommerce/'] },
  { path: '/data-products/virtual-supermarket', label: '虚拟超市', docs: 'virtual-supermarket', prefixes: ['/data/virtual-supermarket/'] },
  { path: '/data-products/public-opinion', label: '全国舆情', docs: 'public-opinion', prefixes: ['/data/public-opinion/'] },
  { path: '/data-products/topic-insights', label: '专题洞察', docs: 'topic-reports', prefixes: ['/data/topic-reports', '/data/platforms'] },
  ...[
    ['ip-risk', 'IP 风险画像', 'ip-risk'], ['enterprise', '企业数据', 'enterprise'],
    ['xiaohongshu-note', '小红书笔记画卷', 'xiaohongshu-note'],
    ['xiaohongshu-hot-notes', '小红书热门笔记', 'xiaohongshu-hot-notes'],
    ['xiaohongshu-inspiration', '小红书创作灵感', 'xiaohongshu-inspiration'],
    ['news', '新闻发现', 'news-discovery'],
  ].map(([key, label, docs]) => ({ path: `/data-products/${key}`, label, docs, native: true })),
]
export const productForPath = path => PRODUCT_WORKBENCHES.find(product => product.path === path)
export const productForDocs = path => PRODUCT_WORKBENCHES.find(product => path?.split('#')[0] === `/docs/${product.docs}` || path?.startsWith(`/docs/${product.docs}/`))

export function productEndpoints(document, product) {
  const labels = { '/data/aggregate/sources': '当前 Key 的搜索范围', '/data/aggregate/preview': '预览本批范围与费用', '/data/aggregate/search': '聚合数据搜索 · 实时 / 已收录' }
  return Object.entries(document?.paths || {}).flatMap(([path, item]) => {
    if (!product.prefixes?.some(prefix => path.startsWith(prefix)) || /\/media$/.test(path)) return []
    return ['get', 'post'].filter(method => item[method]).map(method => ({ path: `/api/v1${path}`, method: method.toUpperCase(),
      id: `${method}:${path}`, ...item[method], summary: labels[path] || item[method].summary, parameters: [...(item.parameters || []), ...(item[method].parameters || [])] }))
  })
}

export function resolveProductSchema(document, schema) {
  if (!schema?.$ref) return schema || {}
  return schema.$ref.split('/').slice(1).reduce((value, key) => value?.[key], document) || {}
}

export function productConsoleRequest(endpoint, values, json) {
  if (!endpoint) throw new Error('请选择接口')
  let path = endpoint.path
  const query = new URLSearchParams()
  for (const parameter of endpoint.parameters || []) {
    if (!['path', 'query'].includes(parameter.in)) continue
    const value = String(values[`${parameter.in}:${parameter.name}`] ?? '').trim()
    if (!value && parameter.required) throw new Error(`请填写 ${parameter.name}`)
    if (parameter.in === 'path') path = path.replace(`{${parameter.name}}`, encodeURIComponent(value))
    else if (value) query.set(parameter.name, value)
  }
  if (/\{[^}]+\}/.test(path)) throw new Error('请填写路径参数')
  let body
  if (endpoint.method === 'POST' && endpoint.requestBody) {
    try { body = JSON.parse(json) } catch { throw new Error('请求体必须是有效 JSON') }
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error('请求体必须是 JSON 对象')
  }
  return { path: path + (query.size ? `?${query}` : ''), method: endpoint.method, ...(body ? { body } : {}) }
}
