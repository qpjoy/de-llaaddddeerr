import { useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, Field, Modal, StatusBadge } from './components.jsx'
import { copyText } from './open-capabilities.js'
import { webSearchProvider } from '../shared/web-search.mjs'

export function StructuredCredentialPanel(props) {
  // Keep drafts and revealed values inside one provider, session and revision.
  return <StructuredCredentialForm key={`${props.token}:${props.provider}:${props.credential?.revision}`} {...props} />
}

function StructuredCredentialForm({ token, provider, credential, onSaved, onUnauthorized, notify }) {
  const fields = Array.isArray(credential.fields) ? credential.fields : []
  const providerLabel = webSearchProvider(provider)?.label || (provider === 'qixin' ? '启信慧眼' : provider)
  const sourceLabel = credential.credentialConfigured === false ? '未配置'
    : credential.credentialConfigured !== true ? '未知'
      : ({ database: 'Hub 数据库', environment: '部署环境', none: '未配置' })[credential.source] || credential.source || '未知'
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [draft, setDraft] = useState({})
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [revealOpen, setRevealOpen] = useState(false)
  const save = async event => {
    event.preventDefault()
    if (busy || !fields.length || fields.some(field => !draft[field.name]?.trim())) return
    setBusy(true); setError(null); setRevealOpen(false)
    try {
      await adminApi.updateExternalPlatformCredential(token, provider, { credentials: draft, expectedRevision: credential.revision })
      if (!mounted.current) return
      setDraft({}); setVisible(false); notify?.('密钥已保存', 'success'); onSaved?.()
    } catch (failure) { if (mounted.current) { setError(failure); if (failure.status === 401) onUnauthorized?.(failure) } }
    finally { if (mounted.current) setBusy(false) }
  }
  return <section className="qp-panel mih-panel mih-external-credential-panel" id="external-credential">
    <div className="mih-external-credential-actions"><h2>{providerLabel} · API 密钥管理</h2><StatusBadge status={credential.credentialConfigured === true ? 'active' : credential.credentialConfigured === false ? 'disabled' : 'unknown'} label={credential.credentialConfigured === true ? '密钥已配置' : credential.credentialConfigured === false ? '待配置' : '状态未知'} /></div>
    <p>当前来源：{sourceLabel} · 版本 {credential.revision ?? '未知'}。输入新密钥并保存即可替换；输入框不回填已有密钥，保存后清空。</p>
    <form onSubmit={save} className="mih-external-credential-form">
      <div className="mih-external-two-column">{fields.map(field => <Field key={field.name} label={field.label}>
        <input className="qp-input mih-mono" type={visible ? 'text' : 'password'} autoComplete="new-password" required maxLength={1024}
          value={draft[field.name] || ''} onChange={event => setDraft(current => ({ ...current, [field.name]: event.target.value }))} disabled={busy} />
      </Field>)}</div>
      <div className="mih-external-credential-actions">
        <button type="button" className="qp-button qp-button--ghost" onClick={() => setVisible(!visible)} aria-pressed={visible}>{visible ? '隐藏输入' : '显示输入'}</button>
        <button className="qp-button qp-button--primary" type="submit" disabled={busy || !fields.length || fields.some(field => !draft[field.name]?.trim())}>{busy ? '正在保存…' : '保存到数据库'}</button>
        <button className="qp-button qp-button--outline" type="button" disabled={busy || !fields.length || !credential.credentialConfigured || !credential.revealable} onClick={() => setRevealOpen(true)}>查看 / 复制</button>
      </div>
    </form>
    <p>{provider === 'qixin' ? '请在启信账户配置 Hub 出口 IP 白名单。timestamp 和 sign 由 Hub 自动生成；' : '密钥加密保存在 Hub；'}保存密钥不会查询或自动启用接口。</p>
    <p>仅 Admin Token 可管理；查看现有密钥需再次验证 Admin Token。{credential.credentialConfigured === true && credential.source === 'environment' ? '当前环境来源的密钥不可查看，重新输入并保存后可迁移到数据库。' : ''}</p>
    {!fields.length ? <p role="alert">未读取到凭据字段，请刷新后再管理。</p> : null}
    {error ? <ErrorState error={error} /> : null}
    {revealOpen ? <CredentialBundleReveal {...{ token, provider, providerLabel, fields, onUnauthorized, notify }} onClose={() => setRevealOpen(false)} /> : null}
  </section>
}

function CredentialBundleReveal({ token, provider, providerLabel, fields, onClose, onUnauthorized, notify }) {
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [adminToken, setAdminToken] = useState('')
  const [values, setValues] = useState(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const close = () => { setAdminToken(''); setValues(null); setVisible(false); onClose() }
  const reveal = async event => {
    event.preventDefault()
    if (busy || !adminToken) return
    setBusy(true); setError(null)
    try {
      const result = await adminApi.revealExternalPlatformCredential(token, provider, adminToken)
      if (!mounted.current) return
      if (fields.some(field => typeof result.credentials?.[field.name] !== 'string')) throw new Error('密钥响应不完整')
      setValues(Object.fromEntries(fields.map(field => [field.name, result.credentials[field.name]])))
    } catch (failure) { if (mounted.current) { setError(failure); if (failure.status === 401) onUnauthorized?.(failure) } }
    finally { if (mounted.current) { setAdminToken(''); setBusy(false) } }
  }
  return <Modal title={`查看 ${providerLabel} 密钥`} description="重新验证 Admin Token 后读取。关闭弹窗即清除明文。" onClose={close} busy={busy} size="small"
    footer={<button type="button" className="qp-button qp-button--ghost" disabled={busy} onClick={close}>关闭并清除</button>}>
    {values ? <div className="mih-external-secret-modal">{fields.map(field => <Field label={field.label} key={field.name}>
      <input className="qp-input mih-mono" type={visible ? 'text' : 'password'} value={values[field.name]} readOnly autoComplete="off" />
      <button type="button" className="qp-button qp-button--outline" onClick={async () => { const ok = await copyText(values[field.name]); notify?.(ok ? `${field.label} 已复制` : '复制失败', ok ? 'success' : 'danger') }}>复制 {field.label}</button>
    </Field>)}<button type="button" className="qp-button qp-button--ghost" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? '隐藏密钥' : '显示密钥'}</button></div>
      : <form onSubmit={reveal}><Field label="重新输入 Admin Token"><input className="qp-input" type="password" autoComplete="off" required disabled={busy} value={adminToken} onChange={event => setAdminToken(event.target.value)} /></Field>
        <button type="submit" className="qp-button qp-button--primary" disabled={busy || !adminToken}>验证并读取</button></form>}
    {error ? <ErrorState error={error} /> : null}
  </Modal>
}
