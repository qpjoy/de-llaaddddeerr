import { useCallback,useEffect,useRef,useState } from 'react'
import { ShieldCheck,ArrowRight,ArrowLeft,Stack,Code,Users,Check } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField,ErrorState,Field,LoadingState,Modal,useRemoteData } from './components.jsx'
import { useDemoKeySelection } from './demo-credentials.jsx'
import { checkoutLocation } from '../shared/payment-checkout.mjs'
import './commerce.css'

const primary='qp-button qp-button--primary',secondary='qp-button qp-button--outline'
const money=value=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',minimumFractionDigits:0,maximumFractionDigits:2}).format(value/100)
const daysLeft=value=>Math.max(0,Math.ceil((new Date(value).getTime()-Date.now())/86400000))
const stamp=value=>new Date(value).toLocaleString('zh-CN',{hour12:false})
const period=months=>months===12?'年':`${months} 个月`
const status={pending:'待付款',delivering:'正在开通',active:'已开通',test_delivered:'测试完成'}
const productStatus={published:'已上架',draft:'草稿',retired:'已下架'}
const benefits=[{icon:ShieldCheck,title:'识别风险线索',text:'查看代理类型与风险标签，辅助判断异常访问。'},{icon:Stack,title:'高效批量核查',text:'一次提交多个 IP，逐项查看结果与历史画像。'},{icon:Code,title:'接入你的业务',text:'网页查询与 API 共用订阅，方便集成到工作流。'}]

