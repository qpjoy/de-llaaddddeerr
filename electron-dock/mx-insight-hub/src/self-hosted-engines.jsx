import { useCallback, useEffect, useMemo, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, LoadingState, PageHeading, StatusBadge, formatDate, useRemoteData } from './components.jsx'
import { WechatSelfHostedEngineAdmin } from './wechat-self-hosted.jsx'
import { COLLECT_ENGINE_BOUNDS as BOUNDS, COLLECT_KINDS } from '../shared/collect-engines.mjs'
import './self-hosted-engines.css'

// 自建引擎管理: every self-hosted collection engine in one place. Generic
// engines (schema collect) are managed here in full; the WeChat engine keeps
// its own tables for now and is shown with its existing management panel.
// Design: docs/architecture/spider_man/07-collect-engines.md

const STATUS = { queued: '排队中', running: '执行中', succeeded: '已完成', failed: '失败', unknown: '结果未知', cancelled: '已取消', expired: '排队超时' }
const PHASE = { dispatching: '派发中', waiting: '上游执行中' }
const DATA = { success: '完整', partial: '部分', no_data: '空结果', unknown: '未知' }
const BILLING = { none: '未计费', reserved: '已预留', charged: '已计费', not_charged: '不计费', pending_review: '待核实' }
const KIND = { runner: '独立 runner', apify: 'Apify Actor', night_all_http: 'Night-All HTTP' }
const EVENT = { created: '新建', configured: '修改配置', recovered: '恢复引擎', slot_recovered: '恢复执行槽', slot_quarantined: '执行槽隔离',
  quarantined: '引擎隔离', cooldown: '冷却', reconcile: '向上游核对', credential_updated: '更新凭据', egress_updated: '更新出口' }
const EGRESS = { inherit: '继承全局', 'system-egress': '系统直连', 'proxy-sequence': '代理序列' }
const money = value => Number.isFinite(value) ? `$${value.toFixed(4)}` : '—'
const TABS = [['overview', '概览'], ['config', '配置'], ['jobs', '任务'], ['events', '记录']]

