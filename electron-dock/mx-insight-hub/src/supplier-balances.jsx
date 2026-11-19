import { useCallback, useEffect, useRef, useState } from 'react'
import { WarningCircle } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, Modal, useRemoteData } from './components.jsx'
import './supplier-balances.css'
import { MonitorScheduleEditor } from './monitor-schedule-editor.jsx'
import { DEFAULT_BALANCE_SCHEDULE, describeMonitorSchedule, normalizeMonitorSchedule } from '../shared/monitor-schedule.mjs'

const states = { ready: '已更新', pending: '等待查询', unconfigured: '未配置平台凭证', error: '查询失败', stale: '数据已过期', paused: '监控已暂停' }
const levels = { healthy: '余额充足', warning: '余额偏低', critical: '余额严重不足', unknown: '余额未知' }
const dailySpendStates = { ready: '已更新', pending: '等待建立基线', stale: '显示最近估算，当前数据未确认', paused: '日消费告警已暂停' }
const dailySpendDayStarts = [{ value: '0', label: '每天 00:00' }, { value: '10', label: '每天 10:00' }]
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
  const dailySpend = item.provider === 'tikhub' ? item.dailySpend : null
  const dailyAlerting = dailySpend?.enabled && dailySpend.exceeded
  const level = item.level === 'critical' ? 'critical' : alerting || dailyAlerting ? 'warning' : item.level
  return <section className={`mih-balance mih-balance--${level}`} aria-label={`${item.displayName} 账户余额与费用告警`}>
    <div className="mih-balance-heading"><span>供应商账户余额</span><strong>{alerting ? <WarningCircle size={16} aria-hidden="true" /> : null}{levels[item.level]}</strong></div>
    <b className="mih-balance-amount">{balanceMoney(item.balance, item.currency)}</b>
    <p className="mih-balance-state">{states[item.state]} · {describeMonitorSchedule(item.balanceSchedule ?? DEFAULT_BALANCE_SCHEDULE)}（北京时间）</p>
    <small>最近成功：{item.lastSuccessAt ? balanceDate.format(new Date(item.lastSuccessAt)) : '尚无成功查询'}</small>
    {item.nextCheckAt ? <small>下次检查：{balanceDate.format(new Date(item.nextCheckAt))}（北京时间）</small> : null}
    <small>提醒 &lt; {balanceMoney(item.warningThreshold, item.currency)} · 严重 &lt; {balanceMoney(item.criticalThreshold, item.currency)}</small>
    <small>飞书告警：{item.feishu?.configured ? `已配置 ${item.feishu?.hint}` : '未配置，仅记录到通知中心'}</small>
    {item.feishu?.configured ? <small>飞书重复提醒：{describeMonitorSchedule(item.feishuSchedule ?? { mode: 'interval', minutes: item.feishuReminderMinutes ?? 60 })}</small> : null}
    {['stale', 'error', 'paused'].includes(item.state) ? <p>显示最近已知余额，当前余额尚未确认。</p> : null}
    {item.errorCode ? <small>查询状态：{item.errorCode}</small> : null}
    {dailySpend ? <div className="mih-daily-spend">
      <div className="mih-balance-heading"><span>本统计日余额下降估算</span><strong>{dailyAlerting ? <><WarningCircle size={16} aria-hidden="true" />已超过日阈值</> : dailySpendStates[dailySpend.state]}</strong></div>
      <b className="mih-daily-spend-amount">{balanceMoney(dailySpend.amount, item.currency)}</b>
      <small>告警条件：严格超过 {balanceMoney(dailySpend.threshold, item.currency)} · 每天 {dailySpend.dayStartHour === 10 ? '10:00' : '00:00'} 重新累计（北京时间）</small>
      {dailySpend.windowStart && dailySpend.windowEnd ? <small>统计时段：{balanceDate.format(new Date(dailySpend.windowStart))} — {balanceDate.format(new Date(dailySpend.windowEnd))}</small> : null}
      {dailySpend.observedAt ? <small>最近估算：{balanceDate.format(new Date(dailySpend.observedAt))}（北京时间）{dailyAlerting ? ` · ${dailySpendStates[dailySpend.state]}` : ''}</small> : null}
      {dailySpend.partial ? <small>本时段统计不完整{dailySpend.baselineAt ? `，从 ${balanceDate.format(new Date(dailySpend.baselineAt))} 的余额基线开始` : ''}。</small> : null}
      <small>累计采样间的余额下降，非精确账单。充值不冲减已累计金额；同一采样间隔内充值抵消的消费可能少计。</small>
    </div> : null}
    {alerting || dailyAlerting ? <a href="#/notifications" className="mih-balance-link">查看费用告警与处理记录 →</a> : null}
  </section>
}

