import { useState } from 'react'
import { ClockCounterClockwise, Coins, Database, Receipt } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { ErrorState, MetricCard, StatusBadge, formatDate, formatNumber } from './components.jsx'

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function minorAmount(value, currency) {
  if (value == null) return '—'
  const amount = Number(value)
  if (!Number.isSafeInteger(amount)) return String(value)
  return `${currency || ''} ${(amount / 100).toFixed(2)}`.trim()
}

function lineageCost(data) {
  // A cache/fallback delivery also links the older call that produced the
  // delivered snapshot. Keep that lineage visible, but do not charge its
  // historical procurement cost to this downstream request a second time.
  const calls = asArray(data?.costLineage?.providerCalls)
    .filter((call) => call.requestCall === true)
  const billedCalls = calls.filter((call) => call.billed === true)
  const pendingCount = calls.filter((call) => call.billed == null).length
  const currencies = new Set(billedCalls.map((call) => call.currency).filter(Boolean))
  const total = billedCalls.reduce((sum, call) => {
    const value = Number(call.costMinor)
    return Number.isSafeInteger(value) ? sum + value : sum
  }, 0)
  const pending = pendingCount ? ` + ${pendingCount} 次待确认` : ''
  if (currencies.size === 1) return `${minorAmount(total, [...currencies][0])}${pending}`
  if (billedCalls.length) return `${billedCalls.length} 次已计费${pending}`
  if (pendingCount) return `${pendingCount} 次待确认`
  return calls.length ? '0（均未计费）' : '—'
}

function callCost(call) {
  if (call.billed === true) return minorAmount(call.costMinor, call.currency)
  if (call.billed === false) return '未计费'
  return call.costMinor == null
    ? '计费状态未知'
    : `${minorAmount(call.costMinor, call.currency)}（待确认）`
}

function responseText(value) {
  return JSON.stringify(value, null, 2)
}

/**
 * Admin-only view of an immutable delivery. It displays the exact response
 * body previously returned to the downstream caller; the Hub does not
 * truncate, redact, normalise, or re-run the upstream request here.
 */
