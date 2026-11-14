import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Check, MagnifyingGlass, ArrowDown, ArrowUpRight, Image as ImageIcon } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { STRATEGY_OPERATION_OPTIONS } from './strategy-search-model.js'
import { DropdownField, ErrorState, formatDate } from './components.jsx'
import { useDemoApiKey, useDemoIdentity, useDemoAccessSnapshot } from './demo-credentials.jsx'
import { WechatResult } from './wechat-product.jsx'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'
import { requestUuid } from './request-id.js'
import { commentRoutePlatforms } from '../server/contracts/comment-routes.mjs'

const COMMENT_PLATFORMS = new Set(commentRoutePlatforms('post-comments'))
import { STRATEGY_SEARCH_PLATFORMS, strategySearchPlatforms, strategySearchBody, strategySearchForm,
  strategyPageInfo, uncertainStrategySearch, safeStrategyUrl, isFacebookPhotoPage, createStrategySearchCell, strategyRequestFingerprint, strategyOutcomeMatches, strategyUnresolvedAttempt, strategyFailureRequestId,
  strategyEndedUnknownMatches, prepareStrategyNewQuery,
  strategyPostDetailPlatforms, strategyPostDetailBody, strategyAccountPlatforms, strategyOperationPath, strategyAccountBody, strategyAccountForm, strategyResultMatches, strategyAccountItem } from './strategy-search-experience-model.js'

export function useStrategySearchState(strategySession) {
  const identity = useDemoIdentity(), access = useDemoAccessSnapshot()
  const local = useRef(new Map()), store = strategySession instanceof Map ? strategySession : strategySession?.current || local.current
  if (!store.has(identity)) store.set(identity, createStrategySearchCell(strategySearchPlatforms(access)[0]?.platform || ''))
  const cell = store.get(identity), state = useSyncExternalStore(cell.subscribe, cell.getSnapshot)
  return { identity, access, cell, state }
}

