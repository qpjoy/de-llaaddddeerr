import { useCallback, useEffect, useRef, useState } from 'react'
import { adminApi, publicDataApi } from './api.js'
import { ErrorState, LoadingState, formatDate, useRemoteData } from './components.jsx'
import { useDemoApiKey } from './demo-credentials.jsx'
import { WECHAT_SELF_HOSTED, WECHAT_SELF_HOSTED_LIMITS as LIMITS } from '../shared/wechat-self-hosted.mjs'
import './wechat-self-hosted.css'

const STATUS = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', unknown: '结果未知', cancelled: '已取消', expired: '排队超时' }
const SOURCE = { live: '实时采集', fresh_cache: '24 小时内缓存', stored_fallback: '旧结果（不收费）' }
const BILLING = { none: '未计费', reserved: '已预留', charged: '已计费', not_charged: '不计费', pending_review: '待核实' }
const OPEN = new Set(['queued', 'running'])

const text = value => ['string', 'number'].includes(typeof value) ? String(value) : ''
// Titles from search pages may carry highlight markup; never render it as HTML.
function plain(value) {
  if (typeof value !== 'string') return ''
  const template = document.createElement('template')
  template.innerHTML = value
  return template.content.textContent || ''
}
const safeLink = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null } }
const unixDate = value => Number.isFinite(Number(value)) && Number(value) > 0 ? formatDate(Number(value) * 1000) : ''
const seconds = ms => ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} 秒`
const shortId = value => value ? String(value).slice(0, 8) : '—'

function JobStatus({ job }) {
  return <span className={`mih-wsh-status mih-wsh-status--${job.status}`}>{STATUS[job.status] || job.status}</span>
}

export function WechatSelfHostedArticles({ items }) {
  if (!items?.length) return <p>本次没有返回文章。空结果同样是一次完成的搜索。</p>
  return <ol className="mih-wsh-articles">{items.map((row, index) => {
    const link = safeLink(row.url || row.link)
    const title = plain(text(row.title) || text(row.content_title)) || `文章 ${index + 1}`
    return <li key={index}><h4>{link ? <a href={link} target="_blank" rel="noreferrer">{title} ↗</a> : title}</h4>
      <p className="mih-wsh-meta">{[text(row.author_name) || text(row.author) || text(row.account_name) || text(row.nickname), unixDate(row.published_at)].filter(Boolean).join(' · ')}</p>
      <p>{plain(text(row.content) || text(row.summary) || text(row.digest) || text(row.desc))}</p>
      <details><summary>完整字段</summary><pre className="mih-api-response">{JSON.stringify(row, null, 2)}</pre></details></li>
  })}</ol>
}

// 产品展示: submit with the selected caller key, follow the queue, read articles.
export function WechatSelfHostedPage() {
  const [key] = useDemoApiKey()
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(LIMITS.limitDefault), [fresh, setFresh] = useState(false)
  const [jobs, setJobs] = useState([]), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState(null), [result, setResult] = useState(null)
  const keyRef = useRef(key)
  keyRef.current = key

  const reload = useCallback(async () => {
    if (!keyRef.current) return
    try {
      const response = await publicDataApi.wechatSelfHostedJobs(keyRef.current, 20)
      setJobs(response.payload.data || [])
    } catch (failure) { setError(failure) }
  }, [])
  useEffect(() => { setJobs([]); setSelected(null); setResult(null); void reload() }, [key, reload])
  const open = jobs.some(job => OPEN.has(job.status))
  useEffect(() => {
    if (!open) return undefined
    const timer = setInterval(() => { void reload() }, 5_000)
    return () => clearInterval(timer)
  }, [open, reload])

  const current = jobs.find(job => job.jobId === selected) || null
  useEffect(() => {
    setResult(null)
    if (!current?.delivery.available || !key) return
    let active = true
    publicDataApi.wechatSelfHostedResult(key, current.jobId)
      .then(response => { if (active) setResult(response.payload.data) })
      .catch(failure => { if (active) setResult({ error: failure }) })
    return () => { active = false }
  }, [current?.jobId, current?.delivery.available, key])

  async function submit(event) {
    event.preventDefault()
    if (!key || !query.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const response = await publicDataApi.wechatSelfHostedSubmit(key, { query: query.trim(), limit, ...(fresh ? { cacheMaxAgeHours: 0 } : {}) },
        `console-${crypto.randomUUID()}`)
      setSelected(response.payload.data.jobId)
      await reload()
    } catch (failure) { setError(failure) } finally { setBusy(false) }
  }
  async function cancel(jobId) {
    try { await publicDataApi.wechatSelfHostedCancel(key, jobId); await reload() } catch (failure) { setError(failure) }
  }

  return <section className="qp-panel mih-panel mih-wsh" aria-label="微信自建引擎产品展示">
    <h2>公众号文章搜索 · 自建引擎</h2>
    <p>引擎全局串行执行，单条通常几十秒到 3 分钟。提交后立即拿到任务号，可以连续提交多条，Hub 负责排队；页面每 5 秒刷新一次进度。</p>
    {!key ? <p role="status">请先在上方选择已授权「{WECHAT_SELF_HOSTED.capability}」的调用身份。</p> : null}
    <form className="mih-wsh-form" onSubmit={submit}>
      <label className="qp-field">关键词<input className="qp-input" value={query} maxLength={LIMITS.queryLength} onChange={event => setQuery(event.target.value)} placeholder="例如：人工智能" /></label>
      <label className="qp-field">文章上限<input className="qp-input" type="number" min="1" max={LIMITS.limitMax} value={limit} onChange={event => setLimit(Math.min(LIMITS.limitMax, Math.max(1, Number(event.target.value) || 1)))} /></label>
      <label className="mih-wsh-check"><input type="checkbox" checked={fresh} onChange={event => setFresh(event.target.checked)} />不用 24 小时缓存</label>
      <button className="qp-button qp-button--primary" disabled={!key || !query.trim() || busy}>{busy ? '正在提交…' : '提交任务'}</button>
    </form>
    <p className="mih-wsh-note">默认只转发、不计费。管理员开启计费后，实时或 24 小时缓存结果按任务计费；旧结果、失败、取消和排队超时始终不计费。</p>
    {error ? <ErrorState error={error} /> : null}
    <h3>最近任务</h3>
    {!jobs.length ? <p>当前调用身份还没有任务。</p> : <div className="qp-table-wrap"><table className="qp-table mih-table">
      <thead><tr><th>提交时间</th><th>关键词</th><th>状态</th><th>来源</th><th>计费</th><th>排队 / 耗时</th><th /></tr></thead>
      <tbody>{jobs.map(job => <tr key={job.jobId} aria-selected={job.jobId === selected}>
        <td>{formatDate(job.timing.queuedAt)}</td><td>{job.input.query}</td><td><JobStatus job={job} /></td>
        <td>{SOURCE[job.delivery.sourceMode] || '—'}</td><td>{BILLING[job.billing.status] || job.billing.status}</td>
        <td>{job.status === 'queued' ? `第 ${job.queue?.position ?? '—'} 位 · 约 ${formatDate(job.queue?.estimatedStartAt)} 开始` : seconds(job.timing.durationMs)}</td>
        <td><button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => setSelected(job.jobId)}>查看</button>
          {job.status === 'queued' ? <button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => cancel(job.jobId)}>取消</button> : null}</td>
      </tr>)}</tbody></table></div>}
    {current ? <article className="mih-wsh-detail">
      <h3>{current.input.query} · <JobStatus job={current} /></h3>
      {current.error ? <p role="status">{current.error.message}（{current.error.code}）</p> : null}
      {OPEN.has(current.status) ? <p role="status">{current.status === 'queued' ? `排在第 ${current.queue?.position ?? '—'} 位，预计 ${formatDate(current.queue?.estimatedStartAt)} 开始。` : '引擎执行中，完成后自动刷新。'}</p> : null}
      {result?.error ? <ErrorState error={result.error} /> : null}
      {result && !result.error ? <>
        <p>{SOURCE[result.sourceMode] || result.sourceMode}{result.fetchedAt ? ` · 采集于 ${formatDate(result.fetchedAt)}` : ''} · {BILLING[result.billing.status] || result.billing.status}</p>
        {result.notice ? <p role="status">{result.notice}</p> : null}
        <WechatSelfHostedArticles items={result.items} />
      </> : null}
    </article> : null}
  </section>
}

// 管理: engine address, switch, quarantine recovery and recent work.
export function WechatSelfHostedEngineAdmin({ token, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.wechatSelfHosted(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  const [draft, setDraft] = useState(null), [reason, setReason] = useState(''), [recoverReason, setRecoverReason] = useState('')
  const [probe, setProbe] = useState(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState(null)
  const data = remote.data
  useEffect(() => {
    const timer = setInterval(remote.refresh, 10_000)
    return () => clearInterval(timer)
  }, [remote.refresh])
  useEffect(() => { if (data && !draft) setDraft({ baseUrl: data.engine.baseUrl, enabled: data.engine.enabled, billingEnabled: data.engine.billingEnabled }) }, [data, draft])
  if (remote.loading && !data) return <LoadingState label="正在读取自建引擎状态" />
  if (remote.error && !data) return <ErrorState error={remote.error} onRetry={remote.refresh} />
  const engine = data.engine
  const state = !engine.enabled ? '已停用' : engine.quarantineReason ? '已隔离，等待人工核实' : data.queue.runningJobId ? '执行中' : engine.cooling ? `冷却到 ${formatDate(engine.cooldownUntil)}` : '空闲'

  async function run(action, success) {
    setBusy(true); setFailure(null)
    try { await action(); notify?.(success, 'success'); remote.refresh(); return true }
    catch (error) { setFailure(error); if (error.status === 401) onUnauthorized?.(error); return false }
    finally { setBusy(false) }
  }
  const save = () => run(() => adminApi.configureWechatSelfHosted(token, { ...draft, expectedRevision: engine.revision, reason }), '自建引擎配置已保存')
    .then(ok => { if (ok) { setReason(''); setDraft(null) } })
  const recover = () => run(() => adminApi.recoverWechatSelfHosted(token, { expectedRevision: engine.revision, reason: recoverReason }), '引擎已恢复派发')
    .then(ok => { if (ok) setRecoverReason('') })
  async function check() {
    setProbe({ pending: true })
    try { setProbe(await adminApi.probeWechatSelfHosted(token, { baseUrl: draft?.baseUrl || engine.baseUrl })) }
    catch (error) { setProbe({ error }) }
  }

  return <section className="qp-panel mih-panel mih-wsh-admin" aria-label="自建引擎管理">
    <h2>自建引擎 · Night-All 搜狗微信</h2>
    <div className="mih-wsh-cards">
      <div><small>引擎状态</small><strong>{state}</strong></div>
      <div><small>排队</small><strong>{data.queue.queued} / {data.limits.globalQueued}</strong></div>
      <div><small>最近单条耗时（中位）</small><strong>{data.queue.medianMs == null ? '暂无，按 180 秒估算' : seconds(data.queue.medianMs)}</strong></div>
      <div><small>预计排空</small><strong>{data.queue.drainAt ? formatDate(data.queue.drainAt) : '—'}</strong></div>
      <div><small>计费</small><strong>{engine.billingEnabled ? '已开启（派发时预留账本）' : '关闭（只转发）'}</strong></div>
      <div><small>配置修订</small><strong>#{engine.revision}</strong></div>
    </div>
    {engine.quarantineReason ? <div className="mih-wsh-alert" role="alert">
      <p><strong>引擎已隔离：</strong>{engine.quarantineReason}（任务 {shortId(engine.activeJobId)}，{formatDate(engine.quarantinedAt)}）。上一条执行的结果未知，Night-All 未确认爬虫已停止。确认它已结束（或已在宿主机上处理）后再恢复，恢复后才会派发下一条。</p>
      <label className="qp-field">恢复原因（必填）<input className="qp-input" value={recoverReason} onChange={event => setRecoverReason(event.target.value)} placeholder="例如：已在宿主机确认 miku_spider 进程退出" /></label>
      <button type="button" className="qp-button qp-button--primary" disabled={busy || recoverReason.trim().length < 2} onClick={recover}>确认已结束，恢复派发</button>
    </div> : null}
    <h3>Night-All 地址</h3>
    <p>默认 <code>{data.defaults.baseUrl}</code>（Admin 为 hostNetwork，回环地址即宿主机 13141）。多节点后可改为内网 IP 或集群内 <code>*.svc</code> 名称。保存只改配置，不会采集；有任务执行或等待核实时不能换地址。</p>
    {draft ? <div className="mih-wsh-form">
      <label className="qp-field">接口地址<input className="qp-input" value={draft.baseUrl} onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
      <label className="mih-wsh-check"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />接收并派发新任务</label>
      <label className="mih-wsh-check" title="关闭时不写使用账本，不与调用方其他付费请求争用预留锁"><input type="checkbox" checked={draft.billingEnabled} onChange={event => setDraft({ ...draft, billingEnabled: event.target.checked })} />计费（派发时预留账本）</label>
      <label className="qp-field">修改原因（必填）<input className="qp-input" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="mih-page-actions">
        <button type="button" className="qp-button qp-button--primary" disabled={busy || reason.trim().length < 2} onClick={save}>保存配置</button>
        <button type="button" className="qp-button qp-button--outline" disabled={probe?.pending} onClick={check}>连通性探测（只读）</button>
      </div>
    </div> : null}
    {probe && !probe.pending ? <p role="status">{probe.error ? `探测失败：${probe.error.message}` : probe.reachable
      ? `${probe.baseUrl} 可达 · HTTP ${probe.httpStatus} · ${probe.healthy ? '健康' : '健康检查未通过'} · ${probe.durationMs} ms${probe.version ? ` · 版本 ${probe.version}` : ''}`
      : `${probe.baseUrl} 不可达（${probe.error}）`}</p> : null}
    {failure ? <ErrorState error={failure} /> : null}
    <h3>最近任务</h3>
    {!data.jobs.length ? <p>还没有任务。</p> : <div className="qp-table-wrap"><table className="qp-table mih-table">
      <thead><tr><th>提交</th><th>调用方</th><th>关键词</th><th>状态</th><th>来源</th><th>计费</th><th>耗时</th><th>说明</th></tr></thead>
      <tbody>{data.jobs.map(job => <tr key={job.jobId}>
        <td>{formatDate(job.timing.queuedAt)}</td><td><code>{shortId(job.consumerId)}</code></td><td>{job.input.query}</td>
        <td><JobStatus job={job} /></td><td>{SOURCE[job.delivery.sourceMode] || '—'}</td><td>{BILLING[job.billing.status] || job.billing.status}</td>
        <td>{seconds(job.timing.durationMs)}</td><td>{job.error ? `${job.error.code}` : job.hasLateEvidence ? '有晚到证据' : ''}</td>
      </tr>)}</tbody></table></div>}
    {data.events.length ? <><h3>引擎记录</h3><ul className="mih-wsh-events">{data.events.map(event => <li key={event.id}>
      {formatDate(event.createdAt)} · {event.action} · #{event.revision} · {event.actor}：{event.reason}</li>)}</ul></> : null}
    <p className="mih-wsh-note">计费默认关闭：只转发，不写使用账本、不扣费，Hub 的使用记录里不会出现这些任务（以本页任务记录为准）。开启后按套餐里 wechat.selfhosted.search 的价格计费。</p>
    <p className="mih-wsh-note">限额：每批 {data.limits.batchItems} 条，每个调用方未完成 {data.limits.consumerOpen} 条，全局排队 {data.limits.globalQueued} 条，最长排队 {data.limits.queueWaitMs / 3_600_000} 小时。供应商限速（TikHub 图 4）不作用于本引擎。</p>
  </section>
}
