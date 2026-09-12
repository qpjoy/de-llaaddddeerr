import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import {
  ArrowLeft,
  ArrowRight,
  ChartLine,
  CheckCircle,
  CirclesThree,
  Coins,
  Copy,
  Database,
  Eye,
  EyeSlash,
  FlowArrow,
  Globe,
  Key,
  Pulse,
  ShieldCheck,
  SlidersHorizontal,
  Stack,
  Users,
  WarningCircle,
} from '@phosphor-icons/react'
import { adminApi, publicDocsHref } from './api.js'
import { copyText } from './open-capabilities.js'
import {
  DropdownField,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  MetricCard,
  Modal,
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
 *   capabilities, tenants, endpoints, guardrails, costPlan, credential, notes }
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
const SUPPORTED_PROVIDERS = new Set(['justone', 'tikhub', 'night-all'])
const UNKNOWN = '未知'

// Jump to the control that fixes what you just read.
//
// The console routes on the URL fragment, so an in-page anchor href would
// navigate away instead of scrolling. This moves the viewport and the focus
// ring itself, and flashes the target so it is obvious what was jumped to.
function jumpToControl(elementId) {
  const target = typeof document === 'undefined' ? null : document.getElementById(elementId)
  if (!target) return
  // 'start', not 'center': these targets are tall panels, and centering one
  // puts its heading above the viewport so the operator lands in the middle of
  // a form with no idea what they are looking at. scroll-margin-top keeps the
  // heading clear of the sticky top bar.
  target.scrollIntoView({ behavior: 'smooth', block: 'start' })
  // Focus lands on the panel rather than a field: the operator still has to
  // choose what to change, and stealing the caret into an input would let a
  // stray keystroke edit a price.
  target.focus?.({ preventScroll: true })
  target.classList.add('is-jump-target')
  window.setTimeout(() => target.classList.remove('is-jump-target'), 1600)
}

function FixLink({ target, children }) {
  return (
    <button className="mih-fix-link" type="button" onClick={() => jumpToControl(target)}>
      {children}<ArrowRight size={13} aria-hidden="true" />
    </button>
  )
}

function providerDisplayName(provider) {
  return ({ justone: 'JustOne', tikhub: 'TikHub', 'night-all': 'Night-All' })[provider] || provider || '外部平台'
}

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
    description: '隔离外部平台的接口、参数与响应差异，保留可审计证据。',
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
    description: '在上游调用前执行租户授权、窗口额度与并发限制；成本单独预测，月度财务线只拦截未形成正价钱包 hold 的流量。',
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

