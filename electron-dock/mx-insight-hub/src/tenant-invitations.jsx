import { useCallback, useEffect, useRef, useState } from 'react'
import { Buildings, Copy, Moon, Plus, Sun } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, LoadingState, Modal, PageHeading, useRemoteData } from './components.jsx'
import { ROLES, ROLE_HINTS } from './tenant-memberships.jsx'

const roleName = role => ROLES.find(item => item.value===role)?.label || role
const stamp = value => new Date(value).toLocaleString('zh-CN')
const statusName = {pending:'待接受',accepted:'已接受',revoked:'已撤回',expired:'已到期'}
const button = 'qp-button qp-button--outline'

export function TenantTeamPage({token,session,onUnauthorized}) {
  const load=useCallback(()=>adminApi.tenants(token),[token])
  const state=useRemoteData(load,onUnauthorized)
  return <><PageHeading eyebrow="TEAM / INVITATIONS" title="团队邀请" description="邀请同事使用自己的 MX 账号加入指定租户。" onRefresh={state.refresh} loading={state.loading}/>{state.error ? <ErrorState error={state.error}/> : state.loading && !state.data ? <LoadingState/> : session.tenantInvitationsEnabled ? <TenantInvitationsPanel token={token} session={session} tenants={state.data || []} onCreated={state.refresh}/> : <p>请先启用 Hub 统一登录，再使用企业邀请。</p>}</>
}

