import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import test from 'node:test'

async function sources() {
  return Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages-ecommerce-treasure-box.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages-source-catalog.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/styles.css', import.meta.url), 'utf8'),
  ])
}

test('ecommerce treasure box is an Admin-token-only data product', async () => {
  const [appSource] = await sources()
  const route = appSource.match(/\{ path: '\/data-products\/ecommerce-treasure-box',[^\n]+\}/u)?.[0] || ''

  assert.match(appSource, /lazy\(\(\) => import\('\.\/pages-ecommerce-treasure-box\.jsx'\)/u)
  assert.match(route, /label: '电商数据百宝箱'/u)
  assert.match(route, /navParent: DATA_PRODUCTS_NAV_KEY/u)
  assert.match(route, /component: EcommerceTreasureBoxPage/u)
  assert.match(route, /platformAdmin: true/u)
  assert.match(route, /adminTokenOnly: true/u)
})

test('treasure box calls only the stable Hub contract and never persists the consumer secret', async () => {
  const [, apiSource, pageSource] = await sources()

  assert.match(apiSource, /export const publicDataApi/u)
  assert.match(apiSource, /\/api\/v1\/data\/ecommerce\/products\/search/u)
  assert.match(pageSource, /publicDataApi\.ecommerceProductsSearch/u)
  assert.match(pageSource, /type="password"/u)
  assert.match(pageSource, /autocomplete="off"/iu)
  assert.match(pageSource, /Hub consumer API Key/u)
  assert.match(pageSource, /确认可能产生一次上游计费/u)
  assert.match(pageSource, /publicDocsHref\('\/docs\/ecommerce-treasure-box'\)/u)
  const persistedRequest = pageSource.match(/function persistLiveRequest\(record\) \{[\s\S]*?\n\}/u)?.[0] || ''
  for (const field of ['body', 'idempotencyKey', 'consumerFingerprint', 'outcome']) {
    assert.match(persistedRequest, new RegExp(`record\\.${field}`, 'u'))
  }
  assert.doesNotMatch(persistedRequest, /hubApiKey|apiKey|authorization/iu)
  assert.doesNotMatch(pageSource, /localStorage\.(?:setItem|getItem)/u)
  assert.doesNotMatch(pageSource, /docs\.justoneapi\.com\/.*(?:token|key)=/iu)
})

test('paid live requests durably bind the exact request before fetch and fail closed on ambiguity', async () => {
  const [, , pageSource] = await sources()
  const runLive = pageSource.match(/const runLive = async[\s\S]*?\n  const submit =/u)?.[0] || ''

  assert.match(pageSource, /crypto\.subtle\.digest\('SHA-256'/u)
  assert.match(pageSource, /sessionStorage\.setItem\(LIVE_REQUEST_STORAGE_KEY/u)
  assert.match(pageSource, /parsed\.outcome === 'pending' \? 'ambiguous'/u)
  assert.ok(
    runLive.indexOf('rememberLiveRequest(requestRecord, { failClosed: true })')
      < runLive.indexOf('publicDataApi.ecommerceProductsSearch'),
    'the durable request record must be written before fetch',
  )
  for (const code of [
    'external_platform_outcome_unknown',
    'external_platform_response_unusable',
    'request_outcome_unknown',
  ]) assert.match(pageSource, new RegExp(code, 'u'))
  assert.match(runLive, /previous\?\.outcome === 'ambiguous'[\s\S]*?只能使用原 Idempotency-Key 重试/u)
  assert.match(runLive, /previous\.consumerFingerprint !== fingerprint[\s\S]*?forgetLiveRequest/u)
  assert.match(pageSource, /verifiedConsumerFingerprintRef\.current && value !== hubApiKey[\s\S]*?forgetLiveRequest/u)
})

test('request controls lock in flight, stale responses are guarded and atlas choices are buttons', async () => {
  const [, , pageSource] = await sources()

  assert.match(pageSource, /requestInFlightRef\.current/u)
  assert.match(pageSource, /requestEpochRef\.current/u)
  assert.match(pageSource, /useEffect\(\(\) => \{[\s\S]*?mountedRef\.current = true[\s\S]*?return \(\) => \{/u)
  assert.match(pageSource, /if \(!finishRequest\(epoch\)\) return/u)
  assert.match(pageSource, /label="获取方式"[\s\S]*?disabled=\{semanticsLocked\}/u)
  assert.match(pageSource, /label="平台"[\s\S]*?disabled=\{semanticsLocked\}/u)
  assert.match(pageSource, /label="排序"[\s\S]*?disabled=\{semanticsLocked/u)
  assert.match(pageSource, /maxLength="200" disabled=\{semanticsLocked\}/u)
  assert.match(pageSource, /type="password"[\s\S]*?disabled=\{phase === 'searching'\}/u)
  assert.match(pageSource, /aria-pressed=\{capabilityGroup === group\.id\}/u)
  assert.doesNotMatch(pageSource, /role="tab(?:list)?"|aria-selected=/u)
})

test('safe demo applies platform, query and supported sort semantics without loading product images', async () => {
  const [, , pageSource] = await sources()
  const demoSearch = pageSource.match(/function demoProducts[\s\S]*?\n\}/u)?.[0] || ''
  const productOrb = pageSource.match(/function ProductOrb[\s\S]*?\n\}/u)?.[0] || ''

  assert.match(demoSearch, /item\.marketplace === marketplace/u)
  assert.match(demoSearch, /terms\.every/u)
  assert.match(demoSearch, /price_asc/u)
  assert.match(demoSearch, /sales_desc/u)
  assert.match(pageSource, /SAFE_DEMO_SORTS/u)
  assert.match(productOrb, /<Package/u)
  assert.doesNotMatch(productOrb, /item\.images|<img\b|src=/u)
})

test('direct Admin-listener visits resolve the isolated Public API and docs surfaces', async () => {
  const [appSource, apiSource] = await sources()
  const viteSource = await readFile(new URL('../../vite.config.mjs', import.meta.url), 'utf8')

  assert.match(apiSource, /VITE_MX_INSIGHT_PUBLIC_API_BASE/u)
  assert.match(apiSource, /window\.location\.port === '18151'/u)
  assert.match(apiSource, /url\.port = '18150'/u)
  assert.match(apiSource, /export function configurePublicApiBase/u)
  assert.match(apiSource, /fetch\(`\$\{publicApiBase\(\)\}\$\{path\}`/u)
  assert.match(appSource, /configurePublicApiBase\(data\?\.publicApiBaseUrl\)/u)
  assert.match(apiSource, /export function publicDocsHref/u)
  assert.match(viteSource, /"\/docs": devApiTarget/u)
})

test('treasure box presents truthful safe, live, cache, fallback and replay states', async () => {
  const [, , pageSource, , styleSource] = await sources()

  for (const value of ['safe_demo', 'live', 'fresh_cache', 'stored_fallback', 'idempotent_replay']) {
    assert.match(pageSource, new RegExp(value, 'u'))
  }
  for (const label of ['安全演示 · 0 上游调用', 'Here you are', '缓存里刚好有一份', '先给你可靠的存档']) {
    assert.match(pageSource, new RegExp(label, 'u'))
  }
  assert.match(pageSource, /phase === 'searching' \? SEARCHING_ASSET : PRESENTING_ASSET/u)
  assert.match(pageSource, /aria-label=\{`查看 \$\{item\.title \|\| item\.id\} 的属性`\}/u)
  assert.match(styleSource, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.mih-treasure-orb/u)
  assert.match(styleSource, /@media \(max-width: 720px\)[\s\S]*?\.mih-treasure-stage/u)
})

test('generated mascot poses are real transparent raster assets', async () => {
  const [, , pageSource] = await sources()
  for (const file of ['data-cat-searching.webp', 'data-cat-presenting.webp']) {
    assert.match(pageSource, new RegExp(`assets/ecommerce-treasure-box/${file}`, 'u'))
    const info = await stat(new URL(`../../public/assets/ecommerce-treasure-box/${file}`, import.meta.url))
    assert.ok(info.size > 50_000, `${file} should be a substantive generated raster asset`)
  }
  assert.doesNotMatch(pageSource, /<svg\b|<canvas\b|<select\b/iu)
})

test('source catalog distinguishes verified JustOne runtime marketplaces from connector evidence', async () => {
  const [, , , catalogSource] = await sources()

  for (const sourceKey of ['0058', '0059', '0060', '0064', '0073']) {
    assert.match(catalogSource, new RegExp(`source-catalog-${sourceKey}`, 'u'))
  }
  assert.doesNotMatch(
    catalogSource.match(/const JUSTONE_CONNECTED_SOURCE_KEYS = new Set\(\[[\s\S]*?\]\)/u)?.[0] || '',
    /source-catalog-0062|source-catalog-0063/u,
  )
  assert.match(catalogSource, /JustOne · 商品搜索已接/u)
  assert.match(catalogSource, /JustOne · 接入线索/u)
  assert.match(catalogSource, /id: 'justone-connected'/u)
})
