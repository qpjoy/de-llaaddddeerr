import { useEffect, useState } from 'react'
import { ArrowClockwise, Globe, MagnifyingGlass } from '@phosphor-icons/react'
import { ProductApiConsole } from './product-workbench.jsx'
import { productForPath } from '../shared/product-workbenches.mjs'
import { publicDataApi, publicDocsHref } from './api.js'
import { useDemoApiKey } from './demo-credentials.jsx'
import { ErrorState } from './components.jsx'
import { WebSearchExperience } from './web-search-experience.jsx'
import './web-search.css'

export function WebSearchPage({ token, session }) {
  const [key] = useDemoApiKey()
  const [scope, setScope] = useState(null), [error, setError] = useState(null), [loading, setLoading] = useState(false)
  const [refresh, setRefresh] = useState(0), [tab, setTab] = useState('debug'), [result, setResult] = useState(null)
  useEffect(() => {
    let active = true
    setScope(null); setError(null); setLoading(Boolean(key))
    if (key) publicDataApi.productRequest(key, { method: 'GET', path: '/api/v1/data/web-search/capabilities' })
      .then(response => { if (active) setScope(response.payload?.data) })
      .catch(failure => { if (active) setError(failure) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [key, refresh])
  const providers = scope?.providers || [], ready = providers.filter(row => row.ready)
  const admin = session?.platformAdmin
  return <div className="mih-page mih-product-workbench mih-web-search-page">
    <header className="mih-page-header"><div><h1>Web Search</h1><p>搜索网页、图片与视频，将带来源的结果接入您的应用。</p></div><a className="qp-button qp-button--outline" href={publicDocsHref('/docs/web-search')}>接口文档 ↗</a></header>
    <nav className="mih-source-section-tabs" aria-label="Web Search 视图">
      {[['debug', '接口调试'], ['product', '产品展示'], ['channels', '搜索渠道与接入']].map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}
    </nav>
    <div className="mih-search-readiness" role="status">
      <Globe size={20} aria-hidden="true" /><div>{!key ? '请选择调用 Key，查看搜索渠道。' : loading ? '正在读取当前 Key 的渠道状态…' : error ? '渠道状态读取失败，请刷新后重试。' : !providers.length ? '当前 Key 没有完整的 Web Search 权限。' : <><strong>已授权 {providers.length} 个渠道 · {ready.length} 个可调用</strong>{!ready.length ? <span>{admin ? '权限已生效，无需重复保存租户授权。请检查渠道运行开关、凭据及采购配置。' : '已开通搜索服务，渠道暂未就绪，请联系服务管理员。'}</span> : null}</>}</div>
      <button className="qp-button qp-button--ghost qp-button--sm" type="button" disabled={!key || loading} onClick={() => setRefresh(value => value + 1)}><ArrowClockwise size={16} aria-hidden="true" />刷新状态</button>
      {tab !== 'channels' ? <button className="qp-button qp-button--outline qp-button--sm" type="button" onClick={() => setTab('channels')}>查看渠道</button> : null}
    </div>
    {error ? <ErrorState error={error} /> : null}
    <div hidden={tab !== 'debug'}><ProductApiConsole token={token} product={productForPath('/data-products/web-search')} onResult={response => { if (Array.isArray(response.payload?.data?.items)) setResult(response) }} /></div>
    <div hidden={tab !== 'product'}><WebSearchExperience providers={providers} loading={loading} result={result} onResult={setResult} onShowChannels={() => setTab('channels')} /></div>
    <section hidden={tab !== 'channels'} className="qp-panel mih-search-channels" aria-label="搜索渠道与接入">
      <header><div><h2>当前身份的搜索渠道</h2><p>按实际调用优先顺序排列；授权与渠道就绪状态分别显示。</p></div><button type="button" className="qp-button qp-button--primary" onClick={() => setTab('product')}><MagnifyingGlass size={18} aria-hidden="true" />打开搜索产品</button></header>
      {!providers.length ? <p>{loading ? '正在读取渠道…' : !key || error ? '选择调用身份并成功读取状态后，展示它的授权渠道。' : '需要同时具备 Web Search 数据域、搜索能力和至少一个渠道权限。'} {admin && key && !loading && !error ? <a href="#/api-keys">调整 Key 权限 ↗</a> : null}</p> : <ol className="mih-search-channel-list">{providers.map(provider => <li key={provider.key}>
        <div><strong>{provider.label}</strong><small>{provider.resources?.map(type => ({ web: '网页', image: '图片', video: '视频' })[type]).join(' / ')}</small></div>
        <span className={`mih-search-channel-status${provider.ready ? ' is-ready' : ''}`}>{provider.ready ? '可调用' : '已授权 · 尚未就绪'}</span>
        {admin ? <a href={`#/external-platforms?provider=${provider.key}`}>管理渠道配置 ↗</a> : null}
      </li>)}</ol>}
      <div className="mih-search-integration"><h3>通过 Hub 接入</h3><code>POST /api/v1/data/web-search/search</code><p>省略 provider 时，按授权顺序选择支持本次参数且就绪的渠道；指定 provider 时只调用该渠道。每次搜索只派发一次，空结果或不确定结果不会自动切换渠道。</p><p>返回搜索摘要与来源链接，不自动抓取全文或生成 AI 答案。失败重试沿用原请求标识；新搜索使用新的 Idempotency-Key。</p>{admin ? <p>凭据保存不等于启用调用。在“上游供应商 → 上游平台操作控制”检查 web.search 的运行模式、采购价格和预算；授权变更则在“开放能力”或“API Keys”中管理。</p> : null}<a href={publicDocsHref('/docs/web-search')}>查看请求参数与接入文档 ↗</a></div>
    </section>
  </div>
}