export function CommercePage({token,session,onUnauthorized,onSessionChanged,query,setQuery,notify}) {
  const admin=session.kind==='admin-token',selectKey=useDemoKeySelection()
  const view=query.get('view')||'store',sku=query.get('sku')
  const [selected,setSelected]=useState(null),[editing,setEditing]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(null)
  const lock=useRef(false),purchaseKey=useRef(null)
  const load=useCallback(()=>Promise.all([adminApi.commerceProducts(token),adminApi.tenants(token)]).then(([catalog,tenants])=>({catalog,tenants})),[token])
  const state=useRemoteData(load,onUnauthorized),data=state.data
  const tenants=(data?.tenants||[]).filter(t=>session.platformAdmin||session.memberships?.some(m=>m.tenantId===t.id&&m.capabilities?.includes('billing.read')))
  const tenantId=tenants.some(t=>t.id===query.get('tenantId'))?query.get('tenantId'):tenants[0]?.id||''
  const canBuy=session.platformAdmin||session.memberships?.some(m=>m.tenantId===tenantId&&m.capabilities?.includes('apikey.write')&&m.capabilities?.includes('recharge.create'))
  const [purchases,setPurchases]=useState({orders:[],subscriptions:[]}),[checkout,setCheckout]=useState(null)
  const refresh=useCallback(async()=>{if(!tenantId)return;const result=await adminApi.commercePurchases(token,tenantId);setPurchases(result);return result},[token,tenantId])
  useEffect(()=>{
    let live=true;setPurchases({orders:[],subscriptions:[]});setCheckout(null)
    if(tenantId)adminApi.commercePurchases(token,tenantId).then(result=>{if(live)setPurchases(result)}).catch(e=>{if(live)setError(e)})
    return()=>{live=false}
  },[token,tenantId])
  async function perform(work){if(lock.current)return;lock.current=true;setBusy(true);setError(null);try{await work()}catch(e){setError(e);if(e.status===401)onUnauthorized?.(e)}finally{lock.current=false;setBusy(false)}}
  const navigate=(next,extra={})=>setQuery({view:next,sku:'',...extra})
  const buy=(item,acceptance=false)=>{purchaseKey.current=null;setSelected({item,acceptance})}
  async function purchase(){await perform(async()=>{
    const body={sku:selected.item.sku,revision:selected.item.revision,environment:'live'},signature=JSON.stringify([tenantId,body,selected.acceptance])
    if(purchaseKey.current?.signature!==signature)purchaseKey.current={signature,key:crypto.randomUUID()}
    const create=selected.acceptance?adminApi.commerceAcceptance:adminApi.commercePurchase
    const order=await create(token,tenantId,body,purchaseKey.current.key)
    setSelected(null);navigate('purchases',{tenantId,orderId:order.id});await refresh()
    notify?.('订单已创建，可以继续付款。')
  })}
  async function action(order,action){await perform(async()=>{
    const result=await adminApi.commerceOrderAction(token,tenantId,order.id,action)
    if(result.paymentUrl)setCheckout({id:order.id,url:checkoutLocation(result.paymentUrl,order.environment)})
    await refresh();await onSessionChanged?.()
  })}
  async function start(subscription){await perform(async()=>{
    if(subscription.channel==='product') {
      const {keyId}=await adminApi.commerceAccess(token,tenantId)
      await selectKey?.(keyId)
      await onSessionChanged?.()
    }
    window.location.hash='/data-products/ip-risk'
  })}
  const pendingOrderIds=purchases.orders.filter(o=>!o.deliveredAt).map(o=>o.id).join(',')
  useEffect(()=>{
    if(view!=='purchases'||!tenantId||!pendingOrderIds)return
    let running=false,active=true
    const timer=setInterval(async()=>{if(running)return;running=true;try{
      const latest=await adminApi.commercePurchases(token,tenantId)
      if(active){setPurchases(latest);if(latest.orders.some(o=>o.deliveredAt&&pendingOrderIds.split(',').includes(o.id)))await onSessionChanged?.()}
    }catch{/* Explicit refresh reports errors. Polling never creates payments or queries. */}finally{running=false}},5000)
    return()=>{active=false;clearInterval(timer)}
  },[view,tenantId,token,pendingOrderIds,onSessionChanged])
  const current=purchases.subscriptions.filter(s=>new Date(s.startsAt)<=new Date()&&new Date(s.endsAt)>new Date())
  const rank=s=>new Date(s.endsAt)<=new Date()?2:new Date(s.startsAt)>new Date()?1:0
  const subscriptions=[...purchases.subscriptions].sort((a,b)=>rank(a)-rank(b)||new Date(a.startsAt)-new Date(b.startsAt))
  const detail=data?.catalog.items.find(item=>item.sku===sku)
  return <div className="mih-page mih-shop">
    <header className="mih-shop-header"><div><h1>数据商城</h1><p>为团队选好数据服务，让业务判断更有依据。</p></div><nav aria-label="商城工作区">{[['store','发现服务'],['purchases','我的订阅'],...(admin?[['manage','商品管理']]:[])].map(([value,label])=><button key={value} className={view===value?'is-active':''} aria-pressed={view===value} onClick={()=>navigate(value)}>{label}</button>)}</nav></header>
    {error||state.error?<ErrorState error={error||state.error}/>:null}
    {!data?<LoadingState/>:<>
      {view==='store'&&!detail?<div className="mih-shop-products">{data.catalog.items.filter(item=>item.status==='published').map(item=><article className="mih-shop-offer" key={item.sku}>
        <div className="mih-shop-art" aria-hidden="true"><div className="mih-shop-orbit"/><ShieldCheck weight="duotone"/><span>IP 风险画像</span></div>
        <div className="mih-shop-offer-copy"><h2>{item.name}</h2><p>{item.description}</p><ul className="mih-shop-highlights"><li><Check/>风险线索识别</li><li><Check/>批量 IP 核查</li><li><Check/>网页与 API 接入</li></ul><div className="mih-shop-price">{money(item.amountMinor)}<span> / {period(item.months)}</span></div><p className="mih-shop-plan">{item.quota.toLocaleString()} 次调用 · 空间共享</p><div className="mih-shop-actions"><button className={primary} onClick={()=>buy(item)}>立即订阅<ArrowRight size={18}/></button><button className={secondary} onClick={()=>navigate('store',{sku:item.sku})}>查看详情</button></div></div>
      </article>)}{!data.catalog.items.some(item=>item.status==='published')?<section className="mih-shop-empty"><h2>更多数据服务，正在准备中</h2></section>:null}</div>:null}
      {view==='store'&&detail?<>
        <button className="qp-button qp-button--ghost mih-shop-back" onClick={()=>navigate('store')}><ArrowLeft/>返回商城</button>
        <section className="mih-shop-detail"><div><h2>{detail.name}</h2><p>{detail.description}</p><div className="mih-shop-feature-grid">{benefits.map(({icon:Icon,title,text})=><div key={title}><Icon size={28}/><h3>{title}</h3><p>{text}</p></div>)}</div></div><aside><ShieldCheck size={42}/><div className="mih-shop-price">{money(detail.amountMinor)}<span> / {period(detail.months)}</span></div><p>{detail.quota.toLocaleString()} 次调用</p><p><Users size={18}/>空间内共享使用</p><button className={primary} onClick={()=>buy(detail)}>立即订阅<ArrowRight/></button></aside></section>
        <section className="mih-shop-terms"><h3>订阅说明</h3><dl><div><dt>为谁开通</dt><dd>绑定你选择的空间。空间内获授权的调用者与 API Keys 共享调用次数，不需要分别购买。</dd></div><div><dt>服务期限</dt><dd>付款确认后自动开通，有效期 {detail.months} 个月。续订从原到期日顺延，下一周期开始时获得新一期调用次数。</dd></div><div><dt>调用规则</dt><dd>本期最多成功调用 {detail.quota.toLocaleString()} 次。有效无数据也计入调用；明确失败不计入，结果待核对时保留对应次数。回看历史不增加调用次数。</dd></div><div><dt>到期与续订</dt><dd>到期或达到调用上限后暂停新查询，不自动续费或扣钱包。风险字段以本次返回为准，画像供业务判断参考。</dd></div></dl></section>
      </>:null}
      {view==='purchases'?<>
        <div className="mih-shop-toolbar"><DropdownField label="使用空间" value={tenantId} options={tenants.map(t=>({value:t.id,label:t.name}))} onChange={value=>setQuery({tenantId:value})}/><button className={secondary} disabled={busy||!tenantId} onClick={()=>perform(async()=>{await refresh();await onSessionChanged?.()})}>刷新</button></div>
        {!tenantId?<section className="mih-shop-empty"><h2>先开通一个空间</h2><a className={primary} href="#/payments">开通个人空间</a></section>:null}
        <div className="mih-shop-grid">{subscriptions.map(s=>{const future=new Date(s.startsAt)>new Date(),expired=new Date(s.endsAt)<=new Date(),remaining=s.quota-s.used-s.held
          return <section className="qp-panel mih-shop-card" key={s.id}><div className="mih-shop-card-top"><ShieldCheck size={26}/><span className="qp-tag">{future?'待生效':expired?'已到期':remaining?'使用中':'已达调用上限'}</span></div><h2>IP 风险画像</h2><p>{s.channel==='product'?'空间共享订阅':'原调用者订阅'}</p><div className="mih-shop-price">{s.used.toLocaleString()}<span> / {s.quota.toLocaleString()} 次</span></div><p>本期已调用{!future&&!expired?` · 有效期还剩 ${daysLeft(s.endsAt)} 天`:future?' · 新周期尚未开始':' · 本期已结束'}</p><progress max={s.quota} value={s.used+s.held} aria-label="本期调用次数"/>{s.held?<p>{s.held.toLocaleString()} 次请求处理中</p>:null}<p className="mih-shop-date">到期时间 {stamp(s.endsAt)}</p><div className="mih-shop-actions"><button className={primary} disabled={busy||future||expired||!canBuy} onClick={()=>start(s)}>开始使用<ArrowRight size={18}/></button><button className={secondary} onClick={()=>navigate('store')}>续订</button></div></section>})}</div>
        {!subscriptions.length&&tenantId?<section className="mih-shop-empty"><h2>还没有已开通的订阅</h2><button className={primary} onClick={()=>navigate('store')}>去商城看看</button></section>:null}
        <section className="mih-shop-orders"><h2>我的订单</h2><div className="qp-table-wrap"><table className="qp-table"><thead><tr><th>商品</th><th>金额</th><th>状态</th><th>操作</th></tr></thead><tbody>{purchases.orders.map(o=><tr key={o.id}><td><strong>{o.product.name}</strong><span className="mih-shop-date">{stamp(o.createdAt)}</span><details><summary>订单编号</summary><span className="mih-shop-id">{o.id}</span></details></td><td>{money(o.product.amountMinor)}</td><td>{status[o.status]}</td><td><div className="mih-shop-actions">{!o.deliveredAt?<><button className={secondary} disabled={busy} onClick={()=>action(o,'refresh')}>查询付款状态</button>{o.paymentStatus!=='paid'?<button className={primary} disabled={busy} onClick={()=>action(o,'checkout')}>去付款</button>:null}</>:<span>已完成</span>}{checkout?.id===o.id&&!o.deliveredAt?<a className={primary} href={checkout.url}>打开支付宝收银台 ↗</a>:null}</div></td></tr>)}</tbody></table></div>{!purchases.orders.length?<p>暂无订单</p>:null}</section>
      </>:null}
      {view==='manage'&&admin?<><div className="mih-shop-admin-heading"><h2>商品管理</h2><button className={primary} onClick={()=>setEditing({sku:'',revision:0,name:'',description:'',status:'draft',amountMinor:3399900,months:12,quota:100000})}>创建商品</button></div><div className="mih-shop-grid">{data.catalog.items.map(item=><section className="qp-panel mih-shop-card" key={item.sku}><span className="qp-tag">{productStatus[item.status]}</span><h2>{item.name}</h2><p>{money(item.amountMinor)} / {period(item.months)} · {item.quota.toLocaleString()} 次</p><div className="mih-shop-actions"><button className={secondary} onClick={()=>setEditing(item)}>编辑商品</button><button className={secondary} disabled={item.status!=='published'} onClick={()=>buy(item,true)}>创建 ¥1 验收订单</button></div></section>)}</div><DeliverySettings token={token}/></>:null}
    </>}
    {selected?<Modal title={`订阅 ${selected.item.name}`} onClose={busy?undefined:()=>setSelected(null)} closeOnBackdrop={!busy} closeOnEscape={!busy} footer={<button className={primary} disabled={busy||!canBuy||!tenantId||!data.catalog.purchaseAvailable||selected.item.status!=='published'} onClick={purchase}>{busy?'正在创建订单…':`确认并支付 ${money(selected.acceptance?100:selected.item.amountMinor)}`}</button>}>
      <div className="mih-shop-checkout"><div className="mih-shop-checkout-summary"><ShieldCheck size={36}/><div><strong>{selected.item.months} 个月 · {selected.item.quota.toLocaleString()} 次</strong><p>网页查询与 API 接入 · 空间共享</p></div></div><DropdownField label="使用空间" value={tenantId} options={tenants.map(t=>({value:t.id,label:t.name}))} onChange={value=>setQuery({tenantId:value})}/><p>付款后自动为空间开通，无需选择调用者。</p>
      {selected.acceptance?<p className="mih-inline-warning">管理员验收价 ¥1，正式售价保持 {money(selected.item.amountMinor)}。实际付款后按此商品期限与次数开通空间订阅。</p>:null}
      {current.some(s=>s.channel==='product')?<p>当前空间已有订阅，本次将从原到期日顺延。</p>:null}
      {!tenantId?<p><a href="#/payments">先开通个人空间</a>，或加入团队空间。</p>:!canBuy?<p>请由空间所有者或管理员购买订阅。</p>:null}
      {!data.catalog.purchaseAvailable?<p role="status">付款服务暂未就绪，请稍后再试。</p>:null}
      <details className="mih-shop-checkout-rules"><summary>订阅与续订规则</summary><p>成功调用计入本期上限；到期或达到上限后暂停新查询。续订的新周期从原到期日开始，次数不提前叠加。不自动续费或扣钱包，暂不支持转赠。</p></details></div>
    </Modal>:null}
    {editing?<ProductEditor item={editing} token={token} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);state.refresh()}}/>:null}
  </div>
}

