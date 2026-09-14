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
  const [key] = useDemoApiKey()
  const access = useDemoAccessSnapshot()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [coverage, setCoverage] = useState('')
  const [data, setData] = useState(null)
  const [metadata, setMetadata] = useState(null)
  const [detail, setDetail] = useState(null)
  const [applied, setApplied] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const lock = useRef(false)
  const allowed = key && access?.platforms?.includes('source_catalog')
  async function run(task) {
    if (!allowed || lock.current) return
    lock.current = true; setBusy(true); setError(null)
    try { await task() } catch (failure) { setError(failure) }
    finally { lock.current = false; setBusy(false) }
  }
  const load = next => run(async () => {
    const filters = next ? applied : { query, majorCategory: category, coverageStatus: coverage, pageSize: 50 }
    const params = Object.fromEntries(Object.entries(filters).filter(([, value]) => value !== ''))
    if (next) params.cursor = data.pageInfo.nextCursor
    const response = await publicDataApi.sourceCatalog(key, params)
    setData(response.payload.data); setApplied(filters); setDetail(null)
  })
  const summary = metadata?.summary
  return <div className="mih-page">
    <div className="qp-panel mih-panel"><h1>数据源目录</h1><p>通过当前 Hub Key 查询平台目录、分类与覆盖情况。</p><a className="qp-button qp-button--outline" href="#/docs?path=/docs/source-catalog">接口文档与字段定义</a>
      {!allowed ? <p>请选择包含数据源目录授权的 Key。</p> : null}
      <p>查询、详情、汇总和续页均为独立接口调用，按当前套餐计量；不会自动加载。</p>
      <button className="qp-button qp-button--outline" disabled={!allowed || busy} onClick={() => run(async () => setMetadata((await publicDataApi.sourceCatalogMetadata(key)).payload.data))}>加载 / 刷新目录汇总</button>
    </div>
    {summary ? <div className="mih-catalog-public-summary">{[['目录总数', summary.total], ['平台已覆盖', summary.covered], ['部分覆盖', summary.partial], ['未覆盖', summary.uncovered]].map(([label, value]) => <div className="qp-panel mih-panel" key={label}><p>{label}</p><h2>{value}</h2></div>)}</div> : null}
    <section className="qp-panel mih-panel"><h2>平台接入目录</h2>
      <form className="mih-catalog-public-filters" onSubmit={event => { event.preventDefault(); void load(false) }}>
        <input className="qp-input" aria-label="搜索平台" placeholder="搜索平台或数据源" value={query} onChange={event => setQuery(event.target.value)} />
        <DropdownField label="分类" value={category} onChange={setCategory} options={[{ value: '', label: '全部分类' }, ...(metadata?.facets?.majorCategories || []).map(value => ({ value, label: value }))]} />
        <DropdownField label="覆盖状态" value={coverage} onChange={setCoverage} options={[{ value: '', label: '全部状态' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))]} />
        <button className="qp-button qp-button--primary" disabled={!allowed || busy}>查询</button>
      </form>
      {error ? <ErrorState error={error} /> : null}
      <div className="qp-table-wrap"><table className="qp-table mih-table"><thead><tr><th>平台 / 数据源</th><th>分类</th><th>覆盖状态</th><th>能力与内容</th><th>操作</th></tr></thead><tbody>{(data?.items || []).map(item => <tr key={item.id}><td>{item.canonicalName}</td><td>{item.majorCategory}</td><td>{statuses[item.coverageStatus] || item.coverageStatus}</td><td>{item.monitorableContent?.join('、')}</td><td><button className="qp-button qp-button--ghost" disabled={busy} onClick={() => run(async () => setDetail((await publicDataApi.sourceCatalogDetail(key, item.id)).payload.data))}>查看详情</button></td></tr>)}</tbody></table></div>
      <p>{data ? `本页 ${data.items.length} 条 · 共 ${data.pageInfo.totalCount} 条` : '点击查询加载目录。'}</p>
      {data ? <button className="qp-button qp-button--outline" disabled={!data.pageInfo.hasMore || busy || !allowed} onClick={() => void load(true)}>下一页</button> : null}
      {detail ? <details open><summary>目录详情 · Hub JSON</summary><pre className="mih-api-response">{JSON.stringify(detail, null, 2)}</pre></details> : null}
    </section>
  </div>
}
