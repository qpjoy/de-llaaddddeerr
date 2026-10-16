import { diagnosticHref } from './diagnostics-navigation.js'
import { useRef, useSyncExternalStore } from 'react'
import { adminApi, publicDataApi } from './api.js'
import { ErrorState } from './components.jsx'
import { ACQUISITION_COMPARISON_PATH, PARAMETER_SOURCE_LABELS, comparisonUnavailableReason, comparisonResultMessage, createAcquisitionComparisonSession, sendAcquisitionComparison } from './acquisition-comparison.js'

export function AcquisitionComparison({ token, original, onBusyChange, session, savedOnly: requestedSavedOnly = false }) {
  const instagram = original.scope?.platform === 'instagram'
  const savedOnly = requestedSavedOnly || instagram
  // Instagram dispatch uses the App-owned diagnostic session so leaving this
  // history panel cannot discard an unknown result and unlock a new paid call.
  const diagnosticOnly = instagram && !session
  const local = useRef(null)
  if (!local.current) local.current = createAcquisitionComparisonSession(original)
  const store = session || local.current
  const { bodyText, attempts, error, busy, verified, verifying } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const unresolved = attempts.some(attempt => attempt.state === 'uncertain')
  const unavailable = comparisonUnavailableReason(original, { savedOnly })
  const path = original.requestEvidence?.request?.path || ACQUISITION_COMPARISON_PATH
  const setError = error => store.update({ error })
  const setVerifying = verifying => store.update({ verifying })
  const setVerified = verified => store.update({ verified })
  const send = retry => !diagnosticOnly && sendAcquisitionComparison(store, { token, original, retry, savedOnly, onBusyChange }, { adminApi, publicDataApi })

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
        path, body,
      })
      setVerified({ ...result, body: JSON.stringify(body) })
    } catch (caught) { setError(caught); if (caught.status === 401) onBusyChange?.(false) }
    finally { setVerifying(false) }
  }

  if (unavailable) return <p role="status">{unavailable}</p>
  return <section className="qp-search-lab mih-acquisition-comparison">
    <header><h3>{savedOnly ? '按原参数重新验证' : '新请求对比'}</h3><p>旧记录保持原样。使用原 API Key、保存的接口路径与参数，按当前权限、配额、价格和路由重新请求，可能再次计费。缓存交付不代表上游已恢复。</p></header>
    <p>原 requestId：<code>{original.requestId}</code><br />原幂等键：<code>{original.requestEvidence?.idempotencyKey || '—'}</code></p>
    <p>{original.requestEvidence?.request?.method || 'POST'} <code>{path}</code> · 原 Key <code>{original.owner.apiKeyPrefix || original.owner.apiKeyId}…{original.owner.apiKeyLastFour || ''}</code></p>
    <label className="qp-field"><span className="qp-field__label">请求参数 JSON</span><textarea className="qp-input" aria-label="请求参数 JSON" rows={9} value={bodyText} readOnly={savedOnly} disabled={busy || unresolved} onChange={event => store.update({ bodyText: event.target.value, verified: null })} placeholder={'{"platform":"xiaohongshu","keyword":"原关键词","page":1,"count":20}'} /></label>
    <p>{original.requestEvidence?.request ? (savedOnly ? '已载入保存的参数，只读展示；不会修改旧请求或跳过当前准入限制。' : '已载入保存的原参数；修改后的请求会标注为手动参数。') : '这条历史记录未保存请求体。请粘贴候选 JSON 并先校验：校验只比对指纹，不调用上游、不计费；校验通过即可证明与历史请求完全一致，未校验的手动参数不作此声明。'}</p>
    {!savedOnly && [ACQUISITION_COMPARISON_PATH, '/api/v1/search/raw'].includes(path) ? <button className="qp-button qp-button--outline" type="button" disabled={busy || verifying || !bodyText.trim()} onClick={verify}>{verifying ? '校验中…' : '校验参数是否与历史请求一致（只读，不计费）'}</button> : null}
    {verified ? <p role="status">{verified.match
      ? '校验通过：该 JSON 规范化后与历史请求指纹完全一致。'
      : verified.rejected
        ? `无法校验：${verified.rejected.message}`
        : '校验不通过：该 JSON 不是本次历史请求的参数。指纹不可逆，系统不会反推原参数。'}</p> : null}
    {error ? <ErrorState error={error} /> : null}
    {diagnosticOnly ? <p>原参数已只读展示。请到<a href={diagnosticHref(original.requestId)}>请求诊断</a>准备并发送新请求；该页面会在切换页面后继续保留未确定请求的状态。</p>
      : <button className="qp-button qp-button--primary" type="button" disabled={busy || verifying || unresolved || !bodyText.trim()} onClick={() => send()}>{busy ? '请求处理中…' : savedOnly ? '按原参数发送新请求（可能计费）' : '发送新请求并对比（可能计费）'}</button>}
    {unresolved ? <p role="alert">{instagram
      ? '未收到明确结果。请保留本次参数与幂等键，只读核查请求状态与账本。同键重发也可能再次采集和计费，此处不再发送业务请求。'
      : '未收到明确响应，结果未知。保留本次参数与幂等键；请使用下方同键查询/重试，不要重复创建新请求。'}</p> : null}
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
      {attempt.delivered?.evidence?.requestId ? <p><a href={diagnosticHref(attempt.delivered.evidence.requestId)}>查看这次新请求的诊断 →</a></p> : null}
      {attempt.delivered ? <p>{instagram && attempt.state === 'uncertain'
        ? '本次请求结果尚未确认，请只读核查诊断与账本。'
        : instagram && attempt.history?.status === 'committed'
          ? `已只读核对本次请求的提交记录：HTTP ${attempt.history.delivered.responseStatus}。下方保留浏览器收到的原始响应。`
          : comparisonResultMessage(attempt)}</p> : null}
      {attempt.message ? <p role="alert">{attempt.message}</p> : null}
      {attempt.historyError ? <p>{attempt.historyError}</p> : null}
      {attempt.retryCheck ? <details><summary>同键查询/重试 HTTP {attempt.retryCheck.status}（尚未确认原请求结果）</summary><pre className="qp-code-block"><code>{JSON.stringify(attempt.retryCheck.body, null, 2)}</code></pre></details> : null}
      {['uncertain', 'not_sent'].includes(attempt.state) && !(instagram && attempt.state === 'uncertain') ? <button className="qp-button qp-button--outline" disabled={busy || attempts.some(other => ['sending', 'uncertain'].includes(other.state) && other.idempotencyKey !== attempt.idempotencyKey)} onClick={() => send(attempt)} type="button">沿用本次幂等键查询/重试</button> : null}
      <details><summary>本次参数</summary><pre className="qp-code-block"><code>{JSON.stringify(attempt.body, null, 2)}</code></pre></details>
      {attempt.delivered ? <details open><summary>新请求完整响应（旧响应仍保留在上方）</summary><pre className="qp-code-block"><code>{JSON.stringify(attempt.delivered.body, null, 2)}</code></pre></details> : null}
      {attempt.history?.costLineage?.providerCalls?.length ? <details><summary>新请求上游调用证据</summary><pre className="qp-code-block"><code>{JSON.stringify(attempt.history.costLineage.providerCalls, null, 2)}</code></pre></details> : null}
    </article>)}
  </section>
}