function WebhookRevealModal({ item, token, onClose, onUnauthorized }) {
  const [adminToken, setAdminToken] = useState('')
  const [revealed, setRevealed] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)
  async function reveal(event) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError(null)
    try {
      const result = await adminApi.revealSupplierBalanceWebhook(token, item.provider, adminToken)
      setRevealed(result.feishuWebhook)
    } catch (failure) { if (failure.status === 401) onUnauthorized?.(); setError(failure) }
    finally { setAdminToken(''); inFlight.current = false; setBusy(false) }
  }
  const close = () => { setAdminToken(''); setRevealed(''); onClose() }
  return <Modal title={`查看 ${item.displayName} 飞书机器人地址`} size="small" busy={busy} onClose={close}
    description="请重新输入 Hub Admin Token。地址仅在此弹窗显示，关闭后清除。"
    footer={<button className="qp-button qp-button--ghost" type="button" disabled={busy} onClick={close}>关闭并清除</button>}>
    {revealed ? <Field label="已保存的飞书机器人地址" hint="可选中完整地址并复制。">
      <textarea className="qp-input mih-balance-secret" readOnly rows={3} value={revealed} />
    </Field> : <form className="mih-balance-policy" onSubmit={reveal}>
      <Field label="重新输入 Admin Token"><input className="qp-input" type="password" autoComplete="off" autoFocus required
        disabled={busy} value={adminToken} onChange={event => setAdminToken(event.target.value)} /></Field>
      {error ? <ErrorState error={error} /> : null}
      <button className="qp-button qp-button--primary" type="submit" disabled={busy || !adminToken}>{busy ? '正在验证…' : '验证并查看'}</button>
    </form>}
  </Modal>
}

