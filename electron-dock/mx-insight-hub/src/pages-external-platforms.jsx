import { useCallback, useEffect, useMemo, useRef } from 'react'
import Chart from 'chart.js/auto'
import {
  ArrowLeft,
  ArrowRight,
  ChartLine,
  CheckCircle,
  CirclesThree,
  Coins,
  Database,
  FlowArrow,
  Globe,
  Key,
  Pulse,
  ShieldCheck,
  Stack,
  Users,
  WarningCircle,
} from '@phosphor-icons/react'
import { adminApi } from './api.js'
import {
  DropdownField,
  EmptyState,
  ErrorState,
  LoadingState,
  MetricCard,
  PageHeading,
  StatusBadge,
  formatDate,
  formatNumber,
  useRemoteData,
  useThemeRevision,
} from './components.jsx'

/*
 * Preferred admin response contract (the readers below also accept the named
 * legacy aliases so a rolling backend upgrade does not blank the console):
 *
 * GET /external-platforms
 * { contractVersion, range, generatedAt, summary, providers: [{ key,
 *   displayName, status, metrics, quota, billing, freshness, circuit }] }
 *
 * GET /external-platforms/:key
 * { contractVersion, range, generatedAt, provider, pipeline, timeSeries,
 *   capabilities, tenants, endpoints, guardrails, costPlan, notes }
 *
 * Rates in the v1 contract are 0..1 ratios. Currency amounts ending in
 * `Minor` are integers in that currency's minor unit; null means unknown.
 */

const RANGE_OPTIONS = [
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
]
const VALID_RANGES = new Set(RANGE_OPTIONS.map((option) => option.value))
const UNKNOWN = '未知'

const PROCESSING_STAGES = [
  {
    key: 'stable-api',
    aliases: ['stable-api', 'stableApi', 'stable_contract', 'request', 'contract'],
    label: '稳定 API 合同',
    description: '校验租户、能力、分页与幂等语义；对外合同不暴露上游身份。',
    icon: Key,
  },
  {
    key: 'protection',
    aliases: ['protection', 'cost_guardrails', 'guardrails', 'admission'],
    label: '准入与调用保护',
    description: '在付费调用前执行额度、重放、异常流量与熔断判断。',
    icon: ShieldCheck,
  },
  {
    key: 'adapter',
    aliases: ['adapter', 'provider_adapter', 'upstreamAdapter', 'provider'],
    label: '版本化上游适配',
    description: '隔离 JustOne 历史接口、参数与响应差异，保留可审计证据。',
    icon: FlowArrow,
  },
  {
    key: 'archive',
    aliases: ['archive', 'data_lineage', 'canonical', 'storage', 'projection'],
    label: '归档与 Canonical',
    description: '原始证据进入 PG，再经 canonical、outbox 投影到检索层。',
    icon: Database,
  },
]

const PROTECTION_DEFINITIONS = [
  {
    key: 'quota-gate',
    aliases: ['quota-gate', 'quotaGate', 'quota', 'budget'],
    label: '额度与调用门禁',
    description: '在上游调用前执行租户授权、窗口额度与并发限制；成本预算单独预测。',
  },
  {
    key: 'idempotency',
    aliases: ['idempotency', 'replay', 'deduplication', 'dedupe'],
    label: '幂等与翻页去重',
    description: '识别安全重放、重复第一页与同一游标，避免重复付费。',
  },
  {
    key: 'circuit-breaker',
    aliases: ['circuit-breaker', 'circuitBreaker', 'circuit', 'retry'],
    label: '熔断与禁止盲重试',
    description: '客户端或上游异常时停止重复派发，歧义付费结果不会自动重试。',
  },
  {
    key: 'freshness-fallback',
    aliases: ['freshness-fallback', 'freshnessFallback', 'freshness', 'fallback'],
    label: '新鲜度与存量回退',
    description: '仅在可解释的新鲜度边界内使用 Hub 已存数据，并标注来源。',
  },
]

const DOCUMENTED_DIFFERENCES = [
  {
    capability: 'search_intent',
    label: '聚合检索',
    scope: 'Hub 编排能力',
    explanation: '它可以组合多个检索步骤，因此不要求 JustOne 存在同名的一对一接口。',
  },
  {
    capability: 'search_post_comments',
    label: '指定原文评论',
    scope: '通用帖子能力',
    explanation: '是否可用应按平台、Provider 与接口版本核验，不能仅凭名称归为 YouTube 问题。',
  },
  {
    capability: 'search_post_detail',
    label: '原文详情',
    scope: '通用帖子能力',
    explanation: '缺少同名上游接口不等于 Hub 无法提供；也可能由搜索、详情补全或已存数据实现。',
  },
  {
    capability: 'youtube_channel_comments',
    label: '频道评论',
    scope: 'YouTube 专属',
    explanation: '这一项才是 YouTube 范围；其差异不应扩大为 JustOne 或全部平台的统一缺口。',
  },
]

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '')
}

function firstRecord(...values) {
  return values.find(isRecord) || {}
}

function firstPopulatedRecord(...values) {
  return values.find((value) => isRecord(value) && Object.keys(value).length > 0) || {}
}

function firstArray(...values) {
  return values.find(Array.isArray) || []
}

function optionalNumber(...values) {
  const value = firstDefined(...values)
  if (value === undefined) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function optionalText(...values) {
  const value = firstDefined(...values)
  return value === undefined ? null : String(value)
}

function ratioToPercent(...values) {
  const value = optionalNumber(...values)
  if (value === null) return null
  return value >= 0 && value <= 1 ? value * 100 : value
}

function sumKnown(...values) {
  const numbers = values.map((value) => optionalNumber(value)).filter((value) => value !== null)
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) : null
}

