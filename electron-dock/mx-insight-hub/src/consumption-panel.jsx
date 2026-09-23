import { useCallback, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, LoadingState, formatDate, useRemoteData } from './components.jsx'

const money = (minor, currency) => new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format((minor || 0) / 100)
const statuses = { reserved: '处理中', captured: '已结算', released: '已释放', unknown: '待对账' }
const kinds = { hold: '请求冻结', capture: '成功结算', release: '释放冻结' }

export function ConsumptionPanel({ token, tenantId, onUnauthorized, labelMeter = value => value }) {
  const [cursors, setCursors] = useState([null])
  const cursor = cursors.at(-1)
  const load = useCallback(() => tenantId ? adminApi.tenantConsumption(token, tenantId, { limit: 20, ...(cursor ? { cursor } : {}) }) : Promise.resolve({ items: [] }), [token, tenantId, cursor])
  const state = useRemoteData(load, onUnauthorized)
  const rows = state.data?.items || []
  return <section className="qp-panel mih-panel mih-commercial-panel" aria-label="消费记录">
    <div className="mih-page-actions"><h2>消费记录</h2><button className="qp-button qp-button--outline qp-button--sm" disabled={state.loading} onClick={state.refresh}>刷新消费记录</button></div>
    <p>每笔请求显示一次实际消费；冻结与结算步骤可展开查看。当前显示本账户各业务的记录。</p>
    {state.error ? <ErrorState error={state.error} onRetry={state.refresh} /> : null}
    {state.loading ? <LoadingState /> : <div className="qp-table-wrap mih-table-wrap"><table className="qp-table mih-table">
      <thead><tr><th>时间 / 业务</th><th>调用者</th><th>状态</th><th>实际消费</th><th>请求详情</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.id}>
        <td>{formatDate(row.createdAt)}<small>{labelMeter(row.meterKey)}</small></td>
        <td>{row.consumerName || row.consumerId}</td>
        <td>{row.enforcementMode === 'shadow' ? '试算 · ' : ''}{statuses[row.status] || row.status}{['reserved', 'unknown'].includes(row.status) ? <small>报价 {money(row.quotedMinor, row.currency)}</small> : null}</td>
        <td>{money(row.enforcementMode === 'enforced' ? row.chargedMinor : 0, row.currency)}</td>
        <td><details><summary>查看结算步骤</summary><p style={{ overflowWrap: 'anywhere' }}>请求 {row.requestId}<br />Key {row.apiKeyId}<br />{row.priceSource === 'tenant_default' ? `租户默认价 · 策略版本 ${row.billingProfileRevision}` : `价目表 ${row.priceBookKey} v${row.priceBookVersion}`}</p>
          {row.events.length ? <ul>{row.events.map(event => <li key={event.id}>{kinds[event.kind] || event.kind} · {formatDate(event.createdAt)}<br />可用变化 {money(event.availableDeltaMinor, row.currency)} / 冻结变化 {money(event.heldDeltaMinor, row.currency)}</li>)}</ul> : <p>无钱包变动（免费或试算）。</p>}
        </details></td>
      </tr>)}</tbody>
    </table>{!rows.length ? <p>暂无消费记录。默认价为 0 的免费调用可在使用记录中查看；充值和人工调整见原始账本。</p> : null}</div>}
    <div className="mih-page-actions"><button className="qp-button qp-button--outline qp-button--sm" disabled={state.loading || cursors.length === 1} onClick={() => setCursors(current => current.slice(0, -1))}>上一页</button><span>第 {cursors.length} 页</span><button className="qp-button qp-button--outline qp-button--sm" disabled={state.loading || !state.data?.pageInfo?.nextCursor} onClick={() => setCursors(current => [...current, state.data.pageInfo.nextCursor])}>下一页</button></div>
  </section>
}
