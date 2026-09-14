import { useEffect, useState } from 'react'
import { withIpRiskProductScopes } from '../shared/product-access.mjs'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field } from './components.jsx'

export function TenantServiceAccess({token,tenants,platforms,capabilities}) {
  const [tenantId,setTenantId] = useState('')
  const [form,setForm] = useState(null)
  const [reason,setReason] = useState('')
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState(null)
  const [saved,setSaved] = useState(false)
  const [reload,setReload] = useState(0)
  useEffect(() => {
    let active = true
    setForm(null); setError(null); setSaved(false); setReason('')
    if (tenantId) adminApi.tenantServiceAccess(token,tenantId).then(data=>{if(active)setForm(data)}).catch(e=>{if(active)setError(e)})
    return ()=>{active=false}
  },[token,tenantId,reload])
  const toggle = (field,scope,enabled) => setForm(f=>({...f,[field]:enabled?[...new Set([...f[field],scope])]:f[field].filter(s=>s!==scope)}))
  const save = async () => {
    setBusy(true);setError(null);setSaved(false)
    try { setForm(await adminApi.saveTenantServiceAccess(token,tenantId,{...form,reason}));setReason('');setSaved(true) }
    catch(e){setError(e)}finally{setBusy(false)}
  }
  const preset = () => setForm(f=>({...f,platforms:[...new Set([...f.platforms,'xiaohongshu'])],capabilities:[...new Set([...f.capabilities,'compat.xiaohongshu.app_v2','social.posts.resolve','social.posts.search','social.users.resolve','social.users.posts'])]}))
  return <section className="qp-panel">
    <h2>租户业务开通</h2><p>仅平台管理员可开通。新租户默认无业务权限；现有调用者同步本次授权，新调用者自动继承，租户自行签发范围更小的 Key。</p>
    <DropdownField label="开通租户" value={tenantId} onChange={setTenantId} disabled={busy} options={[{value:'',label:'选择租户'},...tenants.map(t=>({value:t.id,label:t.name}))]} />
    {error ? <ErrorState error={error} /> : null}
    {tenantId ? <button className="qp-button qp-button--outline" disabled={busy} onClick={()=>setReload(n=>n+1)}>重新读取当前授权</button> : null}
    {form ? <>
      <div className="mih-xhs-detail-actions"><button className="qp-button qp-button--outline" disabled={busy} onClick={preset}>勾选小红书笔记所需权限</button><button className="qp-button qp-button--outline" disabled={busy} onClick={()=>setForm(withIpRiskProductScopes)}>勾选 IP 风险画像所需权限</button><button className="qp-button qp-button--outline" disabled={busy} onClick={()=>setForm(f=>({...f,platforms:[],capabilities:[]}))}>清空本次勾选</button></div>
      {form.platforms.includes('ip_risk') && !form.capabilities.includes('ip.risk.query') ? <p role="status">仅勾选 ip_risk 数据域还不能使用 IP 风险画像。请同时勾选“IP 风险查询能力”，保存后租户才能看到产品和文档。</p> : null}
      <h3>数据域</h3><div className="mih-tenant-access-scopes">{platforms.map(scope=><label key={scope}><input type="checkbox" disabled={busy} checked={form.platforms.includes(scope)} onChange={e=>toggle('platforms',scope,e.target.checked)} /> {scope}</label>)}</div>
      <h3>业务操作与兼容接口</h3><div className="mih-tenant-access-scopes">{Object.entries(capabilities).map(([scope,info])=><label key={scope}><input type="checkbox" disabled={busy} checked={form.capabilities.includes(scope)} onChange={e=>toggle('capabilities',scope,e.target.checked)} /> {info.label || scope}<small>{scope}</small></label>)}</div>
      <p>以下为每个调用者的授权额度，并非整个租户的共享总额。所有 Key 仍受其调用者套餐和上游预算限制。</p>
      <div className="mih-xhs-detail-actions">{[['maxRequests','窗口请求上限'],['windowSeconds','窗口秒数'],['maxPageSize','最大分页'],['maxCrawlWork','最大采集工作量']].map(([field,label])=><Field key={field} label={label}><input className="qp-input" type="number" min="1" disabled={busy} value={form[field]} onChange={e=>setForm(f=>({...f,[field]:Number(e.target.value)}))} /></Field>)}</div>
      <p>取消已开通范围会收回该租户现有调用者的对应授权；旧 Key 随即受限。增加授权不会扩大旧 Key 的签发快照，请在 API Keys 中显式调整原 Key 权限或签发新 Key。原先由管理员单独开通且不在本租户配置中的范围保持原状。</p>
      <Field label="变更原因"><input className="qp-input" value={reason} disabled={busy} onChange={e=>setReason(e.target.value)} /></Field>
      <button className="qp-button qp-button--primary" disabled={busy || !reason.trim()} onClick={save}>{busy?'正在保存…':'保存并同步租户业务权限'}</button>
      {saved ? <p role="status">已保存。租户刷新浏览器页面即可更新产品菜单和文档；请重新打开 Key 权限窗口，显式勾选新增权限。</p> : null}
    </> : null}
  </section>
}
