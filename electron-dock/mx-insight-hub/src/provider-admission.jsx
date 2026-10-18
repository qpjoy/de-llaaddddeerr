import { useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, Field } from './components.jsx'

const FIELDS = [
  ['maxConcurrency', '网关实例总并发', 1, 256],
  ['maxConsumerConcurrency', '单调用者并发', 1, 256],
  ['maxRequestsPerMinute', '供应商每分钟请求数', 1, 60000],
  ['maxWaitMs', '队列最长等待（毫秒）', 1, 60000],
  ['maxPending', '队列最大等待请求数', 1, 256],
]

// The provider identity and revision key discard drafts after a confirmed reload.
export function ProviderAdmission(props) {
  return <AdmissionEditor key={`${props.token}:${props.policy.providerKey}:${props.policy.revision}`} {...props} />
}

function AdmissionEditor({ token, policy, label, onSaved, onUnauthorized, notify }) {
  const [current, setCurrent] = useState(policy)
  const [limits, setLimits] = useState(() => ({ ...policy.limits }))
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false)
  const [error, setError] = useState(null), [receipt, setReceipt] = useState(''), [needsRefresh, setNeedsRefresh] = useState(false)
  const lock = useRef(false), active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const valid = FIELDS.every(([field, , min, max]) => String(limits[field]).trim() !== '' && Number.isInteger(Number(limits[field])) && Number(limits[field]) >= min && Number(limits[field]) <= max)
    && Number(limits.maxConsumerConcurrency) <= Number(limits.maxConcurrency)
  const save = async event => {
    event.preventDefault()
    if (lock.current || needsRefresh || !valid || !reason.trim()) return
    lock.current = true; setBusy(true); setError(null); setReceipt('')
    try {
      const saved = await adminApi.saveExternalPlatformAdmission(token, current.providerKey, {
        expectedRevision: current.revision, reason: reason.trim(),
        limits: Object.fromEntries(FIELDS.map(([field]) => [field, Number(limits[field])])),
      })
      if (!active.current) return
      setCurrent(saved); setLimits({ ...saved.limits }); setReason('')
      setReceipt(`已保存 ${label} 限速配置 · 修订 #${saved.revision}`)
      notify?.('供应商限速配置已保存', 'success'); onSaved?.()
    } catch (failure) {
      if (!active.current) return
      setError(failure); setNeedsRefresh(true)
      if (failure.status === 401) onUnauthorized?.(failure)
    } finally { lock.current = false; if (active.current) setBusy(false) }
  }
  const refresh = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try {
      const saved = await adminApi.externalPlatformAdmission(token, current.providerKey)
      if (!active.current) return
      setCurrent(saved); setLimits({ ...saved.limits }); setReason(''); setNeedsRefresh(false); setReceipt('已重新读取当前配置，请核对后再修改。')
    } catch (failure) { if (active.current) { setError(failure); if (failure.status === 401) onUnauthorized?.(failure) } }
    finally { lock.current = false; if (active.current) setBusy(false) }
  }
  return <section className="qp-panel mih-panel mih-provider-admission" aria-label={`${label} Hub 限速配置`}>
    <header className="mih-product-management-heading"><div><h3>Hub 限速与等待队列</h3><p>{current.source === 'database' ? '已保存配置' : '沿用部署默认值'} · 修订 #{current.revision}</p></div>
      <button className="qp-button qp-button--outline" type="button" disabled={busy} onClick={refresh}>重新读取限速</button></header>
    <p>作用于 <strong>{label}</strong> 的所有相关产品和接口。每分钟请求数按供应商共享；并发按网关实例控制，单调用者并发不能大于实例总并发。保存不修改接口启停、授权或价格，也不能取消供应商自身限制。</p>
    <form onSubmit={save}>
      <fieldset className="mih-product-management-fields" disabled={busy || needsRefresh}>
        {FIELDS.map(([field, title, min, max]) => <Field key={field} label={title}><input aria-label={title} className="qp-input" type="number" required min={min} max={max} step="1" value={limits[field] ?? ''} onChange={event => { setLimits(previous => ({ ...previous, [field]: event.target.value })); setReceipt('') }} /><small>{min}–{max.toLocaleString('zh-CN')}{current.defaults?.[field] != null ? ` · 部署默认 ${current.defaults[field]}` : ''}</small></Field>)}
        <Field label="限速变更原因"><input aria-label="限速变更原因" className="qp-input" maxLength={1000} required value={reason} onChange={event => setReason(event.target.value)} /></Field>
      </fieldset>
      {!valid && !needsRefresh ? <p role="alert">请填写范围内的整数，且单调用者并发不能大于实例总并发。</p> : null}
      {error ? <ErrorState error={error} /> : null}
      {needsRefresh ? <p role="alert">{error?.status === 409 ? '配置已变化。' : '尚未确认本次保存结果。'}请先重新读取限速，核对当前版本后再修改；不会自动重复提交。</p> : null}
      {receipt ? <p role="status">{receipt}</p> : null}
      <button className="qp-button qp-button--primary" disabled={busy || needsRefresh || !valid || !reason.trim()}>{busy ? '处理中…' : '保存供应商限速'}</button>
    </form>
  </section>
}
