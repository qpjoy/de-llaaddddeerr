import { useCallback, useEffect, useRef, useState } from 'react'
import { DeviceMobile, Plus, ArrowClockwise, ShieldCheck } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { ConfirmDialog, Field, PageHeading, useRemoteData } from './components.jsx'
import './peripherals.css'

const secondary = 'qp-button qp-button--ghost'
const primary = 'qp-button qp-button--primary'
const statusName = { idle: '空闲', running: '执行中', quarantined: '待人工核验', queued: '排队中', succeeded: '执行成功', failed: '失败', unknown: '结果未知', cancelled: '未派发 · 已取消', expired: '排队已过期' }
const operationName = { search: '搜索', next: '下一页', note: '笔记详情' }
const stamp = value => value ? new Date(value).toLocaleString() : '尚无记录'
// Only in-memory, identity-scoped uncertain submissions. Never store detail tokens in browser storage.
const pendingSubmissions = new Map()
function Input({ label, hint, ...props }) { return <Field label={label} hint={hint}><input className="qp-input" {...props} /></Field> }
function Status({ value }) { return <span className={`mih-peripheral-status mih-peripheral-status--${value}`}>{statusName[value] || value}</span> }
function ErrorNotice({ error }) { return error ? <p className="mih-peripheral-notice" role="alert">{error.message || error}</p> : null }

export default function PeripheralSettingsPage({ token, session, onUnauthorized }) {
  useEffect(() => { for (const [key, value] of pendingSubmissions) if (value.token !== token) pendingSubmissions.delete(key) }, [token])
  const load = useCallback(() => adminApi.peripherals(token), [token])
  const state = useRemoteData(load, onUnauthorized)
  const [selected, setSelected] = useState(null), [adding, setAdding] = useState(false)
  const [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ name: '', host: '', serial: '', accountKey: '', origin: '' })
  const devices = state.data?.devices || []
  const selectedId = selected || devices[0]?.id
  if (session?.kind !== 'admin-token') return <p>外设管理仅供 Hub Admin Token 管理员使用。</p>
  const register = async event => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const device = await adminApi.peripherals(token, { method: 'POST', body: form })
      setSelected(device.id); setAdding(false); state.refresh()
    } catch (error) { setError(error); if (error.status === 401) onUnauthorized?.() }
    finally { setBusy(false) }
  }
  return <div className="mih-peripherals">
    <PageHeading eyebrow="SYSTEM SETTINGS / PERIPHERALS" title="外设" description="让物理设备成为可追踪、可排队的执行资源。每台手机一个执行槽，不同手机独立调度。" onRefresh={state.refresh} loading={state.loading}>
      <button className={primary} disabled={!state.data?.available} onClick={() => setAdding(!adding)}><Plus size={17} />添加外设</button>
    </PageHeading>
    <div className="mih-peripheral-boundary"><ShieldCheck size={23} /><div><strong>Hub 管理 · 手机执行 · 默认暂停</strong><p>仅管理员显式提交任务。打开页面和刷新只读取 Hub 记录；不依赖 mx-rig，不接入客户计费，也不替换现有小红书渠道。</p></div></div>
    <ErrorNotice error={state.error || error} />
    {state.data && !state.data.available ? <p className="mih-peripheral-notice">{state.data.reason}</p> : null}
    {state.data?.available && !state.data.persistent ? <p className="mih-peripheral-notice">当前为隔离模拟环境，数据不会跨服务重启保存。</p> : null}
    {adding ? <section className="mih-peripheral-panel"><h2>注册手机</h2><p>服务地址必须在部署白名单内。ADB 序列号和账号资源标识不可重复，不填写密码或令牌。</p>
      <form onSubmit={register} className="mih-peripheral-form">
        {[["name", "外设名称", "例如：小红书手机 01"], ["host", "宿主机标识", "例如：rack-01-host-01"], ["serial", "ADB 序列号", "adb devices 中的真实序列号"], ["accountKey", "账号资源标识", "例如：xhs-account-01（不是密码）"], ["origin", "PoC 服务地址", "例如：http://127.0.0.1:18081"]].map(([key, label, placeholder]) => <Input key={key} label={label} placeholder={placeholder} value={form[key]} required maxLength={key === 'origin' ? 300 : 120} onChange={e => setForm({ ...form, [key]: e.target.value })} />)}
        <div className="mih-peripheral-wide"><small>当前允许地址：{state.data?.origins?.join('、') || '尚未配置 MX_INSIGHT_PERIPHERAL_ORIGINS，暂不能注册'}</small></div>
        <div className="mih-peripheral-actions mih-peripheral-wide"><button className={primary} disabled={busy}>保存为暂停状态</button><button className={secondary} type="button" disabled={busy} onClick={() => setAdding(false)}>取消</button></div>
      </form>
    </section> : null}
    {!devices.length && !state.loading ? <section className="mih-peripheral-empty"><DeviceMobile size={42} /><h2>还没有接入外设</h2><p>先注册服务器上的手机，再检查连接并启用调度。</p><p>真实执行需要 PostgreSQL 和受保护的 PoC 地址。不会自动修改 ADB、VPN 或手机应用。</p></section> : null}
    {devices.length ? <div className="mih-peripheral-layout">
      <aside className="mih-peripheral-devices" aria-label="外设列表">{devices.map(d => <button key={d.id} className={`mih-peripheral-device ${d.id === selectedId ? 'is-selected' : ''}`} onClick={() => setSelected(d.id)} aria-pressed={d.id === selectedId}>
        <DeviceMobile size={26} /><span><strong>{d.name}</strong><small>{d.host} · 单执行槽</small></span>
      </button>)}<p>每个序列号和账号只注册一次。当前版本固定绑定设备，不自动迁移搜索会话。</p></aside>
      <DeviceWorkspace key={`${token}:${selectedId}`} {...{ token, id: selectedId, onUnauthorized }} />
    </div> : null}
  </div>
}

