import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowRight,
  Buildings,
  Pulse,
  ChartLine,
  Cloud,
  Coins,
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
import { adminApi } from './api.js'
import {
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
]

const DEFAULT_POLICY = { maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 }

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
  return (
    <Field label={label} className="mih-filter-field">
      <select className="qp-select" value={value || ''} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value="">{emptyLabel}</option>
        {options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
      </select>
    </Field>
  )
}

function RangeFilter({ value, onChange }) {
  return (
    <Field label="时间范围" className="mih-filter-field">
      <select className="qp-select" value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="24h">近 24 小时</option>
        <option value="7d">近 7 天</option>
        <option value="30d">近 30 天</option>
      </select>
    </Field>
  )
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
  const [form, setForm] = useState({ tenantId: '', tenantName: '', name: '' })
  const [tenantDialog, setTenantDialog] = useState(null)
  const [tenantSaving, setTenantSaving] = useState(false)
  const [tenantError, setTenantError] = useState(null)

  const load = useCallback(async () => {
    const [tenants, consumers] = await Promise.all([adminApi.tenants(token), adminApi.consumers(token, tenantId)])
    return { tenants: tenants || [], consumers: consumers || [] }
  }, [tenantId, token])
  const state = useRemoteData(load, onUnauthorized)
  const tenants = state.data?.tenants || []
  const consumers = state.data?.consumers || []
  const visibleConsumers = consumers.filter((consumer) => consumer.name.toLowerCase().includes(search.trim().toLowerCase()))
  const tenantNames = new Map(tenants.map((tenant) => [tenant.id, tenant.name]))
  const consumerTenants = tenants.filter((tenant) => tenantAllows(session, tenant.id, 'consumer.write'))
  const canCreateConsumer = Boolean(session?.platformAdmin) || consumerTenants.length > 0
  const canCreateTenant = Boolean(session?.platformAdmin)

  const showCreate = () => {
    const selectedTenantId = consumerTenants.some((tenant) => tenant.id === tenantId)
      ? tenantId
      : consumerTenants[0]?.id || ''
    setForm({ tenantId: selectedTenantId, tenantName: '', name: '' })
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
      await adminApi.createConsumer(token, { tenantId: targetTenantId, name: form.name })
      setOpen(false)
      if (targetTenantId !== tenantId) setQuery({ tenantId: targetTenantId })
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
      <PageHeading eyebrow="IDENTITY / TENANCY" title="调用者管理" description="调用者是 API Key、平台授权和用量归属的最小业务主体。" loading={state.loading} onRefresh={state.refresh}>
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
          value={tenantId}
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
            <thead><tr><th>名称</th><th>租户</th><th>状态</th><th>创建时间</th><th>Consumer ID</th></tr></thead>
            <tbody>
              {visibleConsumers.map((consumer) => (
                <tr key={consumer.id}>
                  <td><strong>{consumer.name}</strong><small>独立权限与用量归属</small></td>
                  <td>{tenantNames.get(consumer.tenantId) || consumer.tenantId}</td>
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
              <Field label="所属租户">
                <select className="qp-select" value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} required autoFocus>
                  {consumerTenants.map((tenant) => <option value={tenant.id} key={tenant.id}>{tenant.name}</option>)}
                </select>
              </Field>
            ) : (
              <Field label="首个租户名称" hint="当前没有租户，提交时会先创建租户。">
                <input className="qp-input" value={form.tenantName} onChange={(event) => setForm({ ...form, tenantName: event.target.value })} required autoFocus />
              </Field>
            )}
            <Field label="调用者名称">
              <input className="qp-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：市场研究团队" required />
            </Field>
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
  const [form, setForm] = useState({ consumerId: '', name: '', environment: 'live', expiresInDays: 180 })
  const [issuedSecret, setIssuedSecret] = useState(null)
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    const allConsumers = (await adminApi.consumers(token)) || []
    const consumers = allConsumers.filter((consumer) => tenantAllows(session, consumer.tenantId, 'apikey.read'))
    const selectedConsumerId = consumers.some((consumer) => consumer.id === consumerId) ? consumerId : ''
    const keys = consumers.length ? await adminApi.apiKeys(token, selectedConsumerId) : []
    return { consumers, keys: keys || [], selectedConsumerId }
  }, [consumerId, session, token])
  const state = useRemoteData(load, onUnauthorized)
  const consumers = state.data?.consumers || []
  const keys = state.data?.keys || []
  const selectedConsumerId = state.data?.selectedConsumerId || ''
  const writableConsumers = consumers.filter((consumer) => tenantAllows(session, consumer.tenantId, 'apikey.write'))
  const canIssueKey = writableConsumers.length > 0
  const consumerNames = new Map(consumers.map((consumer) => [consumer.id, consumer.name]))

  const showCreate = () => {
    const targetConsumerId = writableConsumers.some((consumer) => consumer.id === selectedConsumerId)
      ? selectedConsumerId
      : writableConsumers[0]?.id || ''
    setForm({ consumerId: targetConsumerId, name: '', environment: 'live', expiresInDays: 180 })
    setFormError(null)
    setOpen(true)
  }

  const create = async (event) => {
    event.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const key = await adminApi.createApiKey(token, form)
      setOpen(false)
      setIssuedSecret({ secret: key.secret, expiresAt: key.expiresAt })
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

  if (state.loading && !state.data) return <LoadingState label="正在加载 API Keys" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  return (
    <>
      <PageHeading eyebrow="ACCESS / ROTATION / REVOCATION" title="API Keys" description="密钥只在签发时显示一次；权限、配额和用量绑定到调用者，默认有效期 180 天。" loading={state.loading} onRefresh={state.refresh}>
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
            <thead><tr><th>名称</th><th>调用者</th><th>密钥标识</th><th>状态</th><th>有效至</th><th>最后使用</th><th><span className="mih-sr-only">操作</span></th></tr></thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td><strong>{key.name}</strong><small>{formatDate(key.createdAt)} 签发</small></td>
                  <td>{consumerNames.get(key.consumerId) || key.consumerId}</td>
                  <td><code className="mih-mono">{key.prefix}****{key.lastFour}</code></td>
                  <td><StatusBadge status={key.effectiveStatus || key.status} /></td>
                  <td>{formatDate(key.expiresAt)}</td>
                  <td>{formatDate(key.lastUsedAt)}</td>
                  <td className="mih-table__actions mih-table__actions--wide">
                    {tenantAllows(session, key.tenantId, 'platform.write') ? (
                      <a
                        className="qp-button qp-button--ghost qp-button--sm"
                        href={`#/platforms?${new URLSearchParams({ tenantId: key.tenantId, consumerId: key.consumerId })}`}
                        aria-label={`管理 ${key.name} 所属调用者的平台授权`}
                      >
                        <SlidersHorizontal size={15} aria-hidden="true" />平台授权
                      </a>
                    ) : null}
                    {tenantAllows(session, key.tenantId, 'apikey.write') ? (
                      <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`撤销 ${key.name}`} disabled={key.status !== 'active'} onClick={() => setRevokeTarget(key)}>
                        <Trash size={17} aria-hidden="true" />
                      </button>
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
          title="签发 API Key"
          description="选择所属调用者和环境。完整 secret 只会显示一次。"
          onClose={() => !saving && setOpen(false)}
          footer={(
            <>
              <button className="qp-button qp-button--ghost" type="button" onClick={() => setOpen(false)} disabled={saving}>取消</button>
              <button className="qp-button qp-button--primary" type="submit" form="create-api-key" disabled={saving}>{saving ? '正在签发' : '签发密钥'}</button>
            </>
          )}
        >
          <form id="create-api-key" className="mih-form" onSubmit={create}>
            <Field label="调用者">
              <select className="qp-select" value={form.consumerId} onChange={(event) => setForm({ ...form, consumerId: event.target.value })} required autoFocus>
                {writableConsumers.map((consumer) => <option value={consumer.id} key={consumer.id}>{consumer.name}</option>)}
              </select>
            </Field>
            <Field label="密钥名称">
              <input className="qp-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="例如：数据分析生产环境" required />
            </Field>
            <Field label="环境">
              <select className="qp-select" value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value })}>
                <option value="live">Live</option>
                <option value="test">Test</option>
              </select>
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
        <Modal title="API Key 已签发" description={`这是唯一一次显示完整密钥；有效至 ${formatDate(issuedSecret.expiresAt)}。`} onClose={() => setIssuedSecret(null)} footer={<button className="qp-button qp-button--primary" type="button" onClick={() => setIssuedSecret(null)}>我已安全保存</button>}>
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
    </>
  )
}

