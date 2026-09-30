import { useState } from 'react'
import { webSearchProvider } from '../shared/web-search.mjs'
import { SEARCH_RESOURCE_LABELS } from './web-search-form.js'

function sourceUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null } catch { return null }
}
export function WebSearchResult({ payload }) {
  const [type, setType] = useState('all')
  const items = payload?.data?.items
  if (!Array.isArray(items)) return null
  const visible = type === 'all' ? items : items.filter(row => row.type === type)
  return <section className="mih-web-search-results" aria-label="Web Search 结果">
    <header><div><h3>搜索结果 · {items.length} 条</h3><p>{payload.data.query}</p></div><small>{webSearchProvider(payload.data.provider)?.label || payload.data.provider}{payload.meta?.capturedAt ? ` · ${payload.meta.capturedAt}` : ''}</small></header>
    {items.length ? <nav className="mih-search-result-tabs" aria-label="筛选已返回结果">{[['all', '全部'], ...Object.entries(SEARCH_RESOURCE_LABELS)].map(([value, label]) => <button type="button" key={value} aria-pressed={type === value} onClick={() => setType(value)}>{label} <span>{value === 'all' ? items.length : items.filter(row => row.type === value).length}</span></button>)}</nav> : null}
    {!items.length ? <div className="mih-search-empty"><h3>本次搜索没有返回结果</h3><p>未自动改用其他渠道。可以修改关键词再搜索。</p></div> : !visible.length ? <p>本次响应没有此类型的结果。切换筛选不会发起搜索。</p> : visible.map((row, index) => {
      const url = sourceUrl(row.url)
      return <article key={`${index}:${row.url}`}><small>{SEARCH_RESOURCE_LABELS[row.type] || row.type} · {url?.hostname || '来源链接不可用'}{row.publishedAt ? ` · ${row.publishedAt}` : ''}</small><h4>{url ? <a href={url.href} target="_blank" rel="noopener noreferrer">{row.title || url.href} ↗</a> : row.title || '未提供标题'}</h4><p>{row.snippet || '此结果未提供摘要。'}</p>{url ? <small className="mih-web-search-url">{url.href}</small> : null}</article>
    })}
  </section>
}
