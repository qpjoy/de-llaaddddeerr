import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, MagnifyingGlass, ArrowDown, ArrowUpRight, Image as ImageIcon } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { DropdownField, ErrorState, formatDate } from './components.jsx'
import { useDemoApiKey, useDemoIdentity, useDemoAccessSnapshot } from './demo-credentials.jsx'
import { WechatResult } from './wechat-product.jsx'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'
import { requestUuid } from './request-id.js'
import { STRATEGY_SEARCH_PLATFORMS, strategySearchPlatforms, strategySearchBody,
  strategyPageInfo, uncertainStrategySearch, safeStrategyUrl, isFacebookPhotoPage, createStrategySearchCell, strategyRequestFingerprint, strategyOutcomeMatches, strategyUnresolvedAttempt, strategyFailureRequestId,
  strategyAccountPlatforms, strategyOperationPath, strategyAccountBody, strategyAccountForm, strategyResultMatches, strategyAccountItem } from './strategy-search-experience-model.js'

export function useStrategySearchState(strategySession) {
  const identity = useDemoIdentity(), access = useDemoAccessSnapshot()
  const local = useRef(new Map()), store = strategySession instanceof Map ? strategySession : strategySession?.current || local.current
  if (!store.has(identity)) store.set(identity, createStrategySearchCell(strategySearchPlatforms(access)[0]?.platform || ''))
  const cell = store.get(identity), state = useSyncExternalStore(cell.subscribe, cell.getSnapshot)
  return { identity, access, cell, state }
}

