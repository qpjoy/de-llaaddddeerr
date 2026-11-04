import { diagnosticHref } from './diagnostics-navigation.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DownloadSimple, MagnifyingGlass } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { ErrorState } from './components.jsx'
import { AcquisitionComparison } from './acquisition-comparison.jsx'
import { acquisitionComparisonSessionFor } from './acquisition-comparison.js'
import { TwitterRequestRetry } from './twitter-request-retry.jsx'
import { SearchAdmissionDisposition } from './search-admission-disposition.jsx'
import { PlatformDiagnosticGuidance } from './platform-diagnostics.jsx'
import './request-diagnostics.css'

const shown = value => value == null || value === '' ? '未记录' : String(value)
const formatDate = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : '未记录'
const statuses = { committed: '已提交响应', released: '已释放', unknown: '结果未知', reserved: '已预留', rejected: '上游拒绝', succeeded: '上游成功', failed: '失败', complete: '完成', partial: '部分完成', pending: '进行中', succeeded_unusable: '上游成功但不可用', captured: '已扣款' }
const stateName = value => statuses[value] || shown(value)
function Facts({ entries }) {
  return <dl className="mih-diagnostic-facts">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{shown(value)}</dd></div>)}</dl>
}
function EvidenceAnalysis({ analysis }) {
  if (!analysis) return null
  return <section className="mih-diagnostic-analysis" aria-label="已存证据分析">
    <header><h4>已存证据分析</h4><p>依据保存的记录与固定诊断规则整理；未调用模型、实时日志或上游接口。</p></header>
    <p><strong>{analysis.summary}</strong></p>
    <div className="mih-diagnostic-findings">{analysis.findings.map((finding, index) => <article key={`${finding.code}-${index}`} className={`mih-diagnostic-finding is-${finding.certainty}`}>
      <h5><span>{finding.certainty === 'confirmed' ? '已确认' : '待核对'}</span>{finding.title}</h5>
      <p>{finding.detail}</p>
      {finding.code === 'tikhub_rate_limit_recorded' ? <p><a href="https://tikhub.io/zh/faq" target="_blank" rel="noopener noreferrer">TikHub 官方 FAQ：速率限制（RPS）</a></p> : null}
      {finding.evidenceRefs?.length ? <details><summary>证据位置</summary><ul>{finding.evidenceRefs.map(ref => <li key={ref}><code>{ref}</code></li>)}</ul></details> : null}
    </article>)}</div>
    {analysis.nextSteps.length ? <><h5>建议下一步（只读核对）</h5><ol>{analysis.nextSteps.map(step => <li key={step}>{step}</li>)}</ol></> : null}
    {analysis.semanticRelevance === 'not_assessed' ? <p className="mih-diagnostic-note">此分析不评判搜索内容与关键词的相关性；HTTP 成功不等于搜索质量已验证。</p> : null}
  </section>
}

