import { WebSearchAccess } from './web-search-access.jsx'
import { useEffect, useState } from 'react'
import { withIpRiskProductScopes, withEnterpriseProductScopes } from '../shared/product-access.mjs'
import { withProductScopes } from '../shared/product-catalog.mjs'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, Modal, Pagination, platformLabel } from './components.jsx'
import { PagedItems } from './paged-items.jsx'

const groups = [['all','全部能力'],['web','Web Search'],['platforms','数据域'],['operations','业务操作'],['compatibility','兼容接口']]
const count = scopes => scopes.platforms.length + scopes.capabilities.length
const diff = (from, to) => ({ platforms: from.platforms.filter(s=>!to.platforms.includes(s)), capabilities: from.capabilities.filter(s=>!to.capabilities.includes(s)) })

export function TenantServiceAccess({token,tenants,platforms,capabilities,initialTenantId='',onSaved}) {
  const [tenantId,setTenantId] = useState(initialTenantId)
  const [form,setForm] = useState(null)
  const [baseline,setBaseline] = useState(null)
  const [reason,setReason] = useState('')
  const [busy,setBusy] = useState(false)
  const [error,setError] = useState(null)
  const [saved,setSaved] = useState(false)
  const [reload,setReload] = useState(0)
  const [group,setGroup] = useState('all')
  const [filter,setFilter] = useState('')
  const [selection,setSelection] = useState('all')
  const [page,setPage] = useState(1)
  const [preview,setPreview] = useState(null)
  const [confirmed,setConfirmed] = useState(false)
  useEffect(() => {
    let active = true
    setForm(null); setBaseline(null); setError(null); setSaved(false); setReason(''); setPreview(null)
    if (tenantId) adminApi.tenantServiceAccess(token,tenantId).then(data=>{if(active){setForm(data);setBaseline(data)}}).catch(e=>{if(active)setError(e)})
    return ()=>{active=false}
  },[token,tenantId,reload])
  const change = update => { setForm(update);setSaved(false);setPreview(null) }
  const toggle = (field,scope,enabled) => change(f=>({...f,[field]:enabled?[...new Set([...f[field],scope])]:f[field].filter(s=>s!==scope),webSearchOrder:field==='capabilities'&&!enabled?(f.webSearchOrder||[]).filter(key=>`web.search.provider.${key}`!==scope):f.webSearchOrder}))
  const review = async () => {
    setBusy(true);setError(null);setConfirmed(false)
    try { setPreview(await adminApi.previewTenantServiceAccess(token,tenantId,{...form,reason})) }
    catch(e){setError(e)}finally{setBusy(false)}
  }
  const save = async () => {
    setBusy(true);setError(null)
    try {
      const result = await adminApi.saveTenantServiceAccess(token,tenantId,{...form,reason,previewToken:preview.previewToken,confirmRemovals:confirmed})
      setForm(result);setBaseline(result);setReason('');setSaved(true);setPreview(null);onSaved?.()
    } catch(e){setError(e);setPreview(null)}finally{setBusy(false)}
  }
  const entries = form ? [
    ...[...new Set([...platforms,...form.platforms])].map(scope=>({scope,field:'platforms',label:scope==='web_search'?'Web Search':platformLabel(scope),group:'platforms'})),
    ...[...new Set([...Object.keys(capabilities),...form.capabilities])].map(scope=>({scope,field:'capabilities',label:capabilities[scope]?.label||scope,group:capabilities[scope]?.group==='compatibility'?'compatibility':'operations'})),
  ] : []
  const matches = entries.filter(row=>(group==='all'||row.group===group) && `${row.label} ${row.scope}`.toLowerCase().includes(filter.trim().toLowerCase()) && (selection==='all'||form[row.field].includes(row.scope)===(selection==='selected')))
  const pages = Math.max(1,Math.ceil(matches.length/8)), current = Math.min(page,pages)
  const added = form && baseline ? diff(form,baseline) : {platforms:[],capabilities:[]}
  const removed = form && baseline ? diff(baseline,form) : {platforms:[],capabilities:[]}
  const names = scopes => [...scopes.platforms.map(s=>platformLabel(s)),...scopes.capabilities.map(s=>capabilities[s]?.label||s)]
  const scopeList = scopes => <ul className="mih-access-scope-list">{scopes.platforms.map(s=><li key={s}>{platformLabel(s)} <code>{s}</code></li>)}{scopes.capabilities.map(s=><li key={s}>{capabilities[s]?.label||s} <code>{s}</code></li>)}</ul>
  return <section className="mih-access-editor" aria-label="租户授权工作区">
    <div className="mih-access-context">
      <DropdownField label="开通租户" value={tenantId} onChange={setTenantId} disabled={busy} options={[{value:'',label:'选择租户'},...tenants.map(t=>({value:t.id,label:t.name}))]} />
      <p>已选能力同步所有已有 Key；新调用者继承租户授权。</p>
      {tenantId ? <button className="qp-button qp-button--outline" disabled={busy} onClick={()=>setReload(n=>n+1)}>重新读取当前授权</button> : null}
    </div>
    {error ? <ErrorState error={error} /> : null}
    {saved ? <p className="mih-access-success" role="status">已保存并同步所有已有 Key。原密钥继续有效，租户清单外的权限已保留；产品页刷新调用身份即可读取。</p> : null}
    {!tenantId ? <div className="qp-panel mih-access-empty">选择租户，集中管理数据域、业务操作和搜索渠道。</div> : !form && !error ? <p role="status">正在读取租户授权…</p> : null}
    {form ? <>
      <div className="mih-access-workspace">
        <nav className="mih-access-rail" aria-label="授权分类">{groups.map(([key,label])=><button type="button" key={key} aria-pressed={group===key} onClick={()=>{setGroup(key);setPage(1)}}>{label}</button>)}</nav>
        <div className="mih-access-main">
          {group==='web' ? <WebSearchAccess form={form} onChange={change} disabled={busy}/> : <>
            <div className="mih-access-tools"><input type="search" className="qp-input" aria-label="搜索租户能力" placeholder="搜索名称或能力标识" value={filter} onChange={e=>{setFilter(e.target.value);setPage(1)}}/>
              <div className="mih-access-segments" aria-label="授权筛选">{[['all','全部'],['selected','已选'],['unselected','未选']].map(([value,label])=><button type="button" key={value} aria-pressed={selection===value} onClick={()=>{setSelection(value);setPage(1)}}>{label}</button>)}</div>
            </div>
            <div className="mih-access-presets"><span>快速勾选</span><button type="button" onClick={()=>change(f=>withProductScopes(f,'xiaohongshu'))} disabled={busy}>小红书笔记</button><button type="button" onClick={()=>change(withIpRiskProductScopes)} disabled={busy}>IP 风险画像</button><button type="button" onClick={()=>change(withEnterpriseProductScopes)} disabled={busy}>企业数据</button></div>
            <div className="mih-access-list" aria-label="租户能力清单">
              <div className="mih-access-list-head"><span>能力名称 / 标识</span><span>分类</span><span>状态</span></div>
              {matches.slice((current-1)*8,current*8).map(row=><label className="mih-access-row" key={`${row.field}:${row.scope}`}>
                <input type="checkbox" disabled={busy} checked={form[row.field].includes(row.scope)} onChange={e=>toggle(row.field,row.scope,e.target.checked)}/>
                <span><strong>{row.label}</strong><code>{row.scope}</code></span><small>{groups.find(([key])=>key===row.group)?.[1]}</small><em data-selected={form[row.field].includes(row.scope)}>{form[row.field].includes(row.scope)?'已选':'未选'}</em>
              </label>)}
              {!matches.length ? <p className="mih-access-empty">没有匹配项，试试其他名称或标识。</p> : null}
            </div>
            <Pagination label="租户能力分页" page={current} pageSize={8} total={matches.length} totalPages={pages} hasMore={current<pages} onPageChange={setPage}/>
          </>}
        </div>
        <aside className="mih-access-summary" aria-label="本次变更">
          <h3>本次变更</h3><dl><div><dt>新增</dt><dd>{count(added)}</dd></div><div data-danger={count(removed)>0}><dt>移除</dt><dd>{count(removed)}</dd></div><div><dt>当前已选</dt><dd>{count(form)}</dd></div></dl>
          <p>保存时补齐所有旧 Key 缺少的已选权限。</p><p>只移除本次明确取消的租户权限，保留 Key 额外权限。</p>
          {count(removed)>0 ? <p className="mih-access-warning">将移除：{names(removed).join('、')}。请在预览中确认受影响的 Key。</p> : null}
          <details><summary>调用者默认额度</summary><p>每个调用者独立生效；已有 Key 的限额保持不变。</p>{[['maxRequests','窗口请求上限'],['windowSeconds','窗口秒数'],['maxPageSize','最大分页'],['maxCrawlWork','最大采集工作量']].map(([field,label])=><Field key={field} label={label}><input className="qp-input" type="number" min="1" disabled={busy} value={form[field]} onChange={e=>change(f=>({...f,[field]:Number(e.target.value)}))}/></Field>)}</details>
        </aside>
        <footer className="mih-access-savebar"><Field label="变更原因"><input className="qp-input" placeholder="说明本次授权调整，便于追溯" value={reason} disabled={busy} onChange={e=>{setReason(e.target.value);setPreview(null)}}/></Field><button className="qp-button qp-button--primary" disabled={busy||!reason.trim()} onClick={review}>{busy?'正在处理…':'预览变更'}</button></footer>
      </div>
    </> : null}
    {preview ? <Modal title="确认授权变更" size="large" busy={busy} onClose={()=>setPreview(null)} description={`${tenants.find(t=>t.id===tenantId)?.name||''} · ${preview.consumerCount} 个调用者 · ${preview.keyCount} 把已有 Key，其中 ${preview.changedKeyCount} 把需要更新。`}
      footer={<><button type="button" className="qp-button qp-button--outline" disabled={busy} onClick={()=>setPreview(null)}>返回修改</button><button type="button" className="qp-button qp-button--primary" disabled={busy||(preview.requiresRemovalConfirmation&&!confirmed)} onClick={save}>{busy?'正在同步…':'确认并同步'}</button></>}>
      <p>新增权限同步到所有已有 Key；原密钥、有效期、状态、已有额度与历史用量保持不变。</p>
      {preview.requiresRemovalConfirmation ? <div className="mih-access-warning"><strong>以下权限将从租户调用者和已有 Key 中移除，相关调用可能立即受限。</strong>{scopeList(preview.removed)}</div> : <p>本次不会移除 Key 权限。</p>}
      <PagedItems items={preview.keys} label="受影响的 Key" text={key=>`${key.name} ${key.consumerName} ${key.id}`} pageSize={5}>{rows=><div className="mih-access-key-preview">{rows.map(({entry:key})=><article key={key.id}>
        <header><strong>{key.name}</strong><span>{key.consumerName} · {key.status}</span><code>{key.id.slice(0,8)}</code></header>
        <div><span>新增 {count(key.added)}</span><span className={count(key.removed)?'mih-access-danger':''}>移除 {count(key.removed)}</span><span>保留额外权限 {count(key.preserved)}</span>{key.previous.scopeMode==='legacy_dynamic'?<span>转换为明确权限快照</span>:null}</div>
        {count(key.removed)>0?<div className="mih-access-warning"><strong>将移除</strong>{scopeList(key.removed)}</div>:null}
        {count(key.added)>0?<details><summary>查看新增权限</summary>{scopeList(key.added)}</details>:null}
        {count(key.preserved)>0?<details><summary>查看保留的额外权限</summary>{scopeList(key.preserved)}</details>:null}
      </article>)}</div>}</PagedItems>
      {preview.requiresRemovalConfirmation ? <label className="mih-access-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} disabled={busy}/>我已确认移除以上权限，并知晓会影响已有 Key 的调用</label>:null}
    </Modal>:null}
  </section>
}
