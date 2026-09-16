import { useCallback, useEffect, useRef, useState } from 'react'
import Chart from 'chart.js/auto'
import { UserCircle, ImageSquare, ArrowLeft, ArrowUpRight, FileText, DownloadSimple } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { EmptyState, ErrorState, LoadingState, formatDate, useRemoteData, useThemeRevision } from './components.jsx'
import { metricLabels, metricNumber, recordPresentation, safeMediaUrl, sourceTags } from '../shared/data-browser-presentation.mjs'

export const formatNumber = (value) => metricNumber(value) == null ? '—' : Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 })
export const platformName = (key) => ({ xiaohongshu: '小红书', douyin: '抖音', kuaishou: '快手', telegram: 'Telegram', bilibili: '哔哩哔哩', weibo: '微博', twitter: 'X / Twitter', mobile_commerce: '移动电商', taobao: '淘宝', jd: '京东' })[key] || key
export const typeName = (key) => ({ post: '帖子 / 笔记', product: '商品', comment: '评论', message: '消息', article: '文章', user: '用户资料', account: '账号', profile: '画像资料', chat: '会话', video: '视频', image: '图片', note: '笔记', text: '文字', audio: '音频' })[key] || key || '未分类'
export function Tags({ tags, onTag }) {
  return <div className="mih-browser-tags">{tags.map((tag) => <button type="button" key={tag} onClick={() => onTag(tag)}>#{tag}</button>)}</div>
}
export function Fields({ value, title = '完整入库字段' }) {
  return <details className="mih-browser-fields"><summary>{title}</summary><pre className="qp-code-block">{JSON.stringify(value, null, 2)}</pre></details>
}
export function downloadBrowserFile(result) {
  const url = URL.createObjectURL(new Blob([result.content], { type: result.mimeType }))
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = result.filename
  document.body.appendChild(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function StoredImage({ url, avatar = false, label }) {
  const [failed, setFailed] = useState(false)
  const Icon = avatar ? UserCircle : ImageSquare
  return <span className={`mih-browser-image ${avatar ? 'is-avatar' : ''}`}>{url && !failed ? <img src={url} alt={label} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <Icon size={avatar ? 40 : 28} aria-label={avatar ? '未采集头像' : '无可用封面'} />}</span>
}
export function Fact({ label, value, hint }) {
  return <div className="mih-browser-fact"><small>{label}</small><strong>{formatNumber(value)}</strong>{hint ? <span>{hint}</span> : null}</div>
}
export function AccountCards({ items, onAccount, onTag }) {
  return <div className="mih-browser-accounts">{items.map((row) => {
    const p = recordPresentation(row)
    return <article className="mih-browser-account-card" key={`${row.platform}:${row.account_id}`}>
      <div className="mih-browser-account-identity"><div className="mih-browser-person"><StoredImage key={p.avatar} url={p.avatar} avatar label={row.name} /><div><button className="mih-browser-title-button" onClick={() => onAccount(row)}>{row.name || '未采集名称'}</button><span className="mih-browser-platform">{platformName(row.platform)}</span><small>ID：{row.account_id}</small></div></div><p className="mih-browser-bio">{p.bio || '暂未采集账号简介'}</p><Tags tags={p.tags.slice(0, 5)} onTag={onTag} /><small className="mih-browser-caption">{row.sample?.records ? `最近 ${row.sample.records} 条内容 · ${(row.sample.types || []).map((entry) => typeName(entry.type)).join(' / ')}` : '暂未采集内容标签'}</small></div>
      <div className="mih-browser-account-numbers"><Fact label="粉丝数" value={p.followers} hint={row.profile?.collectedAt ? `资料采集 ${formatDate(row.profile.collectedAt)}` : '未采集时显示 —'} /><Fact label="匹配内容" value={row.contents} hint="按当前筛选" /><Fact label="匹配入库记录" value={row.records} hint="含账号资料" /><div className="mih-browser-fact"><small>最近采集</small><strong className="is-date">{formatDate(row.updated_at)}</strong><span>仅代表 Hub 已采集范围</span></div></div>
      <div className="mih-browser-card-actions"><button className="qp-button qp-button--secondary" onClick={() => onAccount(row)}>账号详情 <ArrowUpRight /></button><button className="qp-button qp-button--ghost" onClick={() => onAccount(row, 'contents')}>内容列表</button></div>
    </article>
  })}</div>
}
export function ContentTable({ items, onDetail, onAccount, onTag }) {
  return <div className="mih-table-wrap"><table className="mih-table mih-browser-content-table" aria-label="内容检索结果"><thead><tr>{['内容 / 发布时间', '发布账号', '点赞', '评论', '分享', '收藏', '浏览', ''].map((label, i) => <th key={i}>{label}</th>)}</tr></thead><tbody>{items.map((row) => {
    const p = recordPresentation(row)
    return <tr key={row.id}><td><div className="mih-browser-content-cell"><button className="mih-browser-cover-button" onClick={() => onDetail(row)} aria-label={`查看 ${row.title || row.external_id}`}><StoredImage key={p.cover} url={p.cover} label={row.title || '内容封面'} /></button><div><button className="mih-browser-title-button" onClick={() => onDetail(row)}>{row.title || row.body?.slice(0, 80) || row.external_id || '无标题'}</button><small>{platformName(row.platform)} · {typeName(row.content_type || row.object_type)} · {formatDate(row.event_time || row.collected_at)}{!row.event_time ? '（采集）' : ''}</small><Tags tags={p.tags.slice(0, 3)} onTag={onTag} /></div></div></td><td><button className="mih-browser-author" disabled={!row.account_id} onClick={() => onAccount(row)}><StoredImage key={p.avatar} url={p.avatar} avatar label={row.author_name || '账号头像'} /><span>{row.author_name || row.account_id || '身份缺失'}</span></button></td>{['likes', 'comments', 'shares', 'favorites', 'views'].map((key) => <td key={key} className="mih-browser-numeric">{formatNumber(p.metrics[key])}</td>)}<td><button className="qp-button qp-button--ghost" onClick={() => onDetail(row)}>详情</button></td></tr>
  })}</tbody></table></div>
}
function PublicationChart({ entries }) {
  const ref = useRef(null)
  const themeRevision = useThemeRevision()
  useEffect(() => {
    if (!ref.current || !entries.length) return
    const color = getComputedStyle(ref.current).getPropertyValue('--qp-text-3') || '#808b98'
    const chart = new Chart(ref.current, { type: 'bar', data: { labels: entries.map((e) => e.month), datasets: [{ label: '入库内容发布量', data: entries.map((e) => e.records), backgroundColor: getComputedStyle(ref.current).getPropertyValue('--qp-primary').trim() || '#14b8a6', borderRadius: 3, maxBarThickness: 36 }] }, options: { maintainAspectRatio: false, animation: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 200 }, plugins: { legend: { display: false } }, scales: { x: { ticks: { color }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color, precision: 0 }, grid: { color: '#88888820' } } } } })
    return () => chart.destroy()
  }, [entries, themeRevision])
  if (!entries.length) return <p className="mih-browser-note">没有已采集的发布时间，暂无法生成发布分布。</p>
  return <><div className="mih-browser-chart"><canvas ref={ref} role="img" aria-label="月发布分布，数值可在下方数据表查看" /></div><details className="mih-browser-note"><summary>查看发布数量表</summary><table><thead><tr><th>月份</th><th>入库内容发布量</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.month}><td>{entry.month}</td><td>{formatNumber(entry.records)}</td></tr>)}</tbody></table></details></>
}
export function AccountHero({ row, onBack, onTag, onRefresh }) {
  const p = recordPresentation(row)
  return <section className="qp-panel mih-browser-profile"><button className="qp-button qp-button--ghost" onClick={onBack}><ArrowLeft /> 返回账号大盘</button><button className="qp-button qp-button--ghost" onClick={onRefresh}>刷新账号资料</button><div className="mih-browser-profile-main"><StoredImage key={p.avatar} url={p.avatar} avatar label={row.name || row.author_name} /><div><h2>{row.name || row.author_name || row.account_id}</h2><p>{platformName(row.platform)} · ID：{row.account_id}</p><p>{p.bio || '暂未采集账号简介'}</p><Tags tags={p.tags.slice(0, 6)} onTag={onTag} /></div><div className="mih-browser-profile-facts"><Fact label="已采集粉丝数" value={p.followers} hint={row.profile?.collectedAt ? formatDate(row.profile.collectedAt) : '未采集'} /><Fact label="入库内容" value={row.contents} /><Fact label="入库记录" value={row.records} /></div></div></section>
}
export function AccountAnalysis({ token, filters, onUnauthorized, onTag, related = false }) {
  const { page, pageSize, sort, ...scope } = filters
  const key = JSON.stringify(scope)
  const load = useCallback(() => adminApi.dataBrowser(token, { ...JSON.parse(key), summary: 'true', page: 1 }), [token, key])
  const state = useRemoteData(load, onUnauthorized)
  if (state.loading) return <LoadingState label="正在统计账号内容画像，列表浏览不受影响" />
  if (state.error) return <ErrorState error={state.error} onRetry={state.refresh} />
  const data = state.data?.account_summary
  if (!data) return <EmptyState title="暂无账号统计" />
  if (related) return <section className="qp-panel mih-browser-panel"><h3>同标签账号候选</h3><p className="mih-browser-note">选择该账号内容中的来源标签，查看具有同标签记录的账号。这是可核查的关联线索，尚未进行 Agent 相似度判定。</p><Tags tags={(data.tags || []).map((e) => e.tag)} onTag={onTag} />{!data.tags?.length ? <p>当前范围没有来源标签，暂无法生成候选。</p> : null}</section>
  return <div className="mih-browser-analysis">
    <section className="qp-panel mih-browser-panel"><div className="mih-browser-section-title"><h3>数据概览</h3><span>当前筛选 · {formatDate(state.data?.evidence?.computedAt)} · 最多缓存 30 秒</span><button className="qp-button qp-button--ghost" onClick={state.refresh}>刷新统计</button></div><div className="mih-browser-metric-grid"><Fact label="入库内容" value={data.contents} /><Fact label="全部记录" value={data.records} /><Fact label="含发布时间的内容" value={data.datedRecords} />{['likes', 'comments', 'shares', 'favorites', 'views'].map((key) => <Fact key={key} label={`内容${metricLabels[key]}合计`} value={data.metrics?.[key]?.value} hint={`${formatNumber(data.metrics?.[key]?.coverage)} / ${formatNumber(data.contents)} 条有该指标`} />)}</div><p className="mih-browser-note">发布时间：{formatDate(data.firstPublishedAt)} — {formatDate(data.lastPublishedAt)}。互动合计来自当前内容快照；缺失值不作零处理。</p></section>
    <div className="mih-browser-analysis-columns"><section className="qp-panel mih-browser-panel"><div className="mih-browser-section-title"><h3>内容标签画像</h3><span>来源标签 · 按内容数统计</span></div>{data.tags?.length ? <div className="mih-browser-tag-bars">{data.tags.slice(0, 10).map((entry) => <button key={entry.tag} onClick={() => onTag(entry.tag)}><span>#{entry.tag}</span><progress max={Math.max(data.contents || 0, entry.records, 1)} value={entry.records} /><strong>{entry.records} 条</strong></button>)}</div> : <p className="mih-browser-note">没有已采集标签。需要接入有证据的主题分析后，才能补充推断标签。</p>}<p className="mih-browser-note">同一内容的重复标签只计一次，一条内容可以有多个标签。点击标签查看关联账号。</p></section><section className="qp-panel mih-browser-panel"><div className="mih-browser-section-title"><h3>内容构成</h3><span>对象 / 形态</span></div><div className="mih-browser-composition">{(data.types || []).map((entry) => <div key={`${entry.objectType}:${entry.contentType}`}><FileText /><span>{typeName(entry.objectType)} · {typeName(entry.contentType)}</span><strong>{formatNumber(entry.records)}</strong></div>)}</div></section></div>
    <section className="qp-panel mih-browser-panel"><div className="mih-browser-section-title"><h3>月发布分布</h3><span>最近 24 个有记录月份 · 北京时间</span></div><PublicationChart entries={data.timeline || []} /><p className="mih-browser-note">只反映 Hub 已采集内容的发布时间分布，不代表账号全部作品或互动增长。</p></section>
    <section className="mih-browser-analysis-note"><strong>Agent 画像尚未接入</strong><span>以上标签、构成和发布分布为来源数据统计。受众画像、情感分析、相似度评分与热点预测暂未提供。</span></section>
  </div>
}
function RelatedContents({ item, token, onUnauthorized, onDetail, onAccount, onTag }) {
  const tag = sourceTags(item)[0] || ''
  const load = useCallback(() => tag ? adminApi.dataBrowser(token, { view: 'contents', tag, pageSize: 6 }) : Promise.resolve({ items: [] }), [token, tag])
  const state = useRemoteData(load, onUnauthorized)
  const items = (state.data?.items || []).filter((row) => row.id !== item.id).slice(0, 5)
  return <section><h3>同标签相关内容</h3><p className="mih-browser-note">{tag ? `按来源标签 #${tag} 查找，最多展示 5 条；并非 Agent 相似度推荐。` : '尚未采集来源标签。'}</p>{state.loading ? <LoadingState /> : state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : items.length ? <ContentTable items={items} {...{ onDetail, onAccount, onTag }} /> : <EmptyState title="暂无相关内容" />}</section>
}
export function ContentDetail({ row, token, onUnauthorized, onClose, onAccount, onTag, onDetail }) {
  const [tab, setTab] = useState('overview')
  const [showMedia, setShowMedia] = useState(false)
  const [exportState, setExportState] = useState({ busy: false, error: null })
  const load = useCallback(() => adminApi.dataBrowser(token, { id: row.id }), [token, row.id])
  const state = useRemoteData(load, onUnauthorized)
  const item = state.data?.items?.[0] || row
  const p = recordPresentation(item)
  const media = item.stable_fields?.media || {}
  const exportDetail = async () => {
    if (exportState.busy) return
    setExportState({ busy: true, error: null })
    try { downloadBrowserFile(await adminApi.dataBrowserExport(token, { id: row.id, format: 'json', maxRows: 1 })); setExportState({ busy: false, error: null }) }
    catch (error) { if (error.status === 401) onUnauthorized?.(error); setExportState({ busy: false, error }) }
  }
  if (!state.loading && !state.error && !state.data?.items?.length) return <div className="mih-data-browser"><button className="qp-button qp-button--ghost" onClick={onClose}>返回检索结果</button><EmptyState title="这条记录已不可用" description="记录可能已删除，请返回刷新检索结果。" /></div>
  return <div className="mih-data-browser"><div><button className="qp-button qp-button--ghost" onClick={onClose}><ArrowLeft /> 返回检索结果</button></div>
    <section className="qp-panel mih-browser-detail-hero"><div className="mih-browser-detail-cover"><StoredImage key={p.cover} url={p.cover} label={item.title} /></div><div><span className="mih-browser-platform">{platformName(item.platform)} · {typeName(item.content_type || item.object_type)}</span><h2>{item.title || item.external_id || '内容详情'}</h2><p className="mih-browser-note">发布 {formatDate(item.event_time)} · 采集 {formatDate(item.collected_at)}</p><Tags tags={p.tags} onTag={onTag} /><div className="mih-browser-nav"><button className="qp-button qp-button--secondary" onClick={exportDetail} disabled={exportState.busy || state.loading || Boolean(state.error)}><DownloadSimple />{exportState.busy ? '正在导出…' : '导出此条 JSON'}</button>{safeMediaUrl(item.url) ? <a className="qp-button qp-button--ghost" href={item.url} target="_blank" rel="noreferrer">打开来源 <ArrowUpRight /></a> : null}</div></div><aside className="mih-browser-detail-author"><StoredImage key={p.avatar} url={p.avatar} avatar label={item.author_name} /><strong>{item.author_name || item.account_id || '账号身份缺失'}</strong><small>{platformName(item.platform)}</small><button className="qp-button qp-button--secondary" disabled={!item.account_id} onClick={() => onAccount(item)}>查看账号详情</button></aside></section>
    {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}{exportState.error ? <ErrorState error={exportState.error} /> : null}{state.loading ? <LoadingState label="正在读取完整内容" /> : null}
    <section className="qp-panel mih-browser-panel"><div className="mih-browser-tabs" role="group" aria-label="内容详情分区">{[['overview', '数据概览'], ['body', '正文与媒体'], ['related', '相关内容'], ['fields', '完整字段']].map(([key, label]) => <button key={key} aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
      {tab === 'overview' ? <><h3>内容互动数据</h3><div className="mih-browser-metric-grid">{Object.entries(metricLabels).filter(([k]) => k !== 'followers').map(([key, label]) => <Fact key={key} label={label} value={p.metrics[key]} hint="当前采集快照" />)}</div><h3>正文预览</h3><p className="mih-browser-body">{item.body?.slice(0, 500) || '尚未采集正文'}</p><button className="qp-button qp-button--ghost" onClick={() => setTab('body')}>阅读完整正文与媒体 →</button><div className="mih-browser-analysis-note"><strong>分析边界</strong><span>标签来自原始内容。评论数不等于已采集评论明细；目前没有互动时间序列、受众画像和情感分析结果。</span></div></> : null}
      {tab === 'body' && !state.loading && !state.error ? <><p className="mih-browser-body">{item.body || '尚未采集正文'}</p><button className="qp-button qp-button--secondary" onClick={() => setShowMedia((v) => !v)}>{showMedia ? '收起媒体' : '加载已采集媒体'}</button>{showMedia ? <div className="mih-browser-media-preview">{['images', 'videos', 'audio'].flatMap((kind) => (Array.isArray(media[kind]) ? media[kind] : []).map((entry, index) => { const url = safeMediaUrl(typeof entry === 'string' ? entry : entry?.url); return !url ? null : kind === 'images' ? <img key={`${kind}-${index}`} src={url} alt={`内容图片 ${index + 1}`} loading="lazy" referrerPolicy="no-referrer" /> : kind === 'videos' ? <video key={`${kind}-${index}`} src={url} controls preload="none" /> : <audio key={`${kind}-${index}`} src={url} controls preload="none" /> }))}</div> : null}<div className="mih-browser-nav">{['images', 'videos', 'audio'].flatMap((kind) => (Array.isArray(media[kind]) ? media[kind] : []).map((entry, index) => { const url = safeMediaUrl(typeof entry === 'string' ? entry : entry?.url); return url ? <a key={`${kind}-${index}`} href={url} target="_blank" rel="noreferrer">{typeName({ images: 'image', videos: 'video', audio: 'audio' }[kind])} {index + 1} ↗</a> : null }))}</div></> : null}
      {tab === 'related' ? <RelatedContents {...{ item, token, onUnauthorized, onDetail, onAccount, onTag }} /> : null}
      {tab === 'fields' && !state.loading && !state.error ? <Fields value={item} title="展开全部已入库字段" /> : null}
    </section>
  </div>
}
