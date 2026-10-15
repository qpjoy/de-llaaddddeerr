import { useSyncExternalStore } from 'react'
import { adminApi, publicDataApi } from './api.js'
import { ErrorState } from './components.jsx'
import { EMPTY_TWITTER_RETRY, prepareTwitterRetry, sendTwitterRetry, checkTwitterRetry } from './twitter-request-retry.js'

const stateLabels = { sending: '发送中', not_sent: '尚未发送', uncertain: '待只读核对', reserved: '处理中', unknown: '结果未知', committed: '已提交响应', released: '预留已释放' }
export function TwitterRequestRetry({ token, run, session }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const { preparation, attempt, preparing, checking, busy, error } = snapshot.twitterRetry || EMPTY_TWITTER_RETRY
  const options = { token, requestId: run.requestId }
  const dependencies = { adminApi, publicDataApi }
  const successor = preparation?.successor
  const locked = busy || preparing || checking
  const canSend = preparation?.eligibility?.allowed === true && !successor && !attempt?.dispatched
  const request = preparation?.requestEvidence?.request
  const newRequestId = attempt?.requestId || successor?.requestId
  return <section className="mih-diagnostic-validation mih-twitter-retry qp-search-lab" aria-label="Twitter 原请求手动重试">
    <h4>按原参数重试 Twitter</h4>
    <p>原请求结果未知。此操作保留旧请求及其账单，按当前链路创建一次独立重试；原请求可能已经计费，重试可能再次计费。</p>
    {!preparation ? <>
      <button type="button" className="qp-button qp-button--outline" disabled={locked} onClick={() => prepareTwitterRetry(session, options, dependencies)}>{preparing ? '正在读取原参数…' : '准备按原参数重试 Twitter'}</button>
      <p className="mih-diagnostic-note">准备只读取已保存的接口、参数、原 Key 身份和重试资格，不发送采集请求。</p>
    </> : <>
      <p>原请求：<code>{preparation.requestId}</code><br/>原幂等键：<code>{preparation.requestEvidence?.idempotencyKey || '未记录'}</code></p>
      {request?.body && !request.bodyOmitted ? <>
      <p>{request.method} <code>{request.path}</code> · 原 Key <code>{preparation.owner?.apiKeyPrefix || preparation.owner?.apiKeyId || '未记录'}{preparation.owner?.apiKeyLastFour ? `…${preparation.owner.apiKeyLastFour}` : ''}</code></p>
      <label className="qp-field"><span className="qp-field__label">Twitter 原请求参数 JSON（只读）</span>
        <textarea className="qp-input" aria-label="Twitter 原请求参数 JSON（只读）" rows={8} value={JSON.stringify(request.body, null, 2)} readOnly/>
      </label>
      <p className="mih-diagnostic-note">使用保存的原参数及原 Key。当前权限、配额、价格、供应商路由及运行限制仍会检查。</p>
      </> : <p className="mih-diagnostic-note">原请求参数或 Key 身份不可用，无法准备新的采集请求。</p>}
      {!canSend && !attempt?.dispatched ? <p role="status">{preparation.eligibility.message || '原请求当前不符合重试条件，或已经有后续请求。'}</p> : null}
      <div className="mih-twitter-retry-actions">
        {canSend ? <button type="button" className="qp-button qp-button--primary" disabled={locked} onClick={() => sendTwitterRetry(session, options, dependencies)}>{busy ? '正在处理…' : '确认按当前链路重试（可能再次计费）'}</button> : null}
        <button type="button" className="qp-button qp-button--outline" disabled={locked} onClick={() => checkTwitterRetry(session, options, dependencies)}>{checking ? '只读核对中…' : '只读核对重试结果'}</button>
      </div>
    </>}
    {error ? <ErrorState error={error}/> : null}
    {attempt || successor ? <article className="qp-panel mih-panel" aria-live="polite">
      <h4>后续请求 · {stateLabels[attempt?.state || successor?.status] || '待核对'}</h4>
      <p>新 requestId：<code>{newRequestId || '尚未确认'}</code><br/>新幂等键：<code>{attempt?.idempotencyKey || successor?.idempotencyKey || '未记录'}</code></p>
      {attempt?.message ? <p role="status">{attempt.message}</p> : null}
      {attempt?.responseMismatch ? <p role="alert">浏览器响应与后续账本的请求 ID 或 HTTP 状态不一致。上方状态来自只读账本；下方保留收到的原始 HTTP 响应。</p> : null}
      {attempt?.dispatched ? <p className="mih-diagnostic-note">本次发送已记录。切换页面后继续保留状态，不自动重发；这里只读核对，不再创建第二笔请求。</p> : null}
      {attempt?.ledger?.responseStatus != null || successor?.responseStatus != null ? <p>账本响应 HTTP：{attempt?.ledger?.responseStatus ?? successor?.responseStatus}。已提交不代表采集成功。</p> : null}
      {newRequestId ? <p><a href={`#/data-browser?view=diagnostics&requestId=${encodeURIComponent(newRequestId)}`}>查看新请求诊断与结算 →</a></p> : null}
      {attempt?.response ? <details><summary>本次 HTTP 响应 · {attempt.response.status}</summary><pre className="qp-code-block"><code>{JSON.stringify(attempt.response.body, null, 2)}</code></pre></details> : null}
    </article> : null}
  </section>
}
