import { useEffect, useState } from 'react'
import { ProductApiConsole } from './product-workbench.jsx'
import { productForPath } from '../shared/product-workbenches.mjs'
import { WEB_SEARCH_PROVIDERS } from '../shared/web-search.mjs'
import { publicDataApi } from './api.js'
import { useDemoApiKey } from './demo-credentials.jsx'
import { ErrorState } from './components.jsx'
export function WebSearchPage({token,session}) {
  const [key]=useDemoApiKey(), [scope,setScope]=useState(null),[error,setError]=useState(null),[tab,setTab]=useState('debug')
  useEffect(()=>{let active=true;setScope(null);setError(null)
    if(key) publicDataApi.productRequest(key,{method:'GET',path:'/api/v1/data/web-search/capabilities'}).then(result=>{if(active)setScope(result.payload?.data)}).catch(e=>{if(active)setError(e)})
    return()=>{active=false}
  },[key])
  const providers=scope?.providers || (session?.platformAdmin?WEB_SEARCH_PROVIDERS:[])
  return <div className="mih-page">
    <header className="mih-page-header"><div><h1>Web Search</h1><p>搜索全网网页、图片和视频，将结果接入您的应用。可用渠道由当前调用身份决定。</p></div><a className="qp-button qp-button--outline" href="#/docs?path=/docs/web-search">接口文档 ↗</a></header>
    <nav className="mih-source-section-tabs" aria-label="Web Search 视图">{[['debug','接口调试'],['channels','搜索渠道与接入']].map(([id,label])=><button key={id} type="button" aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    {error?<ErrorState error={error}/>:null}
    <section hidden={tab!=='channels'} className="qp-panel mih-panel"><h2>当前身份的搜索渠道</h2><p>{scope?'按实际调用优先顺序排列。':'选择 Hub Live Key 后查看它的可用渠道和顺序。'}</p>
      {!providers.length?<p>尚未开放 Web Search，请在“开放能力”设置租户范围，再在 API Keys 勾选相应权限。</p>:<ol>{providers.map(p=><li key={p.key}><strong>{p.label}</strong> · {p.resources?.join(' / ')} · {p.ready?'可调用':scope?'尚未就绪':'已注册，待配置'} {session?.platformAdmin?<a href={`#/external-platforms?provider=${p.key}`}>管理凭据与网络 ↗</a>:null}</li>)}</ol>}
      <p>请求省略 provider 时按授权顺序选择；指定 provider 时只调用该渠道。每次搜索只派发一次，空结果或不确定结果不会自动产生第二次调用。</p>
      <p>百度支持网页、图片和视频以及站点、日期筛选；其他已接入渠道当前提供网页结果。搜索结果为摘要和链接，不自动抓取全文。</p>
      {session?.platformAdmin?<a href="#/platforms">前往开放能力配置租户与 Key 范围 ↗</a>:null}
    </section>
    <div hidden={tab!=='debug'}><ProductApiConsole token={token} product={productForPath('/data-products/web-search')}/></div>
  </div>
}