function normalizeSummary(owner = {}) {
  const raw = firstRecord(owner.summary, owner.metrics, owner.usage, owner.totals, owner)
  const hubRequests = optionalNumber(
    raw.hubRequests,
    raw.hubRequestCount,
    raw.requests,
    owner.hubRequests,
  )
  const upstreamCalls = optionalNumber(
    raw.upstreamCalls,
    raw.actualUpstreamCalls,
    raw.dispatchedCalls,
    raw.upstreamCallCount,
    owner.upstreamCalls,
  )
  const successfulRequests = optionalNumber(
    raw.successfulRequests,
    raw.successfulHubRequests,
    raw.successCount,
    raw.successes,
    raw.committed,
    owner.successfulRequests,
  )
  const reportedPercent = optionalNumber(raw.successRatePercent, owner.successRatePercent)
  const reportedRatio = ratioToPercent(raw.hubSuccessRate, raw.successRate, owner.hubSuccessRate, owner.successRate)
  const successRate = reportedPercent !== null
    ? reportedPercent
    : reportedRatio !== null
      ? reportedRatio
      : hubRequests !== null && hubRequests > 0 && successfulRequests !== null
        ? (successfulRequests / hubRequests) * 100
        : null
  return {
    hubRequests,
    upstreamCalls,
    billedCalls: optionalNumber(raw.billedCalls, raw.chargedCalls, owner.billedCalls),
    indeterminateBillingCalls: optionalNumber(
      raw.indeterminateBillingCalls,
      raw.unknownBillingCalls,
      owner.indeterminateBillingCalls,
    ),
    unusableSuccesses: optionalNumber(
      raw.unusableSuccesses,
      raw.unusableBilledResponses,
      owner.unusableSuccesses,
    ),
    successfulRequests,
    successRate,
    avoidedCalls: optionalNumber(
      raw.avoidedCalls,
      raw.avoidedUpstreamCalls,
      raw.upstreamCallsAvoided,
      raw.savedCalls,
      owner.avoidedCalls,
    ),
  }
}

function normalizeCost(owner = {}) {
  const raw = firstRecord(owner.cost, owner.billing, owner.spend, owner.summary?.cost)
  return {
    actualMinor: optionalNumber(
      raw.actualMinor,
      raw.actualCostMinor,
      owner.actualCostMinor,
    ),
    grossEstimatedMinor: optionalNumber(
      raw.grossEstimatedCostMinor,
      raw.knownCostMinor,
      raw.costMinor,
      owner.grossEstimatedCostMinor,
      owner.knownCostMinor,
      owner.summary?.grossEstimatedCostMinor,
      owner.summary?.knownCostMinor,
    ),
    projectedMonthMinor: optionalNumber(
      raw.projectedMonthMinor,
      raw.projectedMonthlyCostMinor,
      raw.projectedMonthlyMinor,
      raw.monthForecastMinor,
      owner.projectedMonthMinor,
    ),
    monthlyBudgetMinor: optionalNumber(raw.monthlyBudgetMinor, raw.budgetMinor),
    unknownCostCalls: optionalNumber(raw.unknownCostCalls, owner.unknownCostCalls, owner.summary?.unknownCostCalls),
    indeterminateBillingCalls: optionalNumber(
      raw.indeterminateBillingCalls,
      raw.unknownBillingCalls,
      owner.indeterminateBillingCalls,
      owner.summary?.indeterminateBillingCalls,
    ),
    projectedMonthlyCalls: optionalNumber(raw.projectedMonthlyCalls, raw.monthForecastCalls),
    projectedPaidCalls: optionalNumber(raw.projectedPaidCalls),
    currency: optionalText(raw.currency, owner.currency, owner.summary?.currency)?.toUpperCase() || null,
    pricingAsOf: optionalText(raw.pricingAsOf, raw.observedAt, raw.updatedAt),
    pricingSource: optionalText(raw.pricingSource, raw.source),
    confidence: optionalText(raw.confidence),
    recommendation: optionalText(raw.recommendation, raw.plan, raw.guidance),
  }
}

function normalizeQuota(owner = {}) {
  const raw = firstRecord(owner.quota, owner.allowance, owner.freeQuota, owner.summary?.quota)
  return {
    freeLimit: optionalNumber(raw.freeLimit, raw.freeDailyCalls, raw.limit, raw.allowance, raw.freeAllowance),
    used: optionalNumber(raw.used, raw.usedToday, raw.consumed, raw.freeUsed),
    remaining: optionalNumber(raw.remaining, raw.remainingToday, raw.freeRemaining),
    period: optionalText(raw.period, raw.window) || (raw.freeDailyCalls !== undefined ? '每日' : null),
    resetAt: optionalText(raw.resetAt, raw.renewsAt),
    source: optionalText(raw.source, raw.provenance),
    note: optionalText(raw.note, raw.description),
  }
}

function normalizePlatform(raw = {}, fallbackKey = null) {
  const key = optionalText(raw.key, raw.providerKey, raw.provider, raw.id, fallbackKey)?.toLowerCase() || null
  const capabilities = firstArray(raw.capabilities, raw.capabilityMatrix)
  return {
    raw,
    key,
    displayName: optionalText(raw.displayName, raw.name, raw.label) || (key === 'justone' ? 'JustOne' : key) || UNKNOWN,
    description: optionalText(raw.description, raw.summaryText),
    status: optionalText(raw.status, raw.health, raw.state) || 'unknown',
    summary: normalizeSummary(raw),
    cost: normalizeCost(raw),
    quota: normalizeQuota(raw),
    capabilityCount: optionalNumber(raw.capabilityCount, raw.capabilitiesCount)
      ?? (capabilities.length ? capabilities.length : null),
    lastObservedAt: optionalText(
      raw.lastObservedAt,
      raw.freshness?.lastCallAt,
      raw.freshness?.lastSuccessAt,
      raw.observedAt,
      raw.updatedAt,
    ),
  }
}

