import { useCallback, useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, formatDate } from './components.jsx'
import { collectorRunView } from '../shared/integration-slots.mjs'

const CASES = [
  { key: 'news-feed', title: '采集一页新闻', capability: 'news.collect', description: '澎湃新闻 · 最多 5 条 · 1 页 · 自动保存', expected: '取得 task.id / run.id 后查看运行；核对 saved / created / skipped。', source: 'Night-All-A china-news manifest 与官方 quickstart' },
  { key: 'news-search', title: '按关键词采集新闻', capability: 'news.search', description: '澎湃新闻 · 输入关键词 · 最多 5 条 · 1 页', expected: '搜索结果可能为空或部分完成；必须检查运行状态与完整性。', source: 'Night-All-A china-news manifest 的 news.search' },
  { key: 'plan', title: '立即执行已有计划', description: '读取上游已有计划，选择后触发一次执行批次', expected: '记录 occurrence.id，再查询该计划批次关联的 runs；不创建另一套定时器。', source: 'Night-All-A collection-plans/run-now 与 occurrences' },
]
const STATUS = { accepted: '已受理', running: '执行中', succeeded: '执行成功', failed: '失败', blocked: '阻塞', cancelled: '已取消', unknown: '未知' }
const json = value => JSON.stringify(value, null, 2)
const itemsOf = value => Array.isArray(value?.items) ? value.items : []
const STORE_KEY = 'mx-insight-hub.night-all-a-case-key'
function initialKey() { try { return sessionStorage.getItem(STORE_KEY) || crypto.randomUUID() } catch { return crypto.randomUUID() } }

