import { useEffect, useMemo, useRef, useState } from 'react'
import { adminApi, publicDataApi, publicApiOrigin } from './api.js'
import { DropdownField, ErrorState } from './components.jsx'
import { useDemoApiKey, useDemoAccessSnapshot, DemoCredentialRecheck } from './demo-credentials.jsx'
import { PagedItems } from './paged-items.jsx'
import { requestUuid } from './request-id.js'
import { copyText } from './open-capabilities.js'
import { REQUEST_FORMATS, requestSnippet } from './request-snippets.js'
import { enterpriseAccessIssues, enterpriseConsoleEndpoints, enterpriseConsoleFields, enterpriseConsoleBody, enterpriseRequestIdentity } from './enterprise-console.js'

export function EnterprisePage({ token, query, onUnauthorized }) {
  const [apiKey] = useDemoApiKey()
  const access = useDemoAccessSnapshot()
  const issues = enterpriseAccessIssues(access)
  const [document, setDocument] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [reload, setReload] = useState(0)
  const [tab, setTab] = useState('debug')
  const [selected, setSelected] = useState(() => query?.get('apiId') || '1.31')
  const [category, setCategory] = useState('')
  const [drafts, setDrafts] = useState({})
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [responseTab, setResponseTab] = useState('body')
  const [format, setFormat] = useState('curl')
  const [copyStatus, setCopyStatus] = useState('')
  const [, render] = useState(0)
  const attempts = useRef(new Map())
  const lock = useRef(false)
  useEffect(() => {
    let active = true
    setDocument(null); setLoadError(null)
    adminApi.documentation(token, '/docs/openapi.json').then(data => {
      if (active) setDocument(data.schema)
    }).catch(failure => {
      if (!active) return
      setLoadError(failure)
      if (failure.status === 401) onUnauthorized?.(failure)
    })
    return () => { active = false }
  }, [token, reload, onUnauthorized])
  const endpoints = useMemo(() => enterpriseConsoleEndpoints(document), [document])
  const categories = useMemo(() => [...new Set(endpoints.map(endpoint => endpoint.category))], [endpoints])
  const endpoint = endpoints.find(item => item.id === selected) || endpoints[0]
  const values = drafts[endpoint?.id] || {}
  let body = null, validation = ''
  try { body = enterpriseConsoleBody(endpoint, values) } catch (failure) { validation = failure.message }
  const fingerprint = body ? enterpriseRequestIdentity(endpoint, body) : ''
  const previous = attempts.current.get(fingerprint)
  const allowed = !!apiKey && !issues.length && endpoint?.callable
  const change = (key, value) => {
    setDrafts(current => ({ ...current, [endpoint.id]: { ...values, [key]: value } }))
    setResult(null); setError(null); setCopyStatus('')
  }
  const prepare = () => {
    const attempt = attempts.current.get(fingerprint) || { key: `enterprise-console-${requestUuid()}`, sent: false }
    attempts.current.set(fingerprint, attempt)
    render(value => value + 1)
    return attempt
  }
  const send = async event => {
    event.preventDefault()
    if (lock.current || !allowed || !body) return
    lock.current = true; setBusy(true); setError(null)
    const attempt = prepare(); attempt.sent = true
    const request = { path: endpoint.path, body, idempotencyKey: attempt.key }
    const started = performance.now()
    try {
      const response = await publicDataApi.enterpriseQuery(apiKey, endpoint.id, body, { idempotencyKey: attempt.key })
      setResult({ ...response, request, duration: Math.round(performance.now() - started) })
    } catch (failure) {
      setError(failure)
      setResult({ request, status: failure.status || null, duration: Math.round(performance.now() - started),
        payload: { error: { code: failure.code || 'request_failed', message: failure.message, requestId: failure.requestId } } })
    } finally { lock.current = false; setBusy(false) }
  }
  const snippet = id => requestSnippet({ format, url: `${publicApiOrigin()}${endpoint?.path || ''}`, body,
    credential: '<HUB_API_KEY>', idempotencyKey: id || '<IDEMPOTENCY_KEY>' })
  const copy = async () => {
    if (!allowed || !body || busy) return
    const success = await copyText(snippet(prepare().key))
    setCopyStatus(success ? '已复制。替换 <HUB_API_KEY> 后可运行；复制不会发送请求。' : '复制失败，请从代码预览中复制。')
  }
  const filtered = endpoints.filter(item => !category || item.category === category)
  return <div className="mih-page mih-enterprise-page">
    <header className="mih-page-header"><div><h1>企业数据</h1><p>企业检索、工商、风险与关联信息 · 使用当前 Hub Key 调用</p></div><a className="qp-button qp-button--outline" href="#/docs?path=/docs/enterprise">接口文档</a></header>
    <nav className="mih-source-section-tabs" aria-label="企业数据视图">
      <button type="button" aria-pressed={tab === 'debug'} onClick={() => setTab('debug')}>接口调试</button>
      <button type="button" aria-pressed={tab === 'integration'} onClick={() => setTab('integration')}>接入指南</button>
    </nav>
    <div style={{ display: tab === 'integration' ? undefined : 'none' }} className="qp-panel mih-panel">
      <h2>下游应用接入 Hub</h2><p>使用已授权 enterprise + enterprise.query 的 Hub Live API Key，按接口文档构建 JSON 请求。Hub 处理平台认证并保留交付结果，应用不需要其他平台密钥。</p>
      <p>在调试页选择接口、填写参数并复制 cURL 或 JavaScript 示例，替换 Hub Key 即可接入。接口说明、响应字段和 OpenAPI 保留在「接口文档」。</p>
      <p>每次新查询或换页使用新 Idempotency-Key；同一请求重试保持原标识和参数。HTTP 200 后检查 meta.resultState，pending 表示尚在处理。请求超时或结果未知时先核对请求状态，不能当作失败后反复新建请求。</p>
      <p>费用按所选 Key 所属调用者的套餐结算；页面打开、筛选、翻阅接口目录和切换视图不查询企业数据。只有点击发送才调用，报告与数据下一页均需手动查询。</p>
      <a href="#/docs?path=/docs/enterprise">查看完整接入说明与接口目录 →</a>
    </div>
    <div style={{ display: tab === 'debug' ? undefined : 'none' }}>
      {loadError ? <><ErrorState error={loadError} /><button className="qp-button qp-button--outline" onClick={() => setReload(value => value + 1)}>重载接口契约</button></> : !document ? <p role="status">正在读取接口契约…</p> : null}
      {!apiKey || issues.length ? <div className="mih-inline-warning" role="status"><div>{!apiKey ? <p>请选择已授权的 Hub Live Key。</p> : null}{issues.map(issue => <p key={issue}>{issue}</p>)}<DemoCredentialRecheck /></div></div> : null}
      {document && !issues.length ? <section className="mih-api-console mih-enterprise-console qp-panel" aria-label="Hub 企业接口调试">
        <aside className="mih-api-console-nav"><h2>企业接口</h2><p>{endpoints.length} 项 · 仅手动发送请求</p>
          <DropdownField label="接口分类" value={category} disabled={busy} onChange={setCategory} options={[{ value: '', label: '全部分类' }, ...categories.map(value => ({ value, label: value }))]} />
          <PagedItems key={category} items={filtered} label="企业接口" text={item => `${item.label} ${item.category}`}>
            {rows => <div>{rows.map(({ entry }) => <button type="button" key={entry.id} disabled={busy} aria-pressed={endpoint?.id === entry.id} onClick={() => { setSelected(entry.id); setResult(null); setError(null); setCopyStatus('') }}><span>{entry.label}<small>{entry.callable ? entry.category : '未开放调用'}</small></span></button>)}</div>}
          </PagedItems>
        </aside>
        <div className="mih-api-console-main">
          <header><span className="mih-api-method">POST</span><code>{endpoint?.path || '暂无已开放接口'}</code>{endpoint ? <a href={`#/docs?path=/docs/enterprise/${endpoint.id}`}>本接口文档</a> : null}</header>
          {endpoint ? <>
            <h2>{endpoint.label}</h2>
            {!endpoint.callable ? <p className="mih-inline-warning">此接口未开放调用，不能发送请求。</p> : null}
            <p>按当前套餐计费。相同参数重复发送使用原幂等标识；修改查询、页码或交付方式表示新请求。不会自动翻页、轮询或重试。</p>
            <form onSubmit={send}>
              <div className="mih-enterprise-options"><DropdownField label="交付方式" value={values.deliveryMode || 'live_only'} disabled={busy} onChange={value => change('deliveryMode', value)} options={[
                { value: 'live_only', label: 'live_only · 实时查询' }, { value: 'cache_first', label: 'cache_first · 缓存优先，缺失时查询' },
                { value: 'cache_only', label: 'cache_only · 只读已有快照' }, { value: 'refresh', label: 'refresh · 更新，允许存量回退' },
              ]} />{endpoint.schema.properties.method.enum.length > 1 ? <DropdownField label="接口请求方式" value={values.method || endpoint.schema.properties.method.default} disabled={busy} onChange={value => change('method', value)} options={endpoint.schema.properties.method.enum.map(value => ({ value, label: value }))} /> : null}</div>
              {['query', 'body'].map(section => enterpriseConsoleFields(endpoint, section).length ? <div key={section}><h3>{section} 参数</h3><div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>参数</th><th>说明</th><th>值</th></tr></thead><tbody>{enterpriseConsoleFields(endpoint, section).map(field => <tr key={field.key}><td><code>{field.name}</code>{field.required ? ' *' : ''}</td><td>{field.description?.length > 120 ? <details><summary>{field.description.slice(0, 64)}…（展开）</summary><p>{field.description}</p></details> : field.description}</td><td><input className="qp-input" aria-label={field.key} disabled={busy} value={values[field.key] ?? ''} placeholder={field.required ? '必填' : '留空不传'} maxLength={16000} onChange={event => change(field.key, event.target.value)} /></td></tr>)}</tbody></table></div></div> : null)}
              {validation ? <p role="status">{validation}</p> : null}
              <div className="mih-page-actions"><button className="qp-button qp-button--primary" disabled={!allowed || !body || busy}>{busy ? '正在发送…' : previous?.sent ? '重放 / 重试同一请求' : '发送请求'}</button>
                {previous ? <button type="button" className="qp-button qp-button--outline" disabled={busy} onClick={() => { attempts.current.delete(fingerprint); render(value => value + 1); setResult(null); setError(null); setCopyStatus('') }}>以当前参数新建请求（可能再次计费）</button> : null}</div>
            </form>
            <details><summary>请求预览与代码示例（不含密钥）</summary>
              <DropdownField label="代码格式" value={format} onChange={setFormat} options={REQUEST_FORMATS} />
              <pre>{snippet(previous?.key)}</pre><button type="button" className="qp-button qp-button--outline" disabled={!allowed || !body || busy} onClick={copy}>复制示例 · 替换 Hub Key 后运行</button><p role="status">{copyStatus}</p>
            </details>
          </> : null}
          <div className="mih-api-response-heading"><h3>响应</h3>{result ? <span>HTTP {result.status || '未收到响应'} · {result.duration} ms</span> : null}</div>
          {error ? <ErrorState error={error} /> : null}
          {result?.payload?.meta?.resultState === 'pending' ? <p className="mih-inline-warning">业务仍在处理中，当前响应不代表报告完成。请按本接口文档使用返回的任务标识手动查询。</p> : null}
          <nav className="mih-source-section-tabs" aria-label="企业响应内容"><button type="button" aria-pressed={responseTab === 'body'} onClick={() => setResponseTab('body')}>JSON 响应</button><button type="button" aria-pressed={responseTab === 'request'} onClick={() => setResponseTab('request')}>本次请求</button></nav>
          <pre className="mih-api-response" tabIndex={0}>{result ? JSON.stringify(responseTab === 'body' ? result.payload : result.request, null, 2) : '发送请求后查看真实结果。浏览目录、切换视图不会发送查询。'}</pre>
          {result ? <p>Request ID：{result.evidence?.requestId || error?.requestId || '未取得'} · 交付来源：{result.evidence?.sourceMode || '未知'}{result.evidence?.idempotentReplay ? ' · 幂等回放' : ''}</p> : null}
        </div>
      </section> : null}
    </div>
  </div>
}
