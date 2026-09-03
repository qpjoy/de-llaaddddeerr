import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

async function sources() {
  return Promise.all([
    readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src/api.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/pages-external-platforms.jsx', import.meta.url), 'utf8'),
  ])
}

// Expected mx-insight-hub.external-platform-admin.v1 DTO. Optional evidence stays
// optional in the UI; rates are 0..1 ratios and *Minor amounts are minor units:
// overview = { contractVersion, range, generatedAt,
//   summary: { hubRequests, successfulHubRequests, hubSuccessRate, upstreamCalls,
//     successfulUpstreamCalls, avoidedUpstreamCalls, knownCostMinor,
//     unknownCostCalls, currency },
//   providers: [{ key, displayName, status, metrics, quota, billing,
//     freshness, circuit }] }
// detail = { contractVersion, range, generatedAt, provider,
//   pipeline: [{ key, label, description, status }],
//   timeSeries: [{ bucket, hubRequests, successfulHubRequests, hubSuccessRate,
//     upstreamCalls, freshCache, storedFallback, idempotentReplay, knownCostMinor }],
//   capabilities: [{ capability, label, hubContractVersion, providerMapping,
//     scope, status, fallback, note }],
//   tenants: [{ tenantId, tenantName, hubRequests, successfulHubRequests,
//     upstreamCalls, knownCostMinor, share, successRate }], endpoints,
//   guardrails, costPlan, notes }

test('external-platform admin facade uses bounded range queries and encoded provider keys', async () => {
  const [, apiSource] = await sources()

  assert.match(apiSource, /externalPlatforms: \(token, query = \{\}\) => request\([\s\S]*?`\$\{ADMIN_ROOT\}\/external-platforms`, \{ query \}/u)
  assert.match(apiSource, /externalPlatform: \(token, key, query = \{\}\) => request\([\s\S]*?`\$\{ADMIN_ROOT\}\/external-platforms\/\$\{encodeURIComponent\(key\)\}`, \{ query \}/u)
})

test('external-platform page supports JustOne detail without changing session gating', async () => {
  const [appSource, , pageSource] = await sources()
  const route = appSource.match(/\{ path: '\/external-platforms',[^\n]+\}/u)?.[0] || ''

  assert.match(route, /navParent: DATA_CLEANING_NAV_KEY/u)
  assert.match(route, /capability: 'membership\.write'/u)
  assert.match(route, /platformAdmin: true/u)
  assert.match(route, /adminTokenOnly: true/u)
  assert.match(pageSource, /query\.get\('provider'\)/u)
  assert.match(pageSource, /provider !== 'justone'/u)
  assert.match(pageSource, /adminApi\.externalPlatform\(token, provider, \{ range \}\)/u)
  assert.doesNotMatch(pageSource, /<select\b/iu)
  assert.match(pageSource, /<DropdownField/u)
  assert.doesNotMatch(pageSource, /SESSION_KEY|signInWithLauncher|SessionGate/u)
})

test('JustOne command center distinguishes unknown evidence from real zero values', async () => {
  const [, , pageSource] = await sources()

  assert.match(pageSource, /const UNKNOWN = '未知'/u)
  assert.match(pageSource, /value === null \? UNKNOWN : formatNumber\(value\)/u)
  assert.match(pageSource, /未知不会绘制为 0/u)
  assert.match(pageSource, /不会用示例平台或推测指标填充/u)
  assert.match(pageSource, /不会自行假设免费额度、阶梯价或充值折扣/u)
  assert.match(pageSource, /尚无已登记外部数据平台/u)
  assert.match(pageSource, /暂无调用趋势/u)
  assert.match(pageSource, /暂无能力矩阵/u)
  assert.match(pageSource, /暂无租户排名/u)
  assert.match(pageSource, /misconfigured: '配置错误'/u)
  assert.match(pageSource, /awaiting_verification: '待契约验证'/u)
})

test('JustOne detail exposes usage, cost, processing, capability, tenant, and guardrail evidence', async () => {
  const [, , pageSource] = await sources()

  for (const text of [
    'Hub 请求',
    '实际上游调用',
    'Hub 成功率',
    '避免调用',
    '成本与免费额度',
    '调用趋势',
    'Hub 四阶段处理链路',
    '稳定 API 合同',
    '准入与调用保护',
    '版本化上游适配',
    '归档与 Canonical',
    '能力与版本矩阵',
    '租户使用量排名',
    '费用与稳定性保护',
  ]) assert.match(pageSource, new RegExp(text, 'u'))

  for (const field of [
    'hubRequests',
    'upstreamCalls',
    'successfulHubRequests',
    'hubSuccessRate',
    'successRate',
    'avoidedUpstreamCalls',
    'knownCostMinor',
    'grossEstimatedCostMinor',
    'projectedMonthlyCostMinor',
    'indeterminateBillingCalls',
    'freeDailyCalls',
    'timeSeries',
    'providerMapping',
    'hubContractVersion',
    'guardrails',
    'costPlan',
  ]) assert.match(pageSource, new RegExp(`\\b${field}\\b`, 'u'))

  assert.match(pageSource, /已计费 \/ 计费待定/u)
  assert.match(pageSource, /计费状态未确定的调用/u)
  assert.match(pageSource, /实际净支出/u)
  assert.match(pageSource, /免费额度 \/ 折扣前标价估算/u)
  assert.match(pageSource, /标价成本估算/u)
})

test('figure-four explanation scopes only channel comments to YouTube', async () => {
  const [, , pageSource] = await sources()

  for (const capability of [
    'search_intent',
    'search_post_comments',
    'search_post_detail',
    'youtube_channel_comments',
  ]) assert.match(pageSource, new RegExp(capability, 'u'))

  assert.match(pageSource, /search_intent[\s\S]*?Hub 编排能力/u)
  assert.match(pageSource, /search_post_comments[\s\S]*?通用帖子能力/u)
  assert.match(pageSource, /search_post_detail[\s\S]*?通用帖子能力/u)
  assert.match(pageSource, /youtube_channel_comments[\s\S]*?YouTube 专属/u)
  assert.match(pageSource, /“无等价接口”只能说明不能直接一对一映射/u)
})
