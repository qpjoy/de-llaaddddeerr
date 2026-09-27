import { publicSourceCatalogPage } from './public-source-catalog.mjs'
import { implementedRoutes } from './source-connections.mjs'
import { PRODUCT_WORKBENCHES } from '../../shared/product-workbenches.mjs'
import { productCategory } from '../../shared/product-navigation.mjs'

const routes = implementedRoutes()
const PRIVATE_SUPPLIER = /tik[\s._-]*hub|just[\s._-]*one|rapidapi|night[\s._-]*all|ipsearch|启信|企信宝|qixin/iu
const safe = value => typeof value === 'string' && !PRIVATE_SUPPLIER.test(value) ? value : null
const safeList = values => (values || []).map(safe).filter(Boolean)
// A new allowlisted business projection, independent of the v1 governance DTO.
// Do not spread rows: notes/owners/connector hints and arbitrary metadata are
// internal. Public coverage remains the reviewed catalogue status, not health.
export function serviceCatalogPage(entries, query, secret) {
  const page = publicSourceCatalogPage(entries.map(entry => ({
    id: entry.id, sourceKey: entry.sourceKey, legacySequence: entry.legacySequence,
    canonicalName: safe(entry.canonicalName) || '数据服务', aliases: safeList(entry.aliases),
    sourceKind: entry.sourceKind, majorCategory: safe(entry.majorCategory) || '其他',
    scenarios: safeList(entry.scenarios), regions: safeList(entry.regions), tags: safeList(entry.tags),
    coverageStatus: entry.coverageStatus, archivedAt: entry.archivedAt,
  })), query, secret)
  return { contractVersion: 'source-catalog.services.v1', filters: Object.fromEntries(Object.entries(page.filters).filter(([key]) => ['query','majorCategory','scenario','region','coverageStatus','tag'].includes(key))), pageInfo: page.pageInfo,
    items: page.items.map(entry => {
      const related = routes.filter(route => route.catalogKeys.includes(entry.sourceKey))
      const products = PRODUCT_WORKBENCHES.filter(product => related.some(route => route.product === product.label)).map(product => ({
        label: product.label, path: product.path, docsPath: `/docs/${product.docs}`, category: productCategory(product.path)?.label || '数据服务',
      }))
      return { id: entry.id, sourceKey: safe(entry.sourceKey), canonicalName: entry.canonicalName,
        aliases: entry.aliases, majorCategory: entry.majorCategory, scenarios: entry.scenarios,
        regions: entry.regions, tags: entry.tags, coverageStatus: entry.coverageStatus,
        products, queryModes: [...new Set(related.map(route => route.mode === 'stored' ? 'stored' : 'live'))],
        access: 'checked_per_request', runtimeStatus: 'not_checked',
      }
    }),
    notice: '目录展示已登记的业务覆盖；可调用范围和服务就绪状态以当前 Key 的接口检查为准。已收录数据的新鲜度取决于最新成功入库时间。' }
}
