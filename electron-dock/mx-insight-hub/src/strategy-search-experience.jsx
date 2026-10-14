import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, MagnifyingGlass, ArrowDown, ArrowUpRight, Image as ImageIcon } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { DropdownField, ErrorState, formatDate } from './components.jsx'
import { useDemoApiKey, useDemoIdentity, useDemoAccessSnapshot } from './demo-credentials.jsx'
import { WechatResult } from './wechat-product.jsx'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'
import { requestUuid } from './request-id.js'
import { STRATEGY_DATA_SEARCH_PATH, STRATEGY_SEARCH_PLATFORMS, strategySearchPlatforms, strategySearchBody,
  strategyPageInfo, uncertainStrategySearch, safeStrategyUrl, createStrategySearchCell, strategyRequestFingerprint, strategyOutcomeMatches } from './strategy-search-experience-model.js'

export function useStrategySearchState(strategySession) {
  const identity = useDemoIdentity(), access = useDemoAccessSnapshot()
  const local = useRef(new Map()), store = strategySession instanceof Map ? strategySession : strategySession?.current || local.current
  if (!store.has(identity)) store.set(identity, createStrategySearchCell(strategySearchPlatforms(access)[0]?.platform || ''))
  const cell = store.get(identity), state = useSyncExternalStore(cell.subscribe, cell.getSnapshot)
  return { identity, access, cell, state }
}

