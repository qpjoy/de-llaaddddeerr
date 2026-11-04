import { useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, LoadingState } from './components.jsx'
const LCY = 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
const fields = [['maxConcurrency', '共享并发上限'], ['maxKeyConcurrency', '每个 Key 并发上限'],
  ['requestsPerSecond', '共享每秒请求数'], ['keyRequestsPerSecond', '每个 Key 每秒请求数']]

export function ResourceAdmissionPanel({ token, path, onUnauthorized }) {
  const [view, setView] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const [kind, setKind] = useState('product'), [api, setApi] = useState(''), [keyId, setKeyId] = useState('*')
  const [limits, setLimits] = useState({}), [reason, setReason] = useState(''), [notice, setNotice] = useState('')
  const [needsRefresh, setNeedsRefresh] = useState(false)
  const live = useRef(true), locked = useRef(false)
  const target = kind === 'api' ? api : path
  const rule = view?.rules.find(row => row.kind === kind && row.target === target && row.keyId === keyId)
  const load = async () => {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(null)
    try {
      const next = await adminApi.resourceLimits(token)
      if (live.current) { setView(next); setNeedsRefresh(false); setReason(''); setNotice('') }
    } catch (failure) { if (live.current) { setError(failure); if (failure.status === 401) onUnauthorized?.(failure) } }
    finally { locked.current = false; if (live.current) setBusy(false) }
  }
  useEffect(() => { live.current = true; load(); return () => { live.current = false } }, [token])
  useEffect(() => { setLimits({ ...(kind === 'default' ? view?.defaults : rule?.limits || view?.defaults) }); setReason('') }, [view, kind, target, keyId])
  const valid = view && fields.every(([name]) => String(limits[name] ?? '').trim() && Number.isInteger(Number(limits[name])) && Number(limits[name]) >= 1 && Number(limits[name]) <= view.bounds[name])
    && Number(limits.maxKeyConcurrency) <= Number(limits.maxConcurrency) && Number(limits.keyRequestsPerSecond) <= Number(limits.requestsPerSecond)
    && (kind !== 'api' || api)
  const save = async (event, remove = false) => {
    event.preventDefault()
    if (locked.current || needsRefresh || !reason.trim() || (!remove && !valid)) return
    locked.current = true; setBusy(true); setError(null); setNotice('')
    const value = Object.fromEntries(fields.map(([name]) => [name, Number(limits[name])]))
    let rules = view.rules.filter(row => row !== rule)
    if (kind !== 'default' && !remove) rules = [...rules, { id: rule?.id || crypto.randomUUID(), kind, target, keyId, limits: value }]
    try {
      const next = await adminApi.saveResourceLimits(token, { expectedRevision: view.revision, reason: reason.trim(),
        defaults: kind === 'default' ? value : view.defaults, rules: kind === 'default' ? view.rules : rules })
      if (live.current) { setView(next); setReason(''); setNotice(`已保存修订 #${next.revision}；其他 API 进程通常在 5 秒内读取。`) }
    } catch (failure) {
      if (live.current) { setError(failure); setNeedsRefresh(true); if (failure.status === 401) onUnauthorized?.(failure) }
    } finally { locked.current = false; if (live.current) setBusy(false) }
  }
  return <section className="qp-panel mih-panel" aria-label="产品与 API 资源限速">
    <header className="mih-product-management-heading"><div><h3>产品与 API 资源限速</h3><p>默认约束所有 Key，包含 LCY-delta；预算豁免不取消资源保护。</p></div>
      <button type="button" className="qp-button qp-button--outline" disabled={busy} onClick={load}>重新读取资源限速</button></header>
    <p>按单个 API 进程执行。每秒请求数使用令牌桶，可突发一个秒额度；并发指尚未完成的请求。空闲时直接放行，达到上限返回 429，不增加等待队列。多个进程的额度不共享，不能把本页数值视为集群总量。</p>
    {!view && !error ? <LoadingState label="读取资源限速" /> : null}
    {error ? <ErrorState error={error} /> : null}
    {needsRefresh ? <p role="alert">保存结果尚未确认或版本已变化，请重新读取后核对；不会自动重试保存。</p> : null}
    {view ? <form onSubmit={save}>
      <p>当前修订 #{view.revision}。默认上限、产品规则和 API 规则同时生效，以先到达的上限为准。保存仅改变资源限速。</p>
      <fieldset className="mih-product-management-fields" disabled={busy || needsRefresh}>
        <DropdownField label="资源限制范围" value={kind} onChange={setKind} options={[{ value: 'product', label: '当前数据产品' }, { value: 'api', label: '当前产品的某个 API' }, { value: 'default', label: '所有数据 API 的默认上限' }]} />
        {kind === 'api' ? <DropdownField label="选择 API" value={api} onChange={setApi} options={[{ value: '', label: '请选择接口' }, ...view.catalog.apis.filter(row => row.product === path).map(row => ({ value: row.id, label: row.label }))]} /> : null}
        {kind !== 'default' ? <DropdownField label="规则适用 Key" value={keyId} onChange={setKeyId} options={[{ value: '*', label: '所有 Key（包括 LCY-delta）' }, { value: LCY, label: '仅原始 LCY-delta Key' }]} /> : null}
        {fields.map(([name, label]) => <Field key={name} label={label}><input className="qp-input" aria-label={label} type="number" min="1" max={view.bounds[name]} step="1" required value={limits[name] ?? ''} onChange={event => setLimits(previous => ({ ...previous, [name]: event.target.value }))} /></Field>)}
        <Field label="资源限速修改原因"><input className="qp-input" aria-label="资源限速修改原因" maxLength={1000} required value={reason} onChange={event => setReason(event.target.value)} /></Field>
      </fieldset>
      {kind !== 'default' ? <p>{rule ? '当前范围已保存单独规则。' : '当前范围尚无单独规则；默认保护仍生效。'}</p> : <p>这是所有数据 API 共用的上限；初始每 Key 100 请求/秒、32 并发是保护配置，不是系统实测容量。</p>}
      <div className="mih-page-actions"><button className="qp-button qp-button--primary" disabled={busy || needsRefresh || !valid || !reason.trim()}>保存资源限速</button>
        {rule ? <button type="button" className="qp-button qp-button--outline" disabled={busy || needsRefresh || !reason.trim()} onClick={event => save(event, true)}>移除此范围规则</button> : null}</div>
    </form> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <p>供应商自身配额、已有供应商限速与后台采集任务并发仍独立生效。提高本页上限不能消除这些瓶颈；请结合“数据压力”中的排队、数据库和分词指标调整。</p>
  </section>
}