function BalancePolicyForm({ item, token, onSaved, onUnauthorized }) {
  const [enabled, setEnabled] = useState(item.enabled)
  const [warning, setWarning] = useState(decimalText(item.warningThreshold))
  const [critical, setCritical] = useState(decimalText(item.criticalThreshold))
  const [balanceSchedule, setBalanceSchedule] = useState(item.balanceSchedule ?? DEFAULT_BALANCE_SCHEDULE)
  const [feishuSchedule, setFeishuSchedule] = useState(item.feishuSchedule ?? { mode: 'interval', minutes: item.feishuReminderMinutes ?? 60 })
  const supportsDailySpend = item.provider === 'tikhub' && Boolean(item.dailySpend)
  const [dailySpendEnabled, setDailySpendEnabled] = useState(item.dailySpend?.enabled ?? true)
  const [dailySpendThreshold, setDailySpendThreshold] = useState(decimalText(item.dailySpend?.threshold ?? '30'))
  const [dailySpendDayStartHour, setDailySpendDayStartHour] = useState(String(item.dailySpend?.dayStartHour ?? 0))
  const [revealing, setRevealing] = useState(false)
  // Reveal is separate from editing: an empty box always means "leave it alone".
  const [webhook, setWebhook] = useState('')
  const [clearWebhook, setClearWebhook] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)
  async function save(event) {
    event.preventDefault()
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true); setError(null)
    try {
      const schedules = { balanceSchedule: normalizeMonitorSchedule(balanceSchedule), feishuSchedule: normalizeMonitorSchedule(feishuSchedule) }
      const changed = clearWebhook ? { feishuWebhook: '' } : webhook.trim() ? { feishuWebhook: webhook.trim() } : {}
      const dailyPolicy = supportsDailySpend ? { dailySpendEnabled, dailySpendThreshold, dailySpendDayStartHour: Number(dailySpendDayStartHour) } : {}
      await adminApi.updateSupplierBalance(token, item.provider, { enabled, warningThreshold: warning,
        criticalThreshold: critical, ...schedules, expectedRevision: item.revision, ...changed, ...dailyPolicy })
      setWebhook(''); setClearWebhook(false)
      onSaved()
    } catch (failure) { if (failure.status === 401) onUnauthorized?.(); setError(failure) }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <><form onSubmit={save} className="mih-balance-policy">
    <div className="mih-balance-fields">
      <Field label={`提醒阈值（${item.currency}）`}><input className="qp-input" inputMode="decimal" value={warning} disabled={busy} onChange={event => setWarning(event.target.value)} /></Field>
      <Field label={`严重阈值（${item.currency}）`}><input className="qp-input" inputMode="decimal" value={critical} disabled={busy} onChange={event => setCritical(event.target.value)} /></Field>
    </div>
    <MonitorScheduleEditor label="余额检查计划" value={balanceSchedule} onChange={setBalanceSchedule} disabled={busy}
      intervalHint="新间隔从保存时开始，后续沿用已存执行时间，重启不会重置。" />
    {supportsDailySpend ? <fieldset className="mih-monitor-schedule" disabled={busy}>
      <legend>TikHub 日消费告警 <small>余额下降估算 · 北京时间</small></legend>
      <label className="mih-balance-enabled"><input type="checkbox" checked={dailySpendEnabled} onChange={event => setDailySpendEnabled(event.target.checked)} />启用日消费告警</label>
      <div className="mih-balance-fields">
        <Field label="日告警阈值（USD）" hint="严格超过阈值才告警，等于阈值不告警。"><input className="qp-input" inputMode="decimal" value={dailySpendThreshold} onChange={event => setDailySpendThreshold(event.target.value)} /></Field>
        <DropdownField label="统计日起点" value={dailySpendDayStartHour} options={dailySpendDayStarts} disabled={busy} onChange={setDailySpendDayStartHour} />
      </div>
      <p>复用余额检查计划和飞书地址，累计同一账户每次采样的余额下降。充值不冲减累计金额；同一采样间隔内充值与消费可能互相抵消，估算可能少计。</p>
      <p>首次启用、更换凭据或错过统计日起点时，会标记统计不完整。此告警只发送通知，不限制 API 调用。</p>
    </fieldset> : null}
    <Field label="飞书机器人地址">
      <input className="qp-input" type="url" inputMode="url" value={webhook} disabled={busy || clearWebhook}
        placeholder={item.feishu?.configured ? `已配置 ${item.feishu?.hint} · 留空表示不修改` : '未配置，余额告警仅留在通知中心'}
        onChange={event => setWebhook(event.target.value)} />
    </Field>
    {item.feishu?.configured ? <button className="qp-button qp-button--outline" type="button" disabled={busy}
      onClick={() => setRevealing(true)}>查看已保存地址</button> : null}
    <MonitorScheduleEditor label="飞书重复提醒计划" value={feishuSchedule} onChange={setFeishuSchedule} disabled={busy}
      intervalHint="提醒间隔从上次成功发送开始计算。" />
    <label className="mih-balance-enabled"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} />启用余额监控</label>
    {item.feishu?.configured ? <label className="mih-balance-enabled"><input type="checkbox" checked={clearWebhook} disabled={busy}
      onChange={event => { setClearWebhook(event.target.checked); if (event.target.checked) setWebhook('') }} />清除飞书地址（保存后该平台不再发送群消息）</label> : null}
    <p>余额检查与飞书重复提醒独立设置，保存后生效，无需重启。刷新页面只读取已存结果。</p>
    <p>首次告警、升级为严重及确认恢复时及时通知；持续异常按提醒计划发送。固定时刻计划错过超过 5 分钟后跳过，不集中补发。</p>
    <p>按平台原币比较，严格低于阈值才告警。TikHub 的免费调用额度不计入现金余额。</p>
    {error ? <ErrorState error={error} /> : null}
    <button className="qp-button qp-button--primary" disabled={busy} type="submit">{busy ? '保存中…' : '保存监控设置'}</button>
  </form>{revealing ? <WebhookRevealModal item={item} token={token} onClose={() => setRevealing(false)} onUnauthorized={onUnauthorized} /> : null}</>
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
    {item ? <><SupplierBalanceStatus item={item} /><BalancePolicyForm key={`${token}:${provider}:${item.revision}`} item={item} token={token} onSaved={() => { setSaved(true); remote.refresh() }} onUnauthorized={onUnauthorized} /></> : null}
  </section>
}
