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
function ContentDetail({ row, token, onUnauthorized, onClose, onAccount, onTag }) {
  const [showMedia, setShowMedia] = useState(false)
  const load = useCallback(() => adminApi.dataBrowser(token, { id: row.id }), [token, row.id])
  const state = useRemoteData(load, onUnauthorized)
  const item = state.data?.items?.[0] || row
  const media = item.stable_fields?.media || {}
  const metrics = item.stable_fields?.metrics || {}
  return <Modal title={item.title || item.external_id || '内容详情'} size="large" onClose={onClose}>
    {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
    {state.loading ? <LoadingState label="正在读取完整字段" /> : null}
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
    <section className="mih-browser-note"><strong>分析与关联</strong><p>未运行 Agent 画像、情感或事件关联分析。当前仅提供来源标签和账号身份关联；没有评论明细时，评论数不等于已采集评论。</p></section>
  </Modal>
}

export function DataBrowserPage({ token, onUnauthorized }) {
  const [filters, setFilters] = useState({ view: 'accounts', q: '', platform: '', account: '', tag: '', page: 1, pageSize: 20 })
  const [search, setSearch] = useState('')
  const [platform, setPlatform] = useState('')
  const [accountName, setAccountName] = useState('')
  const [selected, setSelected] = useState(null)
  const filterKey = JSON.stringify(filters)
  const load = useCallback(async () => ({ ...await adminApi.dataBrowser(token, filters), filterKey }), [token, filters, filterKey])
  const state = useRemoteData(load, onUnauthorized)
  const data = state.data
  const loading = state.loading || (!state.error && data?.filterKey !== filterKey)
  const items = data?.items || []
  const patch = (values) => { setSelected(null); setFilters((current) => ({ ...current, ...values, page: 1 })) }
  const selectAccount = (row) => {
    setAccountName(row.name || row.author_name || row.account_id)
    setSearch(''); setPlatform(row.platform)
    patch({ view: 'contents', account: row.account_id, platform: row.platform, tag: '', q: '' })
  }
  const selectTag = (tag) => { setSearch(''); setPlatform(''); patch({ view: 'contents', tag, account: '', platform: '', q: '' }) }
  const switchView = (view) => { setSearch(''); setPlatform(''); patch({ view, account: '', tag: '', platform: '', q: '' }) }
  return <div className="mih-data-browser">
    <PageHeading eyebrow="DATA EXPLORER" title="数据浏览中心" description="从账号、内容到热点线索，浏览 Hub 已积累的数据与证据。" loading={loading} onRefresh={state.refresh} />
    <div className="mih-browser-nav" role="group" aria-label="浏览类型">{views.map((view) => <button className={`qp-button ${filters.view === view.value ? 'qp-button--primary' : 'qp-button--ghost'}`} key={view.value} aria-pressed={filters.view === view.value} onClick={() => switchView(view.value)}>{view.label}</button>)}</div>
    <div className="mih-browser-summary">
      <MetricCard icon={filters.view === 'accounts' ? Users : filters.view === 'contents' ? FileText : Pulse} label={filters.view === 'accounts' ? '匹配账号' : filters.view === 'contents' ? '匹配记录' : '近 7 天标签线索'} value={loading || state.error ? '—' : data?.total ?? '—'} hint="当前筛选 · 全量入库范围" />
      <MetricCard icon={Database} label="数据来源" value="Hub 已入库" hint="浏览不触发外部采集" />
      <MetricCard icon={Pulse} label="Agent 分析" value="尚未运行" hint="来源事实与推断分别呈现" />
    </div>
    {filters.account ? <section className="qp-panel mih-browser-account"><p className="qp-kicker">ACCOUNT PROFILE</p><h2>{accountName}</h2><p>{filters.platform} · {filters.account}</p><p>以下为该账号全部已入库内容及资料记录。可查看每条记录的原始指标和字段。</p><p>标签画像与相似账号分析尚未运行；不能由同名推断账号关联。</p>
      {!loading && !state.error && data?.account_summary ? <div>
        <p>入库样本发布区间：{formatDate(data.account_summary.firstPublishedAt)} — {formatDate(data.account_summary.lastPublishedAt)} · 有发布时间 {data.account_summary.datedRecords} 条</p>
        <h3>内容标签分布</h3><p className="mih-browser-note">按当前筛选的全部入库记录统计，最多展示 20 个来源标签。点击查看持有同标签内容的账号；这是规则关联候选，不是身份关联结论。</p>
        <div className="mih-browser-tags">{data.account_summary.tags.map((entry) => <button key={entry.tag} className="qp-button qp-button--secondary" onClick={() => { setPlatform(''); setSearch(''); patch({ view: 'accounts', tag: entry.tag, account: '', platform: '', q: '' }) }}>#{entry.tag} · {entry.records} 条 · 相关账号</button>)}</div>
      </div> : null}<button className="qp-button qp-button--ghost" onClick={() => switchView('accounts')}>返回账号大盘</button></section> : null}
    {filters.tag ? <section className="qp-panel mih-browser-account"><h2>#{filters.tag} · {filters.view === 'accounts' ? '关联账号候选' : '关联内容'}</h2><p>展示全部已入库同标签记录，包含历史记录。热点入口的统计窗口为最近 7 天。</p><button className="qp-button qp-button--ghost" onClick={() => switchView('hotspots')}>返回热点线索</button></section> : null}
    <section className="qp-panel mih-browser-panel">
      <form className="mih-browser-filters" onSubmit={(event) => { event.preventDefault(); patch({ q: search, platform }) }}>
        <label className="qp-field">{filters.view === 'accounts' ? '账号名称 / ID' : '标题 / 正文'}<input className="qp-input" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="输入关键词" maxLength={200} /></label>
        <label className="qp-field">平台<input className="qp-input" value={platform} disabled={Boolean(filters.account)} onChange={(event) => setPlatform(event.target.value)} placeholder="全部平台（输入平台标识筛选）" maxLength={100} /></label>
        <DropdownField label="每页条数" value={String(filters.pageSize)} options={[10, 20, 50].map((value) => ({ value: String(value), label: `${value} 条` }))} onChange={(value) => patch({ pageSize: Number(value) })} />
        <button className="qp-button qp-button--primary" disabled={loading}>查询</button>
      </form>
      {filters.view === 'hotspots' ? <p className="mih-browser-note">近期热点信号：按近 24 小时记录数排序，统计近 7 天内至少出现 2 次的来源标签。属于需关注候选，尚未完成事件聚类、舆情研判或未来热度预测。</p> : null}
      {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : loading ? <LoadingState label="正在读取入库数据" /> : !items.length ? <EmptyState title="暂无匹配的入库数据" description="调整筛选条件，或在数据清洗中心查看入库进度。" /> : <div className="mih-table-wrap"><table className="mih-table" aria-label="数据浏览列表"><thead><tr>{(filters.view === 'accounts' ? ['账号', '平台', '入库内容 / 总记录', '最近采集', '分析状态', '操作'] : filters.view === 'hotspots' ? ['标签线索', '7 天记录', '24 小时记录', '涉及平台数', '最近发布', '操作'] : ['内容', '平台 / 类型', '发布账号', '发布时间', '来源标签', '操作']).map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{items.map((row) => filters.view === 'accounts' ? <tr key={`${row.platform}:${row.account_id}`}><td><strong>{row.name || '未采集名称'}</strong><small className="mih-browser-sub">{row.account_id}</small></td><td>{row.platform}</td><td>{row.contents} / {row.records}</td><td>{formatDate(row.updated_at)}</td><td>未分析</td><td><button className="qp-button qp-button--ghost" onClick={() => selectAccount(row)}>账号详情 →</button></td></tr> : filters.view === 'hotspots' ? <tr key={row.tag}><td><strong>#{row.tag}</strong></td><td>{row.records}</td><td>{row.recent}</td><td>{row.platforms}</td><td>{formatDate(row.updated_at)}</td><td><button className="qp-button qp-button--ghost" onClick={() => selectTag(row.tag)}>查看关联内容 →</button></td></tr> : <tr key={row.id}><td><strong>{row.title || row.external_id || '无标题'}</strong><small className="mih-browser-sub">{row.body?.slice(0, 140) || '暂无正文'}</small></td><td>{row.platform}<small className="mih-browser-sub">{row.object_type} · {row.content_type || '未分类'}</small></td><td><button className="qp-button qp-button--ghost" disabled={!row.account_id} onClick={() => selectAccount(row)}>{row.author_name || row.account_id || '身份缺失'}</button></td><td>{formatDate(row.event_time)}</td><td><Tags tags={asTags(row)} onTag={selectTag} /></td><td><button className="qp-button qp-button--ghost" onClick={() => setSelected(row)}>内容详情 →</button></td></tr>)}</tbody></table></div>}
      <div className="mih-browser-pagination"><button className="qp-button qp-button--secondary" disabled={loading || filters.page <= 1} onClick={() => setFilters((v) => ({ ...v, page: v.page - 1 }))}>上一页</button><span>第 {filters.page} 页 · 每页 {filters.pageSize} 条</span><button className="qp-button qp-button--secondary" disabled={loading || Boolean(state.error) || !data?.hasMore || filters.page >= 500} onClick={() => setFilters((v) => ({ ...v, page: v.page + 1 }))}>下一页</button></div>
      <p className="mih-browser-note">仅统计未删除的当前记录；翻页采用实时数据，不承诺跨页快照。最多浏览 500 页，可缩小筛选范围。产品、帖子、评论及其他类型保留各自来源字段，空值不代表零。</p>
    </section>
    {selected ? <ContentDetail key={selected.id} row={selected} token={token} onUnauthorized={onUnauthorized} onClose={() => setSelected(null)} onAccount={selectAccount} onTag={selectTag} /> : null}
  </div>
}