const shortId = value => value ? String(value).slice(0, 8) : '—'
const seconds = ms => ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${Math.round(ms / 1000)} 秒` : `${Math.round(ms / 60_000)} 分钟`
const recentText = recent => {
  const parts = [['succeeded', '成功'], ['failed', '失败'], ['unknown', '未知'], ['expired', '超时']]
    .filter(([key]) => recent?.[key]).map(([key, label]) => `${label} ${recent[key]}`)
  return parts.length ? parts.join(' · ') : '—'
}

export function engineState(engine) {
  if (engine.error) return { status: 'down', label: '读取失败' }
  if (!engine.enabled) return { status: 'disabled', label: '已停用' }
  if (engine.quarantineReason) return { status: 'down', label: '引擎已隔离' }
  if (engine.stats?.quarantinedSlots) return { status: 'warning', label: '有执行槽待核实' }
  if (engine.cooling || (engine.cooldownUntil && Date.parse(engine.cooldownUntil) > Date.now())) return { status: 'warning', label: '冷却中' }
  if (engine.stats?.busySlots) return { status: 'active', label: '执行中' }
  return { status: 'ready', label: '空闲' }
}

function JobStatus({ job }) {
  return <span className={`mih-wsh-status mih-wsh-status--${job.status}`}>{STATUS[job.status] || job.status}{job.phase ? ` · ${PHASE[job.phase]}` : ''}</span>
}

function useAction(notify, onUnauthorized) {
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(null)
  const run = useCallback(async (action, success) => {
    setBusy(true); setFailure(null)
    try { const value = await action(); if (success) notify?.(success, 'success'); return value ?? true }
    catch (error) { setFailure(error); if (error.status === 401) onUnauthorized?.(error); return null }
    finally { setBusy(false) }
  }, [notify, onUnauthorized])
  return { busy, failure, run, clear: () => setFailure(null) }
}

export function SelfHostedEnginesPage({ token, query, setQuery, onUnauthorized, notify }) {
  const load = useCallback(() => adminApi.collectEngines(token), [token])
  const remote = useRemoteData(load, onUnauthorized)
  // The catalog is code-owned and static for a deployment: read it once.
  const loadCatalog = useCallback(() => adminApi.collectCatalog(token), [token])
  const catalogRemote = useRemoteData(loadCatalog, onUnauthorized)
  useEffect(() => {
    const timer = setInterval(remote.refresh, 10_000)
    return () => clearInterval(timer)
  }, [remote.refresh])
  const selected = query.get('engine')
  const creating = query.get('new') === '1'
  const data = remote.data && catalogRemote.data ? { ...remote.data, catalog: catalogRemote.data } : null
  const rows = useMemo(() => !data ? [] : [
    ...data.engines.map(engine => ({ ...engine, source: 'collect' })),
    ...data.legacy.map(engine => ({ ...engine, routes: (engine.capabilities || []).map(capability => ({ capability, routeKey: '' })) })),
  ], [data])
  const totals = useMemo(() => rows.reduce((sum, row) => ({
    engines: sum.engines + 1, enabled: sum.enabled + (row.enabled ? 1 : 0), slots: sum.slots + (row.enabled ? row.capacity || 0 : 0),
    busy: sum.busy + (row.stats?.busySlots || 0), queued: sum.queued + (row.stats?.queued || 0),
    attention: sum.attention + (row.stats?.quarantinedSlots || 0) + (row.quarantineReason ? 1 : 0),
  }), { engines: 0, enabled: 0, slots: 0, busy: 0, queued: 0, attention: 0 }), [rows])
  const current = rows.find(row => row.id === selected) || null

  return <div className="mih-she">
    <PageHeading eyebrow="数据接入与治理" title="自建引擎" loading={remote.loading} onRefresh={remote.refresh}
      description="统一查看所有自建采集引擎：执行槽、队列、任务和需要人工核实的结果。引擎在 Hub 数据库里排队与互斥，对外是 202 + 轮询接口。">
      <button type="button" className="qp-button qp-button--primary" onClick={() => setQuery({ new: '1', engine: null, tab: null })}>新建引擎</button>
    </PageHeading>
    {(remote.error || catalogRemote.error) && !data ? <ErrorState error={remote.error || catalogRemote.error} onRetry={() => { remote.refresh(); catalogRemote.refresh() }} /> : null}
    {!data && !remote.error && !catalogRemote.error ? <LoadingState label="正在读取自建引擎" /> : null}
    {data ? <>
      <section className="mih-wsh-cards mih-she-totals" aria-label="引擎概况">
        <div><small>引擎</small><strong>{totals.enabled} / {totals.engines} 启用</strong></div>
        <div><small>执行槽</small><strong>{totals.busy} / {totals.slots} 占用</strong></div>
        <div><small>排队</small><strong>{totals.queued}</strong></div>
        <div className={totals.attention ? 'is-warning' : ''}><small>待人工核实</small><strong>{totals.attention}</strong></div>
        <div><small>本进程执行器</small><strong>{data.executor.running ? '运行中' : '未运行（Public 进程）'}</strong></div>
      </section>
      <section className="qp-panel mih-panel mih-she-list">
        <div className="qp-table-wrap"><table className="qp-table mih-table">
          <thead><tr><th>引擎</th><th>类型</th><th>承接能力</th><th>状态</th><th>执行槽</th><th>排队</th><th>近 24 小时</th><th /></tr></thead>
          <tbody>{rows.map(row => {
            const state = engineState(row)
            return <tr key={row.id} aria-selected={row.id === selected}>
              <td><strong>{row.displayName}</strong><br /><code>{row.id}</code>{row.source === 'wechat' ? <span className="mih-she-tag">原微信引擎</span> : null}</td>
              <td>{KIND[row.kind] || row.kind}</td>
              <td>{row.routes?.length ? row.routes.map(route => <code key={`${route.capability}:${route.routeKey}`} className="mih-she-route">
                {route.capability}{route.routeKey ? `:${route.routeKey}` : ''}</code>) : <span className="mih-wsh-note">未承接</span>}</td>
              <td><StatusBadge status={state.status} label={state.label} /></td>
              <td>{row.error ? '—' : `${row.stats.busySlots} / ${row.capacity}${row.stats.quarantinedSlots ? ` · 隔离 ${row.stats.quarantinedSlots}` : ''}`}</td>
              <td>{row.stats?.queued ?? '—'}</td>
              <td>{row.source === 'wechat' ? recentText(row.stats?.recentSample) : recentText(row.stats?.recent)}{row.stats?.costUsd24h ? ` · ${money(row.stats.costUsd24h)}` : ''}</td>
              <td><button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => setQuery({ engine: row.id, new: null, tab: null })}>管理</button></td>
            </tr>
          })}</tbody></table></div>
        {!rows.length ? <p className="mih-she-empty">还没有引擎。新建后默认停用，绑定能力、探测连通后再启用。</p> : null}
      </section>
      {creating ? <CreateEngine token={token} catalog={data.catalog} notify={notify} onUnauthorized={onUnauthorized}
        onCancel={() => setQuery({ new: null })} onCreated={engine => { remote.refresh(); setQuery({ new: null, engine: engine.id, tab: null }) }} /> : null}
      {current?.source === 'wechat' ? <section className="mih-she-legacy">
        <p className="mih-wsh-note">微信引擎沿用 migration 165 的独立表和执行器，单执行槽；这里直接使用它原有的管理面板。迁入通用引擎前，两者互不影响。</p>
        <WechatSelfHostedEngineAdmin token={token} onUnauthorized={onUnauthorized} notify={notify} />
      </section> : null}
      {current?.source === 'collect' ? <EngineDetail key={current.id} token={token} engineId={current.id} catalog={data.catalog}
        tab={query.get('tab') || 'overview'} setTab={tab => setQuery({ engine: current.id, tab })} notify={notify}
        onUnauthorized={onUnauthorized} onChanged={remote.refresh} /> : null}
      {selected && !current ? <p role="status">没有找到引擎 {selected}。</p> : null}
    </> : null}
  </div>
}

function EngineDetail({ token, engineId, catalog, tab, setTab, notify, onUnauthorized, onChanged }) {
  const load = useCallback(() => adminApi.collectEngine(token, engineId), [token, engineId])
  const remote = useRemoteData(load, onUnauthorized)
  const data = remote.data
  const active = Boolean(data?.queue.running || data?.queue.queued)
  useEffect(() => {
    const timer = setInterval(remote.refresh, active ? 5_000 : 15_000)
    return () => clearInterval(timer)
  }, [remote.refresh, active])
  const refresh = () => { remote.refresh(); onChanged?.() }
  if (!data && remote.error) return <ErrorState error={remote.error} onRetry={remote.refresh} />
  if (!data) return <LoadingState label="正在读取引擎" />
  const engine = data.engine
  const state = engineState({ ...engine, stats: { busySlots: data.slots.filter(slot => slot.jobId && !slot.quarantineReason).length,
    quarantinedSlots: data.slots.filter(slot => slot.quarantineReason).length } })
  return <section className="qp-panel mih-panel mih-she-detail" aria-label={`引擎 ${engine.displayName}`}>
    <header className="mih-she-detail__head">
      <div><h2>{engine.displayName} <StatusBadge status={state.status} label={state.label} /></h2>
        <p className="mih-wsh-note"><code>{engine.id}</code> · {KIND[engine.kind] || engine.kind}{engine.slotRef ? ` · 插槽 ${engine.slotRef}` : ''} · 修订 #{engine.revision}
          {!data.kind.available ? ' · 当前 Hub 版本不支持该类型' : ''}</p></div>
    </header>
    <nav className="mih-source-section-tabs" aria-label="引擎详情">
      {TABS.map(([key, label]) => <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}
    </nav>
    {tab === 'overview' ? <EngineOverview token={token} data={data} notify={notify} onUnauthorized={onUnauthorized} onChanged={refresh} /> : null}
    {tab === 'config' ? <EngineConfig token={token} data={data} catalog={catalog} notify={notify} onUnauthorized={onUnauthorized} onChanged={refresh} /> : null}
    {tab === 'jobs' ? <EngineJobs token={token} jobs={data.jobs} onUnauthorized={onUnauthorized} /> : null}
    {tab === 'events' ? <EngineEvents events={data.events} /> : null}
  </section>
}

function EngineOverview({ token, data, notify, onUnauthorized, onChanged }) {
  const engine = data.engine
  const action = useAction(notify, onUnauthorized)
  const [reasons, setReasons] = useState({}), [probe, setProbe] = useState(null)
  const recoverSlot = async slotNo => {
    const ok = await action.run(() => adminApi.recoverCollectSlot(token, engine.id, slotNo, { expectedRevision: engine.revision, reason: reasons[slotNo] || '' }), `执行槽 ${slotNo} 已恢复`)
    if (ok) { setReasons({ ...reasons, [slotNo]: '' }); onChanged() }
  }
  const recoverEngine = async () => {
    const ok = await action.run(() => adminApi.recoverCollectEngine(token, engine.id, { expectedRevision: engine.revision, reason: reasons.engine || '' }), '引擎已恢复派发')
    if (ok) { setReasons({ ...reasons, engine: '' }); onChanged() }
  }
  const check = async () => {
    setProbe({ pending: true })
    try { setProbe(await adminApi.probeCollectEngine(token, engine.id)) } catch (error) { setProbe({ error }) }
  }
  return <>
    <div className="mih-wsh-cards">
      <div><small>执行槽</small><strong>{data.queue.running} / {engine.capacity} 执行中</strong></div>
      <div><small>排队</small><strong>{data.queue.queued} / {engine.queueLimit}</strong></div>
      <div><small>最近单条耗时（中位）</small><strong>{data.queue.medianMs == null ? '暂无' : seconds(data.queue.medianMs)}</strong></div>
      <div><small>预计排空</small><strong>{data.queue.drainAt ? formatDate(data.queue.drainAt) : '—'}</strong></div>
      <div><small>计费</small><strong>{engine.billingEnabled ? '已开启' : '关闭（只转发）'}</strong></div>
      <div><small>单次执行上限</small><strong>{seconds(engine.runTimeoutMs)}</strong></div>
    </div>
    {engine.quarantineReason ? <div className="mih-wsh-alert" role="alert">
      <p><strong>引擎已隔离：</strong>{engine.quarantineReason}（{formatDate(engine.quarantinedAt)}）。隔离期间不派发新任务。</p>
      <label className="qp-field">恢复原因（必填）<input className="qp-input" value={reasons.engine || ''} onChange={event => setReasons({ ...reasons, engine: event.target.value })} /></label>
      <button type="button" className="qp-button qp-button--primary" disabled={action.busy || (reasons.engine || '').trim().length < 2} onClick={recoverEngine}>确认后恢复派发</button>
    </div> : null}
    <h3>执行槽</h3>
    <p className="mih-wsh-note">每个执行槽同一时间只跑一个任务，由 PostgreSQL 行约束保证，与 Hub 有几个进程无关。结果未知时该槽保持占用，确认上游已结束后再恢复。</p>
    <ol className="mih-she-slots">{data.slots.map(slot => <li key={slot.slotNo} className={slot.quarantineReason ? 'is-quarantined' : slot.jobId ? 'is-busy' : ''}>
      <header><strong>#{slot.slotNo}</strong>{slot.slotNo > engine.capacity ? <span className="mih-she-tag">缩容中</span> : null}</header>
      {!slot.jobId ? <p>空闲</p> : <>
        <p>{slot.quarantineReason ? <>已隔离：<code>{slot.quarantineReason}</code></> : <>{STATUS[slot.job?.status] || slot.job?.status}{slot.job?.phase ? ` · ${PHASE[slot.job.phase]}` : ''}</>}</p>
        <p className="mih-wsh-note">任务 <code>{shortId(slot.jobId)}</code>{slot.job?.dispatchedAt ? ` · ${formatDate(slot.job.dispatchedAt)} 派发` : ''}{slot.quarantinedAt ? ` · ${formatDate(slot.quarantinedAt)} 隔离` : ''}</p>
      </>}
      {slot.quarantineReason ? <div className="mih-she-recover">
        <input className="qp-input" aria-label={`执行槽 ${slot.slotNo} 恢复原因`} placeholder="例如：已在 runner 上确认进程退出"
          value={reasons[slot.slotNo] || ''} onChange={event => setReasons({ ...reasons, [slot.slotNo]: event.target.value })} />
        <button type="button" className="qp-button qp-button--outline qp-button--sm" disabled={action.busy || (reasons[slot.slotNo] || '').trim().length < 2}
          onClick={() => recoverSlot(slot.slotNo)}>确认已结束，恢复</button>
      </div> : null}
    </li>)}</ol>
    <div className="mih-page-actions">
      <button type="button" className="qp-button qp-button--outline" disabled={probe?.pending || (!engine.baseUrl && COLLECT_KINDS[engine.kind]?.baseUrl !== 'none')} onClick={check}>连通性探测（只读）</button>
    </div>
    {probe && !probe.pending ? <p role="status">{probe.error ? `探测失败：${probe.error.message}` : probe.reachable
      ? `${probe.baseUrl} 可达 · HTTP ${probe.httpStatus} · ${probe.healthy ? '健康' : `未通过${probe.error ? `（${probe.error}）` : ''}`} · ${probe.durationMs} ms${probe.version ? ` · 版本 ${probe.version}` : ''}${probe.capacity != null ? ` · runner 容量 ${probe.capacity}` : ''}${probe.account ? ` · 账号 ${probe.account.username || '—'}（${probe.account.plan || '未知套餐'}）` : ''}${probe.usage ? ` · 本月已用 ${money(probe.usage.monthlyUsageUsd)} / 上限 ${money(probe.usage.maxMonthlyUsageUsd)}${probe.usage.maxConcurrentRuns ? ` · 并发上限 ${probe.usage.maxConcurrentRuns}` : ''}` : ''} · 凭据 ${{ configured: '已配置', missing: '缺失', not_required: '不需要' }[probe.credential] || probe.credential}`
      : `${probe.baseUrl} 不可达（${probe.error}）`}</p> : null}
    {action.failure ? <ErrorState error={action.failure} /> : null}
  </>
}

function RoutePicker({ kind, catalog, value, onChange }) {
  const options = catalog.capabilities.filter(row => row.kinds.includes(kind))
    .flatMap(row => row.routeBy ? row.routes.map(route => ({ capability: row.key, routeKey: route.key, label: `${row.label} · ${route.label}`, stage: row.stage }))
      : [{ capability: row.key, routeKey: '', label: row.label, stage: row.stage }])
  if (!options.length) return <p className="mih-wsh-note">该类型目前没有可承接的能力。</p>
  const has = option => value.some(route => route.capability === option.capability && route.routeKey === option.routeKey)
  return <fieldset className="mih-she-routes"><legend>承接能力</legend>{options.map(option => <label key={`${option.capability}:${option.routeKey}`} className="mih-wsh-check">
    <input type="checkbox" checked={has(option)} onChange={event => onChange(event.target.checked ? [...value, { capability: option.capability, routeKey: option.routeKey }]
      : value.filter(route => !(route.capability === option.capability && route.routeKey === option.routeKey)))} />
    {option.label} <code>{option.capability}{option.routeKey ? `:${option.routeKey}` : ''}</code>{option.stage === 'candidate' ? <span className="mih-she-tag">候选</span> : null}
  </label>)}</fieldset>
}

const numberField = (label, key, bound, draft, setDraft, hint) => <label className="qp-field">{label}
  <input className="qp-input" title={hint} type="number" min={bound.min} max={bound.max} value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value === '' ? '' : Number(event.target.value) })} />
</label>

function draftOf(engine, routes) {
  return { displayName: engine.displayName, baseUrl: engine.baseUrl || '', credentialProvider: engine.credentialProvider || '', slotRef: engine.slotRef || '',
    capacity: engine.capacity, queueLimit: engine.queueLimit, consumerOpenLimit: engine.consumerOpenLimit,
    queueWaitMinutes: Math.round(engine.queueWaitMs / 60_000), runTimeoutSeconds: Math.round(engine.runTimeoutMs / 1000),
    enabled: engine.enabled, billingEnabled: engine.billingEnabled, routes }
}

function EngineFields({ draft, setDraft, catalog, kind, creating = false }) {
  const kindInfo = COLLECT_KINDS[kind]
  const fixedAddress = kindInfo?.baseUrl === 'none'
  return <div className="mih-wsh-form mih-she-form">
    <label className="qp-field">名称<input className="qp-input" value={draft.displayName} maxLength={80} onChange={event => setDraft({ ...draft, displayName: event.target.value })} /></label>
    {fixedAddress ? null : <label className="qp-field">接口地址<input className="qp-input" value={draft.baseUrl} placeholder="http://10.0.0.8:18300" onChange={event => setDraft({ ...draft, baseUrl: event.target.value })} /></label>}
    <label className="qp-field">凭据键<input className="qp-input" title="凭据库（迁移 052）中的供应商键；留空表示不需要" value={draft.credentialProvider}
      placeholder={kindInfo?.defaultCredentialProvider || 'collect-runner'} onChange={event => setDraft({ ...draft, credentialProvider: event.target.value })} /></label>
    {fixedAddress ? null : <label className="qp-field">插槽 ID<input className="qp-input" title="integrations/ 下的插槽 ID，作为 runner 的 slotId" value={draft.slotRef} placeholder="market-195" onChange={event => setDraft({ ...draft, slotRef: event.target.value })} /></label>}
    {numberField('执行槽数', 'capacity', BOUNDS.capacity, draft, setDraft, '同时执行的任务数，按上游真实容量设置')}
    {numberField('排队上限', 'queueLimit', BOUNDS.queueLimit, draft, setDraft)}
    {numberField('每个调用方未完成上限', 'consumerOpenLimit', BOUNDS.consumerOpenLimit, draft, setDraft)}
    {numberField('最长排队（分钟）', 'queueWaitMinutes', BOUNDS.queueWaitMinutes, draft, setDraft)}
    {numberField('单次执行上限（秒）', 'runTimeoutSeconds', BOUNDS.runTimeoutSeconds, draft, setDraft)}
    <RoutePicker kind={kind} catalog={catalog} value={draft.routes} onChange={routes => setDraft({ ...draft, routes })} />
    {!creating ? <>
      <label className="mih-wsh-check"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />接收并派发新任务</label>
      <label className="mih-wsh-check"><input type="checkbox" title="关闭时不写使用账本" checked={draft.billingEnabled} onChange={event => setDraft({ ...draft, billingEnabled: event.target.checked })} />计费（派发时预留账本）</label>
    </> : null}
  </div>
}

const payloadOf = (draft, kind) => {
  const payload = { ...draft, credentialProvider: draft.credentialProvider.trim() || null, slotRef: draft.slotRef.trim() || null, baseUrl: draft.baseUrl.trim() || null }
  // Fixed-address kinds (Apify) take neither an address nor a runner slot.
  if (COLLECT_KINDS[kind]?.baseUrl === 'none') { delete payload.baseUrl; if (!payload.slotRef) delete payload.slotRef }
  return payload
}

function EngineConfig({ token, data, catalog, notify, onUnauthorized, onChanged }) {
  const engine = data.engine
  const [draft, setDraft] = useState(() => draftOf(engine, data.routes)), [reason, setReason] = useState('')
  const action = useAction(notify, onUnauthorized)
  useEffect(() => { setDraft(draftOf(engine, data.routes)) }, [engine.revision]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const ok = await action.run(() => adminApi.configureCollectEngine(token, engine.id, { ...payloadOf(draft, engine.kind), expectedRevision: engine.revision, reason }), '引擎配置已保存')
    if (ok) { setReason(''); onChanged() }
  }
  return <>
    <p className="mih-wsh-note">保存只改配置，不会采集。有任务在执行或等待核实时，不能更换地址、凭据和插槽；执行槽缩容时，忙碌的槽执行完再移除。</p>
    <EngineFields draft={draft} setDraft={setDraft} catalog={catalog} kind={engine.kind} />
    <div className="mih-wsh-form">
      <label className="qp-field">修改原因（必填）<input className="qp-input" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="mih-page-actions"><button type="button" className="qp-button qp-button--primary" disabled={action.busy || reason.trim().length < 2} onClick={save}>保存配置</button></div>
    </div>
    {action.failure ? <ErrorState error={action.failure} /> : null}
    {data.credential?.provider ? <CredentialPanel token={token} engine={engine} credential={data.credential} notify={notify} onUnauthorized={onUnauthorized} onChanged={onChanged} /> : null}
    {data.egress ? <EgressPanel token={token} engine={engine} egress={data.egress} notify={notify} onUnauthorized={onUnauthorized} onChanged={onChanged} /> : null}
  </>
}

// Write-only: the stored token is never shown, only whether one exists.
function CredentialPanel({ token, engine, credential, notify, onUnauthorized, onChanged }) {
  const [apiKey, setApiKey] = useState(''), [reason, setReason] = useState('')
  const action = useAction(notify, onUnauthorized)
  const save = async () => {
    const ok = await action.run(() => adminApi.setCollectCredential(token, engine.id, { apiKey, expectedRevision: credential.revision ?? 0, reason }), '凭据已保存')
    if (ok) { setApiKey(''); setReason(''); onChanged() }
  }
  return <section className="mih-she-subpanel" aria-label="引擎凭据">
    <h3>凭据 · <code>{credential.provider}</code></h3>
    <p className="mih-wsh-note">{credential.configured === true ? `已配置（修订 #${credential.revision}${credential.updatedAt ? `，${formatDate(credential.updatedAt)}` : ''}）。保存会替换现有凭据。`
      : credential.configured === false ? '未配置：派发会以「引擎凭据未配置」失败，不收费。' : `状态未知${credential.error ? `（${credential.error}）` : ''}。`}
      凭据存入共享凭据库（迁移 052），同一供应商键的引擎共用；页面和接口都不会回显。</p>
    {credential.writable ? <div className="mih-wsh-form">
      <label className="qp-field">新凭据<input className="qp-input" type="password" autoComplete="off" value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
      <label className="qp-field">原因（必填）<input className="qp-input" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="mih-page-actions"><button type="button" className="qp-button qp-button--outline" disabled={action.busy || !apiKey.trim() || reason.trim().length < 2} onClick={save}>保存凭据</button></div>
    </div> : null}
    {action.failure ? <ErrorState error={action.failure} /> : null}
  </section>
}