export function TenantInvitationsPanel({ token, session, tenants, onCreated }) {
  const allowed = tenants.filter(t => session.platformAdmin || session.memberships?.some(m => m.tenantId===t.id && m.capabilities?.includes('membership.write')))
  const [selected,setSelected] = useState('')
  const tenantId = allowed.some(t => t.id===selected) ? selected : allowed[0]?.id || ''
  const [rows,setRows] = useState([]), [error,setError] = useState(null), [loading,setLoading] = useState(false)
  const [revision,setRevision] = useState(0), [form,setForm] = useState(null), [result,setResult] = useState(null)
  const [busy,setBusy] = useState(false), [revoking,setRevoking] = useState(null), [copied,setCopied] = useState(false)
  useEffect(() => {
    if (!tenantId || !session.tenantInvitationsEnabled) { setRows([]); return }
    let active=true; setLoading(true); setError(null)
    adminApi.tenantInvitations(token,tenantId).then(data => { if(active) setRows(data) }).catch(e => {if(active)setError(e)}).finally(()=>{if(active)setLoading(false)})
    return () => {active=false}
  },[token,tenantId,revision,session.tenantInvitationsEnabled])
  if (!session.tenantInvitationsEnabled || (!session.platformAdmin && !allowed.length)) return null
  const open = () => {
    setError(null);setResult(null);setCopied(false)
    setForm({requestId:crypto.randomUUID(),tenantId:tenantId || '__new__',tenantName:'',label:'',role:tenantId ? 'viewer' : 'owner',days:7,allowRegistration:true})
  }
  const update = patch => setForm(value => ({...value,...patch,requestId:crypto.randomUUID()}))
  const close = () => {
    // Refresh the surrounding tenant list only after the user has had a chance to copy the link.
    if (result) onCreated?.()
    setForm(null);setResult(null);setError(null)
  }
  const create = async event => {
    event.preventDefault();setBusy(true);setError(null)
    try {
      const data=await adminApi.createTenantInvitation(token,{...form,tenantId:form.tenantId==='__new__' ? null : form.tenantId,tenantName:form.tenantId==='__new__' ? form.tenantName : ''})
      setResult(data);setRevision(value=>value+1);setSelected(data.tenantId)
    } catch(e) {setError(e)} finally {setBusy(false)}
  }
  const revoke = async () => {
    setBusy(true);setError(null)
    try {await adminApi.revokeTenantInvitation(token,revoking.id);setRevoking(null);setRevision(value=>value+1)}
    catch(e){setError(e)}finally{setBusy(false)}
  }
  return <section className="qp-panel mih-invitations" aria-label="企业邀请">
    <header className="mih-invitations__header"><div><h2>企业邀请</h2><p>成员接受邀请后自动加入租户，无需等待账号出现再手动绑定。</p></div><button className="qp-button qp-button--primary" onClick={open}><Plus size={16} aria-hidden="true" />邀请成员</button></header>
    {allowed.length ? <DropdownField label="查看租户邀请" value={tenantId} onChange={setSelected} options={allowed.map(t=>({value:t.id,label:t.name}))} /> : <p>可以同时新建企业租户并邀请首位负责人。</p>}
    {error && !form && !revoking ? <ErrorState error={error} /> : null}
    {loading ? <LoadingState /> : <div className="mih-invitations__list">{rows.map(row=><article key={row.id}><div><strong>{row.label}</strong><small>{roleName(row.role)} · {row.allowRegistration?'可注册新账号':'仅已有账号'}</small><small>{row.acceptedAt ? `接受于 ${stamp(row.acceptedAt)}` : `有效至 ${stamp(row.expiresAt)}`}</small></div><span className="qp-tag">{statusName[row.status]}</span>{row.status==='pending' ? <button className={button} onClick={()=>{setError(null);setRevoking(row)}}>撤回</button> : null}</article>)}{tenantId && !rows.length ? <p>此租户暂无邀请记录。</p> : null}</div>}
    <small>每条链接只能由一个账号接受。链接仅在创建成功后显示，请只发给目标成员。最近显示 100 条记录。</small>
    {form ? <Modal title={result?'邀请已生成':'邀请成员'} busy={busy} closeOnBackdrop={false} onClose={close} footer={result ? <button className={button} onClick={close}>完成</button> : <><button className={button} disabled={busy} onClick={close}>取消</button><button className="qp-button qp-button--primary" type="submit" form="create-tenant-invitation" disabled={busy}>{busy?'正在生成…':'生成邀请链接'}</button></>}>
      {result ? <div className="mih-invitations__result"><p><strong>{result.tenantName}</strong> · {roleName(result.role)}</p><Field label="一次性邀请链接"><textarea className="qp-input" rows={4} value={result.url} readOnly onFocus={e=>e.target.select()} /></Field><button className={button} onClick={async()=>{try{await navigator.clipboard.writeText(result.url);setCopied(true)}catch{setCopied(false)}}}><Copy size={16} aria-hidden="true" />{copied?'已复制':'复制链接'}</button><p>有效至 {stamp(result.expiresAt)}。对方登录并确认接受后，即可进入此租户。</p></div> : <form id="create-tenant-invitation" onSubmit={create} className="mih-invitations__form">
        <DropdownField label="加入租户" value={form.tenantId} disabled={busy} onChange={id=>update({tenantId:id,...(id==='__new__'?{role:'owner'}:{})})} options={[...allowed.filter(t=>t.status==='active').map(t=>({value:t.id,label:t.name})),...(session.platformAdmin?[{value:'__new__',label:'新建企业租户并邀请'}]:[])]} />
        {form.tenantId==='__new__' ? <Field label="企业租户名称"><input className="qp-input" required maxLength={120} value={form.tenantName} disabled={busy} onChange={e=>update({tenantName:e.target.value})} /></Field> : null}
        <Field label="邀请备注" hint="例如：张三 · 研发团队。备注不用于匹配账号。"><input className="qp-input" required maxLength={80} value={form.label} disabled={busy} onChange={e=>update({label:e.target.value})} /></Field>
        <DropdownField label="加入后的角色" value={form.role} disabled={busy} onChange={role=>update({role})} options={ROLES} /><p>{ROLE_HINTS[form.role]}</p>
        <Field label="链接有效天数"><input className="qp-input" type="number" min={1} max={30} required value={form.days} disabled={busy} onChange={e=>update({days:Number(e.target.value)})} /></Field>
        <label className="mih-invitations__checkbox"><input type="checkbox" checked={form.allowRegistration} disabled={busy} onChange={e=>update({allowRegistration:e.target.checked})} />允许受邀人直接注册新 MX 账号</label><small>无需额外注册码；平台关闭注册时仍仅允许已有账号登录。邀请只授予所选租户角色。</small>
      </form>}{error ? <ErrorState error={error} /> : null}
    </Modal> : null}
    {revoking ? <Modal title="撤回邀请" busy={busy} closeOnBackdrop={false} onClose={()=>setRevoking(null)} footer={<><button className={button} disabled={busy} onClick={()=>setRevoking(null)}>取消</button><button className="qp-button qp-button--primary" disabled={busy} onClick={revoke}>确认撤回</button></>}><p>撤回「{revoking.label}」的邀请，链接将无法接受。已经加入的成员需通过成员管理单独撤权。</p>{error ? <ErrorState error={error} /> : null}</Modal> : null}
  </section>
}

