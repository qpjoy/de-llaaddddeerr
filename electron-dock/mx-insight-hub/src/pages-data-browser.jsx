import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { MagnifyingGlass, DownloadSimple, Funnel, ArrowClockwise } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DemoProductPage } from './demo-credentials.jsx'
import { DropdownField, EmptyState, ErrorState, LoadingState, PageHeading, formatDate, useRemoteData } from './components.jsx'
import { AccountAnalysis, AccountCards, AccountHero, ContentDetail, ContentTable, downloadBrowserFile, formatNumber, platformName } from './data-browser-parts.jsx'
import './data-browser.css'

const RequestDiagnostics = lazy(() => import('./request-diagnostics.jsx'))
const AdvancedSearchPanel = lazy(() => import('./advanced-search.jsx'))
const AggregateSearchPanel = lazy(() => import('./aggregate-search.jsx'))
const views = [['accounts', '账号大盘'], ['contents', '内容大盘'], ['hotspots', '热点线索'], ['advanced', '高级搜索'], ['aggregate', '聚合数据搜索'], ['diagnostics', '请求诊断']]
const emptySearch = { q: '', platform: '', objectType: '', contentType: '', from: '', to: '', tag: '', sort: 'newest' }
const platforms = [['', '全部平台'], ...['xiaohongshu', 'douyin', 'kuaishou', 'bilibili', 'weibo', 'telegram', 'twitter', 'taobao', 'jd', 'mobile_commerce'].map((key) => [key, platformName(key)])]
const objectTypes = [['', '全部对象'], ['post', '帖子 / 笔记'], ['product', '商品'], ['comment', '评论'], ['message', '消息'], ['article', '文章'], ['user', '用户资料'], ['account', '账号'], ['profile', '画像资料'], ['chat', '会话']]
const contentTypes = [['', '全部形态'], ['video', '视频'], ['image', '图片'], ['text', '文字'], ['note', '笔记'], ['audio', '音频'], ['link', '链接']]
const options = (pairs, value) => (value === undefined || pairs.some(([key]) => key === value) ? pairs : [...pairs, [value, value]]).map(([value, label]) => ({ value, label }))

