import { useEffect, useRef, useState } from 'react'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'
import { publicDataApi, publicApiOrigin } from './api.js'
import { DropdownField, ErrorState, Field } from './components.jsx'
import { copyText } from './open-capabilities.js'
import { REQUEST_FORMATS, requestSnippet } from './request-snippets.js'
import { NEWS_ENDPOINTS, newsConsoleRequest, nextNewsConsoleRequest } from './news-console.js'

export function NewsApiConsole({ apiKey, filters, sourceNames, onSourceOptions, onCatalog, onEntries, onCategory }) {
  const [operation, setOperation] = useState('source-options')
  const [articleId, setArticleId] = useState('')
  const [format, setFormat] = useState('curl'), [copyStatus, setCopyStatus] = useState('')
  const [responses, setResponses] = useState({}), [busy, setBusy] = useState(false)
  const [, render] = useState(0)
  const attempts = useRef(new Map()), locked = useRef(false), active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const endpoint = NEWS_ENDPOINTS.find(item => item.id === operation)
  let request, validation = ''
  try { request = newsConsoleRequest(operation, filters, articleId) } catch (error) { validation = error.message }
  const fingerprint = request ? JSON.stringify(request) : ''
  const attempt = attempts.current.get(fingerprint)
  const result = responses[operation]
  const next = nextNewsConsoleRequest(result)
  const prepare = descriptor => {
    if (!NEWS_ENDPOINTS.find(item => item.id === descriptor.operation).metered) return null
    const signature = JSON.stringify(descriptor)
    if (!attempts.current.has(signature)) attempts.current.set(signature, { key: crypto.randomUUID(), sent: false })
    return attempts.current.get(signature)
  }
  const snippet = idempotencyKey => requestSnippet({ format, method: endpoint.method,
    url: `${publicApiOrigin()}${request?.path || endpoint.path}`, body: request?.body,
    credential: '<HUB_API_KEY>', idempotencyKey: endpoint.metered ? idempotencyKey || '<NEW_IDEMPOTENCY_KEY>' : undefined })
  async function send(descriptor = request) {
    if (!apiKey || !descriptor || locked.current) return
    locked.current = true; setBusy(true); setCopyStatus('')
    const ticket = prepare(descriptor)
    if (ticket) ticket.sent = true
    const started = performance.now()
    let response
    try {
      switch (descriptor.operation) {
        case 'source-options': response = await publicDataApi.newsSourceOptions(apiKey); break
        case 'sources': response = await publicDataApi.newsSources(apiKey); break
        case 'search': response = await publicDataApi.newsSearch(apiKey, descriptor.body, ticket.key); break
        case 'facets': response = await publicDataApi.newsFacets(apiKey, descriptor.body, ticket.key); break
        case 'articles': response = await publicDataApi.newsArticle(apiKey, descriptor.path.split('/').at(-1), ticket.key); break
      }
      if (!active.current) return
      if (descriptor.operation === 'source-options') onSourceOptions(response.payload.data)
      if (descriptor.operation === 'sources') onCatalog(response.payload.data)
    } catch (error) {
      response = { error, status: error.status || null, evidence: error.evidence,
        payload: error.responseBody || { error: { code: error.code || 'request_failed', message: error.message, requestId: error.requestId } } }
    } finally {
      locked.current = false
      if (active.current) {
        setBusy(false)
        if (response) setResponses(current => ({ ...current, [descriptor.operation]: { ...response,
          request: descriptor, idempotencyKey: ticket?.key, duration: Math.round(performance.now() - started) } }))
      }
    }
  }
  async function copy() {
    if (!request) return
    const ticket = prepare(request)
    render(value => value + 1)
    const ok = await copyText(snippet(ticket?.key))
    if (active.current) setCopyStatus(ok ? '已复制。将 <HUB_API_KEY> 替换为下游平台自己的 Live Key；复制不会调用接口。' : '复制失败，请从下方代码框手动复制。')
  }
  const selectedNames = filters.catalogEntryIds.map(key => ({ key, value: sourceNames[key] || null }))
  return <section className="qp-panel mih-news-debug" aria-label="新闻发现接口调试">
    <h2>新闻发现 · 完整接口</h2>
    <p>接入顺序：获取来源与类别 → 多选目录 ID 搜索 → 使用游标翻页 → 用文章 ID 读取详情。所有接口使用下游自己的 Hub Live Key。</p>
    <nav className="mih-news-api-nav" aria-label="选择新闻接口">{NEWS_ENDPOINTS.map(item => <button key={item.id} type="button"
      className={`qp-button ${operation === item.id ? 'qp-button--primary' : 'qp-button--outline'}`} disabled={busy}
      aria-pressed={operation === item.id} onClick={() => { setOperation(item.id); setCopyStatus('') }}>{item.label}</button>)}</nav>
    <h3><code>{endpoint.method} {request?.path || endpoint.path}</code></h3><p>{endpoint.description}</p>
    <p>{endpoint.metered ? '按当前 Key 套餐计量，必须携带 Idempotency-Key。同一请求重放或失败重试保留原标识；新查询或下一页使用新标识。' : '来源元数据不计 usage unit，无需 Idempotency-Key，也不接受查询参数。'}</p>
    {operation === 'articles' ? <Field label="文章 ID" hint="来自新闻搜索 data.items[].id，可点击搜索结果的“填入详情”。">
      <input className="qp-input" value={articleId} onChange={event => { setArticleId(event.target.value); setCopyStatus('') }} maxLength={36} placeholder="文章 UUID，非目录 UUID" />
    </Field> : null}
    {endpoint.method === 'POST' ? <details open><summary>请求 JSON · 当前上方筛选条件</summary><pre>{JSON.stringify(request?.body, null, 2)}</pre>
      <h4>已选目录 ID 与名称</h4><pre>{JSON.stringify(selectedNames, null, 2)}</pre></details> : <p>GET 请求不发送 JSON 请求体。</p>}
    {validation ? <p role="status">{validation}</p> : null}
    <div className="mih-news-actions"><button type="button" className="qp-button qp-button--primary" disabled={!apiKey || !request || busy}
      onClick={() => void send()}>{busy ? '正在发送…' : attempt?.sent ? '重放 / 重试同一请求' : '发送此接口请求'}</button>
      {endpoint.metered && attempt?.sent ? <button type="button" className="qp-button qp-button--outline" disabled={busy} onClick={() => {
        attempts.current.set(fingerprint, { key: crypto.randomUUID(), sent: false }); render(value => value + 1); setCopyStatus('')
      }}>新建请求标识（再次发送会按套餐计量）</button> : null}
      {operation === 'search' && next ? <button type="button" className="qp-button qp-button--outline" disabled={!apiKey || busy} onClick={() => void send(next)}>读取下一页</button> : null}
      {result?.error && JSON.stringify(result.request) !== fingerprint ? <button type="button" className="qp-button qp-button--outline" disabled={!apiKey || busy} onClick={() => void send(result.request)}>重试这次失败请求</button> : null}
    </div>
    {operation === 'search' && next ? <p>下一页沿用最近成功搜索的条件和 pageSize，不采用尚未提交的表单改动；只替换 cursor。</p> : null}
    <details open><summary>调用示例 · 不含真实密钥</summary>
      <DropdownField label="代码格式" value={format} onChange={value => { setFormat(value); setCopyStatus('') }} options={REQUEST_FORMATS} />
      <pre className="mih-news-request-code">{snippet(attempt?.key)}</pre>
      <button type="button" className="qp-button qp-button--outline" disabled={!request || busy} onClick={() => void copy()}>复制调用示例</button>
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
    </details>
    <h3>此接口最近一次响应{result ? ` · HTTP ${result.status || '未收到'} · ${result.duration} ms` : ''}</h3>
    {result?.error ? <ErrorState error={result.error} /> : null}
    {result ? <><p>Request ID：{result.evidence?.requestId || result.payload?.requestId || '未取得'}{result.evidence?.idempotentReplay ? ' · 幂等重放' : ''}</p>
      <details><summary>这次实际发送的请求</summary><pre>{JSON.stringify({ ...result.request, ...(result.idempotencyKey ? { idempotencyKey: result.idempotencyKey } : {}) }, null, 2)}</pre></details></> : null}
    {operation === 'source-options' && result?.payload?.data?.items ? <div className="mih-news-api-table"><table className="qp-table mih-table"><thead><tr><th>名称 · value</th><th>目录 ID · key → catalogEntryIds</th><th>加入筛选</th></tr></thead><tbody>
      {result.payload.data.items.map(item => <tr key={item.key}><td>{item.value}</td><td><code>{item.key}</code></td><td><input type="checkbox" aria-label={`选择来源 ${item.value}`} checked={filters.catalogEntryIds.includes(item.key)}
        disabled={!filters.catalogEntryIds.includes(item.key) && filters.catalogEntryIds.length >= 50}
        onChange={event => onEntries(event.target.checked ? [...filters.catalogEntryIds, item.key].sort() : filters.catalogEntryIds.filter(id => id !== item.key))} /></td></tr>)}</tbody></table></div> : null}
    {operation === 'sources' && result?.payload?.data?.categories ? <div className="mih-news-api-table"><table className="qp-table mih-table"><thead><tr><th>名称 · label</th><th>类别 ID → categories</th><th>授权数据域 · platform</th><th>操作</th></tr></thead><tbody>
      {result.payload.data.categories.map(item => <tr key={item.id}><td>{item.label}</td><td><code>{item.id}</code></td><td><code>{item.platform}</code></td><td><button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => onCategory(item.id)}>用于类别筛选</button></td></tr>)}</tbody></table></div> : null}
    {operation === 'search' && result?.payload?.data?.items ? <div className="mih-news-api-table"><table className="qp-table mih-table"><thead><tr><th>新闻标题</th><th>文章 ID → articles/{'{id}'}</th><th>操作</th></tr></thead><tbody>
      {result.payload.data.items.map(item => <tr key={item.id}><td>{item.title || '无标题新闻'}</td><td><code>{item.id}</code></td><td><button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => { setArticleId(item.id); setOperation('articles'); setCopyStatus('') }}>填入详情</button></td></tr>)}</tbody></table></div> : null}
    <pre className="mih-news-api-response" tabIndex={0}>{result ? JSON.stringify(result.payload, null, 2) : '尚未发送此接口。切换接口、视图、勾选来源和复制示例不会发送请求。'}</pre>
    <AdminExecutionEvidence requestId={result?.evidence?.requestId} />
  </section>
}
