import { useCallback, useRef, useState } from 'react'
import { productForPath } from '../shared/product-workbenches.mjs'
import { ProductApiConsole } from './product-workbench.jsx'
import { ProductViewTabs, ProductIntegrationGuide } from './product-management.jsx'
import { StrategySearchExperience, useStrategySearchState } from './strategy-search-experience.jsx'
import { ArrowRight, MagnifyingGlass, User, Users } from '@phosphor-icons/react'
import { adminApi, publicDocsHref } from './api.js'
import { DropdownField, ErrorState, Field, LoadingState, PageHeading, useRemoteData } from './components.jsx'
import { FacebookSearchPolicyForm } from './platform-search-policy.jsx'
import { STRATEGY_SEARCH_INTERFACES, STRATEGY_PROVIDER_LABELS, INSTAGRAM_STRATEGY_MODE_LABELS,
  STRATEGY_MIGRATION_LABELS, instagramStrategyOptions, instagramStrategyUpdate } from './strategy-search-model.js'
import { recordStrategyAttempt } from './strategy-search-experience-model.js'
import './strategy-search.css'

const icons = { search: MagnifyingGlass, crawl: Users, 'user-info': User }
const supplier = value => STRATEGY_PROVIDER_LABELS[value] || value
const migration = value => STRATEGY_MIGRATION_LABELS[value] || value || '状态未提供'

export function StrategySearchPage({ token, session, query, setQuery, onUnauthorized, notify, strategySession }) {
  const admin = session?.kind === 'admin-token' && session.platformAdmin === true
  const requested = { routing: 'management', interfaces: 'guide', demo: 'product' }[query.get('view')] || query.get('view')
  const tab = ['debug', 'product', 'guide', ...(admin ? ['management'] : [])].includes(requested) ? requested : 'debug'
  const [managementVisited, setManagementVisited] = useState(tab === 'management')
  const [result, setResult] = useState(null)
  const localStrategySession = useRef(new Map()), searchSession = strategySession || localStrategySession.current
  const { cell, state: searchState } = useStrategySearchState(searchSession)
  const pendingSearch = [...searchState.attempts.values()].some(attempt => ['sending', 'uncertain'].includes(attempt.state))
  const selected = STRATEGY_SEARCH_INTERFACES.find(row => row.id === query.get('interface')) || STRATEGY_SEARCH_INTERFACES[0]
  const changeTab = view => { if (view === 'management') setManagementVisited(true); setQuery({ view }) }
  return <div className="mih-page mih-strategy-search">
    <PageHeading title="策略搜索" description="从关键词、账号内容与资料接口接入 Hub，按目标平台查看内容与接入方式。">
      <a className="qp-button qp-button--outline" href={publicDocsHref('/docs/strategy-search')}>接口文档 ↗</a>
    </PageHeading>
    <ProductViewTabs label="策略搜索" value={tab} onChange={changeTab} session={session} />
    {pendingSearch ? <p role="status">有查询正在执行或结果待核实；新请求暂不可发送。可在产品展示中只读核对原请求。</p> : null}
    <div hidden={tab !== 'debug'}><ProductApiConsole product={productForPath('/data-products/strategy-search')} token={token} initialEndpoint={query.get('endpoint')} onResult={setResult} blocked={pendingSearch} attemptStore={searchState.consoleAttempts} onAttempt={event => recordStrategyAttempt(cell, event)} /></div>
    <div hidden={tab !== 'product'}><StrategySearchExperience strategySession={searchSession} initialResult={result} onResult={setResult} /></div>
    <div className="mih-strategy-guide" hidden={tab !== 'guide'}>
      <div className="mih-strategy-interface-cards" role="group" aria-label="选择业务接口">
        {STRATEGY_SEARCH_INTERFACES.map(row => { const Icon = icons[row.id]; return <button type="button" key={row.id}
          className={`mih-strategy-interface-card${selected.id === row.id ? ' is-selected' : ''}`} aria-pressed={selected.id === row.id}
          onClick={() => setQuery({ interface: row.id })}>
          <Icon size={24} weight="duotone" aria-hidden="true" /><strong>{row.label}</strong><span>{row.description}</span><ArrowRight size={18} aria-hidden="true" />
        </button> })}
      </div>
      <section className="qp-panel mih-panel mih-strategy-contract">
        <header><div><p className="qp-kicker">业务接口</p><h2>{selected.label}</h2></div>
          {admin ? <button className="qp-button qp-button--outline" type="button" onClick={() => { setManagementVisited(true); setQuery({ view: 'routing', interface: selected.id }) }}>迁移状态与平台路由 <ArrowRight size={16} aria-hidden="true" /></button> : null}</header>
        <div className="mih-strategy-paths">{selected.paths.map(path => <code key={path}>{path}</code>)}</div>
        <dl className="mih-strategy-contract-grid"><div><dt>请求</dt><dd>{selected.input}</dd></div><div><dt>响应</dt><dd>{selected.output}</dd></div></dl>
        <p>{selected.boundary}</p>
      </section>
      <ProductIntegrationGuide label="策略搜索" docs="strategy-search">
        <p>统一内容搜索使用 <code>/api/v1/data/search</code>，一次选择一个平台；TikTok 使用统一条目和分页字段。多个平台同时检索请使用聚合搜索。</p>
        <p>微信也使用此路径，兼容既有原生响应 <code>contractVersion / endpoint / data / meta / requestId</code>；可用 <code>params.raw=false</code> 显示 items，按 <code>continue_flag / cursor</code> 续页。微信公众号默认检索文章；其他微信与 TikTok 系列接口继续保留。</p>
        <p>每个新查询与下一页各使用新的 Idempotency-Key。fresh 原请求仅在 120 秒内重放已提交响应；stable 固定首次响应。产品展示使用 stable；新建相同查询必须显式操作。超时或结果未知时先只读核对使用记录。</p>
        <p>接口调试保留统一接口与兼容入口，按当前权限展示文档。微信的 <code>/api/v1/night-all/search/raw</code> 已退役并返回 410；其他保留入口继续遵守各自合同，不能互换游标。</p>
      </ProductIntegrationGuide>
    </div>
    {admin && (managementVisited || tab === 'management') ? <div hidden={tab !== 'management'}><StrategySearchManagement key={token} {...{ token, query, setQuery, onUnauthorized, notify }} /></div> : null}
  </div>
}

