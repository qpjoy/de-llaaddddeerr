import { REQUEST_FORMATS, requestSnippet } from './request-snippets.js'
import { copyText } from './open-capabilities.js'
import { useMemo, useRef, useState } from 'react'
import { useDemoApiKey, useDemoAccessSnapshot, DemoCredentialRecheck, useDemoCredentialExpiry } from './demo-credentials.jsx'
import { publicDataApi, publicApiOrigin } from './api.js'
import { DropdownField, ErrorState } from './components.jsx'
import { ipRiskAccessIssues } from './demo-access.js'
import { requestUuid } from './request-id.js'

export function IpRiskPage() {
  const [key] = useDemoApiKey()
  const access = useDemoAccessSnapshot()
  const accessIssues = ipRiskAccessIssues(access)
  const allowed = !!key && accessIssues.length === 0
  const expiresAt = useDemoCredentialExpiry()
  const [format, setFormat] = useState('curl')
  const [copyStatus, setCopyStatus] = useState('')
  const [ip, setIp] = useState('')
  const [batch, setBatch] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const attempts = useRef(new Map())
  const [revision, setRevision] = useState(0)
  const values = batch ? ip.trim().split(/[\s,，]+/u).filter(Boolean) : [ip.trim()]
  const valid = values.length > 0 && values.length <= 100 && values.every(value => /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value) && value.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part))
  const body = batch ? { ips: values } : { ip: ip.trim() }
  const signature = JSON.stringify(body)
  const path = batch ? '/api/v1/data/ip/risk/batch' : '/api/v1/data/ip/risk'
  const identity = useMemo(() => {
    if (!valid) return ''
    if (!attempts.current.has(signature)) attempts.current.set(signature, `ip-risk-${requestUuid()}`)
    return attempts.current.get(signature)
  }, [signature, valid, revision])
  const url = `${publicApiOrigin()}${path}`
  const snippet = credential => requestSnippet({ format, url, body, credential, idempotencyKey: identity })
  const copyRequest = async () => {
    if (!allowed || !valid || busy) return
    const copied = await copyText(snippet(key))
    setCopyStatus(copied ? '已复制请求（含当前调用凭据），可粘贴运行；复制没有发送请求。' : '复制失败，请检查浏览器剪贴板权限后重试。')
  }
  const send = async event => {
    event.preventDefault()
    if (lock.current || !allowed || !valid) return
    lock.current = true; setBusy(true); setError(null)
    const started = performance.now()
    try {
      const response = await (batch ? publicDataApi.ipRiskBatch : publicDataApi.ipRisk)(key, body, { idempotencyKey: identity })
      setResult({ ...response, elapsedMs: Math.round(performance.now() - started), request: { ...body, idempotencyKey: identity } })
    } catch (failure) { setError(failure) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="mih-page">
    <header><h1>IP 风险画像</h1><p>查询 IPv4 的代理识别、风险评分、秒拨概率、真人概率与风险标签。</p></header>
    <div className="qp-panel mih-panel"><strong>接口调试</strong><p>当前仅记录调用次数，暂未定价、不扣费。画像是本次查询结果，不代表绝对安全。</p></div>
    <section className="mih-api-console qp-panel" aria-label="Hub IP 风险接口调试">
      <aside className="mih-api-console-nav"><h2>IP 风险接口</h2><p>使用当前 Hub Key</p>{[false, true].map(mode => <button key={String(mode)} aria-pressed={batch === mode} disabled={busy} type="button" onClick={() => { setBatch(mode); setResult(null); setError(null); setCopyStatus('') }}><small>POST</small>{mode ? '批量查询 IPv4 风险画像' : '查询 IPv4 风险画像'}</button>)}</aside>
      <div className="mih-api-console-main">
      <header><span className="mih-api-method">POST</span> <code>{path}</code><a href="#/docs?path=/docs/ip-risk">接口文档</a></header>
      {!allowed ? <div role="status" className="mih-inline-warning"><div>
        {!key ? <p>尚未选中可用的 Hub Live Key。请在上方“调用身份 / 数据产品演示身份”中选择已授权的 Key。此处使用 Hub Live Key 的授权范围。</p> : null}
        {accessIssues.map(issue => <p key={issue.scope}>{issue.message}</p>)}
        <DemoCredentialRecheck />
      </div></div> : null}
      <form onSubmit={send}>
        <h3>请求参数 · JSON Body</h3>
        <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>参数</th><th>说明</th><th>值</th></tr></thead><tbody><tr><td><code>{batch ? 'ips *' : 'ip *'}</code></td><td>{batch ? '1–100 个 IPv4，以逗号或空格分隔' : 'IPv4 地址'}</td><td><input className="qp-input" aria-label="IPv4 地址" placeholder="例如 1.1.1.1" value={ip} disabled={busy} onChange={event => { setIp(event.target.value); setResult(null); setError(null); setCopyStatus('') }} /></td></tr></tbody></table></div>
        <div className="mih-page-actions">
          <button className="qp-button qp-button--primary" disabled={!allowed || !valid || busy}>{busy ? '查询中…' : '发送请求'}</button>
          <button type="button" className="qp-button qp-button--outline" disabled={busy || !attempts.current.has(signature)} onClick={() => { attempts.current.delete(signature); setRevision(revision + 1); setResult(null); setError(null); setCopyStatus('') }}>新请求 · 再次查询同一 IP</button>
        </div>
      </form>
      <p>相同参数再次发送沿用幂等标识；“新请求”会产生新的查询。批量查询按项记录次数，最多 3 并发；60 秒预算内未执行的项目会返回错误。查询失败不会自动重试。</p>
      <section className="qp-panel mih-panel" aria-label="复制请求与请求标识">
        <h3>命令行与代码调用</h3>
        <div className="mih-page-actions">
          <DropdownField label="复制格式" value={format} options={REQUEST_FORMATS} onChange={value => { setFormat(value); setCopyStatus('') }} />
          <button type="button" className="qp-button qp-button--outline" disabled={!allowed || !valid || busy} onClick={copyRequest}>复制请求 · 含当前凭据</button>
        </div>
        <p>{expiresAt ? `复制的是当前临时调用凭据，有效至 ${new Date(expiresAt).toLocaleString()}。到期后重新复制；长期脚本请在 API Keys 获取已授权的 Live Key，替换 Authorization 的 Bearer 值。` : '复制内容包含当前 Hub Key；可直接粘贴运行，请勿公开分享。'}</p>
        <p role="status">{copyStatus}</p>
        <h4>Idempotency-Key · 请求去重标识</h4>
        <code>{identity || '填写有效 IP 后自动生成'}</code>
        <p>它不是登录密钥，也不是缓存开关。相同参数重试时保留此值：已完成的请求会回放原结果，不重复查询。修改 IP、批量顺序或项目数量，应使用新值；页面会自动处理。</p>
        <p>需要再次获取同一 IP 的新结果，点击“新请求”生成新标识，再发送或复制。结果未知时保留原标识用于核对，不要换值反复重试。命令行示例保留本页当前标识，与页面发送的是同一个请求。</p>
        <details><summary>代码预览（凭据已隐藏）</summary><pre>{snippet('<HUB_API_KEY>')}</pre></details>
      </section>
      {error ? <ErrorState error={error} /> : null}
      <h3>JSON 响应</h3>
      {result ? <><p>{result.elapsedMs} ms · 请求 {result.evidence?.requestId || (result.payload?.requestId || result.payload?.batchId)} · {result.evidence?.idempotentReplay ? '幂等回放' : '本次查询'}</p><pre className="mih-api-response">{JSON.stringify(result.payload, null, 2)}</pre></> : <p>发送请求后在此查看真实响应。</p>}
      </div>
    </section>
  </div>
}