const OPERATION_STATE_ACTIONS = [
  { value: 'shadow', label: '校验' },
  { value: 'canary', label: '灰度' },
  { value: 'active', label: '启用', primary: true },
  { value: 'paused', label: '暂停' },
  { value: 'disabled', label: '停用' },
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

function optionalBoolean(...values) {
  const value = firstDefined(...values)
  if (value === true || value === 'true' || value === 1 || value === '1') return true
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return null
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
    unitPrices: firstArray(raw.unitPrices, raw.endpointPrices).map((entry, index) => ({
      endpointKey: optionalText(entry.endpointKey, entry.endpoint, entry.key) || `#${index + 1}`,
      unitCostMinor: optionalNumber(entry.unitCostMinor, entry.priceMinor, entry.costMinor),
    })),
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
    displayName: optionalText(raw.displayName, raw.name, raw.label) || (key ? providerDisplayName(key) : UNKNOWN),
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
  const items = collectionFrom(payload)
    .map((item) => normalizePlatform(item))
    .filter((item) => SUPPORTED_PROVIDERS.has(item.key))
  const primary = items[0]
  const hasAggregateSummary = isRecord(payload?.summary)
  return {
    items,
    summary: hasAggregateSummary ? normalizeSummary(payload) : primary?.summary || normalizeSummary({}),
    cost: hasAggregateSummary ? normalizeCost({ billing: payload.summary }) : primary?.cost || normalizeCost({}),
    lastObservedAt: primary?.lastObservedAt || null,
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

function normalizeEndpointPrices(priceBook = {}) {
  const raw = firstRecord(priceBook.endpointPrices, priceBook.unitCostMinorByEndpoint)
  return Object.fromEntries(Object.entries(raw).map(([endpointKey, value]) => [
    endpointKey,
    optionalNumber(isRecord(value) ? firstDefined(value.unitCostMinor, value.priceMinor) : value),
  ]))
}

function normalizeOperations(root, fallback = {}) {
  return firstArray(root.operations, fallback.operations).map((row, index) => {
    const release = firstRecord(row.release)
    const priceBook = firstRecord(row.priceBook, row.pricing)
    const labels = firstRecord(row.labels)
    const operationKey = optionalText(row.operationKey, row.operation, row.key) || `operation-${index + 1}`
    return {
      operationKey,
      label: optionalText(
        row.label,
        labels['zh-CN'],
        labels.zh,
        labels.displayName,
        row.displayName,
      ) || operationKey,
      controlSource: optionalText(row.controlSource, row.source),
      desiredState: optionalText(row.desiredState, row.desired, row.state) || 'disabled',
      effectiveState: optionalText(row.effectiveState, row.effective, row.status) || 'unknown',
      revision: optionalNumber(row.revision) ?? 0,
      canaryConsumerIds: firstArray(row.canaryConsumerIds, row.canaryConsumers).map(String),
      release: {
        revision: optionalNumber(release.revision, row.releaseRevision),
        status: optionalText(release.status, row.releaseStatus),
        contractVersion: optionalText(release.contractVersion, row.contractVersion),
        endpointKeys: firstArray(release.endpointKeys, row.endpointKeys).map(String),
      },
      priceBook: {
        version: optionalNumber(priceBook.version),
        source: optionalText(priceBook.source),
        status: optionalText(priceBook.status),
        ready: optionalBoolean(priceBook.ready),
        currency: optionalText(priceBook.currency)?.toUpperCase() || null,
        pricingAsOf: optionalText(priceBook.pricingAsOf),
        monthlyBudgetMinor: optionalNumber(priceBook.monthlyBudgetMinor),
        monthlySubsidyBudgetMinor: optionalNumber(priceBook.monthlySubsidyBudgetMinor),
        endpointPrices: normalizeEndpointPrices(priceBook),
      },
      // The cap the gateway actually enforces for this operation, and how much
      // of it is already committed. Distinct from the provider-level cost panel,
      // which reads deployment billing and can read "未知" while this is real.
      budget: isRecord(row.budget) ? {
        budgetMinor: optionalNumber(row.budget.budgetMinor),
        spentMinor: optionalNumber(row.budget.spentMinor),
        remainingMinor: optionalNumber(row.budget.remainingMinor),
        currency: optionalText(row.budget.currency)?.toUpperCase() || null,
        exhausted: optionalBoolean(row.budget.exhausted),
      } : null,
      blockers: firstArray(row.blockers).map((entry, blockerIndex) => (
        isRecord(entry)
          ? {
              key: `${optionalText(entry.code, entry.key) || 'blocker'}:${blockerIndex}`,
              code: optionalText(entry.code, entry.key),
              message: optionalText(entry.message, entry.description) || UNKNOWN,
            }
          : { key: String(blockerIndex), code: null, message: String(entry) }
      )),
      updatedAt: optionalText(row.updatedAt),
      updatedBy: optionalText(row.updatedBy),
    }
  })
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
  const rawCredential = firstRecord(envelope.credential, root.credential)
  return {
    ...platform,
    credential: {
      source: optionalText(
        rawCredential.source,
        envelope.credentialSource,
        root.credentialSource,
      ),
      revision: optionalNumber(
        rawCredential.revision,
        envelope.credentialRevision,
        root.credentialRevision,
      ),
      credentialConfigured: optionalBoolean(
        rawCredential.credentialConfigured,
        rawCredential.keyConfigured,
        envelope.credentialConfigured,
        envelope.keyConfigured,
        root.credentialConfigured,
        root.keyConfigured,
      ),
      revealable: optionalBoolean(
        rawCredential.revealable,
        envelope.credentialRevealable,
        root.credentialRevealable,
      ),
      updatedAt: optionalText(
        rawCredential.updatedAt,
        envelope.credentialUpdatedAt,
        root.credentialUpdatedAt,
      ),
    },
    cost: normalizeCost({ ...root, billing: firstRecord(envelope.costPlan, root.billing) }),
    notes: firstRecord(envelope.notes, root.notes),
    timeline: normalizeTimeline(envelope, root),
    capabilities: normalizeCapabilities(envelope, root),
    tenants: normalizeTenants(envelope, root),
    operations: normalizeOperations(envelope, root),
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
    shadow: '校验中',
    canary: '灰度中',
    paused: '已暂停',
    blocked: '已阻断',
    reviewed: '已复核',
    inherited: '继承环境配置',
    incomplete: '证据不完整',
    memory_only: '仅内存',
    implemented: '已实现',
    planned: '规划中',
    supported: '已支持',
    unsupported: '不支持',
    unknown: '未知',
  }
  return labels[String(status || 'unknown').toLowerCase()] || String(status)
}

function Panel({ title, subtitle, action, className = '', id = null, children }) {
  return (
    <section className={`qp-panel mih-panel ${className}`.trim()} id={id || undefined} tabIndex={id ? -1 : undefined}>
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
  const canOpen = SUPPORTED_PROVIDERS.has(item.key)
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
          <a className="qp-button qp-button--outline qp-button--sm" href={`#/external-platforms?provider=${encodeURIComponent(item.key)}&range=${encodeURIComponent(range)}`}>
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

function credentialSourceLabel(source) {
  const labels = {
    database: '数据库',
    environment: '环境变量',
    none: '未配置',
  }
  return labels[source] || source || UNKNOWN
}

function ExternalPlatformCredentialRevealModal({
  token,
  provider,
  onClose,
  onUnauthorized,
  notify,
}) {
  const providerName = providerDisplayName(provider)
  const [adminToken, setAdminToken] = useState('')
  const [revealedApiKey, setRevealedApiKey] = useState('')
  const [revealedVisible, setRevealedVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const clearAndClose = useCallback(() => {
    setAdminToken('')
    setRevealedApiKey('')
    setRevealedVisible(false)
    setError(null)
    onClose()
  }, [onClose])

  const reveal = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setRevealedApiKey('')
    setRevealedVisible(false)
    try {
      const result = await adminApi.revealExternalPlatformCredential(token, provider, adminToken)
      if (typeof result?.apiKey !== 'string' || !result.apiKey) {
        throw new Error('管理接口未返回可显示的 API Key')
      }
      setRevealedApiKey(result.apiKey)
      setAdminToken('')
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
    } finally {
      setBusy(false)
    }
  }

  const copyRevealedApiKey = async () => {
    const copied = await copyText(revealedApiKey)
    notify?.(
      copied ? `${providerName} API Key 已复制` : '无法访问剪贴板，请手动选择复制',
      copied ? 'success' : 'danger',
    )
  }

  return (
    <Modal
      title={`查看 ${providerName} API Key`}
      description="这是唯一会返回明文 Key 的管理操作；请重新输入 Hub Admin Token。明文只保留在此弹窗，响应禁止缓存。"
      onClose={clearAndClose}
      busy={busy}
      size="small"
      footer={<button className="qp-button qp-button--ghost" type="button" onClick={clearAndClose} disabled={busy}>关闭并清除</button>}
    >
      {!revealedApiKey ? (
        <form className="mih-external-secret-modal" onSubmit={reveal}>
          <Field label="重新输入 Admin Token" hint="Launcher Token 和普通 API Key 都不能查看平台密钥。">
            <input
              className="qp-input"
              type="password"
              autoComplete="off"
              value={adminToken}
              onChange={(event) => setAdminToken(event.target.value)}
              autoFocus
              required
            />
          </Field>
          {error ? <ErrorState error={error} /> : null}
          <button className="qp-button qp-button--primary" type="submit" disabled={busy || !adminToken}>
            <Key size={16} aria-hidden="true" />{busy ? '正在验证' : '验证并读取'}
          </button>
        </form>
      ) : (
        <div className="mih-external-secret-modal">
          <Field label="API Key" hint="关闭弹窗后立即从组件状态中清除；请勿截图或粘贴到日志。">
            <span className="qp-input-group mih-external-secret-input">
              <input
                className="qp-input mih-mono"
                type={revealedVisible ? 'text' : 'password'}
                readOnly
                value={revealedApiKey}
                autoComplete="off"
              />
              <button
                className="qp-button qp-button--ghost qp-icon-button"
                type="button"
                aria-label={revealedVisible ? `隐藏 ${providerName} API Key` : `显示 ${providerName} API Key`}
                aria-pressed={revealedVisible}
                onClick={() => setRevealedVisible((visible) => !visible)}
              >
                {revealedVisible ? <EyeSlash size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </span>
          </Field>
          <button className="qp-button qp-button--outline" type="button" onClick={copyRevealedApiKey}>
            <Copy size={16} aria-hidden="true" />复制到剪贴板
          </button>
        </div>
      )}
    </Modal>
  )
}

function ExternalPlatformCredentialPanel({
  token,
  provider,
  credential,
  onSaved,
  onUnauthorized,
  notify,
}) {
  const providerName = providerDisplayName(provider)
  const [apiKey, setApiKey] = useState('')
  const [apiKeyVisible, setApiKeyVisible] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [revealing, setRevealing] = useState(false)
  const isEnvironment = credential.source === 'environment'
  const hasEnvironmentCredential = isEnvironment && credential.credentialConfigured === true
  const canReveal = credential.credentialConfigured === true && credential.revealable === true
  const keyStatus = credential.credentialConfigured === true
    ? 'active'
    : credential.credentialConfigured === false ? 'disabled' : 'unknown'

  useEffect(() => {
    setApiKey('')
    setApiKeyVisible(false)
    setError(null)
    setRevealing(false)
  }, [provider])

  const save = async (event) => {
    event.preventDefault()
    const submittedApiKey = apiKey.trim()
    if (!submittedApiKey) return
    setSaving(true)
    setError(null)
    try {
      await adminApi.updateExternalPlatformCredential(token, provider, {
        apiKey: submittedApiKey,
        expectedRevision: Number.isInteger(credential.revision) ? credential.revision : 0,
      })
      setApiKey('')
      setApiKeyVisible(false)
      notify?.(
        hasEnvironmentCredential ? `${providerName} API Key 已迁移到数据库来源` : `${providerName} API Key 已保存`,
        'success',
      )
      onSaved?.()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
      notify?.(requestError?.message || `${providerName} API Key 保存失败`, 'danger')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      id="external-credential"
      title="API Key 管理"
      subtitle="密钥写入数据库来源；普通详情响应只返回配置状态，不返回明文。"
      className="mih-external-credential-panel"
      action={<StatusBadge status={keyStatus} label={credential.credentialConfigured === null ? '状态未知' : credential.credentialConfigured ? 'Key 已配置' : 'Key 未配置'} />}
    >
      <div className="mih-external-credential-layout">
        <dl className="mih-external-facts">
          <div><dt>当前来源</dt><dd>{credentialSourceLabel(credential.source)}</dd></div>
          <div><dt>配置版本</dt><dd>{formatOptionalNumber(credential.revision)}</dd></div>
          <div><dt>可安全查看</dt><dd>{credential.revealable === null ? UNKNOWN : credential.revealable ? '需二次验证' : '不可查看'}</dd></div>
          <div><dt>最近更新</dt><dd>{displayDate(credential.updatedAt)}</dd></div>
        </dl>
        <form className="mih-external-credential-form" onSubmit={save}>
          <Field
            label={hasEnvironmentCredential ? '重输 API Key 并迁移' : credential.credentialConfigured ? '替换 API Key' : '录入 API Key'}
            hint="输入框永不回填已有密钥；保存成功后立即清空。"
          >
            <span className="qp-input-group mih-external-secret-input">
              <input
                className="qp-input mih-mono"
                type={apiKeyVisible ? 'text' : 'password'}
                autoComplete="new-password"
                maxLength="4096"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={`输入新的 ${providerName} API Key`}
                disabled={saving}
                required
              />
              <button
                className="qp-button qp-button--ghost qp-icon-button"
                type="button"
                aria-label={apiKeyVisible ? '隐藏待保存的 API Key' : '显示待保存的 API Key'}
                aria-pressed={apiKeyVisible}
                onClick={() => setApiKeyVisible((visible) => !visible)}
                disabled={saving || !apiKey}
              >
                {apiKeyVisible ? <EyeSlash size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
              </button>
            </span>
          </Field>
          <div className="mih-external-credential-actions">
            <button className="qp-button qp-button--primary" type="submit" disabled={saving || !apiKey.trim()}>
              <Key size={16} aria-hidden="true" />{saving ? '正在保存' : '保存到数据库'}
            </button>
            <button className="qp-button qp-button--outline" type="button" disabled={saving || !canReveal} onClick={() => setRevealing(true)}>
              <Eye size={16} aria-hidden="true" />查看 / 复制
            </button>
          </div>
          {error ? <ErrorState error={error} /> : null}
        </form>
      </div>
      {hasEnvironmentCredential ? (
        <p className="mih-external-unknown"><WarningCircle size={16} aria-hidden="true" />当前 Key 来自环境变量，Hub 不会通过管理接口读取或显示它。请重新输入并保存，以迁移到数据库来源。</p>
      ) : (
        <p className="mih-external-context-note"><ShieldCheck size={16} aria-hidden="true" />只有数据库来源的 Key 可在重新验证 Admin Token 后查看；列表、统计和普通详情不会返回明文。</p>
      )}
      {revealing ? (
        <ExternalPlatformCredentialRevealModal
          token={token}
          provider={provider}
          onUnauthorized={onUnauthorized}
          notify={notify}
          onClose={() => setRevealing(false)}
        />
      ) : null}
    </Panel>
  )
}

function operationControlSourceLabel(source) {
  const labels = {
    database: '数据库热更新',
    legacy_environment: '环境变量兼容',
  }
  return labels[source] || source || UNKNOWN
}

const BUDGET_MODES = [
  { value: 'minor', label: '按金额 · 最小货币单位' },
  { value: 'calls', label: '按调用次数' },
]

function initialOperationPriceDraft(operation) {
  return {
    currency: operation.priceBook.currency || 'CNY',
    pricingAsOf: operation.priceBook.pricingAsOf || '',
    // The control plane stores a money ceiling, so a reopened form shows what
    // is stored and round-trips it exactly. Switching to calls is a deliberate
    // act by whoever is editing.
    budgetMode: 'minor',
    monthlyBudgetMinor: operation.priceBook.monthlyBudgetMinor ?? '',
    monthlySubsidyBudgetMinor: operation.priceBook.monthlySubsidyBudgetMinor ?? '',
    endpointPrices: Object.fromEntries(operation.release.endpointKeys.map((endpointKey) => [
      endpointKey,
      operation.priceBook.endpointPrices[endpointKey] ?? '',
    ])),
  }
}

function parseMinorUnit(value, label, { positive = false } = {}) {
  const normalized = String(value).trim()
  if (!/^\d+$/u.test(normalized)) {
    throw new Error(`${label}必须是不含小数的最小货币单位整数`)
  }
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || (positive ? parsed <= 0 : parsed < 0)) {
    throw new Error(`${label}必须是${positive ? '大于 0 的' : '非负'}安全整数`)
  }
  return parsed
}

function parseCallCount(value, label) {
  const normalized = String(value).trim()
  if (!/^\d+$/u.test(normalized)) throw new Error(`${label}必须是不含小数的调用次数`)
  const parsed = Number(normalized)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label}必须是非负安全整数`)
  }
  return parsed
}

// A call budget has to hold whichever endpoint the call lands on, so it is
// priced at the most expensive one. The prices used are the ones in this form,
// not the stored ones: editing a price and a budget together must convert with
// the price actually being submitted.
function budgetMinorFromDraft(draft, label, unitCostMinorByEndpoint) {
  const stated = draft.budgetMode === 'calls'
    ? draft[`${label.field}Calls`] ?? draft[label.field]
    : draft[label.field]
  if (draft.budgetMode !== 'calls') return parseMinorUnit(stated, label.text)
  const prices = Object.values(unitCostMinorByEndpoint)
  if (prices.length === 0) throw new Error('按次数换算前必须先填写每个 endpoint 的单次价格')
  return parseCallCount(stated, label.text) * Math.max(...prices)
}

function operationPriceBookPayload(draft, endpointKeys) {
  const currency = draft.currency.trim().toUpperCase()
  const pricingAsOf = draft.pricingAsOf.trim()
  if (!/^[A-Z]{3}$/u.test(currency)) throw new Error('币种必须是 3 位 ISO 代码，例如 CNY')
  if (!pricingAsOf || Number.isNaN(Date.parse(pricingAsOf))) {
    throw new Error('请填写有效的定价证据日期')
  }
  const unitCostMinorByEndpoint = Object.fromEntries(endpointKeys.map((endpointKey) => [
    endpointKey,
    parseMinorUnit(draft.endpointPrices[endpointKey], `${endpointKey} 单次价格`, { positive: true }),
  ]))
  return {
    currency,
    pricingAsOf,
    // The wire contract is always minor units; the call notation is an input
    // convenience that never reaches the control plane.
    monthlyBudgetMinor: budgetMinorFromDraft(
      draft, { field: 'monthlyBudgetMinor', text: '月度上游预算' }, unitCostMinorByEndpoint,
    ),
    monthlySubsidyBudgetMinor: budgetMinorFromDraft(
      draft, { field: 'monthlySubsidyBudgetMinor', text: '月度补贴预算' }, unitCostMinorByEndpoint,
    ),
    unitCostMinorByEndpoint,
  }
}

function ExternalPlatformOperationCard({
  token,
  provider,
  operation,
  onSaved,
  onUnauthorized,
  notify,
}) {
  const [reason, setReason] = useState('')
  const [canaryConsumerIds, setCanaryConsumerIds] = useState(operation.canaryConsumerIds.join('\n'))
  const [publishPriceBook, setPublishPriceBook] = useState(false)
  const [priceDraft, setPriceDraft] = useState(() => initialOperationPriceDraft(operation))
  // Operators reason in calls and the provider bills in calls, but the control
  // plane stores a money ceiling. Show both so a budget can be set without
  // doing the arithmetic by hand, and priced at the most expensive endpoint
  // because a call budget must hold whichever one is hit.
  // Whichever unit is being typed, show the other one. The conversion uses the
  // prices in this form so editing a price and a budget together stays honest.
  const budgetHint = (value) => {
    const prices = operation.release.endpointKeys
      .map((endpointKey) => Number(priceDraft.endpointPrices[endpointKey]))
      .filter((price) => Number.isFinite(price) && price > 0)
    const entered = Number(value)
    if (prices.length === 0) return '填写每个 endpoint 的单次价格后显示换算'
    if (!Number.isFinite(entered) || entered <= 0) {
      return priceDraft.budgetMode === 'calls' ? '填写调用次数' : '填写金额'
    }
    const highest = Math.max(...prices)
    return priceDraft.budgetMode === 'calls'
      ? `= ${(entered * highest).toLocaleString('zh-CN')} 最小货币单位（按最高单价 ${highest} 计）`
      : `≈ ${Math.floor(entered / highest).toLocaleString('zh-CN')} 次调用（按最高单价 ${highest} 计）`
  }
  const budgetUnitLabel = priceDraft.budgetMode === 'calls' ? '调用次数' : '最小货币单位'
  const [busyState, setBusyState] = useState(null)
  const [error, setError] = useState(null)
  const busy = busyState !== null
  const activationNeedsPriceBook = operation.priceBook.ready === false

  const updatePriceDraft = (field, value) => {
    setPriceDraft((current) => ({ ...current, [field]: value }))
  }

  const updateEndpointPrice = (endpointKey, value) => {
    setPriceDraft((current) => ({
      ...current,
      endpointPrices: { ...current.endpointPrices, [endpointKey]: value },
    }))
  }

  // Exactly what is stopping the action buttons right now, in the order an
  // operator would fix them.
  const preconditionId = `operation-precondition-${operation.operationKey}`
  const actionBlockers = []
  if (!reason.trim()) actionBlockers.push('请先填写「变更原因」，所有状态按钮才可用（它会写入审计事件）')
  if (activationNeedsPriceBook && !publishPriceBook) {
    actionBlockers.push('「启用」「灰度」还需勾选“随本次变更发布经复核的上游价格表”并录入价目')
  }

  const submit = async (event) => {
    event.preventDefault()
    const desiredState = event.nativeEvent.submitter?.dataset?.state
    if (!OPERATION_STATE_ACTIONS.some((action) => action.value === desiredState)) return
    const submittedReason = reason.trim()
    if (!submittedReason) {
      setError(new Error('请先填写本次状态变更原因'))
      return
    }
    const submittedCanaryIds = canaryConsumerIds
      .split(/[\s,;]+/u)
      .map((value) => value.trim())
      .filter(Boolean)
    if (desiredState === 'canary' && submittedCanaryIds.length === 0) {
      setError(new Error('灰度状态至少需要一个下游 Consumer UUID'))
      return
    }

    setBusyState(desiredState)
    setError(null)
    try {
      const body = {
        expectedRevision: operation.revision,
        desiredState,
        reason: submittedReason,
        canaryConsumerIds: desiredState === 'canary' ? submittedCanaryIds : null,
        ...(publishPriceBook ? {
          priceBook: operationPriceBookPayload(priceDraft, operation.release.endpointKeys),
        } : {}),
      }
      await adminApi.updateExternalPlatformOperationPolicy(
        token,
        provider,
        operation.operationKey,
        body,
      )
      setReason('')
      notify?.(`${operation.label}已切换为${statusLabel(desiredState)}`, 'success')
      onSaved?.()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
      notify?.(requestError?.message || `${operation.label}状态更新失败`, 'danger')
    } finally {
      setBusyState(null)
    }
  }

  return (
    <form
      className="mih-external-operation-card"
      id={`operation-${operation.operationKey}`}
      tabIndex={-1}
      onSubmit={submit}
    >
      <header>
        <div>
          <strong>{operation.label}</strong>
          <small className="mih-mono">{operation.operationKey}</small>
        </div>
        <StatusBadge status={operation.effectiveState} label={`生效：${statusLabel(operation.effectiveState)}`} />
      </header>

      <dl className="mih-external-operation-facts">
        <div><dt>期望状态</dt><dd>{statusLabel(operation.desiredState)}</dd></div>
        <div><dt>策略修订</dt><dd>#{formatOptionalNumber(operation.revision)}</dd></div>
        <div><dt>控制来源</dt><dd>{operationControlSourceLabel(operation.controlSource)}</dd></div>
        <div><dt>发布 / 价格版本</dt><dd>#{formatOptionalNumber(operation.release.revision)} / #{formatOptionalNumber(operation.priceBook.version)}</dd></div>
        <div><dt>价格表来源 / 状态</dt><dd>{operationControlSourceLabel(operation.priceBook.source)} / {statusLabel(operation.priceBook.status)}</dd></div>
        <div><dt>上游合同版本</dt><dd>{operation.release.contractVersion || UNKNOWN}</dd></div>
        {/* The number that actually refuses calls. Readiness above can say
            "可调用" while this is spent, which is precisely the gap that made
            external_platform_cost_budget_exhausted look inexplicable. */}
        <div>
          <dt>月度上游预算 已用 / 上限</dt>
          <dd className={operation.budget?.exhausted ? 'mih-external-budget--spent' : undefined}>
            {operation.budget && operation.budget.budgetMinor !== null
              ? `${formatMoneyMinor(operation.budget.spentMinor, operation.budget.currency)} / ${formatMoneyMinor(operation.budget.budgetMinor, operation.budget.currency)}`
              : UNKNOWN}
          </dd>
        </div>
      </dl>

      {operation.budget?.exhausted ? (
        <div className="mih-external-operation-blockers" role="status">
          <strong><WarningCircle size={16} aria-hidden="true" />月度上游预算已用完</strong>
          <ul>
            <li>
              <code className="mih-mono">external_platform_cost_budget_exhausted</code>
              <span>
                未计费流量会被拒绝；已按次计费的请求不受此上限限制。
                本月已用 {formatMoneyMinor(operation.budget.spentMinor, operation.budget.currency)}，
                上限 {formatMoneyMinor(operation.budget.budgetMinor, operation.budget.currency)}。
                在下方勾选“发布新价目表”后提高月度上游预算即可恢复。
              </span>
            </li>
          </ul>
        </div>
      ) : null}

      {operation.blockers.length ? (
        <div className="mih-external-operation-blockers" role="status">
          <strong><WarningCircle size={16} aria-hidden="true" />当前阻断项</strong>
          <ul>
            {operation.blockers.map((blocker) => (
              <li key={blocker.key}>
                {blocker.code ? <span className="mih-mono">{blocker.code}</span> : null}
                <span>{blocker.message}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mih-external-operation-ready"><CheckCircle size={16} aria-hidden="true" />当前没有上游运行阻断项</p>
      )}

      <div className="mih-external-operation-inputs">
        <Field label="变更原因" hint="必填；与修订号一起写入审计事件。">
          <input
            className="qp-input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength="1000"
            placeholder="例如：已复核 2026-09 价格，开启线上调用"
            disabled={busy}
            required
          />
        </Field>
        <Field label="灰度 Consumer UUID" hint="多个 UUID 用换行、空格或逗号分隔；仅“灰度”操作提交。">
          <textarea
            className="qp-input mih-external-operation-canary"
            value={canaryConsumerIds}
            onChange={(event) => setCanaryConsumerIds(event.target.value)}
            placeholder="00000000-0000-4000-8000-000000000000"
            disabled={busy}
            rows="2"
          />
        </Field>
      </div>

      <label className="mih-external-operation-price-toggle">
        <input
          type="checkbox"
          checked={publishPriceBook}
          onChange={(event) => setPublishPriceBook(event.target.checked)}
          disabled={busy}
        />
        <span>随本次变更发布经复核的上游价格表</span>
        <small>{activationNeedsPriceBook ? '当前价格证据不完整；启用或灰度前请勾选并录入。' : '如需更新价格证据，勾选后与策略一次发布。'}当环境变量中没有价格时，在此录入后可直接启用，无需手工 SQL。</small>
      </label>

      <div className="mih-external-operation-price-grid" aria-label={`${operation.label}上游价格表`}>
        <Field label="币种">
          <input
            className="qp-input mih-mono"
            value={priceDraft.currency}
            onChange={(event) => updatePriceDraft('currency', event.target.value.toUpperCase())}
            maxLength="3"
            pattern="[A-Za-z]{3}"
            disabled={busy || !publishPriceBook}
            required={publishPriceBook}
          />
        </Field>
        <Field label="定价证据日期">
          <input
            className="qp-input mih-mono"
            type="date"
            value={priceDraft.pricingAsOf.slice(0, 10)}
            onChange={(event) => updatePriceDraft('pricingAsOf', event.target.value)}
            disabled={busy || !publishPriceBook}
            required={publishPriceBook}
          />
        </Field>
        <DropdownField
          label="预算填写单位"
          hint="按次数填写时提交前会用本表单的最高单价换算成金额；控制平面始终存储金额。"
          value={priceDraft.budgetMode}
          options={BUDGET_MODES}
          onChange={(value) => updatePriceDraft('budgetMode', value)}
          disabled={busy || !publishPriceBook}
        />
        <Field label={`月度上游预算（${budgetUnitLabel}）`} hint={budgetHint(priceDraft.monthlyBudgetMinor)}>
          <input
            className="qp-input mih-mono"
            type="number"
            min="0"
            step="1"
            value={priceDraft.monthlyBudgetMinor}
            onChange={(event) => updatePriceDraft('monthlyBudgetMinor', event.target.value)}
            disabled={busy || !publishPriceBook}
            required={publishPriceBook}
          />
        </Field>
        <Field label={`月度补贴预算（${budgetUnitLabel}）`} hint={budgetHint(priceDraft.monthlySubsidyBudgetMinor)}>
          <input
            className="qp-input mih-mono"
            type="number"
            min="0"
            step="1"
            value={priceDraft.monthlySubsidyBudgetMinor}
            onChange={(event) => updatePriceDraft('monthlySubsidyBudgetMinor', event.target.value)}
            disabled={busy || !publishPriceBook}
            required={publishPriceBook}
          />
        </Field>
        {operation.release.endpointKeys.map((endpointKey) => (
          <Field
            key={endpointKey}
            className="mih-external-operation-endpoint-price"
            label={`${endpointKey} 单次价格`}
            hint="必须大于 0；与这个上游 endpoint 精确绑定。"
          >
            <input
              className="qp-input mih-mono"
              type="number"
              min="1"
              step="1"
              value={priceDraft.endpointPrices[endpointKey] ?? ''}
              onChange={(event) => updateEndpointPrice(endpointKey, event.target.value)}
              disabled={busy || !publishPriceBook}
              required={publishPriceBook}
            />
          </Field>
        ))}
      </div>

      {error ? <ErrorState error={error} /> : null}
      {/* A disabled button that does not say why is indistinguishable from a
          broken one. These preconditions are real -- the reason is written into
          the audit event, and activation needs reviewed price evidence -- so
          they are stated next to the controls they block rather than left for
          the operator to infer from a button that simply does not respond. */}
      {actionBlockers.length ? (
        <p className="mih-external-operation-precondition" id={preconditionId} role="status">
          <WarningCircle size={15} aria-hidden="true" />
          {actionBlockers.join('；')}
        </p>
      ) : null}
      <footer className="mih-external-operation-actions">
        {OPERATION_STATE_ACTIONS.map((action) => {
          const needsPriceBook = ['active', 'canary'].includes(action.value)
            && activationNeedsPriceBook
            && !publishPriceBook
          const blocked = !reason.trim() || needsPriceBook
          return (
            <button
              key={action.value}
              className={`qp-button ${action.primary ? 'qp-button--primary' : 'qp-button--outline'}`}
              type="submit"
              data-state={action.value}
              aria-pressed={operation.desiredState === action.value}
              aria-describedby={blocked ? preconditionId : undefined}
              title={needsPriceBook && reason.trim() ? '启用或灰度前需勾选并录入经复核的价目表' : undefined}
              disabled={busy || blocked}
            >
              {busyState === action.value ? '正在更新' : action.label}
            </button>
          )
        })}
      </footer>
    </form>
  )
}

// Pricing for the whole provider, in one place.
//
// A provider quotes one rate and one monthly commitment; per-operation pricing
// is the exception. Putting the common case here means an operator sets it once
// instead of retyping it into every operation -- which is how a deployment ends
// up with one operation left on a zero budget, refusing calls for no visible
// reason.
function ExternalPlatformProviderPriceBook({ token, provider, operations, onSaved, onUnauthorized, notify }) {
  const priced = operations.find((operation) => operation.priceBook.monthlyBudgetMinor !== null)
  // Prefilled from what is already configured, so the common case is reviewing
  // a number rather than hunting for it. Only an unambiguous price is offered:
  // if endpoints are priced differently there is no single value to suggest,
  // and guessing one would quietly reprice the others on submit.
  const configuredPrices = [...new Set(
    operations.flatMap((operation) => Object.values(operation.priceBook.endpointPrices || {}))
      .filter((value) => Number.isFinite(value) && value > 0),
  )]
  const [draft, setDraft] = useState(() => ({
    currency: priced?.priceBook.currency || 'CNY',
    pricingAsOf: (priced?.priceBook.pricingAsOf || new Date().toISOString()).slice(0, 10),
    budgetMode: 'calls',
    unitCostMinor: configuredPrices.length === 1 ? String(configuredPrices[0]) : '',
    monthlyBudgetStated: '',
    monthlySubsidyBudgetStated: '',
    reason: '',
  }))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const update = (field, value) => setDraft((current) => ({ ...current, [field]: value }))
  const unitCost = Number(draft.unitCostMinor)
  const budgetPreview = draft.budgetMode === 'calls' && Number.isSafeInteger(unitCost) && unitCost > 0
    && Number(draft.monthlyBudgetStated) > 0
    ? `= ${formatNumber(Number(draft.monthlyBudgetStated) * unitCost)} 最小货币单位`
    : null

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      // The call notation is an input convenience and never reaches the wire:
      // the control plane stores money, and the whole admin API states budgets
      // in minor units. Converting here uses the unit price being submitted in
      // this same form, so the two can never disagree.
      const unitCostMinor = Number(draft.unitCostMinor)
      const toMinor = (stated) => (draft.budgetMode === 'calls'
        ? Number(stated) * unitCostMinor
        : Number(stated))
      const data = await adminApi.updateExternalPlatformPriceBook(token, provider, {
        currency: draft.currency.trim().toUpperCase(),
        pricingAsOf: draft.pricingAsOf,
        unitCostMinor,
        monthlyBudgetMinor: toMinor(draft.monthlyBudgetStated),
        monthlySubsidyBudgetMinor: toMinor(draft.monthlySubsidyBudgetStated),
        reason: draft.reason.trim(),
      })
      setResult(data)
      setDraft((current) => ({ ...current, reason: '' }))
      notify?.(`已统一录入 ${data.applied.length} 个业务操作的价目表`, 'success')
      onSaved?.()
    } catch (requestError) {
      if (requestError?.status === 401) onUnauthorized?.(requestError)
      setError(requestError)
      notify?.(requestError?.message || '统一价目表发布失败', 'danger')
    } finally {
      setBusy(false)
    }
  }

  // Named individually: telling someone to fill a field they already filled is
  // how a form trains people to stop reading its warnings.
  const missing = []
  if (!(Number(draft.unitCostMinor) > 0)) missing.push('每次调用单价')
  if (!(Number(draft.monthlyBudgetStated) >= 0) || draft.monthlyBudgetStated === '') missing.push('月度上游预算')
  if (!(Number(draft.monthlySubsidyBudgetStated) >= 0) || draft.monthlySubsidyBudgetStated === '') missing.push('月度补贴预算')
  if (!draft.reason.trim()) missing.push('变更原因')
  const incomplete = missing.length > 0

  return (
    <Panel
      id="external-price-book"
      title="统一采购价目与预算"
      subtitle="一次录入，应用到该供应方的全部业务操作。个别操作需要单独收紧或放宽时，再到下面对应的操作里改。"
      className="mih-external-pricebook-panel"
      action={<span className="qp-tag"><ShieldCheck size={14} aria-hidden="true" />仅 Admin Token 可写</span>}
    >
      <form className="mih-external-pricebook-form" onSubmit={submit}>
        <div className="mih-external-operation-price-grid">
          <Field label="币种">
            <input className="qp-input mih-mono" value={draft.currency} maxLength="3" pattern="[A-Za-z]{3}"
              onChange={(event) => update('currency', event.target.value.toUpperCase())} disabled={busy} required />
          </Field>
          <Field label="定价证据日期">
            <input className="qp-input mih-mono" type="date" value={draft.pricingAsOf}
              onChange={(event) => update('pricingAsOf', event.target.value)} disabled={busy} required />
          </Field>
          <Field label="每次调用单价（最小货币单位）" hint="应用到该供应方每一个上游 endpoint；个别 endpoint 不同价时再单独改。">
            <input className="qp-input mih-mono" type="number" min="1" step="1" value={draft.unitCostMinor}
              onChange={(event) => update('unitCostMinor', event.target.value)} disabled={busy} required />
          </Field>
          <DropdownField label="预算填写单位" value={draft.budgetMode} options={BUDGET_MODES}
            onChange={(value) => update('budgetMode', value)} disabled={busy} />
          <Field label={`月度上游预算（${draft.budgetMode === 'calls' ? '调用次数' : '最小货币单位'}）`} hint={budgetPreview}>
            <input className="qp-input mih-mono" type="number" min="0" step="1" value={draft.monthlyBudgetStated}
              onChange={(event) => update('monthlyBudgetStated', event.target.value)} disabled={busy} required />
          </Field>
          <Field
            label={`月度补贴预算（${draft.budgetMode === 'calls' ? '调用次数' : '最小货币单位'}）`}
            hint="限制上游成本中没有被下游正价扣费覆盖的部分。若下游还没有按次计费的付费客户，每次调用都算全额补贴，这里填得比上游预算小会先撞补贴上限——通常与上游预算填相同数值。"
          >
            <input className="qp-input mih-mono" type="number" min="0" step="1" value={draft.monthlySubsidyBudgetStated}
              onChange={(event) => update('monthlySubsidyBudgetStated', event.target.value)} disabled={busy} required />
          </Field>
          <Field label="变更原因" hint="必填；与修订号一起写入每个业务操作的审计事件。">
            <input className="qp-input" value={draft.reason} placeholder="例如：按 2026-09 合同统一录入采购价目"
              onChange={(event) => update('reason', event.target.value)} disabled={busy} required />
          </Field>
        </div>

        {/* Overwriting is the stated model, not a surprise: set the common
            value, then re-narrow the exceptions. */}
        <p className="mih-external-operation-precondition" role="status">
          <WarningCircle size={15} aria-hidden="true" />
          这会覆盖全部业务操作当前的价目表与预算；之后可在下面对个别操作单独调整。
          {incomplete ? ` 还需填写：${missing.join('、')}。` : null}
        </p>

        {error ? <ErrorState error={error} /> : null}
        {result ? (
          <div className="mih-external-pricebook-result" role="status">
            <strong>已应用到 {result.applied.length} 个业务操作</strong>
            {result.skipped.length ? (
              <ul>
                {result.skipped.map((entry) => (
                  <li key={entry.operationKey}>
                    <code className="mih-mono">{entry.operationKey}</code>
                    <span>{entry.message || entry.reason}</span>
                  </li>
                ))}
              </ul>
            ) : <small>没有被跳过的操作。</small>}
          </div>
        ) : null}

        <footer className="mih-external-operation-actions">
          <button className="qp-button qp-button--primary" type="submit" disabled={busy || incomplete}>
            {busy ? '正在应用' : '应用到全部业务操作'}
          </button>
        </footer>
      </form>
    </Panel>
  )
}

// A scannable list first, a form only on demand.
//
// Every operation rendered as a full form meant scrolling past six price books
// to find the one that is actually stuck. The row states the two things worth
// scanning -- can it run, and how much budget is left -- and opens into the
// existing editor when there is something to change.
function remainingCallsLabel(operation) {
  const budget = operation.budget
  if (!budget || budget.remainingMinor === null) return null
  const prices = Object.values(operation.priceBook.endpointPrices || {})
    .filter((value) => Number.isFinite(value) && value > 0)
  if (prices.length === 0) return null
  // Priced at the operation's dearest endpoint, the same basis the budget was
  // set on, so this is a floor rather than an optimistic count.
  return `约 ${formatNumber(Math.floor(budget.remainingMinor / Math.max(...prices)))} 次`
}

function ExternalPlatformOperationRow({
  token, provider, operation, open, onToggle, onSaved, onUnauthorized, notify,
}) {
  const budget = operation.budget
  const remaining = remainingCallsLabel(operation)
  const spent = budget?.exhausted === true
  return (
    <article className={`mih-external-operation-row${open ? ' is-open' : ''}`}>
      <header>
        <div className="mih-external-operation-row__name">
          <strong>{operation.label}</strong>
          <small className="mih-mono">{operation.operationKey}</small>
        </div>
        <StatusBadge status={operation.effectiveState} label={`生效：${statusLabel(operation.effectiveState)}`} />
        <div className="mih-external-operation-row__budget">
          <span className={spent ? 'mih-external-budget--spent' : undefined}>
            {budget && budget.budgetMinor !== null
              ? `剩余 ${formatMoneyMinor(budget.remainingMinor, budget.currency)} / ${formatMoneyMinor(budget.budgetMinor, budget.currency)}`
              : '预算未配置'}
          </span>
          {remaining ? <small>{spent ? '本月已用完' : `还可调用 ${remaining}`}</small> : null}
        </div>
        {operation.blockers.length || spent ? (
          <span className="mih-external-operation-row__flag">
            <WarningCircle size={14} aria-hidden="true" />
            {spent ? '预算已用完' : `${operation.blockers.length} 项阻断`}
          </span>
        ) : null}
        <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={onToggle}
          aria-expanded={open} aria-controls={`operation-${operation.operationKey}`}>
          <SlidersHorizontal size={15} aria-hidden="true" />{open ? '收起' : '设置'}
        </button>
      </header>
      {open ? (
        <ExternalPlatformOperationCard
          token={token}
          provider={provider}
          operation={operation}
          onSaved={onSaved}
          onUnauthorized={onUnauthorized}
          notify={notify}
        />
      ) : null}
    </article>
  )
}

function ExternalPlatformOperationControlPanel({
  token,
  provider,
  operations,
  onSaved,
  onUnauthorized,
  notify,
}) {
  // Opening one at a time keeps the list scannable and makes it obvious which
  // operation an edit belongs to.
  const [openKey, setOpenKey] = useState(null)
  return (
    <Panel
      id="external-operations"
      title="上游平台操作控制"
      subtitle="这里控制 Hub 是否可以调用某个上游操作，包括每个操作被实际执行的月度上游预算；下游 API Key 的平台与产品授权仍在“开放能力”中独立管理。"
      className="mih-external-operation-panel"
      action={<span className="qp-tag"><ShieldCheck size={14} aria-hidden="true" />仅 Admin Token 可写</span>}
    >
      {operations.length ? (
        <div className="mih-external-operation-list">
          {operations.map((operation) => (
            <ExternalPlatformOperationRow
              key={`${operation.operationKey}:${operation.revision}:${operation.priceBook.version}`}
              token={token}
              provider={provider}
              operation={operation}
              open={openKey === operation.operationKey}
              onToggle={() => setOpenKey(
                openKey === operation.operationKey ? null : operation.operationKey,
              )}
              onSaved={onSaved}
              onUnauthorized={onUnauthorized}
              notify={notify}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          icon={FlowArrow}
          title="暂无可管理的上游操作"
          description="管理后端尚未返回 operation policy 证据；页面不会用默认开启状态代替。"
        />
      )}
    </Panel>
  )
}

function DetailMetricRail({ detail }) {
  const quotaDisplay = detail.quota.remaining !== null && detail.quota.freeLimit !== null
    ? `${formatNumber(detail.quota.remaining)} / ${formatNumber(detail.quota.freeLimit)}`
    : detail.quota.remaining !== null
      ? formatNumber(detail.quota.remaining)
      : UNKNOWN
  return (
    <section className="mih-external-kpis mih-external-kpis--detail" aria-label={`${detail.displayName || '外部平台'} 当前窗口指标`}>
      <MetricCard icon={Pulse} label="Hub 请求" value={formatOptionalNumber(detail.summary.hubRequests)} hint="对外稳定 API" tone="info" />
      <MetricCard icon={FlowArrow} label="实际上游调用" value={formatOptionalNumber(detail.summary.upstreamCalls)} hint="真实调用证据" tone="archetype" />
      <MetricCard icon={CheckCircle} label="Hub 成功率" value={formatPercent(detail.summary.successRate)} hint="按 Hub 结果口径" tone="success" />
      <MetricCard icon={ShieldCheck} label="避免调用" value={formatOptionalNumber(detail.summary.avoidedCalls)} hint="重放、缓存或保护" tone="primary" />
      <MetricCard icon={Coins} label="上游已计费 / 状态待定" value={`${formatOptionalNumber(detail.summary.billedCalls)} / ${formatOptionalNumber(detail.summary.indeterminateBillingCalls)}`} hint={`上游成功但 Hub 不可用 ${formatOptionalNumber(detail.summary.unusableSuccesses)}`} tone="warning" />
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
    <Panel
      id="external-cost"
      title="上游成本与免费额度"
      subtitle="这里只展示部署级（环境变量）采购证据；真正拦住调用的月度预算按业务操作单独配置，在下方“上游平台操作控制”里。"
      className="mih-external-cost-panel"
    >
      <dl className="mih-external-facts">
        <div><dt>窗口实际净支出</dt><dd>{formatMoneyMinor(cost.actualMinor, cost.currency)}</dd></div>
        <div><dt>免费额度 / 折扣前标价估算</dt><dd>{formatMoneyMinor(cost.grossEstimatedMinor, cost.currency)}</dd></div>
        <div><dt>预计月度成本</dt><dd>{formatMoneyMinor(cost.projectedMonthMinor, cost.currency)}</dd></div>
        <div>
          <dt>上游月度成本线（部署级）</dt>
          <dd>
            {formatMoneyMinor(cost.monthlyBudgetMinor, cost.currency)}
            {/* Unknown here does not mean unpriced: an operation with its own
                database price book is enforced against that instead, and this
                deployment-level value is never consulted for it. */}
            {cost.monthlyBudgetMinor === null
              ? <FixLink target="external-operations">改为按业务操作配置</FixLink>
              : null}
          </dd>
        </div>
        <div><dt>单价未知的已计费调用</dt><dd>{formatOptionalNumber(cost.unknownCostCalls)}</dd></div>
        <div><dt>计费状态未确定的调用</dt><dd>{formatOptionalNumber(cost.indeterminateBillingCalls)}</dd></div>
        <div><dt>预计月调用 / 付费调用</dt><dd>{formatOptionalNumber(cost.projectedMonthlyCalls)} / {formatOptionalNumber(cost.projectedPaidCalls)}</dd></div>
        <div><dt>免费额度</dt><dd>{formatOptionalNumber(quota.freeLimit)}</dd></div>
        <div><dt>已使用 / 剩余</dt><dd>{formatOptionalNumber(quota.used)} / {formatOptionalNumber(quota.remaining)}</dd></div>
        <div><dt>免费额度周期</dt><dd>{quota.period || UNKNOWN}</dd></div>
      </dl>
      {cost.unitPrices.length ? (
        <Table label={`${detail.displayName || '外部平台'} 上游接口价目`}>
          <thead><tr><th scope="col">上游接口</th><th scope="col">每次标价成本</th></tr></thead>
          <tbody>{cost.unitPrices.map((entry) => (
            <tr key={entry.endpointKey}>
              <td className="mih-mono">{entry.endpointKey}</td>
              <td>{formatMoneyMinor(entry.unitCostMinor, cost.currency)}</td>
            </tr>
          ))}</tbody>
        </Table>
      ) : (
        <p className="mih-external-unknown">
          <WarningCircle size={16} aria-hidden="true" />
          部署级环境变量未配置逐接口采购价目。若该操作已绑定数据库价目表，则以那份为准。
          <FixLink target="external-operations">查看各操作的价目与预算</FixLink>
        </p>
      )}
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
        {/* The advice above is about deployment-level billing, so it is paired
            with the control that acts on it rather than left as prose. */}
        <div className="mih-external-cost-note__actions">
          <FixLink target="external-operations">去配置业务操作的价目与月度预算</FixLink>
          <FixLink target="external-credential">检查上游凭据</FixLink>
        </div>
        <small>
          定价证据：{displayDate(cost.pricingAsOf)} · 定价来源：{cost.pricingSource || UNKNOWN} · 预测置信度：{cost.confidence || UNKNOWN}
        </small>
        <small>额度重置：{displayDate(quota.resetAt)} · 额度来源：{quota.source || UNKNOWN}{quota.note ? ` · ${quota.note}` : ''}</small>
        <small>该成本线只限制未形成正价 enforced 钱包预占的补贴流量；已明确按次计费的 Key 继续调用并逐次记录上游成本。</small>
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

function CapabilityMatrix({ capabilities, providerName }) {
  return (
    <Panel title="能力与版本矩阵" subtitle={`Hub 公共合同与 ${providerName} 上游接口分栏展示，避免把同名误当等价。`} className="mih-external-capability-panel">
      {capabilities.length ? (
        <Table label={`${providerName} 能力与版本矩阵`}>
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

function TenantRanking({ tenants, currency, providerName }) {
  return (
    <Panel title="租户使用量排名" subtitle="只按当前统计窗口的服务端聚合结果排序，不在浏览器补齐租户身份。" className="mih-external-tenant-panel">
      {tenants.length ? (
        <Table label={`${providerName} 租户使用量排名`}>
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

function NightAllPlatformDetail({ token, range, setQuery, onUnauthorized }) {
  const load = useCallback(() => adminApi.externalPlatform(token, 'night-all', { range }), [token, range])
  const remote = useRemoteData(load, onUnauthorized)
  const data = remote.data
  return <>
    <PageHeading title="Night-All · 数据接口与客户计费" description="内部数据服务也纳入平台治理；服务转移价、客户售价与采集工作预算分别管理。" loading={remote.loading} onRefresh={remote.refresh}>
      <a className="qp-button qp-button--ghost" href="#/external-platforms">返回平台总览</a><RangeControl range={range} setQuery={setQuery} />
    </PageHeading>
    {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
    {!data && remote.loading ? <LoadingState label="读取 Night-All 调用证据" /> : null}
    {data ? <>
      <section className="qp-panel"><h2>收费或免费，由 Hub 套餐决定</h2>
        <p>{data.provider.billing.recommendation}</p><p>{data.customerBilling.note}</p>
        <a className="qp-button qp-button--primary" href="#/plans">配置租户套餐与接口费率</a>
        <p>发布套餐时可添加这三个计费键，单价填 0 即免费；发布后分配给调用身份。disabled 不扣款，shadow 仅模拟，enforced 按余额结算。修改不会自动影响旧套餐版本。</p>
      </section>
      <section className="qp-panel"><h2>已接入接口</h2>{data.commercialOperations.map(operation => <article key={operation.operationKey}>
        <h3>{operation.label}</h3><p><code>POST {operation.publicPath}</code></p><p>兼容路径：<code>{operation.aliasPath}</code> · 客户计费键：<code>{operation.meterKey}</code> · 按请求计费</p>
        <p>Night-All 服务单价：0 · 业务平台：{operation.platforms.join('、')}</p>
      </article>)}</section>
      <section className="qp-panel"><h2>调用证据</h2><p>{data.notes.scope}</p>
        <Table label="Night-All 调用证据"><thead><tr><th>接口</th><th>业务平台</th><th>已记录请求</th><th>调用记录</th><th>成功交付</th><th>未知结果</th></tr></thead>
          <tbody>{data.endpointStatistics.map(row => <tr key={`${row.operation}:${row.platform}`}><td>{row.operation}</td><td>{row.platform}</td><td>{row.hubRequests}</td><td>{row.upstreamCalls}</td><td>{row.successfulHubRequests}</td><td>{row.unknownOutcomes}</td></tr>)}</tbody></Table>
        {!data.endpointStatistics.length ? <p>当前窗口暂无调用证据；这不表示接口已通过健康检查。</p> : null}
      </section>
      <section className="qp-panel"><h2>交付与运行边界</h2><p>{data.notes.budget}</p><a className="qp-button qp-button--outline" href="#/platforms">配置调用身份采集预算</a><p>{data.notes.fallback}</p><p>{data.notes.connection}</p><p>上游调用成功后，原始结果与入库任务一起提交，再由后台完成归一化和检索投影。</p></section>
    </> : null}
  </>
}

function PlatformDetail({ token, range, provider, setQuery, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.externalPlatform(token, provider, { range }), [provider, range, token])
  const remote = useRemoteData(load, onUnauthorized)
  const detail = useMemo(() => normalizeDetail(remote.data, provider), [provider, remote.data])
  const providerName = detail.displayName || providerDisplayName(provider)

  return (
    <>
      <PageHeading
        className="mih-command-heading"
        eyebrow={`EXTERNAL PLATFORM / ${String(provider).toUpperCase()}`}
        title={`${providerName} 调用与数据保障`}
        description="从 Hub 请求到上游付费调用、版本适配、数据归档与成本规划的同一管理视图。"
        loading={remote.loading}
        onRefresh={remote.refresh}
      >
        <a className="qp-button qp-button--ghost" href={`#/external-platforms?range=${encodeURIComponent(range)}`}><ArrowLeft size={15} aria-hidden="true" />平台总览</a>
        {provider === 'tikhub' ? <><a className="qp-button qp-button--outline" href={publicDocsHref('/docs/tikhub/get_image_note_detail')} target="_blank" rel="noreferrer">小红书接口文档</a><a className="qp-button qp-button--outline" href="#/data-products/xiaohongshu-note">小红书笔记画卷</a></> : null}
        <RangeControl range={range} setQuery={setQuery} />
      </PageHeading>

      {remote.loading && !remote.data ? <LoadingState label={`正在读取 ${providerDisplayName(provider)} 管理证据`} /> : null}
      {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
      {remote.data ? (
        <>
          <section className="mih-external-detail-status" aria-label={`${providerName} 当前状态`}>
            <span><Globe size={20} weight="duotone" aria-hidden="true" /></span>
            <div><strong>{detail.displayName}</strong><small className="mih-mono">provider={detail.key || provider}</small></div>
            <StatusBadge status={detail.status} label={statusLabel(detail.status)} />
            <small>最近观测：{displayDate(detail.lastObservedAt)}</small>
          </section>
          {/* What is happening comes before what to change: an operator opens
              this page to read the situation, and only then edits a credential
              or a price book. The controls keep stable ids so every metric and
              blocker above can jump straight to the one that fixes it. */}
          <DetailMetricRail detail={detail} />
          <section className="mih-external-two-column">
            <TrendPanel detail={detail} />
            <CostQuotaPanel detail={detail} />
          </section>
          <ExternalPlatformProviderPriceBook
            token={token}
            provider={provider}
            operations={detail.operations}
            onSaved={remote.refresh}
            onUnauthorized={onUnauthorized}
            notify={notify}
          />
          <ExternalPlatformOperationControlPanel
            token={token}
            provider={provider}
            operations={detail.operations}
            onSaved={remote.refresh}
            onUnauthorized={onUnauthorized}
            notify={notify}
          />
          <ExternalPlatformCredentialPanel
            token={token}
            provider={provider}
            credential={detail.credential}
            onSaved={remote.refresh}
            onUnauthorized={onUnauthorized}
            notify={notify}
          />
          <ProcessingChain stages={detail.stages} />
          <CapabilityMatrix capabilities={detail.capabilities} providerName={providerName} />
          <section className="mih-external-two-column mih-external-two-column--balanced">
            <TenantRanking tenants={detail.tenants} currency={detail.cost.currency} providerName={providerName} />
            <ProtectionPanel guardrails={detail.guardrails} notes={detail.notes} />
          </section>
          {provider === 'justone' ? <DifferencePanel /> : null}
        </>
      ) : !remote.loading && !remote.error ? (
        <EmptyState
          icon={Globe}
          title={`${providerDisplayName(provider)} 详情响应为空`}
          description="管理接口没有返回可展示的运行证据；页面不会用默认指标代替。"
          action={<a className="qp-button qp-button--outline" href={`#/external-platforms?range=${encodeURIComponent(range)}`}><ArrowLeft size={15} aria-hidden="true" />返回平台总览</a>}
        />
      ) : null}
    </>
  )
}

function UnsupportedProvider({ range }) {
  return (
    <>
      <PageHeading
        eyebrow="DATA CLEANING CENTER / EXTERNAL PLATFORMS"
        title="外部数据平台"
        description="当前详情路由只接受已登记的外部数据平台。"
      />
      <EmptyState
        icon={WarningCircle}
        title="无法识别外部平台"
        description="该平台不在可见的管理目录中。"
        action={<a className="qp-button qp-button--outline" href={`#/external-platforms?range=${encodeURIComponent(range)}`}><ArrowLeft size={15} aria-hidden="true" />返回平台总览</a>}
      />
    </>
  )
}

export function ExternalPlatformsPage({ token, query, setQuery, onUnauthorized, notify }) {
  const rawRange = query.get('range') || '24h'
  const range = VALID_RANGES.has(rawRange) ? rawRange : '24h'
  const provider = (query.get('provider') || '').trim().toLowerCase()
  const unsupportedProvider = Boolean(provider && !SUPPORTED_PROVIDERS.has(provider))

  useEffect(() => {
    if (unsupportedProvider) setQuery({ provider: null, range })
  }, [range, setQuery, unsupportedProvider])

  if (unsupportedProvider) return <UnsupportedProvider range={range} />
  if (provider === 'night-all') return <NightAllPlatformDetail token={token} range={range} setQuery={setQuery} onUnauthorized={onUnauthorized} />
  if (provider) {
    return <PlatformDetail token={token} range={range} provider={provider} setQuery={setQuery} onUnauthorized={onUnauthorized} notify={notify} />
  }
  return <PlatformsOverview token={token} range={range} setQuery={setQuery} onUnauthorized={onUnauthorized} />
}