function InstagramSearchPolicyForm({ token, row, notify, onSaved }) {
  const [mode, setMode] = useState(row.policy.mode)
  const [primaryProvider, setPrimaryProvider] = useState(row.policy.primaryProvider)
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const options = instagramStrategyOptions(row)
  const fallbackProvider = options.providers.find(value => value !== primaryProvider)
  const valid = options.modes.includes(mode) && options.providers.includes(primaryProvider)
  async function save(event) {
    event.preventDefault()
    if (busy) return
    setBusy(true); setError(null)
    try {
      await adminApi.updateInstagramSearchStrategy(token, instagramStrategyUpdate(row, { mode, primaryProvider, reason }))
      onSaved(); notify?.('Instagram 关键词搜索策略已保存')
    } catch (failure) { setError(failure) } finally { setBusy(false) }
  }
  return <form className="mih-strategy-policy-form" onSubmit={save}>
    <div className="mih-external-two-column">
      <DropdownField label="选路方式" value={mode} disabled={busy} onChange={setMode}
        options={options.modes.map(value => ({ value, label: INSTAGRAM_STRATEGY_MODE_LABELS[value] }))} />
      <DropdownField label={mode === 'priority' ? '优先供应商' : mode === 'paused' ? '保留的供应商设置' : '固定供应商'} value={primaryProvider} disabled={busy} onChange={setPrimaryProvider}
        options={options.providers.map(value => ({ value, label: supplier(value) }))} />
    </div>
    {mode === 'priority' ? <p>保底供应商：<strong>{supplier(fallbackProvider)}</strong>。仅在首次请求尚未派发、优先供应商因凭据、开关、熔断或本地限流不可用时使用。实际供应商拒绝、400、超时或结果未知均不触发自动重试。</p>
      : mode === 'paused' ? <p>暂停新的搜索采集；已保存请求仍按各接口既有回放规则处理。</p> : <p>新搜索只使用 {supplier(primaryProvider)}；未就绪时返回对应原因，不自动切换供应商。</p>}
    <p>已有分页继续绑定原供应商，不跨供应商转换游标。策略调整不修改账号内容、账号资料、原有价格或历史账本。</p>
    <Field label="修改原因"><input className="qp-input" required maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="记录此次策略调整的原因" /></Field>
    {error ? <ErrorState error={error} /> : null}
    <div><button className="qp-button qp-button--primary" disabled={busy || !valid || !reason.trim()}>{busy ? '保存中…' : '保存搜索策略'}</button><span className="qp-muted"> 当前修订 #{row.policy.revision}</span></div>
  </form>
}