function EgressPanel({ token, engine, egress, notify, onUnauthorized, onChanged }) {
  const [mode, setMode] = useState(egress.mode || 'system-egress'), [sequenceKey, setSequenceKey] = useState(egress.sequenceKey || ''), [reason, setReason] = useState('')
  const action = useAction(notify, onUnauthorized)
  useEffect(() => { setMode(egress.mode || 'system-egress'); setSequenceKey(egress.sequenceKey || '') }, [egress.revision]) // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const ok = await action.run(() => adminApi.setCollectEgress(token, engine.id, { mode, sequenceKey: mode === 'proxy-sequence' ? sequenceKey : null,
      expectedRevision: egress.revision, reason }), '出口已保存')
    if (ok) { setReason(''); onChanged() }
  }
  if (!egress.available) return <section className="mih-she-subpanel"><h3>出口 · <code>{egress.provider}</code></h3><p className="mih-wsh-note">当前进程没有数据库，调用直连上游（仅本地开发）。</p></section>
  return <section className="mih-she-subpanel" aria-label="引擎出口">
    <h3>出口 · System Proxy 绑定 <code>{egress.provider}</code></h3>
    <p className="mih-wsh-note">当前：{EGRESS[egress.mode] || egress.mode}{egress.sequenceKey ? ` · ${egress.sequenceKey}` : ''}（修订 #{egress.revision}）。只对未鉴权的连通性探测切换代理；付费请求结果不明时从不换路重试。同一供应商的所有引擎共用这条绑定。</p>
    <div className="mih-wsh-form">
      <label className="qp-field">方式<select className="qp-input" value={mode} onChange={event => setMode(event.target.value)}>
        {Object.entries(EGRESS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {mode === 'proxy-sequence' ? <label className="qp-field">代理序列<select className="qp-input" value={sequenceKey} onChange={event => setSequenceKey(event.target.value)}>
        <option value="">请选择</option>
        {egress.sequences.filter(row => row.enabled).map(row => <option key={row.sequenceKey} value={row.sequenceKey}>{row.displayName || row.sequenceKey}</option>)}</select></label> : null}
      <label className="qp-field">原因（必填）<input className="qp-input" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="mih-page-actions"><button type="button" className="qp-button qp-button--outline" disabled={action.busy || reason.trim().length < 2 || (mode === 'proxy-sequence' && !sequenceKey)} onClick={save}>保存出口</button></div>
    </div>
    {egress.recentProbeFailures?.length ? <p className="mih-wsh-note">最近 {egress.recentProbeFailures.length} 次探测失败，最近一次 {formatDate(egress.recentProbeFailures[0].createdAt)}。</p> : null}
    {action.failure ? <ErrorState error={action.failure} /> : null}
  </section>
}

function CreateEngine({ token, catalog, notify, onUnauthorized, onCancel, onCreated }) {
  const kinds = catalog.kinds.filter(row => row.available)
  const [kind, setKind] = useState(kinds[0]?.kind || ''), [id, setId] = useState(''), [reason, setReason] = useState('')
  const [draft, setDraft] = useState({ displayName: '', baseUrl: '', credentialProvider: '', slotRef: '', capacity: BOUNDS.capacity.default,
    queueLimit: BOUNDS.queueLimit.default, consumerOpenLimit: BOUNDS.consumerOpenLimit.default, queueWaitMinutes: BOUNDS.queueWaitMinutes.default,
    runTimeoutSeconds: BOUNDS.runTimeoutSeconds.default, routes: [] })
  const action = useAction(notify, onUnauthorized)
  const create = async () => {
    const created = await action.run(() => adminApi.createCollectEngine(token, { ...payloadOf(draft, kind), id: id.trim(), kind, reason }), '引擎已创建（停用状态）')
    if (created && created !== true) onCreated(created)
  }
  return <section className="qp-panel mih-panel mih-she-detail" aria-label="新建引擎">
    <h2>新建引擎</h2>
    <p className="mih-wsh-note">一个引擎对应一个真实的上游资源。新建后为停用状态：先探测连通、确认能力绑定，再在配置里启用。</p>
    <div className="mih-wsh-form mih-she-form">
      <label className="qp-field">类型<select className="qp-input" value={kind} onChange={event => { setKind(event.target.value); setDraft({ ...draft, routes: [] }) }}>
        {kinds.map(row => <option key={row.kind} value={row.kind}>{row.label}</option>)}</select></label>
      <label className="qp-field">引擎 ID<input className="qp-input" value={id} placeholder={kind === 'apify' ? 'apify.main' : 'runner.market-195'} onChange={event => setId(event.target.value)} /></label>
    </div>
    {kinds.find(row => row.kind === kind)?.description ? <p className="mih-wsh-note">{kinds.find(row => row.kind === kind).description}</p> : null}
    <EngineFields draft={draft} setDraft={setDraft} catalog={catalog} kind={kind} creating />
    <div className="mih-wsh-form">
      <label className="qp-field">原因（必填）<input className="qp-input" value={reason} onChange={event => setReason(event.target.value)} /></label>
      <div className="mih-page-actions">
        <button type="button" className="qp-button qp-button--primary" disabled={action.busy || !kind || !id.trim() || !draft.displayName.trim() || reason.trim().length < 2} onClick={create}>创建</button>
        <button type="button" className="qp-button qp-button--ghost" onClick={onCancel}>取消</button>
      </div>
    </div>
    {action.failure ? <ErrorState error={action.failure} /> : null}
  </section>
}

function EngineJobs({ token, jobs, onUnauthorized }) {
  const [selected, setSelected] = useState(null), [detail, setDetail] = useState(null)
  useEffect(() => {
    if (!selected) return undefined
    let active = true
    setDetail(null)
    adminApi.collectJob(token, selected).then(value => { if (active) setDetail(value) })
      .catch(error => { if (active) { setDetail({ error }); if (error.status === 401) onUnauthorized?.(error) } })
    return () => { active = false }
  }, [token, selected, onUnauthorized])
  if (!jobs.length) return <p>还没有任务。</p>
  return <>
    <div className="qp-table-wrap"><table className="qp-table mih-table">
      <thead><tr><th>提交</th><th>能力</th><th>调用方</th><th>状态</th><th>槽</th><th>数据</th><th>计费</th><th>采购成本</th><th>耗时</th><th>说明</th><th /></tr></thead>
      <tbody>{jobs.map(job => <tr key={job.jobId} aria-selected={job.jobId === selected}>
        <td>{formatDate(job.timing.queuedAt)}</td><td><code>{job.capability}{job.routeKey ? `:${job.routeKey}` : ''}</code></td><td><code>{shortId(job.consumerId)}</code></td>
        <td><JobStatus job={job} /></td><td>{job.slotNo ?? '—'}</td><td>{DATA[job.delivery.dataStatus] || '—'}{job.delivery.itemCount != null ? ` · ${job.delivery.itemCount} 条` : ''}</td>
        <td>{BILLING[job.billing.status] || job.billing.status}</td><td>{money(job.cost?.usd)}</td><td>{seconds(job.timing.durationMs)}</td>
        <td>{job.error ? <code>{job.error.code}</code> : job.hasLateEvidence ? '有晚到证据' : ''}</td>
        <td><button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={() => setSelected(job.jobId)}>查看</button></td>
      </tr>)}</tbody></table></div>
    {selected ? <article className="mih-wsh-detail">
      {!detail ? <LoadingState label="正在读取任务" /> : detail.error ? <ErrorState error={detail.error} /> : <>
        <h3>任务 <code>{shortId(detail.jobId)}</code> · <JobStatus job={detail} /></h3>
        {detail.error ? <p role="status">{detail.error.message}（{detail.error.code}）</p> : null}
        <dl className="mih-she-facts">
          <dt>输入</dt><dd><code>{JSON.stringify(detail.input)}</code></dd>
          <dt>派发</dt><dd>{detail.timing.dispatchedAt ? formatDate(detail.timing.dispatchedAt) : '—'} · 截止 {detail.runDeadlineAt ? formatDate(detail.runDeadlineAt) : '—'} · 核对 {detail.checks} 次</dd>
          <dt>上游</dt><dd>{detail.upstreamRef ? <code>{detail.upstreamRef}</code> : '—'}{detail.upstreamState ? ` · ${JSON.stringify(detail.upstreamState)}` : ''}</dd>
          <dt>结果</dt><dd>{detail.delivery.available ? `${detail.delivery.bytes} 字节 · sha256 ${String(detail.delivery.sha256).slice(0, 12)}…` : '无'}</dd>
        </dl>
        {detail.payload ? <details><summary>原始结果外壳</summary><pre className="mih-api-response">{JSON.stringify(detail.payload, null, 2)}</pre></details> : null}
        {detail.lateEvidence ? <details><summary>晚到证据</summary><pre className="mih-api-response">{JSON.stringify(detail.lateEvidence, null, 2)}</pre></details> : null}
      </>}
    </article> : null}
  </>
}

function EngineEvents({ events }) {
  if (!events.length) return <p>还没有记录。</p>
  return <ul className="mih-wsh-events">{events.map(event => <li key={event.id}>
    {formatDate(event.createdAt)} · {EVENT[event.action] || event.action}{event.slotNo ? ` · 槽 #${event.slotNo}` : ''} · #{event.revision} · {event.actor}：{event.reason}
    {event.jobId ? <> · 任务 <code>{shortId(event.jobId)}</code></> : null}
  </li>)}</ul>
}