function collectionFrom(payload) {
  if (Array.isArray(payload)) return payload
  const raw = firstDefined(payload?.items, payload?.platforms, payload?.providers, payload?.data)
  if (Array.isArray(raw)) return raw
  if (isRecord(raw)) {
    return Object.entries(raw).map(([key, value]) => (
      isRecord(value) ? { key, ...value } : { key, displayName: String(value) }
    ))
  }
  return []
}

function normalizeOverview(payload) {
  const root = firstRecord(payload)
  return {
    items: collectionFrom(payload).map((item) => normalizePlatform(item)),
    summary: normalizeSummary(firstRecord(root.summary, root.totals, root.metrics)),
    cost: normalizeCost(firstRecord(root.summary, root)),
    lastObservedAt: optionalText(root.lastObservedAt, root.generatedAt, root.observedAt, root.updatedAt),
  }
}

function normalizeTimeline(root, fallback = {}) {
  return firstArray(
    root.timeSeries,
    root.timeline,
    root.trend,
    root.usageTrend,
    root.series,
    root.buckets,
    fallback.timeSeries,
    fallback.timeline,
  ).map((row, index) => {
    const summary = normalizeSummary(row)
    return {
      key: optionalText(row.bucket, row.timestamp, row.startedAt, row.date) || String(index),
      label: optionalText(row.label, row.bucket, row.timestamp, row.startedAt, row.date) || `#${index + 1}`,
      ...summary,
      costMinor: optionalNumber(row.costMinor, row.knownCostMinor, row.actualCostMinor, row.cost?.actualMinor),
    }
  })
}

function normalizeCapabilities(root, fallback = {}) {
  return firstArray(
    root.capabilities,
    root.capabilityMatrix,
    fallback.capabilities,
    fallback.capabilityMatrix,
  ).map((row, index) => ({
    key: optionalText(row.capability, row.key, row.name, row.operation) || String(index),
    capability: optionalText(row.capability, row.key, row.name, row.operation) || UNKNOWN,
    label: optionalText(row.label, row.displayName),
    hubApiVersion: optionalText(row.hubContractVersion, row.hubApiVersion, row.apiVersion, row.publicVersion),
    upstreamEndpoint: optionalText(row.upstreamEndpoint, row.endpoint, row.path),
    upstreamVersion: optionalText(row.upstreamVersion, row.providerVersion, row.version),
    providerMapping: optionalText(row.providerMapping, row.mapping),
    scope: optionalText(row.scope, row.platforms),
    status: optionalText(row.status, row.state, row.health) || 'unknown',
    mode: optionalText(row.mode, row.deliveryMode, row.availabilityMode),
    fallback: optionalText(row.fallback, row.fallbackMode),
    note: optionalText(row.note, row.description),
    responseContractVersion: optionalText(
      row.responseContractVersion,
      row.contractVersion,
      row.schemaVersion,
    ),
    lastVerifiedAt: optionalText(row.lastVerifiedAt, row.verifiedAt, row.observedAt),
  }))
}

function normalizeTenants(root, fallback = {}) {
  return firstArray(
    root.tenantRankings,
    root.tenants,
    root.topTenants,
    root.usageByTenant,
    fallback.tenantRankings,
    fallback.tenants,
  ).map((row, index) => ({
    key: optionalText(row.tenantId, row.id, row.tenantName, row.name) || String(index),
    tenantId: optionalText(row.tenantId, row.id),
    tenantName: optionalText(row.tenantName, row.name, row.displayName),
    hubRequests: optionalNumber(row.hubRequests, row.requests, row.requestCount),
    upstreamCalls: optionalNumber(row.upstreamCalls, row.actualUpstreamCalls, row.upstreamCallCount),
    successRate: optionalNumber(row.successRatePercent)
      ?? ratioToPercent(row.successRate, row.hubSuccessRate),
    grossEstimatedCostMinor: optionalNumber(
      row.grossEstimatedCostMinor,
      row.knownCostMinor,
      row.cost?.grossEstimatedMinor,
    ),
    share: optionalNumber(row.sharePercent) ?? ratioToPercent(row.share, row.usageShare),
  }))
}

function keyedEvidence(value) {
  if (Array.isArray(value)) {
    return new Map(value.map((item) => [optionalText(item.key, item.name, item.type), item]))
  }
  return new Map(isRecord(value) ? Object.entries(value) : [])
}

function findEvidence(evidence, aliases) {
  for (const alias of aliases) {
    const value = evidence.get(alias)
    if (isRecord(value)) return value
  }
  return {}
}

function derivedGuardrailEvidence(raw, definition) {
  if (!isRecord(raw)) return {}
  if (definition.key === 'idempotency') {
    const replay = optionalNumber(raw.idempotentReplays, raw.idempotentReplay)
    const cache = optionalNumber(raw.freshCacheHits, raw.freshCache)
    const duplicate = optionalNumber(raw.duplicateDispatchesSuppressed, raw.duplicateSuppressed)
    const count = sumKnown(replay, cache, duplicate)
    return count === null ? {} : {
      count,
      description: `幂等重放 ${formatOptionalNumber(replay)}，新鲜缓存 ${formatOptionalNumber(cache)}，重复 dispatch 抑制 ${formatOptionalNumber(duplicate)}。`,
    }
  }
  if (definition.key === 'circuit-breaker') {
    const rejected = optionalNumber(raw.circuitRejections, raw.circuitRejected)
    const unknownOutcomes = optionalNumber(raw.unknownOutcomes)
    const unusable = optionalNumber(raw.unusableBilledResponses, raw.unusableSuccesses)
    const retries = optionalNumber(raw.automaticUpstreamRetries)
    const count = sumKnown(rejected)
    return count === null && unknownOutcomes === null && unusable === null && retries === null ? {} : {
      count,
      description: `熔断拒绝 ${formatOptionalNumber(rejected)}，结果未知 ${formatOptionalNumber(unknownOutcomes)}，已计费但不可用 ${formatOptionalNumber(unusable)}，自动上游重试 ${formatOptionalNumber(retries)}。`,
    }
  }
  if (definition.key === 'freshness-fallback') {
    const fallback = optionalNumber(raw.storedFallbacks, raw.storedFallback)
    return fallback === null ? {} : {
      count: fallback,
      description: `存量回退 ${formatOptionalNumber(fallback)}；最近上游成功 ${displayDate(optionalText(raw.lastUpstreamSuccessAt, raw.lastSuccessAt))}。`,
    }
  }
  return {}
}

