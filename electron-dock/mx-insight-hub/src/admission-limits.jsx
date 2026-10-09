import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowClockwise, Clock, ShieldCheck, WarningCircle } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { ErrorState, LoadingState, Modal, formatDate } from './components.jsx'
import './admission-limits.css'

const identity = row => [row.kind,row.target,row.scopeType,row.scopeKey].join(':')
function remaining(until, now) {
  if (!until) return '无自动恢复时间'
  const seconds = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000))
  if (!seconds) return '已到预计时间 · 等待刷新确认'
  const hours = Math.floor(seconds / 3600), minutes = Math.floor(seconds % 3600 / 60)
  return `${hours ? `${hours}小时 ` : ''}${minutes ? `${minutes}分 ` : ''}${seconds % 60}秒`
}

export default function AdmissionLimits({ token, onUnauthorized, requestId = '' }) {
  const [keyDraft, setKeyDraft] = useState(''), [apiKeyId, setApiKeyId] = useState('')
  const [linkedRequest, setLinkedRequest] = useState(requestId)
  const [data, setData] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const [auto, setAuto] = useState(true), [onlyActive, setOnlyActive] = useState(true), [provider, setProvider] = useState('')
  const [search, setSearch] = useState(''), [selection, setSelection] = useState(null), [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false), [notice, setNotice] = useState(''), [now, setNow] = useState(Date.now())
  const active = useRef(null), clock = useRef(null), mounted = useRef(true)
  useEffect(() => { setLinkedRequest(requestId); setApiKeyId(''); setKeyDraft(''); setSelection(null) }, [requestId])
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; active.current?.abort() } }, [])
  const refresh = useCallback(async () => {
    active.current?.abort()
    const controller = new AbortController(); active.current = controller; setBusy(true)
    try {
      const result = await adminApi.admissionLimits(token, { apiKeyId, requestId: linkedRequest }, { signal: controller.signal })
      if (controller.signal.aborted) return
      clock.current = { server: Date.parse(result.serverTime), local: performance.now() }
      setNow(clock.current.server); setData(result); setError(null)
    } catch (failure) {
      if (controller.signal.aborted) return
      setError(failure); if ([401,403].includes(failure.status)) onUnauthorized?.(failure)
    } finally { if (active.current === controller && !controller.signal.aborted) { active.current = null; setBusy(false) } }
  }, [token, apiKeyId, linkedRequest, onUnauthorized])
  useEffect(() => { setData(null); setError(null); refresh(); return () => active.current?.abort() }, [refresh])
  useEffect(() => {
    if (!auto) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && !active.current && !saving) refresh() }, 10000)
    return () => clearInterval(timer)
  }, [auto, refresh, saving])
  useEffect(() => {
    const timer = setInterval(() => { if (clock.current) setNow(clock.current.server + performance.now() - clock.current.local) }, 1000)
    return () => clearInterval(timer)
  }, [])
  const stale = error || (clock.current && performance.now() - clock.current.local > 30000)
  const rows = data?.items || []
  const providers = [...new Set(rows.map(row => row.provider).filter(Boolean))].sort()
  const filtered = rows.filter(row => (!onlyActive || row.active) && (!provider || row.provider === provider)
    && (!search || [row.title,row.scope,row.provider,row.platform,row.apiKeyId,row.requestId,row.errorCode].some(v => String(v || '').toLowerCase().includes(search.toLowerCase()))))
  const recover = async event => {
    event.preventDefault()
    if (saving || !selection || reason.trim().length < 3) return
    setSaving(true)
    try {
      const { kind,target,scopeType,scopeKey,revision } = selection
      await adminApi.recoverAdmission(token, { kind,target,scopeType,scopeKey,revision,reason: reason.trim(), ...(data?.apiKeyId ? { apiKeyId: data.apiKeyId } : {}) })
      if (!mounted.current) return
      setSelection(null); setReason(''); setNotice('所选限制已解除，操作已记录。没有重发请求；其他限制仍独立生效。')
      await refresh()
    } catch (failure) { if (mounted.current) { setError(failure); setSelection(null); if ([401,403].includes(failure.status)) onUnauthorized?.(failure) } }
    finally { if (mounted.current) setSaving(false) }
  }
  return <section className="mih-admission" aria-labelledby="admission-title">
    <header className="mih-admission-heading"><div><h2 id="admission-title">限制与恢复</h2><p>查看当前保护与剩余等待时间，按影响范围处理。恢复仅解除所选 Hub 限制，不重发采集。</p></div>
      <button className="qp-button qp-button--secondary" onClick={refresh} disabled={busy || saving}><ArrowClockwise/>{busy ? '刷新中…' : '刷新状态'}</button></header>
    <div className="mih-admission-controls qp-card">
      <form onSubmit={event => { event.preventDefault(); setLinkedRequest(''); setApiKeyId(keyDraft.trim()); setSelection(null) }}>
        <label className="qp-field">Key 名称 / ID<input className="qp-input" list="admission-keys" placeholder="选择 Key 或粘贴完整 Key ID" value={keyDraft} onChange={event => setKeyDraft(event.target.value)} /></label>
        <datalist id="admission-keys">{data?.keys?.map(key => <option key={key.id} value={key.id}>{key.consumerName} · {key.name}</option>)}</datalist>
        <button className="qp-button qp-button--primary" disabled={busy}>查看 Key 限制</button>
        <button className="qp-button qp-button--ghost" type="button" onClick={() => { setKeyDraft(''); setApiKeyId(''); setLinkedRequest(''); setSelection(null) }}>全部上游</button>
      </form>
      <div className="mih-admission-context"><span>{data?.key ? `${data.key.name} · ${data.key.id} · ${data.key.status}` : '全部上游共享限制 · 选择 Key 后查看各层配额'}</span>
        <label><input type="checkbox" checked={auto} onChange={event => setAuto(event.target.checked)}/> 每 10 秒自动刷新</label></div>
      {data?.correlation ? <p>关联请求 <a href={`#/data-browser?view=diagnostics&requestId=${data.correlation.requestId}`}>{data.correlation.requestId}</a> · 下方是当前状态，历史请求结果不变。</p> : null}
      {data?.keysTruncated ? <p>仅列出最近 200 个 Key；可粘贴其他 Key 的完整 ID。</p> : null}
    </div>
    {error ? <ErrorState error={error} onRetry={refresh}/> : null}
    {notice ? <p className="mih-admission-notice" role="status"><ShieldCheck/>{notice}</p> : null}
    {!data && busy ? <LoadingState/> : null}
    {data ? <>
      <div className="mih-admission-stats">{[
        ['当前限制',rows.filter(r => r.active).length,WarningCircle],
        ['可手动恢复',rows.filter(r => r.active && r.recoverable).length,ShieldCheck],
        ['占用 / 待核对',rows.filter(r => r.active && ['pending','unknown','dispatch_lease'].includes(r.kind)).length,Clock],
      ].map(([label,value,Icon]) => <div className="qp-card" key={label}><Icon/><div><span>{label}</span><strong>{value}</strong></div></div>)}</div>
      <div className="mih-admission-filters"><label><input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)}/> 仅显示生效限制</label>
        <select aria-label="上游供应商" className="qp-input" value={provider} onChange={e => setProvider(e.target.value)}><option value="">全部供应商 / Key</option>{providers.map(p => <option key={p} value={p}>{p}</option>)}</select>
        <input aria-label="筛选限制" className="qp-input" value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索平台、错误码、请求 ID"/>
      </div>
      <p className="mih-admission-time">服务器快照 {formatDate(data.serverTime)} · 倒计时按服务器时间计算{stale ? ' · 快照已过期，请刷新后操作' : ''}</p>
      {data.callsTruncated || data.leasesTruncated ? <p role="status">调用保护或派发锁超过 200 条；每类仅显示最近 200 条，统计不是全量。</p> : null}
      {!filtered.length ? <div className="qp-card mih-admission-empty"><ShieldCheck size={30}/><h3>当前筛选下没有{onlyActive ? '生效限制' : '匹配项'}</h3><p>这里只检查 Hub 保存的状态，不代表上游服务已通过实时验证。</p></div> : null}
      <div className="mih-admission-list">{filtered.map(row => <article className="qp-card mih-admission-row" key={identity(row)}>
        <div className="mih-admission-row-top"><div><span className={`mih-admission-badge ${row.active ? 'is-active' : ''}`}>{row.exempt ? '内部豁免' : row.active ? '限制中' : '可用'}</span><h3>{row.title}</h3><p>{row.provider || data.key?.name || 'Key'}{row.platform ? ` · ${row.platform}` : ''} · {row.origin}</p></div>
          <div className="mih-admission-countdown"><Clock/><strong>{row.active ? remaining(row.until, now) : '当前未达到限制'}</strong>{row.until ? <small>{formatDate(row.until)}</small> : null}</div></div>
        {row.limit != null ? <div className="mih-admission-usage"><span>已用 {Math.ceil(row.used).toLocaleString()} / {row.limit.toLocaleString()}{row.windowSeconds ? ` · ${row.windowSeconds} 秒窗口` : ''}</span><progress max={Math.max(1,row.limit)} value={Math.min(row.limit,row.used)} /></div> : null}
        {row.active && row.until && row.startedAt ? <progress aria-label="冷却经过时间" max="100" value={Math.min(100,Math.max(0,(now-Date.parse(row.startedAt))/Math.max(1,Date.parse(row.until)-Date.parse(row.startedAt))*100))}/> : null}
        <dl><dt>影响范围</dt><dd>{row.scope}</dd>{row.errorCode ? <><dt>触发原因</dt><dd><code>{row.errorCode}</code></dd></> : null}
          {row.apiKeyId ? <><dt>关联 Key</dt><dd>{row.apiKeyId}</dd></> : null}{row.requestId ? <><dt>关联请求</dt><dd><a href={`#/data-browser?view=diagnostics&requestId=${row.requestId}`}>{row.requestId}</a></dd></> : null}</dl>
        {row.selectedKeyEffect ? <p>{row.selectedKeyEffect}{row.selectedKeyUntil && Date.parse(row.selectedKeyUntil) > now ? ` 当前 Key 还需等待 ${remaining(row.selectedKeyUntil,now)}` : ''}</p> : null}
        <footer><p>{row.note}</p>{row.recoverable ? <button className="qp-button qp-button--secondary" disabled={!row.active || stale || busy || saving || (row.until && Date.parse(row.until)<=now)} onClick={() => { setSelection(row); setReason(''); setError(null) }}>手动恢复</button>
          : ['key_total','plan_month'].includes(row.kind) ? <a href={row.kind === 'key_total' ? '#/keys' : '#/plans'}>调整额度</a> : null}</footer>
      </article>)}</div>
      <details className="qp-card mih-admission-history"><summary>最近恢复记录 · {data.history.length} 条</summary>{data.history.length ? data.history.map(row => <div key={row.id}><strong>{row.kind} · {row.scope_key || row.target}</strong><p>{row.reason}</p><small>{formatDate(row.created_at)} · {row.actor}</small></div>) : <p>尚无手动恢复操作。</p>}</details>
      <p className="mih-admission-time">{data.coverage}</p>
    </> : null}
    {selection ? <Modal title={`恢复${selection.title}`} busy={saving} onClose={() => !saving && setSelection(null)} description="恢复不会重发历史请求，也不会修改原始响应或账单。">
      <form onSubmit={recover}><p><strong>影响范围：</strong>{selection.scope}</p><p>{selection.note}</p><label className="qp-field">恢复原因<textarea autoFocus className="qp-input" rows={3} minLength={3} maxLength={500} value={reason} onChange={event => setReason(event.target.value)} placeholder="例如：解析修复已部署，原始响应验证通过" required/></label>
        <div className="mih-admission-confirm"><button type="button" className="qp-button qp-button--ghost" disabled={saving} onClick={() => setSelection(null)}>取消</button><button className="qp-button qp-button--primary" disabled={saving || reason.trim().length < 3}>{saving ? '恢复中…' : '确认恢复此限制'}</button></div></form>
    </Modal> : null}
  </section>
}