function exportDiagnostics(data) {
  // Export only the Admin diagnostic DTO, never browser credentials or validation input.
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `hub-diagnostics-${data.identifier.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function Call({ call, provider }) {
  return <article className="mih-diagnostic-call">
    <h4>{provider ? call.provider : '连接器'} · {shown(call.operation)}</h4>
    <p><strong>{stateName(call.outcome)}</strong>{call.message ? ` · ${call.message}` : ''}</p>
    <Facts entries={[
      ['HTTP 状态', call.httpStatus], ['业务码 / 失败类别', provider ? call.businessCode : call.failureKind],
      ['错误码', call.errorCode], ['上游 requestId', call.upstreamRequestId],
      ...(!provider ? [['上游 traceId', call.upstreamTraceId]] : []),
      ['开始时间', formatDate(call.startedAt)], ['结束时间', formatDate(call.completedAt)],
      ['耗时', call.latencyMs == null ? null : `${call.latencyMs} ms`],
      ...(provider ? [['供应商实际计费', call.billed == null ? '未知' : call.billed ? '已计费' : '未计费'],
        ['采购金额（最小货币单位）', call.costMinor == null ? null : `${call.costMinor} ${call.currency || ''} · ${call.costKind || 'unknown'}`],
        ['归档证据', call.hasRestrictedArchive ? '已保存受限响应' : call.hasArchive ? '已保存响应元数据' : '未记录']] : []),
    ]}/>
    {provider && !call.message ? <p className="mih-diagnostic-note">{call.messageEvidence === 'restricted_message_not_exposed' ? '受限响应已保存；该消息尚未通过安全展示规则，界面仅展示业务码，不返回原始正文。' : '没有可展示的上游消息，不能据此推断具体根因。'}</p> : null}
    {!provider && call.failureEvidence ? <section aria-label="Night-All 错误链">
      <h4>Night-All 错误链</h4>
      <p className="mih-diagnostic-note">以下为保存的结构化证据。说明由错误码映射，不是上游原文；任意消息、参数和密钥不展示。</p>
      {call.failureEvidence.errors.map((entry, index) => <div className="mih-diagnostic-call" key={index}>
        <Facts entries={[
          ['证据位置', entry.path], ['内层错误码', entry.code], ['内层 HTTP', entry.httpStatus],
          ['候选端点', entry.endpointId], ['关联 requestId', entry.requestId],
        ]}/>
        <p>{entry.message || '该层没有已识别的错误说明；请结合关联日志核对。'}</p>
      </div>)}
      {!call.failureEvidence.errors.length ? <p>上游未提供可保存的结构化内层错误；需要关联日志。</p> : null}
      {call.failureEvidence.truncated ? <p>错误链已达到采样上限，不代表完整失败链。</p> : null}
    </section> : !provider ? <p className="mih-diagnostic-note">此历史调用未保存结构化错误链；可按上游 ID 与调用时间继续查日志。升级不会补回旧请求正文。</p> : null}
  </article>
}

function RequestValidation({ token, run, session, onUnauthorized }) {
  const { original, loading, error } = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const prepare = async () => {
    if (session.getSnapshot().loading || session.getSnapshot().original) return
    session.update({ loading: true, error: null })
    try {
      const original = await adminApi.acquisitionHistory(token, run.requestId)
      session.update({ original, bodyText: original.requestEvidence?.request?.body ? JSON.stringify(original.requestEvidence.request.body, null, 2) : '' })
    } catch (error) {
      session.update({ error })
      if ([401, 403].includes(error.status)) onUnauthorized?.(error)
    } finally { session.update({ loading: false }) }
  }
  if (run.platform === 'twitter' && run.status === 'unknown') return <>
    <SearchAdmissionDisposition {...{ token, run, session, onUnauthorized }}/>
    <TwitterRequestRetry {...{ token, run, session }}/>
  </>
  if (!run.replayAvailable) return <p className="mih-diagnostic-note">该请求尚无可复现的已提交响应，暂不支持按原参数重新验证。处理中或结果未知时，请先核对原请求结果。</p>
  if (original) return <AcquisitionComparison {...{ token, original, session }} savedOnly/>
  return <section className="mih-diagnostic-validation">
    <button type="button" className="qp-button qp-button--outline" disabled={loading} onClick={prepare}>{loading ? '正在读取原参数…' : '准备按原参数发起新请求验证'}</button>
    <p className="mih-diagnostic-note">此步只读取保存的接口、参数与原 Key 身份；查看后单独点击发送才会发起新请求，可能计费。</p>
    {error ? <ErrorState error={error}/> : null}
  </section>
}

export default function RequestDiagnostics({ token, onUnauthorized, session, setSession, comparisonSessions, autoIdentifier = '' }) {
  const current = session?.token === token ? session : { identifier: '', data: null, error: null }
  const [busy, setBusy] = useState(false)
  const active = useRef(null)
  const localComparisonSessions = useRef(null)
  useEffect(() => () => { active.current?.abort(); active.current = null }, [token])
  const update = patch => setSession(previous => ({ ...(previous?.token === token ? previous : {}), ...patch, token }))
  const lookup = async (event, requestedIdentifier = current.identifier) => {
    event?.preventDefault()
    if (active.current) return
    const identifier = (requestedIdentifier || '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(identifier)) {
      update({ data: null, error: new Error('请输入完整请求 ID，最多 191 个字母、数字、点、冒号、下划线或连字符。') })
      return
    }
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    update({ identifier, routeIdentifier: autoIdentifier, data: null, error: null })
    try {
      const data = await adminApi.requestDiagnostics(token, identifier, { signal: controller.signal })
      if (!controller.signal.aborted) update({ data, error: null })
    } catch (error) {
      if (!controller.signal.aborted) {
        update({ data: null, error })
        if ([401, 403].includes(error.status)) onUnauthorized?.(error)
      }
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false) }
    }
  }
  const lookupRef = useRef(lookup)
  lookupRef.current = lookup
  useEffect(() => {
    if (!autoIdentifier) return
    // A diagnostic deep link is a read, never a business-request retry.
    active.current?.abort()
    active.current = null
    lookupRef.current(null, autoIdentifier)
  }, [token, autoIdentifier])
  return <section className="qp-card mih-request-diagnostics" aria-labelledby="request-diagnostics-title">
    <header><h2 id="request-diagnostics-title">请求诊断</h2><p>查询只读取已保存的请求状态、上游错误与结算证据。按原参数验证需单独发送新请求，可能计费。</p></header>
    <form className="mih-diagnostic-form" onSubmit={lookup}>
      <label htmlFor="diagnostic-request-id">Hub / 上游请求 ID<input id="diagnostic-request-id" className="qp-input" value={current.identifier || ''} maxLength={191} placeholder="Hub UUID 或 Night-All req_…" onChange={event => update({ identifier: event.target.value })} /></label>
      <button className="qp-button qp-button--primary" disabled={busy || !current.identifier?.trim()}><MagnifyingGlass/>{busy ? '查询中…' : '查询诊断'}</button>
    </form>
    <p className="mih-diagnostic-note">支持 Hub 原始请求 ID，或 Hub 调用账本已保存的上游 requestId。复现操作自身的 ID、下游采集 Run 和未经过 Hub 的请求可能查不到。</p>
    <div aria-live="polite" aria-busy={busy}>
      {current.error ? <ErrorState error={current.error}/> : null}
      {current.data ? <>
        <div className="mih-diagnostic-result-heading"><p>查询 ID：<code>{current.data.identifier}</code> · {current.data.runs.length} 条关联请求 · {formatDate(current.data.checkedAt)}</p><button type="button" className="qp-button qp-button--secondary" onClick={() => exportDiagnostics(current.data)}><DownloadSimple/>导出诊断证据</button></div>
        {!current.data.runs.length ? <div className="mih-diagnostic-empty"><h3>未找到关联记录</h3><p>请核对环境、ID 类型与保留期。上游 ID 只有已被 Hub 保存才可反查；未匹配不代表请求成功，也不能证明上游未执行。</p></div> : null}
        {current.data.truncated ? <p role="status">关联请求超过 20 条，仅显示前 20 条；请使用具体 Hub requestId 查询。</p> : null}
        {current.data.runs.map(run => <article className="mih-diagnostic-run" key={run.requestId}>
          <h3>Hub 请求 <code>{run.requestId}</code></h3>
          <p><a href={diagnosticHref(run.requestId, 'limits')}>查看当前限制与恢复倒计时 →</a></p>
          <Facts entries={[
            ['平台', run.platform], ['Hub 状态', stateName(run.status)], ['响应 HTTP', run.responseStatus],
            ['Hub 错误码', run.errorCode], ['交付来源', run.sourceMode],
            ['交付复现', run.replayAvailable ? '满足复现条件' : '不满足已提交交付条件'],
            ['保存的响应', run.hasResponseBody ? '有响应（可能是错误）' : '无响应正文'],
            ['请求时间', formatDate(run.reservedAt)], ['完成时间', formatDate(run.completedAt)],
          ]}/>
          <p className="mih-diagnostic-guidance">{run.guidance}</p>
          <PlatformDiagnosticGuidance analysis={run.analysis?.platformAnalysis} requestId={run.requestId}/>
          <EvidenceAnalysis analysis={run.analysis}/>
          <RequestValidation token={token} run={run} onUnauthorized={onUnauthorized} session={acquisitionComparisonSessionFor(comparisonSessions || localComparisonSessions, token, run.requestId)}/>
          <h4>客户结算</h4>
          {run.customerCharge ? <Facts entries={[
            ['结算状态', stateName(run.customerCharge.status)], ['执行模式', run.customerCharge.enforcementMode],
            ['记录扣款（最小货币单位）', `${run.customerCharge.chargedMinor} ${run.customerCharge.currency || ''}`],
          ]}/> : <p>没有客户扣款记录；不能据此判断供应商是否计费。</p>}
          {run.customerCharge?.enforcementMode === 'shadow' ? <p className="mih-diagnostic-note">shadow 是影子计费记录，不代表实际钱包扣款。</p> : null}
          {run.refusal ? <>
            <h4>拒绝原因（熔断保护）</h4>
            <Facts entries={[
              ['问题归属', run.refusal.cause === 'upstream' ? '上游供应商' : run.refusal.cause === 'hub_response_parsing' ? 'Hub 解析' : '未找到触发记录'],
              ['供应商', run.refusal.provider], ['是否派发', '未派发，未产生供应商费用'], ['拒绝时间', formatDate(run.refusal.refusedAt)],
              ...(run.refusal.trigger ? [
                ['上游错误码', run.refusal.trigger.errorCode], ['上游 HTTP', run.refusal.trigger.httpStatus],
                ['上游业务码', run.refusal.trigger.businessCode], ['触发平台', run.refusal.trigger.marketplace],
                ['供应商计费', run.refusal.trigger.billed === false ? '未计费' : run.refusal.trigger.billed === true ? '已计费' : '未知'],
                ['触发调用', run.refusal.trigger.callId], ['失败时间', formatDate(run.refusal.trigger.failedAt)],
              ] : []),
            ]}/>
            <p className="mih-diagnostic-note">触发记录是拒绝前 {run.refusal.windowMinutes} 分钟内该供应商最近一次失败，用来说明保护为何打开，不是本请求的调用。</p>
          </> : null}
          <h4>当次上游调用</h4>
          {!run.providerCalls.length && !run.connectorCalls.length ? <p>{run.refusal ? '本请求被熔断保护拒绝，没有派发到供应商。' : '未找到当次调用记录。缓存交付、调度前拒绝或证据缺失都可能造成此情况。'}</p> : null}
          {run.providerCalls.map(call => <Call key={call.id} call={call} provider/>)}
          {run.connectorCalls.map(call => <Call key={call.id} call={call}/>)}
          {run.callsTruncated ? <p>调用记录过多，每类仅显示前 50 条，以上不是完整调用链。</p> : null}
        </article>)}
      </> : !busy && !current.error ? <div className="mih-diagnostic-empty">输入请求 ID 后查询。失败、处理中和已交付的请求均可查看。</div> : null}
    </div>
  </section>
}
