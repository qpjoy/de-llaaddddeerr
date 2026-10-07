import { useCallback,useEffect,useRef,useState } from 'react'
import { ShieldCheck,ArrowRight } from '@phosphor-icons/react'
import { adminApi } from './api.js'
import { DropdownField,ErrorState,Field,LoadingState,Modal,PageHeading,useRemoteData } from './components.jsx'
import { checkoutLocation } from '../shared/payment-checkout.mjs'
import './commerce.css'

const primary='qp-button qp-button--primary',secondary='qp-button qp-button--outline'
const money=value=>new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY',maximumFractionDigits:2}).format(value/100)
const daysLeft=value=>Math.max(0,Math.ceil((new Date(value).getTime()-Date.now())/86400000))
const stamp=value=>new Date(value).toLocaleString('zh-CN',{hour12:false})
const status={pending:'待付款',delivering:'付款已确认 · 正在开通',active:'已交付',test_delivered:'测试交付 · 未开通正式权益'}
const productStatus={published:'已上架',draft:'草稿',retired:'已下架'}
export function CommercePage({token,session,onUnauthorized,onSessionChanged,query,setQuery,notify}){
  const [tab,setTab]=useState(query.get('view')==='purchases'?'purchases':'store'),[selected,setSelected]=useState(null),[editing,setEditing]=useState(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(null),lock=useRef(false),purchaseKey=useRef(null)
  const load=useCallback(()=>Promise.all([adminApi.commerceProducts(token),adminApi.tenants(token)]).then(([catalog,tenants])=>({catalog,tenants})),[token])
  const state=useRemoteData(load,onUnauthorized),data=state.data
  const tenants=(data?.tenants||[]).filter(t=>session.platformAdmin||session.memberships?.some(m=>m.tenantId===t.id&&m.capabilities?.includes('billing.read')))
  const tenantId=tenants.some(t=>t.id===query.get('tenantId'))?query.get('tenantId'):tenants[0]?.id||''
  const canBuy=session.platformAdmin||session.memberships?.some(m=>m.tenantId===tenantId&&m.capabilities?.includes('apikey.write')&&m.capabilities?.includes('recharge.create'))
  const [consumerId,setConsumerId]=useState(''),[consumers,setConsumers]=useState([]),[purchases,setPurchases]=useState({orders:[],subscriptions:[]})
  const [environment,setEnvironment]=useState('live'),[checkout,setCheckout]=useState(null)
  const refresh=useCallback(async()=>{
    if(!tenantId)return
    const result=await adminApi.commercePurchases(token,tenantId);setPurchases(result)
    return result
  },[token,tenantId])
  useEffect(()=>{
    let live=true;setConsumerId('');setConsumers([]);setPurchases({orders:[],subscriptions:[]});setCheckout(null)
    if(tenantId)Promise.all([canBuy?adminApi.consumers(token,tenantId):Promise.resolve([]),adminApi.commercePurchases(token,tenantId)]).then(([items,orders])=>{
      if(live){setConsumers(items.filter(c=>c.status==='active'));setPurchases(orders)}
    }).catch(e=>{if(live)setError(e)})
    return()=>{live=false}
  },[token,tenantId,canBuy])
  async function perform(work){if(lock.current)return;lock.current=true;setBusy(true);setError(null);try{await work()}catch(e){setError(e);if(e.status===401)onUnauthorized?.(e)}finally{lock.current=false;setBusy(false)}}
  async function purchase(){await perform(async()=>{
    const body={sku:selected.sku,revision:selected.revision,consumerId,environment},signature=JSON.stringify([tenantId,body])
    if(purchaseKey.current?.signature!==signature)purchaseKey.current={signature,key:crypto.randomUUID()}
    const order=await adminApi.commercePurchase(token,tenantId,body,purchaseKey.current.key)
    setSelected(null);setTab('purchases');setQuery({view:'purchases',tenantId,orderId:order.id});await refresh()
    notify?.('购买订单已创建，请从原订单打开收银台。')
  })}
  async function action(order,action){await perform(async()=>{
    const result=await adminApi.commerceOrderAction(token,tenantId,order.id,action)
    if(result.paymentUrl)setCheckout({id:order.id,url:checkoutLocation(result.paymentUrl,order.environment)})
    await refresh();await onSessionChanged?.()
  })}
  const pendingOrderIds=purchases.orders.filter(o=>!o.deliveredAt).map(o=>o.id).join(',')
  useEffect(()=>{
    if(tab!=='purchases'||!tenantId||!pendingOrderIds)return
    let running=false,active=true
    const timer=setInterval(async()=>{
      if(running)return;running=true
      try{const latest=await adminApi.commercePurchases(token,tenantId);if(active){setPurchases(latest);if(latest.orders.some(o=>o.deliveredAt&&pendingOrderIds.split(',').includes(o.id)))await onSessionChanged?.()}}
      catch{/* The explicit refresh reports errors; polling never creates a payment or query. */}
      finally{running=false}
    },5000)
    return()=>{active=false;clearInterval(timer)}
  },[tab,tenantId,token,pendingOrderIds,onSessionChanged])
  const currentSubscriptions=purchases.subscriptions.filter(s=>new Date(s.startsAt)<=new Date()&&new Date(s.endsAt)>new Date())
  const periodRank=s=>new Date(s.endsAt)<=new Date()?2:new Date(s.startsAt)>new Date()?1:0
  const sortedSubscriptions=[...purchases.subscriptions].sort((a,b)=>periodRank(a)-periodRank(b)||new Date(a.startsAt)-new Date(b.startsAt))
  return <div className="mih-page mih-shop">
    <PageHeading eyebrow="HUB MARKETPLACE" title="数据商城" description="选择数据服务，付款后自动开通。管理已购服务，查看本期调用次数和订阅有效期。" onRefresh={()=>perform(async()=>{state.refresh();await refresh();await onSessionChanged?.()})} loading={busy||state.loading}>
      {session.kind==='admin-token'?<button className={secondary} onClick={()=>setEditing({sku:'',revision:0,name:'',description:'',status:'draft',amountMinor:3399900,months:12,quota:100000})}>创建商品</button>:null}
    </PageHeading>
    <nav className="mih-source-section-tabs" aria-label="商城工作区">{[['store','浏览商品'],['purchases','我的购买']].map(([value,label])=><button key={value} aria-pressed={tab===value} onClick={()=>{setTab(value);setQuery({view:value})}}>{label}</button>)}</nav>
    {error||state.error?<ErrorState error={error||state.error}/>:null}
    {!data?<LoadingState/>:<>
      {tab==='store'?<><section className="qp-panel mih-shop-intro"><ShieldCheck size={36}/><div><span className="qp-eyebrow">从风险线索到可核对的证据</span><h2>让每一次 IP 查询都有据可查</h2><p>看归属地、识别风险信号、回溯历史画像。网页工作台与 API 共用同一份订阅。</p></div></section>
        <div className="mih-shop-grid">{data.catalog.items.map(item=><article className="qp-panel mih-shop-card" key={item.sku}>
          <div className="mih-shop-card-top"><ShieldCheck size={30}/><span className="qp-tag">{productStatus[item.status]}</span></div>
          <h2>{item.name}</h2><p>{item.description}</p><div className="mih-shop-price">{money(item.amountMinor)}<small> / {item.months} 个月</small></div>
          <ul><li>订阅期内最多调用 {item.quota.toLocaleString()} 次</li><li>IP 归属地与分类风险标签</li><li>单个查询、批量查询与受保护接口文档</li><li>到期或达到年度上限后停止服务</li></ul>
          <div className="mih-shop-actions"><button className={primary} onClick={()=>{purchaseKey.current=null;setSelected(item)}}>查看与购买<ArrowRight size={17}/></button>{session.kind==='admin-token'?<button className={secondary} onClick={()=>setEditing(item)}>编辑商品</button>:null}</div>
        </article>)}</div>{!data.catalog.items.length?<p>暂无已上架商品。</p>:null}
        <section className="mih-shop-how"><h3>从购买到使用</h3><ol><li>确认商品与受益账户</li><li>在支付宝完成付款</li><li>自动开通，进入数据产品使用</li></ol><p>付款与开通分开显示。遇到待处理状态，查询原订单即可，无需重复付款。</p></section></>:null}
      {tab==='purchases'?<><div className="qp-panel mih-shop-toolbar"><DropdownField label="受益账户" value={tenantId} options={tenants.map(t=>({value:t.id,label:t.name}))} onChange={value=>setQuery({tenantId:value})}/><button className={secondary} disabled={busy||!tenantId} onClick={()=>perform(async()=>{await refresh();await onSessionChanged?.()})}>刷新购买与权益</button></div>
        {!tenantId?<section className="qp-panel mih-shop-card"><h2>先准备受益账户</h2><p>个人与团队账户分别管理订阅和调用次数。</p><a className={primary} href="#/payments">开通个人账户</a></section>:null}
        <div className="mih-shop-grid">{sortedSubscriptions.map(s=>{
          const future=new Date(s.startsAt)>new Date(),expired=new Date(s.endsAt)<=new Date(),remaining=s.quota-s.used-s.held
          return <section className="qp-panel mih-shop-card" key={s.id}><span className="qp-tag">{future?'待生效':expired?'已到期':remaining?'使用中':'已达调用上限'}</span><h3>IP 风险画像 · 百度 v2</h3><div className="mih-shop-price">{s.used.toLocaleString()}<small> / {s.quota.toLocaleString()} 次</small></div><p>本期已调用{!future&&!expired?` · 有效期还剩 ${daysLeft(s.endsAt)} 天`:future?' · 新周期尚未开始':' · 本期已结束'}</p>{s.held?<small>{s.held.toLocaleString()} 次请求正在处理或核对中</small>:null}<progress max={s.quota} value={s.used+s.held} aria-label="本期调用次数"/><p>{stamp(s.startsAt)} — {stamp(s.endsAt)}</p><small>调用者 {s.consumerId}</small><div className="mih-shop-actions"><a className={primary} href="#/data-products/ip-risk">进入风险画像</a><button className={secondary} onClick={()=>setTab('store')}>续订</button></div></section>
        })}</div>
        <section className="qp-panel mih-shop-card"><h2>购买订单</h2><p>最近 100 笔；测试订单不会开通正式服务。订单创建后保留原商品价格。</p><div className="qp-table-wrap"><table className="qp-table"><thead><tr><th>商品 / 订单</th><th>金额</th><th>交付状态</th><th>操作</th></tr></thead><tbody>{purchases.orders.map(o=><tr key={o.id}><td><strong>{o.product.name}</strong><small className="mih-shop-id">{o.id}</small><small>{stamp(o.createdAt)} · {o.environment==='test'?'测试':'正式'}</small></td><td>{money(o.product.amountMinor)}</td><td>{status[o.status]}</td><td><div className="mih-shop-actions">{!o.deliveredAt?<><button className={secondary} disabled={busy} onClick={()=>action(o,'refresh')}>查询原订单</button>{o.paymentStatus!=='paid'?<button className={primary} disabled={busy} onClick={()=>action(o,'checkout')}>准备支付宝收银台</button>:null}</>:<a className={secondary} href="#/data-products/ip-risk">查看产品</a>}{checkout?.id===o.id&&!o.deliveredAt?<a className={primary} href={checkout.url}>打开支付宝收银台 ↗</a>:null}</div></td></tr>)}</tbody></table></div>{!purchases.orders.length?<p>当前账户尚无购买订单。</p>:null}</section>
      </>:null}
    </>}
    {selected?<Modal title={`购买 ${selected.name}`} onClose={busy?undefined:()=>setSelected(null)} closeOnBackdrop={!busy} closeOnEscape={!busy} footer={<button className={primary} disabled={busy||!canBuy||!consumerId||!data.catalog.purchaseAvailable||selected.status!=='published'} onClick={purchase}>{busy?'正在创建原订单…':`确认购买 · ${money(selected.amountMinor)}`}</button>}>
      <p>{selected.description}</p><p><strong>{money(selected.amountMinor)} / {selected.months} 个月 · 期内最多调用 {selected.quota.toLocaleString()} 次</strong></p>
      <DropdownField label="受益账户" value={tenantId} options={tenants.map(t=>({value:t.id,label:t.name}))} onChange={value=>setQuery({tenantId:value})}/>
      <DropdownField label="共享本订阅的调用者" value={consumerId} options={consumers.map(c=>({value:c.id,label:c.name}))} onChange={setConsumerId}/>
      {session.kind==='admin-token'?<DropdownField label="账务环境" value={environment} options={[{value:'live',label:'正式付款'},{value:'test',label:'测试 · 不授予正式权益'}]} onChange={setEnvironment}/>:null}
      {!tenantId?<p><a href="#/payments">先开通个人账户</a>，或由企业管理员添加成员。</p>:!consumers.length?<p><a href="#/consumers">先创建调用者</a>，再选择受益对象。</p>:null}
      {!canBuy?<p>购买并开通权限需要该账户的 owner/admin；账务成员可以查看和支付已有订单。</p>:null}
      {!data.catalog.purchaseAvailable?<p role="status">当前购买渠道未就绪，商品可查看，暂不能创建购买。</p>:null}
      <p>付款确认后自动开通，所选调用者的有效 Keys 共用订阅。已有同渠道有效订阅时，新周期从原到期日顺延。</p><p>本期成功调用（含有效无数据）计入年度上限。到期或达到上限后停止服务，续订需主动购买。暂不支持赠送或自动续费。</p>
      {currentSubscriptions.some(s=>s.consumerId===consumerId)?<p className="mih-inline-warning">此调用者已有有效订阅。本次将延长一年服务期，下一周期的调用次数从新周期开始统计。</p>:null}
    </Modal>:null}
    {editing?<ProductEditor item={editing} token={token} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);state.refresh()}}/>:null}
  </div>
}