export function StrategySearchExperience({ initialResult, strategySession, onResult, operation = 'search', onOperationChange }) {
  const [key] = useDemoApiKey()
  const { identity, access, cell, state } = useStrategySearchState(strategySession)
  const accountOperation = operation === 'crawl' || operation === 'user-info'
  const path = strategyOperationPath(operation)
  const platforms = accountOperation ? strategyAccountPlatforms(access, operation) : strategySearchPlatforms(access)
  const { form, attempts, result, busy, checking } = state
  const unresolved = strategyUnresolvedAttempt(attempts, form.platform)
  const error = state.error || unresolved?.error
  const change = patch => cell.update({ form: { ...form, ...patch }, error: null, outcomeNote: null })
  useEffect(() => {
    if (initialResult?.identity === identity && initialResult.input?.path === path) {
      const input = initialResult.input.body
      if (cell.getSnapshot().result === initialResult) return
      cell.update({ result: initialResult, ...(platforms.some(row => row.platform === input?.platform)
        ? { form: { ...cell.getSnapshot().form, platform: input.platform, query: input.query || '', pageSize: input.pageSize || input.count || 20,
          ...(accountOperation ? strategyAccountForm(input) : {}) } } : {}) })
    }
  }, [cell, identity, initialResult, path, access])
  let body = null, validation = ''
  try { body = accountOperation ? strategyAccountBody(operation, form, platforms) : strategySearchBody(form, platforms) } catch (failure) { validation = failure.message }
  const inputFor = body => ({ method: 'POST', path, body })
  const fingerprint = strategyRequestFingerprint(inputFor(body)), attempt = body && attempts.get(fingerprint)
  const pageInfo = strategyPageInfo(result?.payload)
  const matching = body && strategyResultMatches(result, identity, inputFor(body))
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
      const response = await publicDataApi.productRequest(key, inputFor(requestBody), operation.idempotencyKey)
      operation.state = 'received'; operation.requestId = response.evidence?.requestId
      const delivery = { ...response, identity, input: inputFor(requestBody) }
      cell.update({ result: delivery }); onResult?.(delivery)
    } catch (failure) {
      operation.state = uncertainStrategySearch(failure) ? 'uncertain' : 'received'
      operation.requestId = strategyFailureRequestId(failure) || operation.requestId
      operation.error = failure
      if (cell.getSnapshot().form.platform === requestBody.platform) cell.update({ error: failure })
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
        unresolved.state = 'received'; unresolved.requestId = recorded.id; unresolved.error = null
        if (cell.getSnapshot().form.platform === unresolved.body.platform) cell.update({ outcomeNote: recorded.status === 'committed' ? '已确认原请求已提交。可显式重放原查询，或新建另一次查询。' : '已确认原预留已释放。再次查询需显式发送，并按当前规则计量。' })
      } else if (cell.getSnapshot().form.platform === unresolved.body.platform) cell.update({ outcomeNote: '原请求仍未确认结束。请保留原请求标识，稍后只读核对使用记录。' })
    } catch (failure) { if (cell.getSnapshot().form.platform === unresolved.body.platform) cell.update({ error: failure }) }
    finally { cell.update({ checking: false }) }
  }
  return <div className="mih-strategy-experience">
    <section className="qp-panel mih-panel mih-strategy-composer" aria-label="策略搜索产品展示">
      <header><div><p className="qp-kicker">{accountOperation ? '账号数据' : '统一内容搜索'}</p><h2>{operation === 'crawl' ? '获取账号发布的内容' : operation === 'user-info' ? '查询账号公开资料' : '选择平台，搜索内容'}</h2><p>{accountOperation ? '每次查询一个平台的已知账号，完整字段保留在响应中。' : '每次查询一个目标平台，结果保留正文、作者、互动与来源。'}</p></div><code>POST {path}</code></header>
      {onOperationChange ? <DropdownField label="业务接口" value={operation} onChange={onOperationChange}
        options={[{ value: 'search', label: '内容搜索' }, { value: 'crawl', label: '账号内容' }, { value: 'user-info', label: '账号资料' }]} /> : null}
      <form onSubmit={event => { event.preventDefault(); void search(body) }}>
        <fieldset>
          <legend>目标平台 <span>{!key ? '请选择调用身份（可预览支持平台）' : access ? `当前 Key 可见 ${platforms.length} 个` : '支持平台 · 发送时验证权限'}</span></legend>
          <div className="mih-strategy-platform-grid">{platforms.map(row => <button type="button" className={`mih-strategy-platform${form.platform === row.platform ? ' is-selected' : ''}`} key={row.platform}
            aria-pressed={form.platform === row.platform} onClick={() => {
              const pending = strategyUnresolvedAttempt(attempts, row.platform), original = pending?.body
              change({ platform: row.platform, ...(row.platform.startsWith('wechat_') ? { pageSize: 20 } : {}),
                ...(original ? { query: original.query || original.keyword || form.query, pageSize: original.pageSize || original.count || form.pageSize,
                  ...(accountOperation ? strategyAccountForm(original) : {}) } : {}) })
            }}>
            <span className={`mih-strategy-platform-mark is-${row.platform}`} aria-hidden="true">{row.mark}</span><span>{row.label}</span>{form.platform === row.platform ? <Check size={15} weight="bold" aria-hidden="true" /> : null}
          </button>)}</div>
          {!platforms.length ? <p>当前 Key 没有可调用的{accountOperation ? '账号接口' : '内容搜索'}平台。请检查 Key 与业务授权。</p> : null}
        </fieldset>
        {accountOperation ? <DropdownField label="账号标识字段" value={form.accountField || 'username'} disabled={busy || checking || Boolean(unresolved)} onChange={accountField => change({ accountField })}
          options={[{ value: 'username', label: 'username · 用户名' }, { value: 'userId', label: 'userId · 平台账号 ID' }, { value: 'user_id', label: 'user_id · 兼容字段' }, { value: 'uid', label: 'uid · 兼容字段' }]} /> : null}
        <div className="mih-strategy-query-row"><label className="qp-field">{accountOperation ? '账号标识' : '关键词'}<input className="qp-input" placeholder={accountOperation ? '输入该平台的用户名或账号 ID' : `在${currentPlatform?.label || '目标平台'}搜索关键词`} maxLength={500} value={accountOperation ? form.account || '' : form.query} disabled={busy || checking || Boolean(unresolved)} onChange={event => change(accountOperation ? { account: event.target.value } : { query: event.target.value })} /></label>
          {operation !== 'user-info' ? <DropdownField label="每页数量" value={String(form.pageSize)} disabled={busy || checking || Boolean(unresolved) || form.platform.startsWith('wechat_')} onChange={value => change({ pageSize: Number(value) })} options={(accountOperation ? [10, 20, 50, 100, 500] : [10, 20, 50, 100]).map(value => ({ value: String(value), label: `${value} 条` }))} /> : null}
          <button className="qp-button qp-button--primary" disabled={!canSend}><MagnifyingGlass size={18} aria-hidden="true" />{busy ? '正在查询…' : attempt ? '重放 / 重试原查询' : accountOperation ? '查询账号' : '搜索'}</button></div>
        <p className="mih-strategy-search-note">仅点击查询或下一页时调用，按当前账户价格计量。切换业务接口、平台与标签不会查询。{accountOperation ? '批量账号、活动类型与平台参数可在接口调试中提交。' : <>跨平台同时检索请使用<a href="#/data-products/search">聚合搜索 ↗</a>。</>}</p>
        {form.platform.startsWith('wechat_') ? <p className="mih-strategy-search-note">微信返回原生一页，不保证 20 条；使用原生 items、continue_flag 与 cursor，完整业务字段保持不变。</p> : null}
        {(accountOperation ? form.account : form.query) && validation ? <p role="status">{validation}</p> : null}
        {attempt && !unresolved ? <div className="mih-strategy-repeat"><span>{accountOperation ? '相同参数沿用原请求标识；按接口规则回放已有结果。' : '本页使用 stable 保留首次响应；相同参数沿用原请求标识。'}</span><button className="qp-button qp-button--outline qp-button--sm" type="button" disabled={busy || checking} onClick={() => { attempts.delete(fingerprint); cell.update({ error: null }) }}>新建相同查询（再次发送会计量）</button></div> : null}
      </form>
      {unresolved ? <div className="mih-strategy-unresolved" role="alert"><strong>原请求结果待核实</strong><p>此平台的原请求保持锁定。超时不代表取消；请先只读核对，避免重复采集和计费。可选择其他平台，切换不会发送请求。</p><p>幂等键 <code>{unresolved.idempotencyKey}</code></p>{unresolved.requestId ? <p>Hub 请求 ID <code>{unresolved.requestId}</code></p> : null}<button className="qp-button qp-button--outline" type="button" disabled={!key || busy || checking} onClick={checkOutcome}>{checking ? '核对中…' : '只读核对原请求状态'}</button>{unresolved.requestId ? <a href={`#/usage?requestId=${encodeURIComponent(unresolved.requestId)}`}>查看使用记录 ↗</a> : null}</div> : null}
      {state.outcomeNote ? <p role="status">{state.outcomeNote}</p> : null}
      {error ? <ErrorState error={unresolved?.requestId && error === unresolved.error ? { ...error, message: error.message, requestId: unresolved.requestId } : error} /> : null}
    </section>
    {result?.identity === identity ? <>
      {!matching ? <p className="qp-muted">以下保留已返回结果；更改接口、平台或查询条件后需手动查询。</p> : null}
      <StrategySearchResult payload={result.payload} evidence={result.evidence} operation={result.input?.path.endsWith('/user-info') ? 'user-info' : result.input?.path.endsWith('/crawl') ? 'crawl' : 'search'} />
      {matching && pageInfo?.hasMore && pageInfo.nextCursor ? <button className="qp-button qp-button--outline mih-strategy-next" type="button" disabled={!canSend} onClick={() => search({ ...result.input.body, cursor: pageInfo.nextCursor })}><ArrowDown size={16} aria-hidden="true" />读取下一页（按当前规则计量）</button> : null}
      <details className="qp-panel mih-panel mih-strategy-response"><summary>完整响应与请求证据</summary><pre className="mih-api-response" role="region" aria-label="完整响应 JSON" tabIndex={0}>{JSON.stringify(result.payload, null, 2)}</pre><AdminExecutionEvidence requestId={result.evidence?.requestId} /></details>
    </> : <section className="qp-panel mih-panel mih-strategy-result-empty"><MagnifyingGlass size={32} weight="duotone" /><h3>{operation === 'user-info' ? '账号资料将在这里展示' : accountOperation ? '账号内容将在这里展示' : '搜索内容将在这里展示'}</h3><p>{operation === 'user-info' ? '查看账号名称、简介、公开指标和主页链接。' : '可按平台查看正文、作者、互动指标与原文链接。'}</p></section>}
  </div>
}

