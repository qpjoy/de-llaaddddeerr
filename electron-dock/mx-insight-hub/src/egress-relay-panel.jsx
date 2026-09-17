import { useState } from 'react'
import { adminApi } from './api.js'
import { Field, DropdownField, ErrorState } from './components.jsx'

// Not the same mechanism as ExternalProxyPanel. That one selects a forward proxy
// for a dispatcher and the URL never changes. This one records where the request
// is sent, and a reverse proxy on the public edge relays it, so the upstream
// admits us by the edge's fixed public IP. See docs/operations/system-proxy.md.
export function EgressRelayPanel({ token, provider, relay, onSaved, onUnauthorized, Panel, notify }) {
  const [mode, setMode] = useState(relay.enabled ? 'relay' : 'direct')
  const [relayBase, setRelayBase] = useState(relay.relayBase || '')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const wantsRelay = mode === 'relay'
  const trimmed = relayBase.trim()
  // The upstream path is appended verbatim, so a query string or a fragment here
  // would silently corrupt every request rather than fail loudly.
  const invalidBase = wantsRelay && trimmed
    ? (() => {
      try {
        const url = new URL(trimmed)
        if (!['http:', 'https:'].includes(url.protocol)) return '只支持 http 或 https'
        if (url.username || url.password) return '不能包含用户名或密码'
        if (url.search || url.hash) return '不能包含 query 或片段，上游路径会直接追加在后面'
        return null
      } catch { return '需要一个完整的绝对地址' }
    })()
    : null
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      await adminApi.updateExternalPlatformEgressRelay(token, provider, {
        enabled: wantsRelay,
        relayBase: wantsRelay ? trimmed : null,
        expectedRevision: relay.revision,
        reason: reason.trim(),
      })
      notify?.('出网方式已保存，下一次请求生效', 'success')
      onSaved()
    } catch (error) { setError(error); if (error.status === 401) onUnauthorized?.(error) }
    finally { setBusy(false) }
  }
  return <Panel title="出网方式" subtitle="保存后下一次请求生效，无须重启；仅影响本平台。">
    <p>当前：{relay.enabled ? `经公网边缘中继 · ${relay.relayBase}` : '直连上游目录地址'} · 修订 {relay.revision}</p>
    {!relay.migrated
      ? <p role="alert">尚未执行 migration 096，当前由环境变量决定：{relay.environmentFallback || '未设置（直连）'}。执行迁移后此处的保存才会生效。</p>
      : null}
    <form onSubmit={save}>
      <DropdownField label="出网方式" value={mode} onChange={setMode} disabled={busy} options={[
        { value: 'direct', label: '直连 · 出口是本机公网地址' },
        { value: 'relay', label: '经公网边缘中继 · 固定出口 IP' },
      ]} />
      {wantsRelay
        ? <Field label="中继 Base URL"
            hint="公网边缘 nginx 上 90-egress.conf 发布的地址，例如 http://10.88.0.1:8081/u/qixin。上游的原路径与 query string 会原样追加在它后面。">
          <input className="qp-input" value={relayBase} onChange={e => setRelayBase(e.target.value)}
            placeholder="http://10.88.0.1:8081/u/qixin" maxLength={500} disabled={busy} />
        </Field>
        : null}
      <Field label="变更原因">
        <input className="qp-input" value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} required disabled={busy} />
      </Field>
      <p>目录地址与签名都不受影响：allowlist 仍然校验上游目录 origin，Auth 2.0 的 sign 只由 appkey、timestamp 与 secret_key 生成，不绑定 Host 或路径。中继只改变请求从哪个公网地址发出，用于上游按 AppKey 的 IP 白名单准入。启用前边缘必须已经发布该地址并验证可达，否则本平台的查询会全部连接失败；把出网方式改回直连即可回滚。</p>
      {error ? <ErrorState error={error} /> : null}
      {invalidBase ? <p role="alert">中继 Base URL {invalidBase}。</p> : null}
      <button className="qp-button qp-button--primary"
        disabled={busy || !reason.trim() || Boolean(invalidBase) || (wantsRelay && !trimmed)}>
        {busy ? '正在保存…' : '保存出网方式'}
      </button>
    </form>
  </Panel>
}
