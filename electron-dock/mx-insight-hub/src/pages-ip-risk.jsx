import { IpRiskDeliverySettings } from './ip-risk-delivery.jsx'
import { useEffect, useRef, useState } from 'react'
import { CaretLeft, CaretRight, Copy, DownloadSimple, Info, MagnifyingGlass, ShieldCheck } from '@phosphor-icons/react'
import { REQUEST_FORMATS, requestSnippet } from './request-snippets.js'
import { copyText } from './open-capabilities.js'
import { useDemoApiKey, useDemoAccessSnapshot, DemoCredentialRecheck, useDemoCredentialExpiry } from './demo-credentials.jsx'
import { adminApi, publicDataApi, publicApiOrigin } from './api.js'
import { DropdownField } from './components.jsx'
import { IpRiskHistoryPanel } from './ip-risk-history.jsx'
import { ipRiskAccessIssues } from './demo-access.js'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'
import { DocsPage } from './pages-docs.jsx'
import { ServicePrice } from './service-price.jsx'
import { PagedItems } from './paged-items.jsx'
import { IP_RISK_STATES, parseIpRiskInput, ipRiskRows, ipRiskFailureRows, ipRiskBatchRows, ipRiskHistoryRows, ipRiskHistoryCsv, riskTone, riskValue, riskTime, riskWarning, ipRiskSummary, ipRiskCsv } from './ip-risk-view.js'
import './ip-risk.css'