function normalizeDetail(payload, requestedKey) {
  const envelope = firstRecord(payload)
  const root = firstRecord(
    isRecord(envelope.platform) ? envelope.platform : null,
    envelope.item,
    envelope.provider,
    envelope,
  )
  const platform = normalizePlatform(root, requestedKey)
  const processing = firstRecord(envelope.processing, root.processing, root.processingChain)
  const stageSource = firstDefined(envelope.pipeline, processing.stages, processing.steps, processing, root.pipeline)
  const stageEvidence = keyedEvidence(stageSource)
  const guardrailSource = firstDefined(
    envelope.guardrails,
    root.guardrails,
    root.protections,
    root.protectionMechanisms,
  )
  const guardrailEvidence = keyedEvidence(guardrailSource)
  return {
    ...platform,
    cost: normalizeCost({ ...root, billing: firstRecord(envelope.costPlan, root.billing) }),
    notes: firstRecord(envelope.notes, root.notes),
    timeline: normalizeTimeline(envelope, root),
    capabilities: normalizeCapabilities(envelope, root),
    tenants: normalizeTenants(envelope, root),
    stages: PROCESSING_STAGES.map((definition) => ({
      ...definition,
      evidence: findEvidence(stageEvidence, definition.aliases),
    })),
    guardrails: PROTECTION_DEFINITIONS.map((definition) => ({
      ...definition,
      evidence: firstPopulatedRecord(
        findEvidence(guardrailEvidence, definition.aliases),
        derivedGuardrailEvidence(guardrailSource, definition),
      ),
    })),
  }
}

function formatOptionalNumber(value) {
  return value === null ? UNKNOWN : formatNumber(value)
}

function formatPercent(value) {
  return value === null ? UNKNOWN : `${Number(value).toFixed(2)}%`
}

function formatMoneyMinor(value, currency) {
  if (value === null) return UNKNOWN
  if (!currency) return `${formatNumber(value)} 最小货币单位`
  try {
    const formatter = new Intl.NumberFormat('zh-CN', { style: 'currency', currency })
    const fractionDigits = formatter.resolvedOptions().maximumFractionDigits
    return formatter.format(value / (10 ** fractionDigits))
  } catch {
    return `${currency} ${formatNumber(value)}（最小货币单位）`
  }
}

function displayDate(value) {
  return value ? formatDate(value) : UNKNOWN
}

function statusLabel(status) {
  const labels = {
    active: '正常',
    ready: '就绪',
    healthy: '健康',
    degraded: '降级',
    disabled: '停用',
    down: '不可用',
    unavailable: '不可用',
    configured: '已配置',
    not_configured: '未配置',
    misconfigured: '配置错误',
    awaiting_verification: '待契约验证',
    circuit_open: '熔断中',
    memory_only: '仅内存',
    implemented: '已实现',
    planned: '规划中',
    supported: '已支持',
    unsupported: '不支持',
    unknown: '未知',
  }
  return labels[String(status || 'unknown').toLowerCase()] || String(status)
}

function Panel({ title, subtitle, action, className = '', children }) {
  return (
    <section className={`qp-panel mih-panel ${className}`.trim()}>
      <header className="mih-panel__header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action ? <div className="mih-page-actions">{action}</div> : null}
      </header>
      {children}
    </section>
  )
}

function Table({ label, children }) {
  return (
    <div className="mih-table-wrap qp-scrollbar">
      <table className="qp-data-table mih-table" aria-label={label}>{children}</table>
    </div>
  )
}

function chartTheme() {
  const styles = getComputedStyle(document.querySelector('.qp-app') || document.documentElement)
  const token = (name, fallback) => styles.getPropertyValue(name).trim() || fallback
  return {
    primary: token('--qp-primary', '#2bf6d2'),
    success: token('--qp-success', '#48bc77'),
    warning: token('--qp-warning', '#f8d06c'),
    info: token('--qp-info', '#5e8eec'),
    archetype: token('--qp-archetype', '#b974ff'),
    text: token('--qp-text-2', 'rgba(226,226,226,.7)'),
    muted: token('--qp-text-3', 'rgba(226,226,226,.5)'),
    line: token('--qp-line', 'rgba(94,142,236,.18)'),
    panel: token('--qp-bg-4', '#292c37'),
  }
}

function useExternalChart(buildConfig, signature) {
  const canvasRef = useRef(null)
  const themeRevision = useThemeRevision()
  useEffect(() => {
    if (!canvasRef.current) return undefined
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const chart = new Chart(canvasRef.current, buildConfig(chartTheme(), reducedMotion))
    return () => chart.destroy()
  }, [buildConfig, signature, themeRevision])
  return canvasRef
}

