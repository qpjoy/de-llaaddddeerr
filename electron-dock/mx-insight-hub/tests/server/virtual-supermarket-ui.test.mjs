import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function sources() {
  return Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages-virtual-supermarket.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages-catalog.jsx', import.meta.url), 'utf8'),
  ])
}

test('virtual supermarket is an Admin-token-only data product route', async () => {
  const [appSource] = await sources()
  const route = appSource.match(/\{ path: '\/data-products\/virtual-supermarket',[^\n]+\}/u)?.[0] || ''

  assert.match(appSource, /import \{ VirtualSupermarketPage \} from '\.\/pages-virtual-supermarket\.jsx'/u)
  assert.match(route, /label: '虚拟超市'/u)
  assert.match(route, /navParent: DATA_PRODUCTS_NAV_KEY/u)
  assert.match(route, /component: VirtualSupermarketPage/u)
  assert.match(route, /platformAdmin: true/u)
  assert.match(route, /adminTokenOnly: true/u)
})

test('virtual supermarket renderer exposes the three approved modes and real raster assets', async () => {
  const [, , pageSource, styleSource] = await sources()

  for (const label of ['逛超市', '超市全景', '目录模式']) assert.match(pageSource, new RegExp(label, 'u'))
  for (const asset of [
    'assets/virtual-supermarket/supermarket-floor.webp',
    'assets/virtual-supermarket/supermarket-aisle.webp',
  ]) assert.match(pageSource, new RegExp(asset.replaceAll('/', '\\/'), 'u'))

  assert.match(pageSource, /<nav className="qp-panel mih-market-departments"/u)
  assert.match(pageSource, /<figure className="qp-panel mih-market-floor"/u)
  assert.match(pageSource, /<table className="mih-table mih-market-table">/u)
  assert.match(pageSource, /源端未提供已验证商品图片/u)
  assert.match(pageSource, /mih-market-product-image__placeholder/u)
  assert.match(pageSource, /暂无图片/u)
  assert.doesNotMatch(pageSource, /unverified-product\.webp/u)
  assert.doesNotMatch(pageSource, /<select\b|<canvas\b|<svg\b|three|WebGL/iu)
  assert.match(styleSource, /\.mih-market-panorama/u)
  assert.match(styleSource, /var\(--qp-bg-3\)/u)
  assert.match(styleSource, /@media \(max-width: 720px\)/u)
  assert.match(styleSource, /prefers-reduced-motion/u)
})

test('virtual supermarket UI uses only the Admin facade for reads and mutations', async () => {
  const [, apiSource, pageSource] = await sources()

  assert.match(apiSource, /dataProductVirtualSupermarketMetadata:[\s\S]*?\$\{ADMIN_ROOT\}\/data-products\/virtual-supermarket\/metadata/u)
  assert.match(apiSource, /dataProductVirtualSupermarketProducts:[\s\S]*?\$\{ADMIN_ROOT\}\/data-products\/virtual-supermarket\/products/u)
  assert.match(apiSource, /updateDataProductVirtualSupermarketProduct:[\s\S]*?method: 'PATCH'/u)
  assert.match(apiSource, /publishDataProductVirtualSupermarketProduct:[\s\S]*?\/publish`[\s\S]*?method: 'POST'/u)
  assert.match(apiSource, /unpublishDataProductVirtualSupermarketProduct:[\s\S]*?\/unpublish`[\s\S]*?method: 'POST'/u)
  assert.doesNotMatch(pageSource, /\/api\/v1\/data\/virtual-supermarket/u)
  assert.match(pageSource, /<ConfirmDialog/u)
  assert.match(pageSource, /<DropdownField label="商品分类与货架"/u)
  assert.match(pageSource, /expectedRevision: product\.revision/u)
  assert.match(pageSource, /shelfPosition:/u)
  assert.match(pageSource, /管理台手动上架/u)
  assert.match(pageSource, /管理台手动下架/u)
})

