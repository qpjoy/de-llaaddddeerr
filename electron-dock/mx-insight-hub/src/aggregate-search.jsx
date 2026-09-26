import { useEffect, useId, useRef, useState } from 'react'
import { MagnifyingGlass, ArrowClockwise, ArrowDown, CaretDown, Funnel, Globe, Stack, ArrowUpRight } from '@phosphor-icons/react'
import { publicDataApi, publicDocsHref } from './api.js'
import { DropdownField, EmptyState, ErrorState, LoadingState, PageHeading, formatDate } from './components.jsx'
import { useDemoApiKey, useDemoIdentity } from './demo-credentials.jsx'
import './aggregate-search.css'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'

const types = [['post', '帖子 / 笔记'], ['article', '文章'], ['message', '消息'], ['chat', '会话'], ['comment', '评论'], ['product', '商品'], ['account', '账号'], ['user', '用户资料'], ['profile', '画像'], ['saved_record', '分类记录'], ['commerce_capture', '电商采集记录'], ['opinion_item', '舆情条目']]
const initial = { query: '', mode: 'refresh', platforms: [], objectTypes: [], tags: '', from: '', to: '', pageSize: 20 }
const statuses = { ok: '成功', empty: '本批无结果', partial: '部分返回', unsupported: '无匹配实时接口', unavailable: '暂不可用', not_authorized: '未获操作授权', unknown: '结果待核实', not_started: '本轮调度超时，未发起调用' }
const toggle = (values, key) => values.includes(key) ? values.filter(value => value !== key) : [...values, key].sort()
const safeUrl = value => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null
function requestBody(draft, sources) {
  return { query: draft.query.trim(), mode: draft.mode,
    platforms: draft.platforms.length ? draft.platforms : draft.mode === 'refresh' ? sources.filter(source => source.refresh).map(source => source.platform).sort() : [],
    objectTypes: draft.objectTypes, pageSize: draft.pageSize, filters: draft.mode === 'stored' ? {
      tags: draft.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
      ...(draft.from ? { from: `${draft.from}T00:00:00+08:00` } : {}),
      ...(draft.to ? { to: `${draft.to}T23:59:59.999+08:00` } : {}),
    } : {},
  }
}

function MultiFilter({ label, allLabel, options, values, onChange, disabled, icon: Icon }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const root = useRef(null), trigger = useRef(null), input = useRef(null)
  const id = useId()
  useEffect(() => {
    if (!open) return
    input.current?.focus()
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open])
  const selection = !values.length ? allLabel : values.length === 1 ? options.find(option => option.value === values[0])?.label || values[0] : `已选 ${values.length} 个${label}`
  const visible = options.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <div ref={root} className={`qp-dropdown mih-aggregate-select ${open ? 'is-open' : ''}`} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
  }} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); trigger.current?.focus() } }}>
    <button ref={trigger} type="button" className="qp-dropdown__trigger" disabled={disabled} aria-expanded={open} aria-controls={id} aria-label={`${label}：${selection}`} onClick={() => { setQuery(''); setOpen(value => !value) }}>
      <Icon /><span className="qp-dropdown__value">{selection}</span><CaretDown className="qp-dropdown__chevron" />
    </button>
    {open ? <div className="qp-dropdown__menu mih-aggregate-select-menu" id={id} role="group" aria-label={`选择${label}`}>
      <label className="qp-dropdown__search"><MagnifyingGlass /><input ref={input} aria-label={`查找${label}`} placeholder={`查找${label}`} value={query} onChange={event => setQuery(event.target.value)} /></label>
      <button type="button" className={`mih-aggregate-all ${!values.length ? 'is-selected' : ''}`} aria-pressed={!values.length} onClick={() => onChange([])}>{allLabel}<small>{options.length}</small></button>
      <div className="mih-aggregate-option-list qp-scrollbar">{visible.map(option => <label className={`qp-dropdown__option ${values.includes(option.value) ? 'is-selected' : ''}`} key={option.value}>
        <input type="checkbox" checked={values.includes(option.value)} onChange={() => onChange(toggle(values, option.value))} /><span>{option.label}</span>
      </label>)}{!visible.length ? <p className="qp-muted">没有匹配的{label}</p> : null}</div>
      <footer><small>选择一个或多个；清空恢复全部</small><button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => { setOpen(false); trigger.current?.focus() }}>完成</button></footer>
    </div> : null}
  </div>
}

