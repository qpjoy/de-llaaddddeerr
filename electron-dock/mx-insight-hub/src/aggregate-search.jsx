import { useEffect, useRef, useState } from 'react'
import { MagnifyingGlass, ArrowClockwise } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { DropdownField, EmptyState, ErrorState, LoadingState, formatDate } from './components.jsx'
import { useDemoApiKey, useDemoIdentity } from './demo-credentials.jsx'
import './aggregate-search.css'

const types = [['post', '帖子 / 笔记'], ['article', '文章'], ['message', '消息'], ['chat', '会话'], ['comment', '评论'], ['product', '商品'], ['account', '账号'], ['user', '用户资料'], ['profile', '画像'], ['saved_record', '分类记录'], ['commerce_capture', '电商采集记录'], ['opinion_item', '舆情条目']]
const initial = { query: '', mode: 'refresh', platforms: [], objectTypes: [], tags: '', from: '', to: '', pageSize: 20 }
const statuses = { ok: '成功', empty: '无结果', partial: '部分返回', unsupported: '无匹配实时接口', unavailable: '暂不可用', not_authorized: '未获操作授权', unknown: '结果待核实' }
const toggle = (values, key) => values.includes(key) ? values.filter(value => value !== key) : [...values, key].sort()
const safeUrl = value => typeof value === 'string' && /^https?:\/\//i.test(value) ? value : null
function requestBody(draft) {
  return { query: draft.query.trim(), mode: draft.mode, platforms: draft.platforms, objectTypes: draft.objectTypes,
    pageSize: draft.pageSize, filters: draft.mode === 'stored' ? {
      tags: draft.tags.split(/[,，]/).map(tag => tag.trim()).filter(Boolean),
      ...(draft.from ? { from: `${draft.from}T00:00:00+08:00` } : {}),
      ...(draft.to ? { to: `${draft.to}T23:59:59.999+08:00` } : {}),
    } : {},
  }
}

