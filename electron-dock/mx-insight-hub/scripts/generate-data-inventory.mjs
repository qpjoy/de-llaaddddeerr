// Offline documentation export. Imports static contracts only; no runtime, DB or HTTP calls.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { NATIVE_FORWARDING_ENDPOINTS } from '../server/contracts/native-forwarding.mjs'
import { QIXIN_CATALOG, enterprisePublicPrice } from '../server/contracts/enterprise.mjs'
import { JUSTONE_RELEASED_RESOURCES } from '../server/contracts/justone-resources.mjs'
import { JUSTONE_ENDPOINTS, productSearchProviders } from '../server/contracts/justone.mjs'
import { SOURCE_CATALOG_SEED } from '../server/data/source-catalog-seed.mjs'
import { PROVIDER_CATALOG_ADDITIONS } from '../server/data/provider-catalog-additions.mjs'
import { providerCatalogKeys } from '../server/data/provider-catalog.mjs'
import { strategySearchCatalog } from '../server/data/strategy-search-catalog.mjs'
import { PUBLIC_OPENAPI_DOCUMENT } from '../server/public-docs.mjs'
import { SEARCH_UPSTREAMS } from '../server/web-search/providers.mjs'
import { NIGHT_ALL_A_OPERATIONS } from '../server/external-platforms/night-all-a.mjs'
import { CRAWLER_SOURCES } from '../server/ingest/crawler/source-contract.mjs'
import { TELEGRAM_MONITOR_INPUTS } from '../server/ingest/telegram/monitor-pipeline.mjs'
import { TELEGRAM_SQLITE_INPUTS } from '../server/ingest/telegram/sqlite-pipeline.mjs'
import { MOBILE_COMMERCE_SOURCE_KEY, MOBILE_COMMERCE_SOURCE_LOCATOR, MOBILE_COMMERCE_DATASET_ID } from '../server/ingest/mobile-commerce/source-contract.mjs'
import { PROVINCE_OPINION_SOURCE_KEY, PROVINCE_OPINION_SOURCE_LOCATOR } from '../server/ingest/province/source-contract.mjs'
import { PUBLIC_OPINION_DATASET_ID } from '../server/data/public-opinion.mjs'

const root = new URL('../', import.meta.url)
const output = new URL('docs/data-inventory/', root)
const check = process.argv.includes('--check')
const countBy = (rows, key) => Object.fromEntries([...new Set(rows.map(row => row[key]))].sort()
  .map(value => [value, rows.filter(row => row[key] === value).length]))
const table = (headers, rows) => {
  const cell = value => String(value ?? '—').replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;')
  return [headers, headers.map(() => '---'), ...rows].map(row => `| ${row.map(cell).join(' | ')} |`).join('\n')
}
const fullPath = path => path.startsWith('/api/') ? path : `/api/v1${path}`
const native = NATIVE_FORWARDING_ENDPOINTS.map(row => ({ key: row.key, platform: row.platform,
  name: row.summary || row.id, provider: row.provider, hubMethod: 'POST', hubPath: row.hubPath,
  upstreamMethod: row.method, upstreamPath: row.path, authorizationPlatform: row.authorizationPlatform,
  operation: row.operation, catalogKeys: providerCatalogKeys(row.platform) }))
const enterprise = QIXIN_CATALOG.apis.map(row => ({ apiId: row.api_id, name: row.api_name,
  category: row.category_name, provider: 'qixin', hubMethod: 'POST', hubPath: `/api/v1/data/enterprise/${row.api_id}/query`,
  upstreamMethods: row.methods, upstreamUrl: row.interface,
  admission: enterprisePublicPrice(row.api_id) === null ? 'negotiated_price_blocked' : 'requires_runtime_admission' }))
const ecommerceResources = JUSTONE_RELEASED_RESOURCES.flatMap(row => row.versions.map(version => ({
  resourceKey: row.resourceKey, name: row.label, marketplaces: row.marketplaces, version,
  defaultVersion: row.defaultVersion, hubMethod: 'POST', hubPath: row.hubPath, provider: 'justone',
  upstreamMethod: 'GET', upstreamPath: row.variantFor(version).upstreamPath, operation: row.operationKey,
})))
const productSearch = Object.entries(JUSTONE_ENDPOINTS).flatMap(([marketplace, row]) =>
  productSearchProviders(marketplace).map(provider => ({ marketplace, provider,
    hubPath: '/api/v1/data/ecommerce/products/search', upstreamMethod: 'GET', upstreamPath: row.path })))
