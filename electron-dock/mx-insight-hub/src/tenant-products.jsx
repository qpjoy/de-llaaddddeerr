import { useRef, useState } from 'react'
import { publicDataApi } from './api.js'
import { useDemoApiKey, useDemoAccessSnapshot } from './demo-credentials.jsx'
import { DropdownField, ErrorState } from './components.jsx'
import { DocsPage } from './pages-docs.jsx'
import { PRODUCT_ACCESS } from '../shared/product-access.mjs'

export function TenantProductPage(props) {
  const rule = PRODUCT_ACCESS[props.routePath]
  return <DocsPage {...props} query={new URLSearchParams({ path: `/docs/${rule.docs}` })} />
}
const statuses = { covered: '已覆盖', partial: '部分覆盖', not_covered: '未覆盖', unknown: '待核验' }
export function TenantCatalogPage() {
  const [key] = useDemoApiKey(), access = useDemoAccessSnapshot()
  const [query, setQuery] = useState(''), [category, setCategory] = useState(''), [coverage, setCoverage] = useState('')
  const [data, setData] = useState(null), [applied, setApplied] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(null)
  const lock = useRef(false), allowed = key && access?.platforms?.includes('source_catalog')
  const load = async next => {
    if (!allowed || lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try {
      const filters = next ? applied : { query, majorCategory: category, coverageStatus: coverage, pageSize: 50 }
      const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''))
      if (next) params.cursor = data.pageInfo.nextCursor
      const response = await publicDataApi.serviceCatalog(key, params)
      setData(response.payload.data); setApplied(filters)
    } catch (failure) { setError(failure) }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="mih-page"><section className="qp-panel mih-panel">
    <h1>数据源目录</h1><p>按平台、业务类别与场景发现 Hub 数据服务。目录覆盖不代表当前 Key 已开通；实际调用单独检查权限和就绪状态。</p>
    <a className="qp-button qp-button--outline" href="#/docs?path=/docs/source-catalog">接口文档</a>
    <form className="mih-catalog-public-filters" onSubmit={event => { event.preventDefault(); void load(false) }}>
      <label className="qp-field">关键词<input className="qp-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="平台、内容或业务场景" /></label>
      <label className="qp-field">数据类别<input className="qp-input" value={category} onChange={event => setCategory(event.target.value)} placeholder="留空查询全部类别" /></label>
      <DropdownField label="覆盖范围" value={coverage} onChange={setCoverage} options={[{value:'',label:'全部'}, ...Object.entries(statuses).map(([value,label])=>({value,label}))]} />
      <button className="qp-button qp-button--primary" disabled={!allowed || busy}>{busy ? '查询中…' : '查询数据目录'}</button>
    </form><p>每次查询和续页按当前套餐计量，不会自动加载。</p>
    {!allowed ? <p>请选择具有数据源目录授权的 Key。</p> : null}
  </section>{error ? <ErrorState error={error}/> : null}
  {data ? <section className="qp-panel mih-panel"><h2>匹配 {data.pageInfo.totalCount} 个目录条目</h2><p>{data.notice}</p>
    <div className="mih-provisioning-list">{data.items.map(item => <article key={item.id} className="mih-provisioning-preview"><h3>{item.canonicalName}</h3><p>{item.majorCategory} · {statuses[item.coverageStatus] || item.coverageStatus}</p><p>{[...item.scenarios,...item.regions,...item.tags].join(' · ')}</p><p>{item.queryModes.map(mode=>mode==='stored'?'已收录数据':'实时查询').join(' / ') || '查询能力待完善'}</p>
      <div className="mih-page-actions">{item.products.map(product=><a className="qp-button qp-button--outline qp-button--sm" key={product.path} href={`#${product.path}`}>{product.category} · {product.label}</a>)}</div>
    </article>)}</div>
    <button className="qp-button qp-button--outline" disabled={busy || !data.pageInfo.hasMore} onClick={()=>load(true)}>下一页</button>
  </section> : null}</div>
}
