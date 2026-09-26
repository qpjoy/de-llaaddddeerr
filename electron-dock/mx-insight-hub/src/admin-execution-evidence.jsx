import { useEffect, useState } from 'react'
import { adminApi } from './api.js'
import { useAdminExecution } from './demo-credentials.jsx'
import { ErrorState } from './components.jsx'

const amount = (minor, currency) => minor == null ? '金额未知' : `${currency || '币种未知'} ${minor}（最小货币单位）`
export function AdminExecutionEvidence({ requestId, aggregate = false }) {
  const admin = useAdminExecution()
  const [data, setData] = useState(null), [error, setError] = useState(null)
  useEffect(() => {
    let active = true
    setData(null); setError(null)
    if (admin && requestId) (aggregate ? adminApi.aggregateDiagnostics : adminApi.requestDiagnostics)(admin.token, requestId)
      .then(value => { if (active) setData(value) }).catch(failure => { if (active) setError(failure) })
    return () => { active = false }
  }, [admin?.token, admin?.keyId, requestId, aggregate])
  if (!admin || !requestId) return null
  const rows = aggregate ? data?.sources : data?.runs
  return <details className="qp-panel mih-panel mih-admin-evidence" open><summary>Admin 调用证据 · 上游、费用与目录</summary>
    <p>请求 {requestId} · <a href={`#/data-browser?view=diagnostics&requestId=${encodeURIComponent(requestId)}`}>请求诊断</a></p>
    {error ? <ErrorState error={error} /> : !data ? <p role="status">正在读取已记录的调用证据…</p> : <>
      <p>{data.note || '显示已记录的采购成本与客户结算；未知金额不会按零处理。'}</p>
      {aggregate ? <p>聚合父请求：{data.parent?.billing === 'non_billable_aggregate_parent' ? '不另计费，各来源分别结算。' : data.parent?.customerCharge ? `${data.parent.customerCharge.status} · ${amount(data.parent.customerCharge.chargedMinor, data.parent.customerCharge.currency)}` : '已收录检索，暂无客户结算凭证。'}</p> : null}
      {(rows || []).map((row, index) => <section key={row.id || row.requestId || index}>
        <h3>{row.label || row.platform || '本次调用'} · {row.status}</h3>
        {aggregate ? <p>目录：{row.catalogEntries?.length ? row.catalogEntries.map(entry => entry.name).join('、') : '尚无目录映射'} · <a href="#/source-catalog?section=connections">查看目录接入情况</a></p> : null}
        <p>客户结算：{row.customerCharge ? `${row.customerCharge.status} · ${amount(row.customerCharge.chargedMinor, row.customerCharge.currency)}（报价 ${amount(row.customerCharge.quotedMinor, row.customerCharge.currency)}）` : '未记录客户收费凭证'}</p>
        {row.providerCalls?.length ? <div className="qp-table-wrap"><table className="qp-table"><thead><tr><th>实际供应商 / 接口</th><th>结果</th><th>采购成本</th><th>耗时</th></tr></thead><tbody>{row.providerCalls.map(call => <tr key={call.id}><td>{call.provider} · {call.operation}<br /><code>{call.endpoint}</code></td><td>{call.outcome} · {call.billed === true ? '已计费' : call.billed === false ? '未计费' : '计费未知'}</td><td>{amount(call.costMinor, call.currency)} · {call.costKind || '未知'}</td><td>{call.latencyMs ?? '—'} ms</td></tr>)}</tbody></table></div> : <p>{row.connectorCalls?.length ? '由 Night-All 连接器处理；内部上游与采购成本未在 Hub 记录。' : '暂无已记录的上游调用；不能据此推断为免费或未执行。'}</p>}
        {row.callsTruncated ? <p>调用证据已达到展示上限，请在请求诊断中进一步核对。</p> : null}
      </section>)}
    </>}
  </details>
}