function UsageTrendChart({ rows }) {
  const signature = JSON.stringify(rows)
  const buildConfig = useCallback((theme, reducedMotion) => {
    const datasets = [
      ['hubRequests', 'Hub 请求', theme.primary],
      ['upstreamCalls', '实际上游调用', theme.info],
      ['avoidedCalls', '避免调用', theme.warning],
    ].filter(([key]) => rows.some((row) => row[key] !== null)).map(([key, label, color]) => ({
      label,
      data: rows.map((row) => row[key]),
      borderColor: color,
      backgroundColor: color,
      borderWidth: 2,
      pointRadius: rows.length > 24 ? 0 : 2,
      pointHoverRadius: 4,
      tension: 0.28,
      spanGaps: true,
    }))
    if (rows.some((row) => row.successRate !== null)) {
      datasets.push({
        label: '成功率',
        data: rows.map((row) => row.successRate),
        yAxisID: 'rate',
        borderColor: theme.archetype,
        backgroundColor: theme.archetype,
        borderDash: [5, 4],
        borderWidth: 2,
        pointRadius: rows.length > 24 ? 0 : 2,
        tension: 0.28,
        spanGaps: true,
      })
    }
    return {
      type: 'line',
      data: { labels: rows.map((row) => row.label), datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reducedMotion ? false : { duration: 220 },
        interaction: { intersect: false, mode: 'index' },
        scales: {
          x: { grid: { display: false }, ticks: { color: theme.muted, maxTicksLimit: 9 } },
          y: { beginAtZero: true, grid: { color: theme.line }, ticks: { color: theme.muted, precision: 0 } },
          rate: {
            display: rows.some((row) => row.successRate !== null),
            position: 'right',
            min: 0,
            max: 100,
            grid: { display: false },
            ticks: { color: theme.archetype, callback: (value) => `${value}%` },
          },
        },
        plugins: {
          legend: { position: 'bottom', labels: { color: theme.text, boxWidth: 9, boxHeight: 9, padding: 14 } },
          tooltip: { backgroundColor: theme.panel, titleColor: theme.text, bodyColor: theme.text },
        },
      },
    }
  }, [rows])
  const ref = useExternalChart(buildConfig, signature)
  const ariaLabel = rows.map((row) => (
    `${row.label}：Hub 请求 ${formatOptionalNumber(row.hubRequests)}，实际上游调用 ${formatOptionalNumber(row.upstreamCalls)}，避免调用 ${formatOptionalNumber(row.avoidedCalls)}，成功率 ${formatPercent(row.successRate)}`
  )).join('；')
  return (
    <div className="mih-external-trend-chart">
      <canvas ref={ref} role="img" aria-label={ariaLabel} />
    </div>
  )
}

function RangeControl({ range, setQuery }) {
  return (
    <DropdownField
      className="mih-filter-field"
      label="统计范围"
      value={range}
      options={RANGE_OPTIONS}
      onChange={(value) => setQuery({ range: value })}
    />
  )
}

function OverviewMetricRail({ overview }) {
  return (
    <section className="mih-external-kpis" aria-label="外部数据平台汇总">
      <MetricCard icon={Globe} label="已登记平台" value={formatNumber(overview.items.length)} hint="当前管理响应" tone="primary" />
      <MetricCard icon={Pulse} label="Hub 请求" value={formatOptionalNumber(overview.summary.hubRequests)} hint="当前统计窗口" tone="info" />
      <MetricCard icon={FlowArrow} label="上游调用" value={formatOptionalNumber(overview.summary.upstreamCalls)} hint="真实付费边界" tone="archetype" />
      <MetricCard icon={ShieldCheck} label="避免调用" value={formatOptionalNumber(overview.summary.avoidedCalls)} hint="未触发上游" tone="success" />
      <MetricCard icon={CheckCircle} label="Hub 成功率" value={formatPercent(overview.summary.successRate)} hint="缺失时不推测" tone="success" />
      <MetricCard icon={Coins} label="标价成本估算" value={formatMoneyMinor(overview.cost.grossEstimatedMinor, overview.cost.currency)} hint="免费额度与折扣前" tone="warning" />
    </section>
  )
}

function ProviderCard({ item, range }) {
  const canOpen = item.key === 'justone'
  return (
    <article className="qp-panel mih-external-provider-card">
      <header>
        <span className="mih-external-provider-card__icon"><Globe size={23} weight="duotone" aria-hidden="true" /></span>
        <div>
          <strong>{item.displayName}</strong>
          <small className="mih-mono">{item.key || UNKNOWN}</small>
        </div>
        <StatusBadge status={item.status} label={statusLabel(item.status)} />
      </header>
      <p>{item.description || '管理接口尚未提供平台说明。'}</p>
      <dl>
        <div><dt>Hub 请求</dt><dd>{formatOptionalNumber(item.summary.hubRequests)}</dd></div>
        <div><dt>上游调用</dt><dd>{formatOptionalNumber(item.summary.upstreamCalls)}</dd></div>
        <div><dt>成功率</dt><dd>{formatPercent(item.summary.successRate)}</dd></div>
        <div><dt>标价成本估算</dt><dd>{formatMoneyMinor(item.cost.grossEstimatedMinor, item.cost.currency)}</dd></div>
      </dl>
      <footer>
        <span>最近观测：{displayDate(item.lastObservedAt)}</span>
        {canOpen ? (
          <a className="qp-button qp-button--outline qp-button--sm" href={`#/external-platforms?provider=justone&range=${encodeURIComponent(range)}`}>
            查看详情<ArrowRight size={14} aria-hidden="true" />
          </a>
        ) : <span className="qp-tag">详情尚未接入</span>}
      </footer>
    </article>
  )
}

