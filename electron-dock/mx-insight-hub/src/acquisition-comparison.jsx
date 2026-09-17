import { useRef, useState } from 'react'
import { adminApi, publicDataApi } from './api.js'
import { ErrorState } from './components.jsx'
import { ACQUISITION_COMPARISON_PATH, PARAMETER_SOURCE_LABELS, canCompareAcquisition, createAcquisitionComparison, comparisonOutcome } from './acquisition-comparison.js'

export function AcquisitionComparison({ token, original, onBusyChange }) {
  const [bodyText, setBodyText] = useState(() => original.requestEvidence?.request
    ? JSON.stringify(original.requestEvidence.request.body, null, 2) : '')
  const [attempts, setAttempts] = useState([])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  // A verified body is one that reproduced the historical request fingerprint,
  // which is the only proof available for a run recorded without its body.
  const [verified, setVerified] = useState(null)
  const [verifying, setVerifying] = useState(false)
  const lock = useRef(false)
  const last = attempts.at(-1)
  const unresolved = last?.state === 'uncertain'
  const supported = canCompareAcquisition(original)

  const patch = (idempotencyKey, values) => setAttempts(current => current.map(attempt => (
    attempt.idempotencyKey === idempotencyKey ? { ...attempt, ...values } : attempt
  )))

  const send = async (retry = null) => {
    if (lock.current) return
    let attempt
    try {
      attempt = retry || createAcquisitionComparison(original, bodyText, `compare-${crypto.randomUUID()}`, {
        verifiedBody: verified?.match ? verified.body : null,
      })
    } catch (caught) { setError(caught); return }
    lock.current = true
    setBusy(true)
    onBusyChange(true)
    setError(null)
    if (!retry) setAttempts(current => [...current, { ...attempt, state: 'sending' }])
    else patch(attempt.idempotencyKey, { state: 'sending' })
    let dispatched = false
    let delivered
    try {
      const identity = await adminApi.demoCredential(token, attempt.keyId)
      if (!identity.secret || identity.keyId !== attempt.keyId) throw new Error('原 API Key 已不可用，无法以原身份重新请求。')
      dispatched = true
      try {
        const result = await publicDataApi.acquisitionComparison(identity.secret, attempt.body, attempt.idempotencyKey)
        delivered = { status: result.status, body: result.payload, evidence: result.evidence }
      } catch (caught) {
        if (!caught.status) throw caught
        delivered = { status: caught.status, body: caught.responseBody, evidence: caught.evidence || { requestId: caught.requestId } }
      }
      patch(attempt.idempotencyKey, { state: comparisonOutcome(delivered), delivered, message: null })
      // History reads enrich the comparison; a lookup failure never replays the write.
      if (delivered.evidence?.requestId) {
        try {
          const history = await adminApi.acquisitionHistory(token, delivered.evidence.requestId)
          patch(attempt.idempotencyKey, { history })
        } catch {
          patch(attempt.idempotencyKey, { historyError: '该请求暂无可读取的持久化交付记录；本次 HTTP 响应仍保留在下方。' })
        }
      }
    } catch (caught) {
      patch(attempt.idempotencyKey, { state: dispatched || retry?.state === 'uncertain' ? 'uncertain' : 'not_sent', message: caught.message })
    } finally {
      lock.current = false
      setBusy(false)
      onBusyChange(false)
    }
  }

  // Read-only: it recomputes a fingerprint server-side and never dispatches.
  const verify = async () => {
    if (busy || verifying) return
    let body
    try { body = JSON.parse(bodyText) } catch { setError(new Error('请输入有效的原请求 JSON。')); return }
    setVerifying(true)
    setError(null)
    setVerified(null)
    try {
      const result = await adminApi.verifyAcquisitionRequest(token, original.requestId, {
        path: ACQUISITION_COMPARISON_PATH, body,
      })
      setVerified({ ...result, body: JSON.stringify(body) })
    } catch (caught) { setError(caught); if (caught.status === 401) onBusyChange(false) }
    finally { setVerifying(false) }
  }

  if (!supported) return <p>当前记录不支持参数重发；保留只读复现。现支持 TikHub 小红书单关键词 raw 搜索。</p>
  return <section className="qp-search-lab mih-acquisition-comparison">
    <header><h3>新请求对比</h3><p>旧记录保持原样。使用原 API Key 的当前权限、配额与价格重新请求，可能再次计费；新幂等键不保证一定调用上游，仍遵循现有缓存与路由策略。</p></header>
    <p>原 requestId：<code>{original.requestId}</code><br />原幂等键：<code>{original.requestEvidence?.idempotencyKey || '—'}</code></p>
    <p>POST <code>{ACQUISITION_COMPARISON_PATH}</code> · 原 Key <code>{original.owner.apiKeyPrefix || original.owner.apiKeyId}…{original.owner.apiKeyLastFour || ''}</code></p>
    <label className="qp-field"><span className="qp-field__label">请求参数 JSON</span><textarea className="qp-input" aria-label="请求参数 JSON" rows={9} value={bodyText} disabled={busy || unresolved} onChange={event => setBodyText(event.target.value)} placeholder={'{"platform":"xiaohongshu","keyword":"原关键词","page":1,"count":20}'} /></label>
    <p>{original.requestEvidence?.request ? '已载入保存的原参数；修改后的请求会标注为手动参数。' : '这条历史记录未保存请求体。请粘贴候选 JSON 并先校验：校验只比对指纹，不调用上游、不计费；校验通过即可证明与历史请求完全一致，未校验的手动参数不作此声明。'}</p>
    <button className="qp-button qp-button--outline" type="button" disabled={busy || verifying || !bodyText.trim()} onClick={verify}>{verifying ? '校验中…' : '校验参数是否与历史请求一致（只读，不计费）'}</button>
    {verified ? <p role="status">{verified.match
      ? '校验通过：该 JSON 规范化后与历史请求指纹完全一致。'
      : verified.rejected
        ? `无法校验：${verified.rejected.message}`
        : '校验不通过：该 JSON 不是本次历史请求的参数。指纹不可逆，系统不会反推原参数。'}</p> : null}
    {error ? <ErrorState error={error} /> : null}
    <button className="qp-button qp-button--primary" type="button" disabled={busy || unresolved || !bodyText.trim()} onClick={() => send()}>{busy ? '请求处理中…' : '发送新请求并对比（可能计费）'}</button>
    {unresolved ? <p role="alert">未收到明确响应，结果未知。保留本次参数与幂等键；请使用下方同键查询/重试，不要重复创建新请求。</p> : null}
    {attempts.map((attempt, index) => <article className="qp-panel mih-panel" key={attempt.idempotencyKey}>
      <h4>对比请求 {index + 1} · {PARAMETER_SOURCE_LABELS[attempt.parameterSource] || '手动参数'}</h4>
      <dl className="mih-search-reindex__facts">
        <div><dt>原 requestId</dt><dd><code>{attempt.originalRequestId}</code></dd></div>
        <div><dt>新 requestId</dt><dd><code>{attempt.delivered?.evidence?.requestId || (attempt.state === 'sending' ? '等待响应' : '尚未获得')}</code></dd></div>
        <div><dt>新幂等键</dt><dd><code>{attempt.idempotencyKey}</code></dd></div>
        <div><dt>交付</dt><dd>{attempt.delivered ? `HTTP ${attempt.delivered.status} · ${attempt.history?.delivered?.sourceMode || attempt.delivered.evidence?.sourceMode || '来源待确认'} · ${attempt.delivered.evidence?.idempotentReplay ? '幂等回放' : '本次响应'}` : attempt.state === 'not_sent' ? '未发送业务请求' : attempt.state === 'uncertain' ? '结果未知' : '处理中'}</dd></div>
        <div><dt>原 → 新下游费用（分）</dt><dd>{original.customerCharge ? `${original.customerCharge.currency} ${original.customerCharge.chargedMinor} / ${original.customerCharge.status}` : '无记录'} → {attempt.history?.customerCharge ? `${attempt.history.customerCharge.currency} ${attempt.history.customerCharge.chargedMinor} / ${attempt.history.customerCharge.status}` : '尚无结算记录'}</dd></div>
        <div><dt>原 → 新 HTTP</dt><dd>{original.delivered?.responseStatus || '—'} → {attempt.delivered?.status || '—'}</dd></div>
      </dl>
      {attempt.message ? <p role="alert">{attempt.message}</p> : null}
      {attempt.historyError ? <p>{attempt.historyError}</p> : null}
      {['uncertain', 'not_sent'].includes(attempt.state) ? <button className="qp-button qp-button--outline" disabled={busy} onClick={() => send(attempt)} type="button">沿用本次幂等键查询/重试</button> : null}
      <details><summary>本次参数</summary><pre className="qp-code-block"><code>{JSON.stringify(attempt.body, null, 2)}</code></pre></details>
      {attempt.delivered ? <details open><summary>新请求完整响应（旧响应仍保留在上方）</summary><pre className="qp-code-block"><code>{JSON.stringify(attempt.delivered.body, null, 2)}</code></pre></details> : null}
      {attempt.history?.costLineage?.providerCalls?.length ? <details><summary>新请求上游调用证据</summary><pre className="qp-code-block"><code>{JSON.stringify(attempt.history.costLineage.providerCalls, null, 2)}</code></pre></details> : null}
    </article>)}
  </section>
}