// Identity-scoped memory survives navigation and credential renewal. Each page
// keeps its exact body/key; only explicit refresh creates another search round.
export function DataSearchPage({ aggregateSession, session }) {
  return <div className="mih-aggregate"><PageHeading title="数据搜索" description="用关键词、平台和条目类型搜索 Hub 数据；同一 API 可供下游产品调用。" />
    <AggregateSearchPanel session={aggregateSession} showCatalog={session?.kind === 'admin-token'} />
  </div>
}

export default function AggregateSearchPanel({ session, showCatalog = true }) {
  const [apiKey] = useDemoApiKey()
  const identity = useDemoIdentity()
  if (!session.current || session.current.identity !== identity) session.current = { identity, draft: initial, rounds: new Map(), round: null }
  const cell = session.current
  const [draft, setDraft] = useState(cell.draft)
  const [sources, setSources] = useState(null)
  const [sourceError, setSourceError] = useState(null)
  const [revision, setRevision] = useState(0)
  const [quote, setQuote] = useState(null)
  const [quoteError, setQuoteError] = useState(null)
  const [quoting, setQuoting] = useState(false)
  const [, render] = useState(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const update = () => { if (alive.current && session.current === cell) render(value => value + 1) }
  useEffect(() => {
    let active = true
    setSources(null); setSourceError(null)
    if (apiKey) publicDataApi.aggregateSources(apiKey).then(result => {
      if (active) setSources(result.payload.data.sources)
    }).catch(error => { if (active) setSourceError(error) })
    return () => { active = false }
  }, [apiKey, revision])
  useEffect(() => { setDraft(cell.draft); cell.round?.active?.promise?.then(update, update) }, [cell])
  const change = patch => setDraft(current => {
    const next = { ...current, ...patch }; cell.draft = next; return next
  })
  const live = draft.mode === 'refresh'
  const available = (sources || []).filter(source => !live || source.refresh)
  const selected = available.filter(source => !draft.platforms.length || draft.platforms.includes(source.platform))
  const availableTypes = new Set(selected.flatMap(source => live ? source.routes.map(route => route.objectType) : source.objectTypes))
  const liveCount = selected.flatMap(source => source.routes).filter(route => !draft.objectTypes.length || draft.objectTypes.includes(route.objectType)).length
  const round = cell.round, run = round?.active, busy = run?.busy || false
  const restartRequired = ['invalid_cursor', 'search_cursor_expired', 'aggregate_continuation_unavailable'].includes(run?.error?.code)
  const pages = round?.pages || []
  const pendingSources = Object.values(run?.progress?.sources || {})
  const provisional = !run?.result && run?.progress ? { mode: run.body.mode, query: run.body.query,
    sources: pendingSources.map(row => row.source), pageInfo: {}, provisional: true } : null
  const result = provisional || pages.at(-1)?.result?.payload?.data
  const items = [...new Map([...pages.flatMap(page => page.result.payload.data.items),
    ...(provisional ? pendingSources.flatMap(row => row.items) : [])].map(item => [item.id, item])).values()]
  const body = requestBody(draft, sources || [])
  const quoteScope = JSON.stringify(body)
  const currentQuote = quote?.scope === quoteScope && quote.identity === identity ? quote.data : null
  async function preview(input = body) {
    if (quoting || !apiKey) return
    setQuoting(true); setQuoteError(null)
    try {
      const value = await publicDataApi.aggregatePreview(apiKey, input)
      if (alive.current && session.current === cell) setQuote({ scope: quoteScope, identity, query: input.query, continuation: Boolean(input.cursor), data: value.payload.data })
    } catch (error) { if (session.current === cell) setQuoteError(error) }
    finally { setQuoting(false) }
  }
  const platformLabel = platform => sources?.find(source => source.platform === platform)?.label || platform
  const continuing = result?.sources.filter(source => source.hasMore).length || 0
  const failed = result?.sources.filter(source => !['ok', 'empty'].includes(source.status)).length || 0
  const requestExample = `POST /api/v1/data/aggregate/search\nAuthorization: Bearer <HUB_API_KEY>\nIdempotency-Key: <新查询或下一页使用新标识，重试保持不变>\n\n${JSON.stringify(body, null, 2)}`

  async function search(input, { fresh = false, targetRound } = {}) {
    if (cell.round?.active?.busy || !apiKey) return
    setQuote(null); setQuoteError(null)
    const fingerprint = JSON.stringify(input)
    let nextRound = targetRound || (!fresh && cell.rounds.get(fingerprint))
    if (!nextRound) {
      nextRound = { body: input, pages: [], operations: new Map(), active: null }
      cell.rounds.set(fingerprint, nextRound)
    }
    let operation = nextRound.operations.get(fingerprint)
    if (!operation) {
      operation = { body: input, idempotencyKey: crypto.randomUUID(), busy: false, result: null, error: null }
      nextRound.operations.set(fingerprint, operation)
    }
    cell.round = nextRound; nextRound.active = operation
    operation.busy = true; operation.error = null
    // No automatic retries or aborts: navigation must not obscure paid outcomes.
    operation.promise = publicDataApi.aggregateSearchStream(apiKey, operation.body, operation.idempotencyKey, (event, payload) => {
      if (event === 'search.started') operation.progress = { ...payload, sources: {}, running: {} }
      if (event === 'source.started' && operation.progress) operation.progress.running[payload.id] = payload.label
      if (event === 'source.completed' && operation.progress) {
        operation.progress.sources[payload.source.id] = payload
        delete operation.progress.running[payload.source.id]
      }
      update()
    })
      .then(value => { operation.result = value; if (!nextRound.pages.includes(operation)) nextRound.pages.push(operation) })
      .catch(error => { operation.error = error })
      .finally(() => { operation.busy = false; update() })
    update()
  }

  return <div className="mih-aggregate">
    <section className="qp-panel qp-panel--active mih-aggregate-search" aria-label="聚合搜索条件">
      <div className="mih-aggregate-heading">
        <h2>聚合数据搜索</h2>
        <div className="qp-segmented" role="group" aria-label="数据范围">
          {[['refresh', '实时搜索'], ['stored', '已收录数据']].map(([value, label]) => <button className={`qp-segmented__item ${draft.mode === value ? 'is-active' : ''}`} type="button" key={value} aria-pressed={draft.mode === value} disabled={busy} onClick={() => change({ mode: value, platforms: [], objectTypes: [] })}>{label}</button>)}
        </div>
      </div>
      <form onSubmit={event => { event.preventDefault(); search(body) }}>
        <div className="mih-aggregate-query">
          <label className="qp-input-group"><MagnifyingGlass className="qp-input-group__prefix" /><input className="qp-input" aria-label="关键词" required maxLength={200} value={draft.query} disabled={busy} onChange={event => change({ query: event.target.value })} placeholder={live ? "输入关键词，即可搜索全部实时平台" : "输入关键词，查找最新入库与历史数据"} /></label>
          <button className="qp-button qp-button--primary" disabled={busy || !apiKey || !sources?.length || (live && !liveCount)}><MagnifyingGlass />{busy ? '正在搜索…' : live ? '搜最新' : '搜索已收录'}</button>
        </div>
        <div className="mih-aggregate-toolbar">
          <MultiFilter label="平台" allLabel={live ? '全部实时平台' : '全部已收录来源'} icon={Globe} disabled={busy || !sources} options={available.map(source => ({ value: source.platform, label: source.label }))} values={draft.platforms} onChange={value => change({ platforms: value, objectTypes: [] })} />
          <MultiFilter label="类型" allLabel="全部条目类型" icon={Stack} disabled={busy || !sources} options={types.filter(([value]) => availableTypes.has(value)).map(([value, label]) => ({ value, label }))} values={draft.objectTypes} onChange={value => change({ objectTypes: value })} />
          {!live ? <details className="mih-aggregate-history-filters"><summary><Funnel />标签与日期<CaretDown /></summary><div className="mih-aggregate-filters">
            <label className="qp-field">标签（同时包含）<input className="qp-input" disabled={busy} value={draft.tags} onChange={event => change({ tags: event.target.value })} placeholder="多个标签以逗号分隔" /></label>
            <label className="qp-field">开始日期<input className="qp-input" type="date" disabled={busy} value={draft.from} onChange={event => change({ from: event.target.value })} /></label>
            <label className="qp-field">结束日期<input className="qp-input" type="date" min={draft.from || undefined} disabled={busy} value={draft.to} onChange={event => change({ to: event.target.value })} /></label>
            <DropdownField label="每批条数" disabled={busy} value={String(draft.pageSize)} onChange={value => change({ pageSize: Number(value) })} options={[10, 20, 50].map(value => ({ value: String(value), label: `${value} 条` }))} />
          </div></details> : null}
          {(draft.platforms.length || draft.objectTypes.length || !live && (draft.tags || draft.from || draft.to)) ? <button type="button" className="qp-button qp-button--ghost qp-button--sm" disabled={busy} onClick={() => change({ platforms: [], objectTypes: [], tags: '', from: '', to: '' })}>重置筛选</button> : null}
          <a className="mih-aggregate-catalog" href={publicDocsHref('/docs/aggregate-search')}>接口文档 <ArrowUpRight /></a>
          {showCatalog ? <a href="#/source-catalog">数据源目录 <ArrowUpRight /></a> : null}
        </div>
        <p className="mih-aggregate-hint">{live ? `搜索 ${liveCount} 个实时平台，各取一页；加载更多继续取后续页，按当前套餐计费。` : '搜索最新入库和历史数据，不触发上游采集；新鲜度取决于清洗与索引进度。日期按北京时间筛选发布时间。'}</p>
        <button type="button" className="qp-button qp-button--outline qp-button--sm" disabled={busy || quoting || !apiKey || !draft.query.trim()} onClick={() => preview()}>{quoting ? '读取价格…' : '预览查询范围与费用'}</button>
        {quoteError ? <ErrorState error={quoteError} /> : null}
        {currentQuote ? <div className="qp-panel" role="status"><strong>“{quote.query}” · {quote.continuation ? '下一批' : '第一批'} {currentQuote.items.length} 个查询 · 预计 {currentQuote.currency ? `${currentQuote.currency} ${(currentQuote.estimatedMinor / 100).toFixed(2)}` : '不扣费'}</strong><p>按当前套餐 v{currentQuote.planVersion || '—'} 估算；预览不采集、不冻结余额。实际价格与可用性在执行时重新检查，估算不是锁价或费用上限。{currentQuote.mode === 'refresh' ? '聚合父请求不另收费。' : ''}</p>
          <details><summary>逐源价格与状态</summary><ul>{currentQuote.items.map(row => <li key={row.id}>{row.label} · {row.pages} 页 · {({ billing_disabled: '当前未扣费', unpriced_free: '租户默认免费', tenant_default: `租户默认价 ${row.currency} ${(row.unitPriceMinor / 100).toFixed(2)}`, explicit_free: '明确免费', priced: `${row.currency} ${(row.unitPriceMinor / 100).toFixed(2)}` })[row.priceStatus]} · {({ ready: '服务就绪', unavailable: '服务未就绪', not_checked: '执行时检查可用性' })[row.readiness]}</li>)}</ul></details>
        </div> : null}
        {!live && (draft.tags || draft.from || draft.to) ? <p className="mih-aggregate-hint">已设筛选：{[draft.tags && `标签 ${draft.tags}`, draft.from && `从 ${draft.from}`, draft.to && `至 ${draft.to}`].filter(Boolean).join(' · ')}</p> : null}
      </form>
      {!apiKey ? <p role="status">请选择上方调用身份，查看已授权的数据来源。</p> : sourceError ? <ErrorState error={sourceError} onRetry={() => setRevision(value => value + 1)} /> : !sources ? <LoadingState /> : !available.length ? <p role="status">当前身份没有{live ? '支持实时搜索的平台，可切换「已收录数据」查看入库来源。' : '已授权的数据来源。'}</p> : null}
    </section>
    {sources?.length ? <details className="qp-panel mih-aggregate-api"><summary>当前身份的搜索范围 · {sources.length} 个平台或分类<CaretDown /></summary>
      <p>已收录数据包含最新入库内容和历史存量。实时搜索按已实现、已授权的操作调用，执行时仍检查服务状态；目录登记不代表可以实时搜索。</p>
      <div className="mih-aggregate-sources">{sources.map(source => <div key={source.platform}><strong>{source.label}</strong><span>{source.refresh ? '支持实时与已收录检索' : '仅已收录检索'}</span><span>{source.objectTypes.map(type => types.find(([value]) => value === type)?.[1] || type).join('、')}</span></div>)}</div>
      <p>全平台表示当前身份可搜索的范围，不代表全网覆盖。没有返回内容与来源失败会分开显示；清洗尚未入库、未授权或未接入的数据不会出现在结果中。</p>
    </details> : null}
    {run?.error ? <section className="qp-panel mih-aggregate-error"><ErrorState error={run.error} /><p>{restartRequired ? '分页位置已失效或与查询条件不符，已加载内容仍保留。重新搜索会从第一页开始，并按当前套餐计量。' : '原请求保留，重试使用相同参数与请求标识。'}<code>{run.idempotencyKey}</code></p>{restartRequired ? <button className="qp-button qp-button--outline" disabled={busy || !apiKey} onClick={() => search(round.body, { fresh: true })}>重新搜索（从第一页）</button> : <button className="qp-button qp-button--outline" disabled={busy || !apiKey} onClick={() => search(run.body, { targetRound: round })}>重试原请求</button>}</section> : null}
    {run?.progress && (busy || run.error) ? <section className="qp-panel mih-aggregate-api" role="status"><strong>{busy ? '各来源陆续返回' : '连接中断，保留已收到的来源'} · {pendingSources.length} / {run.progress.totalSources} 个来源完成</strong><p>{Object.values(run.progress.running).length ? `等待：${Object.values(run.progress.running).join('、')}` : '正在汇总结果'}。已展示结果仅代表已完成来源；最终完成后才生成本批分页游标。</p><p>并发 {run.progress.execution?.concurrency}；{(run.progress.execution?.dispatchBudgetMs || 120000) / 1000} 秒后停止发起新的来源调用，已发出的请求按各自超时收尾。断开页面不会撤销已发出的调用。</p></section> : null}
    {result ? <section className="mih-aggregate-delivery" aria-label="搜索结果" aria-busy={busy}>
      <div className="mih-aggregate-heading mih-aggregate-result-heading">
        <div><h2>已展示 {items.length} 条 <span className="qp-tag qp-tag--primary">{result.mode === 'refresh' ? '本轮实时' : '已收录数据'}</span></h2><p>“{result.query}” · 已加载 {pages.length} 批 · {result.mode === 'refresh' ? '各平台独立分页，无统一总页数' : '按发布时间排序，跨平台统一分页；未统计总量'}</p></div>
        <button className="qp-button qp-button--outline qp-button--sm" disabled={busy || !apiKey} onClick={() => search(round.body, { fresh: true })}><ArrowClockwise />{result.mode === 'refresh' ? '刷新最新' : '刷新已收录'}</button>
      </div>
      <details className="qp-panel mih-aggregate-progress"><summary><span className={`mih-aggregate-dot ${failed ? 'is-partial' : ''}`} />{result.sources.length} 个来源{failed ? ` · ${failed} 个未完整返回` : ' · 本批请求已完成'}{continuing ? ` · ${continuing} 个可继续加载` : ''}<span>查看逐源状态</span><CaretDown /></summary>
        <div className="mih-aggregate-sources">{result.sources.map((source, i) => <div key={`${source.id || source.platform}:${i}`}><strong>{source.label || platformLabel(source.platform)}</strong><span>{statuses[source.status] || source.status}{source.carried ? ' · 本批未再请求' : source.returnedCount != null ? ` · ${source.returnedCount} 条` : ''}{source.hasMore ? ' · 可继续' : source.continuationUnavailable ? ' · 未提供可用后续页' : ''}</span>{source.requestId ? <code>{source.requestId}</code> : null}</div>)}</div>
      </details>
      {result.search?.degraded ? <p role="status">搜索索引暂不可用，已使用数据库检索。</p> : null}
      {!items.length ? <EmptyState title="本次没有返回内容" description="可更换关键词或平台；来源失败与无结果请查看逐源状态。" /> : <div className="mih-aggregate-results">{items.map(item => <article className="qp-card" key={item.id}>
        <div className="mih-aggregate-heading"><span className="qp-tag">{platformLabel(item.platform)}</span><small>{types.find(([value]) => value === item.objectType)?.[1] || item.objectType} · {formatDate(item.eventTime || item.collectedAt)}</small></div>
        <h3>{safeUrl(item.url) ? <a href={safeUrl(item.url)} target="_blank" rel="noreferrer">{item.title || '查看内容'}<ArrowUpRight /></a> : item.title || '未提供标题'}</h3>
        {item.text ? <p>{item.text}</p> : <p className="qp-muted">此条目未提供正文</p>}
        <footer><span>{item.author?.name || '未提供作者'}</span><details><summary>展开内容</summary><div>{item.text || '未提供正文'}<small>采集时间：{formatDate(item.collectedAt)}</small></div></details></footer>
      </article>)}</div>}
      {!result.provisional ? <div className="mih-aggregate-more" aria-live="polite">
        {result.pageInfo.nextCursor ? <><button className="qp-button qp-button--outline" disabled={busy || quoting || restartRequired || !apiKey} onClick={() => preview({ ...round.body, cursor: result.pageInfo.nextCursor })}>预览下一批费用</button><button className="qp-button qp-button--outline" disabled={busy || restartRequired || !apiKey} onClick={() => search({ ...round.body, cursor: result.pageInfo.nextCursor }, { targetRound: round })}><ArrowDown />{busy ? '正在加载…' : result.mode === 'refresh' ? '加载更多实时结果' : '加载更多历史数据'}</button></> : <strong>本轮暂无可继续加载的结果</strong>}
        <p>{result.mode === 'refresh' ? '加载更多保留本轮结果并续查下一页；刷新最新开启新一轮实时搜索。' : '继续浏览已收录数据，不发起实时采集。'}{failed ? ' 部分来源未完整返回，详情见逐源状态。' : ''}</p>
      </div> : null}
    </section> : !busy ? <section className="qp-panel mih-aggregate-empty"><MagnifyingGlass /><div><h3>输入关键词，即可开始</h3><p>默认搜索全部可用实时平台，也可按平台或条目类型缩小范围。</p></div></section> : <LoadingState />}
    <AdminExecutionEvidence requestId={pages.at(-1)?.result?.payload?.requestId} aggregate />
    <details className="qp-panel mih-aggregate-api"><summary>API 调用 · 实时与已收录数据<CaretDown /></summary><p>使用同一 Hub 接口：<code>mode: refresh</code> 搜最新，<code>mode: stored</code> 查最新入库和历史数据。无需选择数据产品或上游服务。</p><pre>{requestExample}</pre><p>加载更多：保持搜索参数不变，增加响应中的 <code>data.pageInfo.nextCursor</code> 作为 <code>cursor</code>，每一页使用新标识。网络重试保留原参数和标识；没有 nextCursor 就停止。</p><p>刷新最新：移除 cursor，使用新标识。已收录结果中的「刷新已收录」会重新读取当前入库数据。相同条件再次点击「搜最新」会复用本轮记录；要重新采集，请点击「刷新最新」。历史查询支持标签、日期，实时查询暂不支持这些统一筛选。</p></details>
  </div>
}
