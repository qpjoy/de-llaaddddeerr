import { useEffect, useSyncExternalStore } from 'react'
import { adminApi } from './api.js'
import { ConfirmDialog, ErrorState } from './components.jsx'
import { canConfirmSearchAdmissionDisposition, searchAdmissionDispositionSessionFor } from './search-admission-disposition.js'

const EFFECT = '仅解除该历史请求对后续正常采集的阻塞，保留旧 unknown 状态和账务。不补回原页，不主动发送采集；后续调度可能产生正常费用，其他阻塞请求仍独立生效。'

export function SearchAdmissionDisposition({ token, run, session, onUnauthorized }) {
  const store = searchAdmissionDispositionSessionFor(session, token, run.requestId, adminApi)
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const { data, reason, loading, saving, confirming, outcome, attempt, error } = state
  const scope = data?.scope
  const disposition = data?.disposition
  const locked = loading || saving
  useEffect(() => { if ([401, 403].includes(error?.status)) onUnauthorized?.(error) }, [error, onUnauthorized])
  return <section className="mih-diagnostic-validation mih-twitter-retry qp-search-lab" aria-label="恢复后续正常采集">
    <h4>恢复后续正常采集</h4>
    <p>{EFFECT}</p>
    {!data ? <>
      <button type="button" className="qp-button qp-button--outline" disabled={locked} onClick={() => store.read()}>{loading ? '正在读取恢复条件…' : '查看后续采集恢复条件'}</button>
      <p className="mih-diagnostic-note">此步只读取该请求的状态、影响范围和恢复资格，不解除限制。</p>
    </> : <>
      <dl className="mih-diagnostic-facts">
        {[['历史请求', run.requestId], ['平台', scope?.platform], ['租户', scope?.tenantId],
          ['调用者', scope?.consumerId], ['原 API Key', scope?.apiKeyId], ['查询词', scope?.query]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '未记录'}</dd></div>)}
      </dl>
      {disposition ? <>
        <p role="status">{!state.checked ? '尚未核实处置当前是否有效，请只读核对。下方保留上次读取的审计记录。'
          : disposition.effective === true ? '已确认解除该历史请求的后续采集阻塞。其他阻塞请求仍可能阻挡后续采集；旧请求与账务保持原状。'
            : '已有处置记录，但原请求证据已变化，当前保护仍生效；请核对原记录，不能认定后续采集已恢复。'}</p>
        <dl className="mih-diagnostic-facts">{[['操作人', disposition.actor], ['保存时间', disposition.createdAt], ['原因', disposition.reason]].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <button type="button" className="qp-button qp-button--outline" disabled={locked} onClick={() => store.read()}>{loading ? '只读核对中…' : '只读核对解除结果与条件'}</button>
      </> : <>
        <p role="status">{data.eligibility.message || '请核对当前恢复条件。'}</p>
        {data.eligibility.allowed ? <label className="qp-field">解除阻塞的原因<textarea className="qp-input" rows={3} minLength={3} maxLength={500} value={reason} disabled={locked || outcome === 'uncertain'} onChange={event => store.setReason(event.target.value)} placeholder="请说明接受原请求结果未知、优先恢复后续采集的原因" /></label> : null}
        {outcome === 'uncertain' ? <p role="alert">操作结果尚未确认，不能认定阻塞已解除。已保留提交时的版本，请只读核对；不会再次发送解除操作。</p> : null}
        {attempt && outcome === 'uncertain' ? <p className="mih-diagnostic-note">提交版本：<code>{attempt.revision}</code></p> : null}
        <div className="mih-twitter-retry-actions">
          {data.eligibility.allowed && outcome !== 'uncertain' ? <button type="button" className="qp-button qp-button--primary" disabled={!canConfirmSearchAdmissionDisposition(state)} onClick={() => store.openConfirmation()}>解除此历史请求的阻塞…</button> : null}
          <button type="button" className="qp-button qp-button--outline" disabled={locked} onClick={() => store.read()}>{loading ? '只读核对中…' : '只读核对解除结果与条件'}</button>
        </div>
      </>}
    </>}
    {error ? <ErrorState error={error}/> : null}
    {confirming ? <ConfirmDialog title="确认恢复后续正常采集" description={EFFECT} tone="primary" busy={saving}
      confirmLabel="确认接受未知风险并解除此阻塞" onCancel={() => store.cancelConfirmation()} onConfirm={() => store.confirm()}>
      <p>历史请求：<code>{run.requestId}</code></p><p>查询词：{scope?.query}</p><p>解除原因：{reason.trim()}</p>
    </ConfirmDialog> : null}
  </section>
}