function useBrowserTotal(token, filters, ready, onUnauthorized) {
  const { page, pageSize, sort, summary, ...scope } = filters
  const key = JSON.stringify(scope)
  const [state, setState] = useState({ key: '', loading: true, total: null, error: null })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!ready) return
    let active = true
    setState({ key, loading: true, total: null, error: null })
    adminApi.dataBrowserStatistics(token, JSON.parse(key)).then((data) => {
      if (active) setState({ ...data, key, loading: false, error: null })
    }).catch((error) => {
      if (error.status === 401) onUnauthorized?.(error)
      if (active) setState({ key, loading: false, total: null, error })
    })
    return () => { active = false }
  }, [token, key, ready, revision, onUnauthorized])
  return { ...(state.key === key ? state : { loading: true, total: null, error: null }), retry: () => setRevision((v) => v + 1) }
}
function Pagination({ filters, data, total, loading, onPage }) {
  const [jump, setJump] = useState('')
  const pages = total.total == null ? null : Math.ceil(total.total / filters.pageSize)
  const max = Math.min(500, pages == null ? 500 : Math.max(1, pages))
  return <div className="mih-browser-pagination"><span>{pages === 0 ? '暂无匹配结果' : `第 ${filters.page} 页${pages == null ? '' : ` / 共 ${formatNumber(pages)} 页`}`} · 每页 {filters.pageSize} 条</span><button className="qp-button qp-button--secondary" disabled={loading || filters.page <= 1} onClick={() => onPage(filters.page - 1)}>上一页</button><button className="qp-button qp-button--secondary" disabled={loading || !data?.hasMore || filters.page >= 500} onClick={() => onPage(filters.page + 1)}>下一页</button><form onSubmit={(event) => { event.preventDefault(); const page = Number(jump); if (Number.isInteger(page) && page >= 1 && page <= max) { onPage(page); setJump('') } }}><label>跳至<input aria-label="跳转页码" className="qp-input" type="number" min={1} max={max} value={jump} onChange={(event) => setJump(event.target.value)} /></label><button className="qp-button qp-button--ghost" disabled={loading || !jump || pages === 0}>确定</button></form>{pages > 500 ? <small>共 {formatNumber(pages)} 页，直接浏览前 500 页；可缩小筛选范围。</small> : null}</div>
}
function AccountHeader({ token, row, onUnauthorized, onBack, onTag }) {
  const load = useCallback(() => adminApi.dataBrowser(token, { view: 'accounts', platform: row.platform, account: row.account_id, pageSize: 1 }), [token, row.platform, row.account_id])
  const state = useRemoteData(load, onUnauthorized)
  return <><AccountHero row={state.loading ? row : state.data?.items?.[0] || row} onBack={onBack} onTag={onTag} onRefresh={state.refresh} />{state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}</>
}
export function DataBrowserPage({ token, onUnauthorized }) {
  const resultsRef = useRef(null)
  const aggregateSession = useRef(null)
  const [aggregate, setAggregate] = useState(() => new URLSearchParams(window.location.hash.split('?')[1]).get('view') === 'aggregate')
  useEffect(() => {
    if (!aggregate) return
    const nav = document.querySelector('.is-aggregate .mih-browser-tabs')
    if (!nav) return
    const reveal = () => {
      const tab = nav.querySelector('button[aria-pressed="true"]')
      if (tab) nav.scrollLeft += tab.getBoundingClientRect().left - nav.getBoundingClientRect().left - (nav.clientWidth - tab.clientWidth) / 2
    }
    const observer = new ResizeObserver(reveal)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [aggregate])
  const [advanced,setAdvanced] = useState(false)
  const [diagnostics, setDiagnostics] = useState(false)
  const [diagnosticSession, setDiagnosticSession] = useState(null)
  const [filters, setFilters] = useState({ ...emptySearch, view: 'accounts', account: '', page: 1, pageSize: 20 })
  const [draft, setDraft] = useState(emptySearch)
  const [accountRow, setAccountRow] = useState(null)
  const [accountTab, setAccountTab] = useState('overview')
  const [selected, setSelected] = useState(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportFormat, setExportFormat] = useState('csv')
  const [exportLimit, setExportLimit] = useState('200')
  const [exportState, setExportState] = useState({ busy: false, error: null, message: '' })
  useEffect(() => { document.getElementById('mih-main-content')?.scrollIntoView({ block: 'start' }) }, [filters.view, filters.account, selected?.id])
  const filterKey = JSON.stringify(filters)
  const load = useCallback(async () => ({ ...(advanced || diagnostics || aggregate || filters.account && accountTab !== 'contents' ? { items: [] } : await adminApi.dataBrowser(token, filters)), filterKey }), [token, filters, filterKey, accountTab, advanced, diagnostics, aggregate])
  const state = useRemoteData(load, onUnauthorized)
  const data = state.data
  const loading = state.loading || (!state.error && data?.filterKey !== filterKey)
  const items = loading || state.error ? [] : data?.items || []
  // Once this scope's list has loaded, count independently. Page/sort changes
  // keep the scope ready, preserving the count instead of restarting it.
  const scopeKey = JSON.stringify(Object.fromEntries(Object.entries(filters).filter(([k]) => !['page', 'pageSize', 'sort'].includes(k))))
  const [readyScope, setReadyScope] = useState('')
  useEffect(() => { if (!loading && !state.error) setReadyScope(scopeKey) }, [loading, state.error, scopeKey])
  const total = useBrowserTotal(token, filters, !advanced && !diagnostics && !aggregate && readyScope === scopeKey, onUnauthorized)
  const updateDraft = (key, value) => setDraft((v) => ({ ...v, [key]: value }))
  const patch = (values) => { setSelected(null); setExportState((v) => ({ ...v, error: null, message: '' })); setFilters((v) => ({ ...v, ...values, page: 1 })) }
  const navigate = (view, values = {}) => { setAggregate(view === 'aggregate'); if (view === 'aggregate') { setAdvanced(false); setDiagnostics(false); return } setDiagnostics(view === 'diagnostics'); if(view==='diagnostics'){setAdvanced(false);return}if(view==='advanced'){setAdvanced(true);return}setAdvanced(false); const search = { ...emptySearch, ...values }; setDraft(search); patch({ ...search, view, account: '', ...values }); setAccountRow(null) }
  const selectAccount = (row, tab = 'overview') => { navigate('contents', { platform: row.platform, account: row.account_id }); setAccountRow(row); setAccountTab(tab) }
  const selectTag = (tag) => navigate('contents', { tag })
  const quick = (key, value) => { updateDraft(key, value); patch({ [key]: value }) }
  const onPage = (page) => { setFilters((v) => ({ ...v, page })); resultsRef.current?.scrollIntoView({ block: 'start' }) }
  const exportData = async () => {
    if (exportState.busy) return
    setExportState({ busy: true, error: null, message: '' })
    try {
      const result = await adminApi.dataBrowserExport(token, { ...filters, format: exportFormat, maxRows: Number(exportLimit) })
      downloadBrowserFile(result)
      setExportState({ busy: false, error: null, message: `已导出 ${result.exportedRows} 条${result.truncated ? '；仍有更多匹配记录，本文件不是全量导出，请缩小筛选范围。' : '；已覆盖本次筛选的全部匹配记录。'}` })
    } catch (error) { if (error.status === 401) onUnauthorized?.(error); setExportState({ busy: false, error, message: '' }) }
  }
  if (aggregate) return <div className="mih-data-browser is-aggregate"><PageHeading title="数据浏览中心" description="搜索最新与已存数据，查看各来源交付情况。"/><nav className="mih-browser-tabs" aria-label="浏览类型">{views.map(([key,label])=><button key={key} aria-pressed={key==='aggregate'} onClick={()=>navigate(key)}>{label}</button>)}</nav><Suspense fallback={<LoadingState/>}><DemoProductPage Page={AggregateSearchPanel} pageProps={{session: aggregateSession}} enabled admin compact /></Suspense></div>
  if (diagnostics) return <div className="mih-data-browser"><PageHeading title="数据浏览中心" description="发现账号、检索内容，理解已入库的数据。"/><nav className="mih-browser-tabs" aria-label="浏览类型">{views.map(([key,label])=><button key={key} aria-pressed={key==='diagnostics'} onClick={()=>navigate(key)}>{label}</button>)}</nav><Suspense fallback={<LoadingState/>}><RequestDiagnostics key={token} token={token} onUnauthorized={onUnauthorized} session={diagnosticSession} setSession={setDiagnosticSession}/></Suspense></div>
  if (advanced) return <div className="mih-data-browser"><PageHeading title="数据浏览中心" description="发现账号、检索内容，理解已入库的数据。"/><nav className="mih-browser-tabs" aria-label="浏览类型">{views.map(([key,label])=><button key={key} aria-pressed={key==='advanced'} onClick={()=>navigate(key)}>{label}</button>)}</nav><Suspense fallback={<LoadingState/>}><AdvancedSearchPanel token={token} onUnauthorized={onUnauthorized} onAccount={selectAccount} onTag={selectTag}/></Suspense></div>
  if (selected) return <ContentDetail key={selected.id} row={selected} {...{ token, onUnauthorized }} onClose={() => setSelected(null)} onAccount={selectAccount} onTag={selectTag} onDetail={setSelected} />
  return <div className={`mih-data-browser ${filters.view === "accounts" ? "is-account-list" : ""}`}>
    {!filters.account ? <PageHeading eyebrow="DATA EXPLORER" title="数据浏览中心" description="发现账号、检索内容，理解已入库的数据。" loading={loading} onRefresh={() => { state.refresh(); total.retry() }} /> : null}
    <nav className="mih-browser-tabs" aria-label="浏览类型">{views.map(([key, label]) => <button key={key} aria-pressed={!filters.account && filters.view === key} onClick={() => navigate(key)}>{label}</button>)}<span>Hub 已入库 · 浏览不触发采集</span></nav>
    {filters.account && accountRow ? <AccountHeader token={token} row={accountRow} onUnauthorized={onUnauthorized} onBack={() => navigate('accounts')} onTag={(tag) => navigate('accounts', { tag })} /> : null}
    {filters.tag ? <div className="mih-browser-context"><strong>#{filters.tag}</strong><span>{filters.view === 'accounts' ? '同标签账号候选' : '关联内容'}</span><button className="qp-button qp-button--ghost" onClick={() => { updateDraft('tag', ''); patch({ tag: '' }) }}>清除标签</button></div> : null}
    <details className="qp-panel mih-browser-panel mih-browser-search-panel" key={filters.account ? "account-filters" : "all-filters"} open={!filters.account}><summary className="mih-browser-filter-summary"><Funnel /> 筛选内容与统计范围{filters.from || filters.to ? ` · ${filters.from || "不限"} — ${filters.to || "不限"}` : " · 全部时间"}</summary>
      <form onSubmit={(event) => { event.preventDefault(); patch(draft) }}>
        <div className="mih-browser-filters"><label className="qp-field">{filters.view === 'accounts' ? '账号名称 / ID' : '标题 / 正文'}<div className="mih-browser-search-input"><MagnifyingGlass /><input className="qp-input" value={draft.q} onChange={(event) => updateDraft('q', event.target.value)} placeholder={filters.view === 'accounts' ? '搜索账号名称或平台 ID' : '搜索标题、正文中的关键词'} maxLength={200} /></div></label><DropdownField label="平台" value={draft.platform} disabled={Boolean(filters.account)} options={options(platforms, draft.platform)} onChange={(value) => updateDraft('platform', value)} /><DropdownField label="对象类型" value={draft.objectType} options={options(objectTypes, draft.objectType)} onChange={(value) => updateDraft('objectType', value)} /><button className="qp-button qp-button--primary" disabled={loading}><MagnifyingGlass /> 搜索</button></div>
        <div className="mih-browser-filter-chips" role="group" aria-label="内容形态"><span>内容形态</span>{options(contentTypes, filters.contentType).map(({ value, label }) => <button type="button" key={value} aria-pressed={filters.contentType === value} onClick={() => quick('contentType', value)}>{label}</button>)}</div>
        <div className="mih-browser-filter-chips" role="group" aria-label="发布时间"><span>发布时间</span><button type="button" aria-pressed={!filters.from && !filters.to} onClick={() => { setDraft((v) => ({ ...v, from: '', to: '' })); patch({ from: '', to: '' }) }}>全部时间</button>{[1, 7, 30, 90].map((days) => <button key={days} type="button" onClick={() => { const now = new Date(); const to = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); const from = new Date(now.getTime() - (days - 1) * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); setDraft((v) => ({ ...v, from, to })); patch({ from, to }) }}>近 {days} 天</button>)}{filters.from || filters.to ? <small>{filters.from || '不限'} — {filters.to || '不限'}</small> : null}</div>
        <details className="mih-browser-advanced-wrap"><summary><Funnel /> 更多筛选：日期、标签与自定义类型</summary><div className="mih-browser-advanced"><label className="qp-field">开始日期<input className="qp-input" type="date" value={draft.from} onChange={(event) => updateDraft('from', event.target.value)} /></label><label className="qp-field">结束日期<input className="qp-input" type="date" min={draft.from || undefined} value={draft.to} onChange={(event) => updateDraft('to', event.target.value)} /></label><label className="qp-field">来源标签<input className="qp-input" value={draft.tag} maxLength={200} onChange={(event) => updateDraft('tag', event.target.value)} placeholder="精确匹配来源标签" /></label>{[['platform', '平台标识'], ['objectType', '对象类型标识'], ['contentType', '内容形态标识']].map(([key, label]) => <label key={key} className="qp-field">{label}<input className="qp-input" disabled={key === 'platform' && Boolean(filters.account)} value={draft[key]} maxLength={100} onChange={(event) => updateDraft(key, event.target.value)} /></label>)}</div><p className="mih-browser-note">日期按北京时间筛选发布时间；无发布时间的记录只出现在全部时间中。</p><button className="qp-button qp-button--secondary">应用筛选</button></details>
        <div className="mih-browser-applied"><span>已应用：{[filters.q && `关键词 ${filters.q}`, filters.platform && platformName(filters.platform), filters.objectType && (objectTypes.find(([key]) => key === filters.objectType)?.[1] || filters.objectType), filters.contentType && (contentTypes.find(([key]) => key === filters.contentType)?.[1] || filters.contentType), filters.tag && `#${filters.tag}`, (filters.from || filters.to) && `${filters.from || '不限'} 至 ${filters.to || '不限'}`].filter(Boolean).join(' · ') || '全部入库范围'}</span><button type="button" className="qp-button qp-button--ghost" onClick={() => { const values = { ...emptySearch, platform: filters.account ? filters.platform : '' }; setDraft(values); patch(values) }}>重置</button></div>
      </form>
    </details>
    {filters.account ? <div className="mih-browser-tabs" role="group" aria-label="账号详情分区">{[['overview', '数据概览与画像'], ['contents', '内容列表'], ['related', '关联账号']].map(([key, label]) => <button key={key} aria-pressed={accountTab === key} onClick={() => setAccountTab(key)}>{label}</button>)}</div> : null}
    <section ref={resultsRef} className={`qp-panel mih-browser-panel mih-browser-results ${filters.account && accountTab !== "contents" ? "is-overview" : ""}`}>
      <div className="mih-browser-results-toolbar"><div className="mih-browser-result-count" aria-live="polite"><strong>{total.total == null ? (total.loading ? '正在统计总量…' : '总量暂不可用') : `共 ${formatNumber(total.total)} ${filters.view === 'accounts' ? '个账号' : filters.view === 'hotspots' ? '个热点线索' : '条记录'}`}</strong><small>{!filters.account || accountTab === "contents" ? (total.total === 0 ? "暂无分页 · " : `第 ${filters.page} 页${total.total == null ? "" : ` / 共 ${Math.ceil(total.total / filters.pageSize)} 页`} · `) : ""}{total.error ? <button className="qp-button qp-button--ghost" onClick={total.retry}><ArrowClockwise /> 重试总量统计</button> : total.computedAt ? `统计于 ${formatDate(total.computedAt)} · 最多缓存 2 分钟` : '列表先呈现，总量独立统计'}</small></div>{!filters.account || accountTab === 'contents' ? <><DropdownField label="排序" value={filters.sort} options={options(filters.view === 'accounts' ? [['newest', '账号目录'], ['activity', '匹配记录数']] : filters.view === 'hotspots' ? [['newest', '24 小时记录数']] : [['newest', '最新优先'], ['oldest', '最早优先']])} disabled={filters.view === 'hotspots'} onChange={(value) => { updateDraft('sort', value); patch({ sort: value }) }} /><DropdownField label="每页条数" value={String(filters.pageSize)} options={options([['10', '10 条'], ['20', '20 条'], ['50', '50 条']])} onChange={(value) => patch({ pageSize: Number(value) })} /></> : null}<button className="qp-button qp-button--secondary" aria-expanded={exportOpen} onClick={() => setExportOpen((v) => !v)}><DownloadSimple /> 导出</button></div>
      {exportOpen ? <div className="mih-browser-export"><DropdownField label="导出格式" value={exportFormat} options={options([['csv', 'CSV（Excel）'], ['json', 'JSON（完整字段）']])} onChange={setExportFormat} /><DropdownField label="导出范围" value={exportLimit} options={options([['200', '前 200 条'], ['500', '前 500 条']])} onChange={setExportLimit} /><button className="qp-button qp-button--primary" disabled={exportState.busy || loading || Boolean(state.error)} onClick={exportData}>{exportState.busy ? '正在生成文件…' : '导出已应用筛选'}</button><small>从筛选结果第一条开始，内容包含完整正文。</small></div> : null}
      {exportState.error ? <ErrorState error={exportState.error} /> : null}{exportState.message ? <p role="status" className="mih-browser-note">{exportState.message}</p> : null}
      {filters.account && accountTab !== 'contents' ? null : <>{filters.view === 'hotspots' ? <p className="mih-browser-note">近 7 天至少出现 2 次的来源标签，按最近 24 小时记录数排序；日期筛选与此窗口取交集。属于待关注线索，尚未进行事件聚类或预测。</p> : null}{state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : loading ? <LoadingState label="正在读取入库数据" /> : !items.length ? <EmptyState title="暂无匹配的入库数据" description="调整关键词、类型、平台或时间范围。" /> : filters.view === 'accounts' ? <AccountCards items={items} onAccount={selectAccount} onTag={(tag) => navigate('accounts', { tag })} /> : filters.view === 'contents' ? <ContentTable items={items} onDetail={setSelected} onAccount={selectAccount} onTag={selectTag} /> : <div className="mih-table-wrap"><table className="mih-table"><thead><tr>{['来源标签', '7 天记录', '24 小时记录', '涉及平台', '最近发布', ''].map((label, i) => <th key={i}>{label}</th>)}</tr></thead><tbody>{items.map((row) => <tr key={row.tag}><td><strong>#{row.tag}</strong></td><td>{formatNumber(row.records)}</td><td>{formatNumber(row.recent)}</td><td>{formatNumber(row.platforms)}</td><td>{formatDate(row.updated_at)}</td><td><button className="qp-button qp-button--ghost" onClick={() => selectTag(row.tag)}>查看关联内容 →</button></td></tr>)}</tbody></table></div>}<Pagination {...{ filters, data, total, loading, onPage }} /></>}
    </section>
    {filters.account && accountTab !== 'contents' ? <AccountAnalysis {...{ token, filters, onUnauthorized }} related={accountTab === 'related'} onTag={(tag) => navigate('accounts', { tag })} /> : null}
    <details className="mih-browser-footnote"><summary>数据与分析说明</summary><p>统计当前未删除的记录。账号以平台和稳定 ID 区分，名称相同不合并。列表实时读取，精确总数为单独统计时的结果；入库持续变化时，页数可能变化。最多直接浏览 500 页，可进一步筛选或导出。</p><p>账号卡片的标签汇总最近 20 条匹配内容；详情画像按筛选范围内全部内容的来源标签统计。Agent 主题推断、情感、受众画像、相似度和事件预测尚未接入本浏览中心，不表示已有任务排队。缺失指标显示 —。</p></details>
  </div>
}
