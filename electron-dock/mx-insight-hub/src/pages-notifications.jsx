import { useCallback, useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, LoadingState, Modal, PageHeading, useRemoteData } from './components.jsx'
import './notifications.css'
import { balanceMoney } from './supplier-balances.jsx'

const categories = { 'supplier.cost': '费用告警 · 账户余额', 'upstream.balance': '供应商 · 余额耗尽错误', 'upstream.token_limit': '供应商 · Token 限额' }
const statuses = { open: '待处理', acknowledged: '已确认', closed: '已关闭' }
const timestamp = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'Asia/Shanghai' })
const date = (value) => value ? timestamp.format(new Date(value)) : '尚无记录'
const sourceLabels = { observed: '上游失败', acknowledged: '管理员确认', closed: '管理员关闭', balance_observed: '余额低于阈值', balance_recovered: '余额恢复并自动关闭', notified: '飞书群已通知', notify_failed: '飞书通知失败', probe_failed: '余额查询失败', probe_recovered: '余额查询已恢复', notify_merged: '已并入余额恢复通知' }

function NotificationDetail({ token, id, onClose, onChanged, onUnauthorized }) {
  const [before, setBefore] = useState(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inFlight = useRef(false)
  const load = useCallback(() => adminApi.notification(token, id, { before }), [token, id, before])
  const remote = useRemoteData(load, onUnauthorized)
  const incident = remote.data?.incident
  async function act(action) {
    if (inFlight.current || !reason.trim()) return
    inFlight.current = true
    setBusy(true)
    setError(null)
    try {
      await adminApi.notificationAction(token, id, { action, reason })
      setReason('')
      setBefore(null)
      remote.refresh()
      onChanged()
    } catch (failure) { setError(failure) }
    finally { inFlight.current = false; setBusy(false) }
  }
  return <Modal title={incident?.title || '通知详情'} description={`事件 #${id} · 处理记录与观测证据`} size="large" onClose={onClose} busy={busy}>
    {remote.error || error ? <ErrorState error={remote.error || error} /> : null}
    {!incident ? <LoadingState label="正在读取事件" /> : <>
      <div className="mih-notice-meta"><span>{categories[incident.category]}</span><strong>{statuses[incident.status]}</strong><span>累计 {incident.occurrence_count} 次</span></div>
      <p>首次发生：{date(incident.first_occurred_at)} · 最近发生：{date(incident.last_occurred_at)}</p>
      <p>供应商：{incident.source}{incident.category !== 'supplier.cost' ? ` · 凭证范围：${incident.source_scope}` : ''}</p>
      <p>{incident.category === 'supplier.cost' ? '供应商账户余额低于已配置阈值；这与 Hub 客户钱包和接口单价独立。每次查询证据见下方时间线。'
        : incident.category === 'upstream.balance' ? '上游报告账户共享余额不足（601），请核对供应商账户并充值。此错误不包含余额数值。' : '上游报告 Token 累计消费限额已达到（602），请核对该 Token 限额；这不等同于账户余额耗尽。'}</p>
      {incident.recovered_at ? <p role="status">余额已在 {date(incident.recovered_at)} 查询确认恢复，系统已自动关闭本事件。</p> : null}
      <a className="qp-button qp-button--outline" href={`#/external-platforms?provider=${encodeURIComponent(incident.source)}`} onClick={onClose}>查看供应商配置</a>
      <p>确认表示已接手；人工关闭不证明余额或服务已恢复。重复告警会继续计入未关闭事件，关闭后再次触发告警会建立新事件。</p>
      {incident.status !== 'closed' ? <div className="mih-notice-action">
        <Field label="处理说明（必填）" hint="写明核查或处理结果，不要填写密钥、密码。">
          <textarea className="qp-input" value={reason} maxLength={1000} disabled={busy} onChange={(event) => setReason(event.target.value)} rows={3} />
        </Field>
        <div className="mih-notice-meta">
          {incident.status === 'open' ? <button className="qp-button qp-button--outline" disabled={busy || !reason.trim()} onClick={() => act('acknowledge')}>确认接手</button> : null}
          <button className="qp-button qp-button--primary" disabled={busy || !reason.trim()} onClick={() => act('close')}>按说明关闭事件</button>
        </div>
      </div> : null}
      <h3>事件时间线</h3>
      <p>操作身份记录为共享 Admin Token，无法据此区分具体管理员。原始调用标识可用于服务器账本核查。</p>
      <ol className="mih-notice-timeline">
        {(remote.data?.events || []).map((event) => <li key={event.id}>
          <div className="mih-notice-meta"><strong>{sourceLabels[event.kind]}</strong><time>{date(event.occurred_at)}</time></div>
          <small>{event.actor}{event.marketplace ? ` · ${event.marketplace}` : ''}{event.credential_revision ? ` · 凭证版本 ${event.credential_revision}` : ''}</small>
          {event.note ? <p>{event.note}</p> : null}
          {event.evidence ? <p>余额：<strong>{balanceMoney(event.evidence.balance, event.evidence.currency)}</strong> · 提醒阈值：{balanceMoney(event.evidence.warningThreshold, event.evidence.currency)} · 严重阈值：{balanceMoney(event.evidence.criticalThreshold, event.evidence.currency)}</p> : null}
          {event.balance_observation_id ? <p>余额采样 ID：<code>{event.balance_observation_id}</code></p> : null}
          {event.request_id ? <p>Request ID：<code>{event.request_id}</code></p> : null}
          {event.source_event_id ? <p>Provider Call ID：<code>{event.source_event_id}</code></p> : null}
        </li>)}
      </ol>
      <div className="mih-notice-meta">
        {before ? <button className="qp-button qp-button--ghost" onClick={() => setBefore(null)}>最新记录</button> : null}
        {remote.data?.nextBefore ? <button className="qp-button qp-button--outline" onClick={() => setBefore(remote.data.nextBefore)}>更早记录</button> : null}
      </div>
    </>}
  </Modal>
}

export function NotificationsPage({ token, onUnauthorized }) {
  const [status, setStatus] = useState('active')
  const [category, setCategory] = useState('all')
  const [before, setBefore] = useState(null)
  const [selected, setSelected] = useState(null)
  const load = useCallback(() => adminApi.notifications(token, { status, category, before }), [token, status, category, before])
  const remote = useRemoteData(load, onUnauthorized)
  const refresh = remote.refresh
  // Refresh only Hub's notification read API. There is no upstream probe.
  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 30_000)
    return () => clearInterval(timer)
  }, [refresh])
  const counts = remote.data?.counts || []
  const count = (value) => counts.filter((item) => item.status === value).reduce((sum, item) => sum + Number(item.count), 0)
  return <div className="mih-notifications">
    <PageHeading eyebrow="OPERATIONS / NOTIFICATIONS" title="通知中心" description="集中查看费用与供应商告警、记录处理过程，并追溯余额采样和原始请求。" loading={remote.loading} onRefresh={refresh} />
    <div className="mih-notice-meta" aria-label="通知统计">
      {Object.entries(statuses).map(([value, label]) => <span key={value}>{label} <strong>{count(value)}</strong></span>)}
    </div>
    <section className="qp-panel mih-panel mih-notice-filters">
      <DropdownField label="处理状态" value={status} onChange={(value) => { setStatus(value); setBefore(null) }} options={[
        { value: 'active', label: '未关闭' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label })), { value: 'all', label: '全部状态' },
      ]} />
      <DropdownField label="通知分类" value={category} onChange={(value) => { setCategory(value); setBefore(null) }} options={[
        { value: 'all', label: '全部分类' }, ...Object.entries(categories).map(([value, label]) => ({ value, label })),
      ]} />
    </section>
    <p>TikHub / JustOne 余额监控固定在北京时间每小时整点检查一次，可在外部数据平台调整告警阈值。JustOne 调用失败与 Token 限额每 30 秒从账本采集；页面刷新不请求供应商。已入库的事件与处理记录持续保留。</p>
    <p>调用账本采集状态：{({ ready: '最近批次完成', pending: '等待首次采集', error: '采集失败，当前列表可能不完整', unavailable: '未启用持久化存储' })[remote.data?.collection?.state] || '读取中'} · 最近成功：{date(remote.data?.collection?.lastSuccessAt)} · 时间均为北京时间</p>
    {remote.error ? <ErrorState error={remote.error} onRetry={refresh} /> : null}
    {remote.loading && !remote.data ? <LoadingState label="正在读取通知" /> : null}
    {remote.data?.available === false ? <p role="status">通知中心需要 PostgreSQL 持久化存储；当前环境未启用。</p> : null}
    {remote.data?.available && !remote.data.items.length ? <p role="status">当前筛选下暂无通知。此状态不代表供应商余额充足。</p> : null}
    {(remote.data?.items || []).map((item) => <article className={`qp-panel mih-panel mih-notice-card mih-notice-card--${item.severity}`} key={item.id}>
      <div className="mih-notice-meta"><span>{categories[item.category] || item.category}</span><strong className={`qp-tag qp-tag--${item.severity === 'critical' ? 'danger' : 'warning'}`}>{item.severity === 'critical' ? '严重' : '警告'}</strong><span>{statuses[item.status]}</span></div>
      <h2><button className="qp-button qp-button--ghost" onClick={() => setSelected(item.id)}>{item.title}</button></h2>
      <p>事件 #{item.id} · 累计 {item.occurrence_count} 次 · 最近发生 {date(item.last_occurred_at)}</p>
      {item.latest_request_id ? <p className="mih-notice-request">最近 Request ID：<code>{item.latest_request_id}</code></p> : null}
      {item.recovered_at ? <p>余额已确认恢复：{date(item.recovered_at)}</p> : null}
      <button className="qp-button qp-button--outline" onClick={() => setSelected(item.id)}>查看与处理</button>
    </article>)}
    <div className="mih-notice-meta">
      {before ? <button className="qp-button qp-button--ghost" onClick={() => setBefore(null)}>返回最新</button> : null}
      {remote.data?.nextBefore ? <button className="qp-button qp-button--outline" onClick={() => setBefore(remote.data.nextBefore)}>更早事件</button> : null}
    </div>
    {selected ? <NotificationDetail key={selected} token={token} id={selected} onClose={() => setSelected(null)} onChanged={refresh} onUnauthorized={onUnauthorized} /> : null}
  </div>
}
