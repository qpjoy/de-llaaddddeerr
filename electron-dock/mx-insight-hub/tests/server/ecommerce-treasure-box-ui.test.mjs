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

test('treasure box reuses the ordinary Open Capabilities API key and never persists its secret', async () => {
  const [, apiSource, pageSource] = await sources()

  assert.match(apiSource, /export const publicDataApi/u)
  assert.match(apiSource, /\/api\/v1\/data\/ecommerce\/products\/search/u)
  assert.match(pageSource, /publicDataApi\.ecommerceProductsSearch/u)
  assert.match(pageSource, /type="password"/u)
  assert.match(pageSource, /autocomplete="off"/iu)
  assert.match(pageSource, /开放能力 API Key/u)
  assert.match(pageSource, /无需另签产品 Key/u)
  assert.match(pageSource, /演示页防误触：允许一次新的外部采集/u)
  assert.match(pageSource, /这不是客户端 API 的额外权限/u)
  assert.doesNotMatch(pageSource, /Hub consumer API Key/u)
  assert.match(pageSource, /publicDocsHref\('\/docs\/ecommerce-treasure-box'\)/u)
  const persistedRequest = pageSource.match(/function persistLiveRequest\(record\) \{[\s\S]*?\n\}/u)?.[0] || ''
  for (const field of ['body', 'idempotencyKey', 'keyFingerprint', 'outcome']) {
    assert.match(persistedRequest, new RegExp(`record\\.${field}`, 'u'))
  }
  assert.doesNotMatch(persistedRequest, /hubApiKey|apiKey|authorization/iu)
  assert.doesNotMatch(pageSource, /localStorage\.(?:setItem|getItem)/u)
  assert.doesNotMatch(pageSource, /docs\.justoneapi\.com\/.*(?:token|key)=/iu)
})

