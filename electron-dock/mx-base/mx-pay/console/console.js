const $ = id => document.getElementById(id)
const node = (tag,text,cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e }
const message = text => { $('message').textContent=text }
const labels={administrator:'支付管理员',channel_manager:'渠道管理员',auditor:'审计查看员',finance_viewer:'财务查看员',viewer:'应用查看员'}
const providerName=value=>({alipay:'支付宝收银台',manual_alipay:'支付宝人工扫码',mock:'测试模拟'}[value] || value)
const statuses={pending:'待付款',submitted:'待核实',paid:'已确认付款',cancelled:'已取消'}
const money = amount => new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(Number(amount || 0)/100)
const when = value => value ? new Date(value).toLocaleString('zh-CN') : '—'
let csrf=null,me=null,current='orders',page=1,busy=false,editSubmit=null
const filters={appId:'',environment:'live',status:'',businessOrderId:'',customerRef:'',channelId:''}
const modules=[
 ['orders','支付订单','orders.read','按来源应用、业务订单、客户和渠道查询。付款确认与业务交付分别显示。'],
 ['customers','客户收款','customers.read','客户引用由来源应用提供；相同引用在不同应用中保持隔离。'],
 ['finance','财务概览','finance.read','按应用、环境和渠道汇总收款事实。此处不代表钱包余额；对账结算、退款和会计功能尚未开放。'],
 ['channels','支付渠道','channels.read','管理支付宝电脑网站支付。先保存草稿，校验后发布；停用仍保留历史订单验签与查单。'],
 ['applications','应用接入','applications.read','各业务应用使用独立的服务端凭据与渠道白名单，测试和正式环境分别授权。'],
 ['members','成员与邀请','members.read','Launcher 的用户角色管理中心授权；这里管理支付本地授权与应用范围。两种授权分别撤销。'],
 ['logs','交付日志','logs.read','查看付款事件及业务应用 ACK。未 ACK 的订单需检查业务应用入账与交付任务。'],
 ['observations','渠道记录','logs.read','查看通知与主动查单结果，包括未匹配订单和待核查异常。'],
 ['audit','管理审计','logs.read','追踪渠道发布、成员授权、邀请和凭据变更。日志不包含渠道密钥或凭据明文。'],
]
const allowed = (permission,center=false) => me?.grants.some(g=>(!center || g.scope==='center') && me.permissions.roles[g.role]?.includes(permission))
async function api(path,method='GET',body) {
 const response=await fetch(path,{method,credentials:'same-origin',redirect:'error',headers:method==='GET'?{}:{'content-type':'application/json','x-mx-csrf':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})})
 if(response.status===204)return null
 const result=await response.json()
 if(!response.ok)throw Error(result.error?.message || '请求失败，请稍后再试')
 return result.data ?? result
}
const call=(path,method,body)=>api(`/console/v1/${path}`,method,body)
function button(text,action,cls) { const e=node('button',text,cls); e.type='button';e.addEventListener('click',()=>void action());return e }
function table(headers,rows) {
 const wrap=node('div',undefined,'table-scroll'), t=node('table'),head=node('thead'),tr=node('tr'),body=node('tbody')
 for(const h of headers)tr.append(node('th',h));head.append(tr);t.append(head,body)
 for(const values of rows){const row=node('tr');for(const v of values){const cell=node('td');cell.append(v instanceof Node?v:node('span',v ?? '—'));row.append(cell)}body.append(row)}
 if(!rows.length){const row=node('tr'),cell=node('td','暂无符合条件的记录','empty');cell.colSpan=headers.length;row.append(cell);body.append(row)}
 wrap.append(t);return wrap
}
function field(label,name,value='',options={}) {
 const wrap=node('label',label),input=node(options.choices?'select':options.multiline?'textarea':'input');input.name=name;input.id=`field-${name}`
 if(options.choices)for(const [v,l] of options.choices){const o=node('option',l);o.value=v;input.append(o)}
 else { if(input.tagName==='INPUT')input.type=options.secret?'password':'text';input.autocomplete='off';input.maxLength=options.multiline?10000:1000 }
 input.value=options.choices && !options.choices.some(([v])=>v===value) ? (options.choices[0]?.[0] || '') : value;input.required=!!options.required;input.disabled=!!options.disabled
 wrap.append(input);if(options.hint)wrap.append(node('small',options.hint));return wrap
}
function editor(title,hint,fields,submit) {
 $('edit-title').textContent=title;$('edit-hint').textContent=hint;$('edit-error').textContent='';$('edit-fields').replaceChildren(...fields)
 $('save-editor').hidden=!submit;$('save-editor').disabled=false;editSubmit=submit;$('editor').showModal()
}
$('close-editor').onclick=()=>$('editor').close()
$('editor').addEventListener('close',()=>{
 // A queued close event may belong to the form replaced by the one-time result.
 if(!$('editor').open){$('edit-fields').replaceChildren();editSubmit=null}
})
$('edit-form').onsubmit=async e=>{
 e.preventDefault();if(!editSubmit)return;$('save-editor').disabled=true;$('edit-error').textContent=''
 try { const after=await editSubmit(new FormData(e.currentTarget));$('editor').close();await load();if(after)after() }
 catch(error){$('edit-error').textContent=error.message}finally{$('save-editor').disabled=false}
}
function reveal(title,text) {
 const output=node('textarea');output.value=text;output.readOnly=true;output.rows=9;output.setAttribute('aria-label',title)
 editor(title,'请立即保存到应用的私有配置。关闭后不会再次展示。',[output],null)
 // Nothing is placed in localStorage, URLs, audit events or console logs.
}
function roleFields() { return [field('角色','role','viewer',{choices:Object.entries(labels)}),field('授权范围','scope','application',{choices:[['application','指定应用与环境'],['center','整个支付中心']]}),field('来源应用 ID','appId','mx-insight-hub'),field('环境','environment','live',{choices:[['live','正式'],['test','测试']]})] }
function grant(form) {return {role:form.get('role'),scope:form.get('scope'),...(form.get('scope')==='application'?{appId:form.get('appId').trim(),environment:form.get('environment')}:{})}}
const grantText = g => `${labels[g.role]} · ${g.scope==='center'?'整个中心':`${g.appId} / ${g.environment==='live'?'正式':'测试'}`}`
function filterBar() {
 const form=node('form');form.id='filters'
 for(const [key,label] of [['appId','来源应用'],['environment','环境'],['status','付款状态'],['businessOrderId','业务订单号'],['customerRef','客户引用'],['channelId','渠道 ID']]){
  if(current!=='orders' && ['status','businessOrderId','channelId'].includes(key))continue
  const options=key==='environment'?{choices:[['live','正式'],['test','测试'],['','全部授权环境']]}:key==='status'?{choices:[['','全部状态'],...Object.entries(statuses)]}:{}
  const f=field(label,key,filters[key],options);f.querySelector('input,select').onchange=e=>{filters[key]=e.target.value.trim()};form.append(f)
 }
 const submit=node('button','查询','primary');submit.type='submit';form.append(submit)
 form.onsubmit=e=>{e.preventDefault();for(const [k,v] of new FormData(form))filters[k]=v.trim();page=1;void load()};return form
}
async function orderDetails(order) {
 try {const data=await call(`orders/${order.id}`),pre=node('pre',JSON.stringify(data,null,2));editor(`订单 ${order.businessOrderId}`,'包含支付状态、不可变业务引用、渠道核验及事件 ACK；不提供人工改付成功。',[pre],null)}catch(e){message(e.message)}
}
function channelEditor(ch={id:'',provider:'alipay',environment:'live',enabled:false,appId:'',sellerId:'',allowedApps:['mx-insight-hub'],keyType:'PKCS8',notifyUrl:'https://pay.minsight-ai.com/v1/notifications/alipay/',returnUrl:'https://hub.minsight-ai.com/admin/',revision:0}) {
 const fields=[field('渠道 ID','id',ch.id,{required:true,disabled:!!ch.revision}),field('环境','environment',ch.environment,{choices:[['live','正式'],['test','支付宝沙箱']]}),
 field('启用新订单','enabled',String(ch.enabled),{choices:[['false','停用'],['true','启用']]}),field('支付宝 APPID','appId',ch.appId),field('到账核验 Seller ID（2088 开头）','sellerId',ch.sellerId),
 field('允许的来源应用（逗号分隔）','allowedApps',ch.allowedApps.join(',')),field('私钥格式','keyType',ch.keyType,{choices:[['PKCS8','PKCS8'],['PKCS1','PKCS1']]}),
 field(ch.privateKeyConfigured?'应用私钥（已保存，留空保留）':'应用私钥（PEM）','privateKey','',{multiline:true}),field(ch.alipayPublicKeyConfigured?'支付宝公钥（已保存，留空保留）':'支付宝公钥（PEM）','alipayPublicKey','',{multiline:true}),
 field('通知地址','notifyUrl',ch.notifyUrl),field('付款后返回地址','returnUrl',ch.returnUrl)]
 editor(ch.revision?`编辑渠道 · ${ch.id}`:'新增支付宝渠道','下单不传 seller_id，由签约商户收款；此处 Seller ID 用于到账核验，发布前仍需填写。密钥留空保留已存值，草稿保存后需另行发布。',fields,async f=>{
  const id=ch.id || f.get('id').trim(), channel={id,provider:'alipay',environment:f.get('environment'),enabled:f.get('enabled')==='true',appId:f.get('appId').trim(),sellerId:f.get('sellerId').trim(),allowedApps:f.get('allowedApps').split(',').map(s=>s.trim()).filter(Boolean),keyType:f.get('keyType'),privateKey:f.get('privateKey').trim(),alipayPublicKey:f.get('alipayPublicKey').trim(),notifyUrl:f.get('notifyUrl').trim(),returnUrl:f.get('returnUrl').trim()}
  await call(`channels/${encodeURIComponent(id)}`,'PUT',{revision:ch.revision,channel})
 })
}
async function load() {
 if(busy)return;busy=true;message('正在加载…');$('actions').replaceChildren();$('content').replaceChildren();$('pagination').hidden=true
 try {
  me=await call('me');buildNavigation()
  if(!$('modules').children.length){$('workspace').hidden=true;message(`当前账号已无支付权限。用户 ID：${me.subject}`);return}
  if(![...$('modules').children].some(b=>b.dataset.module===current))current=$('modules').firstChild.dataset.module
  const mod=modules.find(m=>m[0]===current);$('title').textContent=mod[1];$('intro').textContent=mod[3];$('category').textContent=`MX PAY / ${current.toUpperCase()}`
  for(const b of $('modules').children)b.classList.toggle('selected',b.dataset.module===current)
  const q=new URLSearchParams({page:String(page)})
  if(['orders','customers','finance','logs'].includes(current)){
   $('actions').append(filterBar());for(const [k,v] of Object.entries(filters))if(v && (current==='orders' || ['appId','environment','customerRef'].includes(k)))q.set(k,v)
  }
  const data=await call(`${current}?${q}`),content=$('content'),actions=$('actions')
  if(current==='orders') content.append(table(['业务订单 / 支付单','来源应用','客户 / 商品','金额','状态','渠道','创建时间'],data.items.map(o=>[button(o.businessOrderId,()=>orderDetails(o)),`${o.appId} / ${o.environment}`,`${o.customerRef || '—'} / ${o.subject || '未提供商品描述'}`,money(o.amountMinor),statuses[o.status],o.channelId || providerName(o.provider),when(o.createdAt)])))
  if(current==='customers')content.append(table(['来源应用','环境','客户引用','订单数','已确认付款','最近订单'],data.items.map(o=>[o.appId,o.environment,o.customerRef,o.orders,money(o.paidMinor),when(o.lastOrderAt)])))
  if(current==='finance')content.append(table(['来源应用','环境','渠道','状态','订单数','合计金额'],data.items.map(o=>[o.appId,o.environment,providerName(o.provider),statuses[o.status],o.orders,money(o.amountMinor)])))
  if(current==='logs')content.append(table(['业务订单','来源应用','环境','支付单','事件时间','业务应用 ACK'],data.items.map(o=>[o.businessOrderId,o.appId,o.environment,o.orderId,when(o.createdAt),o.acknowledgedAt?when(o.acknowledgedAt):'等待业务应用确认'])))
  if(current==='observations')content.append(table(['渠道','来源应用 / 环境','支付单','结果','原因','时间'],data.items.map(o=>[o.channel_id,`${o.app_id || '未匹配'} / ${o.environment}`,o.order_id,o.outcome,o.reason,when(o.created_at)])))
  if(current==='audit')content.append(table(['操作','操作者','目标','变更摘要','时间'],data.items.map(o=>[o.action,o.actor.subject || o.actor.credentialId,o.target,JSON.stringify(o.details),when(o.created_at)])))
  if(current==='channels'){
   if(allowed('channels.write',true))actions.append(button('新增渠道',()=>channelEditor(),'primary'))
   content.append(table(['渠道 / 环境','商户身份','发布状态','草稿 / 密钥','允许应用','操作'],data.items.map(ch=>{
    const controls=node('div',undefined,'row-actions')
    if(allowed('channels.write',true)){
     controls.append(button('编辑草稿',()=>channelEditor(ch)))
     const publish=button('发布草稿',()=>editor(`发布渠道 · ${ch.id}`,`发布后：${ch.enabled?'允许创建新订单':'停用新订单'}。已有订单继续验签。`,[node('p',`范围：${ch.allowedApps.join(', ')} · ${ch.environment}`)],async()=>{await call(`channels/${ch.id}/publish`,'POST',{revision:ch.revision})}),'primary')
     publish.disabled=!ch.valid || !ch.pendingChanges;controls.append(publish)
    }
    return [`${ch.id} / ${ch.environment}`,`${ch.appId || 'APPID 待填'} / ${ch.sellerId || '商户 ID 待填'}`,ch.published?(ch.publishedEnabled?'已启用':'已停用'):'未发布',`${ch.valid?'校验通过':'待补齐配置'} · 私钥${ch.privateKeyConfigured?'已保存':'未配置'}`,ch.allowedApps.join(', '),controls]
   })))
  }
  if(current==='applications'){
   if(allowed('applications.write',true)){
    actions.append(button('登记应用',()=>editor('登记来源应用','应用 ID 用于支付凭据、渠道白名单和订单来源归属。',[field('应用 ID','id','',{required:true}),field('显示名称','name','',{required:true})],async f=>{await call('applications','POST',Object.fromEntries(f))}),'primary'))
    actions.append(button('签发接入凭据',()=>editor('签发服务端凭据','只在签发后显示一次。轮换时先部署新凭据并验证，再撤销旧凭据。',[field('来源应用','appId','',{choices:data.items.map(a=>[a.id,a.name])}),field('环境','environment','test',{choices:[['test','测试'],['live','正式']]}),field('用途','purpose','payments',{choices:[['payments','下单与付款事件'],['reporting','只读支付报表'],['launcher-permissions','Launcher 权限汇总（只读）']]})],async f=>{const v=await call('credentials','POST',Object.fromEntries(f));return()=>reveal('接入凭据 · 仅显示一次',JSON.stringify(v,null,2))})))
   }
   content.append(table(['应用 ID','名称'],data.items.map(a=>[a.id,a.name])))
   content.append(node('h2','服务端凭据'),table(['凭据 ID','应用 / 环境','权限','状态','操作'],data.credentials.map(c=>[c.id,`${c.appId} / ${c.environment}`,c.scopes.join(', '),c.revoked?'已撤销':'有效',!c.revoked && allowed('applications.write',true)?button('撤销',()=>editor('撤销接入凭据','立即停止该凭据访问，可能影响业务应用。',[node('p',c.id)],async()=>{await call(`credentials/${c.id}/revoke`,'POST',{})})): '—'])))
  }
  if(current==='members'){
   content.append(node('p',`Launcher 授权：${me.launcherGrants?.map(grantText).join('；') || '无'}。以下列表为本地授权；Launcher 角色请回用户中心修改。`,'muted'))
   if(allowed('members.write',true)){
    actions.append(button('按用户 ID 授权',()=>editor('添加支付授权','先在 Launcher 创建账号，再填写不可变 userId。账号名称不作为授权依据。',[field('用户 ID','subject','',{required:true}),...roleFields()],async f=>{await call('members','POST',{subject:f.get('subject').trim(),grants:[grant(f)]})}),'primary'))
    actions.append(button('创建访问邀请',()=>editor('创建支付访问邀请','有效期 48 小时，只能接受一次。需先完成 Launcher 邀请注册；支付邀请不授予中心管理员。',roleFields(),async f=>{const inv=await call('invitations','POST',{grants:[grant(f)]});return()=>reveal('支付访问邀请 · 请自行发送',`${location.origin}/#invite=${inv.token}`)})))
   }
   content.append(table(['用户 ID','当前支付授权','版本','操作'],data.items.map(m=>[m.identity.subject,m.grants.map(grantText).join('；') || '未授权',m.revision,allowed('members.write',true)?button('管理授权',()=>{
    const list=node('div');for(let i=0;i<m.grants.length;i++)list.append(node('p',grantText(m.grants[i])),button('移除此授权',async()=>{
     try{await call(`members/${m.id}`,'PUT',{revision:m.revision,grants:m.grants.filter((_,j)=>j!==i)});$('editor').close();await load()}catch(e){$('edit-error').textContent=e.message}
    }))
    editor('管理支付授权','添加角色会保留已有角色；移除操作立即生效。',[list,...roleFields()],async f=>{await call(`members/${m.id}`,'PUT',{revision:m.revision,grants:[...m.grants,grant(f)]})})}) : '—'])))
   const invites=await call('invitations')
   content.append(node('h2','访问邀请'),table(['邀请 ID','授予范围','有效期','状态','操作'],invites.items.map(i=>[i.id,i.grants.map(grantText).join('；'),when(i.expires_at),i.revoked?'已撤销':i.used_by?'已接受':new Date(i.expires_at)<new Date()?'已过期':'待接受',allowed('members.write',true) && !i.revoked && !i.used_by?button('撤销',async()=>{try{await call(`invitations/${i.id}/revoke`,'POST',{});await load()}catch(e){message(e.message)}}):'—'])))
  }
  if('hasMore' in data){$('pagination').hidden=false;$('page').textContent=`第 ${page} 页`;$('previous').disabled=page<=1;$('next').disabled=!data.hasMore}
  message(data.items?.length?`已加载 ${data.items.length} 条记录`:'当前没有记录，可调整筛选条件或完成首次配置。')
 }catch(e){message(e.message)}finally{busy=false}
}
function buildNavigation(){
 $('modules').replaceChildren()
 for(const [id,label,permission] of modules)if(allowed(permission,['observations','audit'].includes(id))){const b=button(label,()=>{if(busy)return;current=id;page=1;void load()});b.dataset.module=id;$('modules').append(b)}
 $('navigation').hidden=!$('modules').children.length
}
async function initialize(){
 try{
  const session=await api('/auth/sso/session')
  if(!session.active){message('请使用 Launcher 统一账号登录。注册成功后仍需支付角色授权。');return}
  csrf=session.csrf;$('login').hidden=true;$('switch').hidden=false;$('logout').hidden=false;$('security').href=session.securityUrl;$('security').hidden=false
  me=await call('me');$('account').textContent=me.displayName
  if(!me.permissions){message('管理 API 尚未升级，请先部署当前 mx-pay 版本。');return}
  $('invitation').hidden=!sessionStorage.getItem('mx-pay-invitation')
  if(!me.grants.length){message(`尚未获得支付权限。当前用户 ID：${me.subject}。请由管理员授权，或接受支付访问邀请。`);return}
  buildNavigation();current=$('modules').firstChild.dataset.module;$('workspace').hidden=false;await load()
 }catch(e){message(e.message)}
}
function captureInvitation(){
 const invitation=/^#invite=([A-Za-z0-9_-]{43})$/.exec(location.hash)
 if(invitation){sessionStorage.setItem('mx-pay-invitation',invitation[1]);history.replaceState(null,'',location.pathname);$('invitation').hidden=!csrf}
}
window.addEventListener('hashchange',captureInvitation);captureInvitation()
$('accept-invitation').onclick=async()=>{try{await call('invitations/accept','POST',{token:sessionStorage.getItem('mx-pay-invitation')});sessionStorage.removeItem('mx-pay-invitation');await initialize()}catch(e){message(e.message)}}
$('discard-invitation').onclick=()=>{sessionStorage.removeItem('mx-pay-invitation');$('invitation').hidden=true}
$('previous').onclick=()=>{if(!busy && page>1){page--;void load()}};$('next').onclick=()=>{if(!busy){page++;void load()}}
$('logout').onclick=async()=>{try{await api('/auth/sso/logout','POST',{});location.assign('/')}catch(e){message(e.message)}}
void initialize()
