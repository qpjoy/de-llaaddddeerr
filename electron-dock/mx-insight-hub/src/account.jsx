import { useEffect, useState } from 'react'
import { ArrowRight, Moon, Sun, ShieldCheck, SignOut } from '@phosphor-icons/react'
import { ErrorState, Field, LoadingState, PageHeading } from './components.jsx'
import { SSO_SESSION, accountRequest } from './api.js'
import { hubLoginUrl, hubUiPath } from '../shared/account-navigation.mjs'
import './account.css'

async function formRequest(options = {}) {
  const response = await fetch('/auth/sso/form', { credentials: 'same-origin', cache: 'no-store', ...options })
  const value = await response.json()
  if (!response.ok) { const error = new Error(value.error?.message || value.message || '暂时无法完成操作。'); error.status = response.status; throw error }
  return value
}
const primary = 'qp-button qp-button--primary qp-button--lg qp-button--block'
const deviceLabel = agent => `${/Edg\//.test(agent) ? 'Edge' : /Firefox\//.test(agent) ? 'Firefox' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : '浏览器'} · ${/Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Macintosh/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Linux/.test(agent) ? 'Linux' : '未知设备'}`

export function HubAccountEntry({ themeClass, light, onToggleTheme, message }) {
  const [options, setOptions] = useState(null), [mode, setMode] = useState('login')
  const [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const [startRequired, setStartRequired] = useState(false)
  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    if (query.get('account') !== '1') {
      // Never retry an unsuccessful callback or an explicit sign-out automatically.
      if (message || query.has('sso') || query.has('signedOut')) { setStartRequired(true); return }
      window.location.replace(hubLoginUrl(window.location.pathname)); return
    }
    const reason = new URLSearchParams(window.location.search).get('accountError')
    if (reason) setError(new Error(reason === 'feishu' ? '飞书登录已取消或过期，请重新尝试。' : '登录请求已过期，请重新开始。'))
    let active = true
    formRequest().then(value => { if (active) { setOptions(value); setMode(value.view === 'register' && value.policy && value.policy.mode !== 'closed' ? 'register' : 'login') } }).catch(e => { if (active) setError(e) })
    return () => { active = false }
  }, [message])
  const submit = async (event, intent) => {
    event.preventDefault(); if (!options || busy) return
    setBusy(true); setError(null)
    const data = new FormData(event.currentTarget)
    try {
      const result = await formRequest({ method: 'POST', headers: { 'content-type': 'application/json', 'x-mx-hub-csrf': options.csrf },
        body: JSON.stringify({ ...Object.fromEntries(data), action: intent || event.nativeEvent.submitter?.value || mode,
          policyVersion: options.policy?.version, formId: options.formId }) })
      window.location.assign(result.redirect)
    } catch (e) { setError(e); setBusy(false) }
  }
  const registering = mode === 'register', canRegister = options?.policy && options.policy.mode !== 'closed'
  return <div className={`qp-app ${themeClass} qp-density--medium mih-auth mih-account-entry`}>
    <button className="qp-button qp-button--ghost qp-icon-button mih-auth-theme-toggle" aria-label="切换主题" onClick={onToggleTheme}>{light ? <Moon size={21} /> : <Sun size={21} />}</button>
    <section className="qp-panel mih-auth-card mih-account-card" aria-labelledby="hub-account-title">
      <div className="mih-auth-brand"><img src="assets/mx-insight-logo-mark.png" alt="" /><strong>MX Insight Hub</strong></div>
      <div className="mih-auth-copy"><h1 id="hub-account-title">{registering ? '创建你的账号' : options?.pending ? '完成账号绑定' : '欢迎回到 Hub'}</h1>
        <p>{options?.invited ? '登录或注册，继续加入受邀团队。' : registering ? '从这里，开启你的数据工作空间。' : '连接数据，发现更多。'}</p></div>
      {message ? <p role="status">{message}</p> : null}
      {!options && !error && !startRequired ? <LoadingState /> : null}
      {startRequired ? <a className={primary} href={hubLoginUrl(window.location.pathname)}>重新登录<ArrowRight size={19} /></a> : null}
      {options ? <>
        {canRegister ? <div className="mih-account-tabs" aria-label="账号操作">{[['login', '登录'], ['register', options.enterprise || options.policy.mode === 'open' ? '注册' : '邀请码注册']].map(([value, label]) => <button className={`qp-button qp-button--ghost${mode === value ? ' is-active' : ''}`} key={value} disabled={busy} aria-pressed={mode === value} onClick={() => { setMode(value); setError(null) }}>{label}</button>)}</div> : null}
        {options.invitationError ? <p role="alert">{options.invitationError}</p> : null}
        <form className="mih-auth-form" onSubmit={submit} key={mode}>
          <Field label="账号"><input className="qp-input" name="login" autoComplete="username" required autoFocus maxLength={registering ? 64 : 255} disabled={busy} placeholder={registering ? '设置登录账号' : '输入你的账号'} /></Field>
          <Field label="密码"><input className="qp-input" name="password" type="password" autoComplete={registering ? 'new-password' : 'current-password'} required minLength={registering ? 8 : undefined} maxLength={registering ? 128 : 1024} disabled={busy} placeholder={registering ? '至少 8 位' : '输入密码'} /></Field>
          {registering ? <><Field label="确认密码"><input className="qp-input" name="passwordConfirm" type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} /></Field>
            {options.policy?.mode === 'invite_code' && !options.enterprise ? <Field label="邀请码"><input className="qp-input" name="inviteCode" autoComplete="off" required maxLength={128} disabled={busy} /></Field> : null}</> : null}
          {error ? <ErrorState error={error} /> : null}
          <button className={primary} type="submit" disabled={busy || (registering && Boolean(options.invitationError))}>{busy ? '正在处理…' : registering ? '注册并进入 Hub' : options.pending ? '验证并绑定' : '登录'}<ArrowRight size={19} /></button>
          {options.feishu && !options.pending && !registering ? <><button className="qp-button qp-button--block qp-button--lg" type="submit" value="feishu" formNoValidate disabled={busy}>使用飞书登录</button><details className="mih-account-help"><summary>绑定已有账号</summary><button className="qp-button qp-button--ghost" type="submit" value="feishu-link" formNoValidate disabled={busy}>绑定飞书到我的账号</button></details></> : null}
        </form>
        {!registering ? <details className="mih-account-help"><summary>忘记密码？</summary><p>请联系为你开通服务的管理员重置密码，之后使用原账号登录。</p></details> : <p className="mih-account-help">账号以字母开头，可使用字母、数字、点、下划线和短横线。</p>}
      </> : error ? <ErrorState error={error} /> : null}
      {error ? <a className="qp-button qp-button--ghost" href={hubLoginUrl(window.location.pathname, options?.invited ? { invitation: '1' } : {})}>重新开始</a> : null}
      <footer className="mih-account-footer">{options?.invited ? <a href={`${hubUiPath(window.location.pathname)}#/join`}>返回邀请</a> : <span><ShieldCheck size={15} /> 安全登录</span>}<a href={`${hubUiPath(window.location.pathname)}?admin=1`}>管理员入口</a></footer>
    </section>
  </div>
}