export function StrategySearchExperience({ initialResult, strategySession, onResult, operation = 'search', onOperationChange, onOpenComments }) {
  const [key] = useDemoApiKey()
  const { identity, access, cell, state } = useStrategySearchState(strategySession)
  const accountOperation = operation === 'crawl' || operation === 'user-info'
  const detail = operation === 'post-detail'
  const path = strategyOperationPath(operation)
  const view = useRef(null)
  view.current = { cell, identity, key, path }
  const currentView = () => view.current.cell === cell && view.current.identity === identity && view.current.key === key && view.current.path === path
  const platforms = detail ? strategyPostDetailPlatforms(access) : accountOperation ? strategyAccountPlatforms(access, operation) : strategySearchPlatforms(access)
  const { form, attempts, result, busy, checking } = state
  useEffect(() => {
    if (detail && form.platform !== 'threads') cell.update({ form: { ...cell.getSnapshot().form, platform: 'threads' }, error: null, outcomeNote: null })
  }, [detail, form.platform, cell])
  const unresolved = strategyUnresolvedAttempt(attempts, form.platform)
  const canPrepareUnknown = operation === 'search' && strategyEndedUnknownMatches(unresolved, unresolved?.checkedOutcome)
  const unknownHistory = [...state.attemptHistory.values()].filter(row => row.body?.platform === form.platform
    && strategyEndedUnknownMatches(row, row.checkedOutcome))
  const error = state.error || unresolved?.error
  const change = patch => cell.update({ form: { ...form, ...patch }, error: null, outcomeNote: null })
  const twitterSearch = operation === 'search' && form.platform === 'twitter'
  const twitterAccount = accountOperation && form.platform === 'twitter'
  const threadsAccount = accountOperation && form.platform === 'threads'
  const twitterParams = form.twitterParams === null ? null : form.twitterParams || { category: 'Latest' }
  const changeTwitter = (name, value) => {
    const params = { ...twitterParams }
    if (value === undefined) delete params[name]
    else params[name] = value
    change({ twitterParams: params })
  }
  const restoreFields = input => detail ? { postTarget: input.url || input.contentId || '' } : accountOperation ? strategyAccountForm(input) : strategySearchForm(input)
  const formField = detail ? 'postTarget' : accountOperation ? 'account' : 'query'
  useEffect(() => {
    if (initialResult?.identity === identity && initialResult.input?.path === path) {
      const input = initialResult.input.body
      if (cell.getSnapshot().result === initialResult) return
      cell.update({ result: initialResult, ...(platforms.some(row => row.platform === input?.platform)
        ? { form: { ...cell.getSnapshot().form, platform: input.platform, query: input.query || '', pageSize: input.pageSize || input.count || 20,
          ...restoreFields(input) } } : {}) })
    }
  }, [cell, identity, initialResult, path, access])
  let body = null, validation = ''
  try { body = detail ? strategyPostDetailBody(form, platforms) : accountOperation ? strategyAccountBody(operation, form, platforms) : strategySearchBody(form, platforms) } catch (failure) { validation = failure.message }
  const inputFor = body => ({ method: 'POST', path, body })
  const fingerprint = strategyRequestFingerprint(inputFor(body)), attempt = body && attempts.get(fingerprint)
  const pageInfo = strategyPageInfo(result?.payload)
  const matching = body && strategyResultMatches(result, identity, inputFor(body))
  const canSend = Boolean(key && body && !busy && !checking && !unresolved)
  const currentPlatform = STRATEGY_SEARCH_PLATFORMS.find(row => row.platform === form.platform)
  async function search(requestBody) {
    const current = cell.getSnapshot()
    if (!currentView() || !canSend || !requestBody || current.busy || current.checking
      || strategyUnresolvedAttempt(current.attempts, requestBody.platform)) return
    const scope = strategyRequestFingerprint(inputFor(requestBody))
    const operation = attempts.get(scope) || { idempotencyKey: requestUuid(), body: requestBody, input: inputFor(requestBody) }
    if (['sending', 'uncertain'].includes(operation.state)) return
    operation.state = 'sending'; attempts.set(scope, operation)
    const currentAttempt = () => cell.getSnapshot().attempts.get(scope) === operation
    cell.update({ busy: true, error: null, outcomeNote: null })
    try {
      const response = await publicDataApi.productRequest(key, inputFor(requestBody), operation.idempotencyKey)
      operation.state = 'received'; operation.requestId = response.evidence?.requestId
      const delivery = { ...response, identity, input: inputFor(requestBody) }
      if (currentAttempt()) { cell.update({ result: delivery }); if (currentView()) onResult?.(delivery) }
    } catch (failure) {
      operation.state = uncertainStrategySearch(failure) ? 'uncertain' : 'received'
      operation.requestId = strategyFailureRequestId(failure) || operation.requestId
      operation.error = failure
      if (currentAttempt() && cell.getSnapshot().form.platform === requestBody.platform) cell.update({ error: failure })
    } finally { if (currentAttempt()) cell.update({ busy: false }) }
  }
  async function checkOutcome() {
    const current = cell.getSnapshot()
    if (!currentView() || !key || !unresolved || current.busy || current.checking
      || strategyUnresolvedAttempt(current.attempts, current.form.platform) !== unresolved) return
    const scope = strategyRequestFingerprint(unresolved.input)
    const currentAttempt = () => cell.getSnapshot().attempts.get(scope) === unresolved && unresolved.state === 'uncertain'
    unresolved.checkedOutcome = null
    cell.update({ checking: true, error: null })
    try {
      const response = await publicDataApi.requestByIdempotencyKey(key, unresolved.idempotencyKey)
      const recorded = response.payload?.data
      if (!currentAttempt()) return
      // Lookup never redispatches or settles unknown. A separately prepared
      // Threads search still needs an explicit submit and normal admission.
      if (strategyOutcomeMatches(unresolved, recorded)) {
        unresolved.state = 'received'; unresolved.requestId = recorded.id; unresolved.error = null
        if (cell.getSnapshot().form.platform === unresolved.body.platform) cell.update({ outcomeNote: recorded.status === 'committed' ? '已确认原请求已提交。可显式重放原查询，或新建另一次查询。' : '已确认原预留已释放。再次查询需显式发送，并按当前规则计量。' })
      } else if (strategyEndedUnknownMatches(unresolved, recorded)) {
        unresolved.checkedOutcome = { ...recorded }
        if (cell.getSnapshot().form.platform === unresolved.body.platform) cell.update({ outcomeNote: '原请求已记录为 unknown 且有结束时间；结果和费用仍未知。可以准备新查询，发送时仍会检查当前权限、余额和并发限制。' })
      } else if (cell.getSnapshot().form.platform === unresolved.body.platform) cell.update({ outcomeNote: '原请求状态尚不足以准备新查询。请保留原请求标识，稍后只读核对使用记录。' })
    } catch (failure) { if (currentAttempt() && cell.getSnapshot().form.platform === unresolved.body.platform) cell.update({ error: failure }) }
    finally { cell.update({ checking: false }) }
  }
  function prepare(attempt) {
    if (currentView()) prepareStrategyNewQuery(cell, attempt)
  }
  return <div className="mih-strategy-experience">
    <section className="qp-panel mih-panel mih-strategy-composer" aria-label="策略搜索产品展示">
      <header><div><p className="qp-kicker">{detail ? '帖子详情' : accountOperation ? '账号数据' : '统一内容搜索'}</p><h2>{detail ? '查询一篇 Threads 帖子' : operation === 'crawl' ? '获取账号发布的内容' : operation === 'user-info' ? '查询账号公开资料' : '选择平台，搜索内容'}</h2><p>{detail ? '输入帖子 ID、短码或原文链接。' : accountOperation ? '每次查询一个平台的已知账号，完整字段保留在响应中。' : '每次查询一个目标平台，结果保留正文、作者、互动与来源。'}</p></div><code>POST {path}</code></header>
      {onOperationChange ? <DropdownField label="业务接口" value={operation} onChange={onOperationChange}
        options={STRATEGY_OPERATION_OPTIONS} /> : null}
      <form onSubmit={event => { event.preventDefault(); void search(body) }}>
        <fieldset>
          <legend>目标平台 <span>{!key ? '请选择调用身份（可预览支持平台）' : access ? `当前 Key 可见 ${platforms.length} 个` : '支持平台 · 发送时验证权限'}</span></legend>
          <div className="mih-strategy-platform-grid">{platforms.map(row => <button type="button" className={`mih-strategy-platform${form.platform === row.platform ? ' is-selected' : ''}`} key={row.platform}
            aria-pressed={form.platform === row.platform} onClick={() => {
              const pending = strategyUnresolvedAttempt(attempts, row.platform), original = pending?.body
              change({ platform: row.platform, ...(row.platform.startsWith('wechat_') ? { pageSize: 20 } : {}),
                ...(accountOperation && row.platform === 'threads' && form.platform !== 'threads' && !original
                  ? { accountField: 'username', account: 'threads' } : {}),
                ...(original ? { query: original.query || original.keyword || form.query, pageSize: original.pageSize || original.count || form.pageSize,
                  ...restoreFields(original) } : {}) })
            }}>
            <span className={`mih-strategy-platform-mark is-${row.platform}`} aria-hidden="true">{row.mark}</span><span>{row.label}</span>{form.platform === row.platform ? <Check size={15} weight="bold" aria-hidden="true" /> : null}
          </button>)}</div>
          {!platforms.length ? <p>当前 Key 没有可调用的{detail ? '帖子详情' : accountOperation ? '账号接口' : '内容搜索'}平台。请检查 Key 与业务授权。</p> : null}
        </fieldset>
        {twitterAccount ? <DropdownField label="账号查询方式" value={form.twitterAccountField || 'auto'} disabled={busy || checking || Boolean(unresolved)} onChange={twitterAccountField => change({ twitterAccountField })}
          options={[
            { value: 'auto', label: '自动识别 · ID / 用户名（默认）' },
            { value: 'username', label: 'username · 指定用户名' },
            { value: 'userId', label: 'userId · 指定账号 ID' },
            { value: 'user_id', label: 'user_id · 账号 ID 兼容字段' },
            { value: 'uid', label: 'uid · 账号 ID 兼容字段' },
            { value: 'url', label: 'url · 账号主页链接' },
            ...(form.twitterAccountField === 'original' ? [{ value: 'original', label: `原请求参数 · ${form.accountField || 'username'}（保留重放）` }] : []),
          ]} /> : null}
        {accountOperation && !twitterAccount ? <DropdownField label="账号标识字段" value={form.accountField || 'username'} disabled={busy || checking || Boolean(unresolved)} onChange={accountField => change({ accountField })}
          options={[{ value: 'username', label: 'username · 用户名' }, ...(threadsAccount ? [
            { value: 'url', label: 'url · Threads 主页链接' },
            ...(['profileUrl', 'profile_url'].includes(form.accountField) ? [{ value: form.accountField, label: `${form.accountField} · 原请求主页链接` }] : []),
          ] : []), { value: 'userId', label: 'userId · 平台账号 ID' }, { value: 'user_id', label: 'user_id · 兼容字段' }, { value: 'uid', label: 'uid · 兼容字段' }]} /> : null}
        <div className="mih-strategy-query-row"><label className="qp-field">{detail ? '帖子 ID、短码或链接' : accountOperation ? '账号标识' : '关键词'}<input className="qp-input" placeholder={detail ? 'https://www.threads.com/@用户名/post/短码' : twitterAccount ? '输入 Twitter / X 用户名或账号 ID' : accountOperation ? '输入该平台的用户名或账号 ID' : `在${currentPlatform?.label || '目标平台'}搜索关键词`} maxLength={detail ? 2048 : 500} value={form[formField] || ''} disabled={busy || checking || Boolean(unresolved)} onChange={event => change({ [formField]: event.target.value })} /></label>
          {!detail && operation !== 'user-info' ? <DropdownField label="每页数量" value={String(form.pageSize)} disabled={busy || checking || Boolean(unresolved) || form.platform.startsWith('wechat_')} onChange={value => change({ pageSize: Number(value) })} options={(accountOperation ? [10, 20, 50, 100, 500] : [10, 20, 50, 100]).map(value => ({ value: String(value), label: `${value} 条` }))} /> : null}
          <button className="qp-button qp-button--primary" disabled={!canSend}><MagnifyingGlass size={18} aria-hidden="true" />{busy ? '正在查询…' : attempt ? '重放 / 重试原查询' : detail ? '查询帖子' : accountOperation ? '查询账号' : '搜索'}</button></div>
        {twitterAccount ? <p className="mih-strategy-search-note">默认自动识别：纯数字先按账号 ID 查询（1–19 位），供应商明确报告该 ID 没有账号时再按同名用户名查询；其他文本按用户名查询。可手动指定用户名、ID 或主页链接；用户名由英文字母、数字或下划线组成，不是显示昵称。只查数字用户名请加 @ 或选择 username。</p> : null}
        {threadsAccount ? <p className="mih-strategy-search-note">Threads Scraper 接受用户名或主页链接；数字账号 ID 需选用支持 ID 的渠道。{operation === 'crawl' ? '此表单查询 posts；回复和转发需其他支持这些活动的渠道。' : ''}</p> : null}
        {twitterSearch ? <fieldset disabled={busy || checking || Boolean(unresolved)} className="mih-strategy-twitter-options">
          <legend>Twitter 搜索条件</legend>
          <div className="mih-strategy-twitter-fields">
            <DropdownField label="内容类别" value={twitterParams?.category || ''} disabled={busy || checking || Boolean(unresolved)} onChange={value => changeTwitter('category', value || undefined)}
              options={[...(!twitterParams?.category ? [{ value: '', label: '接口默认（保留原请求）' }] : []), { value: 'Latest', label: 'Latest · 最新（默认）' }, { value: 'Top', label: 'Top · 热门' }, { value: 'Photos', label: 'Photos · 图片' }, { value: 'Videos', label: 'Videos · 视频' }]} />
            <DropdownField label="包含时间戳" value={twitterParams?.includeTimestamp === undefined ? '' : String(twitterParams.includeTimestamp)} disabled={busy || checking || Boolean(unresolved)} onChange={value => changeTwitter('includeTimestamp', value === '' ? undefined : value === 'true')}
              options={[{ value: '', label: '默认 · 否' }, { value: 'true', label: '是' }, { value: 'false', label: '否' }]} />
            <label className="qp-field mih-strategy-twitter-filters">附加筛选（filters）<input className="qp-input" placeholder="可选，按接口约定填写筛选条件" maxLength={2048} value={twitterParams?.filters || ''} onChange={event => changeTwitter('filters', event.target.value || undefined)} /></label>
          </div>
          <p className="mih-strategy-search-note">新查询默认 Latest，可覆盖类别与筛选条件。People 返回账号，不适用于此内容搜索接口。每页数量是 Hub 的交付目标，可能合并多次上游调用；使用返回的游标读取下一页。</p>
        </fieldset> : null}
        <p className="mih-strategy-search-note">仅点击查询或下一页时调用，按当前账户价格计量。切换业务接口、平台与标签不会查询。{detail ? null : accountOperation ? '批量账号、活动类型与平台参数可在接口调试中提交。' : <>跨平台同时检索请使用<a href="#/data-products/search">聚合搜索 ↗</a>。</>}</p>
        {form.platform.startsWith('wechat_') ? <p className="mih-strategy-search-note">微信返回原生一页，不保证 20 条；使用原生 items、continue_flag 与 cursor，完整业务字段保持不变。</p> : null}
        {form[formField] && validation ? <p role="status">{validation}</p> : null}
        {attempt && !unresolved ? <div className="mih-strategy-repeat"><span>{accountOperation || detail ? '相同参数沿用原请求标识；按接口规则回放已有结果。' : '本页使用 stable 保留首次响应；相同参数沿用原请求标识。'}</span><button className="qp-button qp-button--outline qp-button--sm" type="button" disabled={busy || checking} onClick={() => prepare(attempt)}>新建相同查询（再次发送会计量）</button></div> : null}
      </form>
      {unresolved ? <div className="mih-strategy-unresolved" role="alert"><strong>原请求结果待核实</strong><p>此平台的原请求保持锁定。超时不代表取消；请先只读核对，避免重复采集和计费。可选择其他平台，切换不会发送请求。</p><p>幂等键 <code>{unresolved.idempotencyKey}</code></p>{unresolved.requestId ? <p>Hub 请求 ID <code>{unresolved.requestId}</code></p> : null}<button className="qp-button qp-button--outline" type="button" disabled={!key || busy || checking} onClick={checkOutcome}>{checking ? '核对中…' : '只读核对原请求状态'}</button>{unresolved.requestId ? <a href={`#/usage?requestId=${encodeURIComponent(unresolved.requestId)}`}>查看使用记录 ↗</a> : null}
        {canPrepareUnknown ? <div><p>原请求已记录为 unknown，结束时间：{formatDate(unresolved.checkedOutcome.completedAt)}。原结果和费用仍未知，记录会保留；准备不会发送，再次点击搜索会计量。</p><button className="qp-button qp-button--outline" type="button" disabled={!key || busy || checking} onClick={() => prepare(unresolved)}>准备新查询（再次发送会计量）</button></div> : null}
      </div> : null}
      {state.outcomeNote ? <p role="status">{state.outcomeNote}</p> : null}
      {unknownHistory.length ? <details><summary>已保留的原请求（结果和费用仍未知）</summary>{unknownHistory.map(row => <div key={row.idempotencyKey}><p>Hub 请求 ID <a href={`#/usage?requestId=${encodeURIComponent(row.requestId)}`}>{row.requestId}</a> · unknown</p><p>幂等键 <code>{row.idempotencyKey}</code> · 已记录结束时间 {formatDate(row.checkedOutcome.completedAt)}</p></div>)}</details> : null}
      {error ? <ErrorState error={unresolved?.requestId && error === unresolved.error ? { ...error, message: error.message, requestId: unresolved.requestId } : error} /> : null}
    </section>
    {result?.identity === identity ? <>
      {!matching ? <p className="qp-muted">以下保留已返回结果；更改接口、平台或查询条件后需手动查询。</p> : null}
      <StrategySearchResult payload={result.payload} evidence={result.evidence} operation={result.input?.path.split('/').at(-1)} onOpenComments={onOpenComments} />
      {!detail && matching && pageInfo?.hasMore && pageInfo.nextCursor ? <button className="qp-button qp-button--outline mih-strategy-next" type="button" disabled={!canSend} onClick={() => search({ ...result.input.body, cursor: pageInfo.nextCursor })}><ArrowDown size={16} aria-hidden="true" />读取下一页（按当前规则计量）</button> : null}
      <details className="qp-panel mih-panel mih-strategy-response"><summary>完整响应与请求证据</summary><pre className="mih-api-response" role="region" aria-label="完整响应 JSON" tabIndex={0}>{JSON.stringify(result.payload, null, 2)}</pre><AdminExecutionEvidence requestId={result.evidence?.requestId} /></details>
    </> : <section className="qp-panel mih-panel mih-strategy-result-empty"><MagnifyingGlass size={32} weight="duotone" /><h3>{detail ? '帖子详情将在这里展示' : operation === 'user-info' ? '账号资料将在这里展示' : accountOperation ? '账号内容将在这里展示' : '搜索内容将在这里展示'}</h3><p>{operation === 'user-info' ? '查看账号名称、简介、公开指标和主页链接。' : '可按平台查看正文、作者、互动指标与原文链接。'}</p></section>}
  </div>
}

