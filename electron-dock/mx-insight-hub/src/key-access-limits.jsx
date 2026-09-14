import { useEffect, useState } from 'react'
import { adminApi } from './api.js'
import { DropdownField, ErrorState, Field, platformLabel } from './components.jsx'

export function KeyAccessLimitsPanel({token,consumerId,capabilities}) {
 const [keys,setKeys]=useState([]),[keyId,setKeyId]=useState(''),[error,setError]=useState(null)
 useEffect(()=>{let active=true;setKeys([]);setKeyId('');setError(null)
  if(consumerId) adminApi.apiKeys(token,consumerId).then(items=>{if(active)setKeys(items.filter(key=>key.status==='active'))}).catch(e=>{if(active)setError(e)})
  return ()=>{active=false}
 },[token,consumerId])
 const key=keys.find(item=>item.id===keyId)
 return <section className="qp-panel mih-panel"><h2>指定 Key 的次数与频率</h2>
  <p>为当前调用者的某一把 Key 单独设限。默认不额外限制；已有调用者策略、签发额度、套餐及服务容量限制仍然生效。</p>
  <DropdownField label="选择 Key" value={keyId} onChange={setKeyId} options={[{value:'',label:'请选择 Key'},...keys.map(key=>({value:key.id,label:`${key.name} · ${key.id.slice(0,8)}`}))]} />
  {error ? <ErrorState error={error}/> : null}
  {key ? <KeyLimitForm key={key.id} token={token} apiKey={key} capabilities={capabilities}/> : null}
 </section>
}
function KeyLimitForm({token,apiKey,capabilities}) {
 const scopes=[...(apiKey.platforms||[]).map(scope=>({value:`platform:${scope}`,label:`数据域 · ${platformLabel(scope)}`})),...(apiKey.capabilities||[]).map(scope=>({value:`capability:${scope}`,label:`功能 · ${capabilities[scope]?.label||scope}`}))]
 const [scope,setScope]=useState(scopes[0]?.value||''),[limits,setLimits]=useState([]),[ready,setReady]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(null),[saved,setSaved]=useState(false)
 const [form,setForm]=useState({totalLimit:'',rateLimit:'',windowSeconds:60,revision:0})
 useEffect(()=>{let active=true;adminApi.keyAccessLimits(token,apiKey.id).then(rows=>{if(active){setLimits(rows);setReady(true)}}).catch(e=>{if(active)setError(e)})
 return ()=>{active=false}},[token,apiKey.id])
 useEffect(()=>{const [type,key]=scope.split(':');const row=limits.find(item=>item.scopeType===type&&item.scopeKey===key)
 setForm({totalLimit:row?.totalLimit??'',rateLimit:row?.rateLimit??'',windowSeconds:row?.windowSeconds??60,revision:row?.revision??0})
 },[scope,limits])
 const save=async event=>{event.preventDefault();setBusy(true);setError(null);setSaved(false)
 const [scopeType,scopeKey]=scope.split(':')
 try {const row=await adminApi.saveKeyAccessLimit(token,apiKey.id,{scopeType,scopeKey,...form,totalLimit:form.totalLimit===''?null:Number(form.totalLimit),rateLimit:form.rateLimit===''?null:Number(form.rateLimit),windowSeconds:Number(form.windowSeconds)})
 setLimits(current=>[...current.filter(item=>item.scopeType!==scopeType||item.scopeKey!==scopeKey),row]);setSaved(true)
 }catch(e){setError(e)}finally{setBusy(false)}}
 return <form onSubmit={save}>
  <DropdownField label="限制的开放功能 / 数据域" value={scope} onChange={value=>{setScope(value);setSaved(false)}} options={scopes} disabled={busy||!ready}/>
  <div className="mih-page-actions">
   <Field label="累计次数上限" hint="留空：不额外限制。按此 Key 的历史累计用量计算，修改上限不会清零。"><input className="qp-input" type="number" min="1" max="2147483647" placeholder="不限制" value={form.totalLimit} disabled={busy||!ready} onChange={e=>setForm({...form,totalLimit:e.target.value})}/></Field>
   <Field label="窗口内请求上限" hint="留空：不额外限频，例如 60 秒最多 10 次。"><input className="qp-input" type="number" min="1" max="2147483647" placeholder="不限制" value={form.rateLimit} disabled={busy||!ready} onChange={e=>setForm({...form,rateLimit:e.target.value})}/></Field>
   <Field label="时间窗口（秒）"><input className="qp-input" type="number" min="1" max="86400" value={form.windowSeconds} disabled={busy||!ready} onChange={e=>setForm({...form,windowSeconds:e.target.value})}/></Field>
  </div>
  <p>累计额度统计已交付、执行中及结果未知的逻辑请求；失败释放后不占累计额度。限频统计已受理请求，包括后续失败的请求。IP 批量按每个 IP 计数；只回放历史结果不会产生新调用额度。本设置不授予额外权限。</p>
  <button className="qp-button qp-button--primary" disabled={!ready||busy||!scope}>{busy?'正在保存…':'保存此 Key 的限制'}</button>
  {saved ? <p role="status">已保存，下次请求生效。</p> : null}
  {error ? <ErrorState error={error}/> : null}
 </form>
}
