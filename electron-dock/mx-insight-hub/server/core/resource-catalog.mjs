import { XHS_DISCOVERY_PRODUCTS } from '../../shared/xiaohongshu-discovery.mjs'
import { PRODUCT_WORKBENCHES } from '../../shared/product-workbenches.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../contracts/native-forwarding.mjs'
import { dataAdmissionLane } from './data-admission.mjs'
const normalize = path => path.replace(/\/{2,}/g, '/').replace(/\/$/, '')
const full = path => path.startsWith('/api/') ? path : `/api/v1${path}`
const nativeProducts = new Map(NATIVE_FORWARDING_ENDPOINTS.map(row => [row.hubPath,
  row.authorizationPlatform === 'ecommerce' ? '/data-products/ecommerce-treasure-box' : '/data-products/social-content']))
const special = [['/data/ip/', 'ip-risk'], ['/data/enterprise/', 'enterprise'], ['/data/xiaohongshu/', 'xiaohongshu-note'],
  ['/data/news/', 'news'], ['/tools/tokenize', 'tokenizer']]
function productFor(path) {
  const discovery = XHS_DISCOVERY_PRODUCTS.find(row => row.path === path)
  if (discovery) return `/data-products/${discovery.key}`
  if (nativeProducts.has(path)) return nativeProducts.get(path)
  if (/^\/api\/v1\/(?:night-all\/)?search\//.test(path)) return '/data-products/strategy-search'
  if (path === '/api/v2/data/search') return '/data-products/strategy-search'
  const local = path.replace(/^\/api\/v[12]/, '')
  for (const [prefix, product] of special) if (local.startsWith(prefix)) return `/data-products/${product}`
  const matches = PRODUCT_WORKBENCHES.flatMap(product => (product.prefixes || []).filter(prefix =>
    local === prefix || local.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)).map(prefix => ({ product: product.path, length: prefix.length })))
  return matches.sort((a, b) => b.length - a.length)[0]?.product || '/data-products/other'
}
// One canonical template per public route. Variable IDs cannot create unlimited
// buckets or bypass an API rule; URL aliases share their documented template.
export function resourceCatalog(document) {
  const exact = new Map(), dynamic = []
  const apis = [], seen = new Set()
  const paths = Object.entries(document.paths).flatMap(([path, methods]) => path.includes('{operation}')
    ? ['raw', 'crawl', 'user-info'].map(operation => [path.replace('{operation}', operation), methods]) : [[path, methods]])
  for (const [path, methods] of paths) {
    const endpoint = normalize(full(path))
    for (const method of ['GET', 'POST']) {
      if (!methods[method.toLowerCase()] || !dataAdmissionLane(method, endpoint)) continue
      const api = `${method} ${endpoint}`, product = productFor(endpoint)
      if (seen.has(api)) continue
      seen.add(api)
      const target = { api, product }
      apis.push({ id: api, product, label: `${method} ${endpoint}` })
      if (!endpoint.includes('{')) exact.set(api, target)
      else dynamic.push({ method, match: new RegExp('^' + endpoint.split('/').map(part => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$'), target })
    }
  }
  const catalog = { products: [...PRODUCT_WORKBENCHES.map(row => ({ id: row.path, label: row.label })),
    { id: '/data-products/tokenizer', label: '文本分词' }, { id: '/data-products/other', label: '其他数据 API' }], apis }
  return { catalog, classify(method, pathname) {
    pathname = normalize(pathname)
    if (!pathname.startsWith('/api/') || !dataAdmissionLane(method, pathname)) return null
    return exact.get(`${method} ${pathname}`) || dynamic.find(row => row.method === method && row.match.test(pathname))?.target
      || { api: `${method} /unlisted`, product: productFor(pathname) }
  } }
}
