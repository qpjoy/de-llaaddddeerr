import { useEffect, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, Modal } from './components.jsx'

const ROLES = [{value:'viewer',label:'查看者'},{value:'analyst',label:'分析员'},{value:'admin',label:'租户管理员'},{value:'owner',label:'租户所有者'}]
const ROLE_HINTS = {viewer:'查看租户接入与用量，不可签发 Key。',analyst:'查看调用者、Key 和用量，不可修改授权。',admin:'管理调用者与 Key；业务权限由平台管理员开通。',owner:'管理租户、成员、调用者与 Key；不可自行开通业务权限。'}

export function TenantMemberships({ token, tenants }) {
  const [members, setMembers] = useState([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [notice, setNotice] = useState('')
  const load = async () => {
    setLoading(true)
    try { setMembers(await adminApi.members(token)); setError(null) }
    catch (e) { setError(e) } finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [token])
  const change = async (body, revoke = false) => {
    setBusy(true); setError(null); setNotice('')
    try {
      await (revoke ? adminApi.revokeMembership : adminApi.grantMembership)(token, body)
      setEditing(null); setRemoving(null)
      setNotice(revoke ? '已解除该成员的租户访问权限。' : '租户绑定已保存，成员刷新页面后可查看。')
      await load()
    } catch (e) { setError(e) } finally { setBusy(false) }
  }
  const activeBindings = member => member.memberships?.filter(m => m.status === 'active') || []
  const tenantName = id => tenants.find(t => t.id === id)?.name || id
  const unbound = members.filter(m => activeBindings(m).length === 0).length
  const visible = members.filter(m => (filter !== 'unbound' || !activeBindings(m).length) && `${m.displayName || ''} ${m.id} ${activeBindings(m).map(b=>tenantName(b.tenantId)).join(' ')}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <section className="qp-panel mih-memberships">
    <header className="mih-memberships__header"><div><h2>登录成员与租户绑定</h2><p>成员通过 Launcher 登录后，在这里分配租户与角色。业务权限在下方“租户业务开通”单独设置。</p></div><button className="qp-button qp-button--outline" disabled={busy || loading} onClick={load}>刷新登录成员</button></header>
    <div className="mih-memberships__toolbar"><Field label="搜索成员或租户"><input className="qp-input" placeholder="姓名、成员 ID 或租户名称" value={query} onChange={e=>setQuery(e.target.value)} /></Field><DropdownField label="绑定状态" value={filter} onChange={setFilter} options={[{value:'all',label:`全部成员（${members.length}）`},{value:'unbound',label:`待绑定（${unbound}）`}]} /></div>
    {error && !editing && !removing ? <ErrorState error={error} /> : null}
    {notice ? <p role="status">{notice}</p> : null}
    <div className="mih-memberships__list" aria-busy={loading}>
      {!visible.length ? <p>{loading ? '正在加载成员…' : members.length ? '没有符合筛选条件的成员。' : '暂无登录成员，请用户先用 Launcher 账号登录 Hub。'}</p> : null}
      {visible.map(member => <article className="mih-memberships__member" key={member.id}>
        <div className="mih-memberships__identity"><strong>{member.displayName || '未命名成员'}</strong><small>成员 ID</small><code>{member.id}</code>{member.status !== 'active' ? <small>成员已停用</small> : null}</div>
        <div className="mih-memberships__bindings">{activeBindings(member).length ? activeBindings(member).map(binding=><div className="mih-memberships__binding" key={binding.tenantId}><div><strong>{tenantName(binding.tenantId)}</strong><small>{ROLES.find(r=>r.value===binding.role)?.label || binding.role}</small></div><div className="mih-memberships__actions"><button className="qp-button qp-button--ghost qp-button--sm" disabled={busy || member.status !== 'active'} onClick={()=>{setError(null);setEditing({memberId:member.id,tenantId:binding.tenantId,role:binding.role,existing:true})}}>修改角色</button><button className="qp-button qp-button--outline qp-button--sm" disabled={busy} onClick={()=>{setError(null);setRemoving({memberId:member.id,tenantId:binding.tenantId})}}>解除绑定</button></div></div>) : <span className="mih-memberships__empty">待绑定 · 暂无租户访问权限</span>}</div>
        <button className="qp-button qp-button--outline" disabled={busy || member.status !== 'active'} onClick={()=>{setError(null);setEditing({memberId:member.id,tenantId:'',role:'viewer',existing:false})}}>绑定租户</button>
      </article>)}
    </div>
    {editing ? <Modal title={editing.existing?'修改成员角色':'绑定租户'} description={`成员：${members.find(m=>m.id===editing.memberId)?.displayName || editing.memberId}`} busy={busy} closeOnBackdrop={false} onClose={()=>{setEditing(null);setError(null)}} footer={<><button className="qp-button qp-button--outline" disabled={busy} onClick={()=>{setEditing(null);setError(null)}}>取消</button><button className="qp-button qp-button--primary" disabled={busy || !editing.tenantId} onClick={()=>change({memberId:editing.memberId,tenantId:editing.tenantId,role:editing.role})}>保存租户绑定</button></>}>
      <code>{editing.memberId}</code>
      <DropdownField label="绑定租户" value={editing.tenantId} onChange={tenantId=>setEditing(f=>({...f,tenantId}))} disabled={busy || editing.existing} options={[{value:'',label:'选择租户'},...tenants.filter(t=>editing.existing?t.id===editing.tenantId:t.status==='active' && !activeBindings(members.find(m=>m.id===editing.memberId)).some(b=>b.tenantId===t.id)).map(t=>({value:t.id,label:t.name}))]} />
      <DropdownField label="角色" value={editing.role} onChange={role=>setEditing(f=>({...f,role}))} disabled={busy} options={ROLES} />
      <p>{ROLE_HINTS[editing.role]}</p>{error ? <ErrorState error={error} /> : null}
    </Modal> : null}
    {removing ? <Modal title="解除租户绑定" busy={busy} closeOnBackdrop={false} onClose={()=>{setRemoving(null);setError(null)}} footer={<><button className="qp-button qp-button--outline" disabled={busy} onClick={()=>{setRemoving(null);setError(null)}}>取消</button><button className="qp-button qp-button--primary" disabled={busy} onClick={()=>change(removing,true)}>确认解除绑定</button></>}><p>将解除“{members.find(m=>m.id===removing.memberId)?.displayName || removing.memberId}”对“{tenantName(removing.tenantId)}”的访问权限。</p><p>不会删除租户、调用者或撤销已有 API Key。</p>{error ? <ErrorState error={error} /> : null}</Modal> : null}
  </section>
}