export function NightAllAWorkbench({ token, connection }) {
  const [section, setSection] = useState('cases')
  const [caseKey, setCaseKey] = useState('news-feed')
  const [keyword, setKeyword] = useState('人工智能')
  const [limit, setLimit] = useState(5)
  const [reason, setReason] = useState('')
  const [planId, setPlanId] = useState('')
  const [plans, setPlans] = useState([])
  const [occurrenceRuns, setOccurrenceRuns] = useState([])
  const [requestKey, setRequestKey] = useState(initialKey)
  const [frozen, setFrozen] = useState(false)
  const [submitted, setSubmitted] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [rows, setRows] = useState([])
  const [history, setHistory] = useState(null)
  const [runId, setRunId] = useState('')
  const [run, setRun] = useState(null)
  const [logs, setLogs] = useState(null)
  const [steps, setSteps] = useState(null)
  const [observedAt, setObservedAt] = useState(null)
  const [following, setFollowing] = useState(false)
  const locked = useRef(false)
  const selection = useRef(0)
  const mounted = useRef(true)
  const command = useRef(null)
  const selected = CASES.find(item => item.key === caseKey)
  const input = caseKey === 'plan' ? { id: planId, reason } : { body: {
    connector_id: 'china-news', capability: selected.capability,
    parameters: { platforms: ['thepaper'], ...(caseKey === 'news-search' ? { query: keyword } : {}), limit_per_platform: Number(limit), max_pages: 1 },
    persist_results: true, max_attempts: 1,
  }, reason }
  const operation = caseKey === 'plan' ? 'runPlan' : 'createTask'
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; selection.current++ } }, [])
  const call = useCallback(async (operation, input = {}, key = undefined) => {
    const response = await adminApi.nightAllADispatch(token, operation, input, key)
    if (response.upstreamStatus < 200 || response.upstreamStatus >= 300) {
      const failure = new Error(`Night-All-A 返回 HTTP ${response.upstreamStatus}；请检查上游认证、参数或任务状态。`)
      failure.details = response; throw failure
    }
    return response
  }, [token])

  async function action(fn) {
    if (locked.current) return
    locked.current = true; setBusy(true); setError(null)
    try { await fn() } catch (failure) { if (mounted.current) setError(failure) }
    finally { locked.current = false; if (mounted.current) setBusy(false) }
  }
  function chooseCase(key) { if (!frozen) { setCaseKey(key); setError(null) } }
  function newCommand() {
    const key = crypto.randomUUID()
    setRequestKey(key); command.current = null; setFrozen(false); setSubmitted(null); setError(null); setOccurrenceRuns([])
    try { sessionStorage.setItem(STORE_KEY, key) } catch { /* memory fallback */ }
  }
  async function submit() {
    await action(async () => {
      if (!command.current) command.current = { operation, input: structuredClone(input) }
      setFrozen(true)
      try { sessionStorage.setItem(STORE_KEY, requestKey) } catch { /* memory fallback */ }
      const result = await call(command.current.operation, command.current.input, requestKey)
      setSubmitted(result)
      if (result.data?.run?.id) {
        setRunId(String(result.data.run.id)); setRun(result.data.run); setLogs(null); setSteps(null)
      }
    })
  }
  const inspectRun = useCallback(async (id, epoch) => {
    // These are observations only. Each result keeps its own failure; a log failure never causes a new task.
    const results = await Promise.allSettled(['run', 'runLogs', 'runSteps'].map(operation => call(operation, { id })))
    if (!mounted.current || epoch !== selection.current) return
    const [detail, logResult, stepResult] = results
    if (detail.status === 'rejected') { setFollowing(false); throw detail.reason }
    const value = detail.value.data
    setRun(value); setLogs(logResult.status === 'fulfilled' ? logResult.value.data : { error: logResult.reason.message })
    setSteps(stepResult.status === 'fulfilled' ? stepResult.value.data : { error: stepResult.reason.message })
    setObservedAt(new Date().toISOString())
    if (collectorRunView(value).terminal || logResult.status === 'rejected' || stepResult.status === 'rejected') setFollowing(false)
  }, [call])
  function openRun(id) {
    setFollowing(false); setRunId(String(id)); setRun(null); setLogs(null); setSteps(null)
    const epoch = ++selection.current
    action(() => inspectRun(String(id), epoch))
  }
  useEffect(() => {
    if (!following || !runId || section !== 'runs') return
    let stopped = false; let timer
    const deadline = Date.now() + 5 * 60 * 1000
    const tick = async () => {
      if (stopped) return
      if (document.hidden || Date.now() >= deadline) { setFollowing(false); return }
      if (!locked.current) {
        locked.current = true; setBusy(true)
        try { await inspectRun(runId, selection.current) }
        catch (failure) { if (!stopped) { setError(failure); setFollowing(false) } }
        finally { locked.current = false; if (mounted.current) setBusy(false) }
      }
      if (!stopped) timer = setTimeout(tick, 5000)
    }
    timer = setTimeout(tick, 5000)
    return () => { stopped = true; clearTimeout(timer) }
  }, [following, runId, section, inspectRun])
  function changeRunId(value) { selection.current++; setFollowing(false); setRunId(value); setRun(null); setLogs(null); setSteps(null); setObservedAt(null) }
  async function loadTasks() { await action(async () => { setRows(itemsOf((await call('tasks', { query: { limit: 20 } })).data)) }) }
  async function taskRuns(id) {
    await action(async () => {
      const task = (await call('task', { id })).data
      const latest = task.runs?.at(-1)
      if (!latest) throw new Error('该任务暂未返回运行记录，请稍后查询。')
      const epoch = ++selection.current; setRunId(String(latest.id)); setFollowing(false)
      await inspectRun(String(latest.id), epoch)
    })
  }
  const runView = collectorRunView(run || {})
  const unknown = error?.code === 'night_all_a_outcome_unknown' || error?.code === 'network_error'
  return <section className="qp-panel mih-panel mih-na-workbench">
    <header><h2>采集操作台</h2><p>案例准备 → 明确触发 → 运行与日志 → 核对数据交付</p></header>
    <div className="mih-na-tabs" role="tablist" aria-label="采集操作台">
      {[['cases', '案例与触发'], ['runs', '任务与日志'], ['history', 'Hub 操作记录']].map(([key, label]) => <button role="tab" aria-selected={section === key} key={key} className={`qp-button ${section === key ? 'qp-button--primary' : 'qp-button--outline'}`} onClick={() => { setSection(key); setFollowing(false) }}>{label}</button>)}
    </div>
    {!connection.enabled ? <p className="qp-tag">当前转发未启用：可以查看案例和请求预览，运行数据不会被模拟。</p> : null}
    {section === 'cases' ? <>
      <div className="mih-na-case-grid">{CASES.map(item => <article className={`qp-panel mih-na-case ${caseKey === item.key ? 'is-selected' : ''}`} key={item.key}>
        <span className="qp-tag">{item.key === 'plan' ? '计划触发' : '有界采集案例'}</span><h3>{item.title}</h3><p>{item.description}</p><p>{item.expected}</p><small>契约依据：{item.source}；当前环境未做实时验收。</small>
        <button className="qp-button qp-button--outline" disabled={frozen || busy} onClick={() => chooseCase(item.key)}>{caseKey === item.key ? '已选择' : '载入案例'}</button>
      </article>)}</div>
      <div className="mih-na-form">
        {caseKey === 'plan' ? <><button className="qp-button qp-button--outline" disabled={busy || frozen || !connection.enabled} onClick={() => action(async () => setPlans(itemsOf((await call('plans')).data)))}>读取已有采集计划</button><DropdownField label="已有采集计划" value={planId} onChange={setPlanId} disabled={frozen || busy} options={plans.map(plan => ({ value: String(plan.id), label: `${plan.name} · #${plan.id}` }))} /></> : <>
          {caseKey === 'news-search' ? <label className="qp-field">关键词<input className="qp-input" value={keyword} maxLength={200} disabled={frozen || busy} onChange={event => setKeyword(event.target.value)} /></label> : null}
          <label className="qp-field">最多采集条数（1–20）<input className="qp-input" type="number" min="1" max="20" value={limit} disabled={frozen || busy} onChange={event => setLimit(event.target.value)} /></label>
        </>}
        <label className="qp-field">本次操作原因<input className="qp-input" value={reason} maxLength={500} disabled={frozen || busy} placeholder="例如：验证今天的新闻入库链路" onChange={event => setReason(event.target.value)} /></label>
      </div>
      <details><summary>查看将发送的请求与去重标识</summary><p>Idempotency-Key：<code>{requestKey}</code></p><pre>{json(command.current?.input || input)}</pre><p>此键在浏览器会话保留；同一键不会重复派发。准备新的采集才生成另一键。</p></details>
      <div className="mih-na-actions"><button className="qp-button qp-button--primary" disabled={busy || !connection.writesEnabled || !reason.trim() || (caseKey === 'plan' ? !planId : !Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 20 || (caseKey === 'news-search' && !keyword.trim()))} onClick={submit}>{busy ? '处理中…' : frozen ? '核对原请求（同一键）' : '触发一次采集'}</button>
        <button className="qp-button qp-button--outline" disabled={busy || (frozen && !submitted && !(error?.details?.upstreamStatus >= 400 && error?.details?.upstreamStatus < 500))} onClick={newCommand}>准备另一笔采集</button></div>
      {submitted ? <div className="mih-na-result"><strong>{submitted.replay ? '已回放原请求' : '请求已受理'} · HTTP {submitted.upstreamStatus}</strong><p>Hub 派发 ID：{submitted.dispatchId}</p>{submitted.data?.run?.id ? <><p>任务 #{submitted.data.task?.id ?? '未知'} · 运行 #{submitted.data.run.id}</p><button className="qp-button qp-button--outline" onClick={() => { setSection('runs'); openRun(submitted.data.run.id) }}>查看本次状态与日志</button></> : <><p>计划执行批次 #{submitted.data?.id ?? '未知'}。一个批次可能包含多个任务。</p><button className="qp-button qp-button--outline" disabled={busy} onClick={() => action(async () => {
          const response = await call('occurrences', { id: command.current.input.id, query: { limit: 50 } })
          const occurrence = itemsOf(response.data).find(item => String(item.id) === String(submitted.data?.id))
          setOccurrenceRuns(occurrence?.runs || [])
          if (!occurrence) throw new Error('最近 50 个批次未找到本次记录，请在上游核对；不会重新触发。')
        })}>查询本批次运行</button>{occurrenceRuns.map(item => <button className="qp-button qp-button--outline" key={item.id} disabled={busy} onClick={() => { setSection('runs'); openRun(item.id) }}>运行 #{item.id} · {item.status}</button>)}</>}
      </div> : null}
      {unknown ? <p>派发结果未知，请保留错误中的 dispatchId，在 Hub 操作记录核对；不会自动生成新键或重新提交。</p> : null}
    </> : null}
    {section === 'runs' ? <>
      <div className="mih-na-actions"><button className="qp-button qp-button--outline" disabled={busy || !connection.enabled} onClick={loadTasks}>读取最近 20 个上游任务</button><span>包含从 Night-All-A 其他入口创建的任务；不是 Hub 派发统计。</span></div>
      {rows.length ? <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>任务</th><th>能力</th><th>上游状态</th><th>操作</th></tr></thead><tbody>{rows.map(task => <tr key={task.id}><td>#{task.id} · {task.connector_id}</td><td>{task.capability}</td><td>{task.status}</td><td><button className="qp-button qp-button--outline" disabled={busy} onClick={() => taskRuns(task.id)}>查看运行与日志</button></td></tr>)}</tbody></table></div> : <p>尚无已加载任务。点击读取后查询真实上游。</p>}
      <div className="mih-na-form"><label className="qp-field">运行 ID<input className="qp-input" value={runId} onChange={event => changeRunId(event.target.value)} /></label><div className="mih-na-actions"><button className="qp-button qp-button--primary" disabled={busy || !connection.enabled || !/^[1-9]\d*$/.test(runId)} onClick={() => openRun(runId)}>读取状态与日志</button><button className="qp-button qp-button--outline" disabled={!connection.enabled || !run || runView.terminal || busy} onClick={() => setFollowing(value => !value)}>{following ? '停止跟踪' : '每 5 秒跟踪'}</button></div></div>
      <p>跟踪只查询当前运行，离开页面、切换运行、页面进入后台、终态或出错时停止；最多持续 5 分钟。不触发采集，不重试任务。最近读取：{observedAt ? formatDate(observedAt) : '尚未读取'}。</p>
      {run ? <><div className="mih-na-run-metrics">{[['运行状态', STATUS[runView.state]], ['数据完整性', { complete: '完整', partial: '部分', unknown: '未知' }[runView.completeness]], ['上游保存条数', runView.records?.saved ?? '未知'], ['Hub 入库状态', '需在清洗计划核对']].map(([label, value]) => <div className="qp-panel" key={label}><small>{label}</small><strong>{value}</strong></div>)}</div>
        <p>运行 #{run.id} · 任务 #{run.task_id ?? '未知'} · 原始状态 {run.status} · trace {run.trace_id || '未提供'}</p>
        {run.error_message ? <p role="alert">{run.error_code}：{run.error_message}</p> : null}
        <h3>操作步骤</h3>{steps?.error ? <p role="alert">步骤暂不可读：{steps.error}</p> : itemsOf(steps).length ? <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>步骤</th><th>状态</th><th>说明</th><th>时间</th></tr></thead><tbody>{itemsOf(steps).map(step => <tr key={step.id}><td>{step.sequence} · {step.step_key || `#${step.id}`}</td><td>{step.status}</td><td>{typeof step.detail === 'string' ? step.detail : json(step.detail)}{step.error_code ? <p>{step.error_code}</p> : null}</td><td>{step.started_at ? formatDate(step.started_at) : '—'}<br />{step.finished_at ? formatDate(step.finished_at) : '—'}</td></tr>)}</tbody></table></div> : <p>上游尚未提供操作步骤。</p>}
        <h3>运行日志</h3>{logs?.error ? <p role="alert">日志暂不可读：{logs.error}</p> : itemsOf(logs).length ? <div className="mih-na-logs">{itemsOf(logs).map((entry, index) => <article key={`${entry.step_id}-${index}`}><strong>{entry.level} · 步骤 {entry.step_id ?? '—'}</strong><pre>{typeof entry.message === 'string' ? entry.message : json(entry.message)}</pre>{entry.error_code ? <code>{entry.error_code}</code> : null}</article>)}</div> : <p>本次上游未返回日志条目；不代表采集成功。</p>}
        <details><summary>完整运行结果与保存指标</summary><pre>{json(run)}</pre></details>
      </> : null}
    </> : null}
    {section === 'history' ? <><p>最近 50 条 Hub 写操作登记，含原因、派发状态和返回的任务标识。completed 表示已记录 HTTP 响应；上游执行状态另查。不包含所有读取请求或其他入口任务。</p><button className="qp-button qp-button--outline" disabled={busy} onClick={() => action(async () => setHistory(await adminApi.nightAllADispatches(token)))}>读取 Hub 操作记录</button>
      {history && !history.available ? <p role="status">{history.note}</p> : null}
      {history?.available ? history.items.length ? <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>时间 / 原因</th><th>操作 / 状态</th><th>证据</th></tr></thead><tbody>{history.items.map(item => <tr key={item.id}><td>{item.created_at}<p>{item.reason}</p><small>{item.actor}</small></td><td>{item.operation}<p>{item.state}</p></td><td><code>{item.id}</code>{item.response?.data?.run?.id ? <button className="qp-button qp-button--outline" onClick={() => { setSection('runs'); openRun(item.response.data.run.id) }}>查看运行 #{item.response.data.run.id}</button> : null}<details><summary>派发响应</summary><pre>{json(item.response)}</pre></details></td></tr>)}</tbody></table></div> : <p>当前没有 Hub 写操作登记。</p> : null}
    </> : null}
    {error ? <><ErrorState error={error} /><pre>{json(error.details || {})}</pre></> : null}
  </section>
}
