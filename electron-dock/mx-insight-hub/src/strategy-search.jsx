import { useCallback, useRef, useState } from 'react'
import { productForPath } from '../shared/product-workbenches.mjs'
import { ProductApiConsole } from './product-workbench.jsx'
import { ProductViewTabs, ProductIntegrationGuide, ProductManagement } from './product-management.jsx'
import { StrategySearchExperience, useStrategySearchState } from './strategy-search-experience.jsx'
import { ArrowRight, MagnifyingGlass, User, Users } from '@phosphor-icons/react'
import { adminApi, publicDocsHref } from './api.js'
import { DropdownField, ErrorState, Field, LoadingState, PageHeading, useRemoteData } from './components.jsx'
import { StrategyDataStatistics } from './strategy-data-statistics.jsx'
import { FacebookSearchPolicyForm } from './platform-search-policy.jsx'
import { STRATEGY_SEARCH_INTERFACES, STRATEGY_PROVIDER_LABELS, INSTAGRAM_STRATEGY_MODE_LABELS,
  STRATEGY_MIGRATION_LABELS, instagramStrategyOptions, instagramStrategyUpdate, strategyPolicySummary } from './strategy-search-model.js'
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
    {pendingSearch ? <p role="status">有平台的原查询正在执行或结果待核实。产品展示可切换其他平台；接口调试暂不可发送新请求。可回到原平台只读核对。</p> : null}
    <div hidden={tab !== 'debug'}><ProductApiConsole product={productForPath('/data-products/strategy-search')} token={token} initialEndpoint={query.get('endpoint')} onResult={setResult} blocked={pendingSearch} attemptStore={searchState.consoleAttempts} onAttempt={event => recordStrategyAttempt(cell, event)} /></div>
    <div hidden={tab !== 'product'}><StrategySearchExperience strategySession={searchSession} initialResult={result} onResult={setResult}
      operation={selected.id} onOperationChange={interfaceId => setQuery({ interface: interfaceId })} /></div>
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
        <p>账号内容使用 <code>/api/v1/data/social/crawl</code>，账号资料使用 <code>/api/v1/data/social/user-info</code>。保留 username、userId、user_id、uid 等账号别名与 raw_info / raw_data JSON 字符串，并提供 items 与 pageInfo。各平台支持范围、批量参数和返回字段见接口文档。</p>
        <p>账号接口分别要求平台授权及 <code>social.content.crawl</code>、<code>social.profile.get</code>。旧转发入口暂时保留；切换到 Hub 社交接口需从第一页开始，不能携带旧路径游标。</p>
        <p>统一内容搜索使用 <code>/api/v1/data/search</code>，一次选择一个平台；TikTok 使用统一条目和分页字段。多个平台同时检索请使用聚合搜索。</p>
        <p>微信也使用此路径，兼容既有原生响应 <code>contractVersion / endpoint / data / meta / requestId</code>；可用 <code>params.raw=false</code> 显示 items，按 <code>continue_flag / cursor</code> 续页。微信公众号默认检索文章；其他微信与 TikTok 系列接口继续保留。</p>
        <p>每个新查询与下一页各使用新的 Idempotency-Key。fresh 原请求仅在 120 秒内重放已提交响应；stable 固定首次响应。产品展示使用 stable；新建相同查询必须显式操作。超时或结果未知时先只读核对使用记录。</p>
        <p>接口调试保留统一接口与兼容入口，按当前权限展示文档。微信的 <code>/api/v1/night-all/search/raw</code> 已退役并返回 410；其他保留入口继续遵守各自合同，不能互换游标。</p>
      </ProductIntegrationGuide>
    </div>
    {admin && (managementVisited || tab === 'management') ? <div hidden={tab !== 'management'}><StrategySearchManagement key={token} {...{ token, session, query, setQuery, onUnauthorized, notify }} /></div> : null}
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
      <DropdownField label="策略方式" value={mode} disabled={busy} onChange={setMode}
        options={options.modes.map(value => ({ value, label: INSTAGRAM_STRATEGY_MODE_LABELS[value] }))} />
      <DropdownField label={mode === 'priority' ? '优先供应商（派发前可用保底）' : mode === 'paused' ? '保留的供应商设置' : '固定供应商（不启用保底）'} value={primaryProvider} disabled={busy} onChange={setPrimaryProvider}
        options={options.providers.map(value => ({ value, label: supplier(value) }))} />
    </div>
    {mode === 'priority' ? <p>保底供应商：<strong>{supplier(fallbackProvider)}</strong>。仅在首次请求尚未派发、优先供应商因凭据、开关、熔断或本地限流不可用时使用。实际供应商拒绝、400、超时或结果未知均不触发自动重试。</p>
      : mode === 'paused' ? <p>暂停新的搜索采集；已保存请求仍按各接口既有回放规则处理。</p> : <p>新搜索只使用 {supplier(primaryProvider)}；未就绪时返回对应原因，不自动切换供应商。</p>}
    <p>已有分页继续绑定原供应商，不跨供应商转换游标。策略调整不修改账号内容、账号资料、原有价格或历史账本。</p>
    <Field label="修改原因"><input className="qp-input" required maxLength={1000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="记录此次策略调整的原因" /></Field>
    {error ? <ErrorState error={error} /> : null}
    <div><button className="qp-button qp-button--primary" disabled={busy || !valid || !reason.trim()}>{busy ? '保存中…' : '保存 Instagram 搜索策略'}</button><span className="qp-muted"> 当前修订 #{row.policy.revision}</span></div>
  </form>
}

