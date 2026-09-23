import { useEffect, useRef, useState } from 'react'
import { ArrowSquareOut, Books, NewspaperClipping, MagnifyingGlass } from '@phosphor-icons/react'
import { publicDataApi, publicDocsHref } from './api.js'
import { useDemoApiKey, useDemoAccessSnapshot, DemoCredentialRecheck } from './demo-credentials.jsx'
import { newsAccessIssue } from './demo-access.js'
import { DropdownField, EmptyState, ErrorState, Field, LoadingState, Modal, PageHeading } from './components.jsx'
import { NewsSourceSelect } from './news-source-select.jsx'
import { NewsApiConsole } from './news-api-console.jsx'
import './news-discovery.css'

const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未提供'
const EXTENT = { full_text: '已存全文', summary: '仅摘要', reference: '文章线索', unknown: '正文完整性未知' }

export function NewsDiscoveryPage({ session }) {
  const [key] = useDemoApiKey()
  const access = useDemoAccessSnapshot()
  const accessIssue = newsAccessIssue(access)
  const canSelectKey = session?.kind === 'admin-token' || session?.memberships?.some(item => item.capabilities?.includes('apikey.write'))
  const [catalog, setCatalog] = useState(null)
  const [catalogError, setCatalogError] = useState(null)
  const [tab, setTab] = useState('list')
  const [query, setQuery] = useState('')
  const [entries, setEntries] = useState([])
  const [sourceOptions, setSourceOptions] = useState(null), [sourcesLoading, setSourcesLoading] = useState(false), [sourcesError, setSourcesError] = useState(null)
  const sourceRequest = useRef(null), sourceKey = useRef(null)
  const [sourceCode, setSourceCode] = useState('')
  const [category, setCategory] = useState('')
  const [binding, setBinding] = useState('all')
  const [timeField, setTimeField] = useState('firstSeenAt')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [pageSize, setPageSize] = useState('20')
  const [rows, setRows] = useState([])
  const [result, setResult] = useState(null)
  const [applied, setApplied] = useState(null)
  const [facets, setFacets] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [detail, setDetail] = useState(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [detailError, setDetailError] = useState(null)
  const active = useRef(true), locked = useRef(false), detailLocked = useRef(false)
  const request = useRef(null), facetRequest = useRef(null), detailRequests = useRef(new Map())
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    sourceRequest.current?.abort(); sourceRequest.current = null; setSourcesLoading(false)
    if (!key) return undefined
    const controller = new AbortController()
    publicDataApi.newsSources(key, controller.signal).then(value => { setCatalog(value.payload.data); setCatalogError(null) })
      .catch(error => { if (!controller.signal.aborted) setCatalogError(error) })
    return () => { controller.abort(); sourceRequest.current?.abort(); sourceRequest.current = null }
  }, [key])
  async function loadSourceOptions(force = false) {
    if (!key || sourceRequest.current || (!force && sourceKey.current === key && sourceOptions)) return
    const controller = new AbortController()
    sourceRequest.current = controller; setSourcesLoading(true); setSourcesError(null)
    try {
      const response = await publicDataApi.newsSourceOptions(key, controller.signal)
      if (!controller.signal.aborted) { setSourceOptions(response.payload.data); sourceKey.current = key }
    } catch (error) { if (!controller.signal.aborted) setSourcesError(error) }
    finally { if (sourceRequest.current === controller) { sourceRequest.current = null; setSourcesLoading(false) } }
  }
  const sourceNames = Object.fromEntries([...(catalog?.items || []).map(item => [item.id, item.name]), ...(sourceOptions?.items || []).map(item => [item.key, item.value])])
  const body = { query, catalogEntryIds: entries, sourceCodes: sourceCode ? [sourceCode] : [],
    categories: category ? [category] : [], binding, timeField, pageSize: Number(pageSize),
    from: from ? new Date(from).toISOString() : null, to: to ? new Date(to).toISOString() : null }
  async function search(append = false) {
    if (!key || locked.current) return
    const input = append ? { ...applied, cursor: result?.payload.data.pageInfo.nextCursor } : body
    const signature = JSON.stringify(input)
    if (!request.current || request.current.signature !== signature || request.current.ok) request.current = { signature, key: crypto.randomUUID(), ok: false }
    locked.current = true; setBusy(true); setError(null)
    try {
      const response = await publicDataApi.newsSearch(key, input, request.current.key)
      if (!active.current) return
      request.current.ok = true; setResult(response); setApplied(append ? applied : body)
      if (!append) setFacets(null)
      setRows(previous => append ? [...new Map([...previous, ...response.payload.data.items].map(row => [row.id, row])).values()] : response.payload.data.items)
    } catch (error) { if (active.current) setError(error) }
    finally { locked.current = false; if (active.current) setBusy(false) }
  }
  async function statistics() {
    if (!applied || locked.current || !key) return
    const signature = JSON.stringify(applied)
    if (!facetRequest.current || facetRequest.current.signature !== signature || facetRequest.current.ok) facetRequest.current = { signature, key: crypto.randomUUID(), ok: false }
    locked.current = true; setBusy(true); setError(null)
    try {
      const response = await publicDataApi.newsFacets(key, applied, facetRequest.current.key)
      facetRequest.current.ok = true
      if (active.current) setFacets(response.payload.data)
    }
    catch (error) { if (active.current) setError(error) }
    finally { locked.current = false; if (active.current) setBusy(false) }
  }
  async function openArticle(row) {
    if (!key || detailLocked.current) return
    setDetail(row); setDetailError(null)
    let saved = detailRequests.current.get(row.id)
    if (!saved) { saved = { key: crypto.randomUUID() }; detailRequests.current.set(row.id, saved) }
    if (saved.data) { setDetail(saved.data); return }
    detailLocked.current = true; setDetailBusy(true)
    try {
      const response = await publicDataApi.newsArticle(key, row.id, saved.key)
      saved.data = response.payload.data.article
      if (active.current) setDetail(saved.data)
    } catch (error) { if (active.current) setDetailError(error) }
    finally { detailLocked.current = false; if (active.current) setDetailBusy(false) }
  }
  return <div className="mih-news">
    <PageHeading eyebrow="DATA PRODUCTS / NEWS" title="新闻发现" description="从已收录新闻出发，按数据源目录、来源和类别发现值得阅读的信息。">
      <a className="qp-button qp-button--outline" href={publicDocsHref('/docs/news-discovery')}>接口文档 <ArrowSquareOut size={16} /></a>
      {session?.kind === 'admin-token' ? <a className="qp-button qp-button--outline" href="#/agent/catalog-classifier">数据归类</a> : null}
    </PageHeading>
    <div className="mih-news-tabs" role="tablist" aria-label="新闻发现视图">
      {[['list', '新闻列表'], ['api', '接口调试']].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={`qp-button ${tab === id ? 'qp-button--primary' : 'qp-button--ghost'}`} onClick={() => setTab(id)}>{label}</button>)}
    </div>
    {!key || accessIssue ? <div className="mih-inline-warning" role="status"><div>
      <p>{!key ? (canSelectKey
        ? '尚未取得调用 Key。请在页面顶部“当前调用身份”选择可用的 Live Key；有多把 Key 时需要手动选择。若身份加载失败，请查看上方原因或重新检查。'
        : '当前账号没有使用租户调用 Key 的权限。请由租户所有者或管理员操作，或联系管理员核对你的租户成员角色。') : accessIssue}</p>
      <p>新闻发现按数据类别授权，没有单独的“新闻发现”能力开关；数据源目录授权也不能代替新闻数据授权。</p>
      <DemoCredentialRecheck />
    </div></div> : null}
    <form className="qp-panel mih-news-filters" onSubmit={event => { event.preventDefault(); if (tab === 'list') void search() }}>
      <Field label="关键词" hint="标题与正文的字面匹配；留空浏览新闻"><input className="qp-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索新闻标题或正文" maxLength={300} /></Field>
      <NewsSourceSelect items={sourceOptions?.items || []} values={entries} names={sourceNames} onChange={setEntries} onLoad={loadSourceOptions}
        loading={sourcesLoading} error={sourcesError} disabled={!key} />
      <DropdownField label="数据类别" value={category} onChange={setCategory} options={[{ value: '', label: '全部已授权类别' }, ...(catalog?.categories || []).map(item => ({ value: item.id, label: item.label }))]} />
      <Field label="来源代码（可选）" hint="如 sina、huanqiu；可查尚未绑定目录的来源"><input className="qp-input" value={sourceCode} onChange={event => setSourceCode(event.target.value)} placeholder="全部来源" maxLength={96} /></Field>
      <DropdownField label="目录归类" value={binding} onChange={setBinding} options={[{ value: 'all', label: '全部记录' }, { value: 'mapped', label: '已绑定目录' }, { value: 'unmapped', label: '待归类' }]} />
      <DropdownField label="时间依据" value={timeField} onChange={setTimeField} options={[{ value: 'firstSeenAt', label: '首次收录时间' }, { value: 'publishedAt', label: '原文发布时间' }]} />
      <Field label="开始时间"><input className="qp-input" type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></Field>
      <Field label="结束时间（不含）"><input className="qp-input" type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></Field>
      <DropdownField label="每页条数" value={pageSize} onChange={setPageSize} options={[10, 20, 50, 100].map(value => ({ value: String(value), label: `${value} 条` }))} />
      {tab === 'list' ? <div className="mih-news-actions"><button className="qp-button qp-button--primary" disabled={!key || busy}><MagnifyingGlass size={17} />{busy ? '正在查询…' : '查询新闻'}</button>
        <button type="button" className="qp-button qp-button--outline" disabled={!applied || busy || !key} onClick={() => void statistics()}>查看来源统计</button></div> : <p className="mih-news-hint">这些条件用于下方调试器的搜索与统计；请在调试器选择接口并显式发送。</p>}
      <p className="mih-news-hint">查询读取已收录内容，按当前 Key 的授权和套餐计量。按发布时间筛选时，不包含无精确发布时间的记录。</p>
    </form>
    {catalogError ? <ErrorState error={catalogError} /> : null}
    {error ? <ErrorState error={error} /> : null}
    <div className="mih-news-debug-wrap" hidden={tab !== 'api'}><NewsApiConsole apiKey={key} filters={body} sourceNames={sourceNames}
      onSourceOptions={data => { setSourceOptions(data); setSourcesError(null); sourceKey.current = key }} onCatalog={data => { setCatalog(data); setCatalogError(null) }}
      onEntries={setEntries} onCategory={setCategory} /></div>
    {tab === 'list' ? <>
      {facets ? <section className="qp-panel mih-news-facets"><h2><Books size={19} /> 来源分布</h2><p>当前条件下最新 {facets.sampledRecords} 条记录{facets.truncated ? ' · 已达 5,000 条统计上限，不代表全库分布' : ''} · {dateText(facets.asOf)}</p><div>{facets.sources.map((item, index) => <button key={item.catalogEntryId || item.code || index} className="qp-button qp-button--outline qp-button--sm" onClick={() => { setEntries(item.catalogEntryId ? [item.catalogEntryId] : []); setSourceCode(item.catalogEntryId ? '' : item.code || ''); if (!item.catalogEntryId && !item.code) setBinding('unmapped') }}>{item.name} <strong>{item.count}</strong></button>)}</div><small>点击填入筛选条件，再点查询。统计不合并转载和重复采集。</small></section> : null}
      <div className="mih-news-list-heading"><h2><NewspaperClipping size={22} /> 新闻列表</h2><span>{result ? `已加载 ${rows.length} 条` : '查询后展示已收录新闻'}</span></div>
      {rows.length ? <div className="mih-news-list">{rows.map(row => <article className="qp-panel mih-news-card" key={row.id}>
        <div className="mih-news-card-meta"><span>{row.source.name}</span><span>{row.category}</span><span>{row.source.bindingStatus === 'mapped' ? '目录已绑定' : '待归类'}</span><span>{EXTENT[row.contentExtent]}</span></div>
        <h3><button onClick={() => void openArticle(row)}>{row.title || '无标题新闻'}</button></h3><p>{row.summary || row.excerpt || '未提供摘要或正文'}</p>
        <footer><span>发布 {row.publishedAt ? dateText(row.publishedAt) : row.publishedDate || '时间未提供'}</span><span>收录 {dateText(row.firstSeenAt)}</span>{row.author?.name ? <span>{row.author.name}</span> : null}<button className="qp-button qp-button--ghost qp-button--sm" onClick={() => void openArticle(row)}>阅读已存内容</button></footer>
      </article>)}</div> : result ? <EmptyState title="没有匹配的新闻" description="可调整来源、时间或类别；待归类新闻也保留在全部记录中。" /> : <EmptyState title="从一个来源，发现更多新闻" description="按目录选择来源，或直接输入关键词。留空可浏览全部已授权类别的新闻。" />}
      {result?.payload.data.pageInfo.hasMore ? <button className="qp-button qp-button--outline" disabled={busy || !key} onClick={() => void search(true)}>加载下一页</button> : result ? <p className="mih-news-hint">当前查询已无后续记录。</p> : null}
    </> : null}
    {detail ? <Modal title={detail.title || '新闻详情'} size="large" onClose={() => setDetail(null)} busy={detailBusy}>
      <div className="mih-news-detail"><p>{detail.source.name} · {EXTENT[detail.contentExtent]} · {detail.author?.name || '作者未提供'}</p><p>原文发布：{detail.publishedAt ? dateText(detail.publishedAt) : detail.publishedDate || '未提供'} · 首次收录：{dateText(detail.firstSeenAt)}</p>
        {detailBusy ? <LoadingState label="正在读取已存文章" /> : null}{detailError ? <><ErrorState error={detailError} /><button className="qp-button qp-button--outline" onClick={() => void openArticle(detail)}>重试同一详情请求</button></> : null}
        {detail.summary ? <blockquote>{detail.summary}</blockquote> : null}<div className="mih-news-body">{detail.body || (!detailBusy && !detailError ? '没有已存正文。' : '')}</div>
        {detail.topics?.length ? <p>来源主题：{detail.topics.join(' · ')}</p> : null}
        {detail.url ? <a className="qp-button qp-button--outline" target="_blank" rel="noreferrer" href={detail.url}>查看原文 <ArrowSquareOut size={16} /></a> : null}
      </div></Modal> : null}
  </div>
}