// A search row can open its comments when the platform has a comment
// interface and the row carries the platform's post ID. Zhihu comments are
// answer comments, so only answer rows qualify.
function commentTarget(item, data) {
  const platform = item.platform || data?.platform, contentId = item.externalId || item.external_id
  if (!COMMENT_PLATFORMS.has(platform) || typeof contentId !== 'string' || !contentId) return null
  if (platform === 'zhihu' && !String(item.contentType || '').includes('answer')) return null
  return { platform, contentId }
}

export function StrategySearchResult({ payload, evidence, operation = 'search', onOpenComments }) {
  const [images, setImages] = useState(true)
  const data = payload?.data, nativeWechat = payload?.endpoint === 'wechat.search.search'
  const detail = operation === 'post-detail'
  const entries = detail ? data?.item && [data.item] : data?.items
  const items = !nativeWechat && Array.isArray(entries) ? entries.map(item => strategyAccountItem(item, operation)) : null
  if (!nativeWechat && !items) return <p>此接口返回原始业务数据，完整字段见响应。</p>
  if (operation === 'user-info') return <StrategyAccountProfiles items={items || []} data={data} evidence={evidence} />
  const label = STRATEGY_SEARCH_PLATFORMS.find(row => row.platform === data?.platform)?.label || (nativeWechat ? '微信搜索' : data?.platform)
  const metricLabels = { likes: '点赞', comments: '评论', shares: '分享', views: '浏览', bookmarks: '收藏' }
  return <section className="qp-panel mih-panel mih-strategy-results" aria-label={detail ? '帖子详情' : '内容搜索结果'}>
    <header><div><p className="qp-kicker">{label}</p><h2>{detail ? '帖子详情' : data?.query || '已返回搜索内容'}</h2>{!detail && <p>{nativeWechat ? '微信原生业务响应' : `本页 ${items.length} 条 · ${!items.length ? '本页无内容' : data?.status === 'partial' ? '部分返回' : '已返回'}`}</p>}</div>
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
          <footer><span>{item.contentType || '内容'}{item.externalId || item.id ? ` · ${item.externalId || item.id}` : ''}</span><span className="mih-strategy-media-links">{commentTarget(item, data) && onOpenComments ? <button type="button" className="qp-button qp-button--outline qp-button--sm" onClick={() => onOpenComments(commentTarget(item, data))}>查看评论</button> : null}{photoPages.map((href, index) => <a key={href} href={href} target="_blank" rel="noopener noreferrer">查看配图{photoPages.length > 1 ? ` ${index + 1}` : ''} <ArrowUpRight size={14} aria-hidden="true" /></a>)}{url ? <a href={url} target="_blank" rel="noopener noreferrer">查看原文 <ArrowUpRight size={14} aria-hidden="true" /></a> : <span>原文链接未提供</span>}</span></footer>
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
