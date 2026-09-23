import { useRef, useState } from 'react'
import { Sparkle, ArrowRight, Fire } from '@phosphor-icons/react'
import { XHS_DISCOVERY_PRODUCTS, discoveryCollection } from '../shared/xiaohongshu-discovery.mjs'
import { publicDataApi, publicDocsHref } from './api.js'
import { DropdownField, ErrorState, PageHeading } from './components.jsx'
import { useDemoApiKey, useDemoAccessSnapshot, DemoCredentialRecheck } from './demo-credentials.jsx'
import { demoAccessIssues } from './demo-access.js'
import { requestUuid } from './request-id.js'
import './xiaohongshu-discovery.css'

const SORT_LABELS = { premium_imp_num: '曝光量', premium_good_read_rate: '阅读率', premium_read_num: '阅读数', premium_engage_num: '互动数', premium_engage_rate: '互动率', premium_like_num: '点赞数', premium_fav_num: '收藏数', premium_cmt_num: '评论数', DAY_3: '最近 3 天', DAY_7: '最近 7 天', DAY_14: '最近 14 天', DAY_30: '最近 30 天' }
const safeUrl = value => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null } catch { return null } }
function NativeValue({ value, depth = 0 }) {
  if (value == null) return <span className="mih-xhs-discovery-muted">未提供</span>
  if (typeof value !== 'object') {
    const link = typeof value === 'string' && safeUrl(value)
    return link ? <a href={link} target="_blank" rel="noreferrer">{value}</a> : <span>{String(value)}</span>
  }
  if (depth >= 2) return <details><summary>展开 {Array.isArray(value) ? `${value.length} 项` : '字段'}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>
  return <dl className="mih-xhs-discovery-fields">{Object.entries(value).map(([key, entry]) => <div key={key}><dt>{key}</dt><dd><NativeValue value={entry} depth={depth + 1} /></dd></div>)}</dl>
}

function DiscoveryResults({ payload, inspiration }) {
  const [visible, setVisible] = useState(20)
  const value = payload?.data?.result
  const collection = discoveryCollection(value)
  if (!payload) return <div className="mih-xhs-discovery-empty"><Sparkle size={36} /><h2>{inspiration ? '打开下一份创作灵感' : '发现值得关注的热门内容'}</h2><p>设置筛选后点击查询。页面与视图切换不会发起采集。</p></div>
  if (payload.meta?.status === 'no_data') return <div className="mih-xhs-discovery-empty"><h2>本页暂无内容</h2><p>这次查询已完成；可调整筛选后发起新查询。</p></div>
  if (!collection) return <section className="qp-panel mih-panel"><h2>本次返回内容</h2><p>未识别到明确的条目列表，按返回字段展示；不推断笔记数量或排行。</p><NativeValue value={value} /></section>
  return <><p className="mih-xhs-discovery-muted">本页 {collection.items.length} 项 · 顺序沿用本次返回，不代表全站排名。指标名称和数值按原字段显示，不推断单位或统计口径。</p>
    <div className="mih-xhs-discovery-grid">{collection.items.slice(0, visible).map((item, index) => {
      const title = item && typeof item === 'object' && [item.title, item.name, item.display_title].find(value => typeof value === 'string' && value)
      return <article className="qp-panel mih-xhs-discovery-card" key={index}><header><span>{inspiration ? <Sparkle size={18} /> : <Fire size={18} />}本页条目 {index + 1}</span></header><h3>{title || (inspiration ? '创作灵感' : '热门内容')}</h3><NativeValue value={item} /></article>
    })}</div>
    {visible < collection.items.length ? <button className="qp-button qp-button--outline" onClick={() => setVisible(count => count + 20)}>展开本页更多条目（不发起查询）</button> : null}
  </>
}

