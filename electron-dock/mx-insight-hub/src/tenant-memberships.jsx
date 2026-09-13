import { useEffect, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState } from './components.jsx'

export function TenantMemberships({ token, tenants }) {
  const [members, setMembers] = useState([])
  const [memberId, setMemberId] = useState('')
  const [tenantId, setTenantId] = useState('')
  const [role, setRole] = useState('viewer')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const load = async () => { try { setMembers(await adminApi.members(token)); setError(null) } catch (e) { setError(e) } }
  useEffect(() => { void load() }, [token])
  const change = async (body, revoke = false) => {
    setBusy(true); setError(null)
    try { await (revoke ? adminApi.revokeMembership : adminApi.grantMembership)(token, body); await load() }
    catch (e) { setError(e) } finally { setBusy(false) }
  }
  return <section className="qp-panel">
    <h2>登录成员与租户绑定</h2>
    <p>用户先通过 Launcher 账号登录一次，再在这里将 Hub 成员绑定到租户。账号验证不会自动授予租户权限。</p>
    <button className="qp-button qp-button--outline" disabled={busy} onClick={load}>刷新登录成员</button>
    <div className="mih-xhs-detail-actions">
      <DropdownField label="Hub 成员" value={memberId} onChange={setMemberId} disabled={busy} options={[{ value: '', label: '选择已登录成员' }, ...members.filter(m => m.status === 'active').map(m => ({ value: m.id, label: `${m.displayName || '未命名'} · ${m.id}` }))]} />
      <DropdownField label="绑定租户" value={tenantId} onChange={setTenantId} disabled={busy} options={[{ value: '', label: '选择租户' }, ...tenants.filter(t => t.status === 'active').map(t => ({ value: t.id, label: t.name }))]} />
      <DropdownField label="角色" value={role} onChange={setRole} disabled={busy} options={[{value:'viewer',label:'查看者'},{value:'analyst',label:'分析员'},{value:'admin',label:'租户管理员'},{value:'owner',label:'租户所有者'}]} />
      <button className="qp-button qp-button--primary" disabled={busy || !memberId || !tenantId} onClick={() => change({ memberId, tenantId, role })}>保存租户绑定</button>
    </div>
    {error ? <ErrorState error={error} /> : null}
    {members.map(member => <div key={member.id}><strong>{member.displayName || member.id}</strong><small> · {member.id}</small>{member.memberships?.filter(m => m.status === 'active').map(m => <p key={m.tenantId}>{tenants.find(t => t.id === m.tenantId)?.name || m.tenantId} · {m.role} <button className="qp-button qp-button--outline" disabled={busy} onClick={() => change({memberId:member.id,tenantId:m.tenantId},true)}>解除绑定</button></p>)}</div>)}
  </section>
}
