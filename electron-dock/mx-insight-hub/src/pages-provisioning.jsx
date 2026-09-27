import { useEffect, useRef, useState } from 'react'
import { adminApi } from './api.js'
import { ErrorState, Field, LoadingState, PageHeading } from './components.jsx'
import { PagedItems } from './paged-items.jsx'

const providers = { qixin: '启信 · 企业数据', justone: 'JustOne', tikhub: 'TikHub' }
const blockers = { key_scope_limit_exceeded: '追加后超过 Key 的 128 平台 / 2048 能力限制', procurement_price_missing: '缺少完整端点价格', operation_currency_mismatch: '同一操作含多种币种', procurement_price_invalid: '采购价不符合当前计量规则', rounding_acknowledgment_required: '请确认预算取整规则', explicit_operation_review_required: '已暂停或处于验证阶段，须单独审核', credential_missing: '未配置有效凭据', release_not_active: '接口版本未发布', migration_required: '需先执行数据库迁移', qixin_price_negotiation_required: '面议接口尚未开放' }
export function ProvisioningPage({ token, query, setQuery, onUnauthorized, notify }) {
  const [data,setData]=useState(null), [drafts,setDrafts]=useState([]), [error,setError]=useState(null), [busy,setBusy]=useState(false)
  const [provider,setProvider]=useState(providers[query.get('provider')] ? query.get('provider') : 'justone')
  const [keyId,setKeyId]=useState(query.get('keyId') || ''), [selected,setSelected]=useState([]), [draftId,setDraftId]=useState('')
  const [salePrices,setSalePrices]=useState({}), [currency,setCurrency]=useState('CNY'), [overrides,setOverrides]=useState([])
  const [budget,setBudget]=useState('0'),[subsidy,setSubsidy]=useState('0'),[reason,setReason]=useState(''),[rounding,setRounding]=useState(false)
  const [draftText,setDraftText]=useState(''),[preview,setPreview]=useState(null),[result,setResult]=useState(null)
  const lock=useRef(false)
  useEffect(()=>{
    let active=true
    Promise.all([adminApi.provisioningCatalog(token),adminApi.apiKeys(token),adminApi.consumers(token),adminApi.provisioningDrafts(token)]).then(([catalog,keys,consumers,prices])=>{
      if(active){setData({catalog,keys,consumers});setDrafts(prices)}
    }).catch(err=>{if(active){setError(err);if(err.status===401)onUnauthorized?.()}})
    return()=>{active=false}
  },[token,onUnauthorized])
  const savedBatchId=query.get('batchId')
  useEffect(()=>{
    if(!savedBatchId)return
    let active=true
    adminApi.provisioningBatch(token,savedBatchId).then(saved=>{
      if(!active)return
      setPreview(saved);setResult(saved.result)
      setKeyId(saved.spec.keyId);setProvider(saved.spec.operationIds[0].split(':')[0]);setSelected(saved.spec.operationIds)
      setDraftId(saved.spec.draftId||'');setSalePrices(Object.fromEntries(Object.entries(saved.spec.salePrices).map(([id,value])=>[id,String(value)])))
      setOverrides(saved.spec.overrideProcurement);setCurrency(saved.spec.currency||'CNY');setBudget(String(saved.spec.monthlyBudgetMinor));setSubsidy(String(saved.spec.monthlySubsidyBudgetMinor));setRounding(saved.spec.acknowledgeRounding);setReason(saved.spec.reason)
    }).catch(err=>{if(active)setError(err)})
    return()=>{active=false}
  },[token,savedBatchId])
  const run=async action=>{
    if(lock.current)return
    lock.current=true;setBusy(true);setError(null)
    try{await action()}catch(err){setError(err);if(err.status===401)onUnauthorized?.()}finally{lock.current=false;setBusy(false)}
  }
  const invalidate=()=>{setPreview(null);setResult(null);if(query.has('batchId'))setQuery?.({batchId:null})}
  const edit=(setter,value)=>{setter(value);invalidate()}
  if(!data)return error?<ErrorState error={error}/>:<LoadingState label="读取批量开通目录"/>
  const operations=data.catalog.operations.filter(row=>row.provider===provider)
  const draft=drafts.find(row=>row.id===draftId)
  const currentKey=data.keys.find(row=>row.id===keyId)
  const consumer=data.consumers.find(row=>row.id===currentKey?.consumerId)
  const official=data.catalog.officialDrafts.find(row=>row.provider===provider)
  const newDraft=()=>{
    if(official?.available){const {available:_,...spec}=official;setDraftText(JSON.stringify(spec,null,2))}
    else setDraftText(JSON.stringify({provider,name:`${providers[provider]} 账户价格`,sourceKind:'contract',sourceUrl:'https://example.com/prices',observedAt:new Date().toISOString(),rates:operations.filter(row=>selected.includes(row.id)).flatMap(row=>row.endpointKeys.map(endpointKey=>({endpointKey,currency:'CNY',unitPrice:'请填写账户合同单价',billingUnit:'request'})))},null,2))
  }
  const makePreview=()=>run(async()=>{
    const prices=Object.fromEntries(Object.entries(salePrices).filter(([id,value])=>selected.includes(id)&&value!=='').map(([id,value])=>[id,Number(value)]))
    const next=await adminApi.provisioningPreview(token,{keyId,operationIds:selected,draftId:draftId||null,overrideProcurement:overrides.filter(id=>selected.includes(id)),salePrices:prices,currency,
      monthlyBudgetMinor:Number(budget),monthlySubsidyBudgetMinor:Number(subsidy),reason,acknowledgeRounding:rounding})
    setPreview(next);setResult(null);setQuery?.({batchId:next.id})
  })
  return <>
    <PageHeading title="批量开通" description="选择现有 Key，按供应商筛选全部或部分已实现接口；预览采购配置、客户价格、授权与运行范围后一起提交。">
      <a className="qp-button qp-button--outline" href="#/external-platforms">上游供应商</a><a className="qp-button qp-button--outline" href="#/plans">租户倍率与套餐</a>
    </PageHeading>
    <section className="qp-panel mih-provisioning">
      <p>本页覆盖已登记采购策略的企业、JustOne 与 TikHub 接口。IP 风险画像继续使用原产品授权和套餐入口；其采购价格尚无已审证据。</p>
      <h2>1 · 选择调用身份和接口</h2>
      <div className="mih-provisioning-grid">
        <Field label="目标 Key"><select aria-label="目标 Key" className="qp-input" value={keyId} disabled={busy} onChange={e=>edit(setKeyId,e.target.value)}><option value="">请选择现有 Key</option>{data.keys.map(key=><option key={key.id} value={key.id} disabled={key.status!=='active'||Date.parse(key.expiresAt)<=Date.now()}>{data.consumers.find(row=>row.id===key.consumerId)?.name} · {key.name} · {key.id.slice(0,8)}</option>)}</select></Field>
        <Field label="上游供应商"><select aria-label="上游供应商" className="qp-input" disabled={busy} value={provider} onChange={e=>{setProvider(e.target.value);setSelected([]);setOverrides([]);setDraftId('');setSalePrices({});setDraftText('');invalidate()}}>{Object.entries(providers).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></Field>
      </div>
      <p>销售价格绑定调用者{consumer?`「${consumer.name}」`:''}，同一调用者的所有 Key 共用价格。此处只追加所选 Key 的能力，租户倍率和账单保持原值。</p>
      {provider==='qixin'?<p className="mih-provisioning-note">企业查询采用整体 enterprise.query 授权。勾选部分接口仅限定本批价格和运行配置，不能用来限制 Key 只能调用这些企业端点。</p>:null}
      <div className="mih-page-actions"><button className="qp-button qp-button--outline" disabled={busy} onClick={()=>edit(setSelected,operations.filter(row=>!row.blocked).map(row=>row.id))}>选择全部已实现接口（{operations.filter(row=>!row.blocked).length}）</button><button className="qp-button qp-button--ghost" disabled={busy} onClick={()=>edit(setSelected,[])}>清空</button><span>已选 {selected.length} 项</span></div>
      <PagedItems items={operations} text={row=>`${row.label} ${row.operation} ${row.platform} ${row.paths.join(' ')}`} label="接口" pageSize={10}>{visible=><div className="mih-provisioning-list">{visible.map(({entry:row})=><label className="mih-provisioning-row" key={row.id}>
        <input type="checkbox" disabled={busy||!!row.blocked} checked={selected.includes(row.id)} onChange={e=>edit(setSelected,e.target.checked?[...selected,row.id]:selected.filter(id=>id!==row.id))}/><span><strong>{row.label}</strong><small>{row.operation}</small><small>{row.platform} · {row.current.desiredState} · {row.blocked?'面议 / 暂未开放':row.current.priceBook.ready?'已有采购证据':'待补采购证据'}</small></span>
        <a href={`#/external-platforms?provider=${provider}&operation=${encodeURIComponent(row.operation)}`} onClick={e=>e.stopPropagation()}>单项审核</a>
      </label>)}</div>}</PagedItems>
    </section>
    <section className="qp-panel mih-provisioning">
      <h2>2 · 采购价格草稿</h2>
      <p>逐端点保存币种、单价和来源。已审核价格默认保留；新增价格沿用所选草稿。仅导入草稿不会开通接口。</p>
      <Field label="价格草稿"><select aria-label="价格草稿" className="qp-input" disabled={busy} value={draftId} onChange={e=>edit(setDraftId,e.target.value)}><option value="">保留现有采购价格</option>{drafts.filter(row=>row.spec.provider===provider).map(row=><option value={row.id} key={row.id}>{row.spec.name} · {row.spec.observedAt.slice(0,10)} · {row.spec.rates.length} 项</option>)}</select></Field>
      {draft?<p><a href={draft.spec.sourceUrl} target="_blank" rel="noreferrer">价格来源</a> · {draft.spec.sourceKind} · {draft.spec.rates.length} 项精确价格；保存后不可修改，可建立新草稿。</p>:null}
      {!official?.available?<p>{official?.reason}</p>:provider==='tikhub'?<p>新账户参考快照仅覆盖已核对接口；缺失项待核价。阶梯折扣、赠额和实际扣费单独核算，不据此认定服务免费。</p>:null}
      <details><summary>导入逐端点价格</summary><p>单价使用原币金额的十进制字符串，例如 USD “0.0038”。当前仅支持按请求计价；阶梯、套餐和按结果收费须先人工换算为明确适用的账户合同价格。</p>
        <button className="qp-button qp-button--outline" disabled={busy} onClick={newDraft}>{official?.available?'载入已核对官方快照':'生成所选端点导入模板'}</button>
        <Field label="价格草稿 JSON"><textarea aria-label="价格草稿 JSON" className="qp-input mih-provisioning-json" spellCheck="false" disabled={busy} value={draftText} onChange={e=>setDraftText(e.target.value)}/></Field>
        <button className="qp-button qp-button--primary" disabled={busy||!draftText} onClick={()=>run(async()=>{const saved=await adminApi.provisioningSaveDraft(token,JSON.parse(draftText));setDrafts(current=>[saved,...current]);edit(setDraftId,saved.id);notify?.('价格草稿已保存，尚未开通接口','success')})}>保存不可变价格草稿</button>
      </details>
      <div className="mih-provisioning-grid"><Field label="新采购价的月预算（原币最小单位）"><input aria-label="新采购价的月预算（原币最小单位）" className="qp-input" type="number" min="0" step="1" disabled={busy} value={budget} onChange={e=>edit(setBudget,e.target.value)}/></Field><Field label="新采购价的月补贴预算（原币最小单位）"><input aria-label="新采购价的月补贴预算（原币最小单位）" className="qp-input" type="number" min="0" step="1" disabled={busy} value={subsidy} onChange={e=>edit(setSubsidy,e.target.value)}/></Field></div>
      <p>原币分别记账，不自动换汇。0 表示没有该项预算；执行仍须通过余额和采购预算检查。</p>
      <label><input type="checkbox" disabled={busy} checked={rounding} onChange={e=>edit(setRounding,e.target.checked)}/>已知晓：精确价格另存；当前预算按每次端点价格向上取整到最小货币单位，属于保守估值，不是实际扣费。</label>
    </section>
    <section className="qp-panel mih-provisioning">
      <h2>3 · 销售价与例外</h2><p>留空保留当前售价（包括明确免费和租户默认价）。输入价格会为目标调用者发布合并后的套餐版本，未选条目和套餐额度保留。销售价以最小货币单位填写，最终价格仍使用原租户倍率。</p>
      <Field label="销售币种"><select aria-label="销售币种" className="qp-input" disabled={busy} value={currency} onChange={e=>edit(setCurrency,e.target.value)}>{['CNY','USD','EUR','GBP','HKD'].map(value=><option key={value}>{value}</option>)}</select></Field>
      <button className="qp-button qp-button--outline" disabled={busy||!draft||!selected.length} onClick={()=>{const prices={...salePrices};for(const row of operations.filter(row=>selected.includes(row.id))){const rates=row.endpointKeys.map(key=>draft.spec.rates.find(rate=>rate.endpointKey===key));if(rates.length===1&&rates[0]?.currency===currency)prices[row.id]=String(rates[0].budgetMinor)}edit(setSalePrices,prices)}}>将同币种单端点参考价填入销售草稿</button>
      <PagedItems items={operations.filter(row=>selected.includes(row.id))} text={row=>`${row.label} ${row.operation}`} label="所选价格">{visible=><div>{visible.map(({entry:row})=><div className="mih-provisioning-price" key={row.id}><Field label={`${row.label} · 销售单价`}><input aria-label={`${row.label} · 销售单价`} className="qp-input" type="number" min="0" step="1" placeholder="保留当前价格" disabled={busy} value={salePrices[row.id]??''} onChange={e=>edit(setSalePrices,{...salePrices,[row.id]:e.target.value})}/></Field><label><input type="checkbox" disabled={busy||!draftId} checked={overrides.includes(row.id)} onChange={e=>edit(setOverrides,e.target.checked?[...overrides,row.id]:overrides.filter(id=>id!==row.id))}/>明确用草稿替换此接口已有采购价格</label></div>)}</div>}</PagedItems>
      <Field label="变更原因"><input aria-label="变更原因" className="qp-input" maxLength={800} disabled={busy} value={reason} onChange={e=>edit(setReason,e.target.value)}/></Field>
      <button className="qp-button qp-button--primary" disabled={busy||!keyId||!selected.length||!reason.trim()} onClick={makePreview}>{busy?'处理中…':'生成开通预览'}</button>
    </section>
    {error?<ErrorState error={error}/>:null}
    {preview?<section className="qp-panel mih-provisioning" aria-label="开通预览"><h2>4 · 核对并执行</h2><p>批次 {preview.id} · 15 分钟内有效。当前计费模式 {preview.preview.profile.mode}，租户倍率 {preview.preview.profile.multiplierPpm==null?'继承套餐':preview.preview.profile.multiplierPpm/1000000}。{preview.preview.changesPrice?`改价影响同调用者 ${preview.preview.affectedKeys.length} 把 Key。`:'当前销售套餐不变。'}</p>
      <ul>{preview.preview.notes.map(note=><li key={note}>{note}</li>)}</ul>
      <PagedItems items={preview.preview.rows} text={row=>`${row.label} ${row.operation}`} label="预览结果">{visible=><div className="mih-provisioning-list">{visible.map(({entry:row})=><article className="mih-provisioning-preview" key={row.id}><h3>{row.label}</h3><p>{row.current.desiredState} → {row.nextState} · {row.replacePrice?'采用草稿采购价':'保留采购价'} · 合同报价 {row.effectivePrice.currency} {row.effectivePrice.quotedMinor} 最小单位 / 请求</p><p>授权：{row.platform} / {row.capability}</p>{row.exactRates.filter(Boolean).map(rate=><p key={rate.endpointKey}>{rate.endpointKey}：{rate.currency} {rate.unitPrice} / 请求；预算估值 {rate.budgetMinor} 最小单位</p>)}{row.blockers.length?<p role="alert">未就绪：{row.blockers.map(code=>blockers[code]||code).join('；')}</p>:<p>配置检查通过 · 执行时仍检查余额、额度和运行状态</p>}</article>)}</div>}</PagedItems>
      <button className="qp-button qp-button--primary" disabled={busy||!preview.preview.canApply||!!result} onClick={()=>run(async()=>{const receipt=await adminApi.provisioningApply(token,preview.id);setResult(receipt);notify?.('批量配置已完整提交','success')})}>{busy?'正在提交…':'确认并完整提交此批次'}</button>
      <button className="qp-button qp-button--outline" disabled={busy} onClick={()=>run(async()=>{const saved=await adminApi.provisioningBatch(token,preview.id);setResult(saved.result)})}>核对批次结果</button>
      {!preview.preview.canApply?<p>本批不能提交。请修复阻塞项，或取消相应接口后重新预览。</p>:null}
    </section>:null}
    {result?<section className="qp-panel mih-provisioning" role="status"><h2>开通配置已完成</h2><p>已提交 {result.applied.length} 个接口；{result.planChanged?'新套餐已绑定到目标调用者':'销售套餐保持原值'}。同一批次重复提交返回此结果。</p><a href={`#/api-keys?consumerId=${result.consumerId}`}>查看 Key 权限</a> · <a href="#/source-catalog">查看数据源目录</a></section>:null}
  </>
}