export function StrategySearchExperience({ initialResult, strategySession, onResult }) {
  const [key] = useDemoApiKey()
  const { identity, access, cell, state } = useStrategySearchState(strategySession)
  const platforms = strategySearchPlatforms(access)
  const { form, attempts, result, busy, error, checking } = state
  const unresolved = [...attempts.values()].find(attempt => ['sending', 'uncertain'].includes(attempt.state))
  const change = patch => cell.update({ form: { ...form, ...patch }, error: null })
  useEffect(() => {
    if (initialResult?.identity === identity && initialResult.input?.path === STRATEGY_DATA_SEARCH_PATH) {
      const input = initialResult.input.body
      cell.update({ result: initialResult, ...(strategySearchPlatforms(access).some(row => row.platform === input?.platform)
        ? { form: { platform: input.platform, query: input.query || '', pageSize: input.pageSize || 20 } } : {}) })
    }
  }, [cell, identity, initialResult])
  let body = null, validation = ''
  try { body = strategySearchBody(form, platforms) } catch (failure) { validation = failure.message }
  const inputFor = body => ({ method: 'POST', path: STRATEGY_DATA_SEARCH_PATH, body })
  const fingerprint = strategyRequestFingerprint(inputFor(body)), attempt = body && attempts.get(fingerprint)
  const pageInfo = strategyPageInfo(result?.payload)
  const matching = result?.identity === identity && result.input?.body?.platform === body?.platform
    && result.input?.body?.query === body?.query && (result.input?.body?.pageSize || 20) === body?.pageSize
  const canSend = Boolean(key && body && !busy && !checking && !unresolved)
  const currentPlatform = STRATEGY_SEARCH_PLATFORMS.find(row => row.platform === form.platform)
  async function search(requestBody) {
    if (!canSend || !requestBody) return
    const scope = strategyRequestFingerprint(inputFor(requestBody))
    const operation = attempts.get(scope) || { idempotencyKey: requestUuid(), body: requestBody, input: inputFor(requestBody) }
    if (['sending', 'uncertain'].includes(operation.state)) return
    operation.state = 'sending'; attempts.set(scope, operation)
    cell.update({ busy: true, error: null, outcomeNote: null })
    try {
      const response = await publicDataApi.productRequest(key, { method: 'POST', path: STRATEGY_DATA_SEARCH_PATH, body: requestBody }, operation.idempotencyKey)
      operation.state = 'received'; operation.requestId = response.evidence?.requestId
      const delivery = { ...response, identity, input: { method: 'POST', path: STRATEGY_DATA_SEARCH_PATH, body: requestBody } }
      cell.update({ result: delivery }); onResult?.(delivery)
    } catch (failure) {
      operation.state = uncertainStrategySearch(failure) ? 'uncertain' : 'received'
      operation.requestId = failure.requestId
      cell.update({ error: failure })
    } finally { cell.update({ busy: false }) }
  }
  async function checkOutcome() {
    if (!key || !unresolved || busy || checking) return
    cell.update({ checking: true, error: null })
    try {
      const response = await publicDataApi.requestByIdempotencyKey(key, unresolved.idempotencyKey)
      const recorded = response.payload?.data
      // Lookup is owner-scoped and never redispatches. Unknown/not-found stays
      // locked, even after the short replay window of a debugger request.
      if (strategyOutcomeMatches(unresolved, recorded)) {
        unresolved.state = 'received'; unresolved.requestId = recorded.id
        cell.update({ outcomeNote: recorded.status === 'committed' ? '已确认原请求已提交。可显式重放原查询，或新建另一次查询。' : '已确认原预留已释放。再次查询需显式发送，并按当前规则计量。' })
      } else cell.update({ outcomeNote: '原请求仍未确认结束。请保留原请求标识，稍后只读核对使用记录。' })
    } catch (failure) { cell.update({ error: failure }) }
    finally { cell.update({ checking: false }) }
  }
  return <div className="mih-strategy-experience">
    <section className="qp-panel mih-panel mih-strategy-composer" aria-label="策略搜索产品展示">
      <header><div><p className="qp-kicker">统一内容搜索</p><h2>选择平台，搜索内容</h2><p>每次查询一个目标平台，结果保留正文、作者、互动与来源。</p></div><code>POST {STRATEGY_DATA_SEARCH_PATH}</code></header>
      <form onSubmit={event => { event.preventDefault(); void search(body) }}>
        <fieldset disabled={busy || checking || Boolean(unresolved)}>
          <legend>目标平台 <span>{!key ? '请选择调用身份（可预览支持平台）' : access ? `当前 Key 可见 ${platforms.length} 个` : '支持平台 · 发送时验证权限'}</span></legend>
          <div className="mih-strategy-platform-grid">{platforms.map(row => <button type="button" className={`mih-strategy-platform${form.platform === row.platform ? ' is-selected' : ''}`} key={row.platform}
            aria-pressed={form.platform === row.platform} onClick={() => change({ platform: row.platform, ...(row.platform.startsWith('wechat_') ? { pageSize: 20 } : {}) })}>
            <span className={`mih-strategy-platform-mark is-${row.platform}`} aria-hidden="true">{row.mark}</span><span>{row.label}</span>{form.platform === row.platform ? <Check size={15} weight="bold" aria-hidden="true" /> : null}
          </button>)}</div>
          {!platforms.length ? <p>当前 Key 没有可调用的内容搜索平台。请检查 Key 与业务授权。</p> : null}
        </fieldset>
        <div className="mih-strategy-query-row"><label className="qp-field">关键词<input className="qp-input" placeholder={`在${currentPlatform?.label || '目标平台'}搜索关键词`} maxLength={500} value={form.query} disabled={busy || checking || Boolean(unresolved)} onChange={event => change({ query: event.target.value })} /></label>
          <DropdownField label="每页数量" value={String(form.pageSize)} disabled={busy || checking || Boolean(unresolved) || form.platform.startsWith('wechat_')} onChange={value => change({ pageSize: Number(value) })} options={[10, 20, 50, 100].map(value => ({ value: String(value), label: `${value} 条` }))} />
          <button className="qp-button qp-button--primary" disabled={!canSend}><MagnifyingGlass size={18} aria-hidden="true" />{busy ? '正在搜索…' : attempt ? '重放 / 重试原查询' : '搜索'}</button></div>
        <p className="mih-strategy-search-note">仅点击搜索或下一页时调用，按当前账户价格计量。切换平台与标签不会查询。跨平台同时检索请使用<a href="#/data-products/search">聚合搜索 ↗</a>。</p>
        {form.platform.startsWith('wechat_') ? <p className="mih-strategy-search-note">微信返回原生一页，不保证 20 条；使用原生 items、continue_flag 与 cursor，完整业务字段保持不变。</p> : null}
        {form.query && validation ? <p role="status">{validation}</p> : null}
        {attempt && !unresolved ? <div className="mih-strategy-repeat"><span>本页使用 stable 保留首次响应；相同参数沿用原请求标识。</span><button className="qp-button qp-button--outline qp-button--sm" type="button" disabled={busy || checking} onClick={() => { attempts.delete(fingerprint); cell.update({ error: null }) }}>新建相同查询（再次发送会计量）</button></div> : null}
      </form>
      {unresolved ? <div className="mih-strategy-unresolved" role="alert"><strong>原请求结果待核实</strong><p>本次请求保持锁定。超时不代表取消；请先只读核对，避免重复采集和计费。</p><code>{unresolved.idempotencyKey}</code><button className="qp-button qp-button--outline" type="button" disabled={!key || busy || checking} onClick={checkOutcome}>{checking ? '核对中…' : '只读核对原请求状态'}</button>{unresolved.requestId ? <a href={`#/usage?requestId=${encodeURIComponent(unresolved.requestId)}`}>查看使用记录 ↗</a> : null}</div> : null}
      {state.outcomeNote ? <p role="status">{state.outcomeNote}</p> : null}
      {error ? <ErrorState error={error} /> : null}
    </section>
    {result?.identity === identity ? <>
      {!matching ? <p className="qp-muted">以下保留已返回结果；新的平台或关键词需手动搜索。</p> : null}
      <StrategySearchResult payload={result.payload} evidence={result.evidence} />
      {matching && pageInfo?.hasMore && pageInfo.nextCursor ? <button className="qp-button qp-button--outline mih-strategy-next" type="button" disabled={!canSend} onClick={() => search({ ...result.input.body, cursor: pageInfo.nextCursor })}><ArrowDown size={16} aria-hidden="true" />读取下一页（按当前规则计量）</button> : null}
      <details className="qp-panel mih-panel"><summary>完整响应与请求证据</summary><pre className="mih-api-response">{JSON.stringify(result.payload, null, 2)}</pre><AdminExecutionEvidence requestId={result.evidence?.requestId} /></details>
    </> : <section className="qp-panel mih-panel mih-strategy-result-empty"><MagnifyingGlass size={32} weight="duotone" /><h3>搜索内容将在这里展示</h3><p>可按平台查看正文、作者、互动指标与原文链接。</p></section>}
  </div>
}