function DeliverySettings({token}) {
  const load=useCallback(()=>adminApi.commerceDelivery(token),[token]),state=useRemoteData(load)
  const [channel,setChannel]=useState(null),[error,setError]=useState(null),[busy,setBusy]=useState(false)
  async function save(){setBusy(true);setError(null);try{await adminApi.commerceSaveDelivery(token,{channel:channel||state.data.channel,revision:state.data.revision});setChannel(null);state.refresh()}catch(e){setError(e)}finally{setBusy(false)}}
  const names={'legacy-v1':'v1 · 现有 IP 接口','baidu-v2':'百度 v2 · 网页接口'}
  return <section className="qp-panel mih-shop-card"><h2>产品交付渠道</h2><p>仅管理员可见。切换作用于空间订阅的新查询，已交付结果和原请求回放不变；旧调用者订阅仍按原渠道交付。</p>{error||state.error?<ErrorState error={error||state.error}/>:null}{state.data?<><DropdownField label="IP 风险画像交付渠道" value={channel||state.data.channel} options={Object.entries(names).map(([value,label])=>({value,label,description:state.data.channels?.find(c=>c.id===value)?.ready?'已配置':'配置未就绪'}))} onChange={setChannel}/><p>v1 凭据在<a href="#/external-platforms?provider=ipsearch">上游供应商</a>管理。当前百度 v2 为无需商业凭据的网页接口；正式商业 API 需另接其接口及凭据，不使用 Web Search 的密钥。</p><button className={primary} disabled={busy||!channel} onClick={save}>{busy?'保存中…':'保存交付渠道'}</button></>:<LoadingState/>}</section>
}
function ProductEditor({item,token,onClose,onSaved}) {
  const [form,setForm]=useState({...item}),[price,setPrice]=useState(String(item.amountMinor/100)),[busy,setBusy]=useState(false),[error,setError]=useState(null)
  const update=(key,value)=>setForm(f=>({...f,[key]:value}))
  async function save(e){e.preventDefault();if(busy)return;setBusy(true);setError(null);try{const {name,description,status,months,quota,revision}=form;await adminApi.commerceSaveProduct(token,form.sku,{name,description,status,amountMinor:Math.round(Number(price)*100),months:Number(months),quota:Number(quota),revision});onSaved()}catch(e){setError(e)}finally{setBusy(false)}}
  return <Modal title={item.revision?'编辑商品':'创建 IP 数据商品'} onClose={busy?undefined:onClose} closeOnBackdrop={!busy} closeOnEscape={!busy}><form onSubmit={save} className="mih-shop-editor">{error?<ErrorState error={error}/>:null}
    <Field label="商品标识"><input className="qp-input" value={form.sku} disabled={!!item.revision||busy} onChange={e=>update('sku',e.target.value)} required/></Field><Field label="商品名称"><input className="qp-input" value={form.name} onChange={e=>update('name',e.target.value)} required/></Field><Field label="商品介绍"><textarea className="qp-input" value={form.description} onChange={e=>update('description',e.target.value)}/></Field><Field label="售价（元）"><input className="qp-input" type="number" min="1" step="0.01" value={price} onChange={e=>setPrice(e.target.value)} required/></Field><div className="mih-shop-grid">{[['months','有效月数'],['quota','调用上限']].map(([key,label])=><Field key={key} label={label}><input className="qp-input" type="number" min="1" step="1" value={form[key]} onChange={e=>update(key,e.target.value)} required/></Field>)}</div><DropdownField label="销售状态" value={form.status} options={Object.entries(productStatus).map(([value,label])=>({value,label}))} onChange={value=>update('status',value)}/><button className={primary} disabled={busy}>{busy?'保存中…':'保存商品'}</button></form></Modal>
}