export function AcquisitionHistoryPanel({ token, onUnauthorized }) {
  const [requestId, setRequestId] = useState('')
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  const lookup = async (event) => {
    event.preventDefault()
    const normalized = requestId.trim()
    if (!REQUEST_ID_PATTERN.test(normalized)) {
      setData(null)
      setError(new Error('请输入完整的 Hub requestId（UUID）'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      setData(await adminApi.acquisitionHistory(token, normalized))
    } catch (lookupError) {
      setData(null)
      setError(lookupError)
      if ([401, 403].includes(lookupError?.status)) onUnauthorized?.()
    } finally {
      setLoading(false)
    }
  }

  const providerCalls = asArray(data?.costLineage?.providerCalls)
  const connectorCalls = asArray(data?.costLineage?.connectorCalls)
  const requestProviderCalls = providerCalls.filter((call) => call.requestCall === true)
  const historicalProviderSources = providerCalls.filter((call) => (
    call.requestCall !== true && call.deliveredSource === true
  ))
  const requestConnectorCalls = connectorCalls.filter((call) => call.requestCall === true)
  const items = asArray(data?.items)

  return (
    <section className="qp-panel mih-panel">
      <header className="mih-panel__header">
        <div>
          <h2>采集查询复现</h2>
          <p>按 requestId 回看当时交付的原始响应、顺序、canonical 修订与上下游计费证据；只读，不会重新调用上游。</p>
        </div>
      </header>

      <form className="mih-data-center-search" onSubmit={lookup}>
        <label className="qp-field mih-data-center-search__query">
          <span className="qp-field__label">Hub requestId</span>
          <input className="qp-input" value={requestId} spellCheck="false"
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            onChange={(event) => setRequestId(event.target.value)} />
        </label>
        <button className="qp-button" type="submit" disabled={loading}>
          {loading ? '正在查询' : '复现已交付结果'}
        </button>
      </form>

      {error ? <ErrorState error={error} /> : null}

      {data ? (
        <div className="mih-stack">
          <div className="mih-metric-grid">
            <MetricCard icon={Receipt} label="下游计费" value={minorAmount(data.customerCharge?.chargedMinor, data.customerCharge?.currency)}
              hint={data.customerCharge ? `${data.customerCharge.meterKey} · ${data.customerCharge.status}` : '本次请求无计费记录'} />
            <MetricCard icon={Coins} label="上游成本" value={lineageCost(data)}
              hint={`${formatNumber(requestProviderCalls.length)} 次本次供应商调用 · ${formatNumber(historicalProviderSources.length)} 个历史交付源 · ${formatNumber(requestConnectorCalls.length)} 次本次内部连接器调用`} />
            <MetricCard icon={Database} label="归档记录" value={formatNumber(items.length)}
              hint={`${data.scope?.platform || 'Hub'} · ${data.scope?.capability || '未声明操作'}`} />
            <MetricCard icon={ClockCounterClockwise} label="交付时间" value={formatDate(data.delivered?.completedAt)}
              hint={`${data.delivered?.sourceMode || '未知来源'} · HTTP ${data.delivered?.responseStatus || '—'}`} />
          </div>

          <dl className="mih-search-reindex__facts">
            <div><dt>请求归属</dt><dd>{data.owner?.tenantName || data.owner?.tenantId || '—'} / {data.owner?.consumerName || data.owner?.consumerId || '—'}</dd></div>
            <div><dt>交付响应哈希</dt><dd><code>{data.delivered?.responseHash || '—'}</code></dd></div>
            <div><dt>计费价格表</dt><dd>{data.customerCharge?.priceBookKey ? `${data.customerCharge.priceBookKey} · v${data.customerCharge.priceBookVersion}` : '—'}</dd></div>
            <div><dt>合同版本</dt><dd><code>{data.contractVersion || '—'}</code></dd></div>
          </dl>

          <details className="qp-search-lab" open>
            <summary><strong>当时实际交付的完整响应</strong><span className="qp-tag qp-tag--success">保持原样</span></summary>
            <div className="qp-search-lab__body">
              <pre className="qp-code-block"><code>{responseText(data.delivered?.responseBody)}</code></pre>
            </div>
          </details>

          {items.length ? (
            <div className="qp-data-table mih-table-wrap">
              <table className="mih-table" aria-label="本次查询归档记录">
                <thead><tr><th>顺序</th><th>平台 / 类型</th><th>External ID</th><th>当时 / 当前修订</th><th>观测时间</th></tr></thead>
                <tbody>{items.map((item) => (
                  <tr key={item.observationId || `${item.ordinal}:${item.externalId}`}>
                    <td>{formatNumber(item.ordinal)}</td>
                    <td><strong>{item.platform || '—'}</strong><small>{item.objectType || '—'}</small></td>
                    <td><code>{item.externalId || '—'}</code></td>
                    <td>{item.canonicalRevision || '—'} / {item.currentRevision || '—'}<small>{item.canonicalRevisionEvidence || '—'}</small></td>
                    <td>{formatDate(item.observedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : null}

          {providerCalls.length ? (
            <div className="qp-data-table mih-table-wrap">
              <table className="mih-table" aria-label="上游调用与成本证据">
                <thead><tr><th>供应商</th><th>操作 / 端点</th><th>结果</th><th>计费</th><th>时间</th></tr></thead>
                <tbody>{providerCalls.map((call) => (
                  <tr key={call.id}>
                    <td><strong>{call.providerKey}</strong><small>{call.requestCall ? '本次调用' : '历史交付源'} · {call.contractVersion || '—'} · 凭证 r{call.providerCredentialRevision ?? '—'}</small></td>
                    <td>{call.operation || '—'}<small>{call.endpointKey || '—'} · 价格表 v{call.providerPriceBookVersion ?? '—'}</small></td>
                    <td><StatusBadge status={call.outcome || 'unknown'} /> <small>HTTP {call.httpStatus || '—'}</small></td>
                    <td>{callCost(call)}<small>{call.costKind || '—'}</small></td>
                    <td>{formatDate(call.completedAt || call.startedAt)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