const DOC_QUERY = new URLSearchParams({ path: '/docs/ip-risk' })
const SINGLE_PATH = '/api/v1/data/ip/risk'
const HISTORY_LIMIT = 200
const channelErrorHint = code => ({ip_channel_rate_limited:'上游触发限流，渠道将冷却 30 分钟。请保留本次记录，稍后再主动查询。',ip_channel_cooling:'渠道正在限流冷却，请稍后主动查询。',ip_channel_daily_limit:'今日共享上游请求额度已用尽，请明日再查询。',ip_channel_busy:'当前渠道繁忙，请稍后主动查询。',ip_channel_paused:'渠道已暂停，请联系服务管理员。',commerce_quota_exhausted:'本期已达到调用上限。续订将在下一周期生效。',commerce_subscription_required:'当前没有有效订阅，请到商城查看购买记录或开通服务。'})[code]
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
  const list = items => <ul className="mih-ip-tag-list">{items.map(({ entry: tag, index }) => <li key={index}><strong>{tag.name || tag.code || '未命名标签'}</strong>{tag.risk_level ? <span className={`mih-ip-badge is-${riskTone(tag.risk_level)}`}>{tag.risk_level}</span> : null}{tag.code ? <code>{tag.code}</code> : null}<small>最后发现：{tag.last_seen || '未提供'}</small></li>)}</ul>
  return tags.length <= 8 ? list(tags.map((entry, index) => ({ entry, index }))) : <PagedItems items={tags} label="风险标签" pageSize={8} text={tag => `${tag.name || ''} ${tag.code || ''}`}>{list}</PagedItems>
}
function BatchNavigator({ rows, active, onSelect, admin }) {
  const position = rows.findIndex(row => row.id === active.id)
  return <nav className="qp-panel mih-ip-batch-nav" aria-label="当前批次 IP 切换">
    <div className="mih-ip-batch-caption"><strong>批次画像</strong><span role="status">第 {active.index + 1} / {active.batchSize} 项{rows.length < active.batchSize ? ` · 本页保留 ${rows.length} 项` : ''}</span><small>切换仅查看已返回结果，不会重新查询</small></div>
    <div className="mih-ip-batch-controls">
      <button type="button" className="qp-button qp-button--outline" disabled={position <= 0} onClick={() => onSelect(rows[position - 1].id)}><CaretLeft size={16} aria-hidden="true" />上一个 IP</button>
      <DropdownField label="选择批次 IP" value={active.id} options={rows.map(row => ({ value: row.id, label: `第 ${row.index + 1} 项 · ${row.ip} · ${admin ? row.raw?.channel || '产品服务' : '画像'}`, description: `${IP_RISK_STATES[row.status].label} · 风险等级：${riskValue(row.profile?.risk_level)}` }))} onChange={onSelect} />
      <button type="button" className="qp-button qp-button--outline" disabled={position < 0 || position >= rows.length - 1} onClick={() => onSelect(rows[position + 1].id)}>下一个 IP<CaretRight size={16} aria-hidden="true" /></button>
    </div>
  </nav>
}
function Portrait({ row, onCopy }) {
  const p = row.profile || {}, state = IP_RISK_STATES[row.status]
  const hasPortrait = ['success', 'partial'].includes(row.status)
  return <section className="qp-panel mih-ip-report" aria-label={`IP ${row.ip || '未留存'} 画像详情`}>
    <header className="mih-ip-report-header"><div><h2>{row.ip || 'IP 未留存'}</h2><StateBadge status={row.status} /></div><div className="mih-ip-actions">
      <button type="button" className="qp-button qp-button--outline qp-button--sm" onClick={() => onCopy(ipRiskSummary(row))}><Copy size={16} aria-hidden="true" />复制摘要</button>
      <button type="button" className="qp-button qp-button--outline qp-button--sm" onClick={() => download(JSON.stringify(row.envelope || row.raw, null, 2), `ip-risk-${row.ip}.json`, 'application/json;charset=utf-8')}><DownloadSimple size={16} aria-hidden="true" />导出 JSON</button>
    </div></header>
    {hasPortrait ? <>
      <div className={`mih-ip-overview${(row.envelope?.contractVersion?.endsWith('.v2') || Object.hasOwn(p,'country')) ? ' is-v2' : ''}`}><div className={`mih-ip-risk-level is-${riskTone(p.risk_level)}`}><div><strong>{p.risk_level || '未评级'}</strong></div><span>风险等级</span></div>
        {(row.envelope?.contractVersion?.endsWith('.v2') || Object.hasOwn(p,'country')) ? <dl className="mih-ip-v2-facts">{[['归属地',[p.country,p.province,p.city,p.district].filter(Boolean).join(' / ')],['运营商',p.isp],['应用场景',p.scene],['数据更新',p.data_date],['经纬度',p.longitude != null && p.latitude != null ? `${p.longitude}, ${p.latitude}` : null]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{riskValue(value)}</dd></div>)}</dl> : <>
        <Metric label="风险评分" value={p.risk_score} hint="保留返回评分，不套用统一满分或评级阈值。" />
        <Metric label="秒拨概率" value={p.rapid_rotation_probability_percent} percent hint="快速拨号或频繁切换地址的概率，0 是有效值。" />
        <Metric label="真人概率" value={p.human_probability_percent} percent hint="流量由真人产生的概率，不是身份认证结论。" /></>}
      </div>
      {!p.risk_level ? <p className="mih-ip-unrated"><Info size={16} aria-hidden="true" />本次未返回风险等级{p.risk_score === 0 ? '；评分 0 不等于无风险' : '，不从评分推算等级'}。查询成功仅说明已获得有效响应。</p> : null}
      <dl className="mih-ip-facts"><div><dt>代理类型</dt><dd>{riskValue(p.proxy_type)}</dd></div><div><dt>查询时间</dt><dd>{riskTime(row.capturedAt)}</dd></div><div><dt>交付方式</dt><dd>{row.historical ? '历史快照 · 未重新查询' : row.sourceMode === 'idempotent_replay' ? '原结果回放' : '本次查询'}</dd></div></dl>
      <section className="mih-ip-tags"><header><h3>风险标签 <small>{p.risk_tags?.length != null ? `${p.risk_tags.length} 项` : ''}</small></h3><span>历史观察线索，不对当前使用者定性</span></header>
        {p.risk_tags?.length ? p.risk_tags.some(tag=>tag.category) ? <div className="mih-ip-risk-groups">{[...new Set(p.risk_tags.map(tag=>tag.category||'其他标签'))].map(category=><section key={category}><h4>{category}</h4><RiskTags tags={p.risk_tags.filter(tag=>(tag.category||'其他标签')===category)}/></section>)}</div> : <RiskTags key={row.id} tags={p.risk_tags} /> : <p>{p.risk_tags == null ? '未提供标签信息，不能据此判断安全。' : '本次返回空标签集合，不等于无风险。'}</p>}
      </section>
      {row.warnings.length ? <details className="mih-ip-quality"><summary>字段质量提示 · {row.warnings.length} 项</summary><ul>{row.warnings.map((warning, index) => <li key={index}>{riskWarning(warning)} <code>{warning}</code></li>)}</ul></details> : null}
      <p className="mih-ip-boundary"><Info size={16} aria-hidden="true" />{(row.envelope?.contractVersion?.endsWith('.v2') || Object.hasOwn(p,'country')) ? '仅展示本次返回的地理和风险字段；数据更新时间与查询时间不同。' : '当前画像不包含归属地、运营商、机构和经纬度。查询时间不是风险发生时间。'}</p>
    </> : <div className={`mih-ip-result-message is-${state.tone}`}><ShieldCheck size={32} aria-hidden="true" /><div><h3>{state.label}</h3><p>{channelErrorHint(row.errorCode) || state.hint}</p>{row.errorCode ? <code>{row.errorCode}</code> : null}</div></div>}
    <footer className="mih-ip-evidence"><span>请求编号：<code>{row.requestId || '未返回'}</code>{row.batchId ? <> · 批次 <code>{row.batchId}</code> · 第 {row.index + 1} 项</> : null}</span><span>{row.elapsedMs != null ? `${row.elapsedMs} ms${row.batchId ? '（整批）' : ''}` : ''}</span></footer>
  </section>
}

