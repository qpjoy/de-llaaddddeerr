import { useCallback, useMemo, useState } from 'react'
import {
  Pulse,
  ChartLine,
  Cloud,
  Coins,
  Database,
  Globe,
  Key,
  MagnifyingGlass,
  Plus,
  Power,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
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
  SecretPanel,
  StatusBadge,
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
]

const DEFAULT_POLICY = { maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 }

function sortedPlatforms(byPlatform = {}) {
  return Object.entries(byPlatform).sort((left, right) => Number(right[1]?.requests || 0) - Number(left[1]?.requests || 0))
}

function FilterSelect({ label, value, onChange, options, emptyLabel = '全部' }) {
  return (
    <Field label={label} className="mih-filter-field">
      <select className="qp-select" value={value || ''} onChange={(event) => onChange(event.target.value)}>
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

export function DashboardPage({ token, query, setQuery, onUnauthorized }) {
  const range = query.get('range') || '24h'
  const load = useCallback(async () => {
    const [summary, usage] = await Promise.all([
      adminApi.dashboard(token),
      adminApi.usage(token, rangeBounds(range)),
    ])
    return { summary, usage }
  }, [range, token])
  const state = useRemoteData(load, onUnauthorized)

  if (state.loading && !state.data) return <LoadingState label="正在汇总网关指标" />
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.refresh} />

  const summary = state.data?.summary || {}
  const usage = state.data?.usage || {}
  const platforms = sortedPlatforms(usage.byPlatform)
  const successRate = percent(usage.committed, usage.requests)

  return (
    <>
      <PageHeading
        eyebrow="GATEWAY / GOVERNANCE / EVIDENCE"
        title="数据网关总览"
        description="统一观察调用者、API Key、平台权限、用量与上游稳定性。"
        loading={state.loading}
        onRefresh={state.refresh}
      >
        <RangeFilter value={range} onChange={(value) => setQuery({ range: value })} />
      </PageHeading>

      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}

      <section className="mih-metric-grid" aria-label="核心指标">
        <MetricCard icon={Key} label="启用 API Key" value={formatNumber(summary.activeApiKeys)} hint={`${formatNumber(summary.consumers)} 个调用者`} />
        <MetricCard icon={Pulse} label="区间请求" value={formatNumber(usage.requests)} hint={`累计 ${formatNumber(summary.requests)}`} tone="info" />
        <MetricCard icon={ShieldCheck} label="成功率" value={successRate} hint={`${formatNumber(usage.committed)} 次成功`} tone="success" />
        <MetricCard icon={Coins} label="数据用量" value={formatNumber(usage.units)} hint="按实际返回记录计量" tone="warning" />
        <MetricCard icon={Timer} label="平均上游耗时" value={formatLatency(usage.averageUpstreamLatencyMs)} hint="不含客户端网络耗时" tone="archetype" />
        <MetricCard icon={WarningCircle} label="结果未知" value={formatNumber(usage.unknown)} hint="需要人工核验后再重试" tone="danger" />
        <MetricCard icon={Users} label="调用者" value={formatNumber(summary.consumers)} hint={`${formatNumber(summary.tenants)} 个租户`} tone="info" />
        <MetricCard icon={Globe} label="活跃平台" value={formatNumber(platforms.length)} hint="当前统计窗口内有调用" />
      </section>

      <section className="mih-chart-grid">
        <Panel title="调用结果" subtitle="成功、已释放与结果未知" className="mih-chart-panel">
          {usage.requests ? <OutcomeChart committed={usage.committed} released={usage.released} unknown={usage.unknown} /> : (
            <EmptyState icon={ChartLine} title="当前窗口暂无请求" description="产生调用后，这里会展示结果分布。" />
          )}
        </Panel>
        <Panel title="平台请求分布" subtitle="按请求数从高到低排列" className="mih-chart-panel">
          {platforms.length ? <PlatformChart entries={platforms.slice(0, 8)} /> : (
            <EmptyState icon={Globe} title="暂无平台用量" description="启用平台并完成调用后即可查看。" />
          )}
        </Panel>
      </section>

      <Panel title="平台用量摘要" subtitle="仅显示网关业务语义，不暴露上游凭证或内部端点">
        {platforms.length ? (
          <Table label="平台用量摘要">
            <thead><tr><th>平台</th><th>请求</th><th>成功</th><th>用量</th><th>状态</th></tr></thead>
            <tbody>
              {platforms.map(([platform, item]) => (
                <tr key={platform}>
                  <td><strong>{platformLabel(platform)}</strong><small>{platform}</small></td>
                  <td>{formatNumber(item.requests)}</td>
                  <td>{formatNumber(item.committed)}</td>
                  <td>{formatNumber(item.units)}</td>
                  <td><StatusBadge status={item.unknown ? 'warning' : item.released ? 'degraded' : 'active'} label={item.unknown ? '需核验' : item.released ? '有失败' : '正常'} /></td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState icon={Globe} title="暂无平台数据" description="平台用量会在第一笔请求完成后出现。" />}
      </Panel>
    </>
  )
}

export function ConsumersPage({ token, query, setQuery, onUnauthorized, notify }) {
  const tenantId = query.get('tenantId') || ''
  const [search, setSearch] = useState('')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [form, setForm] = useState({ tenantId: '', tenantName: '', name: '' })

  const load = useCallback(async () => {
    const [tenants, consumers] = await Promise.all([adminApi.tenants(token), adminApi.consumers(token, tenantId)])
    return { tenants: tenants || [], consumers: consumers || [] }
  }, [tenantId, token])
  const state = useRemoteData(load, onUnauthorized)
  const tenants = state.data?.tenants || []
  const consumers = state.data?.consumers || []
  const visibleConsumers = consumers.filter((consumer) => consumer.name.toLowerCase().includes(search.trim().toLowerCase()))
  const tenantNames = new Map(tenants.map((tenant) => [tenant.id, tenant.name]))

  const showCreate = () => {
    setForm({ tenantId: tenantId || tenants[0]?.id || '', tenantName: '', name: '' })
    setFormError(null)
    setOpen(true)
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
        <button className="qp-button qp-button--primary" type="button" onClick={showCreate}>
          <UserPlus size={17} aria-hidden="true" />新建调用者
        </button>
      </PageHeading>
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
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
            action={!search ? <button className="qp-button qp-button--outline" type="button" onClick={showCreate}><Plus size={16} aria-hidden="true" />新建调用者</button> : null}
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
            {tenants.length ? (
              <Field label="所属租户">
                <select className="qp-select" value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} required autoFocus>
                  {tenants.map((tenant) => <option value={tenant.id} key={tenant.id}>{tenant.name}</option>)}
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
    </>
  )
}

export function ApiKeysPage({ token, query, setQuery, onUnauthorized, notify }) {
  const consumerId = query.get('consumerId') || ''
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [form, setForm] = useState({ consumerId: '', name: '', environment: 'live' })
  const [issuedSecret, setIssuedSecret] = useState(null)
  const [revokeTarget, setRevokeTarget] = useState(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    const [consumers, keys] = await Promise.all([adminApi.consumers(token), adminApi.apiKeys(token, consumerId)])
    return { consumers: consumers || [], keys: keys || [] }
  }, [consumerId, token])
  const state = useRemoteData(load, onUnauthorized)
  const consumers = state.data?.consumers || []
  const keys = state.data?.keys || []
  const consumerNames = new Map(consumers.map((consumer) => [consumer.id, consumer.name]))

  const showCreate = () => {
    setForm({ consumerId: consumerId || consumers[0]?.id || '', name: '', environment: 'live' })
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
      setIssuedSecret(key.secret)
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
      <PageHeading eyebrow="ACCESS / ROTATION / REVOCATION" title="API Keys" description="密钥只在签发时显示一次；权限、配额和用量绑定到调用者。" loading={state.loading} onRefresh={state.refresh}>
        <button className="qp-button qp-button--primary" type="button" onClick={showCreate} disabled={!consumers.length}>
          <Plus size={17} aria-hidden="true" />签发 API Key
        </button>
      </PageHeading>
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
      <section className="qp-panel mih-filterbar">
        <FilterSelect
          label="调用者"
          value={consumerId}
          onChange={(value) => setQuery({ consumerId: value || null })}
          options={consumers.map((consumer) => ({ value: consumer.id, label: consumer.name }))}
        />
      </section>
      <Panel title="已签发密钥" subtitle={`${keys.length} 条记录`}>
        {keys.length ? (
          <Table label="API Key 列表">
            <thead><tr><th>名称</th><th>调用者</th><th>密钥标识</th><th>状态</th><th>最后使用</th><th><span className="mih-sr-only">操作</span></th></tr></thead>
            <tbody>
              {keys.map((key) => (
                <tr key={key.id}>
                  <td><strong>{key.name}</strong><small>{formatDate(key.createdAt)} 签发</small></td>
                  <td>{consumerNames.get(key.consumerId) || key.consumerId}</td>
                  <td><code className="mih-mono">{key.prefix}****{key.lastFour}</code></td>
                  <td><StatusBadge status={key.status} /></td>
                  <td>{formatDate(key.lastUsedAt)}</td>
                  <td className="mih-table__actions">
                    <button className="qp-button qp-button--ghost qp-icon-button" type="button" aria-label={`撤销 ${key.name}`} disabled={key.status !== 'active'} onClick={() => setRevokeTarget(key)}>
                      <Trash size={17} aria-hidden="true" />
                    </button>
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
            action={consumers.length ? <button className="qp-button qp-button--outline" type="button" onClick={showCreate}><Plus size={16} aria-hidden="true" />签发 API Key</button> : <a className="qp-button qp-button--outline" href="#/consumers"><Users size={16} aria-hidden="true" />前往调用者</a>}
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
                {consumers.map((consumer) => <option value={consumer.id} key={consumer.id}>{consumer.name}</option>)}
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
            {formError ? <ErrorState error={formError} /> : null}
          </form>
        </Modal>
      ) : null}

      {issuedSecret ? (
        <Modal title="API Key 已签发" description="这是唯一一次显示完整密钥。" onClose={() => setIssuedSecret(null)} footer={<button className="qp-button qp-button--primary" type="button" onClick={() => setIssuedSecret(null)}>我已安全保存</button>}>
          <SecretPanel secret={issuedSecret} onCopied={() => notify('密钥已复制', 'success')} />
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

export function PlansQuotasPage({ token, query, setQuery, onUnauthorized }) {
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

  return (
    <>
      <PageHeading eyebrow="PLANS / LIMITS / CREDITS" title="套餐与配额" description="当前 MVP 使用租户与平台策略执行请求窗口和分页上限；后续套餐层映射到同一计量模型。" loading={state.loading} onRefresh={state.refresh}>
        <a className="qp-button qp-button--outline" href={platformHref}><SlidersHorizontal size={17} aria-hidden="true" />管理平台策略</a>
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
            action={data.consumerId ? <a className="qp-button qp-button--outline" href={platformHref}><SlidersHorizontal size={16} aria-hidden="true" />配置平台</a> : null}
          />
        )}
      </Panel>
    </>
  )
}

export function PlatformsPage({ token, query, setQuery, onUnauthorized, notify }) {
  const requestedTenantId = query.get('tenantId') || ''
  const requestedConsumerId = query.get('consumerId') || ''
  const [busyPlatform, setBusyPlatform] = useState('')
  const [configureTarget, setConfigureTarget] = useState(null)
  const [policyForm, setPolicyForm] = useState(DEFAULT_POLICY)
  const [formError, setFormError] = useState(null)
  const load = useCallback(
    () => loadConfigurationContext(token, requestedTenantId, requestedConsumerId),
    [requestedConsumerId, requestedTenantId, token],
  )
  const state = useRemoteData(load, onUnauthorized)

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

  const updatePlatform = async (row, enabled, overrides = row.policy) => {
    if (!data.tenantId || !data.consumerId) return
    setBusyPlatform(row.platform)
    setFormError(null)
    try {
      await adminApi.updatePlatform(token, row.platform, {
        tenantId: data.tenantId,
        consumerId: data.consumerId,
        enabled,
        maxRequests: Number(overrides.maxRequests),
        windowSeconds: Number(overrides.windowSeconds),
        maxPageSize: Number(overrides.maxPageSize),
      })
      setConfigureTarget(null)
      state.refresh()
      notify(`${platformLabel(row.platform)} 已${enabled ? '启用' : '停用'}`, 'success')
    } catch (error) {
      if (error?.status === 401) onUnauthorized(error)
      if (configureTarget) setFormError(error)
      else notify(error.message || '平台更新失败', 'danger')
    } finally {
      setBusyPlatform('')
    }
  }

  const configure = (row) => {
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
                    <button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={() => configure(row)}>
                      <SlidersHorizontal size={15} aria-hidden="true" />配置
                    </button>
                    <button
                      className={`qp-button qp-button--sm ${row.enabled ? 'qp-button--transparent' : 'qp-button--outline'}`}
                      type="button"
                      aria-pressed={row.enabled}
                      disabled={busyPlatform === row.platform}
                      onClick={() => updatePlatform(row, !row.enabled)}
                    >
                      <Power size={15} weight={row.enabled ? 'fill' : 'regular'} aria-hidden="true" />
                      {busyPlatform === row.platform ? '处理中' : row.enabled ? '停用' : '启用'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState icon={Globe} title={data.tenants.length ? '请选择调用者' : '请先创建调用者'} description="平台授权与配额策略必须绑定到具体调用者。" action={!data.tenants.length ? <a className="qp-button qp-button--outline" href="#/consumers"><Users size={16} aria-hidden="true" />前往调用者</a> : null} />
        )}
      </Panel>

      {configureTarget ? (
        <Modal
          title={`配置 ${platformLabel(configureTarget.platform)}`}
          description="保存后立即作用于该调用者的新请求。"
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