export function StrategySearchResult({ payload, evidence }) {
  const [images, setImages] = useState(true)
  const data = payload?.data, nativeWechat = payload?.endpoint === 'wechat.search.search'
  const items = !nativeWechat && Array.isArray(data?.items) ? data.items : null
  if (!nativeWechat && !items) return <p>此接口返回原始业务数据，完整字段见响应。</p>
  const label = STRATEGY_SEARCH_PLATFORMS.find(row => row.platform === data?.platform)?.label || (nativeWechat ? '微信搜索' : data?.platform)
  const metricLabels = { likes: '点赞', comments: '评论', shares: '分享', views: '浏览', bookmarks: '收藏' }
  return <section className="qp-panel mih-panel mih-strategy-results" aria-label="内容搜索结果">
    <header><div><p className="qp-kicker">{label}</p><h2>{data?.query || '已返回搜索内容'}</h2><p>{nativeWechat ? '微信原生业务响应' : `本页 ${items.length} 条 · ${data?.status === 'partial' ? '部分返回' : data?.status === 'empty' ? '无结果' : '已返回'}`}</p></div>
      {!nativeWechat ? <label className="mih-strategy-image-toggle"><input type="checkbox" checked={images} onChange={event => setImages(event.target.checked)} /><ImageIcon size={16} aria-hidden="true" />显示已返回图片</label> : null}</header>
    {(data?.warnings || []).length ? <div role="status" className="mih-strategy-result-warnings">{data.warnings.map((warning, index) => <p key={`${warning.code}:${index}`}><strong>{warning.code}</strong> · {warning.message}</p>)}</div> : null}
    {nativeWechat ? <WechatResult payload={payload} /> : !items.length ? <p>本页没有内容。空结果不会自动补页或切换供应商。</p> : <div className="mih-strategy-result-list">{items.map((item, index) => {
      const url = safeStrategyUrl(item.url)
      const image = safeStrategyUrl(item.media?.coverUrl) || (item.media?.images || []).map(safeStrategyUrl).find(Boolean)
      return <article key={`${item.platform}:${item.id || index}`} className="mih-strategy-result-card">
        {images && image ? <img src={image} alt={item.title || '内容配图'} loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true }} /> : null}
        <div><header><strong>{item.author?.name || '作者未提供'}</strong><span>{item.publishedAt ? formatDate(item.publishedAt) : '发布时间未提供'}</span></header>
          {item.title ? <h3>{item.title}</h3> : null}<p className="mih-strategy-result-text">{item.text || '此条目未提供正文。'}</p>
          <div className="mih-strategy-result-metrics">{Object.entries(metricLabels).map(([name, title]) => <span key={name}>{title} <b>{item.metrics?.[name] == null ? '未提供' : item.metrics[name].toLocaleString()}</b></span>)}</div>
          <footer><span>{item.contentType || '内容'}{item.externalId || item.id ? ` · ${item.externalId || item.id}` : ''}</span>{url ? <a href={url} target="_blank" rel="noopener noreferrer">查看原文 <ArrowUpRight size={14} aria-hidden="true" /></a> : <span>原文链接未提供</span>}</footer>
        </div>
      </article>
    })}</div>}
    {evidence ? <p className="mih-strategy-search-note">{evidence.idempotentReplay ? '原请求回放' : '本次返回'}{evidence.sourceMode ? ` · ${evidence.sourceMode}` : ''}{evidence.requestId ? ` · 请求 ${evidence.requestId}` : ''}</p> : null}
  </section>
}
