import { useCallback, useState } from 'react'
import { ArrowRight, MagnifyingGlass, User, Users } from '@phosphor-icons/react'
import { adminApi, publicDocsHref } from './api.js'
import { DropdownField, ErrorState, Field, LoadingState, PageHeading, useRemoteData } from './components.jsx'
import { FacebookSearchPolicyForm } from './platform-search-policy.jsx'
import { STRATEGY_SEARCH_INTERFACES, STRATEGY_PROVIDER_LABELS, INSTAGRAM_STRATEGY_MODE_LABELS,
  STRATEGY_MIGRATION_LABELS, instagramStrategyOptions, instagramStrategyUpdate } from './strategy-search-model.js'
import './strategy-search.css'

const icons = { search: MagnifyingGlass, crawl: Users, 'user-info': User }
const supplier = value => STRATEGY_PROVIDER_LABELS[value] || value
const migration = value => STRATEGY_MIGRATION_LABELS[value] || value || '状态未提供'

export function StrategySearchPage({ token, session, query, setQuery, onUnauthorized, notify }) {
  const admin = session?.kind === 'admin-token' && session.platformAdmin === true
  const routing = admin && query.get('view') === 'routing'
  const selected = STRATEGY_SEARCH_INTERFACES.find(row => row.id === query.get('interface')) || STRATEGY_SEARCH_INTERFACES[0]
  return <div className="mih-page mih-strategy-search">
    <PageHeading title="策略搜索" description="以业务接口和目标平台组织内容获取；调用方保持统一合同，管理员独立管理上游策略。">
      <a className="qp-button qp-button--outline" href={publicDocsHref('/docs/strategy-search')}>接口文档 ↗</a>
    </PageHeading>
    <nav className="mih-source-section-tabs" aria-label="策略搜索视图">
      <button type="button" aria-pressed={!routing} onClick={() => setQuery({ view: 'interfaces' })}>业务接口</button>
      {admin ? <button type="button" aria-pressed={routing} onClick={() => setQuery({ view: 'routing' })}>上游策略</button> : null}
    </nav>
    {routing ? <StrategySearchManagement key={token} {...{ token, query, setQuery, onUnauthorized, notify }} /> : <>
      <div className="mih-strategy-interface-cards" role="group" aria-label="选择业务接口">
        {STRATEGY_SEARCH_INTERFACES.map(row => { const Icon = icons[row.id]; return <button type="button" key={row.id}
          className={`mih-strategy-interface-card${selected.id === row.id ? ' is-selected' : ''}`} aria-pressed={selected.id === row.id}
          onClick={() => setQuery({ interface: row.id })}>
          <Icon size={24} weight="duotone" aria-hidden="true" /><strong>{row.label}</strong><span>{row.description}</span><ArrowRight size={18} aria-hidden="true" />
        </button> })}
      </div>
      <section className="qp-panel mih-panel mih-strategy-contract">
        <header><div><p className="qp-kicker">业务接口</p><h2>{selected.label}</h2></div>
          {admin ? <button className="qp-button qp-button--outline" type="button" onClick={() => setQuery({ view: 'routing', interface: selected.id })}>查看平台路由 <ArrowRight size={16} aria-hidden="true" /></button> : null}</header>
        <div className="mih-strategy-paths">{selected.paths.map(path => <code key={path}>{path}</code>)}</div>
        <dl className="mih-strategy-contract-grid"><div><dt>请求</dt><dd>{selected.input}</dd></div><div><dt>响应</dt><dd>{selected.output}</dd></div></dl>
        <p>{selected.boundary}</p>
      </section>
      <section className="qp-panel mih-panel mih-strategy-contract">
        <h2>接入约定</h2>
        <p>业务请求继续使用已授权的 Hub API Key、平台权限与套餐；目录展示不代表当前身份已开通或接口此刻可用。</p>
        <p>下一页原样传回游标，并使用新的 Idempotency-Key。查询条件或供应商变化后，旧游标可能要求从第一页重新开始。</p>
        <p>超时或结果未知时，先只读核对使用记录和请求诊断。同一幂等标识受接口与回放窗口限制，重新发送也可能再次计费。</p>
        <a href={publicDocsHref('/docs/strategy-search')}>查看参数、兼容范围与响应说明 ↗</a>
      </section>
    </>}
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
