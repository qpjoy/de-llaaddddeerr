import { WEB_SEARCH_PROVIDERS, searchProviderKeys, withWebSearchProviders } from '../shared/web-search.mjs'
export function WebSearchAccess({form,onChange,allowed,disabled=false}) {
  const selected=searchProviderKeys(form.capabilities)
  const order=[...new Set([...(form.webSearchOrder || []),...selected])].filter(key=>selected.includes(key))
  const providers=WEB_SEARCH_PROVIDERS.filter(p=>!allowed || allowed.includes(p.capability))
  const setOrder=keys=>onChange(withWebSearchProviders(form,keys))
  const move=(index,offset)=>{const next=[...order];[next[index],next[index+offset]]=[next[index+offset],next[index]];setOrder(next)}
  return <section className="qp-panel mih-panel" aria-label="Web Search 开放范围">
    <h3>Web Search · 供应商与调用顺序</h3>
    <p>默认不开放。勾选后同时加入 Web Search 数据域和搜索能力；从上到下选择发送前可用的供应商。</p>
    <div className="mih-tenant-access-scopes">{providers.map(p=><label key={p.key}><input type="checkbox" disabled={disabled} checked={selected.includes(p.key)} onChange={e=>setOrder(e.target.checked?[...order,p.key]:order.filter(key=>key!==p.key))} />{p.label}</label>)}</div>
    <div className="mih-page-actions"><button type="button" className="qp-button qp-button--outline" disabled={disabled} onClick={()=>setOrder([...order,...providers.filter(p=>!order.includes(p.key)).map(p=>p.key)])}>选中当前可授权供应商</button><button type="button" className="qp-button qp-button--ghost" disabled={disabled} onClick={()=>setOrder([])}>清空搜索供应商</button></div>
    {order.length?<ol>{order.map((key,index)=><li key={key} className="mih-web-search-order"><span>{WEB_SEARCH_PROVIDERS.find(p=>p.key===key).label}</span><button type="button" className="qp-button qp-button--ghost" aria-label={`${key} 上移`} disabled={disabled||index===0} onClick={()=>move(index,-1)}>↑</button><button type="button" className="qp-button qp-button--ghost" aria-label={`${key} 下移`} disabled={disabled||index===order.length-1} onClick={()=>move(index,1)}>↓</button></li>)}</ol>:<p role="status">尚未选中搜索供应商。</p>}
    {allowed && selected.length ? <button type="button" className="qp-button qp-button--ghost" disabled={disabled} onClick={()=>onChange({...form,webSearchOrder:[]})}>沿用租户顺序</button> : null}
    {allowed && selected.length && !form.webSearchOrder?.length ? <p>尚未设置 Key 顺序；实际调用继承租户配置。使用上移、下移会保存本 Key 的独立顺序。</p> : null}
    <small>“全部”只保存此刻的勾选快照，后续新增供应商需再次开通。Key 只可使用调用者已获授权的范围。未设置 Key 顺序时继承租户顺序。</small>
  </section>
}