function PlatformsOverview({ token, range, setQuery, onUnauthorized }) {
  const load = useCallback(() => adminApi.externalPlatforms(token, { range }), [range, token])
  const remote = useRemoteData(load, onUnauthorized)
  const overview = useMemo(() => normalizeOverview(remote.data), [remote.data])

  return (
    <>
      <PageHeading
        className="mih-command-heading"
        eyebrow="DATA CLEANING CENTER / EXTERNAL PLATFORMS"
        title="外部数据平台"
        description="管理实时上游接口的调用、稳定性、成本与 Hub 数据沉淀；它与定时清洗任务分开观测。"
        loading={remote.loading}
        onRefresh={remote.refresh}
      >
        <RangeControl range={range} setQuery={setQuery} />
      </PageHeading>

      {remote.loading && !remote.data ? <LoadingState label="正在读取外部数据平台" /> : null}
      {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
      {remote.data !== null || (!remote.loading && !remote.error) ? (
        <>
          <OverviewMetricRail overview={overview} />
          <Panel
            title="平台总览"
            subtitle="同一统计口径横向比较；详情仅在管理后端提供真实证据后展示。"
            className="mih-external-provider-panel"
            action={<span className="mih-external-observed">数据观测：{displayDate(overview.lastObservedAt)}</span>}
          >
            {overview.items.length ? (
              <div className="mih-external-provider-grid">
                {overview.items.map((item, index) => (
                  <ProviderCard key={item.key || index} item={item} range={range} />
                ))}
              </div>
            ) : (
              <EmptyState
                icon={Globe}
                title="尚无已登记外部数据平台"
                description="管理接口返回了空集合；这里不会用示例平台或推测指标填充。"
              />
            )}
          </Panel>
        </>
      ) : null}
    </>
  )
}

function DetailMetricRail({ detail }) {
  const quotaDisplay = detail.quota.remaining !== null && detail.quota.freeLimit !== null
    ? `${formatNumber(detail.quota.remaining)} / ${formatNumber(detail.quota.freeLimit)}`
    : detail.quota.remaining !== null
      ? formatNumber(detail.quota.remaining)
      : UNKNOWN
  return (
    <section className="mih-external-kpis mih-external-kpis--detail" aria-label="JustOne 当前窗口指标">
      <MetricCard icon={Pulse} label="Hub 请求" value={formatOptionalNumber(detail.summary.hubRequests)} hint="对外稳定 API" tone="info" />
      <MetricCard icon={FlowArrow} label="实际上游调用" value={formatOptionalNumber(detail.summary.upstreamCalls)} hint="真实调用证据" tone="archetype" />
      <MetricCard icon={CheckCircle} label="Hub 成功率" value={formatPercent(detail.summary.successRate)} hint="按 Hub 结果口径" tone="success" />
      <MetricCard icon={ShieldCheck} label="避免调用" value={formatOptionalNumber(detail.summary.avoidedCalls)} hint="重放、缓存或保护" tone="primary" />
      <MetricCard icon={Coins} label="已计费 / 计费待定" value={`${formatOptionalNumber(detail.summary.billedCalls)} / ${formatOptionalNumber(detail.summary.indeterminateBillingCalls)}`} hint={`上游成功但 Hub 不可用 ${formatOptionalNumber(detail.summary.unusableSuccesses)}`} tone="warning" />
      <MetricCard icon={Coins} label="实际净支出" value={formatMoneyMinor(detail.cost.actualMinor, detail.cost.currency)} hint="无上游账单证据时未知" tone="warning" />
      <MetricCard icon={CirclesThree} label="免费额度剩余" value={quotaDisplay} hint={detail.quota.period || '额度周期未知'} tone="primary" />
    </section>
  )
}

function CostQuotaPanel({ detail }) {
  const { cost, quota } = detail
  const hasProgress = quota.used !== null && quota.freeLimit !== null && quota.freeLimit > 0
  const quotaPercent = hasProgress ? Math.max(0, Math.min(100, (quota.used / quota.freeLimit) * 100)) : null
  return (
    <Panel title="成本与免费额度" subtitle="金额只展示上游或 Hub 计费证据，不从调用量猜测单价。" className="mih-external-cost-panel">
      <dl className="mih-external-facts">
        <div><dt>窗口实际净支出</dt><dd>{formatMoneyMinor(cost.actualMinor, cost.currency)}</dd></div>
        <div><dt>免费额度 / 折扣前标价估算</dt><dd>{formatMoneyMinor(cost.grossEstimatedMinor, cost.currency)}</dd></div>
        <div><dt>预计月度成本</dt><dd>{formatMoneyMinor(cost.projectedMonthMinor, cost.currency)}</dd></div>
        <div><dt>月度预算</dt><dd>{formatMoneyMinor(cost.monthlyBudgetMinor, cost.currency)}</dd></div>
        <div><dt>单价未知的已计费调用</dt><dd>{formatOptionalNumber(cost.unknownCostCalls)}</dd></div>
        <div><dt>计费状态未确定的调用</dt><dd>{formatOptionalNumber(cost.indeterminateBillingCalls)}</dd></div>
        <div><dt>预计月调用 / 付费调用</dt><dd>{formatOptionalNumber(cost.projectedMonthlyCalls)} / {formatOptionalNumber(cost.projectedPaidCalls)}</dd></div>
        <div><dt>免费额度</dt><dd>{formatOptionalNumber(quota.freeLimit)}</dd></div>
        <div><dt>已使用 / 剩余</dt><dd>{formatOptionalNumber(quota.used)} / {formatOptionalNumber(quota.remaining)}</dd></div>
        <div><dt>免费额度周期</dt><dd>{quota.period || UNKNOWN}</dd></div>
      </dl>
      {hasProgress ? (
        <div className="mih-external-quota">
          <span><strong>免费额度使用进度</strong><small>{quotaPercent.toFixed(1)}%</small></span>
          <progress max="100" value={quotaPercent} aria-label={`免费额度已使用 ${quotaPercent.toFixed(1)}%`} />
        </div>
      ) : (
        <p className="mih-external-unknown"><WarningCircle size={16} aria-hidden="true" />免费额度上限或已用量未知，无法计算进度。</p>
      )}
      <div className="mih-external-cost-note">
        <strong>成本规划建议</strong>
        <p>{cost.recommendation || '管理接口尚未提供定价建议；页面不会自行假设免费额度、阶梯价或充值折扣。'}</p>
        <small>
          定价证据：{displayDate(cost.pricingAsOf)} · 定价来源：{cost.pricingSource || UNKNOWN} · 预测置信度：{cost.confidence || UNKNOWN}
        </small>
        <small>额度重置：{displayDate(quota.resetAt)} · 额度来源：{quota.source || UNKNOWN}{quota.note ? ` · ${quota.note}` : ''}</small>
      </div>
    </Panel>
  )
}

function TrendPanel({ detail }) {
  const rows = detail.timeline.filter((row) => (
    row.hubRequests !== null
      || row.upstreamCalls !== null
      || row.avoidedCalls !== null
      || row.successRate !== null
  ))
  return (
    <Panel title="调用趋势" subtitle="Hub 请求、真实上游调用、避免调用与成功率采用相同时间桶。" className="mih-external-trend-panel">
      {rows.length ? <UsageTrendChart rows={rows} /> : (
        <EmptyState icon={ChartLine} title="暂无调用趋势" description="管理接口未返回有数值的时间桶；未知不会绘制为 0。" />
      )}
    </Panel>
  )
}

function ProcessingChain({ stages }) {
  return (
    <Panel title="Hub 四阶段处理链路" subtitle="以下是职责边界；每一阶段的运行状态仍以管理接口证据为准。" className="mih-external-chain-panel">
      <ol className="mih-external-chain">
        {stages.map((stage, index) => {
          const Icon = stage.icon
          const status = optionalText(stage.evidence.status, stage.evidence.state, stage.evidence.health) || 'unknown'
          return (
            <li key={stage.key}>
              <span className="mih-external-chain__index">{String(index + 1).padStart(2, '0')}</span>
              <span className="mih-external-chain__icon"><Icon size={20} weight="duotone" aria-hidden="true" /></span>
              <div>
                <strong>{stage.label}</strong>
                <p>{optionalText(stage.evidence.detail, stage.evidence.description) || stage.description}</p>
                <small>观测：{displayDate(optionalText(stage.evidence.observedAt, stage.evidence.updatedAt))}</small>
              </div>
              <StatusBadge status={status} label={statusLabel(status)} />
              {index < stages.length - 1 ? <ArrowRight className="mih-external-chain__arrow" size={15} aria-hidden="true" /> : null}
            </li>
          )
        })}
      </ol>
    </Panel>
  )
}

function CapabilityMatrix({ capabilities }) {
  return (
    <Panel title="能力与版本矩阵" subtitle="Hub 公共合同与 JustOne 上游接口分栏展示，避免把同名误当等价。" className="mih-external-capability-panel">
      {capabilities.length ? (
        <Table label="JustOne 能力与版本矩阵">
          <thead>
            <tr><th scope="col">Hub 能力</th><th scope="col">公共合同</th><th scope="col">Provider 映射 / 接口</th><th scope="col">适用范围 / 版本</th><th scope="col">状态</th><th scope="col">回退</th><th scope="col">说明</th></tr>
          </thead>
          <tbody>
            {capabilities.map((row) => (
              <tr key={row.key}>
                <td><strong className="mih-mono">{row.capability}</strong>{row.label ? <small>{row.label}</small> : null}</td>
                <td>{row.hubApiVersion || UNKNOWN}</td>
                <td className="mih-mono">{row.upstreamEndpoint || row.providerMapping || UNKNOWN}</td>
                <td><span>{row.scope || UNKNOWN}</span><small>{row.upstreamVersion || UNKNOWN}</small></td>
                <td><StatusBadge status={row.status === 'implemented' ? 'ready' : row.status} label={statusLabel(row.status)} /></td>
                <td className="mih-mono">{row.fallback || UNKNOWN}</td>
                <td>{row.note || (row.responseContractVersion ? `响应合同 ${row.responseContractVersion}` : UNKNOWN)}{row.lastVerifiedAt ? <small>核验：{displayDate(row.lastVerifiedAt)}</small> : null}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState icon={Stack} title="暂无能力矩阵" description="接口未返回能力与版本证据；页面不会从历史文档推断当前支持状态。" />
      )}
    </Panel>
  )
}

function TenantRanking({ tenants, currency }) {
  return (
    <Panel title="租户使用量排名" subtitle="只按当前统计窗口的服务端聚合结果排序，不在浏览器补齐租户身份。" className="mih-external-tenant-panel">
      {tenants.length ? (
        <Table label="JustOne 租户使用量排名">
          <thead><tr><th scope="col">排名</th><th scope="col">租户</th><th scope="col">Hub 请求</th><th scope="col">上游调用</th><th scope="col">成功率</th><th scope="col">标价成本估算</th><th scope="col">占比</th></tr></thead>
          <tbody>
            {tenants.map((row, index) => (
              <tr key={row.key}>
                <td>{index + 1}</td>
                <td><strong>{row.tenantName || row.tenantId || UNKNOWN}</strong>{row.tenantName && row.tenantId ? <small className="mih-mono">{row.tenantId}</small> : null}</td>
                <td>{formatOptionalNumber(row.hubRequests)}</td>
                <td>{formatOptionalNumber(row.upstreamCalls)}</td>
                <td>{formatPercent(row.successRate)}</td>
                <td>{formatMoneyMinor(row.grossEstimatedCostMinor, currency)}</td>
                <td>{formatPercent(row.share)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      ) : (
        <EmptyState icon={Users} title="暂无租户排名" description="管理接口没有返回租户聚合；不会展示猜测名称或虚构用量。" />
      )}
    </Panel>
  )
}

function ProtectionPanel({ guardrails, notes }) {
  return (
    <Panel title="费用与稳定性保护" subtitle="机制名称描述 Hub 应承担的边界；状态和触发次数缺失时明确标为未知。" className="mih-external-protection-panel">
      <div className="mih-external-protections">
        {guardrails.map((guardrail) => {
          const status = optionalText(guardrail.evidence.status, guardrail.evidence.state) || 'unknown'
          const count = optionalNumber(guardrail.evidence.count, guardrail.evidence.triggerCount, guardrail.evidence.hits)
          return (
            <article key={guardrail.key}>
              <header><ShieldCheck size={18} weight="duotone" aria-hidden="true" /><strong>{guardrail.label}</strong><StatusBadge status={status} label={statusLabel(status)} /></header>
              <p>{optionalText(guardrail.evidence.description, guardrail.evidence.detail) || guardrail.description}</p>
              <small>当前窗口触发：{formatOptionalNumber(count)}</small>
            </article>
          )
        })}
      </div>
      {optionalText(notes?.freshness) ? (
        <p className="mih-external-context-note"><Pulse size={16} aria-hidden="true" />{notes.freshness}</p>
      ) : null}
    </Panel>
  )
}

function DifferencePanel() {
  return (
    <Panel title="图 4 合同差异说明" subtitle="这是能力语义判定，不代表当前运行状态；实时支持情况以上方矩阵证据为准。" className="mih-external-difference-panel">
      <div className="mih-external-differences">
        {DOCUMENTED_DIFFERENCES.map((item) => (
          <article key={item.capability}>
            <span className="mih-mono">{item.capability}</span>
            <strong>{item.label}</strong>
            <small>{item.scope}</small>
            <p>{item.explanation}</p>
          </article>
        ))}
      </div>
      <p className="mih-external-difference-note"><WarningCircle size={16} aria-hidden="true" />“无等价接口”只能说明不能直接一对一映射，不能单独证明 Hub 能力缺失。</p>
    </Panel>
  )
}

function PlatformDetail({ token, range, provider, setQuery, onUnauthorized }) {
  const load = useCallback(() => adminApi.externalPlatform(token, provider, { range }), [provider, range, token])
  const remote = useRemoteData(load, onUnauthorized)
  const detail = useMemo(() => normalizeDetail(remote.data, provider), [provider, remote.data])

  return (
    <>
      <PageHeading
        className="mih-command-heading"
        eyebrow="EXTERNAL PLATFORM / JUSTONE"
        title="JustOne 调用与数据保障"
        description="从 Hub 请求到上游付费调用、版本适配、数据归档与成本规划的同一管理视图。"
        loading={remote.loading}
        onRefresh={remote.refresh}
      >
        <a className="qp-button qp-button--ghost" href={`#/external-platforms?range=${encodeURIComponent(range)}`}><ArrowLeft size={15} aria-hidden="true" />平台总览</a>
        <RangeControl range={range} setQuery={setQuery} />
      </PageHeading>

      {remote.loading && !remote.data ? <LoadingState label="正在读取 JustOne 管理证据" /> : null}
      {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
      {remote.data ? (
        <>
          <section className="mih-external-detail-status" aria-label="JustOne 当前状态">
            <span><Globe size={20} weight="duotone" aria-hidden="true" /></span>
            <div><strong>{detail.displayName}</strong><small className="mih-mono">provider={detail.key || provider}</small></div>
            <StatusBadge status={detail.status} label={statusLabel(detail.status)} />
            <small>最近观测：{displayDate(detail.lastObservedAt)}</small>
          </section>
          <DetailMetricRail detail={detail} />
          <section className="mih-external-two-column">
            <TrendPanel detail={detail} />
            <CostQuotaPanel detail={detail} />
          </section>
          <ProcessingChain stages={detail.stages} />
          <CapabilityMatrix capabilities={detail.capabilities} />
          <section className="mih-external-two-column mih-external-two-column--balanced">
            <TenantRanking tenants={detail.tenants} currency={detail.cost.currency} />
            <ProtectionPanel guardrails={detail.guardrails} notes={detail.notes} />
          </section>
          <DifferencePanel />
        </>
      ) : !remote.loading && !remote.error ? (
        <EmptyState
          icon={Globe}
          title="JustOne 详情响应为空"
          description="管理接口没有返回可展示的运行证据；页面不会用默认指标代替。"
          action={<a className="qp-button qp-button--outline" href={`#/external-platforms?range=${encodeURIComponent(range)}`}><ArrowLeft size={15} aria-hidden="true" />返回平台总览</a>}
        />
      ) : null}
    </>
  )
}

function UnsupportedProvider({ provider, range }) {
  return (
    <>
      <PageHeading
        eyebrow="DATA CLEANING CENTER / EXTERNAL PLATFORMS"
        title="外部数据平台"
        description="当前详情路由只接受 provider=justone。"
      />
      <EmptyState
        icon={WarningCircle}
        title="无法识别外部平台"
        description={`provider=${provider} 尚未登记为可打开的详情页。`}
        action={<a className="qp-button qp-button--outline" href={`#/external-platforms?range=${encodeURIComponent(range)}`}><ArrowLeft size={15} aria-hidden="true" />返回平台总览</a>}
      />
    </>
  )
}

export function ExternalPlatformsPage({ token, query, setQuery, onUnauthorized }) {
  const rawRange = query.get('range') || '24h'
  const range = VALID_RANGES.has(rawRange) ? rawRange : '24h'
  const provider = (query.get('provider') || '').trim().toLowerCase()

  if (provider && provider !== 'justone') return <UnsupportedProvider provider={provider} range={range} />
  if (provider === 'justone') {
    return <PlatformDetail token={token} range={range} provider={provider} setQuery={setQuery} onUnauthorized={onUnauthorized} />
  }
  return <PlatformsOverview token={token} range={range} setQuery={setQuery} onUnauthorized={onUnauthorized} />
}
