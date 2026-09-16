import { useCallback, useState } from 'react'
import { Database, Users, FileText, Pulse } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField, EmptyState, ErrorState, LoadingState, MetricCard, Modal, PageHeading, formatDate, useRemoteData } from './components.jsx'
import './data-browser.css'

const views = [{ value: 'accounts', label: '账号大盘' }, { value: 'contents', label: '内容大盘' }, { value: 'hotspots', label: '热点线索' }]
const safeUrl = (value) => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null
const asTags = (row) => (Array.isArray(row.stable_fields?.tags) ? row.stable_fields.tags : []).filter((tag) => typeof tag === 'string')

function Tags({ tags, onTag }) {
  return <div className="mih-browser-tags">{[...new Set(tags)].map((tag) => <button key={tag} className="qp-button qp-button--ghost" onClick={() => onTag(tag)}>#{tag}</button>)}</div>
}
function Fields({ value, title = '完整字段' }) {
  return <details className="mih-browser-fields"><summary>{title}</summary><pre className="qp-code-block">{JSON.stringify(value, null, 2)}</pre></details>
}
function downloadBrowserFile(result) {
  const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function ContentDetail({ row, token, onUnauthorized, onClose, onAccount, onTag }) {
  const [showMedia, setShowMedia] = useState(false)
  const [exportState, setExportState] = useState({ busy: false, error: null })
  const exportDetail = async () => {
    if (exportState.busy) return
    setExportState({ busy: true, error: null })
    try {
      downloadBrowserFile(await adminApi.dataBrowserExport(token, { id: row.id, format: 'json', maxRows: 1 }))
      setExportState({ busy: false, error: null })
    } catch (error) {
      if (error.status === 401) onUnauthorized?.(error)
      setExportState({ busy: false, error })
    }
  }
  const load = useCallback(() => adminApi.dataBrowser(token, { id: row.id }), [token, row.id])
  const state = useRemoteData(load, onUnauthorized)
  const item = state.data?.items?.[0] || row
  const media = item.stable_fields?.media || {}
  const metrics = item.stable_fields?.metrics || {}
  return <Modal title={item.title || item.external_id || '内容详情'} size="large" onClose={onClose}>
    {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
    {state.loading ? <LoadingState label="正在读取完整字段" /> : null}
    <button className="qp-button qp-button--secondary" onClick={exportDetail} disabled={exportState.busy}>{exportState.busy ? '正在导出…' : '导出此条 JSON'}</button>
    {exportState.error ? <ErrorState error={exportState.error} /> : null}
    <p>{item.platform} · {item.object_type} · 发布 {formatDate(item.event_time)} · 入库 {formatDate(item.collected_at)}</p>
    <button className="qp-button qp-button--secondary" disabled={!item.account_id} onClick={() => onAccount(item)}>{item.author_name || item.account_id || '账号身份缺失'} · 查看账号</button>
    <div className="mih-browser-metrics">{Object.entries(metrics).map(([key, value]) => <div key={key}><small>{({ likes: '点赞', comments: '评论', shares: '分享', favorites: '收藏', views: '浏览', followers: '粉丝' })[key] || key}</small><strong>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '未知')}</strong></div>)}</div>
    <p className="mih-browser-body">{item.body || '尚未采集正文；不会自动向上游补采。'}</p>
    <Tags tags={asTags(item)} onTag={onTag} />
    <p className="mih-browser-note">标签来自入库内容。点击标签浏览相关内容；同标签仅代表关联线索，不代表同一事件。</p>
    {safeUrl(item.url) ? <a className="qp-button qp-button--ghost" href={item.url} target="_blank" rel="noreferrer">打开来源</a> : null}
    <button className="qp-button qp-button--secondary" onClick={() => setShowMedia((value) => !value)}>{showMedia ? '收起媒体预览' : '展示已采集媒体'}</button>
    {showMedia ? <div className="mih-browser-media-preview">{['images', 'videos', 'audio'].flatMap((kind) => (Array.isArray(media[kind]) ? media[kind] : []).map((entry, index) => {
      const url = safeUrl(typeof entry === 'string' ? entry : entry?.url)
      if (!url) return null
      return kind === 'images' ? <img key={`${kind}-${index}`} src={url} alt={`已采集图片 ${index + 1}（加载失败时可使用下方原始链接）`} loading="lazy" referrerPolicy="no-referrer" /> : kind === 'videos' ? <video key={`${kind}-${index}`} src={url} controls preload="none" /> : <audio key={`${kind}-${index}`} src={url} controls preload="none" />
    }))}</div> : null}
    <div className="mih-browser-media">{['images', 'videos', 'audio'].flatMap((kind) => (Array.isArray(media[kind]) ? media[kind] : []).map((entry, index) => {
      const url = safeUrl(typeof entry === 'string' ? entry : entry?.url)
      return url ? <a key={`${kind}-${index}`} href={url} target="_blank" rel="noreferrer">{kind === 'images' ? '图片' : kind === 'videos' ? '视频' : '音频'} {index + 1} ↗</a> : null
    }))}</div>
    {!state.loading && !state.error ? <Fields value={item} title="全部已入库字段（含媒体、评论及扩展字段，如已采集）" /> : null}
    <section className="mih-browser-note"><strong>分析与关联</strong><p>本浏览中心尚未接入 Agent 画像、情感或事件关联分析。当前仅提供来源标签和账号身份关联；没有评论明细时，评论数不等于已采集评论。</p></section>
  </Modal>
}

const emptySearch = { q: '', platform: '', objectType: '', contentType: '', from: '', to: '', tag: '', sort: 'newest' }
const platforms = [['', '全部平台'], ['xiaohongshu', '小红书'], ['douyin', '抖音'], ['kuaishou', '快手'], ['bilibili', '哔哩哔哩'], ['weibo', '微博'], ['telegram', 'Telegram'], ['twitter', 'X / Twitter'], ['taobao', '淘宝'], ['jd', '京东'], ['mobile_commerce', '移动电商']]
const objectTypes = [['', '全部对象'], ['post', '帖子 / 笔记'], ['product', '商品'], ['comment', '评论'], ['message', '消息'], ['article', '文章'], ['user', '用户资料'], ['account', '账号'], ['profile', '画像资料'], ['chat', '会话']]
const contentTypes = [['', '全部内容形态'], ['video', '视频'], ['image', '图片'], ['text', '文字'], ['note', '笔记'], ['audio', '音频'], ['link', '链接']]
const withCustom = (pairs, value) => pairs.some(([key]) => key === value) ? pairs : [...pairs, [value, value]]
const options = (pairs) => pairs.map(([value, label]) => ({ value, label }))

function AccountSummary({ token, filters, onUnauthorized, onTag }) {
  const load = useCallback(() => adminApi.dataBrowser(token, { ...filters, summary: 'true', page: 1 }), [token, filters])
  const state = useRemoteData(load, onUnauthorized)
  if (state.loading) return <LoadingState label="正在汇总账号标签，不影响下方内容浏览" />
  if (state.error) return <ErrorState error={state.error} onRetry={state.refresh} />
  const summary = state.data?.account_summary
  return summary ? <div><p>样本发布区间：{formatDate(summary.firstPublishedAt)} — {formatDate(summary.lastPublishedAt)} · 有发布时间 {summary.datedRecords} 条</p><div className="mih-browser-tags">{summary.tags.map((entry) => <button key={entry.tag} className="qp-button qp-button--secondary" onClick={() => onTag(entry.tag)}>#{entry.tag} · {entry.records} 条 · 相关账号</button>)}</div><p className="mih-browser-note">按当前筛选的全部记录汇总。来源标签相同只代表关联候选。</p></div> : <p>暂无标签汇总</p>
}

export function DataBrowserPage({ token, onUnauthorized }) {
  const [filters, setFilters] = useState({ ...emptySearch, view: 'accounts', account: '', page: 1, pageSize: 20 })
  const [draft, setDraft] = useState(emptySearch)
  const [accountName, setAccountName] = useState('')
  const [selected, setSelected] = useState(null)
  const [showSummary, setShowSummary] = useState(false)
  const [exportFormat, setExportFormat] = useState('csv')
  const [exportLimit, setExportLimit] = useState('200')
  const [exportState, setExportState] = useState({ busy: false, error: null, message: '' })
  const filterKey = JSON.stringify(filters)
  const load = useCallback(async () => ({ ...await adminApi.dataBrowser(token, filters), filterKey }), [token, filters, filterKey])
  const state = useRemoteData(load, onUnauthorized)
  const data = state.data
  const loading = state.loading || (!state.error && data?.filterKey !== filterKey)
  const items = loading || state.error ? [] : data?.items || []
  const updateDraft = (key, value) => setDraft((current) => ({ ...current, [key]: value }))
  const patch = (values) => { setSelected(null); setShowSummary(false); setFilters((current) => ({ ...current, ...values, page: 1 })) }
  const navigate = (view, values = {}) => {
    const search = { ...emptySearch, ...values }
    setDraft(search); patch({ ...search, view, account: '', ...values })
  }
  const selectAccount = (row) => {
    setAccountName(row.name || row.author_name || row.account_id)
    navigate('contents', { platform: row.platform, account: row.account_id })
  }
  const selectTag = (tag) => navigate('contents', { tag })
  const exportData = async () => {
    if (exportState.busy) return
    setExportState({ busy: true, error: null, message: '' })
    try {
      const result = await adminApi.dataBrowserExport(token, { ...filters, format: exportFormat, maxRows: Number(exportLimit) })
      downloadBrowserFile(result)
      setExportState({ busy: false, error: null, message: `已导出 ${result.exportedRows} 条${result.truncated ? '；仍有更多匹配记录，本文件不是全量导出，请缩小筛选范围。' : '；已覆盖本次筛选的全部匹配记录。'}` })
    } catch (error) {
      if (error.status === 401) onUnauthorized?.(error)
      setExportState({ busy: false, error, message: '' })
    }
  }
  return <div className="mih-data-browser">
    <PageHeading eyebrow="DATA EXPLORER" title="数据浏览中心" description="搜索已入库的账号、内容和热点线索，查看详情并导出。" loading={loading} onRefresh={state.refresh} />
    <div className="mih-browser-nav" role="group" aria-label="浏览类型">{views.map((view) => <button className={`qp-button ${filters.view === view.value ? 'qp-button--primary' : 'qp-button--ghost'}`} key={view.value} aria-pressed={filters.view === view.value} onClick={() => navigate(view.value)}>{view.label}</button>)}</div>
    <div className="mih-browser-summary">
      <MetricCard icon={filters.view === 'accounts' ? Users : filters.view === 'contents' ? FileText : Pulse} label={filters.view === 'accounts' ? '本页账号' : filters.view === 'contents' ? '本页记录' : '本页热点线索'} value={loading || state.error ? '—' : items.length} hint="先加载列表，不等待全库精确计数" />
      <MetricCard icon={Database} label="数据来源" value="Hub 已入库" hint="浏览和导出不触发外部采集" />
      <MetricCard icon={Pulse} label="智能分析能力" value="尚未接入" hint="画像、情感、事件关联及趋势预测" />
    </div>
    <details className="mih-browser-note"><summary>智能分析包含哪些内容？</summary><p>账号：内容标签画像、相似账号推荐；内容：摘要、主题和情感；热点：事件聚类、关联和趋势预测。这些分析尚未接入本浏览中心，并非有任务排队等待运行。当前已有的是入库字段、来源标签、数量统计及同标签关联候选。</p></details>
    {filters.account ? <section className="qp-panel mih-browser-account"><p className="qp-kicker">ACCOUNT PROFILE</p><h2>{accountName}</h2><p>{filters.platform} · {filters.account}</p><p>下方可按类型、日期、关键词筛选该账号的内容，并导出。标签汇总单独加载。</p><div className="mih-browser-nav"><button className="qp-button qp-button--secondary" onClick={() => setShowSummary((value) => !value)}>{showSummary ? '收起标签汇总' : '加载账号标签汇总'}</button><button className="qp-button qp-button--ghost" onClick={() => navigate('accounts')}>返回账号大盘</button></div>{showSummary ? <AccountSummary token={token} filters={filters} onUnauthorized={onUnauthorized} onTag={(tag) => navigate('accounts', { tag })} /> : null}</section> : null}
    {filters.tag ? <section className="qp-panel mih-browser-account"><h2>#{filters.tag} · {filters.view === 'accounts' ? '关联账号候选' : '关联内容'}</h2><p>同标签关联，保留当前列表的类型与时间筛选；不代表已经确认同一事件。</p><button className="qp-button qp-button--ghost" onClick={() => navigate('hotspots')}>返回热点线索</button></section> : null}
    {data?.evidence?.cacheMaxAgeSeconds > 0 && !loading && !state.error ? <p className="mih-browser-note">统计时间：{formatDate(data.evidence.computedAt)} · 聚合结果最多复用 30 秒。</p> : null}
    <section className="qp-panel mih-browser-panel">
      <form onSubmit={(event) => { event.preventDefault(); patch(draft) }}>
        <div className="mih-browser-filters">
          <label className="qp-field">{filters.view === 'accounts' ? '账号名称 / ID' : '标题 / 正文'}<input className="qp-input" value={draft.q} onChange={(event) => updateDraft('q', event.target.value)} placeholder="输入关键词" maxLength={200} /></label>
          <DropdownField label="平台" value={draft.platform} disabled={Boolean(filters.account)} options={options([...platforms, ...(!platforms.some(([key]) => key === draft.platform) ? [[draft.platform, draft.platform]] : [])])} onChange={(value) => updateDraft('platform', value)} />
          <DropdownField label="每页条数" value={String(filters.pageSize)} options={options([['10', '10 条'], ['20', '20 条'], ['50', '50 条']])} onChange={(value) => patch({ pageSize: Number(value) })} />
          <button className="qp-button qp-button--primary" disabled={loading}>搜索</button>
        </div>
        <div className="mih-browser-advanced">
          <DropdownField label="对象类型" value={draft.objectType} options={options(withCustom(objectTypes, draft.objectType))} onChange={(value) => updateDraft('objectType', value)} />
          <DropdownField label="内容形态" value={draft.contentType} options={options(withCustom(contentTypes, draft.contentType))} onChange={(value) => updateDraft('contentType', value)} />
          <label className="qp-field">开始日期<input className="qp-input" type="date" value={draft.from} onChange={(event) => updateDraft('from', event.target.value)} /></label>
          <label className="qp-field">结束日期<input className="qp-input" type="date" min={draft.from || undefined} value={draft.to} onChange={(event) => updateDraft('to', event.target.value)} /></label>
          <label className="qp-field">来源标签<input className="qp-input" value={draft.tag} maxLength={200} onChange={(event) => updateDraft('tag', event.target.value)} placeholder="精确匹配标签" /></label>
          <DropdownField label="排序" value={draft.sort} options={options(filters.view === 'accounts' ? [['newest', '账号目录（快速）'], ['activity', '入库内容数量（全量聚合）']] : [['newest', '最新优先'], ['oldest', '最早优先']])} disabled={filters.view === 'hotspots'} onChange={(value) => updateDraft('sort', value)} />
        </div>
        <details className="mih-browser-note"><summary>其他平台 / 自定义类型</summary><div className="mih-browser-advanced">{[['platform', '平台标识'], ['objectType', '对象类型标识'], ['contentType', '内容形态标识']].map(([key, label]) => <label key={key} className="qp-field">{label}<input className="qp-input" disabled={key === 'platform' && Boolean(filters.account)} value={draft[key]} maxLength={100} onChange={(event) => updateDraft(key, event.target.value)} /></label>)}</div></details>
        <div className="mih-browser-nav mih-browser-note"><span>发布时间按北京时间筛选</span>{[1, 7, 30, 90].map((days) => <button key={days} type="button" className="qp-button qp-button--ghost" onClick={() => { const now = new Date(); const to = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); const from = new Date(now.getTime() - (days - 1) * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }); setDraft((v) => ({ ...v, from, to })) }}>近 {days} 天</button>)}<button type="button" className="qp-button qp-button--ghost" onClick={() => { const values = { ...emptySearch, platform: filters.account ? filters.platform : '' }; setDraft(values); patch(values) }}>重置筛选</button></div>
      </form>
      <div className="mih-browser-export"><DropdownField label="导出格式" value={exportFormat} options={options([['csv', 'CSV（Excel）'], ['json', 'JSON（完整字段）']])} onChange={setExportFormat} /><DropdownField label="导出范围" value={exportLimit} options={options([['200', '前 200 条'], ['500', '前 500 条']])} onChange={setExportLimit} /><button className="qp-button qp-button--secondary" disabled={exportState.busy || loading || Boolean(state.error)} onClick={exportData}>{exportState.busy ? '正在生成文件…' : '导出已应用筛选'}</button><span className="mih-browser-note">从筛选结果第一条开始；内容导出包含完整正文。</span></div>
      {exportState.error ? <ErrorState error={exportState.error} /> : null}{exportState.message ? <p role="status">{exportState.message}</p> : null}
      {filters.view === 'hotspots' ? <p className="mih-browser-note">近 7 天至少出现 2 次的来源标签，按最近 24 小时记录数排序。日期筛选与该窗口取交集。属于需关注线索，尚未进行事件聚类或预测。</p> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : loading ? <LoadingState label="正在读取入库数据" /> : !items.length ? <EmptyState title="暂无匹配的入库数据" description="调整关键词、类型、平台或时间范围。" /> : <div className="mih-table-wrap"><table className="mih-table" aria-label="数据浏览列表"><thead><tr>{(filters.view === 'accounts' ? ['账号', '平台', '匹配内容 / 总记录', '最近采集', '操作'] : filters.view === 'hotspots' ? ['标签线索', '7 天记录', '24 小时记录', '涉及平台数', '最近发布', '操作'] : ['内容', '平台 / 类型', '发布账号', '发布时间', '来源标签', '操作']).map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{items.map((row) => filters.view === 'accounts' ? <tr key={`${row.platform}:${row.account_id}`}><td><strong>{row.name || '未采集名称'}</strong><small className="mih-browser-sub">{row.account_id}</small></td><td>{row.platform}</td><td>{row.contents} / {row.records}</td><td>{formatDate(row.updated_at)}</td><td><button className="qp-button qp-button--ghost" onClick={() => selectAccount(row)}>账号详情 →</button></td></tr> : filters.view === 'hotspots' ? <tr key={row.tag}><td><strong>#{row.tag}</strong></td><td>{row.records}</td><td>{row.recent}</td><td>{row.platforms}</td><td>{formatDate(row.updated_at)}</td><td><button className="qp-button qp-button--ghost" onClick={() => selectTag(row.tag)}>查看关联内容 →</button></td></tr> : <tr key={row.id}><td><strong>{row.title || row.external_id || '无标题'}</strong><small className="mih-browser-sub">{row.body?.slice(0, 140) || '暂无正文'}</small></td><td>{row.platform}<small className="mih-browser-sub">{row.object_type} · {row.content_type || '未分类'}</small></td><td><button className="qp-button qp-button--ghost" disabled={!row.account_id} onClick={() => selectAccount(row)}>{row.author_name || row.account_id || '身份缺失'}</button></td><td>{formatDate(row.event_time)}</td><td><Tags tags={asTags(row)} onTag={selectTag} /></td><td><button className="qp-button qp-button--ghost" onClick={() => setSelected(row)}>内容详情 →</button></td></tr>)}</tbody></table></div>}
      <div className="mih-browser-pagination"><button className="qp-button qp-button--secondary" disabled={loading || filters.page <= 1} onClick={() => setFilters((v) => ({ ...v, page: v.page - 1 }))}>上一页</button><span>第 {filters.page} 页 · 每页 {filters.pageSize} 条</span><button className="qp-button qp-button--secondary" disabled={loading || Boolean(state.error) || !data?.hasMore || filters.page >= 500} onClick={() => setFilters((v) => ({ ...v, page: v.page + 1 }))}>下一页</button></div>
      <p className="mih-browser-note">当前列表不计算全库总数；“下一页”依据额外读取一条记录判断。账号默认按平台及稳定 ID 排序，数量排名需显式选择。最多浏览 500 页；翻页是实时读取，导出为单次读取快照。缺少发布时间时，默认列表以采集/入库时间排序。</p>
    </section>
    {selected ? <ContentDetail key={selected.id} row={selected} token={token} onUnauthorized={onUnauthorized} onClose={() => setSelected(null)} onAccount={selectAccount} onTag={selectTag} /> : null}
  </div>
}
