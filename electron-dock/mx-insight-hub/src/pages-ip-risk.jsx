import { REQUEST_FORMATS, requestSnippet } from './request-snippets.js'
import { copyText } from './open-capabilities.js'
import { useRef, useState } from 'react'
import { useDemoApiKey, useDemoAccessSnapshot, DemoCredentialRecheck, useDemoCredentialExpiry } from './demo-credentials.jsx'
import { publicDataApi, publicApiOrigin } from './api.js'
import { DropdownField, ErrorState } from './components.jsx'
import { ipRiskAccessIssues } from './demo-access.js'

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
  const values = batch ? ip.trim().split(/[\s,，]+/u).filter(Boolean) : [ip.trim()]
  const valid = values.length > 0 && values.length <= 100 && values.every(value => /^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value) && value.split('.').every(part => Number(part) <= 255 && String(Number(part)) === part))
  const body = batch ? { ips: values } : { ip: ip.trim() }
  const path = batch ? '/api/v1/data/ip/risk/batch' : '/api/v1/data/ip/risk'
  const url = `${publicApiOrigin()}${path}`
  const snippet = credential => requestSnippet({ format, url, body, credential })
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
      const response = await (batch ? publicDataApi.ipRiskBatch : publicDataApi.ipRisk)(key, body)
      setResult({ ...response, elapsedMs: Math.round(performance.now() - started), request: body })
    } catch (failure) { setError(failure) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="mih-page">
    <header><h1>IP 风险画像</h1><p>查询 IPv4 的代理识别、风险评分、秒拨概率、真人概率与风险标签。</p></header>
    <div className="qp-panel mih-panel"><strong>接口调试</strong><p>按当前调用者生效套餐计费，实际费用见“用量与账单”。批量按成功交付的 IP 逐项计费。画像是本次查询结果，不代表绝对安全。</p></div>
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
        </div>
      </form>
      <p>每次点击“发送请求”都会发起一次新查询并计入用量，重复查询同一 IP 也会计数。批量按每个 IP 计数；达到次数或频率限制时返回 429。查询失败不会自动重试。</p>
      <section className="qp-panel mih-panel" aria-label="复制请求与请求标识">
        <h3>命令行与代码调用</h3>
        <div className="mih-page-actions">
          <DropdownField label="复制格式" value={format} options={REQUEST_FORMATS} onChange={value => { setFormat(value); setCopyStatus('') }} />
          <button type="button" className="qp-button qp-button--outline" disabled={!allowed || !valid || busy} onClick={copyRequest}>复制请求 · 含当前凭据</button>
        </div>
        <p>{expiresAt ? `复制的是当前临时调用凭据，有效至 ${new Date(expiresAt).toLocaleString()}。到期后重新复制；长期脚本请在 API Keys 获取已授权的 Live Key，替换 Authorization 的 Bearer 值。` : '复制内容包含当前 Hub Key；可直接粘贴运行，请勿公开分享。'}</p>
        <p role="status">{copyStatus}</p>
        <p>复制命令可直接调用，无需填写请求去重标识。每次运行都是新请求；若返回结果未知，请保留响应中的请求编号用于核对，避免连续重试。</p>
        <details><summary>代码预览（凭据已隐藏）</summary><pre>{snippet('<HUB_API_KEY>')}</pre></details>
      </section>
      {error ? <ErrorState error={error} /> : null}
      <h3>JSON 响应</h3>
      {result ? <><p>{result.elapsedMs} ms · 请求 {result.evidence?.requestId || (result.payload?.requestId || result.payload?.batchId)} · {result.evidence?.idempotentReplay ? '幂等回放' : '本次查询'}</p><pre className="mih-api-response">{JSON.stringify(result.payload, null, 2)}</pre></> : <p>发送请求后在此查看真实响应。</p>}
      </div>
    </section>
  </div>
}