export function StrategySearchResult({ payload, evidence, operation = 'search' }) {
  const [images, setImages] = useState(true)
  const data = payload?.data, nativeWechat = payload?.endpoint === 'wechat.search.search'
  const items = !nativeWechat && Array.isArray(data?.items) ? data.items.map(item => strategyAccountItem(item, operation)) : null
  if (!nativeWechat && !items) return <p>此接口返回原始业务数据，完整字段见响应。</p>
  if (operation === 'user-info') return <StrategyAccountProfiles items={items || []} data={data} evidence={evidence} />
  const label = STRATEGY_SEARCH_PLATFORMS.find(row => row.platform === data?.platform)?.label || (nativeWechat ? '微信搜索' : data?.platform)
  const metricLabels = { likes: '点赞', comments: '评论', shares: '分享', views: '浏览', bookmarks: '收藏' }
  return <section className="qp-panel mih-panel mih-strategy-results" aria-label="内容搜索结果">
    <header><div><p className="qp-kicker">{label}</p><h2>{data?.query || '已返回搜索内容'}</h2><p>{nativeWechat ? '微信原生业务响应' : `本页 ${items.length} 条 · ${!items.length ? '本页无内容' : data?.status === 'partial' ? '部分返回' : '已返回'}`}</p></div>
      {!nativeWechat ? <label className="mih-strategy-image-toggle"><input type="checkbox" checked={images} onChange={event => setImages(event.target.checked)} /><ImageIcon size={16} aria-hidden="true" />显示已返回图片</label> : null}</header>
    {(data?.warnings || []).length ? <div role="status" className="mih-strategy-result-warnings">{data.warnings.map((warning, index) => <p key={`${warning.code}:${index}`}><strong>{warning.code}</strong> · {warning.message}</p>)}</div> : null}
    {nativeWechat ? <WechatResult payload={payload} /> : !items.length ? <p>{data?.pageInfo?.hasMore && data?.pageInfo?.nextCursor ? '本页没有可展示的内容，但响应仍提供后续游标；可手动读取下一页，不能据此判定搜索结束。' : '本页没有可展示的内容；后续状态以响应中的游标与警告为准。'}</p> : <div className="mih-strategy-result-list">{items.map((item, index) => {
      const url = safeStrategyUrl(item.url)
      const imageUrls = [item.media?.coverUrl, ...(item.media?.images || item.imageUrls || [])].map(safeStrategyUrl).filter(Boolean)
      const photoPages = data?.platform === 'facebook' ? [...new Set(imageUrls.filter(isFacebookPhotoPage))] : []
      const image = imageUrls.find(value => !photoPages.includes(value))
      return <article key={`${item.platform}:${item.id || index}`} className="mih-strategy-result-card">
        {images && image ? <img src={image} alt={item.title || '内容配图'} loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true }} /> : null}
        <div><header><strong>{item.author?.name || '作者未提供'}</strong><span>{item.publishedAt ? formatDate(item.publishedAt) : '发布时间未提供'}</span></header>
          {item.title ? <h3>{item.title}</h3> : null}<p className="mih-strategy-result-text">{item.text || item.content || '此条目未提供正文。'}</p>
          <div className="mih-strategy-result-metrics">{Object.entries(metricLabels).map(([name, title]) => {
            const value = name === 'comments' ? item.metrics?.comments ?? item.metrics?.replies : item.metrics?.[name]
            return <span key={name}>{title} <b>{value == null ? '未提供' : value.toLocaleString()}</b></span>
          })}</div>
          <footer><span>{item.contentType || '内容'}{item.externalId || item.id ? ` · ${item.externalId || item.id}` : ''}</span><span className="mih-strategy-media-links">{photoPages.map((href, index) => <a key={href} href={href} target="_blank" rel="noopener noreferrer">查看配图{photoPages.length > 1 ? ` ${index + 1}` : ''} <ArrowUpRight size={14} aria-hidden="true" /></a>)}{url ? <a href={url} target="_blank" rel="noopener noreferrer">查看原文 <ArrowUpRight size={14} aria-hidden="true" /></a> : <span>原文链接未提供</span>}</span></footer>
        </div>
      </article>
    })}</div>}
    {evidence ? <p className="mih-strategy-search-note">{evidence.idempotentReplay ? '原请求回放' : '本次返回'}{evidence.sourceMode ? ` · ${evidence.sourceMode}` : ''}{evidence.requestId ? ` · 请求 ${evidence.requestId}` : ''}</p> : null}
  </section>
}

