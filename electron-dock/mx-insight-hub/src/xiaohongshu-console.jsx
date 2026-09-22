import { useRef, useState } from 'react'
import { publicDataApi } from './api.js'
import { DropdownField, ErrorState } from './components.jsx'
import { useDemoAccessSnapshot } from './demo-credentials.jsx'
import { demoAccessIssues } from './demo-access.js'
import { requestUuid } from './request-id.js'
import { XHS_CONSOLE_ENDPOINTS, consoleBody, consoleRequestIdentity } from './xiaohongshu-console.js'

export function XiaohongshuConsole({ apiKey }) {
  const access = useDemoAccessSnapshot()
  const endpoints = XHS_CONSOLE_ENDPOINTS.filter(endpoint => access === null || (access && !demoAccessIssues(access, endpoint.capability, endpoint.compatibility).some(issue => issue.kind === 'authorization')))
  const [selected, setSelected] = useState('')
  const endpoint = endpoints.find(item => item.id === selected) || endpoints[0]
  const [drafts, setDrafts] = useState({})
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [responseTab, setResponseTab] = useState('body')
  const lock = useRef(false)
  const attempts = useRef(new Map())
  const [revision, setRevision] = useState(0)
  const defaults = Object.fromEntries((endpoint?.fields || []).filter(field => field[4] != null).map(field => [field[0], field[4]]))
  const values = { ...defaults, ...(drafts[endpoint?.id] || {}) }
  const issues = endpoint ? demoAccessIssues(access, endpoint.capability, endpoint.compatibility) : []
  let body = null, validation = ''
  try { if (endpoint) body = consoleBody(endpoint, values) } catch (failure) { validation = failure.message }
  const fingerprint = body ? consoleRequestIdentity(endpoint, body) : ''
  const previous = attempts.current.get(fingerprint)
  const send = async () => {
    if (lock.current || !apiKey || !endpoint || !body || issues.length) return
    lock.current = true; setBusy(true); setError(null)
    const identity = previous || `xhs-console-${requestUuid()}`
    attempts.current.set(fingerprint, identity)
    const started = performance.now()
    const request = { path: endpoint.path, body, idempotencyKey: identity }
    try {
      const response = endpoint.id === 'post'
        ? await publicDataApi.xiaohongshuPost(apiKey, body, { idempotencyKey: identity })
        : endpoint.research ? await publicDataApi.xiaohongshuResearch(apiKey, endpoint.id, body, { idempotencyKey: identity })
        : await publicDataApi.xiaohongshuNative(apiKey, endpoint.id, body, { idempotencyKey: identity })
      setResult({ ...response, request, duration: Math.round(performance.now() - started) })
    } catch (failure) {
      setError(failure)
      setResult({ request, status: failure.status || null, duration: Math.round(performance.now() - started), payload: { error: { code: failure.code || 'request_failed', requestId: failure.requestId } } })
    } finally { lock.current = false; setBusy(false) }
  }
  return <section className="mih-api-console qp-panel" aria-label="Hub 小红书接口调试">
    <aside className="mih-api-console-nav"><h2>小红书接口</h2><p>仅展示当前 Key 已授权接口</p>{endpoints.map(item => <button type="button" key={item.id} disabled={busy} aria-pressed={endpoint?.id === item.id} onClick={() => { setSelected(item.id); setError(null); setResult(null) }}><small>POST</small>{item.label}</button>)}{!endpoints.length ? <p>{access === undefined ? '正在读取调用身份…' : '当前 Key 暂无可调试接口，请检查授权。'}</p> : null}</aside>
    <div className="mih-api-console-main">
      <header><span className="mih-api-method">POST</span><code>{endpoint?.path || '/api/v1/…'}</code><button className="qp-button qp-button--primary" disabled={busy || !body || !apiKey || !!issues.length} onClick={() => void send()}>{busy ? '正在发送…' : previous ? '重放 / 重试同一请求' : '发送请求'}</button></header>
      <p>认证：当前选择的 Hub Key · 成功调用按套餐计费。修改参数表示新的查询；同参数重复发送使用原幂等标识。</p>
      {endpoint?.notice ? <p className="mih-inline-warning">{endpoint.notice}</p> : null}
      {issues.map(issue => <p className="mih-inline-warning" key={issue.scope}>{issue.message}</p>)}
      <h3>请求参数 · JSON Body</h3>
      <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>参数</th><th>说明</th><th>值</th></tr></thead><tbody>{endpoint?.fields.map(([key, label, type, required]) => <tr key={key}><td><code>{key}</code>{required ? ' *' : ''}</td><td>{label}</td><td>{Array.isArray(type) ? <DropdownField label={label} value={values[key] || ''} disabled={busy} onChange={value => setDrafts(current => ({ ...current, [endpoint.id]: { ...values, [key]: value } }))} options={[{ value: '', label: '不传此参数' }, ...type.map(value => ({ value, label: value }))]} /> : <input className="qp-input" aria-label={label} type={type === 'number' ? 'number' : 'text'} min={type === 'number' ? 1 : undefined} max={type === 'number' ? 15 : undefined} disabled={busy} value={values[key] || ''} placeholder={required ? '必填' : '留空不传'} onChange={event => setDrafts(current => ({ ...current, [endpoint.id]: { ...values, [key]: event.target.value } }))} />}</td></tr>)}</tbody></table></div>
      {validation ? <p>{validation}</p> : null}
      <details><summary>请求预览（密钥不显示）</summary><pre>{JSON.stringify({ method: 'POST', path: endpoint?.path, headers: { Authorization: 'Bearer <当前 Hub Key>', 'Content-Type': 'application/json' }, body }, null, 2)}</pre></details>
      {previous ? <button className="qp-button qp-button--outline" disabled={busy} onClick={() => { attempts.current.delete(fingerprint); setRevision(revision + 1) }}>以当前参数新建请求（可能再次计费）</button> : null}
      <div className="mih-api-response-heading"><h3>响应</h3>{result ? <span>HTTP {result.status || '未收到响应'} · {result.duration} ms</span> : null}</div>
      {error ? <ErrorState error={error} /> : null}
      <nav className="mih-source-section-tabs" aria-label="响应内容"><button aria-pressed={responseTab === 'body'} onClick={() => setResponseTab('body')}>{error ? '错误摘要' : 'JSON 响应'}</button><button aria-pressed={responseTab === 'request'} onClick={() => setResponseTab('request')}>本次请求</button></nav>
      <pre className="mih-api-response" tabIndex={0}>{result ? JSON.stringify(responseTab === 'body' ? result.payload : result.request, null, 2) : '发送请求后在这里查看结果。不会自动发送或加载下一页。'}</pre>
      {result?.evidence?.requestId ? <small>Request ID：{result.evidence.requestId}</small> : null}
    </div>
  </section>
}
