import { useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, Field, Modal, SecretPanel } from './components.jsx'

export function KeyReveal({token, apiKey, onClose}) {
  const [username,setUsername] = useState('')
  const [password,setPassword] = useState('')
  const [secret,setSecret] = useState('')
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState(null)
  const reveal = async () => {
    setBusy(true);setError(null)
    try { const data = await adminApi.revealApiKey(token,apiKey.id,{username,password});setSecret(data.secret) }
    catch(e){setError(e)}finally{setPassword('');setBusy(false)}
  }
  return <Modal title={`查看完整 Key · ${apiKey.name}`} busy={busy} closeOnBackdrop={false} onClose={onClose} footer={<><button className="qp-button qp-button--outline" disabled={busy} onClick={onClose}>关闭</button>{!secret ? <button className="qp-button qp-button--primary" disabled={busy || !username.trim() || !password} onClick={reveal}>验证并查看</button> : null}</>}>
    {secret ? <SecretPanel secret={secret} recoverable /> : <><p>输入当前登录的 Launcher 账号密码。账号必须具有该租户的 Key 管理权限；密码不会保存。</p><Field label="Launcher 账号"><input className="qp-input" autoComplete="username" value={username} disabled={busy} onChange={e=>setUsername(e.target.value)} /></Field><Field label="账号密码"><input className="qp-input" type="password" autoComplete="current-password" value={password} disabled={busy} onChange={e=>setPassword(e.target.value)} /></Field><p>旧版只保存哈希的 Key 无法还原，需要签发替代 Key。</p></>}
    {error ? <ErrorState error={error} /> : null}
  </Modal>
}
