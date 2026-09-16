import { useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, Field, Modal, StatusBadge } from './components.jsx'
import { copyText } from './open-capabilities.js'

export function StructuredCredentialPanel({ token, provider, credential, onSaved, onUnauthorized, notify }) {
  const fields = credential.fields || []
  const [draft, setDraft] = useState({})
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [revealOpen, setRevealOpen] = useState(false)
  const save = async event => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      await adminApi.updateExternalPlatformCredential(token, provider, { credentials: draft, expectedRevision: credential.revision })
      setDraft({}); setVisible(false); notify?.('双密钥已保存', 'success'); onSaved?.()
    } catch (failure) { setError(failure); if (failure.status === 401) onUnauthorized?.(failure) }
    finally { setBusy(false) }
  }
  return <section className="qp-panel mih-panel mih-external-credential-panel" id="external-credential">
    <div className="mih-external-credential-actions"><h2>API 密钥管理</h2><StatusBadge status={credential.credentialConfigured ? 'active' : 'disabled'} label={credential.credentialConfigured ? '双密钥已配置' : '待配置'} /></div>
    <p>App Key 与 Secret Key 成对保存，版本 {credential.revision}。输入框不回填已有密钥，保存后清空。</p>
    <form onSubmit={save} className="mih-external-credential-form">
      <div className="mih-external-two-column">{fields.map(field => <Field key={field.name} label={field.label}>
        <input className="qp-input mih-mono" type={visible ? 'text' : 'password'} autoComplete="new-password" required maxLength={1024}
          value={draft[field.name] || ''} onChange={event => setDraft({ ...draft, [field.name]: event.target.value })} disabled={busy} />
      </Field>)}</div>
      <div className="mih-external-credential-actions">
        <button type="button" className="qp-button qp-button--ghost" onClick={() => setVisible(!visible)} aria-pressed={visible}>{visible ? '隐藏输入' : '显示输入'}</button>
        <button className="qp-button qp-button--primary" type="submit" disabled={busy || fields.some(field => !draft[field.name])}>{busy ? '正在保存…' : '保存双密钥'}</button>
        <button className="qp-button qp-button--outline" type="button" disabled={busy || !credential.revealable} onClick={() => setRevealOpen(true)}>查看 / 复制</button>
      </div>
    </form>
    <p>请在启信账户配置 Hub 出口 IP 白名单。timestamp 和 sign 由 Hub 自动生成；保存密钥不会查询或自动启用接口。</p>
    {error ? <ErrorState error={error} /> : null}
    {revealOpen ? <CredentialBundleReveal key={provider} {...{ token, provider, fields, onUnauthorized, notify }} onClose={() => setRevealOpen(false)} /> : null}
  </section>
}

function CredentialBundleReveal({ token, provider, fields, onClose, onUnauthorized, notify }) {
  const [adminToken, setAdminToken] = useState('')
  const [values, setValues] = useState(null)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const reveal = async event => {
    event.preventDefault(); setBusy(true); setError(null)
    try {
      const result = await adminApi.revealExternalPlatformCredential(token, provider, adminToken)
      if (fields.some(field => typeof result.credentials?.[field.name] !== 'string')) throw new Error('密钥响应不完整')
      setValues(result.credentials); setAdminToken('')
    } catch (failure) { setError(failure); if (failure.status === 401) onUnauthorized?.(failure) }
    finally { setBusy(false) }
  }
  return <Modal title="查看企业平台密钥" description="重新验证 Admin Token 后读取。关闭弹窗即清除明文。" onClose={onClose} busy={busy} size="small"
    footer={<button type="button" className="qp-button qp-button--ghost" disabled={busy} onClick={onClose}>关闭并清除</button>}>
    {values ? <div className="mih-external-secret-modal">{fields.map(field => <Field label={field.label} key={field.name}>
      <input className="qp-input mih-mono" type={visible ? 'text' : 'password'} value={values[field.name]} readOnly autoComplete="off" />
      <button type="button" className="qp-button qp-button--outline" onClick={async () => { const ok = await copyText(values[field.name]); notify?.(ok ? `${field.label} 已复制` : '复制失败', ok ? 'success' : 'danger') }}>复制 {field.label}</button>
    </Field>)}<button type="button" className="qp-button qp-button--ghost" aria-pressed={visible} onClick={() => setVisible(!visible)}>{visible ? '隐藏密钥' : '显示密钥'}</button></div>
      : <form onSubmit={reveal}><Field label="重新输入 Admin Token"><input className="qp-input" type="password" autoComplete="off" required value={adminToken} onChange={event => setAdminToken(event.target.value)} /></Field>
        <button type="submit" className="qp-button qp-button--primary" disabled={busy || !adminToken}>验证并读取</button></form>}
    {error ? <ErrorState error={error} /> : null}
  </Modal>
}
