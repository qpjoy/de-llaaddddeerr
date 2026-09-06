import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
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

let behaviorModulePromise

function behaviorModule() {
  behaviorModulePromise ||= build({
    stdin: {
      contents: "export { normalizedStoredLiveRequest, liveRequestRecoveryDecision, liveRequestStorageDecision } from './pages-ecommerce-treasure-box.jsx'",
      loader: 'js',
      resolveDir: fileURLToPath(new URL('../../src/', import.meta.url)),
    },
    bundle: true,
    define: { 'import.meta.env': '{}' },
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    treeShaking: true,
    write: false,
  }).then(({ outputFiles }) => import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].contents).toString('base64')}`))
  return behaviorModulePromise
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
  assert.doesNotMatch(pageSource, /chargeConfirmed|mih-treasure-charge-confirm|允许一次新的外部采集/u)
  assert.doesNotMatch(pageSource, /Hub consumer API Key/u)
  assert.match(pageSource, /publicDocsHref\('\/docs\/ecommerce-treasure-box'\)/u)
  const persistedRequest = pageSource.match(/function persistLiveRequest\(record\) \{[\s\S]*?\n\}/u)?.[0] || ''
  for (const field of ['body', 'idempotencyKey', 'keyFingerprint', 'requestId', 'outcome']) {
    assert.match(persistedRequest, new RegExp(`record\\.${field}`, 'u'))
  }
  assert.match(pageSource, /REQUEST_ID_PATTERN\.test\(parsed\.requestId\.trim\(\)\)/u)
  assert.match(pageSource, /\.\.\.\(requestId \? \{ requestId \} : \{\}\)/u)
  assert.doesNotMatch(persistedRequest, /hubApiKey|apiKey|authorization/iu)
  assert.doesNotMatch(pageSource, /localStorage\.(?:setItem|getItem)/u)
  assert.doesNotMatch(pageSource, /docs\.justoneapi\.com\/.*(?:token|key)=/iu)
})

test('the v1 session ledger migrates to v2, drops damage and accepts records without a Request ID', async () => {
  const [, , pageSource] = await sources()
  const loadSource = pageSource.match(/function loadLiveRequest\(\) \{[\s\S]*?\n\}/u)?.[0] || ''
  const persistSource = pageSource.match(/function persistLiveRequest\(record\) \{[\s\S]*?\n\}/u)?.[0] || ''
  const { normalizedStoredLiveRequest, liveRequestRecoveryDecision, liveRequestStorageDecision } = await behaviorModule()
  const migrated = normalizedStoredLiveRequest({
    body: { marketplace: 'taobao', query: ' 便携相机 ', deliveryMode: 'refresh', sort: 'sales_desc' },
    idempotencyKey: 'treasure-00000000-0000-4000-8000-000000000000',
    consumerFingerprint: 'a'.repeat(64),
    outcome: 'pending',
  })

  assert.equal(migrated.outcome, 'ambiguous')
  assert.equal(migrated.body.query, '便携相机')
  assert.equal(migrated.idempotencyKey, 'treasure-00000000-0000-4000-8000-000000000000')
  assert.equal('requestId' in migrated, false)
  assert.equal(normalizedStoredLiveRequest({ ...migrated, idempotencyKey: 'damaged' }), null)
  assert.deepEqual(liveRequestStorageDecision({ ...migrated, outcome: 'pending' }, { legacy: true }), {
    action: 'migrate',
    record: { ...migrated, migratedFromV1: true },
  })
  assert.deepEqual(liveRequestStorageDecision({ ...migrated, idempotencyKey: 'damaged' }), { action: 'remove', record: null })
  assert.equal(liveRequestRecoveryDecision({ status: 'committed' }), 'replay')
  assert.equal(liveRequestRecoveryDecision({ status: 'released' }), 'unlock')
  assert.equal(liveRequestRecoveryDecision({ status: 'reserved' }), 'hold_reserved')
  assert.equal(liveRequestRecoveryDecision({ status: 'unknown' }), 'hold_unknown')
  assert.equal(liveRequestRecoveryDecision({ migratedFromV1: true, httpStatus: 404, errorCode: 'request_not_found' }), 'clear_orphan')
  assert.equal(liveRequestRecoveryDecision({ migratedFromV1: false, httpStatus: 404, errorCode: 'request_not_found' }), 'clear_orphan')
  assert.equal(liveRequestRecoveryDecision({ migratedFromV1: true, httpStatus: 404, errorCode: 'not_found' }), 'deployment_mismatch')
  assert.match(pageSource, /live-request\.v1/u)
  assert.match(pageSource, /live-request\.v2/u)
  assert.match(loadSource, /\[LIVE_REQUEST_STORAGE_KEY, LEGACY_LIVE_REQUEST_STORAGE_KEY\]/u)
  assert.match(loadSource, /JSON\.parse\(serialized\)[\s\S]*?catch \{[\s\S]*?removeStoredLiveRequest\(storageKey\)/u)
  assert.match(loadSource, /liveRequestStorageDecision\(parsed,[\s\S]*?storageKey === LEGACY_LIVE_REQUEST_STORAGE_KEY/u)
  assert.match(loadSource, /decision\.action === 'remove'[\s\S]*?removeStoredLiveRequest\(storageKey\)/u)
  assert.match(loadSource, /decision\.action === 'migrate'[\s\S]*?persistLiveRequest\(decision\.record\)/u)
  assert.match(persistSource, /version: 2/u)
  assert.match(persistSource, /migratedFromV1/u)
  assert.match(persistSource, /removeStoredLiveRequest\(LEGACY_LIVE_REQUEST_STORAGE_KEY\)/u)
})

test('treasure box exposes safe stored, cache-first and explicit refresh delivery on one API', async () => {
  const [, , pageSource] = await sources()
  const runLive = pageSource.match(/const runLive = async[\s\S]*?\n  const submit =/u)?.[0] || ''
  const storedBody = pageSource.match(/function storedRequestBody\(value\) \{[\s\S]*?\n\}/u)?.[0] || ''
  const changeMode = pageSource.match(/const changeMode = \(value\) => \{[\s\S]*?\n  \}/u)?.[0] || ''
  const changeDeliveryMode = pageSource.match(/const changeDeliveryMode = \(value\) => \{[\s\S]*?\n  \}/u)?.[0] || ''

  for (const mode of ['cache_only', 'cache_first', 'refresh']) {
    assert.match(pageSource, new RegExp(`value: '${mode}'`, 'u'))
  }
  assert.match(pageSource, /const \[deliveryMode, setDeliveryMode\] = useState\('cache_only'\)/u)
  assert.match(pageSource, /label="交付策略"[\s\S]*?options=\{DELIVERY_MODE_OPTIONS\}/u)
  assert.match(pageSource, /只读保障：本次不会调用外部平台/u)
  assert.match(pageSource, /读取 Hub 存量/u)
  assert.match(pageSource, /重新采集最新数据/u)
  assert.match(runLive, /const providerMayRun = deliveryMode !== 'cache_only'/u)
  assert.match(runLive, /const refreshRequested = !replay && deliveryMode === 'refresh'/u)
  assert.doesNotMatch(runLive, /chargeConfirmed|成本确认|防误触/u)
  assert.match(runLive, /const verification = await verifyHubApiKey\(\)/u)
  assert.ok(
    runLive.indexOf('await verifyHubApiKey()') < runLive.indexOf('publicDataApi.ecommerceProductsSearch'),
    'one search click must preflight an unverified key before dispatching through Hub',
  )
  assert.match(runLive, /if \(tracksProviderRisk\) \{[\s\S]*?rememberLiveRequest/u)
  assert.match(storedBody, /deliveryMode: value\.deliveryMode \|\| 'cache_first'/u)
  assert.match(pageSource, /stored_snapshot_not_found[\s\S]*?没有调用 JustOne/u)
  for (const transition of [changeMode, changeDeliveryMode]) {
    assert.match(transition, /setProducts\(\[\]\)/u)
    assert.match(transition, /setSelected\(null\)/u)
    assert.match(transition, /setEvidence\(null\)/u)
  }
})

test('safe demo independently simulates all delivery strategies with zero Hub and zero upstream traffic', async () => {
  const [, , pageSource, , styleSource] = await sources()
  const demoOptions = pageSource.match(/const DEMO_DELIVERY_MODE_OPTIONS = \[[\s\S]*?\n\]/u)?.[0] || ''
  const demoScenario = pageSource.match(/function safeDemoScenario[\s\S]*?\n\}\n\nfunction safeDemoIdleMessage/u)?.[0] || ''
  const runSafeDemo = pageSource.match(/const runSafeDemo = async \(\) => \{[\s\S]*?\n  \}\n\n  const runLive/u)?.[0] || ''
  const changeMode = pageSource.match(/const changeMode = \(value\) => \{[\s\S]*?\n  \}\n\n  const changeDeliveryMode/u)?.[0] || ''
  const changeDemoDeliveryMode = pageSource.match(/const changeDemoDeliveryMode = \(value\) => \{[\s\S]*?\n  \}\n\n  const changeDemoCacheOnlyScene/u)?.[0] || ''

  for (const deliveryMode of ['cache_only', 'cache_first', 'refresh']) {
    assert.match(demoOptions, new RegExp(`value: '${deliveryMode}'`, 'u'))
  }
  assert.match(pageSource, /const \[demoDeliveryMode, setDemoDeliveryMode\] = useState\('cache_first'\)/u)
  assert.match(pageSource, /const \[demoCacheOnlyScene, setDemoCacheOnlyScene\] = useState\('no_inventory'\)/u)
  assert.match(pageSource, /label="模拟交付策略"[^\n]+options=\{DEMO_DELIVERY_MODE_OPTIONS\}[^\n]+onChange=\{changeDemoDeliveryMode\}/u)
  assert.match(pageSource, /label="cache_only 演练场景"[^\n]+options=\{DEMO_CACHE_ONLY_SCENE_OPTIONS\}[^\n]+onChange=\{changeDemoCacheOnlyScene\}/u)
  assert.match(pageSource, /浏览器本地策略沙盘 · 实际 0 Hub \/ 0 上游/u)
  assert.match(pageSource, /sourceMode=safe_demo/u)
  assert.match(demoScenario, /sourceMode: 'safe_demo'/u)
  assert.doesNotMatch(demoScenario, /\bsourceMode: '(?:live|fresh_cache|stored_fallback|idempotent_replay)'/u)
  assert.match(demoScenario, /simulatedErrorCode: 'stored_snapshot_not_found'/u)
  assert.match(demoScenario, /products: \[\][\s\S]*?实际 0 Hub \/ 0 上游/u)
  assert.match(demoScenario, /simulatedSourceMode: 'stored_fallback'/u)
  assert.match(demoScenario, /simulatedSourceMode: 'live'/u)
  assert.match(runSafeDemo, /safeDemoScenario\(\{ demoDeliveryMode, demoCacheOnlyScene, candidates \}\)/u)
  assert.match(runSafeDemo, /demoRunId: `demo-\$\{crypto\.randomUUID\(\)\}`/u)
  assert.doesNotMatch(runSafeDemo, /publicDataApi|fetch\(|requestId:|rememberLiveRequest|persistLiveRequest|sessionStorage/u)
  assert.match(changeMode, /if \(value === 'hub_live'\) setDeliveryMode\('cache_only'\)/u)
  assert.doesNotMatch(changeDemoDeliveryMode, /setDeliveryMode\(/u)
  assert.match(styleSource, /\.mih-treasure-demo-boundary/u)
  assert.match(styleSource, /\.mih-treasure-demo-trace/u)
})

test('live key preflight is zero-cost, rejects every Test key and leaves one-click recovery to submit', async () => {
  const [, apiSource, pageSource] = await sources()
  const capabilitiesApi = apiSource.match(/capabilities: \(apiKey,[\s\S]*?\n  \),/u)?.[0] || ''
  const requestLookupApi = apiSource.match(/requestByIdempotencyKey: \(apiKey,[\s\S]*?\n  \),/u)?.[0] || ''
  const verifyKey = pageSource.match(/const verifyHubApiKey = async \(\) => \{[\s\S]*?\n  \}\n\n  return \(/u)?.[0] || ''
  const changeKey = pageSource.match(/const changeHubApiKey = \(value\) => \{[\s\S]*?\n  \}\n\n  const verifyHubApiKey/u)?.[0] || ''

  assert.match(capabilitiesApi, /'\/api\/v1\/data\/capabilities'/u)
  assert.doesNotMatch(capabilitiesApi, /method: 'POST'|ecommerce\/products\/search/u)
  assert.match(requestLookupApi, /'\/api\/v1\/requests\/by-idempotency-key'/u)
  assert.match(requestLookupApi, /\{ idempotencyKey, signal \}/u)
  assert.doesNotMatch(requestLookupApi, /\?|query|method: 'POST'|ecommerce\/products\/search/u)
  assert.match(verifyKey, /publicDataApi\.capabilities\(apiKey\)/u)
  assert.doesNotMatch(verifyKey, /checkAmbiguousRequestStatus|ecommerceProductsSearch|rememberLiveRequest|persistLiveRequest/u)
  assert.match(verifyKey, /apiKey\.includes\('\*\*\*\*'\)/u)
  assert.ok(
    verifyKey.indexOf("apiKey.includes('****')") < verifyKey.indexOf('publicDataApi.capabilities(apiKey)'),
    'a masked key identifier must be rejected before any Hub request',
  )
  assert.doesNotMatch(verifyKey, /recoveringLegacyTestRequest/u)
  assert.match(verifyKey, /if \(apiKey\.startsWith\('mih_test_'\)\)/u)
  assert.match(verifyKey, /Test 前缀当前只是兼容标签，并非隔离沙箱/u)
  assert.match(verifyKey, /历史 Test Key 不能核对或恢复外部请求[\s\S]*?mih_live_ Key/u)
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
  assert.match(pageSource, /预检通过：没有创建 Hub usage/u)
  assert.match(apiSource, /export function publicApiOrigin\(\)/u)
  assert.match(pageSource, /本页调用 Public API：[\s\S]*?publicApiOrigin\(\)[\s\S]*?MX_INSIGHT_PUBLIC_URL/u)
  assert.match(pageSource, /上一次外部采集请求仍待核查[\s\S]*?点击主按钮即可[\s\S]*?先自动只读核对/u)
  assert.doesNotMatch(pageSource, /ambiguousLookupReady|再次核对状态|需要人工核查 consumer 归属/u)
  assert.match(changeKey, /setKeyCheck\(\{ status: 'idle', fingerprint: null/u)
  assert.match(changeKey, /lastLiveRequestRef\.current\?\.outcome !== 'ambiguous'\) forgetLiveRequest\(\)/u)
  assert.doesNotMatch(pageSource, /const keyUsable|ambiguousLookupReady/u)
  assert.doesNotMatch(pageSource, /type="submit"[^>]+!keyUsable/u)
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
  assert.match(script, /deliveryMode:"refresh"/u)
  assert.match(script, /external_platform_outcome_unknown\|request_outcome_unknown/u)
  assert.match(script, /external_platform_response_unusable[\s\S]*?502 is committed/u)
  assert.match(script, /request_in_progress[\s\S]*?suppressed before dispatch/u)
  assert.match(script, /Recover only with the same Idempotency-Key and identical body/u)
  assert.match(script, /idempotent_replay\)[\s\S]*?original request completed; this run created no new Hub usage or provider dispatch/u)
  assert.doesNotMatch(script, /no paid request|paid upstream dispatch/u)
})

test('one click reconciles an ambiguous refresh before one explicitly related retry', async () => {
  const [, apiSource, pageSource] = await sources()
  const runLive = pageSource.match(/const runLive = async[\s\S]*?\n  const submit =/u)?.[0] || ''
  const statusCheck = pageSource.match(/const checkAmbiguousRequestStatus = async \(\{[\s\S]*?\n  \}\n\n  const changeMarketplace/u)?.[0] || ''
  const submit = pageSource.match(/const submit = async \(event\) => \{[\s\S]*?\n  \}/u)?.[0] || ''
  const archive = pageSource.match(/function archiveLiveRequest\(record,[\s\S]*?\n\}/u)?.[0] || ''
  const sameLogicalRequest = pageSource.match(/function sameLogicalRequestBody\(left, right\) \{[\s\S]*?\n\}/u)?.[0] || ''
  const ambiguityClassifier = pageSource.match(/function ambiguousLiveFailure\(error\) \{[\s\S]*?\n\}/u)?.[0] || ''
  const ambiguousCodes = pageSource.match(/const AMBIGUOUS_LIVE_ERROR_CODES = new Set\(\[[\s\S]*?\]\)/u)?.[0] || ''
  const changeKey = pageSource.match(/const changeHubApiKey = \(value\) => \{[\s\S]*?\n  \}\n\n  const verifyHubApiKey/u)?.[0] || ''
  const searchApi = apiSource.match(/ecommerceProductsSearch: \(apiKey,[\s\S]*?\n  \),/u)?.[0] || ''

  assert.match(pageSource, /crypto\.subtle\.digest\('SHA-256'/u)
  assert.match(pageSource, /sessionStorage\.setItem\(LIVE_REQUEST_STORAGE_KEY/u)
  assert.match(archive, /sessionStorage\.setItem\(LIVE_REQUEST_AUDIT_STORAGE_KEY/u)
  assert.match(archive, /MAX_LIVE_REQUEST_AUDIT_RECORDS - 1/u)
  assert.doesNotMatch(archive, /hubApiKey|authorization|apiKey\s*:/iu)
  assert.match(pageSource, /parsed\.outcome === 'pending' \? 'ambiguous'/u)
  assert.ok(
    runLive.indexOf('rememberLiveRequest(requestRecord, { failClosed: true })')
      < runLive.indexOf('publicDataApi.ecommerceProductsSearch'),
    'the durable request record must be written before fetch',
  )
  assert.match(runLive, /if \(replay && previous\?\.outcome !== 'resolved'\)/u)
  assert.match(runLive, /outcome: replay \? 'resolved' : 'pending'/u)
  assert.match(runLive, /requestError\?\.requestId \? \{ requestId: requestError\.requestId \}/u)
  assert.match(statusCheck, /publicDataApi\.requestByIdempotencyKey\(apiKey, pending\.idempotencyKey\)/u)
  assert.doesNotMatch(statusCheck, /publicDataApi\.requestStatus|method:\s*'POST'/u)
  assert.match(submit, /if \(mode === 'safe_demo'\) await runSafeDemo\(\)[\s\S]*?else await runLive\(\)/u)
  assert.doesNotMatch(submit, /checkAmbiguousRequestStatus|verifyHubApiKey/u)
  assert.match(statusCheck, /liveRequestRecoveryDecision\(\{ status \}\)/u)
  assert.match(statusCheck, /recoveryDecision === 'replay'[\s\S]*?outcome: 'resolved'[\s\S]*?runLive\(\{ replay: true, apiKeyOverride: apiKey, fingerprintOverride: fingerprint \}\)/u)
  assert.match(statusCheck, /const refreshRequested = requestedBody\?\.deliveryMode === 'refresh'/u)
  assert.match(statusCheck, /recoveryDecision === 'unlock'[\s\S]*?forgetLiveRequest\(\)[\s\S]*?action: refreshRequested \? 'continue' : 'stop'/u)
  assert.match(statusCheck, /recoveryDecision === 'hold_reserved'[\s\S]*?code: 'request_in_progress'[\s\S]*?action: 'stop'/u)
  assert.match(statusCheck, /const verifiedRequestId = typeof resultRequestId[\s\S]*?resultRequestId[\s\S]*?: null/u)
  assert.match(statusCheck, /recoveryDecision === 'hold_unknown'[\s\S]*?archiveLiveRequest\(pending, \{ requestId, serverStatus: 'unknown' \}\)[\s\S]*?forgetLiveRequest\(\)[\s\S]*?retryOfRequestId: verifiedRequestId/u)
  assert.match(statusCheck, /recoveryDecision === 'clear_orphan'[\s\S]*?forgetLiveRequest\(\)[\s\S]*?action: refreshRequested \? 'continue' : 'stop'/u)
  assert.match(statusCheck, /recoveryDecision === 'deployment_mismatch'[\s\S]*?同版本的部署/u)
  assert.match(statusCheck, /const sameRequest = sameLogicalRequestBody\(requestedBody, pending\.body\)/u)
  assert.match(sameLogicalRequest, /\['marketplace', 'query', 'cursor', 'sort'\]/u)
  assert.doesNotMatch(sameLogicalRequest, /deliveryMode/u)
  assert.match(runLive, /const refreshRequested = !replay && deliveryMode === 'refresh'/u)
  assert.doesNotMatch(runLive, /chargeConfirmed|setChargeConfirmed|allowNewRefresh/u)
  assert.match(runLive, /checkAmbiguousRequestStatus\(\{[\s\S]*?requestedBody: currentLiveBody/u)
  assert.match(runLive, /if \(recovery\?\.action !== 'continue'\) return/u)
  assert.match(runLive, /retryOfRequestId = recovery\.retryOfRequestId \|\| null/u)
  assert.match(runLive, /`treasure-\$\{crypto\.randomUUID\(\)\}`/u)
  assert.match(runLive, /ecommerceProductsSearch\(apiKey, body, \{[\s\S]*?idempotencyKey,[\s\S]*?retryOfRequestId/u)
  assert.match(searchApi, /retryOfRequestId/u)
  for (const code of [
    'external_platform_outcome_unknown',
    'request_outcome_unknown',
    'request_in_progress',
  ]) assert.match(pageSource, new RegExp(code, 'u'))
  assert.doesNotMatch(ambiguousCodes, /external_platform_response_unusable/u)
  assert.match(ambiguityClassifier, /if \(error\?\.status === 409\) return false/u)
  assert.ok(
    ambiguityClassifier.indexOf('error?.status === 409') < ambiguityClassifier.indexOf('AMBIGUOUS_LIVE_ERROR_CODES.has'),
    'a fresh server-side suppression must not become a no-confirmation replay merely because it shares an ambiguity code',
  )
  assert.doesNotMatch(runLive, /previous\?\.keyFingerprint !== fingerprint/u)
  assert.match(statusCheck, /verifiedKeyFingerprintRef\.current !== fingerprint/u)
  assert.doesNotMatch(statusCheck, /fingerprint !== pending\.keyFingerprint|fingerprint === pending\.keyFingerprint/u)
  assert.match(changeKey, /lastLiveRequestRef\.current\?\.outcome !== 'ambiguous'/u)
  assert.match(runLive, /stableCommittedFailure[\s\S]*?outcome: 'resolved'/u)
  assert.match(runLive, /tracksProviderRisk[\s\S]*?rememberLiveRequest\(requestRecord, \{ failClosed: true \}\)/u)
})

test('ambiguous refresh is one click without fee checkbox, UUID or manual reconciliation controls', async () => {
  const [, , pageSource] = await sources()
  const keyField = pageSource.match(/<Field label="开放能力 API Key"[\s\S]*?<\/Field>/u)?.[0] || ''
  const changeMode = pageSource.match(/const changeMode = \(value\) => \{[\s\S]*?\n  \}\n\n  const changeDeliveryMode/u)?.[0] || ''
  const statusCheck = pageSource.match(/const checkAmbiguousRequestStatus = async \(\{[\s\S]*?\n  \}\n\n  const changeMarketplace/u)?.[0] || ''
  const runSafeDemo = pageSource.match(/const runSafeDemo = async \(\) => \{[\s\S]*?\n  \}/u)?.[0] || ''

  assert.match(pageSource, /requestInFlightRef\.current/u)
  assert.match(pageSource, /requestEpochRef\.current/u)
  assert.match(pageSource, /useEffect\(\(\) => \{[\s\S]*?mountedRef\.current = true[\s\S]*?return \(\) => \{/u)
  assert.match(pageSource, /if \(!finishRequest\(epoch\)\) return/u)
  assert.match(pageSource, /const \[mode, setMode\] = useState\('safe_demo'\)/u)
  assert.match(pageSource, /const hasAmbiguousLiveRequest = lastLiveRequest\?\.outcome === 'ambiguous'/u)
  assert.match(pageSource, /label="获取方式"[^\n]+disabled=\{phase === 'searching'\}/u)
  assert.doesNotMatch(pageSource, /label="获取方式"[^\n]+disabled=\{semanticsLocked\}/u)
  assert.match(pageSource, /label="平台"[\s\S]*?disabled=\{semanticsLocked\}/u)
  assert.match(pageSource, /label="排序"[\s\S]*?disabled=\{semanticsLocked/u)
  assert.match(pageSource, /maxLength="200" disabled=\{semanticsLocked\}/u)
  assert.match(keyField, /type="password"[\s\S]*?disabled=\{phase === 'searching' \|\| checkingKey\}/u)
  assert.match(pageSource, /const semanticsLocked = phase === 'searching'/u)
  assert.doesNotMatch(pageSource, /const semanticsLocked = [^\n]*ambiguousOriginalSelected/u)
  assert.match(changeMode, /if \(phase === 'searching'\) return/u)
  assert.doesNotMatch(changeMode, /setMarketplace\(pending\.body\.marketplace\)|setQuery\(pending\.body\.query\)/u)
  assert.match(statusCheck, /result\.payload\?\.data\?\.id/u)
  assert.doesNotMatch(statusCheck, /pending\.requestId \|\||fingerprint !== pending\.keyFingerprint/u)
  assert.doesNotMatch(pageSource, /placeholder="[^"]*(?:UUID|Request ID)|aria-label="原请求 Request ID"|旧记录缺少 Request ID/u)
  assert.match(pageSource, /无需输入 Request ID/u)
  assert.doesNotMatch(pageSource, /恢复原请求条件|再次核对状态|需要人工核查 consumer 归属/u)
  assert.doesNotMatch(changeMode, /forgetLiveRequest|clearPersistedLiveRequest/u)
  assert.doesNotMatch(runSafeDemo, /publicDataApi|forgetLiveRequest|clearPersistedLiveRequest/u)
  assert.match(pageSource, /deliveryMode === 'refresh'[\s\S]*?点击主按钮即可[\s\S]*?reserved 或核对失败仍会安全停止/u)
  assert.match(pageSource, /const providerRequestBlockedByAmbiguity = mode === 'hub_live'[\s\S]*?deliveryMode === 'cache_first'/u)
  assert.doesNotMatch(pageSource, /chargeConfirmed|setChargeConfirmed|mih-treasure-charge-confirm|成本确认/u)
  assert.match(pageSource, /type="submit" disabled=\{phase === 'searching' \|\| checkingKey \|\| providerRequestBlockedByAmbiguity\}/u)
  assert.match(pageSource, /hasAmbiguousLiveRequest \? '自动核对后重新采集'/u)
  assert.doesNotMatch(pageSource, /type="submit" disabled=\{[^}]*!keyUsable/u)
  assert.match(pageSource, /mode === 'safe_demo' \? safeDemoIdleMessage\(demoDeliveryMode, demoCacheOnlyScene\)/u)
  assert.match(pageSource, /aria-pressed=\{capabilityGroup === group\.id\}/u)
  assert.doesNotMatch(pageSource, /role="tab(?:list)?"|aria-selected=/u)
})

test('data-product errors are localized by ownership and always retain operator evidence', async () => {
  const [, , pageSource, , styleSource] = await sources()
  const presentation = pageSource.match(/function ecommerceErrorPresentation\(error\) \{[\s\S]*?\n\}/u)?.[0] || ''
  const errorState = pageSource.match(/function TreasureProductError[\s\S]*?\n\}/u)?.[0] || ''

  for (const [code, copy] of [
    ['external_platform_response_unusable', '外部数据已返回，但暂时无法整理成 Hub 商品'],
    ['external_platform_outcome_unknown', '这次实时请求的结果暂时无法确认'],
    ['request_in_progress', '同一实时请求仍在处理中'],
    ['external_platform_not_configured', '实时数据源尚未配置完成'],
    ['external_platform_capacity_exceeded', '外部数据容量暂不可用'],
    ['external_platform_busy', '实时请求较多，请稍后再试'],
    ['quota_exceeded', '当前调用身份的 Hub 请求额度已用完'],
    ['external_platform_rejected', '外部数据服务拒绝了本次查询'],
  ]) {
    assert.match(presentation, new RegExp(code, 'u'))
    assert.match(presentation, new RegExp(copy, 'u'))
  }
  assert.match(presentation, /error\?\.status === 409[\s\S]*?本次尝试在上游派发前停止，没有新增外部采集/u)
  assert.match(presentation, /同类实时请求仍在未决隔离期[\s\S]*?早先的请求结果仍可能未知/u)
  assert.match(errorState, /error\.code/u)
  assert.match(errorState, /error\.requestId/u)
  assert.match(errorState, /转到零费用演示/u)
  assert.match(errorState, /查看上游运行状态/u)
  assert.doesNotMatch(errorState, /error\?\.message \|\| '数据请求失败'/u)
  assert.match(pageSource, /<section className="qp-panel mih-treasure-lab">\s*\{error \? <TreasureProductError/u)
  assert.equal(pageSource.match(/<TreasureProductError\b/gu)?.length, 1)
  assert.match(styleSource, /\.mih-treasure-lab > \.mih-treasure-product-error \{[\s\S]*?grid-column: 1 \/ -1/u)
  assert.match(pageSource, /这次没有找到商品/u)
  assert.match(pageSource, /这是正常空结果/u)
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
  for (const label of ['安全演示 · 0 Hub / 0 上游', 'Here you are', '缓存里刚好有一份', '先给你可靠的存档']) {
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
