import { useEffect, useMemo, useRef, useState } from 'react'
import { productForPath, productEndpoints, productConsoleRequest, resolveProductSchema } from '../shared/product-workbenches.mjs'
import { adminApi, publicDataApi, publicDocsHref, publicApiOrigin } from './api.js'
import { useDemoApiKey, useDemoAccessSnapshot } from './demo-credentials.jsx'
import { ErrorState, DropdownField } from './components.jsx'
import { PagedItems } from './paged-items.jsx'
import { ServicePrice } from './service-price.jsx'
import { requestSnippet } from './request-snippets.js'
import { copyText } from './open-capabilities.js'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'
import './product-workbench.css'

export function ProductWorkbench({ Page, pageProps, enabled }) {
  const product = enabled && productForPath(pageProps.routePath)
  const directoryLink = pageProps.routePath === '/source-catalog' && (pageProps.query?.has('section') || pageProps.query?.has('catalogView'))
  const [tab, setTab] = useState(directoryLink ? 'demo' : 'debug'), [visited, setVisited] = useState(Boolean(directoryLink))
  useEffect(() => { if (directoryLink) { setTab('demo'); setVisited(true) } }, [directoryLink, pageProps.query?.get('section'), pageProps.query?.get('catalogView')])
  if (!product || product.native) return <Page {...pageProps} />
  return <div className="mih-product-workbench">
    <header className="mih-page-header"><div><h1>{product.label}</h1><p>从 Hub 接口开始，查看产品展示与接入方式。</p></div><a className="qp-button qp-button--outline" href={publicDocsHref(`/docs/${product.docs}`)}>接口文档 ↗</a></header>
    <nav className="mih-source-section-tabs" aria-label={`${product.label}视图`}>
      {[['debug', '接口调试'], ['demo', '产品展示'], ['guide', '接入指南']].map(([id, label]) => <button key={id} type="button" aria-pressed={tab === id} onClick={() => { setTab(id); if (id === 'demo') setVisited(true) }}>{label}</button>)}
    </nav>
    <div hidden={tab !== 'debug'}><ProductApiConsole product={product} token={pageProps.token} initialEndpoint={pageProps.query?.get('endpoint')} /></div>
    <div hidden={tab !== 'demo'}>{visited ? <Page {...pageProps} /> : null}</div>
    <section className="qp-panel mih-panel" hidden={tab !== 'guide'}><h2>接入 {product.label}</h2><p>选择已授权的 Hub Key，在接口调试页查看参数、发送请求并复制示例。接口以当前 Key 的有效权限为准；目录展示不等于已开通或服务就绪。</p><p>支持幂等契约的接口，新查询与下一页各用新的 Idempotency-Key；失败重试保留原参数与标识。GET 等读取是否每次计量以各接口说明为准。游标原样传回，不从条数猜测总量，也不自动补页。切换标签页不会自动发起付费查询。</p>{product.docs === 'aggregate-search' ? <p>推荐通过 POST fetch 设置 Accept: text/event-stream。按 source.completed 展示先到结果；search.completed 才是本批最终结果与分页游标。连接中断不代表调用被撤销，使用同一请求标识核对或重试。已收录模式读取最新入库及存量，不触发上游采集。</p> : null}<a href={publicDocsHref(`/docs/${product.docs}`)}>查看完整契约、分页和响应说明 ↗</a></section>
  </div>
}

function initialBody(document, endpoint) {
  const content = endpoint?.requestBody?.content?.['application/json']
  const schema = resolveProductSchema(document, content?.schema)
  const example = field => field.default ?? (field.type === 'object' ? Object.fromEntries(Object.entries(field.properties || {}).filter(([name,p])=>field.required?.includes(name) || p.default !== undefined).map(([name,p])=>[name,example(p)])) : field.type === 'array' ? [] : field.type === 'boolean' ? false : ['number','integer'].includes(field.type) ? 0 : '')
  return JSON.stringify(content?.example || Object.values(content?.examples || {})[0]?.value || schema.example || example(schema), null, 2)
}