export function IpRiskPage({ token, session, onUnauthorized, theme }) {
  const admin = session?.kind === 'admin-token'
  const [selectedTab, setTab] = useState('product'), [docsVisited, setDocsVisited] = useState(false)
  const tab = !admin && selectedTab === 'channels' ? 'product' : selectedTab
  const [key] = useDemoApiKey(), access = useDemoAccessSnapshot(), expiresAt = useDemoCredentialExpiry()
  const [requestedChannel,setChannelChoice] = useState('latest')
  const channelChoice = admin ? requestedChannel : 'latest'
  const defaultChannel = access && !access.capabilities?.includes('ip.risk.query.v2') && access.capabilities?.includes('ip.risk.query') ? 'legacy-v1' : 'baidu-v2'
  const selectedChannels = channelChoice === 'both' ? ['baidu-v2','legacy-v1'] : [channelChoice === 'latest' ? defaultChannel : channelChoice]
  const product = access?.capabilities?.includes('ip.risk.subscription.query') && channelChoice === 'latest'
  const v2 = !product && selectedChannels.includes('baidu-v2')
  const subscribed = product || v2
  const accessIssues = product ? ipRiskAccessIssues(access,'ip.risk.subscription.query') : [...new Map(selectedChannels.flatMap(channel => ipRiskAccessIssues(access,channel === 'baidu-v2' ? 'ip.risk.query.v2' : 'ip.risk.query')).map(issue=>[issue.scope,issue])).values()]
  const runtimeBlocked = product ? access?.operations?.['ip.risk.subscription.query']?.ready === false : selectedChannels.some(c => access?.operations?.[c === 'baidu-v2' ? 'ip.risk.query.v2' : 'ip.risk.query']?.ready === false)
  const allowed = !!key && !accessIssues.length && !runtimeBlocked
  const [batch, setBatch] = useState(false), [singleInput, setSingleInput] = useState(''), [batchInput, setBatchInput] = useState('')
  const [busy, setBusy] = useState(false), lock = useRef(false), portraitRef = useRef(null)
  const [result, setResult] = useState(null), [failure, setFailure] = useState(null)
  const [rows, setRows] = useState([]), [selected, setSelected] = useState(null)
  const [subscription,setSubscription] = useState(null)
  const [offer,setOffer] = useState(null)
  useEffect(()=>{let current=true;adminApi.commerceProducts(token).then(catalog=>{if(current)setOffer(catalog.items.find(p=>p.sku==='ip-risk-baidu-annual-100k'&&p.status==='published'))}).catch(()=>{});return()=>{current=false}},[token])
  const [historyRevision, setHistoryRevision] = useState(0), [historyBusy, setHistoryBusy] = useState(false)
  useEffect(()=>{let current=true;setSubscription(null);if(key && (!access || access.capabilities?.some(c=>['ip.risk.query.v2','ip.risk.subscription.query'].includes(c))))publicDataApi.ipRiskSubscription(key).then(r=>{if(current)setSubscription(r.payload?.data?.subscription)}).catch(()=>{});return()=>{current=false}},[key,historyRevision,access])
  const historyLoad = useRef(null)
  useEffect(() => () => historyLoad.current?.abort(), [key])
  const [currentIds, setCurrentIds] = useState([]), [notice, setNotice] = useState('')
  const [format, setFormat] = useState('curl'), [priceOpen, setPriceOpen] = useState(false)
  const input = batch ? batchInput : singleInput, parsed = parseIpRiskInput(input, batch)
  const path = product ? `${SINGLE_PATH}/service` : v2 ? `${SINGLE_PATH}/v2` : batch ? `${SINGLE_PATH}/batch` : SINGLE_PATH
  const requestBody = v2 ? {...parsed.body,channels:selectedChannels} : parsed.body
  const fingerprint = JSON.stringify([path, requestBody])
  const blocked = rows.some(row => row.status === 'unknown' && parsed.values.includes(row.ip))
  const tooManyItems = parsed.values.length * selectedChannels.length > 100
  const canSend = allowed && parsed.valid && !tooManyItems && !busy && !blocked
  const active = rows.find(row => row.id === selected) || rows[0]
  const activeBatchRows = ipRiskBatchRows(rows, active)
  const currentRows = rows.filter(row => currentIds.includes(row.id))
  const snippet = credential => requestSnippet({ format, url: `${publicApiOrigin()}${path}`, body: requestBody, credential })
  async function copy(value) { setNotice(await copyText(value) ? '已复制。' : '复制失败，请检查剪贴板权限。') }
  function keepRows(next) {
    setRows(previous => [...next, ...previous.filter(row => !next.some(item => item.id === row.id))].slice(0, HISTORY_LIMIT))
    setSelected(next[0]?.id); setCurrentIds(next.map(row => row.id))
  }
  async function openHistory(item) {
    historyLoad.current?.abort()
    const controller = new AbortController()
    historyLoad.current = controller; setHistoryBusy(true); setNotice('')
    try {
      const response = await publicDataApi.ipRiskHistoryDetail(key, item.kind, item.recordId, controller.signal)
      if (controller.signal.aborted) return
      const detail = response.payload, restored = ipRiskHistoryRows(detail)
      keepRows(restored); setCurrentIds([])
      setSelected(restored.find(row => row.index === item.index)?.id || restored[0]?.id)
      setResult({ ...detail, historical: true, fingerprint: 'history' }); setFailure(null)
      portraitRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    } catch (error) { if (!controller.signal.aborted) setNotice(`历史画像读取失败：${error.message}。未发起新查询。`) }
    finally { if (historyLoad.current === controller) setHistoryBusy(false) }
  }
  async function send(event) {
    event.preventDefault()
    if (lock.current || !canSend) return
    historyLoad.current?.abort(); setHistoryBusy(false)
    lock.current = true; setBusy(true); setFailure(null); setNotice('')
    const started = performance.now(), localId = crypto.randomUUID(), request = requestBody
    try {
      const response = await (product ? publicDataApi.ipRiskService : v2 ? publicDataApi.ipRiskV2 : batch ? publicDataApi.ipRiskBatch : publicDataApi.ipRisk)(key, request)
      const next = { ...response, localId, elapsedMs: Math.round(performance.now() - started), request, receivedAt: new Date().toISOString(), fingerprint }
      setResult(next); keepRows(ipRiskRows(next))
    } catch (error) {
      setFailure({ error, fingerprint, request }); setResult(null)
      keepRows(ipRiskFailureRows(error, request, localId, new Date().toISOString()))
    } finally { lock.current = false; setBusy(false); setHistoryRevision(value => value + 1) }
  }
  const switchMode = mode => { setBatch(mode); setNotice('') }
  const composer = debug => <form className={debug ? 'mih-ip-debug-form' : 'qp-panel mih-ip-composer'} onSubmit={send} aria-label={debug ? 'IP 风险接口参数' : 'IP 风险查询'}>
    <div className="mih-ip-composer-top"><div className="mih-ip-segment" aria-label="查询方式">{[[false, '单个查询'], [true, '批量查询']].map(([value, label]) => <button key={label} type="button" aria-pressed={batch === value} disabled={busy} onClick={() => switchMode(value)}>{label}</button>)}</div><span>{batch ? '每批 1–100 项 · 保留输入顺序' : 'IPv4 风险查询'}</span></div>
    {debug ? <label htmlFor="ip-debug-input" className="mih-ip-input-label"><code>{batch ? 'ips' : 'ip'}</code> · {batch ? 'string[]' : 'string'} · 必填</label> : null}
    {admin ? <DropdownField label="查询渠道" value={channelChoice} disabled={busy} options={[{value:'latest',label:access?.capabilities?.includes('ip.risk.subscription.query')?'产品默认渠道（管理员配置）':'最新已开通渠道（优先 v2）'},{value:'baidu-v2',label:'百度 v2 · 订阅服务'},{value:'legacy-v1',label:'原渠道 v1 · 原套餐计费'},{value:'both',label:'两渠道对照 · 分别计量'}]} onChange={setChannelChoice}/> : null}
    <div className={`mih-ip-input-row${batch ? ' is-batch' : ''}`}>
      {batch ? <textarea id={debug ? 'ip-debug-input' : 'ip-product-input'} aria-label="批量 IPv4 地址" aria-describedby={debug ? 'ip-debug-validation' : 'ip-product-validation'} aria-invalid={!!input.trim() && !parsed.valid} className="qp-input" placeholder={'每行一个 IPv4，也可使用空格或逗号分隔\n例如：1.1.1.1\n8.8.8.8'} rows={4} maxLength={10000} value={input} disabled={busy} onChange={event => setBatchInput(event.target.value)} />
        : <div className="mih-ip-search-input"><MagnifyingGlass size={21} aria-hidden="true" /><input id={debug ? 'ip-debug-input' : 'ip-product-input'} aria-label="单个 IPv4 地址" aria-describedby={debug ? 'ip-debug-validation' : 'ip-product-validation'} aria-invalid={!!input.trim() && !parsed.valid} placeholder="输入 IPv4 地址，例如 1.1.1.1" autoComplete="off" spellCheck={false} className="qp-input" maxLength={100} value={input} disabled={busy} onChange={event => setSingleInput(event.target.value)} /></div>}
      <button className="qp-button qp-button--primary" disabled={!canSend}><MagnifyingGlass size={18} aria-hidden="true" />{busy ? '正在查询…' : debug ? '发送请求' : batch ? `查询 ${parsed.values.length || ''} 项画像` : '查询画像'}</button>
    </div>
    <div id={debug ? 'ip-debug-validation' : 'ip-product-validation'} className="mih-ip-validation" role="status">
      {input.trim() && parsed.message ? <span className="is-warning">{parsed.message}</span> : batch && parsed.values.length ? <span>{parsed.values.length} 项有效 IPv4{parsed.duplicateCount ? ` · 含 ${parsed.duplicateCount} 个重复项，重复项会${subscribed?'独立计入调用次数':'独立查询与计费'}。` : ''}</span> : <span>支持单个与批量查询；不会自动补查或重试。</span>}
      {batch && parsed.duplicateCount ? <button type="button" disabled={busy} className="qp-button qp-button--ghost qp-button--sm" onClick={() => setBatchInput([...new Set(parsed.values)].join('\n'))}>去除重复项</button> : null}
    </div>
    <p className="mih-ip-cost"><Info size={15} aria-hidden="true" />{product ? '本次查询包含在空间订阅内。' : v2 ? admin ? `百度 v2 已纳入年度订阅，本期成功调用计入年度上限。${selectedChannels.includes('legacy-v1') ? '本次选择的 v1 对照另按原套餐计费。' : ''}` : '本次查询包含在年度订阅内，本期成功调用计入年度上限。' : '按当前账户套餐计费 · 每次点击都是新查询 · 成功交付的 IP（含暂无数据）逐项计费'}</p>
    {tooManyItems ? <p role="status">{admin ? '每批最多 100 个 IP × 渠道组合；双渠道对照最多输入 50 个 IP。' : '每批最多 100 个 IP。'}</p> : null}
    {blocked ? <p role="status" className="mih-ip-blocked">输入包含结果待核对的 IP。请先通过请求编号核对，避免重复提交。当前页面不会再次派发这些 IP。</p> : null}
  </form>
  return <div className="mih-page mih-product-workbench mih-ip-page">
    <header className="mih-page-header"><div><h1>IP 风险画像</h1><p>查看 IPv4 的归属地、应用场景和风险线索；用分类标签快速定位需要关注的信号。</p></div></header>
    <nav className="mih-source-section-tabs mih-ip-tabs" aria-label="IP 风险画像视图">{[['product', '风险画像'], ['debug', '接口调用'], ['docs', '接口文档'], ...(admin ? [['channels', '渠道与接入']] : [])].map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => { setTab(id); if (id === 'docs') setDocsVisited(true) }}>{label}</button>)}</nav>
    {!allowed && ['product', 'debug'].includes(tab) ? <div role="status" className="mih-inline-warning mih-ip-access"><div>{!key ? <p>请选择已授权的 Hub Live Key 后查询。</p> : null}{accessIssues.map(issue => <p key={issue.scope}>{issue.message}</p>)}{runtimeBlocked ? <p>查询服务尚未就绪。已开通权限无需重复授予；{admin ? <a href={`#/external-platforms?provider=${v2 ? 'baidu-ip' : 'ipsearch'}`}>检查服务运行配置 ↗</a> : '请联系管理员恢复服务。'}</p> : null}<DemoCredentialRecheck /></div></div> : null}
    <div hidden={tab !== 'product'} className="mih-ip-product">
      <section className="qp-panel mih-ip-subscription"><div><strong>IP 风险画像 · 订阅服务</strong><p>{subscription ? `本期已调用 ${subscription.used.toLocaleString()} / ${subscription.quota.toLocaleString()} 次 · 有效期还剩 ${Math.max(0,Math.ceil((new Date(subscription.endsAt).getTime()-Date.now())/86400000))} 天 · 到期 ${riskTime(subscription.endsAt)}` : offer ? `¥${(offer.amountMinor/100).toLocaleString()} / ${offer.months} 个月 · 最多 ${offer.quota.toLocaleString()} 次 · 年度订阅` : '前往商城查看在售套餐、价格与服务状态'}</p></div><a className="qp-button qp-button--primary" href="#/store?view=purchases">查看权益 / 续订</a><a className="qp-button qp-button--outline" href="#/store">前往商城</a></section>
      {composer(false)}
      <div className="mih-ip-secondary"><span>风险画像仅反映本次查询结果，不代表绝对安全。</span><button type="button" className="qp-button qp-button--ghost qp-button--sm" aria-expanded={priceOpen} onClick={() => setPriceOpen(value => !value)}>{priceOpen ? '收起价格' : '查看当前价格'}</button></div>
      {priceOpen ? subscribed ? <p>查询已包含在订阅中。<a href="#/store?view=purchases">查看订阅与调用次数</a></p> : <ServicePrice path={SINGLE_PATH} /> : null}
      <div aria-busy={busy} className="mih-ip-results" ref={portraitRef}>
        {busy ? <p className="mih-ip-loading" role="status">正在查询{batch ? ` ${parsed.values.length} 项，批量结果返回后统一展示` : ''}…下方保留已返回记录，切换标签不会再次发送。</p> : null}
        {active ? <><div className="mih-ip-section-caption"><h2>画像详情</h2><span>{busy ? '上一次提交的结果 · 新查询进行中' : active.historical ? '历史查询快照 · 保留原始时间与结果' : currentIds.includes(active.id) ? '本次提交的结果' : '正在查看本页较早记录'}{active.capturedAt ? '' : ` · 接收于 ${riskTime(active.receivedAt)}`}</span></div>{activeBatchRows.length ? <BatchNavigator admin={admin} rows={activeBatchRows} active={active} onSelect={setSelected} /> : null}<Portrait row={active} onCopy={copy} /></> : busy ? null : <section className="qp-panel mih-ip-empty"><div className="mih-ip-empty-icon"><ShieldCheck size={28} aria-hidden="true" /></div><div><h2>查询 IP，或回看历史画像</h2><p>输入地址发起新查询；选择下方历史记录，可还原当时的画像与完整批次。</p></div></section>}
        {currentRows.length ? <div className="mih-ip-counts" aria-label="本次结果统计"><span>本次 {currentRows.length} 项</span>{Object.entries(IP_RISK_STATES).map(([state, value]) => { const count = currentRows.filter(row => row.status === state).length; return count ? <span key={state}>{value.label} <b>{count}</b></span> : null })}<button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => download(ipRiskCsv(currentRows), 'ip-risk-current.csv', 'text/csv;charset=utf-8')}>导出本次结果</button></div> : null}
        {historyBusy ? <p role="status">正在读取原始历史画像，不会重新查询…</p> : null}
        <IpRiskHistoryPanel apiKey={key} enabled={!!key && !accessIssues.length} revision={historyRevision} active={active} busy={busy || historyBusy} onOpen={openHistory} onExport={items => download(ipRiskHistoryCsv(items), 'ip-risk-history-page.csv', 'text/csv;charset=utf-8')} />
      </div>
    </div>
    <div hidden={tab !== 'debug'} className="mih-ip-debug"><section className="qp-panel mih-api-console" aria-label="Hub IP 风险接口调用"><aside className="mih-api-console-nav"><h2>IP 风险接口</h2><p>使用当前 Hub Key</p>{[[false, '单个 IPv4 画像'], [true, '批量 IPv4 画像']].map(([mode, label]) => <button key={label} type="button" aria-pressed={batch === mode} disabled={busy} onClick={() => switchMode(mode)}><small>POST</small>{label}</button>)}<p>产品视图与接口调用共用参数和结果。</p></aside><div className="mih-api-console-main"><header><span className="mih-api-method">POST</span><code>{path}</code></header>
      {composer(true)}
      <details className="mih-ip-code" open><summary>命令行与代码调用</summary><div className="mih-ip-actions"><DropdownField label="复制格式" value={format} options={REQUEST_FORMATS} onChange={setFormat} /><button type="button" className="qp-button qp-button--outline" disabled={!allowed || !parsed.valid || busy} onClick={() => copy(snippet(key))}>复制请求 · 含当前凭据</button></div><p>{expiresAt ? `当前临时凭据有效至 ${riskTime(expiresAt)}。长期调用请使用已授权的 Live Key。` : '复制内容包含当前 Hub Key，请勿公开分享。'} 复制不会发送请求。</p><pre>{snippet('<HUB_API_KEY>')}</pre></details>
      <section aria-label="JSON 响应"><div className="mih-ip-section-caption"><h3>JSON 响应</h3>{result ? <button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => setTab('product')}>查看可视化画像 →</button> : null}</div>{failure ? <p role="alert">{IP_RISK_STATES[ipRiskFailureRows(failure.error, failure.request, 'error', '')[0].status].hint} <code>{failure.error.code || 'transport_error'}</code></p> : null}{result ? <><p>请求 {result.payload.requestId || result.payload.batchId}{result.historical ? ' · 已保存的历史响应，未重新查询' : <> · {result.elapsedMs} ms{result.fingerprint !== fingerprint ? ' · 当前参数已修改，以下为上一次提交的响应' : ''}</>}</p><pre className="mih-api-response">{JSON.stringify(result.payload, null, 2)}</pre></> : <p>主动发送后展示真实响应；批次返回 200 仍须逐项检查状态。</p>}</section>
    </div></section><AdminExecutionEvidence requestId={active?.requestId} /></div>
    <section hidden={tab !== 'docs'} className="mih-ip-docs" aria-label="IP 风险接口文档">{docsVisited ? <DocsPage embedded token={token} query={product ? new URLSearchParams({path:'/docs/ip-risk-subscription'}) : v2 ? new URLSearchParams({path:'/docs/ip-risk-v2'}) : DOC_QUERY} onUnauthorized={onUnauthorized} theme={theme} /> : null}</section>
    {admin ? <section hidden={tab !== 'channels'} className="qp-panel mih-ip-channels" aria-label="IP 风险渠道与接入"><header><h2>{admin ? '渠道与供应商' : '服务与接入'}</h2><p>一个产品入口，统一的 IPv4 画像字段与逐项查询状态。</p></header>
      <div className="mih-ip-channel-row"><div><strong>IP 风险画像 · 标准查询</strong><p>单个 / 批量（1–100 项） · IPv4 · 代理识别与风险标签</p></div><span className="mih-ip-badge is-neutral">{!key ? '未选择身份' : accessIssues.length ? '当前 Key 未授权' : runtimeBlocked ? '已授权 · 服务未就绪' : access ? '已授权 · 配置就绪' : '发送时校验权限'}</span></div>
      <p>配置就绪不代表实时连通性；查询是否成功以本次返回为准。无结果或失败不会自动改换渠道。</p>
      {admin ? <><IpRiskDeliverySettings token={token}/><div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>供应商 / 渠道</th><th>接入状态</th><th>出口与代理</th><th>配置</th></tr></thead><tbody><tr><td><strong>ipsearch</strong><small>原渠道 v1 · 保留兼容</small></td><td>接口已实现，运行状态按当前配置</td><td>现有服务端 fetch 出口<br /><small>尚未接入独立 System Proxy 绑定</small></td><td><a href="#/external-platforms?provider=ipsearch">凭据与调用证据 ↗</a></td></tr><tr><td><strong>百度智能云</strong><small>IP 风险画像 v2 · 网页渠道</small></td><td>已接入 · 受共享限流和冷却状态约束</td><td>固定百度 HTTPS 目标<br /><small>服务端出口，未绑定独立代理</small></td><td><a href="#/external-platforms?provider=baidu-ip">开关、限流与调用证据 ↗</a></td></tr></tbody></table></div><p>启信宝（启信慧眼）属于企业数据产品，不是当前 IP 风险画像来源。百度 Web Search 与百度 IP 风险是不同服务渠道，凭据、接口、价格和出口不应互相套用。</p><div className="mih-ip-channel-design"><h3>渠道配置边界</h3><p>产品 → 渠道 → 版本化适配器；每个渠道独立管理凭据、运行开关、采购证据与代理出口。复用 System Proxy 的出口目录，绑定按渠道隔离；不调整全局路由或用户网络。</p><p>空间订阅使用上方保存的交付渠道；切换仅影响新查询。原始渠道调试仍需分别授权，空结果、失败或结果未知均不自动切换供应商。</p><a href="#/agent/proxies">查看 System Proxy ↗</a></div></> : null}
      <div className="mih-ip-channel-design"><h3>接入现有应用</h3><code>POST {product ? `${SINGLE_PATH}/service` : v2 ? `${SINGLE_PATH}/v2` : SINGLE_PATH}</code><p>批量使用相应路径的 <code>/batch</code>。{product?'使用空间内获授权的 Hub Live Key，网页与 API 共用本期调用次数。':'使用已授权 ip_risk 与对应渠道能力的 Hub Live Key。百度 v2 还需有效订阅且未达到调用上限。'}</p><p>每次提交都是新查询；结果待核对时请保留请求或批次编号。{product?'接口地址不随服务渠道调整而改变。':'计费、限额与授权沿用当前账户配置。'}</p><button type="button" className="qp-button qp-button--outline" onClick={() => { setDocsVisited(true); setTab('docs') }}>查看完整接口文档 →</button></div>
    </section> : null}
    {notice ? <p className="mih-ip-notice" role="status">{notice}</p> : null}
  </div>
}
