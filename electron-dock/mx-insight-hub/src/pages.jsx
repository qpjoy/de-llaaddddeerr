import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowClockwise,
  ArrowRight,
  Brain,
  Buildings,
  Pulse,
  ChartLine,
  Cloud,
  Coins,
  Copy,
  Database,
  Globe,
  Key,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  Power,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  TrendDown,
  TrendUp,
  Trash,
  UserPlus,
  Users,
  WarningCircle,
} from '@phosphor-icons/react'
import { adminApi, publicDocsHref } from './api.js'
import { copyText, TOKENIZE_CURL_TEMPLATE } from './open-capabilities.js'
import { selectVisibleTenantId } from './tenant-scope.js'
import {
  DropdownField,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  MetricCard,
  Modal,
  OutcomeChart,
  PageHeading,
  PlatformChart,
  ReadinessGauge,
  SecretPanel,
  StatusRing,
  StatusBadge,
  TrafficComparisonChart,
  formatDate,
  formatLatency,
  formatNumber,
  percent,
  platformLabel,
  rangeBounds,
  useRemoteData,
} from './components.jsx'

// Grouping for the open-capability tables. 34 platforms in one flat list means
// scrolling from top to bottom to find anything, and the list only grows. The
// order here is the order they render in, and membership is by explicit id or
// prefix so a new platform lands somewhere deliberate rather than at the end.
const PLATFORM_GROUPS = [
  {
    key: 'social',
    label: '社交与内容平台',
    hint: '按来源平台授权；内部可聚合多个供应方',
    members: [
      'xiaohongshu', 'weibo', 'douyin', 'kuaishou', 'bilibili', 'zhihu',
      'wechat_mp', 'wechat_search', 'telegram',
      'tiktok', 'instagram', 'youtube', 'twitter', 'facebook', 'linkedin', 'reddit',
    ],
  },
  {
    key: 'commerce',
    label: '电商与商品',
    hint: '商品、店铺与货架数据域',
    members: ['ecommerce', 'mobile_commerce', 'virtual_supermarket'],
  },
  {
    key: 'hub',
    label: 'Hub 自有数据域',
    hint: '由 Hub 规范化数据层提供，不直连外部供应方',
    members: ['public_opinion', 'source_catalog'],
  },
  {
    key: 'saved_records',
    label: '存量记录 · 按栏目',
    hint: 'Night-All 存量记录，按栏目分别授权',
    prefix: 'data_center_saved_records_',
  },
]

function platformGroupOf(platform) {
  for (const group of PLATFORM_GROUPS) {
    if (group.members?.includes(platform)) return group.key
    if (group.prefix && platform.startsWith(group.prefix)) return group.key
  }
  return 'other'
}

const PLATFORM_CATALOG = [
  'xiaohongshu',
  'weibo',
  'douyin',
  'zhihu',
  'reddit',
  'tiktok',
  'instagram',
  'linkedin',
  'youtube',
  'wechat_search',
  'bilibili',
  'kuaishou',
  'twitter',
  'facebook',
  'wechat_mp',
  'telegram',
  'public_opinion',
  'source_catalog',
  'mobile_commerce',
  'virtual_supermarket',
  'ecommerce',
  'data_center_saved_records_automotive',
  'data_center_saved_records_finance',
  'data_center_saved_records_forum',
  'data_center_saved_records_hotspot',
  'data_center_saved_records_local_news',
  'data_center_saved_records_media',
  'data_center_saved_records_news',
  'data_center_saved_records_other',
  'data_center_saved_records_recruitment',
  'data_center_saved_records_research',
  'data_center_saved_records_social',
  'data_center_saved_records_technology',
  'data_center_saved_records_web',
]

const DEFAULT_POLICY = { maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 }
const CAPABILITY_CATALOG = {
  'compat.xiaohongshu.app_v2': {
    group: 'compatibility',
    label: '小红书 App V2 兼容接口',
    description: '允许调用 Hub 管理的 App V2 provider-compatible 路径；不会暴露或绑定物理供应商凭证',
    endpoint: 'GET /api/v1/xiaohongshu/app_v2/*',
    usageHint: '还需同时授予 xiaohongshu 数据域及每个 endpoint 对应的业务能力',
  },
  'nlp.tokenize': {
    label: '中文分词',
    description: 'HanLP → Jieba → CJK bigram，响应明确本次实际后端与降级状态',
    endpoint: 'POST /api/v1/tools/tokenize',
    usageHint: 'curl 粘贴即运行并静默读取 Key；旧 API Key 不会被读取或回显',
  },
  'ecommerce.products.search': {
    label: '电商商品搜索',
    description: '通过 Hub 统一商品合同读取缓存或调用已开通的外部数据平台；可能产生外部数据成本',
    endpoint: 'POST /api/v1/data/ecommerce/products/search',
    usageHint: '还需同时授予 ecommerce 数据域；每把 Key 都要显式包含此业务操作',
  },
  'public_opinion.all_ingested.read': {
    label: '全量安全舆情读取',
    description: '在有界时间窗内枚举 canonical current safe 记录，包含未分类和未评分项，不暴露 raw、模型推理或历史 revision',
    endpoint: 'GET /api/v1/data/public-opinion/regions/{regionCode}/items',
    usageHint: '还必须同时授予 public_opinion 平台；默认不向新调用者开放',
  },
  'social.posts.resolve': {
    label: '社交笔记详情',
    description: '按官方笔记链接获取正文、作者、标签、互动量与媒体清单；可能产生外部数据成本',
    endpoint: 'POST /api/v1/data/post',
    usageHint: '当前需同时授予 xiaohongshu 平台；历史 Key 不会自动获得此能力',
  },
  'social.posts.search': {
    label: '社交笔记搜索',
    description: '按关键词调用已开通的小红书笔记搜索接口；可能产生外部数据成本',
    endpoint: 'GET /api/v1/xiaohongshu/app_v2/search_notes',
    usageHint: '需同时授予 xiaohongshu 平台；每把 Key 都要显式包含此能力',
  },
  'social.users.resolve': {
    label: '社交用户资料',
    description: '搜索用户或按用户 ID 获取资料；可能产生外部数据成本',
    endpoint: 'GET /api/v1/xiaohongshu/app_v2/get_user_info',
    usageHint: '需同时授予 xiaohongshu 平台；同一能力覆盖 search_users 与 get_user_info',
  },
  'social.users.posts': {
    label: '社交用户笔记',
    description: '按用户获取已发布笔记并使用 Hub 不透明游标翻页；可能产生外部数据成本',
    endpoint: 'GET /api/v1/xiaohongshu/app_v2/get_user_posted_notes',
    usageHint: '需同时授予 xiaohongshu 平台；每把 Key 都要显式包含此能力',
  },
}

const PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION = {
  ecommerce: {
    kind: 'Hub 数据域',
    operation: 'ecommerce.products.search',
    route: 'Hub 内部路由',
    policyNote: '启用即允许该调用身份请求电商数据；当前固定单候选，缓存与内部采购成本由 Hub 管理。',
  },
  xiaohongshu: {
    kind: '来源平台',
    operation: 'social.posts.resolve',
    route: 'Hub 内部路由',
    policyNote: '平台授权与付费笔记详情能力分开；Key 必须同时包含 social.posts.resolve。',
  },
}

function selectionContext(tenantId, consumerId) {
  return `${tenantId || ''}\u0000${consumerId || ''}`
}

function tenantAllows(session, tenantId, capability) {
  if (!tenantId) return false
  return Boolean(
    session?.platformAdmin || session?.memberships?.some((membership) => (
      membership.tenantId === tenantId && membership.capabilities?.includes(capability)
    )),
  )
}

function sortedPlatforms(byPlatform = {}) {
  return Object.entries(byPlatform).sort((left, right) => Number(right[1]?.requests || 0) - Number(left[1]?.requests || 0))
}

function FilterSelect({ label, value, onChange, options, emptyLabel = '全部', disabled = false }) {
  return <DropdownField className="mih-filter-field" label={label} value={value || ''} onChange={onChange}
    options={[{ value: '', label: emptyLabel }, ...options]} disabled={disabled} />
}

function RangeFilter({ value, onChange }) {
  return <DropdownField className="mih-filter-field" label="时间范围" value={value} onChange={onChange} options={[
    { value: '24h', label: '近 24 小时' },
    { value: '7d', label: '近 7 天' },
    { value: '30d', label: '近 30 天' },
  ]} />
}

function Panel({ title, subtitle, action, children, className = '' }) {
  return (
    <section className={`qp-panel mih-panel ${className}`.trim()}>
      <header className="mih-panel__header">
        <div>
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  )
}

function Table({ children, label }) {
  return (
    <div className="qp-data-table mih-table-wrap">
      <table className="mih-table" aria-label={label}>{children}</table>
    </div>
  )
}

function comparisonBounds(range) {
  const current = rangeBounds(range)
  const from = Date.parse(current.from)
  const to = Date.parse(current.to)
  const duration = to - from
  return {
    current,
    previous: {
      from: new Date(from - duration).toISOString(),
      to: current.from,
    },
  }
}

function numericPercent(part, total) {
  if (!Number(total)) return null
  return (Number(part || 0) / Number(total)) * 100
}

const LATENCY_CONCERN_MS = 1500

function processingCount(usage) {
  return Math.max(0, Number(usage?.requests || 0)
    - Number(usage?.committed || 0)
    - Number(usage?.released || 0)
    - Number(usage?.unknown || 0))
}

function certaintyPercent(usage) {
  const requests = Number(usage?.requests || 0)
  if (!requests) return null
  const certain = Math.max(0, Number(usage?.committed || 0) + Number(usage?.released || 0))
  return Math.min(100, (certain / requests) * 100)
}

function optionalNumber(value) {
  return value === null || value === undefined ? '—' : formatNumber(value)
}

function formatMoneyMinor(value, currency = 'CNY') {
  if (value === null || value === undefined || !currency) return '—'
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) / 100)
}

function decimalToMinor(value) {
  const normalized = String(value || '').trim()
  if (!/^(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/u.test(normalized)) return null
  const [whole, fraction = ''] = normalized.split('.')
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
  return Number.isSafeInteger(minor) ? minor : null
}

function multiplierToPpm(value) {
  const normalized = String(value || '').trim()
  if (!/^(?:0|[1-9]\d{0,2})(?:\.\d{1,6})?$/u.test(normalized)) return null
  const [whole, fraction = ''] = normalized.split('.')
  const ppm = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, '0'))
  return Number.isSafeInteger(ppm) && ppm <= 100_000_000 ? ppm : null
}

function billingMeterLabel(meterKey) {
  return ({
    'social.posts.search': '小红书笔记搜索',
    'social.posts.resolve': '小红书笔记详情',
    'social.users.resolve': '小红书用户资料',
    'social.users.posts': '小红书用户笔记',
    'ecommerce.products.search': '电商商品搜索',
    'nlp.tokenize': '中文分词',
  })[meterKey] || meterKey
}

function effectivePriceMinor(unitPriceMinor, multiplierPpm = 1_000_000) {
  if (!Number.isSafeInteger(Number(unitPriceMinor)) || !Number.isSafeInteger(Number(multiplierPpm))) return null
  return Number((BigInt(unitPriceMinor) * BigInt(multiplierPpm) + 999_999n) / 1_000_000n)
}

function billingLedgerKindLabel(kind) {
  return ({
    topup: '充值入账',
    adjustment: '人工调账',
    hold: '请求冻结',
    capture: '成功扣费',
    release: '失败解冻',
  })[kind] || kind
}

function metricDelta(current, previous, { lowerIsBetter = false, points = false } = {}) {
  const now = Number(current || 0)
  const before = Number(previous || 0)
  if (!before) {
    if (!now) return { label: '与上期持平', direction: 'flat', favorable: true }
    return { label: '本期新增', direction: 'up', favorable: !lowerIsBetter }
  }
  const change = points ? now - before : ((now - before) / before) * 100
  if (Math.abs(change) < 0.05) return { label: '与上期持平', direction: 'flat', favorable: true }
  const direction = change > 0 ? 'up' : 'down'
  const favorable = lowerIsBetter ? change < 0 : change > 0
  return {
    label: `${change > 0 ? '+' : ''}${points ? change.toFixed(1) : Math.abs(change) >= 10 ? change.toFixed(0) : change.toFixed(1)}${points ? 'pp' : '%'}`,
    direction,
    favorable,
  }
}

function readinessScore(usage) {
  const requests = Number(usage?.requests || 0)
  if (!requests) return null
  const success = Number(usage?.committed || 0) / requests
  const certainty = (certaintyPercent(usage) || 0) / 100
  const latency = usage?.averageUpstreamLatencyMs
  const latencyHealth = latency === null || latency === undefined
    ? 0
    : Math.max(0, Math.min(1, 1 - (Number(latency) / LATENCY_CONCERN_MS)))
  return Math.round(success * 70 + certainty * 15 + latencyHealth * 15)
}

function readinessLabel(score) {
  if (score === null) return '等待数据'
  if (score >= 95) return '优秀'
  if (score >= 85) return '稳定'
  if (score >= 70) return '关注'
  return '告警'
}

function buildRiskEvents(usage, summary, platformCount, range) {
  const events = []
  const requests = Number(usage.requests || 0)
  const unknown = Number(usage.unknown || 0)
  const released = Number(usage.released || 0)
  const processing = processingCount(usage)
  const latency = usage.averageUpstreamLatencyMs
  if (unknown > 0) {
    events.push({
      severity: 'critical',
      label: '严重',
      title: '存在结果未知请求',
      detail: `${formatNumber(unknown)} 次请求需要人工核验后再决定是否重试`,
      icon: WarningCircle,
      href: `#/usage?range=${range}`,
    })
  }
  if (released > 0) {
    events.push({
      severity: 'high',
      label: '高危',
      title: '请求已释放',
      detail: `${formatNumber(released)} 次调用未计量，可检查上游失败原因`,
      icon: Cloud,
      href: `#/usage?range=${range}`,
    })
  }
  if (processing > 0) {
    events.push({
      severity: 'info',
      label: '信息',
      title: '存在处理中请求',
      detail: `${formatNumber(processing)} 次请求尚未形成最终计量结果`,
      icon: Pulse,
      href: `#/usage?range=${range}`,
    })
  }
  if (latency !== null && latency !== undefined && Number(latency) > LATENCY_CONCERN_MS) {
    events.push({
      severity: 'warning',
      label: '警告',
      title: '上游平均延迟偏高',
      detail: `${formatLatency(latency)}，已超过 1.5 秒关注阈值`,
      icon: Timer,
      href: `#/usage?range=${range}`,
    })
  }
  if (summary.activeApiKeys === 0) {
    events.push({
      severity: 'warning',
      label: '警告',
      title: '没有启用的 API Key',
      detail: '调用者当前无法通过公共 Data API 发起请求',
      icon: Key,
      href: '#/api-keys',
    })
  }
  if (!requests) {
    events.push({
      severity: 'info',
      label: '信息',
      title: '当前窗口没有请求',
      detail: '可扩大时间范围，或检查调用者与平台授权是否已配置',
      icon: Pulse,
      href: '#/platforms',
    })
  } else if (!platformCount) {
    events.push({
      severity: 'info',
      label: '信息',
      title: '未识别到活跃平台',
      detail: '用量已产生，但平台分布尚未形成可用摘要',
      icon: Globe,
      href: '#/platforms',
    })
  }
  return events
}

function DashboardKpi({ icon: Icon, label, value, delta, tone = 'primary' }) {
  const TrendIcon = delta?.direction === 'up' ? TrendUp : delta?.direction === 'down' ? TrendDown : null
  return (
    <article className={`mih-command-kpi mih-command-kpi--${tone}`}>
      <Icon size={18} weight="duotone" aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
      <small className={delta ? (delta.favorable ? 'is-positive' : 'is-negative') : ''}>
        {TrendIcon ? <TrendIcon size={12} aria-hidden="true" /> : null}
        {delta?.label || '当前范围'}
      </small>
    </article>
  )
}