test('live key preflight is zero-cost, rejects every Test key and preserves an ambiguous lock', async () => {
  const [, apiSource, pageSource] = await sources()
  const capabilitiesApi = apiSource.match(/capabilities: \(apiKey,[\s\S]*?\n  \),/u)?.[0] || ''
  const verifyKey = pageSource.match(/const verifyHubApiKey = async \(\) => \{[\s\S]*?\n  \}\n\n  return \(/u)?.[0] || ''
  const changeKey = pageSource.match(/const changeHubApiKey = \(value\) => \{[\s\S]*?\n  \}\n\n  const verifyHubApiKey/u)?.[0] || ''

  assert.match(capabilitiesApi, /'\/api\/v1\/data\/capabilities'/u)
  assert.doesNotMatch(capabilitiesApi, /method: 'POST'|ecommerce\/products\/search/u)
  assert.match(verifyKey, /publicDataApi\.capabilities\(apiKey\)/u)
  assert.doesNotMatch(verifyKey, /ecommerceProductsSearch|rememberLiveRequest|persistLiveRequest|idempotencyKey/u)
  assert.match(verifyKey, /apiKey\.includes\('\*\*\*\*'\)/u)
  assert.ok(
    verifyKey.indexOf("apiKey.includes('****')") < verifyKey.indexOf('publicDataApi.capabilities(apiKey)'),
    'a masked key identifier must be rejected before any Hub request',
  )
  assert.doesNotMatch(verifyKey, /recoveringLegacyTestRequest/u)
  assert.match(verifyKey, /if \(apiKey\.startsWith\('mih_test_'\)\)/u)
  assert.match(verifyKey, /Test 前缀当前只是兼容标签，并非隔离沙箱/u)
  assert.match(verifyKey, /历史 Test Key 不能从演示页恢复外部请求[\s\S]*?交由运维核查/u)
  assert.ok(
    verifyKey.indexOf("apiKey.startsWith('mih_test_')") < verifyKey.indexOf('publicDataApi.capabilities(apiKey)'),
    'the compatibility-only Test-key policy must be resolved before any Hub request',
  )
  assert.match(verifyKey, /\^mih_live_/u)
  assert.match(verifyKey, /entry\?\.platform\) === 'ecommerce'/u)
  assert.match(verifyKey, /status: 'missing_grant'/u)
  assert.match(verifyKey, /status: 'degraded'/u)
  assert.match(verifyKey, /status: 'ready'/u)
  assert.match(pageSource, /placeholder="mih_live_…"/u)
  assert.doesNotMatch(pageSource, /placeholder="[^"]*mih_test_/u)
  assert.doesNotMatch(pageSource, /placeholder="mxk_/u)
  assert.match(pageSource, /type="button"[^>]+onClick=\{verifyHubApiKey\}[\s\S]*?零费用验证 Key/u)
  assert.match(pageSource, /预检不创建 Hub usage/u)
  assert.match(pageSource, /原 body 与 Idempotency-Key 已锁定[\s\S]*?原 Live Key[\s\S]*?运维核查/u)
  assert.match(pageSource, /const ambiguousLiveReplayReady = ambiguousRetryAvailable[\s\S]*?keyCheck\.fingerprint === lastLiveRequest\?\.keyFingerprint/u)
  assert.match(pageSource, /ambiguousRetryAvailable && !ambiguousLiveReplayReady/u)
  assert.match(pageSource, /ambiguousLiveReplayReady \? '使用原 Idempotency-Key 重试' : '已锁定 · 验证原 Live Key'/u)
  assert.match(changeKey, /setKeyCheck\(\{ status: 'idle', fingerprint: null/u)
  assert.match(changeKey, /lastLiveRequestRef\.current\?\.outcome !== 'ambiguous'\) forgetLiveRequest\(\)/u)
  assert.match(pageSource, /const keyUsable = \['ready', 'degraded'\]\.includes\(keyCheck\.status\)/u)
  assert.match(pageSource, /mode === 'hub_live' && !keyUsable/u)
})

test('live verification script preserves one recovery identity across ambiguous outcomes', async () => {
  const script = await readFile(new URL('../../scripts/justone-apicall.sh', import.meta.url), 'utf8')
  const firstHubRequest = script.indexOf('PREFLIGHT_HTTP_STATUS=$(curl')
  const firstDispatch = script.indexOf('if ! LIVE_HTTP_STATUS=$(curl')
  const recoveryKey = script.indexOf("printf 'Recovery Idempotency-Key:")
  const recoveryBody = script.indexOf("printf 'Recovery request body:")

  assert.match(script, /mih_test_\*\) fail "mih_test_ is compatibility metadata, not a no-cost sandbox/u)
  assert.ok(script.indexOf('mih_test_*) fail') < firstHubRequest, 'Test keys must fail before any Hub request')
  assert.match(script, /LIVE_KEY="\$\{HUB_IDEMPOTENCY_KEY:-\}"/u)
  assert.match(script, /HUB_ECOMMERCE_QUERY:-蓝牙耳机受控实时检查-\$\{LIVE_KEY##\*-\}/u)
  assert.ok(recoveryKey >= 0 && recoveryKey < firstDispatch, 'recovery key must be shown before dispatch')
  assert.ok(recoveryBody >= 0 && recoveryBody < firstDispatch, 'recovery body must be shown before dispatch')
  assert.match(script, /external_platform_outcome_unknown\|external_platform_response_unusable\|request_outcome_unknown\|request_in_progress/u)
  assert.match(script, /Recover only with the same Idempotency-Key and identical body/u)
  assert.match(script, /idempotent_replay\)[\s\S]*?original request completed; this run created no new Hub usage or provider dispatch/u)
  assert.doesNotMatch(script, /no paid request|paid upstream dispatch/u)
})

test('live requests durably bind the exact request before fetch and fail closed on ambiguity', async () => {
  const [, , pageSource] = await sources()
  const runLive = pageSource.match(/const runLive = async[\s\S]*?\n  const submit =/u)?.[0] || ''
  const mismatchBlock = runLive.match(/if \(replay && previous\?\.keyFingerprint !== fingerprint\) \{[\s\S]*?\n      \}/u)?.[0] || ''
  const changeKey = pageSource.match(/const changeHubApiKey = \(value\) => \{[\s\S]*?\n  \}\n\n  const verifyHubApiKey/u)?.[0] || ''

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
  assert.match(mismatchBlock, /previous\?\.keyFingerprint !== fingerprint/u)
  assert.doesNotMatch(mismatchBlock, /forgetLiveRequest/u)
  assert.match(mismatchBlock, /原 body 与 Idempotency-Key 已继续锁定/u)
  assert.match(changeKey, /lastLiveRequestRef\.current\?\.outcome !== 'ambiguous'/u)
  assert.match(runLive, /if \(!\(replay && previous\?\.outcome === 'ambiguous'\)\) forgetLiveRequest\(\)/u)
})

test('request controls lock in flight, stale responses are guarded and atlas choices are buttons', async () => {
  const [, , pageSource] = await sources()
  const keyField = pageSource.match(/<Field label="开放能力 API Key"[\s\S]*?<\/Field>/u)?.[0] || ''

  assert.match(pageSource, /requestInFlightRef\.current/u)
  assert.match(pageSource, /requestEpochRef\.current/u)
  assert.match(pageSource, /useEffect\(\(\) => \{[\s\S]*?mountedRef\.current = true[\s\S]*?return \(\) => \{/u)
  assert.match(pageSource, /if \(!finishRequest\(epoch\)\) return/u)
  assert.match(pageSource, /label="获取方式"[\s\S]*?disabled=\{semanticsLocked\}/u)
  assert.match(pageSource, /label="平台"[\s\S]*?disabled=\{semanticsLocked\}/u)
  assert.match(pageSource, /label="排序"[\s\S]*?disabled=\{semanticsLocked/u)
  assert.match(pageSource, /maxLength="200" disabled=\{semanticsLocked\}/u)
  assert.match(keyField, /type="password"[\s\S]*?disabled=\{phase === 'searching' \|\| checkingKey\}/u)
  assert.match(pageSource, /aria-pressed=\{capabilityGroup === group\.id\}/u)
  assert.doesNotMatch(pageSource, /role="tab(?:list)?"|aria-selected=/u)
})

test('safe demo applies platform, query and supported sort semantics without loading product images', async () => {
  const [, , pageSource] = await sources()
  const demoSearch = pageSource.match(/function demoProducts[\s\S]*?\n\}/u)?.[0] || ''

  assert.match(demoSearch, /item\.marketplace === marketplace/u)
  assert.match(demoSearch, /terms\.every/u)
  assert.match(demoSearch, /price_asc/u)
  assert.match(demoSearch, /sales_desc/u)
  assert.match(pageSource, /SAFE_DEMO_SORTS/u)
  assert.match(pageSource, /apiKey=\{mode === 'hub_live' \? hubApiKey\.trim\(\) : ''\}/u)
})

test('optional product imagery is loaded only through the authenticated Hub media relay', async () => {
  const [, apiSource, pageSource] = await sources()
  const hubProductImage = pageSource.match(/function HubProductImage[\s\S]*?\n\}/u)?.[0] || ''
  const productOrb = pageSource.match(/function ProductOrb[\s\S]*?\n\}/u)?.[0] || ''

  assert.match(apiSource, /\/api\/v1\/data\/ecommerce\/products\/media/u)
  assert.match(apiSource, /authorization: `Bearer \$\{apiKey\}`/u)
  assert.match(apiSource, /ecommerceProductImage: \(apiKey,[\s\S]*?publicDataImage/u)
  assert.match(productOrb, /<HubProductImage apiKey=\{apiKey\} requestId=\{requestId\} item=\{item\} \/>/u)
  assert.doesNotMatch(productOrb, /item\.images|<img\b|src=/u)
  assert.match(hubProductImage, /publicDataApi\.ecommerceProductImage\(apiKey/u)
  assert.match(hubProductImage, /requestId,[\s\S]*?itemId: item\.id,[\s\S]*?imageIndex: 0/u)
  assert.match(hubProductImage, /URL\.createObjectURL\(blob\)/u)
  assert.match(hubProductImage, /<img src=\{source\}/u)
  assert.match(hubProductImage, /<Package/u)
  assert.doesNotMatch(hubProductImage, /item\.images\s*\[/u)
  assert.doesNotMatch(pageSource, /fetch\(/u)
  assert.doesNotMatch(pageSource, /src=\{[^}]*item\??\.images|src=\{[^}]*product\??\.images/iu)
})

test('product spheres support local 3, 6 or 9 item display pages without another data request', async () => {
  const [, , pageSource] = await sources()
  const pageSizeOptions = pageSource.match(/const DISPLAY_PAGE_SIZE_OPTIONS = \[[\s\S]*?\n\]/u)?.[0] || ''
  const showDisplayPage = pageSource.match(/const showDisplayPage = \(nextPage\) => \{[\s\S]*?\n  \}/u)?.[0] || ''
  const pageSizeControl = pageSource.match(/<DropdownField label="每页陈列"[^\n]+/u)?.[0] || ''

  for (const [value, label] of [['3', '3 件 / 页'], ['6', '6 件 / 页'], ['9', '9 件 / 页']]) {
    assert.match(pageSizeOptions, new RegExp(`value: '${value}', label: '${label}'`, 'u'))
  }
  assert.match(pageSource, /useState\('6'\)/u)
  assert.match(pageSource, /Math\.ceil\(products\.length \/ pageSize\)/u)
  assert.match(pageSource, /products\.slice\(displayPage \* pageSize, \(displayPage \+ 1\) \* pageSize\)/u)
  assert.match(pageSizeControl, /options=\{DISPLAY_PAGE_SIZE_OPTIONS\}/u)
  assert.match(pageSizeControl, /setDisplayPageSize\(value\); setDisplayPage\(0\)/u)
  assert.doesNotMatch(pageSizeControl, /publicDataApi|fetch\(/u)
  assert.match(pageSource, /const angle = \(-120 \+ \(index \* 360\) \/ total\)/u)
  assert.match(pageSource, /total=\{visibleProducts\.length\}/u)
  assert.match(showDisplayPage, /setDisplayPage\(bounded\)/u)
  assert.match(showDisplayPage, /setSelected\(products\[bounded \* pageSize\] \|\| null\)/u)
  assert.doesNotMatch(showDisplayPage, /publicDataApi|fetch\(/u)
  assert.match(pageSource, /aria-label="商品陈列分页"/u)
  assert.match(pageSource, /aria-label="上一陈列页"/u)
  assert.match(pageSource, /aria-label="下一陈列页"/u)
})

test('direct Admin-listener visits resolve the isolated Public API and docs surfaces', async () => {
  const [appSource, apiSource, pageSource] = await sources()
  const pagesSource = await readFile(new URL('../../src/pages.jsx', import.meta.url), 'utf8')
  const viteSource = await readFile(new URL('../../vite.config.mjs', import.meta.url), 'utf8')

  assert.match(apiSource, /VITE_MX_INSIGHT_PUBLIC_API_BASE/u)
  assert.match(apiSource, /window\.location\.port === '18151'/u)
  assert.match(apiSource, /url\.port = '18150'/u)
  assert.match(apiSource, /export function configurePublicApiBase/u)
  assert.match(apiSource, /fetch\(`\$\{publicApiBase\(\)\}\$\{path\}`/u)
  assert.match(appSource, /configurePublicApiBase\(data\?\.publicApiBaseUrl\)/u)
  assert.match(apiSource, /export function publicDocsHref/u)
  assert.doesNotMatch(pagesSource, /const PUBLIC_DOCS_HREF = publicDocsHref/u)
  assert.match(pagesSource, /href=\{publicDocsHref\(\)\}/u)
  assert.doesNotMatch(pageSource, /const ECOMMERCE_DOCS_HREF = publicDocsHref/u)
  assert.match(pageSource, /href=\{publicDocsHref\('\/docs\/ecommerce-treasure-box'\)\}/u)
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
