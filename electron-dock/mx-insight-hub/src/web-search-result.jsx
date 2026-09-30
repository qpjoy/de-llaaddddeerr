export function WebSearchResult({payload}) {
  const items=payload?.data?.items
  if(!Array.isArray(items))return null
  return <section className="mih-web-search-results" aria-label="Web Search 结果"><h3>搜索结果 · {items.length} 条</h3><p>渠道：{payload.data.provider} · 捕获时间：{payload.meta?.capturedAt}</p>{!items.length?<p>本次搜索没有返回结果，未自动改用其他渠道。</p>:items.map((row,i)=><article key={`${i}:${row.url}`} className="qp-panel mih-panel"><small>{row.type} · {row.publishedAt || '日期未提供'}</small><h4><a href={row.url} target="_blank" rel="noopener noreferrer">{row.title || row.url}</a></h4><p>{row.snippet || '此结果未提供摘要。'}</p><small className="mih-web-search-url">{row.url}</small></article>)}</section>
}