async function loadConfigurationContext(token, requestedTenantId, requestedConsumerId) {
  const [tenants, allConsumers] = await Promise.all([adminApi.tenants(token), adminApi.consumers(token)])
  const safeTenants = tenants || []
  const safeConsumers = allConsumers || []
  const tenantId = requestedTenantId || safeTenants[0]?.id || ''
  const consumers = safeConsumers.filter((consumer) => !tenantId || consumer.tenantId === tenantId)
  const consumerId = consumers.some((consumer) => consumer.id === requestedConsumerId)
    ? requestedConsumerId
    : consumers[0]?.id || ''
  const configuration = tenantId && consumerId
    ? await adminApi.platforms(token, { tenantId, consumerId })
    : { grants: [], policies: [] }
  return { tenants: safeTenants, consumers, tenantId, consumerId, configuration }
}

export function PlansQuotasPage({ token, session, query, setQuery, onUnauthorized }) {
  const requestedTenantId = query.get('tenantId') || ''
  const requestedConsumerId = query.get('consumerId') || ''
  const load = useCallback(
    () => loadConfigurationContext(token, requestedTenantId, requestedConsumerId),
    [requestedConsumerId, requestedTenantId, token],
  )
  const state = useRemoteData(load, onUnauthorized)

  if (state.loading && !state.data) return <LoadingState label="正在加载配额策略" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const data = state.data || { tenants: [], consumers: [], configuration: { grants: [], policies: [] } }
  const policies = data.configuration?.policies || []
  const grants = new Set(data.configuration?.grants || [])
  const platformHref = `#/platforms?${new URLSearchParams({ tenantId: data.tenantId || '', consumerId: data.consumerId || '' })}`
  const selectedConsumer = data.consumers.find((consumer) => consumer.id === data.consumerId)
  const canManagePlatform = tenantAllows(session, selectedConsumer?.tenantId, 'platform.write')

  return (
    <>
      <PageHeading eyebrow="PLANS / LIMITS / CREDITS" title="套餐与配额" description="当前 MVP 使用租户与平台策略执行请求窗口和分页上限；后续套餐层映射到同一计量模型。" loading={state.loading} onRefresh={state.refresh}>
        {canManagePlatform ? <a className="qp-button qp-button--outline" href={platformHref}><SlidersHorizontal size={17} aria-hidden="true" />管理平台策略</a> : null}
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

      <section className="mih-metric-grid mih-metric-grid--compact" aria-label="默认配额基线">
        <MetricCard icon={Pulse} label="默认请求窗口" value={formatNumber(DEFAULT_POLICY.maxRequests)} hint="每个启用平台" />
        <MetricCard icon={Timer} label="窗口长度" value="1 小时" hint={`${DEFAULT_POLICY.windowSeconds} 秒`} tone="info" />
        <MetricCard icon={Database} label="最大分页" value={formatNumber(DEFAULT_POLICY.maxPageSize)} hint="单次 pageSize" tone="warning" />
        <MetricCard icon={Globe} label="已授权平台" value={formatNumber(grants.size)} hint="按调用者显式授权" tone="success" />
      </section>

      <Panel title="平台级配额" subtitle="显式策略覆盖默认基线">
        {policies.length ? (
          <Table label="平台级配额策略">
            <thead><tr><th>平台</th><th>授权</th><th>请求上限</th><th>窗口</th><th>最大分页</th><th>更新时间</th></tr></thead>
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
  const [configureTarget, setConfigureTarget] = useState(null)
  const [policyForm, setPolicyForm] = useState(DEFAULT_POLICY)
  const [formError, setFormError] = useState(null)
  const load = useCallback(
    () => loadConfigurationContext(token, requestedTenantId, requestedConsumerId),
    [requestedConsumerId, requestedTenantId, token],
  )
  const state = useRemoteData(load, onUnauthorized)

  useEffect(() => {
    setConfigureTarget(null)
    setFormError(null)
  }, [requestedConsumerId, requestedTenantId])

  if (state.loading && !state.data) return <LoadingState label="正在加载平台策略" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const data = state.data || { tenants: [], consumers: [], configuration: { grants: [], policies: [] } }
  const grants = new Set(data.configuration?.grants || [])
  const policyByPlatform = new Map((data.configuration?.policies || []).map((policy) => [policy.platform, policy]))
  const rows = PLATFORM_CATALOG.map((platform) => ({
    platform,
    enabled: grants.has(platform),
    policy: policyByPlatform.get(platform) || DEFAULT_POLICY,
    explicit: policyByPlatform.has(platform),
  }))
  const selectedTenant = data.tenants.find((tenant) => tenant.id === data.tenantId)
  const selectedConsumer = data.consumers.find((consumer) => consumer.id === data.consumerId)
  const contextMatchesRequest = (
    (!requestedTenantId || requestedTenantId === data.tenantId)
    && (!requestedConsumerId || requestedConsumerId === data.consumerId)
  )
  const contextUnavailable = state.loading || !contextMatchesRequest
  const hasPlatformWrite = tenantAllows(session, selectedConsumer?.tenantId, 'platform.write')
  const canUpdatePlatform = hasPlatformWrite && !contextUnavailable
  const mutationPending = Boolean(busyPlatform)
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

  return (
    <>
      <PageHeading eyebrow="PLATFORM / GRANTS / POLICY" title="平台能力" description="每个平台必须显式授权，并拥有独立的窗口限额与分页上限。" loading={state.loading} onRefresh={state.refresh} />
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
            <small>API Key 仅继承其所属调用者的平台权限</small>
          </div>
        ) : null}
      </section>

      <Panel title="平台授权矩阵" subtitle={`${grants.size} / ${PLATFORM_CATALOG.length} 已启用`}>
        {data.consumerId ? (
          <Table label="平台授权与策略">
            <thead><tr><th>平台</th><th>状态</th><th>请求上限</th><th>窗口</th><th>最大分页</th><th>操作</th></tr></thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.platform}>
                  <td><strong>{platformLabel(row.platform)}</strong><small>{row.platform}</small></td>
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
        ) : (
          <EmptyState icon={Globe} title={data.tenants.length ? '请选择调用者' : '请先创建调用者'} description="平台授权与配额策略必须绑定到具体调用者。" action={!data.tenants.length ? <a className="qp-button qp-button--outline" href="#/consumers"><Users size={16} aria-hidden="true" />前往调用者</a> : null} />
        )}
      </Panel>

      {configureTarget && canUpdatePlatform ? (
        <Modal
          title={`配置 ${platformLabel(configureTarget.platform)}`}
          description={`保存后立即作用于调用者「${selectedConsumer?.name || data.consumerId}」的新请求。`}
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
            <Field label="窗口请求上限">
              <input className="qp-input" type="number" min="1" value={policyForm.maxRequests} onChange={(event) => setPolicyForm({ ...policyForm, maxRequests: event.target.value })} required autoFocus />
            </Field>
            <Field label="窗口长度（秒）">
              <input className="qp-input" type="number" min="1" value={policyForm.windowSeconds} onChange={(event) => setPolicyForm({ ...policyForm, windowSeconds: event.target.value })} required />
            </Field>
            <Field label="最大 pageSize">
              <input className="qp-input" type="number" min="1" value={policyForm.maxPageSize} onChange={(event) => setPolicyForm({ ...policyForm, maxPageSize: event.target.value })} required />
            </Field>
            {formError ? <div className="mih-form__wide"><ErrorState error={formError} /></div> : null}
          </form>
        </Modal>
      ) : null}
    </>
  )
}