test('spatial modes disclose partial loading and append cursor pages without duplicates', async () => {
  const [, , pageSource] = await sources()

  assert.equal([...pageSource.matchAll(/<SpatialLoadStatus \{\.\.\.spatialPagination\} \/>/gu)].length, 2)
  assert.match(pageSource, /当前已加载 \$\{formatNumber\(loadedCount\)\} 件 · 仍有更多/u)
  assert.match(pageSource, /分页状态确认中/u)
  assert.match(pageSource, /已到当前筛选结果末尾/u)
  assert.match(pageSource, /继续加载/u)
  assert.match(pageSource, /const loadMoreSpatial = async \(\) =>/u)
  assert.match(pageSource, /const unique = new Map\(current\.map\(\(item\) => \[item\.id, item\]\)\)/u)
  assert.match(pageSource, /spatialGenerationRef\.current \+= 1/u)
  assert.match(pageSource, /setSpatialProducts\(\[\]\)/u)
  assert.match(pageSource, /'storefront_revision_changed'/u)
  assert.match(pageSource, /'virtual_supermarket_inventory_changed'/u)
  assert.match(pageSource, /数据已变化，已从第一页刷新/u)
  assert.match(pageSource, /setCursorStack\(\[null\]\)/u)
  assert.match(pageSource, /setInventoryRecovering\(true\)/u)
  assert.match(pageSource, /const cursor = viewKind === 'catalog' \? cursorStack\[cursorIndex\] : null/u)
  assert.match(pageSource, /pageInfo\?\.nextCursor \? '还有下一页' : '已到末页'/u)
  assert.match(pageSource, /下一页/u)
})