function DeviceWorkspace({ token, id, onUnauthorized }) {
  const [cursor, setCursor] = useState(null), [cursors, setCursors] = useState([])
  const load = useCallback(() => adminApi.peripheral(token, id, { query: { before: cursor } }), [token, id, cursor])
  const state = useRemoteData(load, onUnauthorized)
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [notice, setNotice] = useState('')
  const [keyword, setKeyword] = useState(''), [input, setInput] = useState('')
  const [intent, setIntent] = useState(() => pendingSubmissions.get(id)?.token === token ? pendingSubmissions.get(id).body : null)
  const [config, setConfig] = useState(null)
  const [result, setResult] = useState(null), [confirm, setConfirm] = useState(null), [reason, setReason] = useState('')
  const lock = useRef(false), mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { const timer = setInterval(state.refresh, 3000); return () => clearInterval(timer) }, [state.refresh])
  useEffect(() => {
    const latest = state.data?.jobs?.find(job => job.id === result?.id)
    if (!latest || latest.status === result.status) return
    let active = true
    adminApi.peripheralJob(token, id, result.id).then(job => { if (active) setResult(job) }).catch(error => { if (active) setError(error) })
    return () => { active = false }
  }, [state.data, token, id, result?.id, result?.status])
  useEffect(() => {
    if (!intent) return
    const warn = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [intent])
  const run = async fn => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(null); setNotice('')
    try { await fn(); if (mounted.current) state.refresh() }
    catch (error) { if (mounted.current) setError(error); if (error.status === 401) onUnauthorized?.() }
    finally { lock.current = false; if (mounted.current) setBusy(false) }
  }
  const d = state.data?.device
  const submit = payload => run(async () => {
    const body = intent || { ...payload, idempotencyKey: crypto.randomUUID() }
    pendingSubmissions.set(id, { token, body })
    setIntent(body)
    try {
      const job = await adminApi.peripheralSubmit(token, id, body)
      pendingSubmissions.delete(id)
      if (mounted.current) { setIntent(null); setResult(job); setNotice(`任务已保存：${job.id}。提交成功不代表手机已执行完成。`); setCursor(null); setCursors([]) }
    } catch (error) {
      if (error.status >= 400 && error.status < 500) { pendingSubmissions.delete(id); if (mounted.current) setIntent(null) }
      throw error
    }
  })
  const control = (action, extra = {}) => run(async () => {
    await adminApi.peripheralControl(token, id, { action, revision: d.revision, ...extra })
    if (mounted.current) { setConfirm(null); setConfig(null); setReason(''); setNotice('管理操作已保存。') }
  })
  if (!d) return <div className="mih-peripheral-panel"><ErrorNotice error={state.error} /><p>{state.loading ? '正在读取外设…' : '暂无外设记录'}</p></div>
  const jobs = state.data.jobs || [], active = jobs.some(j => ['queued','running'].includes(j.status)) || d.state === 'running'
  return <main className="mih-peripheral-workspace">
    <section className="mih-peripheral-panel">
      <div className="mih-peripheral-heading"><div><h2>{d.name}</h2><p>{d.host} · {d.serial}</p></div><Status value={d.state} /></div>
      <div className="mih-peripheral-facts"><div><small>调度开关</small><strong>{d.enabled ? '已启用' : '已暂停'}</strong></div><div><small>适配器</small><strong>XHS PoC · v1</strong></div><div><small>最近连接检查</small><strong>{d.probe ? (d.probe.reachable ? '可达 · 不代表业务健康' : '不可达') : '尚未检查'}</strong><small>{stamp(d.probe?.at)}</small></div></div>
      <p className="mih-peripheral-address">{d.origin} · 账号资源：{d.accountKey}</p>
      <div className="mih-peripheral-actions"><button className={secondary} disabled={busy} onClick={() => run(async () => { await adminApi.peripheralProbe(token, id); setNotice('已读取 /api/state。是否登录、空闲或补丁正常，需结合手机现场核验。') })}><ArrowClockwise size={16} />检查连接（只读）</button>
        <button className={d.enabled ? secondary : primary} disabled={busy || (!d.enabled && d.state !== 'idle')} onClick={() => control(d.enabled ? 'pause' : 'enable')}>{d.enabled ? '暂停新派发' : '启用调度'}</button>
        <button className={secondary} disabled={busy || d.enabled || d.state !== 'idle' || active || !!d.session} onClick={() => setConfig({ name: d.name, host: d.host, serial: d.serial, accountKey: d.accountKey, origin: d.origin })}>编辑连接</button>
      </div>
      {config ? <form className="mih-peripheral-form" onSubmit={e => { e.preventDefault(); control('configure', config) }}>{[['name','外设名称'],['host','宿主机标识'],['serial','ADB 序列号'],['accountKey','账号资源标识'],['origin','PoC 服务地址']].map(([key, label]) => <Input key={key} label={label} value={config[key]} maxLength={key === 'origin' ? 300 : 120} required onChange={e => setConfig({ ...config, [key]: e.target.value })} />)}<div className="mih-peripheral-actions mih-peripheral-wide"><button className={primary} disabled={busy}>保存连接（需重新检查）</button><button className={secondary} type="button" disabled={busy} onClick={() => setConfig(null)}>取消编辑</button></div></form> : null}
      {d.probe ? <details><summary>查看连接检查原始证据</summary><pre>{JSON.stringify(d.probe, null, 2)}</pre></details> : null}
      <ErrorNotice error={error || state.error} />{notice ? <p role="status">{notice}</p> : null}
      {d.state === 'quarantined' ? <div className="mih-peripheral-notice"><strong>执行结果未知，设备已隔离</strong><p>不会自动重试或接替任务。先停止旧执行器、确认手机任务结束且无旁路调用，再检查连接、填写说明并人工恢复。原任务仍保留“结果未知”。</p>{Date.now() < d.recoveryAfter ? <p>执行租约尚未结束，最早可核验时间：{stamp(d.recoveryAfter)}。到时仍需现场确认，不能自动恢复。</p> : null}<Input label="现场核验说明" value={reason} onChange={e => setReason(e.target.value)} maxLength={500} /><button className={secondary} disabled={busy || !reason.trim() || Date.now() < d.recoveryAfter} onClick={() => setConfirm('recover')}>核验后恢复为暂停</button></div> : null}
    </section>
    <section className="mih-peripheral-panel"><h2>接口验证与执行</h2><p>只在点击提交时驱动手机；结果保存为管理员证据，尚未写入 Canonical 或开放给客户调用。</p>
      {d.session ? <div className="mih-peripheral-session"><strong>搜索会话 · {d.session.keyword}</strong><p>已完成第 {d.session.page} 页 · {d.session.hasMore ? '还有下一页' : '未开始或已无下一页'} · 有效至 {stamp(d.session.expiresAt)}</p><div className="mih-peripheral-actions"><button className={primary} disabled={busy || !!intent || !d.enabled || active || !d.session.hasMore || Date.now() >= d.session.expiresAt} onClick={() => submit({ operation: 'next', sessionId: d.session.id, expectedPage: d.session.page })}>提交下一页</button><button className={secondary} disabled={busy || active || !!intent} onClick={() => setConfirm('close-session')}>结束搜索会话</button></div></div> : null}
      {intent ? <div className="mih-peripheral-notice"><p>提交结果尚不确定。请留在此页面，以同一幂等键确认，不要创建新请求。</p><code>{intent.idempotencyKey}</code><button className={primary} disabled={busy} onClick={() => submit(intent)}>用原请求确认 / 重试提交</button></div> : null}
      <div className="mih-peripheral-form"><form onSubmit={e => { e.preventDefault(); submit({ operation: 'search', keyword }) }}><Input label="搜索关键词" value={keyword} onChange={e => setKeyword(e.target.value)} maxLength={200} required /><button className={primary} disabled={busy || !!intent || !d.enabled || !!d.session || active}>提交搜索</button></form>
        <form onSubmit={e => { e.preventDefault(); submit({ operation: 'note', input }) }}><Input label="笔记 detailInput" hint="原样粘贴带 xsec_token 的链接；先结束搜索会话。" value={input} onChange={e => setInput(e.target.value)} maxLength={8192} required /><button className={secondary} disabled={busy || !!intent || !d.enabled || !!d.session}>提交笔记详情</button></form></div>
    </section>
    <section className="mih-peripheral-panel"><div className="mih-peripheral-heading"><div><h2>任务记录</h2><p>自动刷新仅查询 Hub · 最多每页 50 条 · 排队超过 5 分钟不再派发</p></div></div>
      {!jobs.length ? <p>还没有任务。检查连接不会创建执行任务。</p> : <div className="mih-peripheral-table-wrap"><table><thead><tr><th>操作 / 时间</th><th>任务 ID</th><th>状态</th><th>记录</th></tr></thead><tbody>{jobs.map(job => <tr key={job.id}><td>{operationName[job.operation]}<small>{stamp(job.createdAt)}</small></td><td><code>{job.id.slice(0, 8)}</code></td><td><Status value={job.status} /></td><td><div className="mih-peripheral-actions"><button className={secondary} disabled={busy} onClick={() => run(async () => { const value = await adminApi.peripheralJob(token, id, job.id); if (mounted.current) setResult(value) })}>查看结果</button>{job.status === 'queued' ? <button className={secondary} disabled={busy} onClick={() => control('cancel', { jobId: job.id })}>取消排队</button> : null}</div></td></tr>)}</tbody></table></div>}
      <div className="mih-peripheral-actions"><button className={secondary} disabled={busy || !cursors.length} onClick={() => { setCursor(cursors.at(-1)); setCursors(cursors.slice(0, -1)) }}>上一页</button><span>第 {cursors.length + 1} 页</span><button className={secondary} disabled={busy || !state.data.next} onClick={() => { setCursors([...cursors, cursor]); setCursor(state.data.next) }}>下一页记录</button></div>
      {result?.result?.items?.length ? <div className="mih-peripheral-result"><h3>已保存的搜索结果</h3><p>选用链接只填入详情表单；需结束搜索会话并显式提交，才会调用手机。</p>{result.result.items.slice(0, 20).map((item, index) => <div className="mih-peripheral-actions" key={`${item.id}:${index}`}><span>{item.title || item.id}</span>{item.detailInput ? <button className={secondary} onClick={() => setInput(item.detailInput)}>使用详情链接</button> : null}</div>)}{result.result.items.length > 20 ? <p>此处预览前 20 条，完整结果见下方原始证据。</p> : null}</div> : null}
      {result ? <details className="mih-peripheral-result"><summary>任务证据：{result.id} · {statusName[result.status]}</summary><pre>{JSON.stringify(result, null, 2)}</pre></details> : null}
      <details><summary>最近 50 条管理与调度事件</summary><pre>{JSON.stringify(state.data.events, null, 2)}</pre></details>
    </section>
    {confirm ? <ConfirmDialog title={confirm === 'recover' ? '确认现场核验完成' : '结束搜索会话？'} description={confirm === 'recover' ? '确认旧执行器和手机任务已停止，且没有其他脚本直连。连接检查不能替代此核验；恢复不会重试未知任务，也不会自动启用。' : '结束后不能继续当前搜索的下一页。已保存的结果不会删除。'} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => control(confirm, confirm === 'recover' ? { reason, confirmedStopped: true } : { sessionId: d.session?.id })} confirmLabel={confirm === 'recover' ? '确认已停止，恢复为暂停' : '结束会话'}><ErrorNotice error={error} /></ConfirmDialog> : null}
  </main>
}