function ProductEditor({item,token,onClose,onSaved}){
  const [form,setForm]=useState({...item}),[price,setPrice]=useState(String(item.amountMinor/100)),[busy,setBusy]=useState(false),[error,setError]=useState(null)
  const update=(key,value)=>setForm(f=>({...f,[key]:value}))
  async function save(e){e.preventDefault();if(busy)return;setBusy(true);setError(null);try{const {name,description,status,months,quota,revision}=form;await adminApi.commerceSaveProduct(token,form.sku,{name,description,status,amountMinor:Math.round(Number(price)*100),months:Number(months),quota:Number(quota),revision});onSaved()}catch(e){setError(e)}finally{setBusy(false)}}
  return <Modal title={item.revision?'编辑商品':'创建 IP 数据商品'} onClose={busy?undefined:onClose} closeOnBackdrop={!busy} closeOnEscape={!busy}>
    <form onSubmit={save} className="mih-shop-editor">{error?<ErrorState error={error}/>:null}
      <Field label="商品标识"><input className="qp-input" value={form.sku} disabled={!!item.revision||busy} onChange={e=>update('sku',e.target.value)} required/></Field>
      <Field label="商品名称"><input className="qp-input" value={form.name} onChange={e=>update('name',e.target.value)} required/></Field>
      <Field label="商品介绍"><textarea className="qp-input" value={form.description} onChange={e=>update('description',e.target.value)}/></Field>
      <Field label="售价（元）"><input className="qp-input" type="number" min="1" step="0.01" value={price} onChange={e=>setPrice(e.target.value)} required/></Field>
      <div className="mih-shop-grid">{[['months','有效月数'],['quota','成功交付次数']].map(([key,label])=><Field key={key} label={label}><input className="qp-input" type="number" min="1" step="1" value={form[key]} onChange={e=>update(key,e.target.value)} required/></Field>)}</div>
      <DropdownField label="销售状态" value={form.status} options={Object.entries(productStatus).map(([value,label])=>({value,label}))} onChange={value=>update('status',value)}/>
      <p>此期支持百度 v2 定期订阅商品。保存新价格不修改已有订单；下架不撤销已购权益。</p><button className={primary} disabled={busy}>{busy?'保存中…':'保存商品'}</button>
    </form>
  </Modal>
}
