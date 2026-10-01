import { useRef, useState } from 'react'
import { Copy, DownloadSimple, Info, MagnifyingGlass, ShieldCheck } from '@phosphor-icons/react'
import { REQUEST_FORMATS, requestSnippet } from './request-snippets.js'
import { copyText } from './open-capabilities.js'
import { useDemoApiKey, useDemoAccessSnapshot, DemoCredentialRecheck, useDemoCredentialExpiry } from './demo-credentials.jsx'
import { publicDataApi, publicApiOrigin } from './api.js'
import { DropdownField, Pagination } from './components.jsx'
import { ipRiskAccessIssues } from './demo-access.js'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'
import { DocsPage } from './pages-docs.jsx'
import { ServicePrice } from './service-price.jsx'
import { PagedItems } from './paged-items.jsx'
import { IP_RISK_STATES, parseIpRiskInput, ipRiskRows, ipRiskFailureRows, riskTone, riskValue, riskTime, riskWarning, filterIpRiskRows, ipRiskSummary, ipRiskCsv } from './ip-risk-view.js'
import './ip-risk.css'

const DOC_QUERY = new URLSearchParams({ path: '/docs/ip-risk' })
const SINGLE_PATH = '/api/v1/data/ip/risk'
const HISTORY_LIMIT = 200
function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function StateBadge({ status }) {
  const state = IP_RISK_STATES[status] || IP_RISK_STATES.unknown
  return <span className={`mih-ip-badge is-${state.tone}`}>{state.label}</span>
}
function Metric({ label, value, percent, hint }) {
  return <div className="mih-ip-metric"><span>{label}<span className="mih-ip-info" tabIndex={0} aria-label={hint} title={hint}><Info size={15} aria-hidden="true" /></span></span>
    <strong className={value == null ? 'is-missing' : ''}>{riskValue(value)}{percent && value != null ? <small>%</small> : null}</strong>
    {percent && value != null ? <div className="mih-ip-meter" aria-hidden="true"><i style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></div> : <small>{hint}</small>}
  </div>
}
function RiskTags({ tags }) {
  const list = items => <ul className="mih-ip-tag-list">{items.map(({ entry: tag, index }) => <li key={index}><strong>{tag.name || tag.code || '未命名标签'}</strong>{tag.code ? <code>{tag.code}</code> : null}<small>最后发现：{tag.last_seen || '未提供'}</small></li>)}</ul>
  return tags.length <= 8 ? list(tags.map((entry, index) => ({ entry, index }))) : <PagedItems items={tags} label="风险标签" pageSize={8} text={tag => `${tag.name || ''} ${tag.code || ''}`}>{list}</PagedItems>
}
function Portrait({ row, onCopy }) {
  const p = row.profile || {}, state = IP_RISK_STATES[row.status]
  const hasPortrait = ['success', 'partial'].includes(row.status)
  return <section className="qp-panel mih-ip-report" aria-label={`IP ${row.ip} 画像详情`}>
    <header className="mih-ip-report-header"><div><h2>{row.ip}</h2><StateBadge status={row.status} /></div><div className="mih-ip-actions">
      <button type="button" className="qp-button qp-button--outline qp-button--sm" onClick={() => onCopy(ipRiskSummary(row))}><Copy size={16} aria-hidden="true" />复制摘要</button>
      <button type="button" className="qp-button qp-button--outline qp-button--sm" onClick={() => download(JSON.stringify(row.envelope || row.raw, null, 2), `ip-risk-${row.ip}.json`, 'application/json;charset=utf-8')}><DownloadSimple size={16} aria-hidden="true" />导出 JSON</button>
    </div></header>
    {hasPortrait ? <>
      <div className="mih-ip-overview"><div className={`mih-ip-risk-level is-${riskTone(p.risk_level)}`}><div><strong>{riskValue(p.risk_level)}</strong></div><span>风险等级</span></div>
        <Metric label="风险评分" value={p.risk_score} hint="保留返回评分，不套用统一满分或评级阈值。" />
        <Metric label="秒拨概率" value={p.rapid_rotation_probability_percent} percent hint="快速拨号或频繁切换地址的概率，0 是有效值。" />
        <Metric label="真人概率" value={p.human_probability_percent} percent hint="流量由真人产生的概率，不是身份认证结论。" />
      </div>
      <dl className="mih-ip-facts"><div><dt>代理类型</dt><dd>{riskValue(p.proxy_type)}</dd></div><div><dt>查询时间</dt><dd>{riskTime(row.capturedAt)}</dd></div><div><dt>交付方式</dt><dd>{row.sourceMode === 'idempotent_replay' ? '原结果回放' : '本次查询'}</dd></div></dl>
      <section className="mih-ip-tags"><header><h3>风险标签 <small>{p.risk_tags?.length != null ? `${p.risk_tags.length} 项` : ''}</small></h3><span>历史观察线索，不对当前使用者定性</span></header>
        {p.risk_tags?.length ? <RiskTags key={row.id} tags={p.risk_tags} /> : <p>{p.risk_tags == null ? '未提供标签信息，不能据此判断安全。' : '本次返回空标签集合，不等于无风险。'}</p>}
      </section>
      {row.warnings.length ? <details className="mih-ip-quality"><summary>字段质量提示 · {row.warnings.length} 项</summary><ul>{row.warnings.map((warning, index) => <li key={index}>{riskWarning(warning)} <code>{warning}</code></li>)}</ul></details> : null}
      <p className="mih-ip-boundary"><Info size={16} aria-hidden="true" />当前画像不包含归属地、运营商、机构和经纬度。查询时间不是风险发生时间。</p>
    </> : <div className={`mih-ip-result-message is-${state.tone}`}><ShieldCheck size={32} aria-hidden="true" /><div><h3>{state.label}</h3><p>{state.hint}</p>{row.errorCode ? <code>{row.errorCode}</code> : null}</div></div>}
    <footer className="mih-ip-evidence"><span>请求编号：<code>{row.requestId || '未返回'}</code>{row.batchId ? <> · 批次 <code>{row.batchId}</code> · 第 {row.index + 1} 项</> : null}</span><span>{row.elapsedMs != null ? `${row.elapsedMs} ms${row.batchId ? '（整批）' : ''}` : ''}</span></footer>
  </section>
}