function StrategyAccountProfiles({ items, data, evidence }) {
  const metrics = { followers: '粉丝', following: '关注', posts: '内容数' }
  return <section className="qp-panel mih-panel mih-strategy-results" aria-label="账号资料结果">
    <header><div><p className="qp-kicker">账号资料 · {data?.platform}</p><h2>已返回 {items.length} 个账号</h2><p>数据来自本次响应；未提供的字段不会显示为零。</p></div></header>
    {(data?.warnings || []).map((warning, index) => <p role="status" key={index}>{warning.code} · {warning.message}</p>)}
    {items.length ? <div className="mih-strategy-result-list">{items.map((item, index) => {
      const avatar = safeStrategyUrl(item.avatarUrl), url = safeStrategyUrl(item.url)
      return <article className="mih-strategy-result-card" key={`${item.platform}:${item.id || item.userId || index}`}>
        {avatar ? <img src={avatar} alt="账号头像" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true }} /> : null}
        <div><header><strong>{item.name || item.username || '名称未提供'}</strong><span>{item.username ? `@${item.username}` : '用户名未提供'}</span></header>
          <p className="mih-strategy-result-text">{item.description || '简介未提供'}</p>
          <div className="mih-strategy-result-metrics">{Object.entries(metrics).map(([field, label]) => <span key={field}>{label} <b>{item[field] == null ? '未提供' : item[field].toLocaleString()}</b></span>)}</div>
          <footer><span>{item.platform || data?.platform} · {item.userId || item.id || '账号 ID 未提供'}</span>{url ? <a href={url} target="_blank" rel="noopener noreferrer">查看主页 <ArrowUpRight size={14} aria-hidden="true" /></a> : null}</footer>
        </div>
      </article>
    })}</div> : <p>本次未返回可展示的账号资料；请查看完整响应和警告。</p>}
    {evidence?.requestId ? <p className="mih-strategy-search-note">请求 {evidence.requestId}</p> : null}
  </section>
}
