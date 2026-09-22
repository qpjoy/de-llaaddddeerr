import { useEffect, useRef, useState } from 'react'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { ErrorState } from './components.jsx'
import './request-diagnostics.css'

const shown = value => value == null || value === '' ? '未记录' : String(value)
const formatDate = value => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toISOString().replace('T', ' ').replace('Z', ' UTC') : '未记录'
const statuses = { committed: '已提交响应', released: '已释放', unknown: '结果未知', reserved: '已预留', rejected: '上游拒绝', succeeded: '上游成功', failed: '失败', complete: '完成', partial: '部分完成', pending: '进行中', succeeded_unusable: '上游成功但不可用', captured: '已扣款' }
const stateName = value => statuses[value] || shown(value)
function Facts({ entries }) {
  return <dl className="mih-diagnostic-facts">{entries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{shown(value)}</dd></div>)}</dl>
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
    {!provider ? <p className="mih-diagnostic-note">此连接器的完整错误正文未接入诊断；可按上游 ID 与调用时间继续查日志。</p> : null}
  </article>
}

export default function RequestDiagnostics({ token, onUnauthorized, session, setSession }) {
  const current = session?.token === token ? session : { identifier: '', data: null, error: null }
  const [busy, setBusy] = useState(false)
  const active = useRef(null)
  useEffect(() => () => { active.current?.abort(); active.current = null }, [token])
  const update = patch => setSession(previous => ({ ...(previous?.token === token ? previous : {}), ...patch, token }))
  const lookup = async event => {
    event.preventDefault()
    if (active.current) return
    const identifier = (current.identifier || '').trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,190}$/.test(identifier)) {
      update({ data: null, error: new Error('请输入完整请求 ID，最多 191 个字母、数字、点、冒号、下划线或连字符。') })
      return
    }
    const controller = new AbortController()
    active.current = controller
    setBusy(true)
    update({ data: null, error: null })
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
  return <section className="qp-card mih-request-diagnostics" aria-labelledby="request-diagnostics-title">
    <header><h2 id="request-diagnostics-title">请求诊断</h2><p>管理员只读查询 · 查看已保存的请求状态、上游错误与结算证据，不触发采集或重试。</p></header>
    <form className="mih-diagnostic-form" onSubmit={lookup}>
      <label htmlFor="diagnostic-request-id">Hub / 上游请求 ID<input id="diagnostic-request-id" className="qp-input" value={current.identifier || ''} maxLength={191} placeholder="Hub UUID 或 Night-All req_…" onChange={event => update({ identifier: event.target.value })} /></label>
      <button className="qp-button qp-button--primary" disabled={busy || !current.identifier?.trim()}><MagnifyingGlass/>{busy ? '查询中…' : '查询诊断'}</button>
    </form>
    <p className="mih-diagnostic-note">支持 Hub 原始请求 ID，或 Hub 调用账本已保存的上游 requestId。复现操作自身的 ID、下游采集 Run 和未经过 Hub 的请求可能查不到。</p>
    <div aria-live="polite" aria-busy={busy}>
      {current.error ? <ErrorState error={current.error}/> : null}
      {current.data ? <>
        <p>查询 ID：<code>{current.data.identifier}</code> · {current.data.runs.length} 条关联请求 · {formatDate(current.data.checkedAt)}</p>
        {!current.data.runs.length ? <div className="mih-diagnostic-empty"><h3>未找到关联记录</h3><p>请核对环境、ID 类型与保留期。上游 ID 只有已被 Hub 保存才可反查；未匹配不代表请求成功，也不能证明上游未执行。</p></div> : null}
        {current.data.truncated ? <p role="status">关联请求超过 20 条，仅显示前 20 条；请使用具体 Hub requestId 查询。</p> : null}
        {current.data.runs.map(run => <article className="mih-diagnostic-run" key={run.requestId}>
          <h3>Hub 请求 <code>{run.requestId}</code></h3>
          <Facts entries={[
            ['平台', run.platform], ['Hub 状态', stateName(run.status)], ['响应 HTTP', run.responseStatus],
            ['Hub 错误码', run.errorCode], ['交付来源', run.sourceMode],
            ['交付复现', run.replayAvailable ? '满足复现条件' : '不满足已提交交付条件'],
            ['保存的响应', run.hasResponseBody ? '有响应（可能是错误）' : '无响应正文'],
            ['请求时间', formatDate(run.reservedAt)], ['完成时间', formatDate(run.completedAt)],
          ]}/>
          <p className="mih-diagnostic-guidance">{run.guidance}</p>
          <h4>客户结算</h4>
          {run.customerCharge ? <Facts entries={[
            ['结算状态', stateName(run.customerCharge.status)], ['执行模式', run.customerCharge.enforcementMode],
            ['记录扣款（最小货币单位）', `${run.customerCharge.chargedMinor} ${run.customerCharge.currency || ''}`],
          ]}/> : <p>没有客户扣款记录；不能据此判断供应商是否计费。</p>}
          {run.customerCharge?.enforcementMode === 'shadow' ? <p className="mih-diagnostic-note">shadow 是影子计费记录，不代表实际钱包扣款。</p> : null}
          <h4>当次上游调用</h4>
          {!run.providerCalls.length && !run.connectorCalls.length ? <p>未找到当次调用记录。缓存交付、调度前拒绝或证据缺失都可能造成此情况。</p> : null}
          {run.providerCalls.map(call => <Call key={call.id} call={call} provider/>)}
          {run.connectorCalls.map(call => <Call key={call.id} call={call}/>)}
          {run.callsTruncated ? <p>调用记录过多，每类仅显示前 50 条，以上不是完整调用链。</p> : null}
        </article>)}
      </> : !busy && !current.error ? <div className="mih-diagnostic-empty">输入请求 ID 后查询。失败、处理中和已交付的请求均可查看。</div> : null}
    </div>
  </section>
}