export function DashboardPage({ token, query, setQuery, onUnauthorized }) {
  const range = query.get('range') || '24h'
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [chartView, setChartView] = useState('comparison')
  const load = useCallback(async () => {
    const bounds = comparisonBounds(range)
    const [summary, usage, previousUsage] = await Promise.all([
      adminApi.dashboard(token),
      adminApi.usage(token, bounds.current),
      adminApi.usage(token, bounds.previous),
    ])
    return { summary, usage, previousUsage, asOf: new Date().toISOString() }
  }, [range, token])
  const state = useRemoteData(load, onUnauthorized)

  useEffect(() => {
    if (!autoRefresh) return undefined
    const timer = window.setInterval(state.refresh, 30_000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, state.refresh])

  if (state.loading && !state.data) return <LoadingState label="正在汇总网关指标" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const summary = state.data?.summary || {}
  const usage = state.data?.usage || {}
  const previousUsage = state.data?.previousUsage || {}
  const platforms = sortedPlatforms(usage.byPlatform)
  const successRateValue = numericPercent(usage.committed, usage.requests)
  const previousSuccessRate = numericPercent(previousUsage.committed, previousUsage.requests)
  const certaintyValue = certaintyPercent(usage)
  const score = readinessScore(usage)
  const previousScore = readinessScore(previousUsage)
  const scoreDelta = score === null
    ? '产生调用后自动计算'
    : previousScore === null
      ? '当前窗口首个可用基线'
      : `较上一周期 ${score - previousScore >= 0 ? '+' : ''}${score - previousScore} 分`
  const latencyHealth = usage.averageUpstreamLatencyMs === null || usage.averageUpstreamLatencyMs === undefined
    ? 0
    : Math.max(0, Math.min(100, 100 - (Number(usage.averageUpstreamLatencyMs) / LATENCY_CONCERN_MS) * 100))
  const risks = buildRiskEvents(usage, summary, platforms.length, range)
  const riskCounts = risks.reduce((counts, event) => ({ ...counts, [event.severity]: (counts[event.severity] || 0) + 1 }), {})
  const processing = processingCount(usage)
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || '浏览器本地时区'

  return (
    <>
      <PageHeading
        className="mih-command-heading"
        eyebrow="GATEWAY / GOVERNANCE / EVIDENCE"
        title="数据网关总览"
        description="用真实计量证据观察网关战备度、请求结果、风险事件与平台健康。"
        loading={state.loading}
        onRefresh={state.refresh}
      >
        <span className="mih-command-refresh-state" title={state.data?.asOf ? `最后更新：${formatDate(state.data.asOf)}` : undefined}>
          <i className={autoRefresh ? 'is-live' : ''} aria-hidden="true" />
          {autoRefresh ? '30 秒自动刷新' : '自动刷新已暂停'}
        </span>
        <button
          className="qp-button qp-button--ghost qp-button--sm"
          type="button"
          aria-pressed={autoRefresh}
          onClick={() => setAutoRefresh((value) => !value)}
        >
          {autoRefresh ? '暂停' : '开启'}
        </button>
        <RangeFilter value={range} onChange={(value) => setQuery({ range: value })} />
      </PageHeading>

      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}

      <section className="mih-command-overview" aria-label="网关指挥舱">
        <Panel
          title="网关战备参考分"
          subtitle="本地启发式（非 SLO）：成功率 70% + 结果确定性 15% + 上游延迟 15%"
          className="mih-command-readiness"
        >
          <ReadinessGauge score={score} label={readinessLabel(score)} delta={scoreDelta} />
        </Panel>

        <Panel title="平台请求态势" subtitle="当前周期按真实请求量展示平台负载" className="mih-command-traffic">
          {platforms.length ? (
            <PlatformChart entries={platforms.slice(0, 8)} />
          ) : (
            <EmptyState icon={Globe} title="当前周期暂无平台请求" description="产生真实调用后，这里会显示平台负载分布。" />
          )}
        </Panel>

        <Panel title="链路健康" subtitle="只展示当前接口可证实的指标" className="mih-command-rings">
          <StatusRing
            label="调用成功率"
            value={successRateValue || 0}
            display={successRateValue === null ? '暂无' : `${successRateValue.toFixed(2)}%`}
            hint={metricDelta(successRateValue, previousSuccessRate, { points: true }).label}
            tone="success"
          />
          <StatusRing
            label="平均上游延迟"
            value={latencyHealth}
            display={formatLatency(usage.averageUpstreamLatencyMs)}
            hint="关注阈值 1.5 秒"
            tone="info"
          />
          <StatusRing
            label="结果确定率"
            value={certaintyValue || 0}
            display={certaintyValue === null ? '暂无' : `${certaintyValue.toFixed(2)}%`}
            hint={`${formatNumber(usage.unknown)} 次未知`}
            tone="archetype"
          />
        </Panel>
      </section>

      <section className="mih-command-kpi-rail" aria-label="核心计量指标">
        <DashboardKpi icon={Pulse} label="请求总数" value={formatNumber(usage.requests)} delta={metricDelta(usage.requests, previousUsage.requests)} tone="info" />
        <DashboardKpi icon={ShieldCheck} label="成功" value={formatNumber(usage.committed)} delta={metricDelta(usage.committed, previousUsage.committed)} tone="success" />
        <DashboardKpi icon={Cloud} label="已释放" value={formatNumber(usage.released)} delta={metricDelta(usage.released, previousUsage.released, { lowerIsBetter: true })} tone="danger" />
        <DashboardKpi icon={WarningCircle} label="结果未知" value={formatNumber(usage.unknown)} delta={metricDelta(usage.unknown, previousUsage.unknown, { lowerIsBetter: true })} tone="warning" />
        <DashboardKpi icon={Coins} label="计量单位" value={formatNumber(usage.units)} delta={metricDelta(usage.units, previousUsage.units)} tone="archetype" />
        <DashboardKpi icon={Key} label="启用 API Key" value={optionalNumber(summary.activeApiKeys)} tone="primary" />
        <DashboardKpi icon={Users} label="调用者" value={optionalNumber(summary.consumers)} tone="info" />
        <DashboardKpi icon={Buildings} label="租户" value={optionalNumber(summary.tenants)} tone="info" />
        <DashboardKpi icon={Globe} label="活跃平台" value={formatNumber(platforms.length)} tone="primary" />
      </section>

      <section className="mih-command-grid">
        <Panel
          title="请求与结果对比"
          subtitle="成功、已释放、结果未知与处理中请求"
          className="mih-command-panel--outcomes"
          action={(
            <div className="mih-command-segmented" aria-label="图表视图">
              <button type="button" aria-pressed={chartView === 'comparison'} onClick={() => setChartView('comparison')}>对比</button>
              <button type="button" aria-pressed={chartView === 'composition'} onClick={() => setChartView('composition')}>结构</button>
            </div>
          )}
        >
          {usage.requests || previousUsage.requests ? (
            chartView === 'comparison'
              ? <TrafficComparisonChart current={usage} previous={previousUsage} />
              : <OutcomeChart committed={usage.committed} released={usage.released} unknown={usage.unknown} processing={processing} />
          ) : (
            <EmptyState icon={ChartLine} title="当前没有可比较的调用结果" description="更换时间范围，或在第一笔调用完成后回来查看。" />
          )}
          <div className="mih-command-outcome-strip">
            <span><small>当前请求</small><strong>{formatNumber(usage.requests)}</strong></span>
            <span><small>成功</small><strong>{formatNumber(usage.committed)} <em>{percent(usage.committed, usage.requests)}</em></strong></span>
            <span><small>已释放</small><strong>{formatNumber(usage.released)} <em>{percent(usage.released, usage.requests)}</em></strong></span>
            <span><small>结果未知</small><strong>{formatNumber(usage.unknown)} <em>{percent(usage.unknown, usage.requests)}</em></strong></span>
            <span><small>处理中</small><strong>{formatNumber(processing)} <em>{percent(processing, usage.requests)}</em></strong></span>
          </div>
        </Panel>

        <Panel
          title="风险事件"
          subtitle="由当前计量、链路阈值与可用配置直接推导"
          className={`mih-command-panel--risks${risks.length < 3 ? ' is-compact' : ''}`}
          action={<a className="mih-command-link" href={`#/usage?range=${range}`}>查看证据<ArrowRight size={13} aria-hidden="true" /></a>}
        >
          {risks.length ? (
            <div className="mih-risk-list">
              {risks.map((risk) => {
                const Icon = risk.icon
                return (
                  <article className={`mih-risk-item mih-risk-item--${risk.severity}`} key={`${risk.severity}-${risk.title}`}>
                    <span className="mih-risk-item__icon"><Icon size={17} weight="duotone" aria-hidden="true" /></span>
                    <div><strong>{risk.title}</strong><p>{risk.detail}</p></div>
                    <span className="mih-risk-item__level">{risk.label}</span>
                    <a href={risk.href} aria-label={`查看${risk.title}详情`}><ArrowRight size={15} aria-hidden="true" /></a>
                  </article>
                )
              })}
            </div>
          ) : (
            <EmptyState icon={ShieldCheck} title="当前未发现需处置事件" description="成功率、延迟与结果确定性均处于正常范围。" />
          )}
          {risks.length ? (
            <section className="mih-risk-playbook" aria-labelledby="mih-risk-playbook-title">
              <h3 id="mih-risk-playbook-title">建议处置路径</h3>
              <a href={`#/usage?range=${range}`}><span>01</span><strong>查看计量证据</strong><ArrowRight size={13} aria-hidden="true" /></a>
              <a href="#/runtime"><span>02</span><strong>检查运行依赖</strong><ArrowRight size={13} aria-hidden="true" /></a>
              <a href="#/platforms"><span>03</span><strong>复核平台策略</strong><ArrowRight size={13} aria-hidden="true" /></a>
            </section>
          ) : null}
          <div className="mih-risk-summary" aria-label="风险级别汇总">
            <span><strong>{riskCounts.critical || 0}</strong><small>严重</small></span>
            <span><strong>{riskCounts.high || 0}</strong><small>高危</small></span>
            <span><strong>{riskCounts.warning || 0}</strong><small>警告</small></span>
            <span><strong>{riskCounts.info || 0}</strong><small>信息</small></span>
          </div>
        </Panel>

        <Panel
          title="平台健康矩阵"
          subtitle="按当前窗口请求量排序；不暴露上游凭证或内部端点"
          className={`mih-command-panel--platforms${risks.length < 3 ? ' is-wide' : ''}`}
          action={<a className="mih-command-link" href="#/platforms">管理平台<ArrowRight size={13} aria-hidden="true" /></a>}
        >
          {platforms.length ? (
            <Table label="平台健康矩阵">
              <thead><tr><th>平台</th><th>状态</th><th>请求</th><th>成功率</th><th>异常结果</th><th>计量单位</th></tr></thead>
              <tbody>
                {platforms.slice(0, 8).map(([platform, item]) => {
                  const anomalies = Number(item.unknown || 0) + Number(item.released || 0)
                  return (
                    <tr key={platform}>
                      <td><strong>{platformLabel(platform)}</strong><small>{platform}</small></td>
                      <td><StatusBadge status={item.unknown ? 'warning' : item.released ? 'degraded' : 'active'} label={item.unknown ? '需核验' : item.released ? '有失败' : '健康'} /></td>
                      <td>{formatNumber(item.requests)}</td>
                      <td>{percent(item.committed, item.requests)}</td>
                      <td className={anomalies ? 'mih-table-value--danger' : ''}>{formatNumber(anomalies)}</td>
                      <td>{formatNumber(item.units)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </Table>
          ) : <EmptyState icon={Globe} title="暂无平台健康数据" description="平台用量会在第一笔真实请求完成后出现。" />}
        </Panel>
      </section>

      <footer className="mih-command-footer" aria-label="仪表盘状态">
        <span>时区：{browserTimeZone}</span>
        <span><i className="is-live" aria-hidden="true" />自动刷新：{autoRefresh ? '已开启（30 秒）' : '已暂停'}</span>
        <span>最后更新：{state.data?.asOf ? formatDate(state.data.asOf) : '尚未完成'}</span>
        <span>数据口径：网关计量事实</span>
      </footer>
    </>
  )
}

export function ConsumersPage({ token, session, query, setQuery, onUnauthorized, notify }) {
  const tenantId = query.get('tenantId') || ''
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [form, setForm] = useState({ tenantId: '', tenantName: '', name: '', businessId: '' })
  const [tenantDialog, setTenantDialog] = useState(null)
  const [tenantSaving, setTenantSaving] = useState(false)
  const [tenantError, setTenantError] = useState(null)

  const load = useCallback(async () => {
    const allTenants = (await adminApi.tenants(token)) || []
    const tenants = allTenants.filter((tenant) => tenantAllows(session, tenant.id, 'consumer.read'))
    const selectedTenantId = selectVisibleTenantId(tenants, tenantId, { aggregateWhenEmpty: true })
    const consumers = await adminApi.consumers(token, selectedTenantId)
    return { tenants, consumers: consumers || [], selectedTenantId }
  }, [session, tenantId, token])
  const state = useRemoteData(load, onUnauthorized)
  useEffect(() => {
    if (!state.loading && state.data && tenantId && tenantId !== state.data.selectedTenantId) {
      setQuery({ tenantId: state.data.selectedTenantId || null })
    }
  }, [setQuery, state.data, state.loading, tenantId])
  const tenants = (state.data?.tenants || []).filter((tenant) => (
    tenantAllows(session, tenant.id, 'consumer.read')
  ))
  const visibleTenantIds = new Set(tenants.map((tenant) => tenant.id))
  const consumers = (state.data?.consumers || []).filter((consumer) => (
    visibleTenantIds.has(consumer.tenantId)
  ))
  const selectedTenantId = state.data?.selectedTenantId || ''
  const visibleConsumers = consumers.filter((consumer) => consumer.name.toLowerCase().includes(search.trim().toLowerCase()))
  const tenantNames = new Map(tenants.map((tenant) => [tenant.id, tenant.name]))
  const consumerTenants = tenants.filter((tenant) => tenantAllows(session, tenant.id, 'consumer.write'))
  const canCreateConsumer = Boolean(session?.platformAdmin) || consumerTenants.length > 0
  const canCreateTenant = Boolean(session?.platformAdmin)

  const showCreate = () => {
    const targetTenantId = consumerTenants.some((tenant) => tenant.id === selectedTenantId)
      ? selectedTenantId
      : consumerTenants[0]?.id || ''
    setForm({ tenantId: targetTenantId, tenantName: '', name: '', businessId: '' })
    setFormError(null)
    setOpen(true)
  }

  const showTenantDialog = (tenant = null) => {
    setTenantError(null)
    setTenantDialog({ id: tenant?.id || null, name: tenant?.name || '' })
  }

  const saveTenant = async (event) => {
    event.preventDefault()
    setTenantSaving(true)
    setTenantError(null)
    try {
      if (tenantDialog.id) {
        await adminApi.renameTenant(token, tenantDialog.id, { name: tenantDialog.name })
        notify('租户名称已更新', 'success')
      } else {
        await adminApi.createTenant(token, { name: tenantDialog.name })
        notify('租户已创建', 'success')
      }
      setTenantDialog(null)
      state.refresh()
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      setTenantError(error)
    } finally {
      setTenantSaving(false)
    }
  }

  const create = async (event) => {
    event.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      let targetTenantId = form.tenantId
      if (!targetTenantId) {
        const tenant = await adminApi.createTenant(token, { name: form.tenantName })
        targetTenantId = tenant.id
      }
      await adminApi.createConsumer(token, {
        tenantId: targetTenantId,
        name: form.name,
        ...(session?.platformAdmin && form.businessId.trim() ? { businessId: form.businessId.trim() } : {}),
      })
      setOpen(false)
      if (targetTenantId !== selectedTenantId) setQuery({ tenantId: targetTenantId })
      else state.refresh()
      notify('调用者已创建', 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      setFormError(error)
    } finally {
      setSaving(false)
    }
  }

  if (state.loading && !state.data) return <LoadingState label="正在加载调用者" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading eyebrow="IDENTITY / TENANCY" title={session?.platformAdmin ? '调用者管理' : '我的调用身份'} description="调用者是 API Key、开放能力和用量归属的最小业务主体。" loading={state.loading} onRefresh={state.refresh}>
        {canCreateConsumer ? (
          <button className="qp-button qp-button--primary" type="button" onClick={showCreate}>
            <UserPlus size={17} aria-hidden="true" />新建调用者
          </button>
        ) : null}
      </PageHeading>
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      <Panel
        title="租户"
        subtitle={`${tenants.length} 个租户`}
        action={canCreateTenant ? (
          <button className="qp-button qp-button--outline" type="button" onClick={() => showTenantDialog()}>
            <Plus size={16} aria-hidden="true" />新建租户
          </button>
        ) : null}
      >
        {tenants.length ? (
          <Table label="租户列表">
            <thead><tr><th>名称</th><th>状态</th><th>更新时间</th><th>Tenant ID</th><th className="mih-table__actions">操作</th></tr></thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id}>
                  <td><strong>{tenant.name}</strong><small>调用者与用量的隔离边界</small></td>
                  <td><StatusBadge status={tenant.status} /></td>
                  <td>{formatDate(tenant.updatedAt)}</td>
                  <td><code className="mih-mono">{tenant.id}</code></td>
                  <td className="mih-table__actions">
                    {tenantAllows(session, tenant.id, 'tenant.write') ? (
                      <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => showTenantDialog(tenant)}>
                        <PencilSimple size={15} aria-hidden="true" />重命名
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Buildings}
            title="还没有租户"
            description="先创建租户，再把调用者和 API Key 归入对应的隔离边界。"
            action={canCreateTenant ? <button className="qp-button qp-button--outline" type="button" onClick={() => showTenantDialog()}><Plus size={16} aria-hidden="true" />新建租户</button> : null}
          />
        )}
      </Panel>
      <section className="qp-panel mih-filterbar">
        <FilterSelect
          label="租户"
          value={selectedTenantId}
          onChange={(value) => setQuery({ tenantId: value || null })}
          options={tenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
        />
        <Field label="搜索" className="mih-filter-field mih-filter-field--grow">
          <span className="qp-input-group">
            <span className="qp-input-group__prefix"><MagnifyingGlass size={16} aria-hidden="true" /></span>
            <input className="qp-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="名称" />
          </span>
        </Field>
      </section>
      <Panel title="调用者" subtitle={`${visibleConsumers.length} 条记录`}>
        {visibleConsumers.length ? (
          <Table label="调用者列表">
            <thead><tr><th>名称</th><th>租户</th>{session?.platformAdmin ? <th>兼容业务 ID</th> : null}<th>状态</th><th>创建时间</th><th>Consumer ID</th></tr></thead>
            <tbody>
              {visibleConsumers.map((consumer) => (
                <tr key={consumer.id}>
                  <td><strong>{consumer.name}</strong><small>独立权限与用量归属</small></td>
                  <td>{tenantNames.get(consumer.tenantId) || consumer.tenantId}</td>
                  {session?.platformAdmin ? <td><code className="mih-mono">{consumer.businessId}</code></td> : null}
                  <td><StatusBadge status={consumer.status} /></td>
                  <td>{formatDate(consumer.createdAt)}</td>
                  <td><code className="mih-mono">{consumer.id}</code></td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Users}
            title={search ? '没有匹配的调用者' : '还没有调用者'}
            description={search ? '请调整搜索条件。' : '创建调用者后，才能签发 API Key 并配置平台权限。'}
            action={!search && canCreateConsumer ? <button className="qp-button qp-button--outline" type="button" onClick={showCreate}><Plus size={16} aria-hidden="true" />新建调用者</button> : null}
          />
        )}
      </Panel>

      {open ? (
        <Modal
          title="新建调用者"
          description="调用者创建后可独立签发 Key、授权平台并统计用量。"
          onClose={() => !saving && setOpen(false)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setOpen(false)} disabled={saving}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="create-consumer" disabled={saving}>{saving ? '正在创建' : '创建调用者'}</button>
            </>
          )}
        >
          <form id="create-consumer" className="mih-form" onSubmit={create}>
            {consumerTenants.length ? (
              <DropdownField label="所属租户" value={form.tenantId}
                onChange={(tenantId) => setForm({ ...form, tenantId })}
                options={consumerTenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
                required autoFocus />
            ) : (
              <Field label="首个租户名称" hint="当前没有租户，提交时会先创建租户。">
                <input className="qp-input" value={form.tenantName} onChange={(event) => setForm({ ...form, tenantName: event.target.value })} required autoFocus />
              </Field>
            )}
            <Field label="调用者名称">
              <input className="qp-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：市场研究团队" required />
            </Field>
            {session?.platformAdmin ? (
              <Field label="兼容业务 ID（可选）" hint="仅迁移旧调用方时填写；创建后作为不可变调用归属。留空则由 Hub 自动生成。">
                <input className="qp-input" value={form.businessId} onChange={(event) => setForm({ ...form, businessId: event.target.value })} maxLength={128} placeholder="例如：risk-console" />
              </Field>
            ) : null}
            {formError ? <ErrorState error={formError} /> : null}
          </form>
        </Modal>
      ) : null}

      {tenantDialog ? (
        <Modal
          title={tenantDialog.id ? '重命名租户' : '新建租户'}
          description="租户是调用者、API Key、授权和用量的隔离边界。"
          onClose={() => !tenantSaving && setTenantDialog(null)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setTenantDialog(null)} disabled={tenantSaving}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="save-tenant" disabled={tenantSaving}>{tenantSaving ? '正在保存' : '保存租户'}</button>
            </>
          )}
        >
          <form id="save-tenant" className="mih-form" onSubmit={saveTenant}>
            <Field label="租户名称">
              <input className="qp-input" value={tenantDialog.name} onChange={(event) => setTenantDialog({ ...tenantDialog, name: event.target.value })} placeholder="例如：舟山租户" required autoFocus />
            </Field>
            {tenantError ? <ErrorState error={tenantError} /> : null}
          </form>
        </Modal>
      ) : null}
    </>
  )
}

export function ApiKeysPage({ token, session, query, setQuery, onUnauthorized, notify }) {
  const consumerId = query.get('consumerId') || ''
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [form, setForm] = useState({ consumerId: '', name: '', environment: 'live', expiresInDays: 180, platforms: [], capabilities: [] })
  const [scopeOptions, setScopeOptions] = useState({ platforms: [], capabilities: [] })
  const [scopeLoading, setScopeLoading] = useState(false)
  const scopeRequestRef = useRef(0)
  const [issuedSecret, setIssuedSecret] = useState(null)
  const [rotationSource, setRotationSource] = useState(null)
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revoking, setRevoking] = useState(false)
  const [overviewTarget, setOverviewTarget] = useState(null)
  const [overviewLoading, setOverviewLoading] = useState(false)
  const [overviewError, setOverviewError] = useState(null)

  const load = useCallback(async () => {
    const allConsumers = (await adminApi.consumers(token)) || []
    const consumers = allConsumers.filter((consumer) => tenantAllows(session, consumer.tenantId, 'apikey.read'))
    const selectedConsumerId = consumers.some((consumer) => consumer.id === consumerId) ? consumerId : ''
    const keys = consumers.length ? await adminApi.apiKeys(token, selectedConsumerId) : []
    const visibleConsumerIds = new Set(consumers.map((consumer) => consumer.id))
    return {
      consumers,
      keys: (keys || []).filter((key) => visibleConsumerIds.has(key.consumerId)),
      selectedConsumerId,
    }
  }, [consumerId, session, token])
  const state = useRemoteData(load, onUnauthorized)
  useEffect(() => {
    if (!state.loading && state.data && consumerId && consumerId !== state.data.selectedConsumerId) {
      setQuery({ consumerId: state.data.selectedConsumerId || null })
    }
  }, [consumerId, setQuery, state.data, state.loading])
  const consumers = state.data?.consumers || []
  const keys = state.data?.keys || []
  const selectedConsumerId = state.data?.selectedConsumerId || ''
  const writableConsumers = consumers.filter((consumer) => tenantAllows(session, consumer.tenantId, 'apikey.write'))
  const canIssueKey = writableConsumers.length > 0
  const consumerNames = new Map(consumers.map((consumer) => [consumer.id, consumer.name]))
  const compatibilityScopeOptions = scopeOptions.capabilities.filter((capability) => (
    CAPABILITY_CATALOG[capability]?.group === 'compatibility'
  ))
  const operationScopeOptions = scopeOptions.capabilities.filter((capability) => (
    CAPABILITY_CATALOG[capability]?.group !== 'compatibility'
  ))

  const applyScopes = async (targetConsumerId, requestedScopes = null) => {
    const generation = ++scopeRequestRef.current
    setScopeOptions({ platforms: [], capabilities: [] })
    setScopeLoading(true)
    const target = writableConsumers.find((consumer) => consumer.id === targetConsumerId)
    if (!target) {
      if (scopeRequestRef.current === generation) setScopeLoading(false)
      return
    }
    try {
      const configuration = await adminApi.platforms(token, { tenantId: target.tenantId, consumerId: target.id })
      if (scopeRequestRef.current !== generation) return
      const scopes = {
        platforms: [...(configuration?.grants || [])].sort(),
        capabilities: [...(configuration?.capabilityGrants || [])].sort(),
      }
      setScopeOptions(scopes)
      const selectedScopes = requestedScopes === 'legacy_all' ? scopes : requestedScopes ? {
        platforms: scopes.platforms.filter((value) => requestedScopes.platforms?.includes(value)),
        capabilities: scopes.capabilities.filter((value) => requestedScopes.capabilities?.includes(value)),
      } : { platforms: [], capabilities: [] }
      setForm((current) => current.consumerId === targetConsumerId
        ? { ...current, platforms: selectedScopes.platforms, capabilities: selectedScopes.capabilities }
        : current)
    } catch (error) {
      if (scopeRequestRef.current !== generation) return
      if (error?.status === 401) onUnauthorized(error)
      setFormError(error)
    } finally {
      if (scopeRequestRef.current === generation) setScopeLoading(false)
    }
  }

  const showCreate = async () => {
    const targetConsumerId = writableConsumers.some((consumer) => consumer.id === selectedConsumerId)
      ? selectedConsumerId
      : writableConsumers[0]?.id || ''
    setForm({ consumerId: targetConsumerId, name: '', environment: 'live', expiresInDays: 180, platforms: [], capabilities: [] })
    setScopeOptions({ platforms: [], capabilities: [] })
    setRotationSource(null)
    setFormError(null)
    setOpen(true)
    await applyScopes(targetConsumerId)
  }

  const showRotate = async (key) => {
    if (key.status !== 'active' || !writableConsumers.some((consumer) => consumer.id === key.consumerId)) return
    setForm({
      consumerId: key.consumerId,
      name: `${key.name} · 替代`.slice(0, 128),
      environment: key.environment === 'test' || key.prefix?.startsWith('mih_test_') ? 'test' : 'live',
      expiresInDays: 180,
      platforms: [],
      capabilities: [],
    })
    setScopeOptions({ platforms: [], capabilities: [] })
    setRotationSource(key)
    setFormError(null)
    setOpen(true)
    await applyScopes(key.consumerId, key.scopeMode === 'legacy_dynamic' ? 'legacy_all' : {
      platforms: key.platforms || [],
      capabilities: key.capabilities || [],
    })
  }

  const changeFormConsumer = async (targetConsumerId) => {
    setForm((current) => ({ ...current, consumerId: targetConsumerId, platforms: [], capabilities: [] }))
    setFormError(null)
    await applyScopes(targetConsumerId)
  }

  const toggleScope = (field, value) => setForm((current) => ({
    ...current,
    [field]: current[field].includes(value)
      ? current[field].filter((entry) => entry !== value)
      : [...current[field], value].sort(),
  }))

  const create = async (event) => {
    event.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const key = await adminApi.createApiKey(token, form)
      setOpen(false)
      setIssuedSecret({
        secret: key.secret,
        expiresAt: key.expiresAt,
        tenantId: key.tenantId,
        consumerId: key.consumerId,
        replaces: rotationSource,
      })
      setRotationSource(null)
      state.refresh()
      notify('API Key 已签发', 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      setFormError(error)
    } finally {
      setSaving(false)
    }
  }

  const revoke = async () => {
    setRevoking(true)
    try {
      await adminApi.revokeApiKey(token, revokeTarget.id)
      setRevokeTarget(null)
      state.refresh()
      notify('API Key 已撤销', 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      notify(error.message || '撤销失败', 'danger')
    } finally {
      setRevoking(false)
    }
  }

  const showOverview = async (key) => {
    setOverviewTarget({ key, data: null })
    setOverviewError(null)
    setOverviewLoading(true)
    try {
      const data = await adminApi.apiKeyOverview(token, key.id)
      setOverviewTarget((current) => current?.key.id === key.id ? { key, data } : current)
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      setOverviewError(error)
    } finally {
      setOverviewLoading(false)
    }
  }

  if (state.loading && !state.data) return <LoadingState label="正在加载 API Keys" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading eyebrow="ACCESS / ROTATION / REVOCATION" title="API Keys" description="每把 Key 在签发时固化平台与能力范围，并独立统计用量。调用者授权减少会立即收窄现有 Key；新增授权需要重新签发。默认有效期 180 天。" loading={state.loading} onRefresh={state.refresh}>
        {canIssueKey ? (
          <button className="qp-button qp-button--primary" type="button" onClick={showCreate}>
            <Plus size={17} aria-hidden="true" />签发 API Key
          </button>
        ) : null}
      </PageHeading>
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      <section className="qp-panel mih-filterbar">
        <FilterSelect
          label="调用者"
          value={selectedConsumerId}
          onChange={(value) => setQuery({ consumerId: value || null })}
          options={consumers.map((consumer) => ({ value: consumer.id, label: consumer.name }))}
        />
      </section>
      <Panel title="已签发密钥" subtitle={`${keys.length} 条记录`}>
        {keys.length ? (
          <Table label="API Key 列表">
            <thead><tr><th>名称</th><th>调用者</th><th>密钥标识（不可用于调用）</th><th>授权范围</th><th>环境</th><th>状态</th><th>有效至</th><th>最后使用</th><th><span className="mih-sr-only">操作</span></th></tr></thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td><strong>{key.name}</strong><small>{formatDate(key.createdAt)} 签发</small></td>
                  <td>{consumerNames.get(key.consumerId) || key.consumerId}</td>
                  <td><code className="mih-mono">{key.prefix}****{key.lastFour}</code><small>仅用于核对；完整 secret 只在签发时显示一次</small></td>
                  <td><strong>{key.platforms?.length || 0} 平台 · {key.capabilities?.length || 0} 能力</strong><small>{[...(key.platforms || []), ...(key.capabilities || [])].join('、') || '无调用权限'}</small></td>
                  <td>
                    <strong>{key.environment === 'test' || key.prefix?.startsWith('mih_test_') ? 'Test · 兼容标签' : 'Live'}</strong>
                    <small>{key.environment === 'test' || key.prefix?.startsWith('mih_test_') ? '非沙箱；外部电商接口拒绝使用' : '正式开放能力凭据'}</small>
                  </td>
                  <td><StatusBadge status={key.effectiveStatus || key.status} /></td>
                  <td>{formatDate(key.expiresAt)}</td>
                  <td>{formatDate(key.lastUsedAt)}</td>
                  <td className="mih-table__actions mih-table__actions--wide">
                    <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => showOverview(key)}>
                      <ChartLine size={15} aria-hidden="true" />额度与用量
                    </button>
                    {tenantAllows(session, key.tenantId, 'platform.write') ? (
                      <a
                        className="qp-button qp-button--ghost qp-button--sm"
                        href={`#/platforms?${new URLSearchParams({ tenantId: key.tenantId, consumerId: key.consumerId })}`}
                        aria-label={`配置 ${key.name} 所属调用身份的开放能力`}
                      >
                        <SlidersHorizontal size={15} aria-hidden="true" />配置开放能力
                      </a>
                    ) : null}
                    {tenantAllows(session, key.tenantId, 'apikey.write') ? (
                      <>
                        <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={key.status !== 'active'} onClick={() => showRotate(key)}>
                          <ArrowClockwise size={15} aria-hidden="true" />签发替代 Key
                        </button>
                        <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`撤销 ${key.name}`} disabled={key.status !== 'active'} onClick={() => setRevokeTarget(key)}>
                          <Trash size={17} aria-hidden="true" />
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Key}
            title={consumers.length ? '还没有 API Key' : '请先创建调用者'}
            description={consumers.length ? '签发后完整 secret 只展示一次。' : 'API Key 必须归属于一个调用者。'}
            action={canIssueKey ? <button className="qp-button qp-button--outline" type="button" onClick={showCreate}><Plus size={16} aria-hidden="true" />签发 API Key</button> : !consumers.length ? <a className="qp-button qp-button--outline" href="#/consumers"><Users size={16} aria-hidden="true" />前往调用者</a> : null}
          />
        )}
      </Panel>

      {open ? (
        <Modal
          title={rotationSource ? '签发替代 API Key' : '签发 API Key'}
          description={rotationSource
            ? '先签发不超过旧 Key 有效范围的替代 Key；安全保存并完成客户端切换后，再显式撤销旧 Key。'
            : '新 Key 默认不包含任何平台或能力，也可保持零权限；需要调用时再显式勾选不可变范围。完整 secret 只显示一次。'}
          onClose={() => {
            if (!saving) {
              scopeRequestRef.current += 1
              setOpen(false)
              setRotationSource(null)
            }
          }}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setOpen(false)} disabled={saving}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="create-api-key" disabled={saving || scopeLoading}>{saving ? '正在签发' : rotationSource ? '签发替代 Key' : '签发密钥'}</button>
            </>
          )}
        >
          <form id="create-api-key" className="mih-form" onSubmit={create}>
            <DropdownField label="调用者" value={form.consumerId}
              onChange={changeFormConsumer}
              options={writableConsumers.map((consumer) => ({ value: consumer.id, label: consumer.name }))}
              disabled={scopeLoading || Boolean(rotationSource)}
              required autoFocus />
            <Field label="密钥名称">
              <input className="qp-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：数据分析生产环境" required />
            </Field>
            <Field label="数据域 / 来源范围" hint="决定可访问哪类数据；只展示调用者当前授权，扩大范围需要签发新 Key。">
              <div className="mih-key-scopes">
                {scopeOptions.platforms.map((platform) => (
                  <label key={platform}><input type="checkbox" checked={form.platforms.includes(platform)} disabled={Boolean(rotationSource && rotationSource.scopeMode !== 'legacy_dynamic' && !rotationSource.platforms?.includes(platform))} onChange={() => toggleScope('platforms', platform)} /><span>{platformLabel(platform)}</span><small>{platform}</small></label>
                ))}
                {!scopeLoading && scopeOptions.platforms.length === 0 ? <small>暂无平台授权，请先到“开放能力”配置。</small> : null}
              </div>
            </Field>
            <Field label="业务操作" hint="决定 Key 可以执行什么；产生外部费用的操作不随数据域授权自动开启。">
              <div className="mih-key-scopes">
                {operationScopeOptions.map((capability) => (
                  <label key={capability}><input type="checkbox" checked={form.capabilities.includes(capability)} disabled={Boolean(rotationSource && rotationSource.scopeMode !== 'legacy_dynamic' && !rotationSource.capabilities?.includes(capability))} onChange={() => toggleScope('capabilities', capability)} /><span>{CAPABILITY_CATALOG[capability]?.label || capability}</span><small>{capability}</small></label>
                ))}
                {!scopeLoading && operationScopeOptions.length === 0 ? <small>暂无业务操作授权。</small> : null}
              </div>
            </Field>
            <Field label="兼容接口合同" hint="仅授权 provider-compatible 接口形状；仍需同时勾选对应数据域和业务操作。">
              <div className="mih-key-scopes">
                {compatibilityScopeOptions.map((capability) => (
                  <label key={capability}><input type="checkbox" checked={form.capabilities.includes(capability)} disabled={Boolean(rotationSource && rotationSource.scopeMode !== 'legacy_dynamic' && !rotationSource.capabilities?.includes(capability))} onChange={() => toggleScope('capabilities', capability)} /><span>{CAPABILITY_CATALOG[capability]?.label || capability}</span><small>{capability}</small></label>
                ))}
                {!scopeLoading && compatibilityScopeOptions.length === 0 ? <small>暂无兼容接口合同授权。</small> : null}
              </div>
            </Field>
            <Field label="有效期（天）" hint="默认 180 天；可设置 1–730 天，到期后立即拒绝认证。">
              <input
                className="qp-input"
                type="number"
                min="1"
                max="730"
                step="1"
                value={form.expiresInDays}
                onChange={(event) => setForm({ ...form, expiresInDays: Number(event.target.value) })}
                required
              />
            </Field>
            {formError ? <ErrorState error={formError} /> : null}
          </form>
        </Modal>
      ) : null}

      {issuedSecret ? (
        <Modal
          title={issuedSecret.replaces ? '替代 API Key 已签发' : 'API Key 已签发'}
          description={issuedSecret.replaces
            ? `这是唯一一次显示完整密钥；有效至 ${formatDate(issuedSecret.expiresAt)}。旧 Key 保持有效，请先安全保存、更新客户端并验证，再撤销旧 Key。`
            : `这是唯一一次显示完整密钥；有效至 ${formatDate(issuedSecret.expiresAt)}。该 Key 只能调用签发时勾选、且调用者当前仍允许的范围。`}
          onClose={() => setIssuedSecret(null)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setIssuedSecret(null)}>{issuedSecret.replaces ? '先保留旧 Key' : '我已安全保存'}</button>
              {issuedSecret.replaces ? (
                <button className="qp-button qp-button--danger" type="button" onClick={() => { setRevokeTarget(issuedSecret.replaces); setIssuedSecret(null) }}>已切换并验证，撤销旧 Key</button>
              ) : tenantAllows(session, issuedSecret.tenantId, 'platform.write') ? (
                <a
                  className="qp-button qp-button--primary"
                  href={`#/platforms?${new URLSearchParams({ tenantId: issuedSecret.tenantId, consumerId: issuedSecret.consumerId })}`}
                  onClick={() => setIssuedSecret(null)}
                >
                  我已保存，配置开放能力
                </a>
              ) : (
                <a className="qp-button qp-button--primary" href="#/plans" onClick={() => setIssuedSecret(null)}>查看套餐、余额与用量</a>
              )}
            </>
          )}
        >
          <SecretPanel secret={issuedSecret.secret} onCopied={() => notify('密钥已复制', 'success')} />
        </Modal>
      ) : null}

      {revokeTarget ? (
        <Modal
          title="撤销 API Key"
          description="撤销后所有使用此密钥的请求都会立即失败，且不能恢复。"
          onClose={() => !revoking && setRevokeTarget(null)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setRevokeTarget(null)} disabled={revoking}>取消</button>
              <button className="qp-button qp-button--danger" type="button" onClick={revoke} disabled={revoking}>{revoking ? '正在撤销' : '确认撤销'}</button>
            </>
          )}
        >
          <div className="mih-confirm-copy"><WarningCircle size={26} weight="duotone" aria-hidden="true" /><p>将撤销 <strong>{revokeTarget.name}</strong>（{revokeTarget.prefix}****{revokeTarget.lastFour}）。</p></div>
        </Modal>
      ) : null}

      {overviewTarget ? (
        <Modal
          title={`${overviewTarget.key.name} · 额度与用量`}
          description="这里的调用量只属于这一把 Key；套餐总额仍由同一调用者下的所有 Key 共享。"
          onClose={() => !overviewLoading && setOverviewTarget(null)}
          footer={<button className="qp-button qp-button--primary" type="button" onClick={() => setOverviewTarget(null)} disabled={overviewLoading}>关闭</button>}
        >
          {overviewLoading && !overviewTarget.data ? <LoadingState label="正在读取 Key 用量" /> : null}
          {overviewError ? <ErrorState error={overviewError} onRetry={() => showOverview(overviewTarget.key)} /> : null}
          {overviewTarget.data ? (
            <div className="mih-form">
              <section className="mih-metric-grid mih-metric-grid--compact">
                <MetricCard icon={Pulse} label="累计请求" value={formatNumber(overviewTarget.data.usage?.requests || 0)} hint={`已提交 ${formatNumber(overviewTarget.data.usage?.committed || 0)}`} />
                <MetricCard icon={Coins} label="所属套餐" value={overviewTarget.data.plan?.name || '未分配'} hint={overviewTarget.data.plan ? `${overviewTarget.data.plan.key} · v${overviewTarget.data.plan.version}` : '无套餐总额'} />
                <MetricCard icon={Globe} label="平台范围" value={formatNumber(overviewTarget.data.platformEntitlements?.length || 0)} hint={overviewTarget.key.scopeMode === 'legacy_dynamic' ? '历史 Key · 跟随调用者授权' : '签发快照'} />
                <MetricCard icon={Brain} label="能力范围" value={formatNumber(overviewTarget.data.capabilityEntitlements?.length || 0)} hint="平台与付费能力需同时满足" />
              </section>
              <Table label="API Key 平台与能力额度">
                <thead><tr><th>范围</th><th>窗口请求</th><th>窗口秒数</th><th>最大分页</th></tr></thead>
                <tbody>
                  {(overviewTarget.data.platformEntitlements || []).map((entry) => (
                    <tr key={`platform:${entry.platform}`}><td><strong>{platformLabel(entry.platform)}</strong><small>{entry.platform}</small></td><td>{formatNumber(entry.maxRequests)}</td><td>{formatNumber(entry.windowSeconds)}</td><td>{formatNumber(entry.maxPageSize)}</td></tr>
                  ))}
                  {(overviewTarget.data.capabilityEntitlements || []).map((entry) => (
                    <tr key={`capability:${entry.capability}`}><td><strong>{CAPABILITY_CATALOG[entry.capability]?.label || entry.capability}</strong><small>{entry.capability}</small></td><td>{formatNumber(entry.maxRequests)}</td><td>{formatNumber(entry.windowSeconds)}</td><td>—</td></tr>
                  ))}
                </tbody>
              </Table>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </>
  )
}

async function loadConfigurationContext(token, requestedTenantId, requestedConsumerId, session) {
  const [tenants, allConsumers] = await Promise.all([adminApi.tenants(token), adminApi.consumers(token)])
  const safeTenants = (tenants || []).filter((tenant) => tenantAllows(session, tenant.id, 'consumer.read'))
  const visibleTenantIds = new Set(safeTenants.map((tenant) => tenant.id))
  const safeConsumers = (allConsumers || []).filter((consumer) => visibleTenantIds.has(consumer.tenantId))
  const tenantId = selectVisibleTenantId(safeTenants, requestedTenantId)
  const consumers = safeConsumers.filter((consumer) => !tenantId || consumer.tenantId === tenantId)
  const consumerId = consumers.some((consumer) => consumer.id === requestedConsumerId)
    ? requestedConsumerId
    : consumers[0]?.id || ''
  const configuration = tenantId && consumerId
    ? await adminApi.platforms(token, { tenantId, consumerId })
    : { grants: [], policies: [] }
  return {
    tenants: safeTenants,
    consumers,
    tenantId,
    consumerId,
    configuration,
    // Which selection this result answers. Without it a caller cannot tell a
    // deliberate server-side redirect (the requested tenant is not visible)
    // from data that simply predates the selection being made.
    requestedContext: selectionContext(requestedTenantId, requestedConsumerId),
  }
}

export function PlansQuotasPage({ token, session, query, setQuery, onUnauthorized, notify }) {
  const requestedTenantId = query.get('tenantId') || ''
  const requestedConsumerId = query.get('consumerId') || ''
  const requestedContext = `${requestedTenantId}\u0000${requestedConsumerId}`
  const contextRef = useRef(requestedContext)
  contextRef.current = requestedContext
  const [assigningPlanVersionId, setAssigningPlanVersionId] = useState('')
  const [creditOpen, setCreditOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [billingBusy, setBillingBusy] = useState('')
  const [billingError, setBillingError] = useState(null)
  const [creditForm, setCreditForm] = useState({ amount: '', currency: 'CNY', reason: '', externalReference: '' })
  const [profileForm, setProfileForm] = useState({ mode: 'shadow', multiplier: '1.000000' })
  const [planForm, setPlanForm] = useState({
    key: '',
    name: '',
    priceBookKey: '',
    currency: 'CNY',
    defaultMultiplier: '1.000000',
    monthlyRequests: '1000000',
    burstRps: '100',
    maxPageSize: '100',
    entries: [{ meterKey: '', price: '' }],
  })
  const load = useCallback(async () => {
    const context = await loadConfigurationContext(token, requestedTenantId, requestedConsumerId, session)
    const billingPromise = context.tenantId
      ? adminApi.tenantBilling(token, context.tenantId)
      : Promise.resolve({ profile: null, account: null, ledger: [] })
    if (!context.consumerId) {
      return {
        ...context,
        plans: { catalog: [], currentPlan: null },
        usage: {},
        billing: await billingPromise,
      }
    }
    const monthStart = new Date()
    monthStart.setUTCDate(1)
    monthStart.setUTCHours(0, 0, 0, 0)
    const [plans, usage, billing] = await Promise.all([
      adminApi.plans(token, context.consumerId),
      adminApi.usage(token, { consumerId: context.consumerId, from: monthStart.toISOString() }),
      billingPromise,
    ])
    return {
      ...context,
      plans: plans || { catalog: [], currentPlan: null },
      usage: usage || {},
      billing: billing || { profile: null, account: null, ledger: [] },
    }
  }, [requestedConsumerId, requestedTenantId, session, token])
  const state = useRemoteData(load, onUnauthorized)
  useEffect(() => {
    // Only act on a result that answers the selection currently in the URL.
    // `state.loading` is not enough on its own: the refetch triggered by a new
    // selection is still queued on the render where this first runs, so the
    // previous tenant's data is briefly paired with the new request and would
    // be read as a rejected selection -- snapping the picker back and making
    // it look as though tenants cannot be switched.
    if (state.loading || !state.data) return
    if (state.data.requestedContext !== selectionContext(requestedTenantId, requestedConsumerId)) return
    const tenantMismatch = requestedTenantId && requestedTenantId !== state.data.tenantId
    const consumerMismatch = requestedConsumerId && requestedConsumerId !== state.data.consumerId
    if (tenantMismatch || consumerMismatch) {
      setQuery({ tenantId: state.data.tenantId || null, consumerId: state.data.consumerId || null })
    }
  }, [requestedConsumerId, requestedTenantId, setQuery, state.data, state.loading])

  if (state.loading && !state.data) return <LoadingState label="正在加载配额策略" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const data = state.data || { tenants: [], consumers: [], configuration: { grants: [], policies: [] } }
  const policies = data.configuration?.policies || []
  const grants = new Set(data.configuration?.grants || [])
  const capabilityPolicies = data.configuration?.capabilityPolicies || []
  const capabilityGrants = new Set(data.configuration?.capabilityGrants || [])
  const platformHref = `#/platforms?${new URLSearchParams({ tenantId: data.tenantId || '', consumerId: data.consumerId || '' })}`
  const selectedConsumer = data.consumers.find((consumer) => consumer.id === data.consumerId)
  const canManagePlatform = tenantAllows(session, selectedConsumer?.tenantId, 'platform.write')
  const currentPlan = data.plans?.currentPlan
  const planLimits = currentPlan?.limits || {}
  const monthlyUsed = Number(data.usage?.requests || 0)
  const monthlyLimit = Number(planLimits.monthlyRequests || 0)
  const monthlyRemaining = monthlyLimit > 0 ? Math.max(0, monthlyLimit - monthlyUsed) : null
  const billing = data.billing || { profile: null, account: null, ledger: [] }
  const account = billing.account
  const customerBilling = data.usage?.customerBilling || {}
  const billingCurrency = account?.currency || customerBilling.currency || currentPlan?.priceBook?.currency || 'CNY'
  const effectiveRates = currentPlan?.customerRates || (currentPlan?.priceBook?.entries || []).map((entry) => ({
    meterKey: entry.meterKey,
    billingUnit: entry.billingUnit,
    unitPriceMinor: effectivePriceMinor(
      entry.unitPriceMinor,
      billing.profile?.multiplierPpm ?? currentPlan.priceBook.defaultMultiplierPpm,
    ),
    currency: currentPlan.priceBook.currency,
  }))
  const newerPricedVersion = (data.plans?.catalog || []).find((plan) => (
    plan.key === currentPlan?.key
    && Number(plan.version) > Number(currentPlan?.version || 0)
    && Boolean(plan.priceBook)
  )) || null
  const canAssignPlan = Boolean(
    session?.platformAdmin
    && data.consumerId
    && Number.isInteger(currentPlan?.revision)
    && currentPlan.revision > 0,
  )

  const openPlanPublisher = (sourcePlan = currentPlan) => {
    const reusablePlan = sourcePlan?.key === 'legacy-unmetered' ? null : sourcePlan
    const planKey = reusablePlan?.key || ''
    setBillingError(null)
    setPlanForm({
      key: planKey,
      name: reusablePlan?.name || '',
      priceBookKey: planKey ? `${planKey.slice(0, 60)}-cny` : '',
      currency: 'CNY',
      defaultMultiplier: '1.000000',
      monthlyRequests: String(reusablePlan?.limits?.monthlyRequests || 1000000),
      burstRps: String(reusablePlan?.limits?.burstRps || 100),
      maxPageSize: String(reusablePlan?.limits?.maxPageSize || 100),
      entries: [{ meterKey: '', price: '' }],
    })
    setPlanOpen(true)
  }

  const refreshCurrentContext = async () => {
    const targetContext = contextRef.current
    const refreshed = await load()
    if (contextRef.current === targetContext) state.setData(refreshed)
  }

  const saveCredit = async (event) => {
    event.preventDefault()
    if (!session?.platformAdmin || !data.tenantId || billingBusy) return
    const amountMinor = decimalToMinor(creditForm.amount)
    if (!amountMinor || amountMinor <= 0) {
      setBillingError(new Error('充值金额必须是大于 0、最多两位小数的金额。'))
      return
    }
    setBillingBusy('credit')
    setBillingError(null)
    try {
      await adminApi.addTenantCredit(token, data.tenantId, {
        amountMinor,
        currency: creditForm.currency,
        reason: creditForm.reason,
        ...(creditForm.externalReference.trim() ? { externalReference: creditForm.externalReference.trim() } : {}),
      }, `credit-${crypto.randomUUID()}`)
      await refreshCurrentContext()
      setCreditOpen(false)
      setCreditForm({ amount: '', currency: billingCurrency, reason: '', externalReference: '' })
      notify?.('租户余额已通过不可变账本入账', 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      setBillingError(error)
    } finally {
      setBillingBusy('')
    }
  }

  const openProfile = () => {
    setBillingError(null)
    setProfileForm({
      mode: billing.profile?.mode || 'disabled',
      multiplier: billing.profile?.multiplierPpm == null
        ? ''
        : (Number(billing.profile.multiplierPpm) / 1_000_000).toFixed(6),
    })
    setProfileOpen(true)
  }

  const saveProfile = async (event) => {
    event.preventDefault()
    if (!session?.platformAdmin || !data.tenantId || billingBusy) return
    const multiplierPpm = profileForm.multiplier.trim()
      ? multiplierToPpm(profileForm.multiplier)
      : null
    if (profileForm.multiplier.trim() && multiplierPpm == null) {
      setBillingError(new Error('租户倍率必须是 0–100 之间、最多六位小数的数值。'))
      return
    }
    setBillingBusy('profile')
    setBillingError(null)
    try {
      await adminApi.updateTenantBillingProfile(token, data.tenantId, {
        mode: profileForm.mode,
        multiplierPpm,
        ...(billing.profile?.revision > 0 ? { expectedRevision: billing.profile.revision } : {}),
      })
      await refreshCurrentContext()
      setProfileOpen(false)
      notify?.('租户计费策略已更新；既有请求价格快照不会变化', 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      setBillingError(error)
    } finally {
      setBillingBusy('')
    }
  }

  const updatePlanEntry = (index, patch) => setPlanForm((current) => ({
    ...current,
    entries: current.entries.map((entry, entryIndex) => (
      entryIndex === index ? { ...entry, ...patch } : entry
    )),
  }))

  const publishPlan = async (event) => {
    event.preventDefault()
    if (!session?.platformAdmin || billingBusy) return
    const entries = planForm.entries.map((entry) => ({
      meterKey: entry.meterKey.trim(),
      unitPriceMinor: decimalToMinor(entry.price),
    })).filter((entry) => entry.meterKey && entry.unitPriceMinor != null)
    const defaultMultiplierPpm = multiplierToPpm(planForm.defaultMultiplier)
    if (!entries.length || defaultMultiplierPpm == null) {
      setBillingError(new Error('至少填写一项有效接口价格，并检查默认倍率。'))
      return
    }
    setBillingBusy('plan')
    setBillingError(null)
    try {
      await adminApi.publishPlan(token, {
        key: planForm.key,
        name: planForm.name,
        limits: {
          monthlyRequests: Number(planForm.monthlyRequests),
          maxPageSize: Number(planForm.maxPageSize),
          burstRps: Number(planForm.burstRps),
        },
        priceBook: {
          key: planForm.priceBookKey,
          currency: planForm.currency,
          defaultMultiplierPpm,
          entries,
        },
      })
      await refreshCurrentContext()
      setPlanOpen(false)
      notify?.('新的不可变套餐版本已发布；需显式分配后才会生效', 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      setBillingError(error)
    } finally {
      setBillingBusy('')
    }
  }

  const assignPlan = async (plan) => {
    if (
      !canAssignPlan
      || assigningPlanVersionId
      || plan.versionId === currentPlan.versionId
      || plan.key === 'legacy-unmetered'
    ) return
    const targetContext = contextRef.current
    const targetConsumerId = data.consumerId
    setAssigningPlanVersionId(plan.versionId)
    try {
      await adminApi.assignConsumerPlan(token, targetConsumerId, {
        planVersionId: plan.versionId,
        expectedRevision: currentPlan.revision,
      })
      const refreshed = await load()
      if (contextRef.current === targetContext) state.setData(refreshed)
      notify?.(`调用者「${selectedConsumer?.name || targetConsumerId}」已分配 ${plan.name} v${plan.version}`, 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      notify?.(error.message || '套餐分配失败，请刷新后重试', 'danger')
    } finally {
      setAssigningPlanVersionId('')
    }
  }

  return (
    <>
      <PageHeading eyebrow="PLANS / LIMITS / CREDITS" title="套餐与配额" description="套餐总额、调用者策略与 API Key 签发额度同时生效；每次请求会受其中最严格的边界约束。" loading={state.loading} onRefresh={state.refresh}>
        {session?.platformAdmin ? <button className="qp-button qp-button--primary" type="button" onClick={() => { setBillingError(null); setCreditForm((current) => ({ ...current, currency: billingCurrency })); setCreditOpen(true) }} disabled={!data.tenantId}><Plus size={17} aria-hidden="true" />人工充值</button> : null}
        {session?.platformAdmin ? <button className="qp-button qp-button--outline" type="button" onClick={openProfile} disabled={!data.tenantId}><SlidersHorizontal size={17} aria-hidden="true" />计费策略</button> : null}
        {session?.platformAdmin ? <button className="qp-button qp-button--outline" type="button" onClick={() => openPlanPublisher()}><Coins size={17} aria-hidden="true" />发布套餐版本</button> : null}
        {canManagePlatform ? <a className="qp-button qp-button--outline" href={platformHref}><SlidersHorizontal size={17} aria-hidden="true" />管理开放能力</a> : null}
      </PageHeading>
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      <section className="qp-panel mih-filterbar">
        <FilterSelect
          label="租户"
          value={data.tenantId}
          onChange={(value) => setQuery({ tenantId: value || null, consumerId: null })}
          options={data.tenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
          emptyLabel="请选择租户"
        />
        <FilterSelect
          label="调用者"
          value={data.consumerId}
          onChange={(value) => setQuery({ tenantId: data.tenantId || null, consumerId: value || null })}
          options={data.consumers.map((consumer) => ({ value: consumer.id, label: consumer.name }))}
          emptyLabel="请选择调用者"
        />
      </section>

      <section className="mih-metric-grid mih-metric-grid--compact" aria-label="当前套餐与配额基线">
        <MetricCard icon={Coins} label="可用余额" value={account ? formatMoneyMinor(account.availableMinor, account.currency) : '未开户'} hint={account ? `冻结 ${formatMoneyMinor(account.heldMinor, account.currency)}` : '由平台管理员首次入账时开户'} tone="success" />
        <MetricCard icon={ShieldCheck} label="计费状态" value={({ disabled: '未启用', shadow: '影子计价', enforced: '余额门禁' })[billing.profile?.mode] || '未启用'} hint={session?.platformAdmin && billing.profile?.multiplierPpm != null ? `租户倍率 ${(Number(billing.profile.multiplierPpm) / 1_000_000).toFixed(4)}×` : '租户只看到最终成交价'} tone={billing.profile?.mode === 'enforced' ? 'warning' : 'info'} />
        <MetricCard icon={ChartLine} label="本月已扣" value={formatMoneyMinor(customerBilling.chargedMinor || 0, customerBilling.currency || billingCurrency)} hint={`报价 ${formatMoneyMinor(customerBilling.quotedMinor || 0, customerBilling.currency || billingCurrency)}`} tone="warning" />
        <MetricCard icon={Timer} label="请求冻结" value={formatMoneyMinor(customerBilling.heldMinor || 0, customerBilling.currency || billingCurrency)} hint="结果未知时继续冻结，待对账后结算" tone="archetype" />
        <MetricCard icon={Coins} label="当前套餐" value={currentPlan?.name || '未分配'} hint={currentPlan ? `${currentPlan.key} · v${currentPlan.version} · 修订 ${currentPlan.revision}` : '请联系平台管理员'} />
        <MetricCard icon={Pulse} label="本月请求" value={formatNumber(monthlyUsed)} hint={monthlyRemaining == null ? '历史兼容：不设月总额' : `剩余 ${formatNumber(monthlyRemaining)} / ${formatNumber(monthlyLimit)}`} />
        <MetricCard icon={Timer} label="套餐突发边界" value={planLimits.burstRps ? `${formatNumber(planLimits.burstRps)} RPS` : '不限制'} hint={planLimits.windowSeconds ? `${formatNumber(planLimits.maxRequests)} / ${formatNumber(planLimits.windowSeconds)} 秒` : '平台与 Key 滑动窗口仍独立生效'} tone="info" />
        <MetricCard icon={Database} label="套餐最大分页" value={planLimits.maxPageSize ? formatNumber(planLimits.maxPageSize) : '按策略'} hint="与 Key ceiling 取最小值" tone="warning" />
        <MetricCard icon={Globe} label="已授权平台" value={formatNumber(grants.size)} hint="按调用者显式授权" tone="success" />
        <MetricCard icon={Brain} label="已授权通用能力" value={formatNumber(capabilityGrants.size)} hint="不隐含数据读取权" tone="info" />
      </section>

      {session?.platformAdmin && currentPlan?.pricing?.mode === 'operator_price_book' && !currentPlan?.priceBook && !newerPricedVersion ? (
        <Panel
          title="费率尚未配置"
          subtitle="当前套餐只限制配额、不向租户扣费。下游费率尚未确定，需运营方核对上游成本、目标毛利与客户合同后显式录入；计费单位是一次被 Hub 接受的逻辑请求，不按实际上游调用次数累加。成功交付才扣费，安全失败释放，发布后也不会自动分配。"
          action={(
            <div className="mih-page-actions">
              <button className="qp-button qp-button--primary qp-button--sm" type="button" onClick={() => openPlanPublisher(currentPlan)}><Coins size={16} aria-hidden="true" />录入费率草案</button>
            </div>
          )}
        >
          <Table label="小红书待定价能力">
            <thead><tr><th>开放能力</th><th>计量键</th><th>当前费率</th><th>交付口径</th></tr></thead>
            <tbody>
              <tr><td><strong>小红书笔记搜索</strong></td><td><code>social.posts.search</code></td><td><strong>待运营定价</strong></td><td>每个 Hub 搜索逻辑请求产生 1 条计价记录；成功交付扣费，正文补全和上游调用不另计</td></tr>
              <tr><td><strong>小红书笔记详情</strong></td><td><code>social.posts.resolve</code></td><td><strong>待运营定价</strong></td><td>每个 Hub 笔记详情逻辑请求产生 1 条计价记录；成功交付扣费，上游调用不另计</td></tr>
              <tr><td><strong>小红书用户资料</strong></td><td><code>social.users.resolve</code></td><td><strong>待运营定价</strong></td><td>每个 Hub 用户资料逻辑请求产生 1 条计价记录；成功交付扣费，账号解析和上游调用不另计</td></tr>
              <tr><td><strong>小红书用户笔记</strong></td><td><code>social.users.posts</code></td><td><strong>待运营定价</strong></td><td>每个 Hub 用户笔记逻辑请求产生 1 条计价记录；成功交付扣费，账号解析、资料与笔记抓取等上游调用不另计</td></tr>
              <tr><td><strong>租户合同倍率</strong></td><td><code>customer multiplier</code></td><td><strong>由合同确定</strong></td><td>需按合同人工设置，不会自动生效</td></tr>
            </tbody>
          </Table>
          <p className="mih-inline-warning"><WarningCircle size={17} aria-hidden="true" /><span>上游价目、免费额度或账单证据不完整时，未知成本不能当作 0。只有运营方显式录入、发布并分配新版本后才会产生客户报价。</span></p>
        </Panel>
      ) : null}

      <Panel title="当前合同费率" subtitle="按 Hub 开放能力计价；供应商、采购成本与路由切换不会暴露给租户">
        {effectiveRates.length ? (
          <Table label="当前合同费率">
            <thead><tr><th>开放能力</th><th>计量键</th><th>计费单位</th><th>每次成交价</th></tr></thead>
            <tbody>{effectiveRates.map((entry) => (
              <tr key={entry.meterKey}>
                <td><strong>{billingMeterLabel(entry.meterKey)}</strong></td>
                <td><code>{entry.meterKey}</code></td>
                <td>{entry.billingUnit === 'request' ? '每个 Hub 逻辑请求（成功交付扣费）' : entry.billingUnit}</td>
                <td><strong>{formatMoneyMinor(entry.unitPriceMinor, entry.currency || billingCurrency)}</strong></td>
              </tr>
            ))}</tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Coins}
            title="当前套餐尚未配置费率 · 当前不计费"
            description="历史调用继续按原策略运行；只有发布并显式分配的新计费套餐才会产生报价。"
            action={session?.platformAdmin && newerPricedVersion
              ? <button className="qp-button qp-button--outline qp-button--sm" type="button" disabled={!canAssignPlan || Boolean(assigningPlanVersionId)} onClick={() => assignPlan(newerPricedVersion)}>分配已发布 v{newerPricedVersion.version}</button>
              : session?.platformAdmin && currentPlan?.pricing?.mode === 'operator_price_book' ? <button className="qp-button qp-button--outline qp-button--sm" type="button" onClick={() => openPlanPublisher(currentPlan)}>配置费率并发布新版本</button> : null}
          />
        )}
      </Panel>

      <Panel title="余额流水" subtitle="租户钱包跨调用者共享；每笔请求仍按调用者与 API Key 独立归因">
        {billing.ledger?.length ? (
          <Table label="租户余额流水">
            <thead><tr><th>时间</th><th>类型</th><th>金额</th><th>可用余额变化</th><th>冻结变化</th><th>事由</th></tr></thead>
            <tbody>{billing.ledger.map((entry) => (
              <tr key={entry.id}>
                <td>{formatDate(entry.createdAt)}</td>
                <td><strong>{billingLedgerKindLabel(entry.kind)}</strong><small>{entry.usageRequestId ? `请求 ${entry.usageRequestId.slice(0, 8)}…` : '租户钱包'}</small></td>
                <td>{formatMoneyMinor(entry.amountMinor, entry.currency)}</td>
                <td>{entry.availableDeltaMinor > 0 ? '+' : ''}{formatMoneyMinor(entry.availableDeltaMinor, entry.currency)}<small>余额 {formatMoneyMinor(entry.availableAfterMinor, entry.currency)}</small></td>
                <td>{entry.heldDeltaMinor > 0 ? '+' : ''}{formatMoneyMinor(entry.heldDeltaMinor, entry.currency)}<small>冻结 {formatMoneyMinor(entry.heldAfterMinor, entry.currency)}</small></td>
                <td>{entry.reason || '自动请求结算'}</td>
              </tr>
            ))}</tbody>
          </Table>
        ) : (
          <EmptyState icon={Coins} title={account ? '当前还没有余额变动' : '租户钱包尚未开户'} description={session?.platformAdmin ? '管理员首次人工充值后会创建钱包并留下不可变流水。' : '请联系平台管理员开通余额。'} />
        )}
      </Panel>

      <Panel title="套餐目录" subtitle="套餐版本一经发布不可原地改价；调用者绑定具体版本用于对账">
        {data.plans?.catalog?.length ? (
          <Table label="套餐目录">
            <thead><tr><th>套餐</th><th>版本</th><th>月请求</th><th>滑动窗口</th><th>突发</th><th>分页</th><th>价格状态</th>{session?.platformAdmin ? <th>操作</th> : null}</tr></thead>
            <tbody>{data.plans.catalog.map((plan) => (
              <tr key={plan.versionId}>
                <td><strong>{plan.name}</strong><small>{plan.key}{plan.versionId === currentPlan?.versionId ? ' · 当前' : ''}</small></td>
                <td>v{plan.version}</td>
                <td>{plan.limits?.monthlyRequests ? formatNumber(plan.limits.monthlyRequests) : '不限制'}</td>
                <td>{plan.limits?.maxRequests ? `${formatNumber(plan.limits.maxRequests)} / ${formatNumber(plan.limits.windowSeconds)} 秒` : '按调用者策略'}</td>
                <td>{plan.limits?.burstRps ? `${formatNumber(plan.limits.burstRps)} RPS` : '不限制'}</td>
                <td>{plan.limits?.maxPageSize ? formatNumber(plan.limits.maxPageSize) : '按策略'}</td>
                <td>{plan.priceBook
                  ? <><strong>{plan.priceBook.currency} · {formatNumber(plan.priceBook.entries?.length || 0)} 项</strong><small>{plan.priceBook.key} · v{plan.priceBook.version}</small></>
                  : plan.pricing?.mode === 'operator_price_book' ? <><strong>尚未配置费率</strong><small>当前不计费</small></> : plan.pricing?.mode === 'contract' ? '按租户合同价' : '历史兼容'}</td>
                {session?.platformAdmin ? (
                  <td>
                    {plan.key === 'legacy-unmetered' ? (
                      <small>{plan.versionId === currentPlan?.versionId ? '当前历史绑定' : '仅保留现有绑定'}</small>
                    ) : !plan.priceBook && plan.pricing?.mode === 'operator_price_book' ? (
                      <button className="qp-button qp-button--outline qp-button--sm" type="button" onClick={() => openPlanPublisher(plan)}>配置费率并发布</button>
                    ) : (
                      <button
                        className="qp-button qp-button--ghost qp-button--sm"
                        type="button"
                        disabled={
                          !canAssignPlan
                          || Boolean(assigningPlanVersionId)
                          || plan.versionId === currentPlan?.versionId
                          || plan.status !== 'active'
                          || plan.versionStatus !== 'published'
                        }
                        onClick={() => assignPlan(plan)}
                      >
                        {plan.versionId === currentPlan?.versionId
                          ? '已分配'
                          : assigningPlanVersionId === plan.versionId ? '分配中…' : '分配此版本'}
                      </button>
                    )}
                  </td>
                ) : null}
              </tr>
            ))}</tbody>
          </Table>
        ) : <EmptyState icon={Coins} title="尚无套餐版本" description="数据库迁移完成后会显示可分配套餐。" />}
      </Panel>

      <Panel title="平台级配额" subtitle="显式策略覆盖默认基线">
        {policies.length ? (
          <Table label="平台级配额策略">
            <thead><tr><th>平台</th><th>授权</th><th>滑动窗口内请求上限</th><th>滑动窗口秒数</th><th>最大分页</th><th>更新时间</th></tr></thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.platform}>
                  <td><strong>{platformLabel(policy.platform)}</strong><small>{policy.platform}</small></td>
                  <td><StatusBadge status={grants.has(policy.platform) ? 'enabled' : 'disabled'} label={grants.has(policy.platform) ? '已授权' : '未授权'} /></td>
                  <td>{formatNumber(policy.maxRequests)}</td>
                  <td>{formatNumber(policy.windowSeconds)} 秒</td>
                  <td>{formatNumber(policy.maxPageSize)}</td>
                  <td>{formatDate(policy.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Coins}
            title={data.consumerId ? '当前使用默认配额' : '请选择调用者'}
            description={data.consumerId ? '在平台管理中保存配置后，会在这里显示显式策略。' : '配额策略需要绑定到租户和调用者。'}
            action={data.consumerId && canManagePlatform ? <a className="qp-button qp-button--outline" href={platformHref}><SlidersHorizontal size={16} aria-hidden="true" />配置平台</a> : null}
          />
        )}
      </Panel>

      <Panel title="通用能力配额" subtitle="调用者 × capability 总窗口与每 Key 签发 ceiling 独立计量；不使用 pageSize">
        {capabilityPolicies.length ? (
          <Table label="通用能力配额策略">
            <thead><tr><th>能力</th><th>授权</th><th>滑动窗口内请求上限</th><th>滑动窗口秒数</th><th>更新时间</th></tr></thead>
            <tbody>
              {capabilityPolicies.map((policy) => {
                const metadata = CAPABILITY_CATALOG[policy.capability]
                return (
                  <tr key={policy.capability}>
                    <td><strong>{metadata?.label || policy.capability}</strong><small>{policy.capability}</small></td>
                    <td><StatusBadge status={capabilityGrants.has(policy.capability) ? 'enabled' : 'disabled'} label={capabilityGrants.has(policy.capability) ? '已授权' : '未授权'} /></td>
                    <td>{formatNumber(policy.maxRequests)}</td>
                    <td>{formatNumber(policy.windowSeconds)} 秒</td>
                    <td>{formatDate(policy.updatedAt)}</td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            icon={Brain}
            title={data.consumerId ? '当前通用能力使用默认配额' : '请选择调用者'}
            description={data.consumerId ? '在开放能力中保存配置后，会在这里显示显式策略。' : '能力策略需要绑定到租户和调用者。'}
            action={data.consumerId && canManagePlatform ? <a className="qp-button qp-button--outline" href={platformHref}><SlidersHorizontal size={16} aria-hidden="true" />配置开放能力</a> : null}
          />
        )}
      </Panel>

      {creditOpen && session?.platformAdmin ? (
        <Modal
          title="人工充值"
          description="资金会先进入租户共享钱包，并以幂等键写入不可变账本；当前版本不接在线支付。"
          busy={billingBusy === 'credit'}
          onClose={() => !billingBusy && setCreditOpen(false)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setCreditOpen(false)} disabled={Boolean(billingBusy)}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="tenant-credit-form" disabled={Boolean(billingBusy)}>{billingBusy === 'credit' ? '正在入账…' : '确认入账'}</button>
            </>
          )}
        >
          <form id="tenant-credit-form" className="mih-form mih-form--grid" onSubmit={saveCredit}>
            <Field label="充值金额" hint="使用主货币单位，最多两位小数。">
              <input className="qp-input" type="text" inputMode="decimal" value={creditForm.amount} onChange={(event) => setCreditForm({ ...creditForm, amount: event.target.value })} placeholder="1000.00" required autoFocus />
            </Field>
            <Field label="币种" hint={account ? '已有钱包不能切换币种。' : '三位 ISO 币种代码。'}>
              <input className="qp-input" value={creditForm.currency} onChange={(event) => setCreditForm({ ...creditForm, currency: event.target.value.toUpperCase() })} minLength={3} maxLength={3} disabled={Boolean(account)} required />
            </Field>
            <div className="mih-form__wide">
              <Field label="入账事由">
                <input className="qp-input" value={creditForm.reason} onChange={(event) => setCreditForm({ ...creditForm, reason: event.target.value })} maxLength={256} placeholder="例如：线下合同首充" required />
              </Field>
            </div>
            <div className="mih-form__wide">
              <Field label="外部凭证号（可选）" hint="仅管理员可见，不会向租户展示。">
                <input className="qp-input" value={creditForm.externalReference} onChange={(event) => setCreditForm({ ...creditForm, externalReference: event.target.value })} maxLength={256} placeholder="合同、转账或工单编号" />
              </Field>
            </div>
            {billingError ? <div className="mih-form__wide"><ErrorState error={billingError} /></div> : null}
          </form>
        </Modal>
      ) : null}

      {profileOpen && session?.platformAdmin ? (
        <Modal
          title="租户计费策略"
          description="倍率只影响以后创建的价格快照；供应商变化不会改变租户已经冻结或成交的价格。"
          busy={billingBusy === 'profile'}
          onClose={() => !billingBusy && setProfileOpen(false)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setProfileOpen(false)} disabled={Boolean(billingBusy)}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="tenant-billing-profile-form" disabled={Boolean(billingBusy)}>{billingBusy === 'profile' ? '正在保存…' : '保存策略'}</button>
            </>
          )}
        >
          <form id="tenant-billing-profile-form" className="mih-form" onSubmit={saveProfile}>
            <Field label="计费模式" hint="建议先用影子计价核对费率与 QPS，再开启余额门禁。">
              <select className="qp-input" value={profileForm.mode} onChange={(event) => setProfileForm({ ...profileForm, mode: event.target.value })} autoFocus>
                <option value="disabled">未启用 · 不报价不扣费</option>
                <option value="shadow">影子计价 · 记录报价不动余额</option>
                <option value="enforced">余额门禁 · 请求前冻结、成功后扣费</option>
              </select>
            </Field>
            <Field label="租户费率倍率（可选）" hint="留空继承套餐默认倍率；例如 1.200000 表示合同价为基础费率的 1.2 倍。">
              <input className="qp-input" type="text" inputMode="decimal" value={profileForm.multiplier} onChange={(event) => setProfileForm({ ...profileForm, multiplier: event.target.value })} placeholder="继承套餐默认倍率" />
            </Field>
            {billingError ? <ErrorState error={billingError} /> : null}
          </form>
        </Modal>
      ) : null}

      {planOpen && session?.platformAdmin ? (
        <Modal
          title="发布套餐版本"
          description="请由运营方根据已核验的上游成本、目标毛利与客户合同显式输入费率。发布后套餐与价目表都不可原地修改；新版本不会自动分配。"
          size="large"
          busy={billingBusy === 'plan'}
          onClose={() => !billingBusy && setPlanOpen(false)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setPlanOpen(false)} disabled={Boolean(billingBusy)}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="publish-plan-form" disabled={Boolean(billingBusy)}>{billingBusy === 'plan' ? '正在发布…' : '发布不可变版本'}</button>
            </>
          )}
        >
          <form id="publish-plan-form" className="mih-form mih-form--grid" onSubmit={publishPlan}>
            <Field label="套餐标识"><input className="qp-input" value={planForm.key} onChange={(event) => setPlanForm({ ...planForm, key: event.target.value.toLowerCase() })} placeholder="business-standard" maxLength={64} required autoFocus /></Field>
            <Field label="套餐名称"><input className="qp-input" value={planForm.name} onChange={(event) => setPlanForm({ ...planForm, name: event.target.value })} placeholder="商务标准版" maxLength={128} required /></Field>
            <Field label="价目表标识"><input className="qp-input" value={planForm.priceBookKey} onChange={(event) => setPlanForm({ ...planForm, priceBookKey: event.target.value.toLowerCase() })} placeholder="cn-social-standard" maxLength={64} required /></Field>
            <Field label="币种"><input className="qp-input" value={planForm.currency} onChange={(event) => setPlanForm({ ...planForm, currency: event.target.value.toUpperCase() })} minLength={3} maxLength={3} required /></Field>
            <Field label="默认费率倍率" hint="租户未设置专属倍率时使用。"><input className="qp-input" type="text" inputMode="decimal" value={planForm.defaultMultiplier} onChange={(event) => setPlanForm({ ...planForm, defaultMultiplier: event.target.value })} required /></Field>
            <Field label="每月请求上限"><input className="qp-input" type="number" min="1" value={planForm.monthlyRequests} onChange={(event) => setPlanForm({ ...planForm, monthlyRequests: event.target.value })} required /></Field>
            <Field label="突发 QPS"><input className="qp-input" type="number" min="1" value={planForm.burstRps} onChange={(event) => setPlanForm({ ...planForm, burstRps: event.target.value })} required /></Field>
            <Field label="最大分页"><input className="qp-input" type="number" min="1" max="1000" value={planForm.maxPageSize} onChange={(event) => setPlanForm({ ...planForm, maxPageSize: event.target.value })} required /></Field>
            <div className="mih-form__wide">
              <Table label="逐接口价格">
                <thead><tr><th>开放能力计量键</th><th>每次基础价格</th><th>操作</th></tr></thead>
                <tbody>{planForm.entries.map((entry, index) => (
                  <tr key={index}>
                    <td><input className="qp-input" value={entry.meterKey} onChange={(event) => updatePlanEntry(index, { meterKey: event.target.value.toLowerCase() })} placeholder="social.posts.resolve" required /></td>
                    <td><input className="qp-input" type="text" inputMode="decimal" value={entry.price} onChange={(event) => updatePlanEntry(index, { price: event.target.value })} placeholder="输入合同价格" required /></td>
                    <td><button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label="删除费率" disabled={planForm.entries.length <= 1} onClick={() => setPlanForm((current) => ({ ...current, entries: current.entries.filter((_, entryIndex) => entryIndex !== index) }))}><Trash size={17} aria-hidden="true" /></button></td>
                  </tr>
                ))}</tbody>
              </Table>
              <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => setPlanForm((current) => ({ ...current, entries: [...current.entries, { meterKey: '', price: '' }] }))}><Plus size={16} aria-hidden="true" />增加接口费率</button>
            </div>
            {billingError ? <div className="mih-form__wide"><ErrorState error={billingError} /></div> : null}
          </form>
        </Modal>
      ) : null}
    </>
  )
}

export function PlatformsPage({ token, session, query, setQuery, onUnauthorized, notify }) {
  const requestedTenantId = query.get('tenantId') || ''
  const requestedConsumerId = query.get('consumerId') || ''
  const requestedContext = `${requestedTenantId}\u0000${requestedConsumerId}`
  const contextRef = useRef(requestedContext)
  contextRef.current = requestedContext
  const [busyPlatform, setBusyPlatform] = useState('')
  const [busyCapability, setBusyCapability] = useState('')
  // Client-side because the whole catalog is already loaded: filtering here is
  // instant and cannot fall out of step with what the tables render.
  const [capabilityFilter, setCapabilityFilter] = useState('')
  const [configureTarget, setConfigureTarget] = useState(null)
  const [configureCapabilityTarget, setConfigureCapabilityTarget] = useState(null)
  const [policyForm, setPolicyForm] = useState(DEFAULT_POLICY)
  const [capabilityPolicyForm, setCapabilityPolicyForm] = useState(DEFAULT_POLICY)
  const [formError, setFormError] = useState(null)
  const load = useCallback(
    () => loadConfigurationContext(token, requestedTenantId, requestedConsumerId, session),
    [requestedConsumerId, requestedTenantId, session, token],
  )
  const state = useRemoteData(load, onUnauthorized)
  useEffect(() => {
    // Only act on a result that answers the selection currently in the URL.
    // `state.loading` is not enough on its own: the refetch triggered by a new
    // selection is still queued on the render where this first runs, so the
    // previous tenant's data is briefly paired with the new request and would
    // be read as a rejected selection -- snapping the picker back and making
    // it look as though tenants cannot be switched.
    if (state.loading || !state.data) return
    if (state.data.requestedContext !== selectionContext(requestedTenantId, requestedConsumerId)) return
    const tenantMismatch = requestedTenantId && requestedTenantId !== state.data.tenantId
    const consumerMismatch = requestedConsumerId && requestedConsumerId !== state.data.consumerId
    if (tenantMismatch || consumerMismatch) {
      setQuery({ tenantId: state.data.tenantId || null, consumerId: state.data.consumerId || null })
    }
  }, [requestedConsumerId, requestedTenantId, setQuery, state.data, state.loading])

  useEffect(() => {
    setConfigureTarget(null)
    setConfigureCapabilityTarget(null)
    setFormError(null)
  }, [requestedConsumerId, requestedTenantId])

  if (state.loading && !state.data) return <LoadingState label="正在加载平台策略" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const data = state.data || { tenants: [], consumers: [], configuration: { grants: [], policies: [] } }
  const grants = new Set(data.configuration?.grants || [])
  const policyByPlatform = new Map((data.configuration?.policies || []).map((policy) => [policy.platform, policy]))
  const filterTerm = capabilityFilter.trim().toLowerCase()
  // Match the id and the human label, so either "xhs 小红书" spelling finds it.
  const matchesFilter = (...fields) => filterTerm === '' || fields.some(
    (field) => String(field || '').toLowerCase().includes(filterTerm),
  )
  const rows = PLATFORM_CATALOG.map((platform) => ({
    platform,
    enabled: grants.has(platform),
    policy: policyByPlatform.get(platform) || DEFAULT_POLICY,
    explicit: policyByPlatform.has(platform),
  })).filter((row) => matchesFilter(row.platform, platformLabel(row.platform)))
  const groupedPlatformRows = [...PLATFORM_GROUPS, { key: 'other', label: '其他', hint: '' }]
    .map((group) => ({
      ...group,
      rows: rows.filter((row) => platformGroupOf(row.platform) === group.key),
    }))
    .filter((group) => group.rows.length > 0)
  const capabilityGrants = new Set(data.configuration?.capabilityGrants || [])
  const capabilityPolicyByName = new Map(
    (data.configuration?.capabilityPolicies || []).map((policy) => [policy.capability, policy]),
  )
  const capabilityRows = (data.configuration?.availableCapabilities || []).map((entry) => ({
    capability: entry.capability,
    ready: entry.ready === true,
    enabled: capabilityGrants.has(entry.capability),
    policy: capabilityPolicyByName.get(entry.capability) || DEFAULT_POLICY,
    explicit: capabilityPolicyByName.has(entry.capability),
    metadata: CAPABILITY_CATALOG[entry.capability] || {
      label: entry.capability,
      description: 'Hub 通用开放能力',
      endpoint: '—',
    },
  }))
  const visibleCapabilityRows = capabilityRows.filter((row) => matchesFilter(
    row.capability, row.metadata.label, row.metadata.endpoint,
  ))
  const businessOperationRows = visibleCapabilityRows.filter((row) => row.metadata.group !== 'compatibility')
  const compatibilityCapabilityRows = visibleCapabilityRows.filter((row) => row.metadata.group === 'compatibility')
  const selectedTenant = data.tenants.find((tenant) => tenant.id === data.tenantId)
  const selectedConsumer = data.consumers.find((consumer) => consumer.id === data.consumerId)
  const contextMatchesRequest = (
    (!requestedTenantId || requestedTenantId === data.tenantId)
    && (!requestedConsumerId || requestedConsumerId === data.consumerId)
  )
  const contextUnavailable = state.loading || !contextMatchesRequest
  const hasPlatformWrite = tenantAllows(session, selectedConsumer?.tenantId, 'platform.write')
  const canReadApiKeys = tenantAllows(session, selectedConsumer?.tenantId, 'apikey.read')
  const canUpdatePlatform = hasPlatformWrite && !contextUnavailable
  const mutationPending = Boolean(busyPlatform || busyCapability)
  const mutationDisabled = mutationPending || contextUnavailable

  const updatePlatform = async (row, enabled, overrides = row.policy) => {
    if (!data.tenantId || !data.consumerId || !canUpdatePlatform || mutationDisabled) return
    const targetContext = contextRef.current
    const targetTenantId = data.tenantId
    const targetConsumerId = data.consumerId
    const targetConsumerName = selectedConsumer?.name || data.consumerId
    setBusyPlatform(row.platform)
    setFormError(null)
    try {
      await adminApi.updatePlatform(token, row.platform, {
        tenantId: targetTenantId,
        consumerId: targetConsumerId,
        enabled,
        maxRequests: Number(overrides.maxRequests),
        windowSeconds: Number(overrides.windowSeconds),
        maxPageSize: Number(overrides.maxPageSize),
      })
      if (contextRef.current === targetContext) {
        const refreshed = await load()
        if (contextRef.current === targetContext) state.setData(refreshed)
        setConfigureTarget(null)
      }
      notify(`${platformLabel(row.platform)} 已为调用者「${targetConsumerName}」${enabled ? '启用' : '停用'}`, 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      if (configureTarget) setFormError(error)
      else notify(error.message || '平台更新失败', 'danger')
    } finally {
      setBusyPlatform('')
    }
  }

  const configure = (row) => {
    if (!canUpdatePlatform) return
    setConfigureTarget(row)
    setPolicyForm({
      maxRequests: row.policy.maxRequests,
      windowSeconds: row.policy.windowSeconds,
      maxPageSize: row.policy.maxPageSize,
    })
    setFormError(null)
  }

  const updateCapability = async (row, enabled, overrides = row.policy) => {
    if (!data.tenantId || !data.consumerId || !canUpdatePlatform || mutationDisabled) return
    const targetContext = contextRef.current
    const targetTenantId = data.tenantId
    const targetConsumerId = data.consumerId
    setBusyCapability(row.capability)
    setFormError(null)
    try {
      await adminApi.updateCapability(token, row.capability, {
        tenantId: targetTenantId,
        consumerId: targetConsumerId,
        enabled,
        maxRequests: Number(overrides.maxRequests),
        windowSeconds: Number(overrides.windowSeconds),
      })
      if (contextRef.current === targetContext) {
        const refreshed = await load()
        if (contextRef.current === targetContext) state.setData(refreshed)
        setConfigureCapabilityTarget(null)
      }
      notify(`${row.metadata.label} 已为调用者「${selectedConsumer?.name || targetConsumerId}」${enabled ? '启用' : '停用'}`, 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      if (configureCapabilityTarget) setFormError(error)
      else notify(error.message || '开放能力更新失败', 'danger')
    } finally {
      setBusyCapability('')
    }
  }

  const configureCapability = (row) => {
    if (!canUpdatePlatform) return
    setConfigureCapabilityTarget(row)
    setCapabilityPolicyForm({
      maxRequests: row.policy.maxRequests,
      windowSeconds: row.policy.windowSeconds,
      maxPageSize: DEFAULT_POLICY.maxPageSize,
    })
    setFormError(null)
  }

  const copyCapabilityCurl = async (row) => {
    if (row.capability !== 'nlp.tokenize') return
    if (await copyText(TOKENIZE_CURL_TEMPLATE)) {
      notify('中文分词 curl 已复制；粘贴运行后会静默提示输入 API Key', 'success')
    } else {
      notify('无法访问剪贴板，请从公共 API 文档复制 curl', 'danger')
    }
  }

  return (
    <>
      <PageHeading eyebrow="OPEN PLATFORM / GRANTS / POLICY" title="开放能力" description="调用者授权是上限，API Key 在签发时选择其中的平台与能力。停用会立即收窄现有 Key；新增能力需重新签发并显式勾选。" loading={state.loading} onRefresh={state.refresh}>
        {canReadApiKeys && data.consumerId ? <a className="qp-button qp-button--ghost" href={`#/api-keys?${new URLSearchParams({ consumerId: data.consumerId })}`}><Key size={17} aria-hidden="true" />查看该身份 API Key</a> : null}
        <a className="qp-button qp-button--outline" href={publicDocsHref()} target="_blank" rel="noreferrer">查看公共 API 文档</a>
      </PageHeading>
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      <section className="qp-panel mih-filterbar">
        <FilterSelect
          label="租户"
          value={data.tenantId}
          onChange={(value) => {
            setConfigureTarget(null)
            setFormError(null)
            setQuery({ tenantId: value || null, consumerId: null })
          }}
          options={data.tenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
          emptyLabel="请选择租户"
          disabled={mutationPending || state.loading}
        />
        <FilterSelect
          label="调用者"
          value={data.consumerId}
          onChange={(value) => {
            setConfigureTarget(null)
            setFormError(null)
            setQuery({ tenantId: data.tenantId || null, consumerId: value || null })
          }}
          options={data.consumers.map((consumer) => ({ value: consumer.id, label: consumer.name }))}
          emptyLabel="请选择调用者"
          disabled={mutationPending || state.loading}
        />
        {contextUnavailable ? (
          <div className="mih-platform-context" role="status" aria-live="polite">
            <span>{state.loading ? '正在加载授权对象' : '授权对象尚未就绪'}</span>
            <strong>当前显示的旧数据暂不可操作</strong>
            <small>{state.loading ? '加载完成后可继续配置' : '请重试或重新选择调用者'}</small>
          </div>
        ) : selectedConsumer ? (
          <div className="mih-platform-context" role="status" aria-live="polite">
            <span>当前授权对象</span>
            <strong>{selectedTenant?.name || data.tenantId} / {selectedConsumer.name}</strong>
            <code className="mih-mono">Consumer ID: {selectedConsumer.id}</code>
            <small>现有 Key 只会被这里的变更收窄，不会因新增授权而静默扩权；扩大范围请签发新 Key</small>
          </div>
        ) : null}
      </section>

      <section className="qp-panel mih-provider-routing-boundary" aria-label="电商能力与上游路由边界">
        <div className="mih-provider-routing-boundary__intro">
          <span><Cloud size={19} weight="duotone" aria-hidden="true" /></span>
          <div>
            <strong>对外授权 Hub 数据域，对内选择上游适配器</strong>
            <p>数据产品只是“数据域 + 业务操作”的权限组合；provider-compatible 接口再叠加兼容合同授权。调用方只持有同一把 Hub API Key，不会看到或指定供应方。</p>
          </div>
        </div>
        <div className="mih-provider-routing-boundary__flow" aria-label="电商请求分流">
          <span><small>PUBLIC GRANT</small><strong>ecommerce</strong></span>
          <ArrowRight size={16} aria-hidden="true" />
          <span><small>HUB OPERATION</small><strong>products.search</strong></span>
          <ArrowRight size={16} aria-hidden="true" />
          <span><small>ROUTING BOUNDARY</small><strong>Hub 内部路由</strong></span>
        </div>
        <footer>
          <span>上游连接器、供应商选择、健康、采购成本与游标绑定均由 Admin 内部治理；租户只看数据域、业务操作、兼容合同、费率与交付结果。</span>
          {session?.platformAdmin && session?.kind === 'admin-token' ? <a className="qp-button qp-button--ghost qp-button--sm" href="#/external-platforms?range=24h">管理内部上游<ArrowRight size={15} aria-hidden="true" /></a> : null}
        </footer>
      </section>

      <Panel
        title="API Key 可访问的数据平台 / 数据域"
        subtitle={`${grants.size} / ${PLATFORM_CATALOG.length} 已启用；调用者授权是上限，新 Key 签发时再选择 immutable snapshot`}
      >
        {data.consumerId ? (
          <div className="mih-capability-filter">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              className="qp-input"
              type="search"
              value={capabilityFilter}
              onChange={(event) => setCapabilityFilter(event.target.value)}
              placeholder="筛选开放项：名称或标识，如 小红书 / xiaohongshu / saved_records"
              aria-label="筛选开放能力"
            />
            {filterTerm ? (
              <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => setCapabilityFilter('')}>
                清除
              </button>
            ) : null}
          </div>
        ) : null}
        {data.consumerId && groupedPlatformRows.length === 0 ? (
          <p className="mih-capability-empty">没有匹配「{capabilityFilter}」的开放项。</p>
        ) : null}
        {data.consumerId ? groupedPlatformRows.map((group) => (
          <section className="mih-capability-group" key={group.key}>
            <header>
              <strong>{group.label}</strong>
              <span>{group.rows.filter((row) => row.enabled).length} / {group.rows.length} 已启用</span>
              {group.hint ? <small>{group.hint}</small> : null}
            </header>
          <Table label={`${group.label}授权与策略`}>
            <thead><tr><th>开放项</th><th>能力类型</th><th>状态</th><th>滑动窗口内请求上限</th><th>滑动窗口秒数</th><th>最大分页</th><th>操作</th></tr></thead>
            <tbody>
              {group.rows.map((row) => (
                <tr key={row.platform}>
                  <td>
                    <strong>{platformLabel(row.platform)}</strong>
                    <small>{row.platform}</small>
                    {PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION[row.platform] ? (
                      <>
                        <small>{PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION[row.platform].operation} · {PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION[row.platform].route}</small>
                        <small>{PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION[row.platform].policyNote}</small>
                      </>
                    ) : null}
                  </td>
                  <td>
                    <strong>{PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION[row.platform]?.kind || '来源平台'}</strong>
                    <small>{PROVIDER_NEUTRAL_PLATFORM_AUTHORIZATION[row.platform] ? '内部可聚合多个供应方' : '平台身份属于合同语义'}</small>
                  </td>
                  <td><StatusBadge status={row.enabled ? 'enabled' : 'disabled'} label={row.enabled ? '已启用' : '未启用'} /></td>
                  <td>{formatNumber(row.policy.maxRequests)}{row.explicit ? '' : '（默认）'}</td>
                  <td>{formatNumber(row.policy.windowSeconds)} 秒</td>
                  <td>{formatNumber(row.policy.maxPageSize)}</td>
                  <td className="mih-table__actions mih-table__actions--wide">
                    {hasPlatformWrite ? (
                      <>
                        <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={mutationDisabled} onClick={() => configure(row)}>
                          <SlidersHorizontal size={15} aria-hidden="true" />配置
                        </button>
                        <button
                          className={`qp-button qp-button--sm ${row.enabled ? 'qp-button--transparent' : 'qp-button--outline'}`}
                          type="button"
                          aria-pressed={row.enabled}
                          disabled={mutationDisabled}
                          onClick={() => updatePlatform(row, !row.enabled)}
                        >
                          <Power size={15} weight={row.enabled ? 'fill' : 'regular'} aria-hidden="true" />
                          {busyPlatform === row.platform ? '处理中' : row.enabled ? '停用' : '启用'}
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          </section>
        )) : (
          <EmptyState icon={Globe} title={data.tenants.length ? '请选择调用者' : '请先创建调用者'} description="平台授权与配额策略必须绑定到具体调用者。" action={!data.tenants.length ? <a className="qp-button qp-button--outline" href="#/consumers"><Users size={16} aria-hidden="true" />前往调用者</a> : null} />
        )}
      </Panel>

      {[
        {
          key: 'operations',
          title: '业务操作',
          subtitle: '决定调用者可以执行什么；与数据域共同生效，数据产品只组合底层权限',
          rows: businessOperationRows,
          total: capabilityRows.filter((row) => row.metadata.group !== 'compatibility'),
          tableLabel: '业务操作授权与策略',
        },
        {
          key: 'compatibility',
          title: '兼容接口合同',
          subtitle: '只开放兼容接口形状，不代表可指定或查看物理上游连接器',
          rows: compatibilityCapabilityRows,
          total: capabilityRows.filter((row) => row.metadata.group === 'compatibility'),
          tableLabel: '兼容接口合同授权与策略',
        },
      ].map((section) => (
        <Panel
          key={section.key}
          title={section.title}
          subtitle={`${section.total.filter((row) => row.enabled).length} / ${section.total.length} 已启用${filterTerm ? `（筛选后显示 ${section.rows.length} 项）` : ''}；${section.subtitle}`}
        >
          {data.consumerId ? (
            section.rows.length ? (
              <Table label={section.tableLabel}>
              <thead><tr><th>能力</th><th>授权</th><th>运行状态</th><th>滑动窗口内请求上限</th><th>滑动窗口秒数</th><th>操作</th></tr></thead>
              <tbody>
                {section.rows.map((row) => (
                  <tr key={row.capability}>
                    <td><strong>{row.metadata.label}</strong><small>{row.capability} · {row.metadata.endpoint}</small><small>{row.metadata.description}</small>{row.metadata.usageHint ? <small>{row.metadata.usageHint}</small> : null}</td>
                    <td><StatusBadge status={row.enabled ? 'enabled' : 'disabled'} label={row.enabled ? '已授权' : '未授权'} /></td>
                    <td><StatusBadge status={row.ready ? 'ready' : 'degraded'} label={row.ready ? '可调用' : '运行时未就绪'} /></td>
                    <td>{formatNumber(row.policy.maxRequests)}{row.explicit ? '' : '（默认）'}</td>
                    <td>{formatNumber(row.policy.windowSeconds)} 秒</td>
                    <td className="mih-table__actions mih-table__actions--wide">
                      {row.capability === 'nlp.tokenize' ? (
                        <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => copyCapabilityCurl(row)}>
                          <Copy size={15} aria-hidden="true" />复制 curl
                        </button>
                      ) : null}
                      {hasPlatformWrite ? (
                        <>
                          <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={mutationDisabled} onClick={() => configureCapability(row)}>
                            <SlidersHorizontal size={15} aria-hidden="true" />配置
                          </button>
                          <button
                            className={`qp-button qp-button--sm ${row.enabled ? 'qp-button--transparent' : 'qp-button--outline'}`}
                            type="button"
                            aria-pressed={row.enabled}
                            disabled={mutationDisabled || (!row.ready && !row.enabled)}
                            title={!row.ready && !row.enabled ? '运行时未就绪，暂不能启用' : ''}
                            onClick={() => updateCapability(row, !row.enabled)}
                          >
                            <Power size={15} weight={row.enabled ? 'fill' : 'regular'} aria-hidden="true" />
                            {busyCapability === row.capability ? '处理中' : row.enabled ? '停用' : '启用'}
                          </button>
                        </>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
              </Table>
            ) : (
              <EmptyState icon={Globe} title={`当前版本没有可配置的${section.title}`} description="升级 Hub 后刷新能力目录。" />
            )
          ) : (
            <EmptyState icon={Globe} title="请选择调用者" description={`${section.title}授权与配额同样绑定到具体调用者。`} />
          )}
        </Panel>
      ))}

      {configureTarget && canUpdatePlatform ? (
        <Modal
          title={`配置 ${platformLabel(configureTarget.platform)}`}
          description={`停用后会立即收窄调用身份「${selectedConsumer?.name || data.consumerId}」的所有 Key；启用后仅新签且勾选该范围的 Key 可用。`}
          onClose={() => !busyPlatform && setConfigureTarget(null)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setConfigureTarget(null)} disabled={Boolean(busyPlatform)}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="platform-policy" disabled={Boolean(busyPlatform)}>{busyPlatform ? '正在保存' : '保存策略'}</button>
            </>
          )}
        >
          <form
            id="platform-policy"
            className="mih-form mih-form--grid"
            onSubmit={(event) => {
              event.preventDefault()
              updatePlatform(configureTarget, configureTarget.enabled, policyForm)
            }}
          >
            <Field label="滑动窗口内请求上限">
              <input className="qp-input" type="number" min="1" value={policyForm.maxRequests} onChange={(event) => setPolicyForm({ ...policyForm, maxRequests: event.target.value })} required autoFocus />
            </Field>
            <Field label="滑动窗口秒数">
              <input className="qp-input" type="number" min="1" value={policyForm.windowSeconds} onChange={(event) => setPolicyForm({ ...policyForm, windowSeconds: event.target.value })} required />
            </Field>
            <Field label="最大 pageSize">
              <input className="qp-input" type="number" min="1" value={policyForm.maxPageSize} onChange={(event) => setPolicyForm({ ...policyForm, maxPageSize: event.target.value })} required />
            </Field>
            {formError ? <div className="mih-form__wide"><ErrorState error={formError} /></div> : null}
          </form>
        </Modal>
      ) : null}

      {configureCapabilityTarget && canUpdatePlatform ? (
        <Modal
          title={`配置 ${configureCapabilityTarget.metadata.label}`}
          description={`能力 ${configureCapabilityTarget.capability}；这是 consumer × capability 的滑动窗口，该调用者的所有 API Key 共享上限。`}
          onClose={() => !busyCapability && setConfigureCapabilityTarget(null)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setConfigureCapabilityTarget(null)} disabled={Boolean(busyCapability)}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="capability-policy" disabled={Boolean(busyCapability)}>{busyCapability ? '正在保存' : '保存策略'}</button>
            </>
          )}
        >
          <form
            id="capability-policy"
            className="mih-form mih-form--grid"
            onSubmit={(event) => {
              event.preventDefault()
              updateCapability(configureCapabilityTarget, configureCapabilityTarget.enabled, capabilityPolicyForm)
            }}
          >
            <Field label="滑动窗口内请求上限">
              <input className="qp-input" type="number" min="1" value={capabilityPolicyForm.maxRequests} onChange={(event) => setCapabilityPolicyForm({ ...capabilityPolicyForm, maxRequests: event.target.value })} required autoFocus />
            </Field>
            <Field label="滑动窗口秒数">
              <input className="qp-input" type="number" min="1" value={capabilityPolicyForm.windowSeconds} onChange={(event) => setCapabilityPolicyForm({ ...capabilityPolicyForm, windowSeconds: event.target.value })} required />
            </Field>
            {formError ? <div className="mih-form__wide"><ErrorState error={formError} /></div> : null}
          </form>
        </Modal>
      ) : null}
    </>
  )
}

export function UsagePage({ token, session, query, setQuery, onUnauthorized, notify }) {
  const tenantId = query.get('tenantId') || ''
  const consumerId = query.get('consumerId') || ''
  const range = query.get('range') || '24h'
  const [reconcileTarget, setReconcileTarget] = useState(null)
  const [reconcileForm, setReconcileForm] = useState({ disposition: 'release', reason: '' })
  const [reconcileBusy, setReconcileBusy] = useState(false)
  const [reconcileError, setReconcileError] = useState(null)
  const load = useCallback(async () => {
    const [tenants, consumers, usage] = await Promise.all([
      adminApi.tenants(token),
      adminApi.consumers(token, tenantId),
      adminApi.usage(token, { tenantId, consumerId, ...rangeBounds(range) }),
    ])
    return { tenants: tenants || [], consumers: consumers || [], usage: usage || {} }
  }, [consumerId, range, tenantId, token])
  const state = useRemoteData(load, onUnauthorized)

  if (state.loading && !state.data) return <LoadingState label="正在加载用量证据" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const data = state.data || { tenants: [], consumers: [], usage: {} }
  const usage = data.usage || {}
  const platforms = sortedPlatforms(usage.byPlatform)
  const capabilities = sortedPlatforms(usage.byCapability)
  const requestMeters = sortedPlatforms(usage.requestMetering?.byMeter)
  const customerBilling = usage.customerBilling || {}
  const billingCurrencies = sortedPlatforms(customerBilling.byCurrency)
  const billingMeters = sortedPlatforms(customerBilling.byMeter)
  const recentRequests = usage.recentRequests || []
  const consumerNames = new Map(data.consumers.map((consumer) => [consumer.id, consumer.name]))
  const billingMoney = (minor, currency = customerBilling.currency, mixedCurrencies = customerBilling.mixedCurrencies) => (
    mixedCurrencies
      ? '多币种，见按币种汇总'
      : !currency
        ? `${formatNumber(minor ?? 0)} 最小货币单位`
        : formatMoneyMinor(minor ?? 0, currency)
  )

  const openReconciliation = (request) => {
    setReconcileError(null)
    setReconcileForm({ disposition: 'release', reason: '' })
    setReconcileTarget({
      request,
      idempotencyKey: `reconcile-${crypto.randomUUID()}`,
    })
  }

  const reconcileUnknownCharge = async (event) => {
    event.preventDefault()
    if (!session?.platformAdmin || !reconcileTarget || reconcileBusy) return
    setReconcileBusy(true)
    setReconcileError(null)
    try {
      await adminApi.reconcileUnknownCustomerCharge(
        token,
        reconcileTarget.request.id,
        reconcileForm,
        reconcileTarget.idempotencyKey,
      )
      await state.refresh()
      setReconcileTarget(null)
      notify?.(
        reconcileForm.disposition === 'capture' ? '未知请求已确认扣费' : '未知请求已释放冻结余额',
        'success',
      )
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      setReconcileError(error)
    } finally {
      setReconcileBusy(false)
    }
  }

  return (
    <>
      <PageHeading eyebrow="METERING / COST / AUDIT" title="使用记录" description="统一记录数据平台与通用能力的请求结果、工作单元和耗时证据。" loading={state.loading} onRefresh={state.refresh} />
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      <section className="qp-panel mih-filterbar mih-filterbar--usage">
        <RangeFilter value={range} onChange={(value) => setQuery({ range: value })} />
        <FilterSelect
          label="租户"
          value={tenantId}
          onChange={(value) => setQuery({ tenantId: value || null, consumerId: null })}
          options={data.tenants.map((tenant) => ({ value: tenant.id, label: tenant.name }))}
        />
        <FilterSelect
          label="调用者"
          value={consumerId}
          onChange={(value) => setQuery({ consumerId: value || null })}
          options={data.consumers.map((consumer) => ({ value: consumer.id, label: consumer.name }))}
        />
      </section>

      <section className="mih-metric-grid mih-metric-grid--compact" aria-label="使用摘要">
        <MetricCard icon={Pulse} label="请求数" value={formatNumber(usage.requests)} hint={`${formatNumber(usage.committed)} 次成功`} />
        <MetricCard icon={ShieldCheck} label="成功率" value={percent(usage.committed, usage.requests)} hint={`${formatNumber(usage.released)} 次释放`} tone="success" />
        <MetricCard icon={Coins} label="工作单元" value={formatNumber(usage.units)} hint="平台记录或能力结果单元" tone="warning" />
        <MetricCard icon={Timer} label="平均上游耗时" value={formatLatency(usage.averageUpstreamLatencyMs)} hint={`${formatNumber(usage.unknown)} 次结果未知`} tone="archetype" />
      </section>

      <section className="mih-metric-grid mih-metric-grid--compact" aria-label="客户计费摘要">
        <MetricCard icon={Coins} label="客户报价" value={billingMoney(customerBilling.quotedMinor)} hint={`${formatNumber(customerBilling.requests)} 条计价记录；${formatNumber(customerBilling.releasedRequests)} 次安全失败已释放`} />
        <MetricCard icon={ShieldCheck} label="实际扣费" value={billingMoney(customerBilling.chargedMinor)} hint={`${formatNumber(customerBilling.capturedRequests)} 次成功扣费`} tone="success" />
        <MetricCard icon={Timer} label="待结算冻结" value={billingMoney(customerBilling.heldMinor)} hint={`${formatNumber(customerBilling.heldRequests)} 次冻结；结果未知时保留`} tone="warning" />
        <MetricCard icon={ChartLine} label="影子报价" value={billingMoney(customerBilling.shadowQuotedMinor)} hint={`${formatNumber(customerBilling.shadowRequests)} 次影子计价；不改变余额`} tone="info" />
      </section>

      <Panel title="最近 API 调用" subtitle="最多展示当前筛选范围内最近 50 笔；请求与客户价格按同一 request ID 对账">
        {recentRequests.length ? (
          <Table label="最近 API 调用">
            <thead><tr><th>时间</th><th>调用者</th><th>开放能力</th><th>结果</th><th>工作单元 / 耗时</th><th>客户计费</th>{session?.platformAdmin ? <th>对账</th> : null}</tr></thead>
            <tbody>{recentRequests.map((request) => {
              const charge = request.customerCharge
              const chargeValue = charge?.status === 'captured' ? charge.chargedMinor : charge?.quotedMinor
              const chargeHint = !charge
                ? '历史未计价'
                : charge.enforcementMode === 'shadow' ? '影子报价'
                  : ['reserved', 'unknown'].includes(charge.status) ? '已冻结待结算'
                    : charge.status === 'released' ? '已解冻' : '已扣费'
              return (
                <tr key={request.id}>
                  <td>{formatDate(request.createdAt)}<small>请求 {request.id.slice(0, 8)}…</small></td>
                  <td><strong>{consumerNames.get(request.consumerId) || request.consumerId.slice(0, 8)}</strong><small>Key {request.apiKeyId.slice(0, 8)}…</small></td>
                  <td><strong>{billingMeterLabel(request.billingMeterKey || request.capability || request.platform)}</strong><small>{request.billingMeterKey || request.capability || request.platform}</small></td>
                  <td><StatusBadge status={request.status} label={({ committed: '成功', released: '已释放', unknown: '待对账', reserved: '处理中' })[request.status] || request.status} /></td>
                  <td>{formatNumber(request.unitsActual || 0)} / {formatLatency(request.upstreamLatencyMs)}</td>
                  <td>{charge ? <strong>{formatMoneyMinor(chargeValue || 0, charge.currency)}</strong> : '—'}<small>{chargeHint}</small></td>
                  {session?.platformAdmin ? (
                    <td>{request.status === 'unknown'
                      && charge?.status === 'unknown'
                      && charge.enforcementMode === 'enforced'
                      && charge.quotedMinor > 0
                      ? <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => openReconciliation(request)}>处理冻结</button>
                      : <small>无需处理</small>}</td>
                  ) : null}
                </tr>
              )
            })}</tbody>
          </Table>
        ) : <EmptyState icon={Pulse} title="当前范围没有 API 调用" description="更换时间范围、租户或调用者后重试。" />}
      </Panel>

      <section className="mih-chart-grid">
        <Panel title="数据平台用量" subtitle="当前筛选范围" className="mih-chart-panel">
          {platforms.length ? <PlatformChart entries={platforms.slice(0, 10)} /> : <EmptyState icon={ChartLine} title="暂无用量" description="当前筛选范围没有请求。" />}
        </Panel>
        <Panel title="调用结果" subtitle="成功、释放与未知" className="mih-chart-panel">
          {usage.requests ? <OutcomeChart committed={usage.committed} released={usage.released} unknown={usage.unknown} /> : <EmptyState icon={Pulse} title="暂无结果分布" description="当前筛选范围没有请求。" />}
        </Panel>
      </section>

      <Panel title="平台计量明细" subtitle={`${platforms.length} 个平台`}>
        {platforms.length ? (
          <Table label="平台计量明细">
            <thead><tr><th>平台</th><th>请求</th><th>成功</th><th>已释放</th><th>结果未知</th><th>数据单元</th></tr></thead>
            <tbody>
              {platforms.map(([platform, item]) => (
                <tr key={platform}>
                  <td><strong>{platformLabel(platform)}</strong><small>{platform}</small></td>
                  <td>{formatNumber(item.requests)}</td>
                  <td>{formatNumber(item.committed)}</td>
                  <td>{formatNumber(item.released)}</td>
                  <td>{formatNumber(item.unknown)}</td>
                  <td>{formatNumber(item.units)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState icon={Database} title="没有可展示的记录" description="更换时间范围或调用者后重试。" />}
      </Panel>

      <Panel title="通用能力计量明细" subtitle={`${capabilities.length} 项能力`}>
        {capabilities.length ? (
          <Table label="通用能力计量明细">
            <thead><tr><th>能力</th><th>请求</th><th>成功</th><th>已释放</th><th>结果未知</th><th>工作单元</th></tr></thead>
            <tbody>
              {capabilities.map(([capability, item]) => (
                <tr key={capability}>
                  <td><strong>{CAPABILITY_CATALOG[capability]?.label || capability}</strong><small>{capability}</small></td>
                  <td>{formatNumber(item.requests)}</td>
                  <td>{formatNumber(item.committed)}</td>
                  <td>{formatNumber(item.released)}</td>
                  <td>{formatNumber(item.unknown)}</td>
                  <td>{formatNumber(item.units)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState icon={Brain} title="没有通用能力调用" description="为调用者授权能力并使用 API 后，这里会出现独立计量。" />}
      </Panel>

      <Panel title="按 Hub 计量键" subtitle="逻辑用量请求精确计数；不依赖价目表、客户扣费或上游调用数">
        {requestMeters.length ? (
          <Table label="按 Hub 计量键的请求明细">
            <thead><tr><th>开放能力</th><th>计量键</th><th>请求</th><th>成功</th><th>处理中</th><th>已释放</th><th>结果未知</th><th>工作单元</th></tr></thead>
            <tbody>{requestMeters.map(([meterKey, item]) => (
              <tr key={meterKey}>
                <td><strong>{billingMeterLabel(meterKey)}</strong></td>
                <td><code>{meterKey}</code></td>
                <td>{formatNumber(item.requests)}</td>
                <td>{formatNumber(item.committed)}</td>
                <td>{formatNumber(item.reserved)}</td>
                <td>{formatNumber(item.released)}</td>
                <td>{formatNumber(item.unknown)}</td>
                <td>{formatNumber(item.units)}</td>
              </tr>
            ))}</tbody>
          </Table>
        ) : <EmptyState icon={Pulse} title="当前范围没有可计量请求" description="请求一旦进入 Hub 逻辑用量账本，即使尚未定价也会在这里计数。" />}
      </Panel>

      <Panel title="客户计费按币种" subtitle="每种币种独立对账；跨币种不换汇、不相加，顶层仅汇总请求与计费状态次数">
        {billingCurrencies.length ? (
          <Table label="客户计费按币种汇总">
            <thead><tr><th>币种</th><th>计价记录</th><th>成功扣费次数</th><th>冻结次数</th><th>释放次数</th><th>影子次数</th><th>报价金额</th><th>已扣金额</th><th>冻结金额</th><th>影子报价</th></tr></thead>
            <tbody>{billingCurrencies.map(([currency, item]) => (
              <tr key={currency}>
                <td><strong>{currency}</strong></td>
                <td>{formatNumber(item.requests)}</td>
                <td>{formatNumber(item.capturedRequests)}</td>
                <td>{formatNumber(item.heldRequests)}</td>
                <td>{formatNumber(item.releasedRequests)}</td>
                <td>{formatNumber(item.shadowRequests)}</td>
                <td>{formatMoneyMinor(item.quotedMinor, currency)}</td>
                <td>{formatMoneyMinor(item.chargedMinor, currency)}</td>
                <td>{formatMoneyMinor(item.heldMinor, currency)}</td>
                <td>{formatMoneyMinor(item.shadowQuotedMinor, currency)}</td>
              </tr>
            ))}</tbody>
          </Table>
        ) : <EmptyState icon={Coins} title="当前范围没有按币种计费记录" description="计费记录产生后，会按原币种展示可独立核对的次数与金额。" />}
      </Panel>

      <Panel title="客户计费明细" subtitle="按 Hub 开放能力归集；计费状态次数与金额分别统计，不包含供应商名称、采购成本或上游调用次数">
        {billingMeters.length ? (
          <Table label="客户计费明细">
            <thead><tr><th>开放能力</th><th>计量键</th><th>计价记录</th><th>成功扣费次数</th><th>冻结次数</th><th>释放次数</th><th>影子次数</th><th>报价金额</th><th>已扣金额</th><th>冻结金额</th></tr></thead>
            <tbody>{billingMeters.map(([meterKey, item]) => (
              <tr key={meterKey}>
                <td><strong>{billingMeterLabel(meterKey)}</strong></td>
                <td><code>{meterKey}</code></td>
                <td>{formatNumber(item.requests)}</td>
                <td>{formatNumber(item.capturedRequests)}</td>
                <td>{formatNumber(item.heldRequests)}</td>
                <td>{formatNumber(item.releasedRequests)}</td>
                <td>{formatNumber(item.shadowRequests)}</td>
                <td>{billingMoney(item.quotedMinor, item.currency, item.mixedCurrencies)}</td>
                <td>{billingMoney(item.chargedMinor, item.currency, item.mixedCurrencies)}</td>
                <td>{billingMoney(item.heldMinor, item.currency, item.mixedCurrencies)}</td>
              </tr>
            ))}</tbody>
          </Table>
        ) : <EmptyState icon={Coins} title="当前范围没有计费记录" description="历史未计费调用不受影响；发布并分配计费套餐后才会记录客户报价。" />}
      </Panel>

      {reconcileTarget && session?.platformAdmin ? (
        <Modal
          title="处理未知请求冻结"
          description={`请求 ${reconcileTarget.request.id} 的交付状态保持“未知”；这里只依据人工证据结算客户侧冻结金额。`}
          busy={reconcileBusy}
          onClose={() => !reconcileBusy && setReconcileTarget(null)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setReconcileTarget(null)} disabled={reconcileBusy}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="customer-charge-reconciliation" disabled={reconcileBusy}>{reconcileBusy ? '正在对账…' : '确认结算'}</button>
            </>
          )}
        >
          <form id="customer-charge-reconciliation" className="mih-form" onSubmit={reconcileUnknownCharge}>
            <Field label="结算结果" hint="只有确认客户已收到有效交付时才选择扣费；否则释放冻结余额。">
              <select className="qp-input" value={reconcileForm.disposition} onChange={(event) => setReconcileForm({ ...reconcileForm, disposition: event.target.value })} autoFocus>
                <option value="release">释放冻结 · 未确认交付</option>
                <option value="capture">确认扣费 · 已确认交付</option>
              </select>
            </Field>
            <Field label="证据与事由" hint="会连同操作者写入不可变余额流水；重试沿用同一个幂等键。">
              <textarea className="qp-input" rows="4" maxLength="1024" value={reconcileForm.reason} onChange={(event) => setReconcileForm({ ...reconcileForm, reason: event.target.value })} placeholder="填写上游账单、交付日志或工单结论" required />
            </Field>
            {reconcileError ? <ErrorState error={reconcileError} /> : null}
          </form>
        </Modal>
      ) : null}
    </>
  )
}

export function RuntimePage({ token, onUnauthorized }) {
  const load = useCallback(() => adminApi.runtime(token), [token])
  const state = useRemoteData(load, onUnauthorized)

  if (state.loading && !state.data) return <LoadingState label="正在检查运行状态" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const runtime = state.data || {}
  const dependencies = runtime.dependencies || {}
  const liveStatus = runtime.status?.live || 'unknown'
  const readyStatus = runtime.status?.ready || 'unknown'
  const services = [
    { name: 'MX Insight API', role: '进程健康', status: liveStatus, detail: '当前管理接口可达' },
    { name: 'Readiness', role: '依赖就绪', status: readyStatus, detail: '核心依赖综合状态' },
    { name: 'Store', role: '用量与权限存储', status: dependencies.store?.status || 'unknown', detail: '持久化状态检查' },
    { name: '数据服务', role: '数据能力', status: dependencies.dataService?.status || 'unknown', detail: '数据能力就绪检查' },
  ]

  return (
    <>
      <PageHeading eyebrow="HEALTH / DEPENDENCIES / RECOVERY" title="运行状态" description="分别观察进程存活、存储和数据服务就绪状态，故障不会被聚合状态掩盖。" loading={state.loading} onRefresh={state.refresh} />
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      <section className="mih-runtime-grid">
        {services.map((service) => (
          <article className="qp-panel mih-runtime-card" key={service.name}>
            <span className="mih-runtime-card__icon">
              {service.name === 'Store' ? <Database size={23} weight="duotone" aria-hidden="true" /> : service.name === '数据服务' ? <Cloud size={23} weight="duotone" aria-hidden="true" /> : <Pulse size={23} weight="duotone" aria-hidden="true" />}
            </span>
            <div>
              <h2>{service.name}</h2>
              <p>{service.role}</p>
            </div>
            <StatusBadge status={service.status} />
            <small>{service.detail}</small>
          </article>
        ))}
      </section>
      <Panel title="运行边界" subtitle="MX Launcher 管部署入口，MX Insight Hub 管业务网关状态">
        <div className="mih-boundary-list">
          <div><strong>公开流量</strong><p>仅进入公开 Data API；Admin 与内部路径不对外暴露。</p></div>
          <div><strong>管理流量</strong><p>使用受保护的 Hub 会话，并由 MX Launcher 提供人工运维入口。</p></div>
          <div><strong>数据来源</strong><p>Hub 统一交付数据能力；调用者不会看到供应方身份、凭证和内部端点。</p></div>
        </div>
      </Panel>
    </>
  )
}