function StrategySearchManagement({ token, session, query, setQuery, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.strategySearch(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const interfaces = remote.data?.interfaces || []
  const selected = interfaces.find(row => row.id === query.get('interface')) || interfaces[0]
  const rows = selected?.platforms || []
  const row = rows.find(item => item.platform === query.get('platform')) || rows.find(item => item.platform === 'instagram') || rows[0]
  const summary = strategyPolicySummary(selected?.id, row)
  const configurable = (interfaces.find(item => item.id === 'search')?.platforms || []).filter(item => strategyPolicySummary('search', item).editor)
  const chooseInterface = interfaceId => {
    const next = interfaces.find(item => item.id === interfaceId)?.platforms || []
    setQuery({ interface: interfaceId, platform: next.find(item => item.platform === row?.platform)?.platform || next[0]?.platform })
  }
  return <div className="mih-strategy-management">
    <div className="mih-strategy-management-heading"><div><h2>上游供应商与搜索策略</h2><p>策略按业务接口和目标平台独立生效。读取此页与保存配置不会发起供应商采集。</p></div>
      <button className="qp-button qp-button--outline" type="button" disabled={remote.loading} onClick={remote.refresh}>{remote.loading ? '刷新中…' : '刷新策略'}</button></div>
    {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
    {!remote.data && remote.loading ? <LoadingState label="正在读取接口与平台路由" /> : null}
    {remote.data ? <>
      <section className="qp-panel mih-panel mih-strategy-scope" aria-label="选择策略配置范围">
        <div className="mih-strategy-scope-fields">
          <DropdownField label="业务接口" value={selected?.id || ''} onChange={chooseInterface}
            options={interfaces.map(item => ({ value: item.id, label: item.label }))} />
          <DropdownField label="目标平台" value={row?.platform || ''} onChange={platform => setQuery({ platform })}
            options={rows.map(item => ({ value: item.platform, label: `${item.label || item.platform} · ${strategyPolicySummary(selected?.id, item).editor ? '可修改策略' : '只读路由'}` }))} />
        </div>
        <p>当前配置范围：<strong>{selected?.label || '未选择接口'} / {row?.label || row?.platform || '未选择平台'}</strong>。平台间的策略互不覆盖；修改内容搜索不会更改账号内容或账号资料。</p>
        {configurable.length ? <div className="mih-strategy-configurable-links"><span>内容搜索可配置：</span>{configurable.map(item => <button key={item.platform} className="qp-button qp-button--outline qp-button--sm" type="button" onClick={() => setQuery({ interface: 'search', platform: item.platform })}>{item.label || item.platform}</button>)}</div> : null}
      </section>
      {selected && row ? <section className="qp-panel mih-panel mih-strategy-route-panel" aria-label={`${row.label || row.platform}当前策略与配置`}>
        <header className="mih-strategy-route-heading"><div><p className="qp-kicker">{selected.label} / {row.label || row.platform}</p><h2>当前已保存策略</h2></div><div className="mih-strategy-route-badges"><span className="qp-tag">{migration(row.migrationStatus)}</span><span className="qp-tag">{summary.editor ? '可修改策略' : '只读路由'}</span></div></header>
        <div className="mih-strategy-effective-policy"><strong>{summary.title}</strong><p>{summary.description}</p>
          <dl><div><dt>策略方式</dt><dd>{summary.mode}</dd></div><div><dt>{summary.editor ? '可选供应商' : '登记供应商'}</dt><dd>{summary.providers.length ? summary.providers.map(supplier).join(' / ') : '不适用'}</dd></div>{summary.revision ? <div><dt>当前修订</dt><dd>#{summary.revision}</dd></div> : null}</dl>
        </div>
        {summary.editor ? <div className="mih-strategy-editor">
          <header><h3>修改 {row.label || row.platform} 搜索策略</h3><p>以下为待保存配置；填写修改原因并保存后生效。可用方式：{summary.modes.join('；')}。</p></header>
          {summary.editor === 'instagram' ? <InstagramSearchPolicyForm key={`${selected.id}:${row.platform}:${row.policy.revision}`} {...{ token, row, notify }} onSaved={remote.refresh} />
            : <FacebookSearchPolicyForm key={`${row.platform}:${row.policy.revision}`} {...{ token, notify }} row={row.policy} allowedModes={row.allowedModes} onSaved={remote.refresh} />}
        </div> : <div className="mih-strategy-readonly"><strong>{row.editable ? '策略尚未就绪' : '当前未开放供应商切换'}</strong><p>{row.readOnlyReason || summary.description}</p><p>供应商目录、凭据或某个平台的其他接口已接入，并不代表当前业务接口具有可切换的兼容适配器。</p></div>}
        <details className="mih-strategy-route-details"><summary>接口范围与执行路由</summary><p>{row.routeSummary || '尚未提供当前路由信息。'}</p><p>{selected.description}</p><div className="mih-strategy-paths">{selected.paths.map(path => <code key={path}>{path}</code>)}</div></details>
        {(row.providers || []).length ? <p className="mih-strategy-provider-links">{row.providers.map(provider => <a key={provider} href={`#/external-platforms?provider=${encodeURIComponent(provider)}`}>{supplier(provider)} 凭据与运行状态 ↗</a>)}</p> : null}
        <p className="mih-strategy-policy-boundary">已有分页沿用原游标合同，已绑定供应商的分页不能跨供应商转换。策略变更只影响各接口允许的新请求；授权、价格与历史账本继续使用现有规则。</p>
      </section> : <p>尚未读取到业务接口与目标平台，请检查部署版本。</p>}
      {selected ? <section className="qp-panel mih-panel mih-strategy-contract"><h2>{selected.label} · 平台策略与迁移总览</h2><div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table">
        <thead><tr><th>目标平台</th><th>当前策略</th><th>迁移状态</th><th>配置</th><th>执行路由</th></tr></thead>
        <tbody>{rows.map(item => { const policy = strategyPolicySummary(selected.id, item); return <tr key={item.platform}><td><button type="button" className="qp-button qp-button--ghost" aria-pressed={row?.platform === item.platform} onClick={() => setQuery({ platform: item.platform })}>{item.label || item.platform}</button></td>
          <td>{policy.title}</td><td>{migration(item.migrationStatus)}</td><td>{policy.editor ? <button className="qp-button qp-button--outline qp-button--sm" type="button" onClick={() => setQuery({ platform: item.platform })}>修改策略</button> : '只读'}</td><td>{item.routeSummary || '未提供'}</td></tr> })}</tbody>
      </table></div></section> : null}
    </> : null}
    <ProductManagement {...{ token, session, onUnauthorized, notify }} path="/data-products/strategy-search" label="策略搜索" />
    <StrategySearchUsage {...{ token, onUnauthorized }} interfaceId={selected?.id || query.get('interface') || 'search'} />
    <StrategyDataStatistics {...{ token, onUnauthorized }} interfaceId={selected?.id || query.get('interface') || 'search'} />
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
      <p className="mih-strategy-usage-boundary">接口路径不代表执行方；0 表示未匹配到此类证据，不表示已全部直连 Hub。</p>
      <div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table"><thead><tr><th>接口（逻辑合同）</th><th>合计</th><th>已记录 Night-All 证据</th>{(data.days || []).map(day => <th key={day}>{day.slice(5)}</th>)}</tr></thead>
        <tbody>{items.map(row => <tr key={row.path}><td><code>{row.path}</code>{row.paths?.length > 1 ? <small className="mih-strategy-usage-alias">合并兼容别名</small> : null}</td><td>{row.total}</td><td>{row.nightAllRequests}</td>{(data.days || []).map(day => { const point = row.daily?.find(item => item.day === day); return <td key={day}><span>{point?.requests ?? 0}</span><small className="mih-strategy-usage-alias">旧连接器证据 {point?.nightAllRequests ?? 0}</small></td> })}</tr>)}</tbody>
      </table></div>
      {items.map(row => <details key={row.path}><summary><code>{row.path}</code> · 按平台查看</summary><div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table"><thead><tr><th>平台</th><th>合计</th><th>已记录 Night-All 证据</th>{(data.days || []).map(day => <th key={day}>{day.slice(5)}</th>)}</tr></thead><tbody>{(row.platforms || []).map(platform => <tr key={platform.platform}><td>{platform.platform === 'unspecified' ? '未指定平台' : platform.platform}</td><td>{platform.total}</td><td>{platform.nightAllRequests}</td>{(data.days || []).map(day => { const point = platform.daily?.find(item => item.day === day); return <td key={day}>{point?.requests ?? 0}<small className="mih-strategy-usage-alias">旧连接器证据 {point?.nightAllRequests ?? 0}</small></td> })}</tr>)}</tbody></table></div>{!row.platforms?.length ? <p>此统计窗口没有已记录的平台请求。</p> : null}</details>)}
      <div className="mih-strategy-usage-notes">{(data.notes || []).map((note, index) => <p key={index}>{note}</p>)}<p>历史兼容别名按逻辑合同合并，无法据此区分真实旧 URL 流量。Night-All 数量只统计关联到旧适配器证据的业务请求，不等同供应商派发次数；零值不能单独作为下线依据。</p></div>
    </> : null}
  </section>
}