export function UsagePage({ token, query, setQuery, onUnauthorized }) {
  const tenantId = query.get('tenantId') || ''
  const consumerId = query.get('consumerId') || ''
  const range = query.get('range') || '24h'
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

  return (
    <>
      <PageHeading eyebrow="METERING / COST / AUDIT" title="使用记录" description="以请求结果、实际数据单元和上游耗时作为计量与对账证据。" loading={state.loading} onRefresh={state.refresh} />
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
        <MetricCard icon={Coins} label="数据用量" value={formatNumber(usage.units)} hint="按实际返回记录计量" tone="warning" />
        <MetricCard icon={Timer} label="平均上游耗时" value={formatLatency(usage.averageUpstreamLatencyMs)} hint={`${formatNumber(usage.unknown)} 次结果未知`} tone="archetype" />
      </section>

      <section className="mih-chart-grid">
        <Panel title="平台用量" subtitle="当前筛选范围" className="mih-chart-panel">
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
    </>
  )
}

export function RuntimePage({ token, onUnauthorized }) {
  const load = useCallback(() => adminApi.runtime(token), [token])
  const state = useRemoteData(load, onUnauthorized)

  if (state.loading && !state.data) return <LoadingState label="正在检查运行状态" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const runtime = state.data || {}
  const dependencies = runtime.dependencies?.data || runtime.ready?.data?.dependencies || {}
  const liveStatus = runtime.live?.data?.status || (runtime.live?.ok ? 'live' : 'down')
  const readyStatus = runtime.ready?.data?.status || (runtime.ready?.ok ? 'ready' : 'not_ready')
  const services = [
    { name: 'MX Insight API', role: '进程健康', status: liveStatus, detail: runtime.live?.status ? `HTTP ${runtime.live.status}` : runtime.live?.error?.message },
    { name: 'Readiness', role: '依赖就绪', status: readyStatus, detail: runtime.ready?.status ? `HTTP ${runtime.ready.status}` : runtime.ready?.error?.message },
    { name: 'Store', role: '用量与权限存储', status: dependencies.store?.status || 'unknown', detail: dependencies.store?.detail || '持久化状态检查' },
    { name: 'Night-All', role: '内部数据源', status: dependencies.nightAll?.status || 'unknown', detail: dependencies.nightAll?.detail || '数据能力就绪检查' },
  ]

  return (
    <>
      <PageHeading eyebrow="HEALTH / DEPENDENCIES / RECOVERY" title="运行状态" description="分别观察进程存活、存储就绪和 Night-All 内部依赖，故障不会被聚合状态掩盖。" loading={state.loading} onRefresh={state.refresh} />
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      <section className="mih-runtime-grid">
        {services.map((service) => (
          <article className="qp-panel mih-runtime-card" key={service.name}>
            <span className="mih-runtime-card__icon">
              {service.name === 'Store' ? <Database size={23} weight="duotone" aria-hidden="true" /> : service.name === 'Night-All' ? <Cloud size={23} weight="duotone" aria-hidden="true" /> : <Pulse size={23} weight="duotone" aria-hidden="true" />}
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
          <div><strong>管理流量</strong><p>使用 session-only Admin Token，并由 MX Launcher 提供人工运维入口。</p></div>
          <div><strong>数据来源</strong><p>Night-All 作为内部一手来源，调用者不会看到其凭证和内部端点。</p></div>
        </div>
      </Panel>
    </>
  )
}
