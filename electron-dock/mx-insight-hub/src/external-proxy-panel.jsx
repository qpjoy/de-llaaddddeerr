import { useState } from 'react'
import { adminApi } from './api.js'
import { Field, DropdownField, ErrorState } from './components.jsx'

export function ExternalProxyPanel({ token, proxy, onSaved, onUnauthorized, Panel, notify }) {
  const [mode, setMode] = useState(proxy.mode)
  const [sequenceKey, setSequenceKey] = useState(proxy.sequenceKey || '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      await adminApi.updateExternalPlatformProxy(token, 'tikhub', {
        mode, sequenceKey: mode === 'proxy-sequence' ? sequenceKey : null,
        expectedRevision: proxy.revision, reason: reason.trim(),
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
      <Field label="代理变更原因"><input className="qp-input" value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} required disabled={busy} /></Field>
      <p>按序验证不带凭据的接口连通性，选定出口后只发起一次付费请求。超时或结果未知不会自动换代理重复调用；是否允许直连回退由序列设置决定。</p>
      <a href="#/agent/proxies">管理 System Proxy 与代理序列</a>
      {error ? <ErrorState error={error} /> : null}
      <button className="qp-button qp-button--primary" disabled={busy || !reason.trim() || (mode === 'proxy-sequence' && !sequenceKey)}>{busy ? '正在保存…' : '保存代理设置'}</button>
    </form>
  </Panel>
}
