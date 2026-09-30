import { useRef, useState } from 'react'
import { MagnifyingGlass, SlidersHorizontal } from '@phosphor-icons/react'
import { WEB_SEARCH_PATH } from '../shared/web-search.mjs'
import { publicDataApi } from './api.js'
import { useDemoApiKey, useDemoIdentity } from './demo-credentials.jsx'
import { ErrorState } from './components.jsx'
import { ServicePrice } from './service-price.jsx'
import { WebSearchResult } from './web-search-result.jsx'
import { buildWebSearchBody, matchingSearchProviders, SEARCH_RESOURCE_LABELS, SEARCH_RESOURCE_MAX } from './web-search-form.js'

export function WebSearchExperience({ providers, loading, result, onResult, onShowChannels }) {
  const [key] = useDemoApiKey(), identity = useDemoIdentity()
  const [form, setForm] = useState({ query: '', provider: '', types: ['web'], limits: { web: 10, image: 10, video: 5 }, sites: '', from: '', to: '', recency: '', edition: 'standard' })
  const [busy, setBusy] = useState(false), [error, setError] = useState(null), [, render] = useState(0)
  const attempts = useRef(new Map()), lock = useRef(false)
  const change = patch => setForm(current => ({ ...current, ...patch }))
  let body = null, validation = ''
  try { body = buildWebSearchBody(form) } catch (failure) { validation = failure.message }
  // Signed credentials renew. The durable selected Key identity must retain its retry intent.
  const fingerprint = JSON.stringify([identity, body]), attempt = body && attempts.current.get(fingerprint)
  const matching = matchingSearchProviders(providers, body), available = matching.filter(provider => provider.ready)
  const canSend = Boolean(key && body && (attempt || !loading && available.length))
  async function search() {
    if (lock.current || !canSend) return
    lock.current = true; setBusy(true); setError(null)
    const operation = attempt || crypto.randomUUID()
    attempts.current.set(fingerprint, operation)
    try {
      const response = await publicDataApi.productRequest(key, { method: 'POST', path: WEB_SEARCH_PATH, body }, operation)
      onResult({ ...response, identity, input: { body } })
    } catch (failure) { setError(failure) }
    finally { lock.current = false; setBusy(false) }
  }
  return <section className="mih-search-experience" aria-label="Web Search 产品展示">
    <header className="mih-search-intro"><h2>从一个问题，找到全网线索</h2><p>选择搜索渠道，获取带来源的搜索结果。</p></header>
    <form onSubmit={event => { event.preventDefault(); void search() }}>
      <fieldset className="mih-search-composer" disabled={busy}>
        <legend className="mih-search-sr-only">搜索问题与资源</legend>
        <label className="mih-search-sr-only" htmlFor="mih-web-search-query">问题或关键词</label>
        <textarea id="mih-web-search-query" value={form.query} maxLength={2000} rows={4} placeholder="输入想了解的问题或关键词" onChange={event => change({ query: event.target.value })} />
        <div className="mih-search-toolbar">
          <label><span className="mih-search-sr-only">搜索渠道</span><select className="qp-input" aria-label="搜索渠道" value={form.provider} onChange={event => change({ provider: event.target.value })}><option value="">自动选择渠道</option>{providers.map(provider => <option key={provider.key} value={provider.key}>{provider.label}{provider.ready ? '' : ' · 未就绪'}</option>)}</select></label>
          <div className="mih-search-resources">{Object.entries(SEARCH_RESOURCE_LABELS).map(([type, label]) => <label key={type}><input type="checkbox" checked={form.types.includes(type)} onChange={event => change({ types: event.target.checked ? [...form.types, type] : form.types.filter(value => value !== type) })} />{label}</label>)}</div>
          <button type="submit" className="qp-button qp-button--primary" disabled={busy || !canSend}><MagnifyingGlass size={18} aria-hidden="true" />{busy ? '正在搜索…' : attempt ? '重放 / 重试' : '搜索'}</button>
        </div>
      </fieldset>
      <div className="mih-search-options-row"><details className="mih-search-filters"><summary><SlidersHorizontal size={16} aria-hidden="true" />更多筛选</summary>
        <fieldset disabled={busy} className="mih-search-filter-grid"><legend className="mih-search-sr-only">高级搜索筛选</legend>
          {form.types.map(type => <label className="qp-field" key={type}>{SEARCH_RESOURCE_LABELS[type]}数量（1–{SEARCH_RESOURCE_MAX[type]}）<input className="qp-input" type="number" min={1} max={SEARCH_RESOURCE_MAX[type]} value={form.limits[type]} onChange={event => change({ limits: { ...form.limits, [type]: event.target.value } })} /></label>)}
          <label className="qp-field">站点域名<input className="qp-input" placeholder="example.com，多个用逗号分隔" value={form.sites} onChange={event => change({ sites: event.target.value })} /></label>
          <label className="qp-field">时间范围<select className="qp-input" value={form.recency} onChange={event => change({ recency: event.target.value })}>{[['', '不限时间'], ['week', '最近一周'], ['month', '最近一月'], ['semiyear', '最近半年'], ['year', '最近一年']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="qp-field">开始日期<input type="date" className="qp-input" value={form.from} onChange={event => change({ from: event.target.value })} /></label>
          <label className="qp-field">结束日期<input type="date" className="qp-input" value={form.to} onChange={event => change({ to: event.target.value })} /></label>
          <label className="qp-field">搜索版本<select className="qp-input" value={form.edition} onChange={event => change({ edition: event.target.value })}><option value="standard">Standard</option><option value="lite">Lite</option></select></label>
          <p>图片、视频、站点、日期及 Lite 版本当前由百度渠道支持；其他渠道最多返回 20 条网页结果。筛选项不会被静默忽略。</p>
        </fieldset>
      </details><span>仅点击搜索时调用，按当前账户价格计量。</span></div>
      {form.query && validation ? <p className="mih-search-feedback" role="status">{validation}</p> : null}
      {body && !loading && !available.length && !attempt ? <p className="mih-search-feedback" role="status">{matching.length ? '支持这些参数的渠道尚未就绪。' : '当前授权渠道不支持这些参数，请调整筛选或选择其他渠道。'}<button className="qp-button qp-button--ghost qp-button--sm" type="button" onClick={onShowChannels}>查看渠道状态</button></p> : null}
      {attempt ? <div className="mih-search-retry"><span>相同参数沿用原请求，空结果与失败也不会自动改换渠道。</span><button className="qp-button qp-button--outline qp-button--sm" type="button" disabled={busy} onClick={() => { attempts.current.delete(fingerprint); setError(null); render(value => value + 1) }}>新建相同查询（再次发送会计量）</button></div> : null}
    </form>
    <div className="mih-search-suggestions"><span>试试搜索</span>{['人工智能行业最新进展', '新能源汽车市场动态', '数据分析与商业智能'].map(query => <button className="qp-button qp-button--ghost qp-button--sm" key={query} type="button" disabled={busy} onClick={() => change({ query })}>{query} ↗</button>)}</div>
    <details className="mih-search-price"><summary>查看当前调用价格</summary><ServicePrice path={WEB_SEARCH_PATH} /></details>
    {error ? <ErrorState error={error} /> : null}
    <div className="mih-search-result-area" aria-busy={busy}>
      {busy ? <p role="status">正在搜索，请稍候。切换页签不会再次发送请求。</p> : null}
      {result && (busy || error || result.payload?.data?.query !== body?.query) ? <p className="mih-search-evidence">以下保留上一次成功返回的结果，查询词见结果标题。</p> : null}
      {result ? <><WebSearchResult key={result.evidence?.requestId || result.payload?.meta?.capturedAt} payload={result.payload} /><p className="mih-search-evidence">{result.evidence?.idempotentReplay ? '原请求回放' : '本次返回'}{result.evidence?.requestId ? ` · 请求 ${result.evidence.requestId}` : ''}</p></> : <div className="mih-search-empty"><MagnifyingGlass size={30} aria-hidden="true" /><h3>搜索结果将在这里展示</h3><p>保留来源链接，便于继续阅读与核对。</p></div>}
    </div>
  </section>
}
