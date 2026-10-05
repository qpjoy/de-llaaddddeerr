const $ = id => document.getElementById(id)
const node = (tag,text,cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e }
const message = text => { $('message').textContent=text }
const labels={administrator:'支付管理员',channel_manager:'渠道管理员',auditor:'审计查看员',finance_viewer:'财务查看员',viewer:'应用查看员'}
const providerName=value=>({alipay:'支付宝收银台',manual_alipay:'支付宝人工扫码',mock:'测试模拟'}[value] || value)
const statuses={pending:'待付款',submitted:'待核实',paid:'已确认付款',cancelled:'已取消'}
const money = amount => new Intl.NumberFormat('zh-CN',{style:'currency',currency:'CNY'}).format(Number(amount || 0)/100)
const when = value => value ? new Date(value).toLocaleString('zh-CN') : '—'
let csrf=null,me=null,current='orders',page=1,busy=false,editSubmit=null,editBusy=false,editInvoker=null
const selects=installNeonSelects(document)
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
 const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',redirect:'error',headers:method==='GET'?{}:{'content-type':'application/json','x-mx-csrf':csrf},...(body===undefined?{}:{body:JSON.stringify(body)})})
 if(response.status===204)return null
 const result=await response.json()
 if(!response.ok)throw Error(result.error?.message || '请求失败，请稍后再试')
 return result.data ?? result
}
const call=(path,method,body)=>api(`/console/v1/${path}`,method,body)
function button(text,action,cls) { const e=node('button',text,`qp-button ${cls==='primary'?'qp-button--primary':cls==='ghost'?'qp-button--ghost':'qp-button--outline'}`); e.type='button';e.addEventListener('click',()=>void action());return e }
function table(headers,rows) {
 const wrap=node('div',undefined,'table-scroll'), t=node('table'),head=node('thead'),tr=node('tr'),body=node('tbody')
 for(const h of headers)tr.append(node('th',h));head.append(tr);t.append(head,body)
 for(const values of rows){const row=node('tr');for(const v of values){const cell=node('td');cell.append(v instanceof Node?v:node('span',v ?? '—'));row.append(cell)}body.append(row)}
 if(!rows.length){const row=node('tr'),cell=node('td','暂无符合条件的记录','empty');cell.colSpan=headers.length;row.append(cell);body.append(row)}
 wrap.append(t);return wrap
}
function field(label,name,value='',options={}) {
 const wrap=node('label',undefined,'qp-field'),input=node(options.choices?'select':options.multiline?'textarea':'input',undefined,options.choices?'qp-select':options.multiline?'qp-textarea':'qp-input');wrap.dataset.field=name;wrap.append(node('span',label,'qp-field__label'));input.name=name;input.id=`field-${name}`
 if(options.choices)for(const [v,l] of options.choices){const o=node('option',l);o.value=v;input.append(o)}
 else { if(input.tagName==='INPUT')input.type=options.secret?'password':'text';input.autocomplete='off';input.maxLength=options.multiline?10000:1000 }
 input.value=options.choices && !options.choices.some(([v])=>v===value) ? (options.choices[0]?.[0] || '') : value;input.required=!!options.required;input.disabled=!!options.disabled
 if(options.placeholder)input.placeholder=options.placeholder
 wrap.append(input);if(options.hint){const hint=node('small',options.hint,'qp-field__hint');hint.id=`hint-${name}`;input.setAttribute('aria-describedby',hint.id);wrap.append(hint)}return wrap
}
function editor(title,hint,fields,submit,saveLabel='保存') {
 if(!$('editor').open)editInvoker=document.activeElement
 $('edit-title').textContent=title;$('edit-hint').textContent=hint;$('edit-error').textContent='';$('edit-validation').hidden=true;$('edit-validation').replaceChildren();$('edit-fields').replaceChildren(...fields)
 $('save-editor').textContent=saveLabel;$('save-editor').hidden=!submit;$('save-editor').disabled=false;editSubmit=submit
 if(!$('editor').open)$('editor').showModal()
 selects.refresh()
}
$('close-editor').onclick=()=>{if(!editBusy)$('editor').close()}
$('editor').addEventListener('cancel',e=>{if(editBusy)e.preventDefault()})
$('editor').addEventListener('close',()=>{
 // A queued close event may belong to the form replaced by the one-time result.
 if(!$('editor').open){$('edit-fields').replaceChildren();editSubmit=null;(editInvoker?.isConnected?editInvoker:$('title')).focus({preventScroll:true})}
})
$('edit-form').onsubmit=async e=>{
 e.preventDefault();if(!editSubmit || editBusy)return;editBusy=true;$('save-editor').disabled=true;$('close-editor').disabled=true;$('editor').setAttribute('aria-busy','true');$('edit-error').textContent=''
 try {
  const after=await editSubmit(new FormData(e.currentTarget))
  if(after?.keepOpen){await load();after.refresh();$('editor').querySelector('.qp-modal__body').scrollTop=0}
  else{$('editor').close();await load();if(after)after()}
 }
 catch(error){$('edit-error').textContent=error.message;$('edit-error').scrollIntoView({block:'nearest'})}
 finally{editBusy=false;$('save-editor').disabled=false;$('close-editor').disabled=false;$('editor').removeAttribute('aria-busy')}
}
function reveal(title,text) {
 const output=node('textarea',undefined,'qp-textarea');output.value=text;output.readOnly=true;output.rows=9;output.setAttribute('aria-label',title)
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
 const submit=node('button','查询','qp-button qp-button--primary');submit.type='submit';form.append(submit)
 form.onsubmit=e=>{e.preventDefault();for(const [k,v] of new FormData(form))filters[k]=v.trim();page=1;void load()};return form
}
async function orderDetails(order) {
 try {const data=await call(`orders/${order.id}`),pre=node('pre',JSON.stringify(data,null,2));editor(`订单 ${order.businessOrderId}`,'包含支付状态、不可变业务引用、渠道核验及事件 ACK；不提供人工改付成功。',[pre],null)}catch(e){message(e.message)}
}
function channelIssues(ch){
 return ch.validationIssues || (ch.valid?[]:[{field:'channel',message:'请检查 APPID、商户 ID、密钥格式与完整通知地址；更新服务后可查看逐项原因。'}])
}
function validationPanel(ch,focusFields=false){
 const issues=channelIssues(ch),panel=node('div',undefined,`validation-summary${issues.length?'':' validation-ok'}`)
 panel.append(node('strong',issues.length?`待修正 ${issues.length} 项，暂不能发布`:'配置校验通过'))
 if(issues.length){
  const list=node('ul')
  for(const issue of issues){const li=node('li');li.append(focusFields?button(issue.message,()=>document.getElementById(`field-${issue.field}`)?.focus(),'ghost'):node('span',issue.message));list.append(li)}
  panel.append(list)
 }else panel.append(node('span','已通过配置格式校验；实际收款仍需验证支付宝签约与支付回调。'))
 return panel
}
function channelEditor(ch={id:'',provider:'alipay',environment:'live',enabled:false,appId:'',sellerId:'',allowedApps:['mx-insight-hub'],keyType:'PKCS8',notifyUrl:new URL('/v1/notifications/alipay/',location.origin).href,returnUrl:'https://hub.minsight-ai.com/admin/',revision:0},saved=false){
 const section=text=>node('h3',text,'form-section')
 const idField=field('渠道 ID','id',ch.id,{required:true,disabled:!!ch.revision,placeholder:'例如 alipay-live',hint:'Pay 内部唯一名称；Hub 的渠道绑定使用同一个 ID。'})
 const notifyField=field('支付宝通知地址','notifyUrl',ch.notifyUrl,{hint:'按渠道 ID 自动补全路径；自定义域名可直接修改。'})
 const idInput=idField.querySelector('input'),notifyInput=notifyField.querySelector('input')
 const notificationUrl=id=>{try{return new URL(`/v1/notifications/alipay/${id}`,notifyInput.value || location.origin).href}catch{return new URL(`/v1/notifications/alipay/${id}`,location.origin).href}}
 let previousAuto=ch.notifyUrl
 try{if(new URL(ch.notifyUrl).pathname==='/v1/notifications/alipay/' && ch.id)notifyInput.value=previousAuto=notificationUrl(ch.id)}catch{}
 idInput.addEventListener('input',()=>{
  if(!notifyInput.value || notifyInput.value===previousAuto){notifyInput.value=previousAuto=notificationUrl(idInput.value.trim())}
 })
 const switchField=node('div',undefined,'switch-field wide'),switchLabel=node('label',undefined,'qp-switch'),enabled=node('input')
 enabled.type='checkbox';enabled.name='enabled';enabled.checked=ch.enabled;enabled.id='field-enabled'
 switchLabel.append(enabled,node('span',undefined,'qp-switch__track'),node('span','发布后接收新订单'))
 switchField.append(switchLabel,node('p','保存仅更新草稿。校验通过并发布后，才会按此开关接收或停用新订单。'))
 const fields=[section('基本信息'),idField,field('环境','environment',ch.environment,{choices:[['live','正式'],['test','支付宝沙箱']]}),
 field('支付宝 APPID','appId',ch.appId,{placeholder:'支付宝应用的 16 位 APPID'}),field('到账核验 Seller ID','sellerId',ch.sellerId,{placeholder:'2088 开头的 16 位商户 ID'}),
 field('允许的来源应用','allowedApps',ch.allowedApps.join(','),{hint:'多个应用用逗号分隔，例如 mx-insight-hub,luopan。'}),field('私钥格式','keyType',ch.keyType,{choices:[['PKCS8','PKCS8 · Java 常用'],['PKCS1','PKCS1 · RSA 私钥']]}),
 section('支付密钥'),field(ch.privateKeyConfigured?'应用私钥（已保存）':'应用私钥','privateKey','',{multiline:true,placeholder:'-----BEGIN PRIVATE KEY-----',hint:ch.privateKeyConfigured?'留空保留已有密钥；原文不会回显。':'粘贴完整 PEM，包含 BEGIN / END；不要只粘贴一行 Base64。'}),
 field(ch.alipayPublicKeyConfigured?'支付宝公钥（已保存）':'支付宝公钥','alipayPublicKey','',{multiline:true,placeholder:'-----BEGIN PUBLIC KEY-----',hint:ch.alipayPublicKeyConfigured?'留空保留已有公钥。':'填写支付宝提供的验签公钥，包含 PEM 首尾。'}),
 section('通知与启用'),notifyField,field('付款后返回地址','returnUrl',ch.returnUrl,{hint:'用户支付后返回业务应用，不用于确认到账。'}),switchField]
 editor(ch.revision?`编辑渠道 · ${ch.id}`:'新增支付宝渠道','填写并保存配置，再检查校验结果、发布生效。已保存的密钥不会回显。',fields,async f=>{
  const id=ch.id || f.get('id').trim(),channel={id,provider:'alipay',environment:f.get('environment'),enabled:f.get('enabled')==='on',appId:f.get('appId').trim(),sellerId:f.get('sellerId').trim(),allowedApps:f.get('allowedApps').split(',').map(s=>s.trim()).filter(Boolean),keyType:f.get('keyType'),privateKey:f.get('privateKey').trim(),alipayPublicKey:f.get('alipayPublicKey').trim(),notifyUrl:f.get('notifyUrl').trim(),returnUrl:f.get('returnUrl').trim()}
  const result=await call(`channels/${encodeURIComponent(id)}`,'PUT',{revision:ch.revision,channel})
  if(!result.valid)return {keepOpen:true,refresh:()=>channelEditor(result,true)}
  return ()=>message('草稿已保存并通过校验。请点击“发布并启用”或“发布并停用”，使配置正式生效。')
 },'保存草稿')
 if(ch.revision){
  $('edit-validation').hidden=false
  if(saved)$('edit-validation').append(node('p','草稿已保存，当前线上配置尚未改变。','muted'))
  else $('edit-validation').append(node('p','以下为已保存草稿的校验结果；修改后保存即可重新校验。','muted'))
  $('edit-validation').append(validationPanel(ch,true))
  for(const issue of channelIssues(ch)){
   const input=document.getElementById(`field-${issue.field}`),wrap=input?.closest('.qp-field')
   if(!wrap)continue
   const error=node('span',issue.message,'field-error');error.id=`error-${issue.field}`
   input.setAttribute('aria-invalid','true');input.setAttribute('aria-describedby',`${input.getAttribute('aria-describedby') || ''} ${error.id}`.trim());wrap.append(error)
   input.addEventListener('input',()=>{input.removeAttribute('aria-invalid');error.hidden=true},{once:true})
  }
  selects.refresh()
 }
}
function renderChannels(data,content,actions){
 const canWrite=allowed('channels.write',true)
 if(canWrite)actions.append(button('新增渠道',()=>channelEditor(),'primary'))
 actions.append(node('p','保存草稿 → 检查配置 → 发布生效','channel-workflow'))
 if(!data.items.length){content.append(node('div','尚未配置支付渠道。新增支付宝渠道，保存并发布后即可供业务应用接入。','empty qp-panel'));return}
 const list=node('div',undefined,'channel-list')
 for(const ch of data.items){
  const card=node('article',undefined,'channel-card qp-panel'),header=node('div',undefined,'channel-header'),heading=node('div',undefined,'channel-heading')
  heading.append(node('h2',ch.id),node('span',ch.environment==='live'?'正式':'沙箱','qp-tag'))
  header.append(heading,node('span',ch.published?(ch.publishedEnabled?'已启用':'已停用'):'未发布',`qp-tag ${ch.publishedEnabled?'qp-tag--success':'qp-tag--warning'}`))
  const body=node('div',undefined,'channel-body'),facts=node('dl',undefined,'channel-facts')
  for(const [label,value] of [['APPID',ch.appId || '待填写'],['商户 ID',ch.sellerId || '待填写'],['允许应用',ch.allowedApps.join('，') || '待填写'],['密钥状态',`应用私钥${ch.privateKeyConfigured?'已保存':'未填写'} · 支付宝公钥${ch.alipayPublicKeyConfigured?'已保存':'未填写'}`]])facts.append(node('dt',label),node('dd',value))
  body.append(facts,validationPanel(ch))
  const footer=node('div',undefined,'channel-footer'),controls=node('div',undefined,'row-actions')
  footer.append(node('p',ch.pendingChanges?`有待发布修改 · 发布后${ch.enabled?'接收':'停用'}新订单`:'当前配置已发布，无待发布修改。'))
  if(canWrite){
   controls.append(button('编辑配置',()=>channelEditor(ch)))
   const label=ch.pendingChanges?(ch.enabled?'发布并启用':'发布并停用'):'已发布'
   const publish=button(label,()=>editor(`${label} · ${ch.id}`,ch.enabled?'确认发布后，允许的业务应用可使用该渠道创建新订单。':'确认发布后停止接收新订单，已有订单仍保留验签与查询。',[node('p',`应用：${ch.allowedApps.join('，')} · ${ch.environment==='live'?'正式':'沙箱'}`)],async()=>{await call(`channels/${ch.id}/publish`,'POST',{revision:ch.revision});return ()=>message(ch.enabled?'渠道已发布并启用。':'渠道已发布并停用。')},label),'primary')
   publish.disabled=!ch.valid || !ch.pendingChanges
   publish.title=!ch.valid?'请先按上方提示修正配置并保存':!ch.pendingChanges?'没有待发布的修改':''
   controls.append(publish)
  }
  footer.append(controls);card.append(header,body,footer);list.append(card)
 }
 content.append(list)
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
  if(current==='channels')renderChannels(data,content,actions)
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
 for(const [id,label,permission] of modules)if(allowed(permission,['observations','audit'].includes(id))){const b=button(label,()=>{if(busy)return;current=id;page=1;void load()},'ghost');b.dataset.module=id;$('modules').append(b)}
 $('navigation').hidden=!$('modules').children.length
}
// One automatic SSO attempt per tab; an explicit retry remains available.
// This is navigation state only. Identity and permissions always come from the server.
function loginState(value){
 try{
  if(value===undefined)return sessionStorage.getItem('mx-pay-login-state')
  if(value===null)sessionStorage.removeItem('mx-pay-login-state')
  else sessionStorage.setItem('mx-pay-login-state',value)
  return value
 }catch{return 'unavailable'}
}
function pendingInvitation(){try{return sessionStorage.getItem('mx-pay-invitation')}catch{return null}}
async function initialize(){
 try{
  const session=await api('/auth/sso/session')
  const query=new URLSearchParams(location.search)
  if(session.active!==true){
   if(session.active!==false)throw Error('暂时无法确认登录状态，请刷新后重试。')
   if(query.has('signedOut') || loginState()==='signed-out'){
    loginState('signed-out');message('你已退出支付中心。点击“统一登录”可重新进入。');return
   }
   if(query.has('sso')){message('登录状态未能保存，请确认浏览器允许本站 Cookie，再点击“统一登录”重试。');return}
   if(loginState()==='attempted'){message('统一登录尚未完成，请点击“统一登录”重试。');return}
   if(loginState('attempted')==='unavailable'){message('浏览器无法保存登录跳转状态，请点击“统一登录”继续。');return}
   message('正在前往 Launcher 统一登录…');location.replace('/auth/sso/login');return
  }
  loginState(null)
  if(query.has('sso') || query.has('signedOut')){
   query.delete('sso');query.delete('signedOut')
   history.replaceState(null,'',`${location.pathname}${query.size?`?${query}`:''}${location.hash}`)
  }
  csrf=session.csrf;$('login').hidden=true;$('switch').hidden=false;$('logout').hidden=false;$('security').href=session.securityUrl;$('security').hidden=false
  me=await call('me');$('account').textContent=me.displayName
  if(!me.permissions){message('管理 API 尚未升级，请先部署当前 mx-pay 版本。');return}
  $('invitation').hidden=!pendingInvitation()
  if(!me.grants.length){message(`尚未获得支付权限。当前用户 ID：${me.subject}。请由管理员授权，或接受支付访问邀请。`);return}
  buildNavigation();current=$('modules').firstChild.dataset.module;$('workspace').hidden=false;await load()
 }catch(e){message(e.message)}
}
function captureInvitation(){
 const invitation=/^#invite=([A-Za-z0-9_-]{43})$/.exec(location.hash)
 if(invitation){
  try{sessionStorage.setItem('mx-pay-invitation',invitation[1])}
  catch{message('浏览器无法暂存支付邀请，请允许本站存储后重新打开邀请链接。');return false}
  history.replaceState(null,'',`${location.pathname}${location.search}`);$('invitation').hidden=!csrf
 }
 return true
}
window.addEventListener('hashchange',captureInvitation)
$('accept-invitation').onclick=async()=>{try{await call('invitations/accept','POST',{token:sessionStorage.getItem('mx-pay-invitation')});sessionStorage.removeItem('mx-pay-invitation');await initialize()}catch(e){message(e.message)}}
$('discard-invitation').onclick=()=>{sessionStorage.removeItem('mx-pay-invitation');$('invitation').hidden=true}
$('previous').onclick=()=>{if(!busy && page>1){page--;void load()}};$('next').onclick=()=>{if(!busy){page++;void load()}}
$('login').onclick=$('switch').onclick=()=>{loginState('attempted')}
$('logout').onclick=async()=>{try{await api('/auth/sso/logout','POST',{});loginState('signed-out');location.replace('/?signedOut=1')}catch(e){message(e.message)}}
if(captureInvitation())void initialize()