export function HubAccountPage({ token, onUnauthorized }) {
  const [data, setData] = useState(null), [error, setError] = useState(null), [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false), [revision, setRevision] = useState(0)
  useEffect(() => {
    if (token !== SSO_SESSION) return
    let active = true
    accountRequest().then(value => { if (active) setData(value) }).catch(e => { if (active) { setError(e); if (e.status === 401) onUnauthorized?.() } })
    return () => { active = false }
  }, [token, revision, onUnauthorized])
  const submit = async (event, action, extra = {}) => {
    event.preventDefault(); const form = event.currentTarget
    const fields = Object.fromEntries(new FormData(form))
    if (action === 'password' && fields.password !== fields.confirmPassword) { setError(new Error('两次输入的密码不一致。')); return }
    setBusy(true); setError(null); setNotice('')
    try {
      const result = await accountRequest({ action, ...fields, ...extra })
      form.reset()
      if (result.signedOut) { window.location.replace(`${hubUiPath(window.location.pathname)}?signedOut=1`); return }
      setNotice('已保存。'); setRevision(value => value + 1)
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  const password = <Field label="当前密码"><input className="qp-input" type="password" name="currentPassword" autoComplete="current-password" required maxLength={1024} disabled={busy} /></Field>
  return <div className="mih-account-page"><PageHeading title="我的账号" description="管理你的个人资料与账号安全。" />
    {token !== SSO_SESSION ? <a className="qp-button qp-button--primary" href={hubLoginUrl(window.location.pathname, { return: 'account' })}>登录个人账号</a> : !data && !error ? <LoadingState /> : null}
    {error ? <ErrorState error={error} /> : null}{notice ? <p role="status">{notice}</p> : null}
    {data ? <>
      <section className="qp-panel"><h2>个人资料</h2><p>登录账号：<strong>{data.account}</strong></p><form onSubmit={e => submit(e, 'profile')} className="mih-auth-form"><Field label="显示名称"><input className="qp-input" name="displayName" defaultValue={data.displayName} key={data.displayName} required maxLength={80} disabled={busy} /></Field>{password}<button className="qp-button qp-button--primary" disabled={busy}>保存资料</button></form></section>
      <section className="qp-panel"><h2>密码与绑定</h2><details><summary>修改密码</summary><form className="mih-auth-form" onSubmit={e => submit(e, 'password')}>{password}<Field label="新密码"><input className="qp-input" name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} /></Field><Field label="确认新密码"><input className="qp-input" name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={128} disabled={busy} /></Field><p>修改后需重新登录；使用同一账号的其他应用也将使用新密码。</p><button className="qp-button qp-button--primary" disabled={busy}>确认修改密码</button></form></details>
        <details><summary>飞书 · {data.feishuLinked ? '已绑定' : '未绑定'}</summary>{data.feishuLinked ? <form className="mih-auth-form" onSubmit={e => submit(e, 'unlink-feishu')}>{password}<button className="qp-button" disabled={busy}>解除飞书绑定</button></form> : <a className="qp-button" href={hubLoginUrl(window.location.pathname, { switch: '1', return: 'account' })}>验证账号并绑定飞书</a>}</details></section>
      <section className="qp-panel mih-account-devices"><h2>登录设备</h2>{data.sessions.map(device => <article key={device.id}><div><strong>{device.current ? '当前浏览器' : '其他浏览器'}</strong><p>{deviceLabel(device.agent)}</p><small>{new Date(device.authTime * 1000).toLocaleString()}</small></div><details><summary>退出此设备</summary><form className="mih-auth-form" onSubmit={e => submit(e, 'revoke', { target: device.id })}>{password}<button className="qp-button" disabled={busy}>确认退出</button></form></details></article>)}
        <details><summary>退出所有网页登录</summary><form className="mih-auth-form" onSubmit={e => submit(e, 'revoke', { target: 'all' })}>{password}<p>退出这个账号在各应用中的网页登录，需要重新输入密码。</p><button className="qp-button" disabled={busy}><SignOut size={16} />确认退出全部</button></form></details></section>
    </> : null}
  </div>
}