function StrategySearchManagement({ token, query, setQuery, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.strategySearch(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const interfaces = remote.data?.interfaces || []
  const selected = interfaces.find(row => row.id === query.get('interface')) || interfaces[0]
  const rows = selected?.platforms || []
  const row = rows.find(item => item.platform === query.get('platform')) || rows.find(item => item.platform === 'instagram') || rows[0]
  const instagramOptions = instagramStrategyOptions(row)
  const instagramEditable = selected?.id === 'search' && instagramOptions.providers.length > 0 && instagramOptions.modes.length > 0
  const facebookEditable = selected?.id === 'search' && row?.platform === 'facebook' && row.editable === true
    && row.policy && Number.isSafeInteger(row.policy.revision)
  return <div className="mih-strategy-management">
    <div className="mih-strategy-management-heading"><div><h2>业务接口的上游策略</h2><p>管理设置使用当前 Admin 会话。读取此页与保存策略不会发起供应商采集。</p></div>
      <button className="qp-button qp-button--outline" type="button" disabled={remote.loading} onClick={remote.refresh}>{remote.loading ? '刷新中…' : '刷新策略'}</button></div>
    {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
    {!remote.data && remote.loading ? <LoadingState label="正在读取接口与平台路由" /> : null}
    <StrategySearchUsage {...{ token, onUnauthorized }} interfaceId={selected?.id || query.get('interface') || 'search'} />
    {remote.data ? <>
      <div className="mih-strategy-route-layout">
        <nav className="mih-strategy-interface-nav" aria-label="上游策略业务接口">{interfaces.map(item => <button type="button" key={item.id}
          className={selected?.id === item.id ? 'is-selected' : ''} aria-pressed={selected?.id === item.id} onClick={() => setQuery({ interface: item.id })}>
          <strong>{item.label}</strong><small>{item.platforms.length} 个目标平台</small></button>)}</nav>
        <section className="qp-panel mih-panel mih-strategy-route-panel">
          {selected ? <><h2>{selected.label}</h2><p>{selected.description}</p><div className="mih-strategy-paths">{selected.paths.map(path => <code key={path}>{path}</code>)}</div>
            {row ? <>
              <DropdownField label="目标平台" value={row.platform} onChange={platform => setQuery({ platform })}
                options={rows.map(item => ({ value: item.platform, label: item.label || item.platform }))} />
              <header className="mih-strategy-route-heading"><h3>{row.label || row.platform}</h3><span className="qp-tag">{migration(row.migrationStatus)}</span></header>
              <p className="mih-strategy-current-route">{row.routeSummary || '尚未提供当前路由信息。'}</p>
              {instagramEditable ? <InstagramSearchPolicyForm key={`${selected.id}:${row.platform}:${row.policy.revision}`} {...{ token, row, notify }} onSaved={remote.refresh} />
                : facebookEditable ? <FacebookSearchPolicyForm key={`${row.platform}:${row.policy.revision}`} {...{ token, notify }} row={row.policy} onSaved={remote.refresh} />
                  : <div className="mih-strategy-readonly"><strong>当前只读</strong><p>{row.readOnlyReason || '此业务接口尚未开放可配置路由，沿用已登记的处理链路。'}</p></div>}
              {(row.providers || []).length ? <p className="mih-strategy-provider-links">{row.providers.map(provider => <a key={provider} href={`#/external-platforms?provider=${encodeURIComponent(provider)}`}>{supplier(provider)} 凭据与运行状态 ↗</a>)}</p> : null}
            </> : <p>此业务接口尚未登记目标平台。</p>}
          </> : <p>尚未读取到业务接口目录，请检查部署版本。</p>}
        </section>
      </div>
      {selected ? <section className="qp-panel mih-panel mih-strategy-contract"><h2>{selected.label} · 全部目标平台</h2><div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table">
        <thead><tr><th>目标平台</th><th>当前路由</th><th>迁移状态</th><th>配置</th></tr></thead>
        <tbody>{rows.map(item => <tr key={item.platform}><td><button type="button" className="qp-button qp-button--ghost" onClick={() => setQuery({ platform: item.platform })}>{item.label || item.platform}</button></td>
          <td>{item.routeSummary || '未提供'}</td><td>{migration(item.migrationStatus)}</td><td>{item.editable ? '可配置' : '只读'}</td></tr>)}</tbody>
      </table></div></section> : null}
    </> : null}
  </div>
}

function StrategySearchUsage({ token, onUnauthorized, interfaceId }) {
  const [days, setDays] = useState(7)
  const load = useCallback(() => adminApi.strategySearchUsage(token, days), [token, days])
  const remote = useRemoteData(load, onUnauthorized)
  const data = remote.data?.data || remote.data
  const items = (data?.items || []).filter(row => row.interface === interfaceId)
  return <section className="qp-panel mih-panel mih-strategy-usage" aria-label="策略接口每日调用次数">
    <header><div><h2>接口每日调用次数</h2><p>按已记录的业务请求观察迁移使用情况；读取此处不会发起采集。</p></div><div className="mih-page-actions">
      <DropdownField label="统计范围" value={String(days)} onChange={value => setDays(Number(value))} disabled={remote.loading} options={[7, 14, 31].map(value => ({ value: String(value), label: `最近 ${value} 天` }))} />
      <button className="qp-button qp-button--outline" type="button" disabled={remote.loading} onClick={remote.refresh}>刷新统计</button></div></header>
    {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
    {!data && remote.loading ? <LoadingState label="正在读取每日请求统计" /> : null}
    {data ? <><p>{data.fromDay} 至 {data.throughDay} · {data.timeZone || 'Asia/Shanghai'} · 今日数据尚未完整</p>
      <div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table"><thead><tr><th>接口（逻辑合同）</th><th>合计</th><th>进入 Night-All</th>{(data.days || []).map(day => <th key={day}>{day.slice(5)}</th>)}</tr></thead>
        <tbody>{items.map(row => <tr key={row.path}><td><code>{row.path}</code>{row.paths?.length > 1 ? <small className="mih-strategy-usage-alias">合并兼容别名</small> : null}</td><td>{row.total}</td><td>{row.nightAllRequests}</td>{(data.days || []).map(day => { const point = row.daily?.find(item => item.day === day); return <td key={day}><span>{point?.requests ?? 0}</span><small className="mih-strategy-usage-alias">Night-All {point?.nightAllRequests ?? 0}</small></td> })}</tr>)}</tbody>
      </table></div>
      {items.map(row => <details key={row.path}><summary><code>{row.path}</code> · 按平台查看</summary><div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table"><thead><tr><th>平台</th><th>合计</th><th>进入 Night-All</th>{(data.days || []).map(day => <th key={day}>{day.slice(5)}</th>)}</tr></thead><tbody>{(row.platforms || []).map(platform => <tr key={platform.platform}><td>{platform.platform === 'unspecified' ? '未指定平台' : platform.platform}</td><td>{platform.total}</td><td>{platform.nightAllRequests}</td>{(data.days || []).map(day => { const point = platform.daily?.find(item => item.day === day); return <td key={day}>{point?.requests ?? 0}<small className="mih-strategy-usage-alias">Night-All {point?.nightAllRequests ?? 0}</small></td> })}</tr>)}</tbody></table></div>{!row.platforms?.length ? <p>此统计窗口没有已记录的平台请求。</p> : null}</details>)}
      <div className="mih-strategy-usage-notes">{(data.notes || []).map((note, index) => <p key={index}>{note}</p>)}<p>历史兼容别名按逻辑合同合并，无法据此区分真实旧 URL 流量。Night-All 数量只统计关联到旧适配器证据的业务请求，不等同供应商派发次数；零值不能单独作为下线依据。</p></div>
    </> : null}
  </section>
}
