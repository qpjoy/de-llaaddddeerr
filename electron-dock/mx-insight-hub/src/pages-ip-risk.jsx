import { useRef, useState } from 'react'
import { useDemoApiKey, useDemoAccessSnapshot, DemoCredentialRecheck } from './demo-credentials.jsx'
import { publicDataApi } from './api.js'
import { ErrorState } from './components.jsx'
import { ipRiskAccessIssues } from './demo-access.js'
import { requestUuid } from './request-id.js'

export function IpRiskPage() {
  const [key] = useDemoApiKey()
  const access = useDemoAccessSnapshot()
  const accessIssues = ipRiskAccessIssues(access)
  const allowed = !!key && accessIssues.length === 0
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
  const send = async event => {
    event.preventDefault()
    if (lock.current || !allowed || !valid) return
    lock.current = true; setBusy(true); setError(null)
    const value = signature
    const identity = attempts.current.get(value) || `ip-risk-${requestUuid()}`
    attempts.current.set(value, identity)
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
      <aside className="mih-api-console-nav"><h2>IP 风险接口</h2><p>使用当前 Hub Key</p>{[false, true].map(mode => <button key={String(mode)} aria-pressed={batch === mode} disabled={busy} type="button" onClick={() => { setBatch(mode); setResult(null); setError(null) }}><small>POST</small>{mode ? '批量查询 IPv4 风险画像' : '查询 IPv4 风险画像'}</button>)}</aside>
      <div className="mih-api-console-main">
      <header><span className="mih-api-method">POST</span> <code>{path}</code><a href="#/docs?path=/docs/ip-risk">接口文档</a></header>
      {!allowed ? <div role="status" className="mih-inline-warning"><div>
        {!key ? <p>尚未选中可用的 Hub Live Key。请在上方“调用身份 / 数据产品演示身份”中选择已授权的 Key。此处使用 Hub Live Key 的授权范围。</p> : null}
        {accessIssues.map(issue => <p key={issue.scope}>{issue.message}</p>)}
        <DemoCredentialRecheck />
      </div></div> : null}
      <form onSubmit={send}>
        <h3>请求参数 · JSON Body</h3>
        <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>参数</th><th>说明</th><th>值</th></tr></thead><tbody><tr><td><code>{batch ? 'ips *' : 'ip *'}</code></td><td>{batch ? '1–100 个 IPv4，以逗号或空格分隔' : 'IPv4 地址'}</td><td><input className="qp-input" aria-label="IPv4 地址" placeholder="例如 1.1.1.1" value={ip} disabled={busy} onChange={event => { setIp(event.target.value); setResult(null); setError(null) }} /></td></tr></tbody></table></div>
        <div className="mih-page-actions">
          <button className="qp-button qp-button--primary" disabled={!allowed || !valid || busy}>{busy ? '查询中…' : '发送请求'}</button>
          <button type="button" className="qp-button qp-button--outline" disabled={busy || !attempts.current.has(signature)} onClick={() => { attempts.current.delete(signature); setRevision(revision + 1); setResult(null); setError(null) }}>新请求 · 再次查询同一 IP</button>
        </div>
      </form>
      <p>相同参数再次发送沿用幂等标识；“新请求”会产生新的查询。批量查询按项记录次数，最多 3 并发；60 秒预算内未执行的项目会返回错误。查询失败不会自动重试。</p>
      <details><summary>请求预览（密钥不显示）</summary><pre>{JSON.stringify({ method: 'POST', path, body }, null, 2)}</pre></details>
      {error ? <ErrorState error={error} /> : null}
      <h3>JSON 响应</h3>
      {result ? <><p>{result.elapsedMs} ms · 请求 {result.evidence?.requestId || (result.payload?.requestId || result.payload?.batchId)} · {result.evidence?.idempotentReplay ? '幂等回放' : '本次查询'}</p><pre className="mih-api-response">{JSON.stringify(result.payload, null, 2)}</pre></> : <p>发送请求后在此查看真实响应。</p>}
      </div>
    </section>
  </div>
}