// The parent owns this memory across tab changes. An in-flight acquisition and
// its exact idempotency key survive unmounting; mounting never starts a search.
export default function AggregateSearchPanel({ session }) {
  const [apiKey] = useDemoApiKey()
  const identity = useDemoIdentity()
  if (!session.current || session.current.identity !== identity) session.current = { identity, draft: initial, runs: new Map(), active: null }
  const cell = session.current
  const [draft, setDraft] = useState(cell.draft)
  const [sources, setSources] = useState(null)
  const [sourceError, setSourceError] = useState(null)
  const [revision, setRevision] = useState(0)
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
  useEffect(() => { setDraft(cell.draft); cell.active?.promise?.then(update, update) }, [cell])
  const change = (key, value) => setDraft(current => {
    const next = { ...current, [key]: value }; cell.draft = next; return next
  })
  const selected = (sources || []).filter(source => !draft.platforms.length || draft.platforms.includes(source.platform))
  const liveCount = selected.flatMap(source => source.routes).filter(route => !draft.objectTypes.length || draft.objectTypes.includes(route.objectType)).length
  const run = cell.active
  const busy = run?.busy || false
  const result = run?.result?.payload?.data
  const body = requestBody(draft)
  const requestExample = `POST /api/v1/data/aggregate/search\nAuthorization: Bearer <HUB_API_KEY>\nIdempotency-Key: <每次新查询的唯一标识，重试保持不变>\n\n${JSON.stringify(body, null, 2)}`
  async function search(input, fresh = false) {
    if (cell.active?.busy || !apiKey) return
    const fingerprint = JSON.stringify(input)
    let operation = cell.runs.get(fingerprint)
    if (!operation || fresh) {
      operation = { body: input, idempotencyKey: crypto.randomUUID(), busy: false, result: null, error: null }
      cell.runs.set(fingerprint, operation)
    }
    cell.active = operation
    operation.busy = true; operation.error = null
    // No automatic retries, and no AbortController that could obscure whether
    // a paid request completed on the server after navigation.
    operation.promise = publicDataApi.aggregateSearch(apiKey, operation.body, operation.idempotencyKey)
      .then(value => { operation.result = value })
      .catch(error => { operation.error = error })
      .finally(() => { operation.busy = false; update() })
    update()
  }
  return <div className="mih-aggregate">
    <section className="qp-panel mih-browser-panel">
      <div className="mih-aggregate-heading"><div><h2>聚合数据搜索</h2><p>从 Hub 直接搜索各平台最新数据，或查询已入库的数据。</p></div><a href="#/source-catalog">查看数据源目录</a></div>
      <div className="mih-browser-filter-chips" role="group" aria-label="数据范围">
        {[['refresh', '实时搜最新'], ['stored', '搜索存量']].map(([value, label]) => <button type="button" key={value} aria-pressed={draft.mode === value} disabled={busy} onClick={() => change('mode', value)}>{label}</button>)}
      </div>
      <form onSubmit={event => { event.preventDefault(); search(body) }}>
        <label className="qp-field">关键词<input className="qp-input" required maxLength={200} value={draft.query} disabled={busy} onChange={event => change('query', event.target.value)} placeholder="输入关键词，例如新能源汽车、小红书笔记主题" /></label>
        <fieldset disabled={busy} className="mih-aggregate-choices"><legend>平台 · 支持全选、单选和多选</legend>
          <button type="button" className="qp-button qp-button--outline qp-button--sm" aria-pressed={!draft.platforms.length} onClick={() => change('platforms', [])}>全平台（当前授权范围）</button>
          {(sources || []).map(source => <label key={source.platform}><input type="checkbox" checked={draft.platforms.includes(source.platform)} onChange={() => change('platforms', toggle(draft.platforms, source.platform))} /><span>{source.label}<small>{source.refresh ? '支持实时' : '仅存量'}</small></span></label>)}
        </fieldset>
        {!apiKey ? <p role="status">请选择上方调用身份，查看该 Key 已授权的数据来源。</p> : sourceError ? <ErrorState error={sourceError} onRetry={() => setRevision(value => value + 1)} /> : !sources ? <LoadingState /> : !sources.length ? <p>当前 Key 尚未授权可搜索平台，请在 API Keys 中检查授权快照。</p> : null}
        <fieldset disabled={busy} className="mih-aggregate-choices"><legend>条目类型 · 不选表示全部类型</legend>
          {types.map(([value, label]) => <label key={value}><input type="checkbox" checked={draft.objectTypes.includes(value)} onChange={() => change('objectTypes', toggle(draft.objectTypes, value))} />{label}</label>)}
        </fieldset>
        {draft.mode === 'stored' ? <div className="mih-aggregate-filters">
          <label className="qp-field">标签（同时包含）<input className="qp-input" disabled={busy} value={draft.tags} onChange={event => change('tags', event.target.value)} placeholder="多个标签以逗号分隔" /></label>
          <label className="qp-field">开始日期<input className="qp-input" type="date" disabled={busy} value={draft.from} onChange={event => change('from', event.target.value)} /></label>
          <label className="qp-field">结束日期<input className="qp-input" type="date" min={draft.from || undefined} disabled={busy} value={draft.to} onChange={event => change('to', event.target.value)} /></label>
          <DropdownField label="每页条数" disabled={busy} value={String(draft.pageSize)} onChange={value => change('pageSize', Number(value))} options={[10, 20, 50].map(value => ({ value: String(value), label: `${value} 条` }))} />
        </div> : null}
        <p className="mih-browser-note">{draft.mode === 'refresh' ? `将调用 ${liveCount} 个已授权实时接口，各取第一页；按现有接口套餐计费。仅存量的来源会单独标明。` : '从 Hub 已入库数据检索，不触发采集。日期按北京时间筛选发布时间；标签需全部匹配。'}</p>
        {draft.mode === 'refresh' ? <p className="mih-browser-note">实时接口暂不支持统一标签、日期过滤。需要这些筛选时请选择「搜索存量」。</p> : null}
        <div className="mih-page-actions"><button className="qp-button qp-button--primary" disabled={busy || !apiKey || !sources?.length || (draft.mode === 'refresh' && !liveCount)}><MagnifyingGlass />{busy ? '正在搜索…' : draft.mode === 'refresh' ? '实时搜最新' : '搜索存量'}</button>
          {run?.result && draft.mode === 'refresh' ? <button type="button" className="qp-button qp-button--outline" disabled={busy || !draft.query.trim() || !liveCount} onClick={() => search(body, true)}><ArrowClockwise />重新采集最新（新计费请求）</button> : null}
        </div>
        <p className="mih-browser-note">同条件再次搜索会复用本次请求；需要新一轮采集时使用「重新采集最新」。</p>
      </form>
      <details className="mih-aggregate-api"><summary>直接调用 API · 查看当前参数</summary><pre>{requestExample}</pre></details>
    </section>
    {run?.error ? <section className="qp-panel mih-browser-panel"><ErrorState error={run.error} /><p>原请求标识：<code>{run.idempotencyKey}</code>。重试保持参数和标识不变，结果未知时不会自动重新采集。</p><button className="qp-button qp-button--outline" disabled={busy} onClick={() => search(run.body)}>重试原请求</button></section> : null}
    {result ? <section className="qp-panel mih-browser-panel" aria-live="polite">
      <div className="mih-aggregate-heading"><div><h2>{result.mode === 'refresh' ? '实时搜索结果' : '存量搜索结果'} · {result.items.length} 条</h2><p>关键词：{result.query} · {run.result.evidence.idempotentReplay ? '本次请求回放' : '本次请求结果'}</p></div><code>{run.result.evidence.requestId}</code></div>
      {result.mode === 'refresh' ? <p>本次为各来源第一页的结果窗口，不代表全量。已交付内容会异步入库；如需查看历史，请切换「搜索存量」。</p> : <p>第 {result.pageInfo.pageIndex} 页 · 为减少等待，首屏不统计全库总数。</p>}
      <div className="mih-aggregate-sources">{result.sources.map((source, i) => <div key={`${source.id || source.platform}:${i}`}><strong>{source.label || sources?.find(entry => entry.platform === source.platform)?.label || source.platform}</strong><span>{statuses[source.status] || source.status}{source.returnedCount != null ? ` · ${source.returnedCount} 条` : ''}{source.hasMore ? ' · 来源还有后续页' : ''}</span>{source.requestId ? <small>调用记录：{source.requestId}</small> : null}</div>)}</div>
      {result.status === 'partial' ? <p role="status">部分来源未完成实时搜索；请按上述逐源状态判断覆盖范围。</p> : null}
      {result.search?.degraded ? <p role="status">搜索索引暂不可用，已使用数据库检索。</p> : null}
      {!result.items.length ? <EmptyState title="本次没有返回内容" description="可更换关键词或平台；来源失败与无结果请以上方状态为准。" /> : <div className="mih-aggregate-results">{result.items.map((item, index) => <article key={`${item.id}:${index}`}><div className="mih-aggregate-heading"><small>{sources?.find(source => source.platform === item.platform)?.label || item.platform} · {types.find(([value]) => value === item.objectType)?.[1] || item.objectType}</small><small>{formatDate(item.eventTime || item.collectedAt)}</small></div><h3>{item.title || '未提供标题'}</h3>{item.text ? <p>{item.text}</p> : null}<footer><span>{item.author?.name || '未提供作者'}</span>{safeUrl(item.url) ? <a href={safeUrl(item.url)} target="_blank" rel="noreferrer">查看原文 ↗</a> : null}</footer></article>)}</div>}
      {result.mode === 'stored' && result.pageInfo.nextCursor ? <button className="qp-button qp-button--outline" disabled={busy} onClick={() => search({ ...run.body, cursor: result.pageInfo.nextCursor })}>下一页存量</button> : null}
    </section> : null}
  </div>
}