export function XiaohongshuDiscoveryPage({ session, routePath }) {
  const product = XHS_DISCOVERY_PRODUCTS.find(item => routePath === `/data-products/${item.key}`) || XHS_DISCOVERY_PRODUCTS[0]
  return <DiscoveryWorkbench key={product.id} product={product} admin={session?.platformAdmin === true} />
}

function DiscoveryWorkbench({ product, admin }) {
  const [apiKey] = useDemoApiKey()
  const access = useDemoAccessSnapshot()
  const issues = demoAccessIssues(access, product.operation)
  const authorized = admin || !issues.some(issue => issue.kind === 'authorization')
  const [view, setView] = useState('debug')
  const [values, setValues] = useState(() => Object.fromEntries(product.fields.filter(field => field[4] != null).map(field => [field[0], field[4]])))
  const [result, setResult] = useState(null), [error, setError] = useState(null), [busy, setBusy] = useState(false)
  const [, rerender] = useState(0)
  const attempts = useRef(new Map()), lock = useRef(false)
  const body = Object.fromEntries(product.fields.filter(([key]) => values[key] != null && String(values[key]).trim() !== '').map(([key]) => [key, String(values[key]).trim()]))
  const fingerprint = JSON.stringify(body)
  const previous = attempts.current.get(fingerprint)
  const provider = product.id === 'hot_notes' ? 'justone' : 'tikhub'
  const page = result?.payload?.data?.pageInfo
  const currentResult = result?.fingerprint === fingerprint
  const visibleFields = product.fields.filter(([key]) => view === 'debug' || key !== 'cursor')
  const blocked = busy || !apiKey || issues.length > 0 || !authorized
  const send = async (requestBody = body) => {
    if (lock.current || !apiKey || issues.length || !authorized) return
    const identity = JSON.stringify(requestBody)
    const idempotencyKey = attempts.current.get(identity) || `xhs-discovery-${requestUuid()}`
    attempts.current.set(identity, idempotencyKey)
    lock.current = true; setBusy(true); setError(null)
    const request = { method: 'POST', path: product.path, body: requestBody, idempotencyKey }
    try {
      const response = await publicDataApi.xiaohongshuDiscovery(apiKey, product.id, requestBody, { idempotencyKey })
      setResult({ ...response, request, fingerprint: identity })
    } catch (failure) { setError(failure); setResult({ request, fingerprint: identity, status: failure.status }) }
    finally { lock.current = false; setBusy(false) }
  }
  const curl = `curl -X POST "$HUB_URL${product.path}" \\\n  -H "Authorization: Bearer $HUB_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: xhs-discovery-example-001" \\\n  --data '${JSON.stringify(body).replaceAll("'", "'\\''")}'`
  const field = ([key, label, type]) => Array.isArray(type)
    ? <DropdownField key={key} label={label} value={values[key] || ''} options={type.map(value => ({ value, label: SORT_LABELS[value] || value }))} disabled={busy} onChange={value => setValues(current => ({ ...current, [key]: value, cursor: key === 'cursor' ? value : '' }))} />
    : <label className="mih-xhs-discovery-field" key={key}><span>{label}</span><input className="qp-input" value={values[key] || ''} disabled={busy} maxLength={key === 'cursor' ? 8192 : key === 'noteContentCategory' ? 200 : 500} placeholder={key === 'noteContentCategory' ? '内容类目#美妆 或 所属行业#母婴' : key === 'cursor' ? '首页留空；下一页原样使用返回游标' : '留空浏览热门内容'} onChange={event => setValues(current => ({ ...current, [key]: event.target.value, ...(key !== 'cursor' ? { cursor: '' } : {}) }))} /></label>
  return <>
    <PageHeading eyebrow="DATA PRODUCT / XIAOHONGSHU" title={product.label} description={product.description}><a className="qp-button qp-button--outline" href={publicDocsHref(`/docs/${product.key}`)}>接口文档</a><a className="qp-button qp-button--outline" href="#/plans">合同费率</a></PageHeading>
    <nav className="mih-source-section-tabs" aria-label={`${product.label}视图`}><button aria-pressed={view === 'debug'} onClick={() => setView('debug')}>接口调试</button><button aria-pressed={view === 'board'} onClick={() => setView('board')}>{product.tab}</button></nav>
    <section className="qp-panel mih-panel mih-xhs-discovery-query"><header><div><h2>{view === 'debug' ? '请求参数' : product.id === 'hot_notes' ? '发现热门内容' : '热点创作灵感'}</h2>{admin ? <small>内部来源：{provider === 'justone' ? 'JustOne' : 'TikHub'} · 独立操作与调用记录</small> : null}</div><span className="mih-api-method">POST</span></header>
      {view === 'debug' ? <code className="mih-xhs-discovery-path">{product.path}</code> : null}
      {issues.map(issue => <p className="mih-inline-warning" key={`${issue.kind}:${issue.scope}`}>{issue.message}</p>)}
      {issues.length ? <DemoCredentialRecheck /> : null}
      {admin ? <a href={`#/external-platforms?provider=${provider}&operation=${encodeURIComponent(product.operation)}`}>查看此接口运行配置与调用证据 →</a> : null}
      {authorized && visibleFields.length > 0 ? <div className="mih-xhs-discovery-form">{visibleFields.map(field)}</div> : null}
      <div className="mih-page-actions"><button className="qp-button qp-button--primary" disabled={blocked} onClick={() => void send()}>{busy ? '正在查询…' : previous ? '重放 / 重试同一请求' : '查询一页'}</button>
        {result?.payload && currentResult ? <button className="qp-button qp-button--outline" disabled={busy} onClick={() => { attempts.current.delete(fingerprint); setResult(null); rerender(value => value + 1) }}>新建相同查询（可能再次计费）</button> : null}
        {values.cursor ? <button className="qp-button qp-button--outline" disabled={busy} onClick={() => setValues(current => ({ ...current, cursor: '' }))}>返回首页参数</button> : null}</div>
      <p>每次获取一页，成功请求按当前合同计费。相同参数重试保留原请求标识；切换视图不查询。</p>
      {view === 'debug' && authorized ? <details><summary>外部调用示例（密钥不显示）</summary><pre>{curl}</pre></details> : null}
    </section>
    {error ? <ErrorState error={error} /> : null}
    {view === 'debug' ? <section className="qp-panel mih-panel"><h2>JSON 响应</h2><pre className="mih-api-response" tabIndex={0}>{result?.payload ? JSON.stringify(result.payload, null, 2) : error ? `请求失败：${error.code || 'request_failed'}，可使用原请求标识重试。` : '发送请求后查看响应。'}</pre>{result ? <details><summary>本次请求</summary><pre>{JSON.stringify(result.request, null, 2)}</pre></details> : null}</section>
      : <DiscoveryResults key={result?.evidence?.requestId || 'empty'} payload={result?.payload} inspiration={product.id === 'creator_inspiration'} />}
    {page ? <section className="qp-panel mih-panel mih-xhs-discovery-pagination"><div><strong>已获取第 {page.page} 页</strong><p>{({ exhausted: '本页已结束。', limit_reached: '达到 15 页上限，不代表内容耗尽。', unknown: '没有可用的继续信息，停止翻页。', next_page_probe: '结果未说明是否还有数据；点击下一页将查询下一页，可能返回空结果并计费。', continuable: '可按需继续获取下一页。' })[page.paginationStatus]}</p>{!currentResult ? <p>筛选已修改，请先执行当前查询。</p> : null}</div><button className="qp-button qp-button--outline" disabled={blocked || !currentResult || !page.nextCursor} onClick={() => { const next = { ...result.request.body, cursor: page.nextCursor }; setValues(next); void send(next) }}>下一页 <ArrowRight /></button></section> : null}
    {result?.evidence?.requestId ? <small>Request ID：{result.evidence.requestId}</small> : null}
  </>
}