const nativePaths = new Set(native.map(row => row.hubPath))
const enterprisePaths = new Set(enterprise.map(row => row.hubPath))
const routeMap = new Map()
for (const [path, definition] of Object.entries(PUBLIC_OPENAPI_DOCUMENT.paths)) {
  for (const [method, operation] of Object.entries(definition)) {
    if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue
    const paths = path.endsWith('/search/{operation}')
      ? ['raw', 'crawl', 'user-info'].map(op => path.replace('{operation}', op)) : [path]
    for (const item of paths) {
      const hubPath = fullPath(item), hubMethod = method.toUpperCase()
      const legacy = /^\/api\/v1\/(night-all\/)?search\/(raw|crawl|user-info)$/.test(hubPath)
      routeMap.set(`${hubMethod} ${hubPath}`, { hubMethod, hubPath,
        name: legacy ? '旧搜索兼容入口；平台/形状分流及微信退役边界见总览' : operation.summary || operation.operationId,
        family: nativePaths.has(hubPath) ? 'native' : enterprisePaths.has(hubPath) ? 'enterprise' : 'business',
        evidence: 'server/public-docs.mjs (PUBLIC_OPENAPI_DOCUMENT)' })
    }
  }
}
// app.mjs accepts these explicit aliases; the current OpenAPI only describes the base paths.
for (const suffix of ['v2/batch', 'service/batch']) {
  const hubPath = `/api/v1/data/ip/risk/${suffix}`
  routeMap.set(`POST ${hubPath}`, { hubMethod: 'POST', hubPath, name: 'IP 风险批量别名',
    family: 'business', evidence: 'server/app.mjs' })
}
const publicRoutes = [...routeMap.values()].sort((a, b) => a.hubPath.localeCompare(b.hubPath) || a.hubMethod.localeCompare(b.hubMethod))
for (const row of [...native, ...enterprise]) {
  if (!routeMap.has(`${row.hubMethod} ${row.hubPath}`)) throw new Error(`Missing public contract: ${row.hubPath}`)
}
if (new Set(native.map(row => row.key)).size !== native.length) throw new Error('Duplicate native key')
const sourceDirectory = [...SOURCE_CATALOG_SEED, ...PROVIDER_CATALOG_ADDITIONS].map(row => ({
  sourceKey: row.sourceKey, name: row.canonicalName, category: row.majorCategory, sourceKind: row.sourceKind,
  seedCoverageStatus: row.coverageStatus, seedDeliveryStatus: row.deliveryStatus,
  nativeContractCount: native.filter(item => item.catalogKeys.includes(row.sourceKey)).length,
  evidence: row.sourceKey.startsWith('source-catalog-') ? 'server/data/source-catalog-seed.mjs' : 'server/data/provider-catalog-additions.mjs',
}))
const webSearch = SEARCH_UPSTREAMS.map(({ key, label, resources, capability, url }) => ({ key, name: label, resources, capability, upstreamUrl: url }))
const nightAllA = Object.entries(NIGHT_ALL_A_OPERATIONS).map(([operation, [upstreamMethod, upstreamPath]]) => ({
  operation, hubMethod: 'POST', hubPath: `/internal/v1/admin/external-platforms/night-all-a/dispatch/${operation}`,
  upstreamMethod, upstreamPath,
}))
const fixedInputs = [
  ...TELEGRAM_MONITOR_INPUTS.map(row => ({ sourceKey: row.sourceKey, sourceKind: 'database',
    locator: `${row.schema}.${row.table}`, datasetId: `telegram.monitor.${row.role}.v1`, platform: 'telegram' })),
  ...TELEGRAM_SQLITE_INPUTS.map(row => ({ sourceKey: row.sourceKey, sourceKind: 'sqlite_api',
    locator: `GET ${row.endpoint}`, datasetId: row.datasetId, platform: 'telegram' })),
  { sourceKey: MOBILE_COMMERCE_SOURCE_KEY, sourceKind: 'database',
    locator: `${MOBILE_COMMERCE_SOURCE_LOCATOR.schema}.${MOBILE_COMMERCE_SOURCE_LOCATOR.table}`,
    datasetId: MOBILE_COMMERCE_DATASET_ID, platform: 'mobile_commerce' },
  { sourceKey: PROVINCE_OPINION_SOURCE_KEY, sourceKind: 'database',
    locator: `${PROVINCE_OPINION_SOURCE_LOCATOR.schema}.${PROVINCE_OPINION_SOURCE_LOCATOR.table}`,
    datasetId: PUBLIC_OPINION_DATASET_ID, platform: 'public_opinion' },
  ...CRAWLER_SOURCES.map(row => ({ sourceKey: row.sourceKey, sourceKind: 'database',
    locator: `${row.locator.schema}.${row.locator.table}`, datasetId: row.datasetId, platform: row.platform })),
]
const summary = {
  sourceDirectorySeed: SOURCE_CATALOG_SEED.length, sourceDirectoryAdditions: PROVIDER_CATALOG_ADDITIONS.length,
  sourceDirectoryTotal: sourceDirectory.length, nativeContracts: native.length,
  nativeByProvider: countBy(native, 'provider'), nativeByPlatformCode: countBy(native, 'platform'),
  nativeDistinctPlatformCodes: new Set(native.map(row => row.platform)).size,
  nativeUniqueUpstreamMethodPaths: new Set(native.map(row => `${row.provider}:${row.upstreamMethod}:${row.upstreamPath}`)).size,
  enterpriseContracts: enterprise.length, enterpriseByAdmission: countBy(enterprise, 'admission'),
  enterpriseByCategory: countBy(enterprise, 'category'), ecommerceSearchMarketplaces: Object.keys(JUSTONE_ENDPOINTS).length,
  ecommerceSearchSupplierMappings: productSearch.length, ecommerceResourcePaths: JUSTONE_RELEASED_RESOURCES.length,
  ecommerceResourceVersions: ecommerceResources.length, webSearchProviders: webSearch.length,
  crawlerSeedLeaves: CRAWLER_SOURCES.length, fixedIngestionInputs: fixedInputs.length, nightAllAOperations: nightAllA.length,
  publicMethodPathEntries: publicRoutes.length, publicEntriesByFamily: countBy(publicRoutes, 'family'),
}
const evidenceFiles = [
  'server/app.mjs', 'server/public-docs.mjs', 'server/contracts/native-forwarding.mjs',
  'server/data/night-all-provider-inventory.json', 'server/data/provider-official-contracts.json', 'server/data/wechat-contracts.json',
  'server/contracts/enterprise.mjs', 'server/external-platforms/qixin-catalog.json', 'shared/qixin-official-prices.mjs',
  'server/contracts/justone.mjs', 'server/contracts/justone-resources.mjs', 'server/data/strategy-search-catalog.mjs',
  'server/data/source-catalog-seed.mjs', 'server/data/provider-catalog-additions.mjs', 'server/data/provider-catalog.mjs',
  'server/web-search/providers.mjs', 'shared/web-search.mjs', 'server/external-platforms/night-all-a.mjs',
  'server/ingest/crawler/source-contract.mjs',
  'server/ingest/telegram/monitor-pipeline.mjs', 'server/ingest/telegram/sqlite-pipeline.mjs',
  'server/ingest/mobile-commerce/source-contract.mjs', 'server/ingest/province/source-contract.mjs',
  'server/data/public-opinion.mjs',
]
const inventory = { schemaVersion: 'mx-insight-hub.data-inventory.v1',
  scope: 'repository_static_contracts', runtimeStatus: 'not_checked',
  evidence: evidenceFiles.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex') })),
  summary, native, enterprise, ecommerceResources, productSearch, webSearch, nightAllA,
  fixedInputs, crawlerSeedSources: CRAWLER_SOURCES, strategySearch: strategySearchCatalog(), sourceDirectory, publicRoutes,
}
const business = publicRoutes.filter(row => row.family === 'business')
const preamble = '由 `scripts/generate-data-inventory.mjs` 离线生成；请勿手改。仅含仓库合同，不读取生产数据库、不请求上游。运行状态统一为 `not_checked`。供应商信息用于内部协作，不是租户公开说明。\n\n[总览与统计口径](README.md) · [机器可读明细](inventory.json)\n'
const registry = `# 数据接口逐项注册表\n\n${preamble}
## 业务与配套公开入口（${business.length} 个方法/路径条目）

旧 operation 模板已展开、同方法同路径已去重；IP 两条 batch 别名由 HTTP 分发代码补充。别名、GET/POST 变体分别计数，不能当作独立业务能力。Native 和企业接口在后文单列。

${table(['方法', 'Hub 路径', '用途'], business.map(row => [row.hubMethod, row.hubPath, row.name]))}

## Native 平台覆盖（原始平台代码，不合并别名）

${table(['供应商', '平台代码', '注册合同数'], ['tikhub', 'justone'].flatMap(provider => Object.entries(countBy(native.filter(row => row.provider === provider), 'platform')).map(([platform, count]) => [provider, platform, count])))}

## Native 逐项明细（${native.length} 条）

${table(['平台', '名称', 'Hub POST 路径', '供应商', '上游方法', '上游路径', '授权域', '操作'], native.map(row => [row.platform, row.name, row.hubPath, row.provider, row.upstreamMethod, row.upstreamPath, row.authorizationPlatform, row.operation]))}

## 企业接口（${enterprise.length} 个 apiId）

${table(['apiId', '分类', '名称', 'Hub POST 路径', '上游方法', '启信宝上游地址', '准入'], enterprise.map(row => [row.apiId, row.category, row.name, row.hubPath, row.upstreamMethods.join('/'), row.upstreamUrl, row.admission === 'negotiated_price_blocked' ? '议价，代码禁止派发' : '有公开价格；仍需运行准入']))}

## 统一电商商品搜索供应商映射

${table(['平台', '供应商', 'Hub POST 路径', '上游 GET 路径'], productSearch.map(row => [row.marketplace, row.provider, row.hubPath, row.upstreamPath]))}

## 电商专用资源版本

${table(['名称', '平台', 'Hub POST 路径', '版本', '默认版本', 'JustOne GET 路径'], ecommerceResources.map(row => [row.name, row.marketplaces.join('/'), row.hubPath, row.version, row.defaultVersion, row.upstreamPath]))}

## Web Search 渠道

${table(['渠道', '名称', '资源类型', '上游地址', '授权能力'], webSearch.map(row => [row.key, row.name, row.resources.join('/'), row.upstreamUrl, row.capability]))}

## Night-All-A 管理派发允许列表

全部为 Admin 专用 Hub POST；只有 createTask/runPlan 是上游写操作。目录可见不授予执行权限。

${table(['operation', '上游方法', '上游路径'], nightAllA.map(row => [row.operation, row.upstreamMethod, row.upstreamPath]))}
`
const directory = `# 数据源治理目录\n\n${preamble}
## 统计边界

共 ${sourceDirectory.length} 个源码初始化条目（原始目录 ${SOURCE_CATALOG_SEED.length} + 供应商补充 ${PROVIDER_CATALOG_ADDITIONS.length}）。这是治理范围，**不是全部已接入来源**，也不包含部署后由管理员或动态发现新增的目录。coverage/delivery 是初始化声明，不能当作当前覆盖率或健康状态。

“映射 native 合同”按代码的 providerCatalogKeys 稳定映射统计；0 仅表示此映射无命中，不证明没有文件/数据库/其他业务接口数据。一个合同可能关联多个目录条目，各行数量不可累加为接口总数。未显式映射的别名不根据名称猜测归属。

${table(['类别', '初始化目录条目数'], Object.entries(countBy(sourceDirectory, 'category')))}

## 全部目录条目

${table(['sourceKey', '名称', '类别', '种类', '初始覆盖声明', '初始交付声明', '映射 native 合同'], sourceDirectory.map(row => [row.sourceKey, row.name, row.category, row.sourceKind, row.seedCoverageStatus, row.seedDeliveryStatus, row.nativeContractCount]))}

## 全部固定初始化清洗输入（${fixedInputs.length} 项）

这是源码注册范围，不代表当前都已配置、批准映射、启用或入库；动态发现和自定义输入须另读运行目录。

${table(['sourceKey', '类型', '源表/读取路径', 'Hub dataset', 'Hub platform'], fixedInputs.map(row => [row.sourceKey, row.sourceKind, row.locator, row.datasetId, row.platform]))}

## Night-All-A saved_records 固定初始化来源

以下 ${CRAWLER_SOURCES.length} 个叶表各自有检查点、映射和失败状态。新 source_type 可通过发现机制增补；实际数量须读取运行数据库。内部键沿用 night-all，清洗任务归属 Night-All-A。

${table(['sourceKey', '源表', 'Hub dataset', 'Hub platform'], CRAWLER_SOURCES.map(row => [row.sourceKey, `${row.locator.schema}.${row.locator.table}`, row.datasetId, row.platform]))}
`
if (!check) mkdirSync(output, { recursive: true })
for (const [name, content] of [['inventory.json', JSON.stringify(inventory, null, 2) + '\n'], ['interfaces.md', registry], ['source-directory.md', directory]]) {
  const destination = new URL(name, output)
  if (check) {
    if (readFileSync(destination, 'utf8') !== content) throw new Error(`Inventory is stale: ${name}`)
  } else writeFileSync(destination, content)
}
console.log(JSON.stringify({ mode: check ? 'check' : 'write', summary }, null, 2))