test('selected evidence is request-bound and never falls back to a stale product after failure', async () => {
  const [, , pageSource] = await sources()

  assert.match(pageSource, /\{ requestedId: selectedId, response: await adminApi\.dataProductVirtualSupermarketProduct/u)
  assert.match(pageSource, /error\.virtualSupermarketRequestedId = selectedId/u)
  assert.match(pageSource, /const detailMatchesSelection = detailState\.data\?\.requestedId === selectedId/u)
  assert.match(pageSource, /detailState\.error\?\.virtualSupermarketRequestedId === selectedId/u)
  assert.match(pageSource, /<ErrorState error=\{error\} onRetry=\{onRetry\} \/>/u)
  assert.match(pageSource, /<LoadingState label="正在加载商品证据" \/>/u)
  assert.doesNotMatch(pageSource, /normalizeProduct\(detailState\.data\?\.item \?\? detailState\.data\) \|\| fallbackSelected/u)
})

test('category manager operates the real Admin category contract', async () => {
  const [, apiSource, pageSource, styleSource] = await sources()

  assert.match(apiSource, /createDataProductVirtualSupermarketCategory:[\s\S]*?\/categories`[\s\S]*?method: 'POST'/u)
  assert.match(apiSource, /updateDataProductVirtualSupermarketCategory:[\s\S]*?\/categories\/\$\{encodeURIComponent\(id\)\}`[\s\S]*?method: 'PATCH'/u)
  for (const label of ['管理分类', '管理商品分类', '新建商品分类', '编辑商品分类']) {
    assert.match(pageSource, new RegExp(label, 'u'))
  }
  for (const field of ['department', 'aisle', 'shelf']) {
    assert.match(pageSource, new RegExp(`CategoryPlacementFields label="[^"]+" prefix="${field}"`, 'u'))
  }
  assert.match(pageSource, /expectedRevision: category\.revision/u)
  assert.match(pageSource, /setCategoryId: \(value\) => setQuery\(\{ categoryId:[\s\S]*?department: null, aisle: null, shelf: null/u)
  assert.match(pageSource, /resetInventoryFromFirstPage\(\)/u)
  assert.match(styleSource, /\.mih-market-category-placements[\s\S]*?grid-template-columns: repeat\(3/u)
  assert.doesNotMatch(pageSource, /删除分类|归档分类/u)
})

test('product editing preserves source provenance and sends only dirty overrides', async () => {
  const [, , pageSource] = await sources()

  assert.match(pageSource, /listingOverrides: \{/u)
  assert.match(pageSource, /sourceFields: \{/u)
  assert.match(pageSource, /fieldState\.displayTitle\?\.override \?\? listing\.displayTitle/u)
  assert.match(pageSource, /\.\.\.\(titleDirty \? \{ title: titleOverride \|\| null \} : \{\}\)/u)
  assert.match(pageSource, /\.\.\.\(priceDirty \? \{ price: priceAmount \? \{ amount: priceAmount, currency: form\.currency \} : null \} : \{\}\)/u)
  assert.match(pageSource, /\.\.\.\(categoryDirty \? \{ categoryId: form\.categoryId \|\| null \} : \{\}\)/u)
  assert.match(pageSource, /恢复源值/u)
  assert.match(pageSource, /清除人工覆盖/u)
  assert.match(pageSource, /currency: product\.listingOverrides\.price\?\.currency \|\| ''/u)
  assert.match(pageSource, /币种（ISO 4217）/u)
  assert.match(pageSource, /pattern="\[A-Z\]\{3\}"/u)
  assert.match(pageSource, /function readablePriceValue/u)
  assert.match(pageSource, /parsed\.integer/u)
  assert.match(pageSource, /minorUnits === BigInt\(origin\)/u)
  assert.match(pageSource, /function readableSpecification/u)
  assert.match(pageSource, /JSON\.parse\(trimmed\)/u)
  assert.match(pageSource, /!value\.startsWith\('\/\/'\)/u)
  assert.doesNotMatch(pageSource, /源价/u)
  assert.doesNotMatch(pageSource, /JSON\.stringify/u)
  assert.match(pageSource, /币种未确认/u)
  assert.doesNotMatch(pageSource, /sourceFields\.currency \|\| 'CNY'/u)
})

test('panorama is mobile-first and desktop evidence is compact enough to keep actions reachable', async () => {
  const [, , pageSource, styleSource] = await sources()
  const panorama = pageSource.match(/function PanoramaView[\s\S]*?function ProductCard/u)?.[0] || ''

  assert.ok(panorama.indexOf('mih-market-spatial-canvas') < panorama.indexOf('mih-market-panorama__rail'))
  assert.match(styleSource, /\.mih-market-panorama \{\s*grid-template-areas: "rail canvas evidence"/u)
  assert.match(styleSource, /@media \(max-width: 720px\)[\s\S]*?\.mih-market-panorama \{\s*grid-template-areas: "canvas" "rail" "evidence"/u)
  assert.match(panorama, /aria-label=\{`进入\$\{department\.name\}部门（\$\{formatNumber\(department\.total\)\}件已加载）`\}/u)
  assert.match(styleSource, /\.mih-market-evidence__facts > div \{[\s\S]*?grid-template-columns: 78px minmax\(0, 1fr\)/u)
  assert.match(styleSource, /\.mih-market-shelf-preview > div \{[\s\S]*?grid-template-columns: repeat\(6/u)
})

test('evidence link opens Data Center with a stable datasetId route filter', async () => {
  const [appSource, , pageSource, , dataCenterSource] = await sources()

  assert.match(pageSource, /href="#\/data-center\?datasetId=mobile-commerce\.collected-items\.v1"/u)
  assert.match(appSource, /query: location\.query/u)
  assert.match(dataCenterSource, /DataCenterPage\(\{ token, query: routeQuery, onUnauthorized \}\)/u)
  assert.match(dataCenterSource, /const routeDatasetId = routeQuery\?\.get\('datasetId'\)\?\.trim\(\) \|\| ''/u)
  assert.match(dataCenterSource, /const \[datasetId, setDatasetId\] = useState\(routeDatasetId\)/u)
  assert.match(dataCenterSource, /setDatasetId\(routeDatasetId\)[\s\S]*?resetPagination\(\)[\s\S]*?\}, \[routeDatasetId\]\)/u)
  assert.doesNotMatch(dataCenterSource, /\}, \[routeQuery\]\)/u)
})
