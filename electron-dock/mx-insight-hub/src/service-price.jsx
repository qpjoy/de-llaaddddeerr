import { useEffect, useState } from 'react'
import { publicDataApi } from './api.js'
import { useDemoApiKey } from './demo-credentials.jsx'

export function ServicePrice({ path }) {
  const [key] = useDemoApiKey(), [state,setState] = useState(null), [refresh,setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    setState(null)
    if (key && path) publicDataApi.servicePricing(key,path).then(result => {
      if (active) setState({key,path,quote:result.payload.data})
    }).catch(error => { if(active) setState({key,path,error}) })
    return () => { active=false }
  }, [key,path,refresh])
  if (!path) return null
  const current = state?.key === key && state?.path === path ? state : null
  const quote = current?.quote
  const money = amount => `${quote.currency} ${(amount / 100).toFixed(2)}`
  return <section className="mih-service-price" aria-label="Hub 服务定价"><strong>Hub 官方定价</strong>
    {!key ? <p>选择已授权 Key 后查看当前服务价格。</p> : !current ? <p role="status">正在读取价格…</p> : current.error ? <p role="status">{current.error.status === 403 ? '当前 Key 未开通此接口，价格需开通后查看。' : '暂时无法读取价格，请重试。'}</p> : <>
      <div className="mih-page-actions"><span>当前价格表：<b>{quote.hubPrice.published ? money(quote.hubPrice.unitPriceMinor) : '未发布单价'}</b></span><span>账户执行价：<b>{money(quote.accountPrice.unitPriceMinor)}</b> / {quote.billingUnit === 'ip' ? 'IP' : '次'}</span></div>
      <small>{quote.accountPrice.status === 'billing_disabled' ? '当前账户未启用实际扣费。' : quote.accountPrice.status === 'account_default' ? '此接口使用账户默认费率。' : quote.accountPrice.multiplierPpm !== 1000000 ? `当前合同倍率 ${(quote.accountPrice.multiplierPpm / 1000000).toFixed(4)}。` : ''} 以发送时的有效价格和账单为准；读取价格不产生查询费用。</small>
    </>}
    {key ? <button type="button" className="qp-button qp-button--ghost qp-button--sm" onClick={()=>setRefresh(value=>value+1)}>刷新价格</button> : null}
  </section>
}