export function IpRiskPage({ token, session, onUnauthorized, theme }) {
  const [tab, setTab] = useState('product'), [docsVisited, setDocsVisited] = useState(false)
  const [key] = useDemoApiKey(), access = useDemoAccessSnapshot(), expiresAt = useDemoCredentialExpiry()
  const accessIssues = ipRiskAccessIssues(access)
  const runtimeBlocked = access?.operations?.['ip.risk.query']?.ready === false
  const allowed = !!key && !accessIssues.length && !runtimeBlocked
  const admin = session?.kind === 'admin-token'
  const [batch, setBatch] = useState(false), [singleInput, setSingleInput] = useState(''), [batchInput, setBatchInput] = useState('')
  const [busy, setBusy] = useState(false), lock = useRef(false), portraitRef = useRef(null)
  const [result, setResult] = useState(null), [failure, setFailure] = useState(null)
  const [rows, setRows] = useState([]), [selected, setSelected] = useState(null), [dropped, setDropped] = useState(0)
  const [currentIds, setCurrentIds] = useState([]), [notice, setNotice] = useState('')
  const [query, setQuery] = useState(''), [stateFilter, setStateFilter] = useState(''), [levelFilter, setLevelFilter] = useState(''), [page, setPage] = useState(1)
  const [format, setFormat] = useState('curl'), [priceOpen, setPriceOpen] = useState(false)
  const input = batch ? batchInput : singleInput, parsed = parseIpRiskInput(input, batch)
  const path = batch ? `${SINGLE_PATH}/batch` : SINGLE_PATH
  const fingerprint = JSON.stringify([path, parsed.body])
  const blocked = rows.some(row => row.status === 'unknown' && parsed.values.includes(row.ip))
  const canSend = allowed && parsed.valid && !busy && !blocked
  const active = rows.find(row => row.id === selected) || rows[0]
  const matching = filterIpRiskRows(rows, query, stateFilter, levelFilter)
  const pages = Math.max(1, Math.ceil(matching.length / 10)), currentPage = Math.min(page, pages)
  const visible = matching.slice((currentPage - 1) * 10, currentPage * 10)
  const currentRows = rows.filter(row => currentIds.includes(row.id))
  const levels = [...new Set(rows.map(row => row.profile?.risk_level).filter(Boolean))]
  const snippet = credential => requestSnippet({ format, url: `${publicApiOrigin()}${path}`, body: parsed.body, credential })
  async function copy(value) { setNotice(await copyText(value) ? '已复制。' : '复制失败，请检查剪贴板权限。') }
  function keepRows(next) {
    setDropped(value => value + Math.max(0, rows.length + next.length - HISTORY_LIMIT))
    setRows(previous => [...next, ...previous].slice(0, HISTORY_LIMIT))
    setSelected(next[0]?.id); setCurrentIds(next.map(row => row.id)); setPage(1)
    setQuery(''); setStateFilter(''); setLevelFilter('')
  }
  async function send(event) {
    event.preventDefault()
    if (lock.current || !canSend) return
    lock.current = true; setBusy(true); setFailure(null); setNotice('')
    const started = performance.now(), localId = crypto.randomUUID(), request = parsed.body
    try {
      const response = await (batch ? publicDataApi.ipRiskBatch : publicDataApi.ipRisk)(key, request)
      const next = { ...response, localId, elapsedMs: Math.round(performance.now() - started), request, receivedAt: new Date().toISOString(), fingerprint }
      setResult(next); keepRows(ipRiskRows(next))
    } catch (error) {
      setFailure({ error, fingerprint, request }); setResult(null)
      keepRows(ipRiskFailureRows(error, request, localId, new Date().toISOString()))
    } finally { lock.current = false; setBusy(false) }
  }
  const switchMode = mode => { setBatch(mode); setNotice('') }
  const composer = debug => <form className={debug ? 'mih-ip-debug-form' : 'qp-panel mih-ip-composer'} onSubmit={send} aria-label={debug ? 'IP 风险接口参数' : 'IP 风险查询'}>
    <div className="mih-ip-composer-top"><div className="mih-ip-segment" aria-label="查询方式">{[[false, '单个查询'], [true, '批量查询']].map(([value, label]) => <button key={label} type="button" aria-pressed={batch === value} disabled={busy} onClick={() => switchMode(value)}>{label}</button>)}</div><span>{batch ? '每批 1–100 项 · 保留输入顺序' : 'IPv4 风险查询'}</span></div>
    {debug ? <label htmlFor="ip-debug-input" className="mih-ip-input-label"><code>{batch ? 'ips' : 'ip'}</code> · {batch ? 'string[]' : 'string'} · 必填</label> : null}
    <div className={`mih-ip-input-row${batch ? ' is-batch' : ''}`}>
      {batch ? <textarea id={debug ? 'ip-debug-input' : 'ip-product-input'} aria-label="批量 IPv4 地址" aria-describedby={debug ? 'ip-debug-validation' : 'ip-product-validation'} aria-invalid={!!input.trim() && !parsed.valid} className="qp-input" placeholder={'每行一个 IPv4，也可使用空格或逗号分隔\n例如：1.1.1.1\n8.8.8.8'} rows={4} maxLength={10000} value={input} disabled={busy} onChange={event => setBatchInput(event.target.value)} />
        : <div className="mih-ip-search-input"><MagnifyingGlass size={21} aria-hidden="true" /><input id={debug ? 'ip-debug-input' : 'ip-product-input'} aria-label="单个 IPv4 地址" aria-describedby={debug ? 'ip-debug-validation' : 'ip-product-validation'} aria-invalid={!!input.trim() && !parsed.valid} placeholder="输入 IPv4 地址，例如 1.1.1.1" autoComplete="off" spellCheck={false} className="qp-input" maxLength={100} value={input} disabled={busy} onChange={event => setSingleInput(event.target.value)} /></div>}
      <button className="qp-button qp-button--primary" disabled={!canSend}><MagnifyingGlass size={18} aria-hidden="true" />{busy ? '正在查询…' : debug ? '发送请求' : batch ? `查询 ${parsed.values.length || ''} 项画像` : '查询画像'}</button>
    </div>
    <div id={debug ? 'ip-debug-validation' : 'ip-product-validation'} className="mih-ip-validation" role="status">
      {input.trim() && parsed.message ? <span className="is-warning">{parsed.message}</span> : batch && parsed.values.length ? <span>{parsed.values.length} 项有效 IPv4{parsed.duplicateCount ? ` · 含 ${parsed.duplicateCount} 个重复项，重复项会独立查询与计费。` : ''}</span> : <span>支持单个与批量查询；不会自动补查或重试。</span>}
      {batch && parsed.duplicateCount ? <button type="button" disabled={busy} className="qp-button qp-button--ghost qp-button--sm" onClick={() => setBatchInput([...new Set(parsed.values)].join('\n'))}>去除重复项</button> : null}
    </div>
    <p className="mih-ip-cost"><Info size={15} aria-hidden="true" />按当前账户套餐计费 · 每次点击都是新查询 · 成功交付的 IP（含暂无数据）逐项计费</p>
    {blocked ? <p role="status" className="mih-ip-blocked">输入包含结果待核对的 IP。请先通过请求编号核对，避免重复消费。当前页面不会再次派发这些 IP。</p> : null}
  </form>
  return <div className="mih-page mih-product-workbench mih-ip-page">
    <header className="mih-page-header"><div><h1>IP 风险画像</h1><p>查询 IPv4 的代理类型、风险指标与标签，快速核对单个地址或批量线索。</p></div></header>
    <nav className="mih-source-section-tabs mih-ip-tabs" aria-label="IP 风险画像视图">{[['product', '风险画像'], ['debug', '接口调用'], ['docs', '接口文档'], ['channels', '渠道与接入']].map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => { setTab(id); if (id === 'docs') setDocsVisited(true) }}>{label}</button>)}</nav>
    {!allowed && ['product', 'debug'].includes(tab) ? <div role="status" className="mih-inline-warning mih-ip-access"><div>{!key ? <p>请选择已授权的 Hub Live Key 后查询。</p> : null}{accessIssues.map(issue => <p key={issue.scope}>{issue.message}</p>)}{runtimeBlocked ? <p>查询服务尚未就绪。已开通权限无需重复授予；{admin ? <a href="#/external-platforms?provider=ipsearch">检查服务运行配置 ↗</a> : '请联系管理员恢复服务。'}</p> : null}<DemoCredentialRecheck /></div></div> : null}
    <div hidden={tab !== 'product'} className="mih-ip-product">
      {composer(false)}
      <div className="mih-ip-secondary"><span>风险画像仅反映本次查询结果，不代表绝对安全。</span><button type="button" className="qp-button qp-button--ghost qp-button--sm" aria-expanded={priceOpen} onClick={() => setPriceOpen(value => !value)}>{priceOpen ? '收起价格' : '查看当前价格'}</button></div>
      {priceOpen ? <ServicePrice path={SINGLE_PATH} /> : null}
      <div aria-busy={busy} className="mih-ip-results" ref={portraitRef}>
        {busy ? <p className="mih-ip-loading" role="status">正在查询{batch ? ` ${parsed.values.length} 项，批量结果返回后统一展示` : ''}…下方保留已返回记录，切换标签不会再次发送。</p> : null}
        {active ? <><div className="mih-ip-section-caption"><h2>画像详情</h2><span>{busy ? '上一次提交的结果 · 新查询进行中' : currentIds.includes(active.id) ? '本次提交的结果' : '正在查看本页较早记录'}{active.capturedAt ? '' : ` · 接收于 ${riskTime(active.receivedAt)}`}</span></div><Portrait row={active} onCopy={copy} /></> : busy ? null : <section className="qp-panel mih-ip-empty"><div className="mih-ip-empty-icon"><ShieldCheck size={35} aria-hidden="true" /></div><h2>从一个 IP，了解风险线索</h2><p>输入地址后点击“查询画像”，查看风险等级、代理类型、行为概率与标签。</p><div><span>01 输入单个或批量 IP</span><span>02 查看画像与数据完整性</span><span>03 筛选、复制或导出结果</span></div><small>尚未发起查询，不展示推测数据。</small></section>}
        {rows.length ? <section className="qp-panel mih-ip-history" aria-label="本页查询记录"><header><div><h2>查询记录 <small>{rows.length} 项</small></h2><p>仅保留当前身份在本页最近 {HISTORY_LIMIT} 项；切换身份或离开页面后清空。{dropped ? `已移出 ${dropped} 项较早记录。` : ''}</p></div><button type="button" className="qp-button qp-button--outline qp-button--sm" disabled={!matching.length} onClick={() => download(ipRiskCsv(matching), 'ip-risk-filtered.csv', 'text/csv;charset=utf-8')}><DownloadSimple size={16} aria-hidden="true" />导出筛选结果（{matching.length}）</button></header>
          <div className="mih-ip-counts" aria-label="本次结果统计"><span>本次 {currentRows.length} 项</span>{Object.entries(IP_RISK_STATES).map(([state, value]) => { const count = currentRows.filter(row => row.status === state).length; return count ? <span key={state}>{value.label} <b>{count}</b></span> : null })}</div>
          <div className="mih-ip-history-filters"><input aria-label="搜索查询记录" className="qp-input" type="search" placeholder="搜索 IP、代理、标签或请求编号" value={query} onChange={event => { setQuery(event.target.value); setPage(1) }} /><DropdownField label="数据状态" value={stateFilter} options={[{ value: '', label: '全部状态' }, ...Object.entries(IP_RISK_STATES).map(([value, state]) => ({ value, label: state.label }))]} onChange={value => { setStateFilter(value); setPage(1) }} /><DropdownField label="风险等级" value={levelFilter} options={[{ value: '', label: '全部等级' }, ...levels.map(value => ({ value, label: value }))]} onChange={value => { setLevelFilter(value); setPage(1) }} /></div>
          <div className="qp-table-wrap"><table className="qp-table mih-table mih-ip-table"><thead><tr><th>IP / 输入序号</th><th>数据状态</th><th>风险等级</th><th>风险评分</th><th>代理类型</th><th>查询时间</th><th>操作</th></tr></thead><tbody>{visible.map(row => <tr key={row.id} className={active?.id === row.id ? 'is-selected' : ''}><td><strong>{row.ip}</strong>{row.batchId ? <small>批次第 {row.index + 1} 项</small> : null}</td><td><StateBadge status={row.status} /></td><td className={`is-${riskTone(row.profile?.risk_level)}`}>{riskValue(row.profile?.risk_level)}</td><td>{riskValue(row.profile?.risk_score)}</td><td>{riskValue(row.profile?.proxy_type)}</td><td>{riskTime(row.capturedAt)}</td><td><button type="button" aria-label={`查看 ${row.ip} 第 ${row.index + 1} 项详情`} aria-pressed={active?.id === row.id} className="qp-button qp-button--ghost qp-button--sm" onClick={() => { setSelected(row.id); portraitRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }}>查看详情</button></td></tr>)}</tbody></table></div>
          {!matching.length ? <p role="status">没有匹配记录。调整筛选不会发起查询。</p> : null}
          <Pagination label="查询记录分页" page={currentPage} pageSize={10} total={matching.length} totalPages={pages} hasMore={currentPage < pages} onPageChange={setPage} />
        </section> : null}
      </div>
    </div>
    <div hidden={tab !== 'debug'} className="mih-ip-debug"><section className="qp-panel mih-api-console" aria-label="Hub IP 风险接口调用"><aside className="mih-api-console-nav"><h2>IP 风险接口</h2><p>使用当前 Hub Key</p>{[[false, '单个 IPv4 画像'], [true, '批量 IPv4 画像']].map(([mode, label]) => <button key={label} type="button" aria-pressed={batch === mode} disabled={busy} onClick={() => switchMode(mode)}><small>POST</small>{label}</button>)}<p>产品视图与接口调用共用参数和结果。</p></aside><div className="mih-api-console-main"><header><span className="mih-api-method">POST</span><code>{path}</code></header>
      {composer(true)}
      <details className="mih-ip-code" open><summary>命令行与代码调用</summary><div className="mih-ip-actions"><DropdownField label="复制格式" value={format} options={REQUEST_FORMATS} onChange={setFormat} /><button type="button" className="qp-button qp-button--outline" disabled={!allowed || !parsed.valid || busy} onClick={() => copy(snippet(key))}>复制请求 · 含当前凭据</button></div><p>{expiresAt ? `当前临时凭据有效至 ${riskTime(expiresAt)}。长期调用请使用已授权的 Live Key。` : '复制内容包含当前 Hub Key，请勿公开分享。'} 复制不会发送请求。</p><pre>{snippet('<HUB_API_KEY>')}</pre></details>
      <section aria-label="JSON 响应"><div className="mih-ip-section-caption"><h3>JSON 响应</h3>{result ? <button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => setTab('product')}>查看可视化画像 →</button> : null}</div>{failure ? <p role="alert">{IP_RISK_STATES[ipRiskFailureRows(failure.error, failure.request, 'error', '')[0].status].hint} <code>{failure.error.code || 'transport_error'}</code></p> : null}{result ? <><p>请求 {result.payload.requestId || result.payload.batchId} · {result.elapsedMs} ms{result.fingerprint !== fingerprint ? ' · 当前参数已修改，以下为上一次提交的响应' : ''}</p><pre className="mih-api-response">{JSON.stringify(result.payload, null, 2)}</pre></> : <p>主动发送后展示真实响应；批次返回 200 仍须逐项检查状态。</p>}</section>
    </div></section><AdminExecutionEvidence requestId={active?.requestId} /></div>
    <section hidden={tab !== 'docs'} className="mih-ip-docs" aria-label="IP 风险接口文档">{docsVisited ? <DocsPage token={token} query={DOC_QUERY} onUnauthorized={onUnauthorized} theme={theme} /> : null}</section>
    <section hidden={tab !== 'channels'} className="qp-panel mih-ip-channels" aria-label="IP 风险渠道与接入"><header><h2>{admin ? '渠道与供应商' : '服务与接入'}</h2><p>一个产品入口，统一的 IPv4 画像字段与逐项查询状态。</p></header>
      <div className="mih-ip-channel-row"><div><strong>IP 风险画像 · 标准查询</strong><p>单个 / 批量（1–100 项） · IPv4 · 代理识别与风险标签</p></div><span className="mih-ip-badge is-neutral">{!key ? '未选择身份' : accessIssues.length ? '当前 Key 未授权' : runtimeBlocked ? '已授权 · 服务未就绪' : access ? '已授权 · 配置就绪' : '发送时校验权限'}</span></div>
      <p>配置就绪不代表实时连通性；查询是否成功以本次返回为准。无结果或失败不会自动改换渠道。</p>
      {admin ? <><div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>供应商 / 渠道</th><th>接入状态</th><th>出口与代理</th><th>配置</th></tr></thead><tbody><tr><td><strong>ipsearch</strong><small>IP 风险标准查询 · 当前适配器</small></td><td>接口已实现，运行状态按当前配置</td><td>现有服务端 fetch 出口<br /><small>尚未接入独立 System Proxy 绑定</small></td><td><a href="#/external-platforms?provider=ipsearch">凭据与调用证据 ↗</a></td></tr><tr><td><strong>百度智能云</strong><small>IP 风险画像 · 候选渠道</small></td><td>规划中 · 尚未接入</td><td>计划独立绑定 Proxy Sequence<br /><small>需验证固定 API 目标的可达性</small></td><td>待接口、字段与采购证据确认</td></tr></tbody></table></div><p>启信宝（启信慧眼）属于企业数据产品，不是当前 IP 风险画像来源。百度 Web Search 与百度 IP 风险是不同服务渠道，凭据、接口、价格和出口不应互相套用。</p><div className="mih-ip-channel-design"><h3>渠道配置边界</h3><p>产品 → 渠道 → 版本化适配器；每个渠道独立管理凭据、运行开关、采购证据与代理出口。复用 System Proxy 的出口目录，绑定按渠道隔离；不调整全局路由或用户网络。</p><p>候选渠道仅在派发前筛选。一旦发送，空结果、失败或结果未知均不自动切换供应商。未来多渠道比对需显式选择并逐渠道计量。</p><a href="#/agent/proxies">查看 System Proxy ↗</a></div></> : null}
      <div className="mih-ip-channel-design"><h3>接入现有应用</h3><code>POST {SINGLE_PATH}</code><p>批量使用 <code>{SINGLE_PATH}/batch</code>。使用已授权 ip_risk 与 ip.risk.query 的 Hub Live Key。</p><p>每次提交都是新查询；结果待核对时请保留请求或批次编号。计费、限额与授权沿用当前账户配置。</p><button type="button" className="qp-button qp-button--outline" onClick={() => { setDocsVisited(true); setTab('docs') }}>查看完整接口文档 →</button></div>
    </section>
    {notice ? <p className="mih-ip-notice" role="status">{notice}</p> : null}
  </div>
}
