import { useState } from 'react'
import { adminApi } from './api.js'
import { Field, DropdownField, ErrorState } from './components.jsx'

const PROBE_FIELDS = [
  { key: 'timeoutMs', label: '单次探测超时（毫秒）', min: 1000, max: 60000,
    hint: '留空继承所选 Sequence，再继承应用默认。低于链路真实握手耗时会把正常出口判成不可达。' },
  { key: 'attempts', label: '每个出口探测次数', min: 1, max: 5,
    hint: '留空继承。同一出口连续失败才换下一个，不影响付费请求只发一次的约束。' },
  { key: 'cacheTtlMs', label: '探测结果复用时长（毫秒）', min: 0, max: 600000,
    hint: '留空继承；0 表示每次调用都探测。复用会跳过探测，付费请求失败时将从「明确未计费」变成「计费未知」。' },
]

function numberOrNull(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN
}

function failureSummary(attempts) {
  return (Array.isArray(attempts) ? attempts : [])
    .map(entry => `${entry.endpoint} 第 ${entry.attempt} 次 · ${entry.status ?? entry.error} · ${entry.durationMs}ms`)
    .join('；')
}

export function ExternalProxyPanel({ token, proxy, onSaved, onUnauthorized, Panel, notify }) {
  const [mode, setMode] = useState(proxy.mode)
  const [sequenceKey, setSequenceKey] = useState(proxy.sequenceKey || '')
  const [reason, setReason] = useState('')
  const [probe, setProbe] = useState(() => Object.fromEntries(PROBE_FIELDS.map(field => (
    [field.key, proxy.probePolicy?.override?.[field.key] ?? '']
  ))))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const effective = proxy.probePolicy?.effective
  const failures = Array.isArray(proxy.recentProbeFailures) ? proxy.recentProbeFailures : []
  const invalidProbe = PROBE_FIELDS.find(field => {
    const value = numberOrNull(probe[field.key])
    return value !== null && (Number.isNaN(value) || value < field.min || value > field.max)
  })
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      await adminApi.updateExternalPlatformProxy(token, 'tikhub', {
        mode, sequenceKey: mode === 'proxy-sequence' ? sequenceKey : null,
        expectedRevision: proxy.revision, reason: reason.trim(),
        probePolicy: Object.fromEntries(PROBE_FIELDS.map(field => [field.key, numberOrNull(probe[field.key])])),
      })
      notify?.('TikHub 代理已保存，下一次请求生效', 'success')
      onSaved()
    } catch (error) { setError(error); if (error.status === 401) onUnauthorized?.(error) }
    finally { setBusy(false) }
  }
  return <Panel title="TikHub 出网代理" subtitle="复用 System Proxy；保存后下一次请求生效，仅影响 TikHub。">
    <p>当前：{proxy.mode === 'inherit' ? '继承 System Proxy 全局设置' : proxy.mode === 'system-egress' ? '直接出网' : `Proxy Sequence · ${proxy.sequenceKey}`} · 修订 {proxy.revision}</p>
    <form onSubmit={save}>
      <DropdownField label="出网方式" value={mode} onChange={setMode} disabled={busy} options={[
        { value: 'inherit', label: '继承 System Proxy 全局设置' },
        { value: 'proxy-sequence', label: '指定 Proxy Sequence' },
        { value: 'system-egress', label: '直接出网 · 不使用应用代理' },
      ]} />
      {mode === 'proxy-sequence' ? <DropdownField label="Proxy Sequence" value={sequenceKey} onChange={setSequenceKey} disabled={busy} options={[
        { value: '', label: '请选择代理序列' },
        ...proxy.sequences.map(s => ({ value: s.sequenceKey, label: `${s.displayName}${s.enabled ? '' : '（已停用）'}` })),
      ]} /> : null}
      <fieldset className="mih-proxy-probe">
        <legend>探测策略覆盖（仅 TikHub）</legend>
        <p>探测策略属于出网链路，默认在 System Proxy 的 Sequence 上维护；这里只为 TikHub 覆盖。留空即继承。
          {effective ? ` 本次生效：超时 ${effective.timeoutMs}ms · 探测 ${effective.attempts} 次 · 复用 ${effective.cacheTtlMs}ms。` : ''}</p>
        {PROBE_FIELDS.map(field => <Field key={field.key} label={field.label} hint={field.hint}>
          <input className="qp-input" type="number" inputMode="numeric" min={field.min} max={field.max}
            value={probe[field.key]} disabled={busy} placeholder="继承"
            onChange={event => setProbe(current => ({ ...current, [field.key]: event.target.value }))} />
        </Field>)}
      </fieldset>
      <Field label="代理变更原因"><input className="qp-input" value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} required disabled={busy} /></Field>
      <p>按序验证不带凭据的接口连通性，选定出口后只发起一次付费请求。探测只证明出口可达：目标返回的任何状态（含 429/404）都算可达，只有代理自身的 407/502/503/504 才判定该出口不可用。超时或结果未知不会自动换代理重复调用；是否允许直连回退由序列设置决定。</p>
      <a href="#/agent/proxies">管理 System Proxy 与代理序列</a>
      {error ? <ErrorState error={error} /> : null}
      {invalidProbe ? <p role="alert">{invalidProbe.label} 需为 {invalidProbe.min}–{invalidProbe.max} 之间的整数，或留空继承。</p> : null}
      <button className="qp-button qp-button--primary" disabled={busy || !reason.trim() || Boolean(invalidProbe) || (mode === 'proxy-sequence' && !sequenceKey)}>{busy ? '正在保存…' : '保存代理设置'}</button>
    </form>
    {failures.length ? <details className="qp-search-lab">
      <summary><strong>最近探测失败</strong>（{failures.length} 次，不含凭据）</summary>
      <div className="qp-search-lab__body">
        <ul>{failures.map((failure, index) => <li key={`${failure.createdAt}-${index}`}>
          {new Date(failure.createdAt).toLocaleString()} · {failureSummary(failure.attempts) || '无探测明细'}
        </li>)}</ul>
      </div>
    </details> : null}
  </Panel>
}