async function invitationRequest(path, options={}) {
  const response=await fetch(`/auth/sso/invitation${path}`,{credentials:'same-origin',cache:'no-store',...options})
  const data=await response.json()
  if (!response.ok) throw new Error(data?.error?.message || data?.message || '邀请暂不可用，请重试或联系邀请人。')
  return data
}
export function TenantInvitationPage({ query, theme, onToggleTheme }) {
  const [initialToken] = useState(()=>query.get('invitation') || '')
  const startup = useRef(null)
  const [data,setData] = useState(null), [error,setError] = useState(null), [busy,setBusy] = useState(false), [retry,setRetry] = useState(0)
  useEffect(()=>{
    let active=true
    if (!startup.current) startup.current=(async()=>{
      if(initialToken){
        await invitationRequest('/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:initialToken})})
        window.history.replaceState(null,'',`${window.location.pathname}#/join`)
      }
    })().catch(error=>{startup.current=null;throw error})
    startup.current.then(()=>invitationRequest('')).then(value=>{if(active){setData(value);setError(null)}}).catch(e=>{if(active)setError(e)})
    return ()=>{active=false}
  },[initialToken,retry])
  const accept=async()=>{
    setBusy(true);setError(null)
    try {const result=await invitationRequest('/accept',{method:'POST',headers:{'content-type':'application/json','x-mx-hub-csrf':data.csrf},body:JSON.stringify({invitationId:data.invitation.id})});window.location.assign(result.returnUrl)}
    catch(e){setError(e);setBusy(false)}
  }
  const invitation=data?.invitation
  return <div className={`qp-app ${theme==='dark'?'qp-theme-neon-void':'qp-theme-neon-void-light'} mih-invitation-page`}><main className="qp-panel mih-invitation-card">
    <header><a className="mih-invitation-brand" href="/"><img src="assets/mx-insight-logo-mark.png" alt="" />MX Insight Hub</a><button className="qp-button qp-button--ghost qp-icon-button" aria-label="切换亮暗主题" onClick={onToggleTheme}>{theme==='dark'?<Sun size={20}/>:<Moon size={20}/>}</button></header>
    <span className="mih-invitation-eyebrow">TEAM INVITATION</span><h1>加入企业工作空间</h1>
    {invitation ? <><div className="mih-invitation-target"><Buildings size={30} aria-hidden="true"/><div><h2>{invitation.tenantName}</h2><p>{roleName(invitation.role)} · 有效至 {stamp(invitation.expiresAt)}</p></div></div><p>{ROLE_HINTS[invitation.role]}</p>
      {data.user ? <><div className="mih-invitation-identity"><span>当前登录账号</span><strong>{data.user.displayName}</strong><small>成员 ID：{data.user.memberId}</small></div><p>请确认使用此账号加入。如果你已经是成员，会保留原角色。</p><button className="qp-button qp-button--primary" disabled={busy} onClick={accept}>{busy?'正在加入…':invitation.status==='accepted'?'进入工作空间':'确认接受并加入'}</button>{invitation.status!=='accepted' ? <a className={button} href="/auth/sso/login?surface=application&invitation=1&switch=1">换一个账号</a> : null}</> : <><p>{invitation.allowRegistration?'使用原 MX 账号登录；没有账号可通过此邀请注册。':'此邀请仅供已有 MX 账号使用，请登录后继续。'}</p><a className="qp-button qp-button--primary" href="/auth/sso/login?surface=application&invitation=1">{invitation.allowRegistration?'登录或注册后继续':'登录后继续'}</a></>}
    </> : !error ? <LoadingState /> : null}
    {error ? <><ErrorState error={error}/><button className={button} disabled={busy} onClick={()=>setRetry(value=>value+1)}>重新检查邀请</button></> : null}
    <footer>加入后自动完成租户绑定，无需管理员再次操作。</footer>
  </main></div>
}