export function ProductApiConsole({ product, token, initialEndpoint }) {
  const [key] = useDemoApiKey()
  const access = useDemoAccessSnapshot()
  const [document, setDocument] = useState(null), [loadError, setLoadError] = useState(null)
  const [selected, setSelected] = useState(initialEndpoint ? `post:/data/native/${initialEndpoint}` : ''), [drafts, setDrafts] = useState({}), [category, setCategory] = useState('')
  const [result, setResult] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState(null), [, render] = useState(0)
  const [copyStatus, setCopyStatus] = useState('')
  const attempts = useRef(new Map()), lock = useRef(false)
  useEffect(() => { let active = true
    adminApi.documentation(token, '/docs/openapi.json').then(value => { if (active) setDocument(value.schema) }).catch(failure => { if (active) setLoadError(failure) })
    return () => { active = false }
  }, [token])
  const endpoints = useMemo(() => productEndpoints(document, product).filter(row => !access || !row['x-mx-required-platform'] || access.platforms?.includes(row['x-mx-required-platform']) && (row['x-mx-required-capabilities'] || []).every(cap => access.capabilities?.includes(cap))), [document, product, access])
  const categories = [...new Set(endpoints.map(row=>row['x-mx-category'] || '通用'))].sort()
  const visibleEndpoints = endpoints.filter(row=>!category || (row['x-mx-category'] || '通用') === category)
  const endpoint = visibleEndpoints.find(row => row.id === selected) || visibleEndpoints[0]
  const revealItem = useMemo(() => { const index=endpoints.filter(row=>!category || (row['x-mx-category'] || '通用')===category).findIndex(row=>row.id===`post:/data/native/${initialEndpoint}`); return initialEndpoint && index>=0 ? {index} : null },[endpoints,category,initialEndpoint])
  const draft = drafts[endpoint?.id] || {}, values = draft.values || {}
  const json = draft.json ?? initialBody(document, endpoint)
  const schema = resolveProductSchema(document, endpoint?.requestBody?.content?.['application/json']?.schema)
  let input = null, validation = ''
  try { input = productConsoleRequest(endpoint, values, json) } catch (failure) { validation = failure.message }
  const fingerprint = JSON.stringify([key,input]), attempt = attempts.current.get(fingerprint)
  const usesIdempotency = endpoint?.method === 'POST' && endpoint.parameters?.some(row => row.in === 'header' && row.name?.toLowerCase() === 'idempotency-key')
  const snippet = id => input ? requestSnippet({ format: 'curl', url: publicApiOrigin() + input.path, method: input.method, body: input.body,
    credential: '<HUB_API_KEY>', idempotencyKey: usesIdempotency ? id || '<IDEMPOTENCY_KEY>' : undefined,
    accept: input.path === '/api/v1/data/aggregate/search' ? 'text/event-stream' : undefined }) : '请先填写参数'
  const change = patch => setDrafts(current => ({ ...current, [endpoint.id]: { ...draft, ...patch } }))
  async function send() {
    if (lock.current || !key || !input) return
    lock.current = true; setBusy(true); setError(null); setProgress(null)
    const operation = usesIdempotency && attempt || { key: crypto.randomUUID() }
    attempts.current.set(fingerprint, operation)
    try {
      const response = input.path === '/api/v1/data/aggregate/search'
        ? await publicDataApi.aggregateSearchStream(key, input.body, operation.key, (event, data) => {
          if (event === 'search.started') setProgress({ total: data.totalSources, completed: 0, items: 0 })
          if (event === 'source.completed') setProgress(value => value ? { ...value, completed: value.completed + 1, items: value.items + data.items.length } : value)
        })
        : await publicDataApi.productRequest(key, input, usesIdempotency ? operation.key : undefined)
      setResult({ ...response, input, identity:key })
    } catch (failure) { setError(failure) }
    finally { lock.current = false; setBusy(false) }
  }
  if (loadError) return <ErrorState error={loadError} />
  if (!document) return <p role="status">正在读取接口契约…</p>
  return <section className="mih-api-console qp-panel" aria-label={`${product.label}接口调试`}>
    <aside className="mih-api-console-nav"><h2>{product.label}接口</h2><p>{endpoints.length} 项 · 仅手动发送</p>
      {categories.length > 1 ? <DropdownField label="平台与分类" value={category} onChange={setCategory} options={[{value:'',label:'全部平台'},...categories.map(value=>({value,label:value}))]} /> : null}
      <PagedItems key={category} revealItem={revealItem} items={visibleEndpoints} label="产品接口" text={row=>`${row.summary} ${row.path} ${row['x-mx-category'] || ''}`}>{rows=>rows.map(({entry:row})=><button className="mih-api-endpoint-option" key={row.id} type="button" disabled={busy} aria-pressed={endpoint?.id === row.id} onClick={() => {setSelected(row.id);setResult(null);setError(null)}}><small>{row.method}</small><span>{row.summary}</span><code>{row.path}</code></button>)}</PagedItems>
    </aside>
    <div className="mih-api-console-main">{endpoint ? <>
      <header><strong className="mih-api-method">{endpoint.method}</strong> <code>{endpoint.path}</code><a href={publicDocsHref(endpoint['x-mx-doc-path'] || `/docs/${product.docs}`)}>本接口文档 ↗</a></header>
      <h2>{endpoint.summary}</h2><details><summary>契约说明</summary><p>{endpoint.description}</p></details>
      {endpoint.path.startsWith('/api/v1/data/native/') || endpoint.path === '/api/v1/data/ecommerce/products/search' ? <ServicePrice path={endpoint.path} /> : null}
      <p>发送使用当前 Key，服务端复核授权、限额与价格。页面打开和标签切换不会自动调用。</p>
      <form onSubmit={event => { event.preventDefault(); void send() }}>
        {(endpoint.parameters || []).filter(row => ['path', 'query'].includes(row.in)).map(row => <label className="qp-field" key={`${row.in}:${row.name}`}>{row.name}{row.required ? ' *' : ''} · {row.in}<input className="qp-input" disabled={busy} value={values[`${row.in}:${row.name}`] || ''} placeholder={row.description || '留空不传'} onChange={event => change({ values: { ...values, [`${row.in}:${row.name}`]: event.target.value } })} /></label>)}
        {schema.properties?.params && endpoint.path.startsWith('/api/v1/data/native/') ? <NativeParameterFields schema={schema.properties.params} json={json} disabled={busy} onChange={value=>change({json:value})} /> : null}
        {endpoint.requestBody ? <><details><summary>请求体字段</summary><div className="qp-table-wrap"><table className="qp-table"><thead><tr><th>参数</th><th>类型</th><th>说明</th></tr></thead><tbody>{Object.entries(schema.properties || {}).map(([name, field]) => <tr key={name}><td>{name}{schema.required?.includes(name) ? ' *' : ''}</td><td>{field.type || '见契约'}</td><td>{field.description || field.enum?.join(' / ') || '—'}</td></tr>)}</tbody></table></div></details><label className="qp-field">JSON 请求体<textarea aria-label="JSON 请求体" className="qp-input mih-product-json" rows={10} disabled={busy} value={json} onChange={event => change({ json: event.target.value })} /></label></> : null}
        {validation ? <p role="status">{validation}</p> : null}
        <div className="mih-page-actions"><button className="qp-button qp-button--primary" disabled={busy || !key || !input}>{busy ? '正在调用…' : usesIdempotency && attempt ? '重放 / 重试原请求' : '发送请求'}</button>{usesIdempotency && attempt ? <button className="qp-button qp-button--outline" type="button" disabled={busy} onClick={() => { attempts.current.delete(fingerprint); render(value => value + 1) }}>新建请求（再次发送会计量）</button> : null}</div>
        {!usesIdempotency ? <p>此接口未声明请求重放契约，每次发送均为独立调用；是否计费以接口说明为准。</p> : null}
      </form>
      <details><summary>下游 cURL 调用示例（不含密钥）</summary><pre className="mih-api-response">{snippet(attempt?.key)}</pre><button className="qp-button qp-button--outline" type="button" disabled={!input || busy} onClick={async () => {
        const operation = attempt || { key: crypto.randomUUID() }; if (usesIdempotency) attempts.current.set(fingerprint, operation)
        render(value => value + 1); setCopyStatus(await copyText(snippet(operation.key)) ? '已复制；替换 <HUB_API_KEY> 后可调用，复制不会发送请求。' : '复制失败，请手动复制代码。')
      }}>复制示例</button><p role="status">{copyStatus}</p></details>
      {progress ? <p role="status">已完成 {progress.completed} / {progress.total} 个来源 · 收到 {progress.items} 条（最终以去重响应为准）</p> : null}
      {error ? <ErrorState error={error} /> : null}
      <h3>JSON 响应</h3>{result?.identity === key ? <><p>{result.evidence?.requestId} · {result.evidence?.idempotentReplay ? '幂等回放' : '本次返回'}</p><pre className="mih-api-response">{JSON.stringify(result.payload, null, 2)}</pre><AdminExecutionEvidence requestId={result.evidence?.requestId} aggregate={result.input.path === '/api/v1/data/aggregate/search'} /></> : <p>发送后展示实际响应。</p>}
    </> : <p>当前身份暂无可见接口。</p>}</div>
  </section>
}

