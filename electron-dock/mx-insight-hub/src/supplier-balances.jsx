import { useCallback, useEffect, useRef, useState } from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { ErrorState, Field, useRemoteData } from './components.jsx'
import './supplier-balances.css'

const states = { ready: '已更新', pending: '等待查询', unconfigured: '未配置平台凭证', error: '查询失败', stale: '数据已过期', paused: '监控已暂停' }
const levels = { healthy: '余额充足', warning: '余额偏低', critical: '余额严重不足', unknown: '余额未知' }
const balanceDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const decimalText = value => String(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
export const balanceMoney = (amount, currency) => amount == null ? '未知'
  : `${currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''}${decimalText(amount)} ${currency}`

export function useSupplierBalances(token, onUnauthorized) {
  const load = useCallback(() => adminApi.supplierBalances(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const refresh = remote.refresh
  useEffect(() => {
    // Poll cached Hub evidence only. Page visits never trigger supplier reads.
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 60_000)
    return () => clearInterval(timer)
  }, [refresh])
  return remote
}

export function SupplierBalanceStatus({ item }) {
  if (!item) return null
  const alerting = item.level === 'warning' || item.level === 'critical'
  return <section className={`mih-balance mih-balance--${item.level}`} aria-label={`${item.displayName} 账户余额`}>
    <div className="mih-balance-heading"><span>供应商账户余额</span><strong>{alerting ? <WarningCircle size={16} aria-hidden="true" /> : null}{levels[item.level]}</strong></div>
    <b className="mih-balance-amount">{balanceMoney(item.balance, item.currency)}</b>
    <p className="mih-balance-state">{states[item.state]} · 每天 10:00、22:00 检查（北京时间）</p>
    <small>最近成功：{item.lastSuccessAt ? balanceDate.format(new Date(item.lastSuccessAt)) : '尚无成功查询'}</small>
    {item.nextCheckAt ? <small>下次检查：{balanceDate.format(new Date(item.nextCheckAt))}（北京时间）</small> : null}
    <small>提醒 &lt; {balanceMoney(item.warningThreshold, item.currency)} · 严重 &lt; {balanceMoney(item.criticalThreshold, item.currency)}</small>
    {['stale', 'error', 'paused'].includes(item.state) ? <p>显示最近已知余额，当前余额尚未确认。</p> : null}
    {item.errorCode ? <small>查询状态：{item.errorCode}</small> : null}
    {alerting ? <a href="#/notifications" className="mih-balance-link">查看费用告警与处理记录 →</a> : null}
  </section>
}

function BalancePolicyForm({ item, token, onSaved, onUnauthorized }) {
  const [enabled, setEnabled] = useState(item.enabled)
  const [warning, setWarning] = useState(decimalText(item.warningThreshold))
  const [critical, setCritical] = useState(decimalText(item.criticalThreshold))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)
  async function save(event) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError(null)
    try {
      await adminApi.updateSupplierBalance(token, item.provider, { enabled, warningThreshold: warning,
        criticalThreshold: critical, expectedRevision: item.revision })
      onSaved()
    } catch (failure) { if (failure.status === 401) onUnauthorized?.(); setError(failure) }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <form onSubmit={save} className="mih-balance-policy">
    <div className="mih-balance-fields">
      <Field label={`提醒阈值（${item.currency}）`}><input className="qp-input" inputMode="decimal" value={warning} disabled={busy} onChange={event => setWarning(event.target.value)} /></Field>
      <Field label={`严重阈值（${item.currency}）`}><input className="qp-input" inputMode="decimal" value={critical} disabled={busy} onChange={event => setCritical(event.target.value)} /></Field>
    </div>
    <label className="mih-balance-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />启用余额监控</label>
    <p>固定北京时间每天 10:00、22:00 各检查一次。保存设置后等待下一个检查时刻。</p>
    <p>按平台原币比较，严格低于阈值才告警。TikHub 的免费调用额度不计入现金余额。</p>
    {error ? <ErrorState error={error} /> : null}
    <button className="qp-button qp-button--primary" disabled={busy} type="submit">{busy ? '保存中…' : '保存监控设置'}</button>
  </form>
}

export function SupplierBalancePanel({ token, provider, onUnauthorized }) {
  const remote = useSupplierBalances(token, onUnauthorized)
  const [saved, setSaved] = useState(false)
  const item = remote.data?.items?.find(entry => entry.provider === provider)
  if (!item && !remote.error) return null
  return <section className="qp-panel mih-panel mih-balance-panel">
    <header><h2>账户余额与费用告警</h2><button className="qp-button qp-button--ghost" onClick={remote.refresh}>刷新已存结果</button></header>
    {remote.error ? <ErrorState error={remote.error} onRetry={remote.refresh} /> : null}
    {saved ? <p role="status">监控设置已保存，后台将按新设置检查。</p> : null}
    {item ? <><SupplierBalanceStatus item={item} /><BalancePolicyForm key={`${provider}:${item.revision}`} item={item} token={token} onSaved={() => { setSaved(true); remote.refresh() }} onUnauthorized={onUnauthorized} /></> : null}
  </section>
}