export function SocialContentOverview() {
  return <section className="qp-panel mih-panel"><h2>从内容到账号，按业务选择接口</h2><p>关键词搜索、内容详情、账号资料、评论、榜单和创作者分析统一通过 Hub 调用。接口调试按当前 Key 展示可访问的接口与价格。</p><p>版本间参数、业务字段和分页方式可能不同。使用当前接口的字段与游标，不把某一平台的翻页规则套到所有平台。</p><div className="mih-page-actions"><a href="#/data-products/search">跨平台聚合搜索 →</a><a href="#/source-catalog">数据源目录 →</a></div><p>本页浏览不采集数据；发送后在接口调试中查看真实 JSON 响应与调用记录。</p></section>
}

function NativeParameterFields({schema,json,disabled,onChange}) {
  let body
  try {body=JSON.parse(json)} catch {return null}
  if(!body.params || typeof body.params!=='object')return null
  const update=(name,field,value)=>{
    const params={...body.params}
    if(value==='') delete params[name]
    else params[name]=field.type==='boolean' ? value==='true' : ['integer','number'].includes(field.type) ? Number(value) : value
    onChange(JSON.stringify({...body,params},null,2))
  }
  return <fieldset className="mih-native-fields" disabled={disabled}><legend>接口参数</legend>{Object.entries(schema.properties || {}).map(([name,field])=> field.enum || field.type==='boolean'
    ? <DropdownField key={name} label={`params.${name}${schema.required?.includes(name)?' *':''}`} disabled={disabled} value={String(body.params[name]??'')} onChange={value=>update(name,field,value)} options={[{value:'',label:'留空不传'},...(field.enum || [true,false]).map(value=>({value:String(value),label:String(value)}))]} hint={field.description || '按本接口参数填写'} />
    : <label className="qp-field" key={name}>{name}{schema.required?.includes(name)?' *':''}<input aria-label={`params.${name}`} className="qp-input" type={['integer','number'].includes(field.type)?'number':'text'} step={field.type==='integer'?'1':'any'} min={field.minimum} max={field.maximum} value={body.params[name]??''} onChange={e=>update(name,field,e.target.value)} placeholder={field.default!==undefined?`默认 ${field.default}`:'留空不传'} /><small>{field.description || '按本接口参数填写'}</small></label>)}</fieldset>
}
