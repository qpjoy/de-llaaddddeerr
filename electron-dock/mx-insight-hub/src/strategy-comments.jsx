import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, ArrowDown, ArrowUpRight, ChatCircleText } from '@phosphor-icons/react'
import { publicDataApi } from './api.js'
import { DropdownField, ErrorState, formatDate } from './components.jsx'
import { useDemoApiKey, useDemoAccessSnapshot, useDemoIdentity } from './demo-credentials.jsx'
import { AdminExecutionEvidence } from './admin-execution-evidence.jsx'
import { requestUuid } from './request-id.js'
import { safeStrategyUrl } from './strategy-search-experience-model.js'
import { STRATEGY_COMMENT_PATHS, strategyCommentPlatforms, strategyCommentBody, strategyCommentPage, strategyCommentRows,
  commentIdHint, replyNeedsContent, strategyCommentFailure } from './strategy-comments-model.js'
import { commentRoutePlatforms } from '../server/contracts/comment-routes.mjs'

const OPERATIONS = [{ value: 'search', label: '内容搜索' }, { value: 'crawl', label: '账号内容' }, { value: 'user-info', label: '账号资料' },
  { value: 'post-comments', label: '帖子评论' }, { value: 'comment-replies', label: '评论回复' }]
const REPLY_PLATFORMS = new Set(commentRoutePlatforms('comment-replies'))
const statusText = { continuable: '可继续读取下一页', exhausted: '已到最后一页', unknown: '是否还有更多无法确认（不要自动循环）', limit_reached: '已达到 15 页上限' }

// Product display for the two comment interfaces. Sending happens only on an
// explicit click; an identical request reuses its Idempotency-Key so a retry
// replays instead of buying again.
export function StrategyCommentsExperience({ operation, onOperationChange, prefill = {}, onOpenReplies, admin }) {
  const [key] = useDemoApiKey()
  const identity = useDemoIdentity(), access = useDemoAccessSnapshot()
  const platforms = strategyCommentPlatforms(access, operation)
  const [form, setForm] = useState(() => ({ platform: prefill.platform || platforms[0]?.platform || '', contentId: prefill.contentId || '',
    commentId: prefill.commentId || '', count: 20 }))
  const [result, setResult] = useState(null), [busy, setBusy] = useState(false), [failure, setFailure] = useState(null)
  const attempts = useRef(new Map()), pending = useRef(false), visible = useRef(null)
  useEffect(() => {
    if (prefill.platform || prefill.contentId || prefill.commentId) setForm(current => ({ ...current,
      ...(prefill.platform ? { platform: prefill.platform } : {}), contentId: prefill.contentId ?? current.contentId,
      commentId: prefill.commentId ?? current.commentId }))
  }, [prefill.platform, prefill.contentId, prefill.commentId])
  useEffect(() => { if (platforms.length && !platforms.some(row => row.platform === form.platform)) setForm(current => ({ ...current, platform: platforms[0].platform })) }, [operation, platforms.length])
  let body = null, validation = ''
  try { body = strategyCommentBody(operation, form, platforms) } catch (failure) { validation = failure.message }
  const path = STRATEGY_COMMENT_PATHS[operation]
  const formScope = JSON.stringify([identity, path, body])
  const rows = result?.formScope === formScope ? strategyCommentRows(result.payload) : null
  const page = rows ? strategyCommentPage(result.payload) : null
  const nextCursor = page?.nextCursor
  const feedback = strategyCommentFailure(failure, { formScope, operation, nextCursor, admin })
  const rejected = feedback?.canRequery ? failure : null
  useLayoutEffect(() => {
    visible.current = { formScope, nextCursor, rejected }
    return () => { visible.current = null }
  }, [formScope, nextCursor, rejected])
  const change = patch => { setForm(current => ({ ...current, ...patch })); setFailure(null) }
  async function send(requestBody, replace = null) {
    if (!key || !requestBody || pending.current || visible.current?.formScope !== formScope
      || (requestBody.cursor && requestBody.cursor !== visible.current.nextCursor)) return
    const input = { method: 'POST', path, body: requestBody }, scope = JSON.stringify([identity, input])
    const originalKey = attempts.current.get(scope)
    if (replace && (replace !== visible.current.rejected || replace.idempotencyKey !== originalKey)) return
    const idempotencyKey = replace || !originalKey ? requestUuid() : originalKey
    attempts.current.set(scope, idempotencyKey)
    pending.current = true
    setBusy(true); setFailure(null)
    try {
      const response = await publicDataApi.productRequest(key, input, idempotencyKey)
      if (visible.current?.formScope === formScope) setResult({ ...response, formScope, input })
    } catch (error) {
      if (visible.current?.formScope === formScope) setFailure({ error, formScope, body: requestBody, idempotencyKey })
    } finally { pending.current = false; setBusy(false) }
  }
  const replies = operation === 'comment-replies'
  return <div className="mih-strategy-experience">
    <section className="qp-panel mih-panel mih-strategy-composer" aria-label="评论产品展示">
      <header><div><p className="qp-kicker">评论数据</p><h2>{replies ? '查看一条评论下的回复' : '按帖子查看评论'}</h2>
        <p>{replies ? '传入评论 ID；抖音、小红书、快手、B站、Instagram、Reddit 还需要所属帖子 ID。从帖子评论点「查看回复」会自动带上。' : '每次查询一个平台的一篇帖子，返回一级评论；每条评论都可以继续查看回复。'}</p></div>
        <code>POST {path}</code></header>
      {onOperationChange ? <DropdownField label="业务接口" value={operation} onChange={onOperationChange} options={OPERATIONS} /> : null}
      <form onSubmit={event => { event.preventDefault(); void send(body) }}>
        <fieldset>
          <legend>目标平台 <span>{!key ? '请选择调用身份（可预览支持平台）' : access ? `当前 Key 可见 ${platforms.length} 个` : '支持平台 · 发送时验证权限'}</span></legend>
          <div className="mih-strategy-platform-grid">{platforms.map(row => <button type="button" key={row.platform} aria-pressed={form.platform === row.platform}
            className={`mih-strategy-platform${form.platform === row.platform ? ' is-selected' : ''}`} onClick={() => change({ platform: row.platform })}>
            <span className={`mih-strategy-platform-mark is-${row.platform}`} aria-hidden="true">{row.mark}</span><span>{row.label}</span>
            {form.platform === row.platform ? <Check size={15} weight="bold" aria-hidden="true" /> : null}</button>)}</div>
          {!platforms.length ? <p>当前 Key 没有可调用的评论平台。需要目标平台和 social.comments.list 授权。</p> : null}
        </fieldset>
        <div className="mih-strategy-query-row">
          {replies ? <label className="qp-field">评论 ID（commentId）<input className="qp-input" value={form.commentId} disabled={busy}
            onChange={event => change({ commentId: event.target.value })} placeholder="帖子评论结果中的 commentId" maxLength={128} /></label> : null}
          <label className="qp-field">{replies ? `所属帖子 contentId${replyNeedsContent(form.platform) ? '（必填）' : '（可选）'}` : '帖子 contentId 或链接'}
            <input className="qp-input" value={form.contentId} disabled={busy} onChange={event => change({ contentId: event.target.value })}
              placeholder={commentIdHint(form.platform)} maxLength={2048} /></label>
          <DropdownField label="每页数量" value={String(form.count)} disabled={busy} onChange={value => change({ count: Number(value) })}
            options={[10, 20, 50, 100].map(value => ({ value: String(value), label: `${value} 条` }))} />
          <button className="qp-button qp-button--primary" disabled={!key || !body || busy}><ChatCircleText size={18} aria-hidden="true" />{busy ? '正在查询…' : replies ? '查看回复' : '查看评论'}</button>
        </div>
        <p className="mih-strategy-search-note">查询和下一页按当前账户价格计量。相同参数会回放原请求已保存的结果；点击「重新查询」会发起新的计费请求。Twitter、Reddit、快手、微博每次只取一页来源数据，条数可能少于每页数量。</p>
        {(form.contentId || form.commentId) && validation ? <p role="status">{validation}</p> : null}
      </form>
      {feedback ? <><ErrorState error={feedback.error} />
        {feedback.sourceStatus ? <p>数据源返回 {feedback.sourceStatus}</p> : null}
        {feedback.error.evidence?.idempotentReplay ? <p>本次回放原请求已保存的失败结果。</p> : null}
        {feedback.diagnostic ? <p><a href={feedback.diagnostic}>查看原请求诊断</a></p> : null}
        {rejected ? <button type="button" className="qp-button qp-button--outline" disabled={!key || busy}
          onClick={() => send(rejected.body, rejected)}>重新查询（按新请求计费）</button> : null}</> : null}
    </section>
    {rows ? <section className="qp-panel mih-panel mih-strategy-results" aria-label={replies ? '评论回复结果' : '帖子评论结果'}>
      <header><div><p className="qp-kicker">{platforms.find(row => row.platform === result.payload?.data?.platform)?.label || result.payload?.data?.platform}</p>
        <h2>{replies ? `评论 ${result.payload?.data?.commentId} 的回复` : `帖子 ${result.payload?.data?.postId} 的评论`}</h2>
        <p>本页 {rows.length} 条 · {statusText[page?.paginationStatus] || '分页状态以响应为准'}</p></div></header>
      {(result.payload?.data?.warnings || []).length ? <div role="status" className="mih-strategy-result-warnings">{result.payload.data.warnings.map((warning, index) => <p key={`${warning.code}:${index}`}><strong>{warning.code}</strong> · {warning.message}</p>)}</div> : null}
      {rows.length ? <div className="mih-strategy-result-list">{rows.map((item, index) => {
        const url = safeStrategyUrl(item.url), avatar = safeStrategyUrl(item.author?.avatarUrl)
        const canReply = !replies && item.replyRef && REPLY_PLATFORMS.has(item.platform)
        return <article key={item.id || index} className="mih-strategy-result-card">
          {avatar ? <img src={avatar} alt="评论作者头像" loading="lazy" referrerPolicy="no-referrer" onError={event => { event.currentTarget.hidden = true }} /> : null}
          <div><header><strong>{item.author?.name || '作者未提供'}</strong><span>{item.publishedAt ? formatDate(item.publishedAt) : item.publishedTime || '发布时间未提供'}</span></header>
            <p className="mih-strategy-result-text">{item.text ?? '此条评论没有文字（可能是图片或贴纸）。'}</p>
            <div className="mih-strategy-result-metrics"><span>点赞 <b>{item.likeCount == null ? '未提供' : item.likeCount.toLocaleString()}</b></span>
              <span>回复 <b>{item.replyCount == null ? '未提供' : item.replyCount.toLocaleString()}</b></span>
              {item.metrics?.score !== undefined ? <span>得分 <b>{item.metrics.score ?? '隐藏'}</b></span> : null}
              {replies && item.parentCommentId && item.parentCommentId !== item.rootCommentId ? <span>回复给 <b>{item.parentCommentId}</b></span> : null}</div>
            <footer><span>commentId · {item.commentId}</span><span className="mih-strategy-media-links">
              {canReply ? <button type="button" className="qp-button qp-button--outline qp-button--sm" onClick={() => onOpenReplies?.(item.replyRef)}>查看回复</button> : null}
              {url ? <a href={url} target="_blank" rel="noopener noreferrer">原文 <ArrowUpRight size={14} aria-hidden="true" /></a> : null}</span></footer>
          </div>
        </article>
      })}</div> : <p>{page?.nextCursor ? '本页没有评论，但响应仍提供后续游标；可手动读取下一页。' : '本页没有评论。'}</p>}
      {result.evidence?.requestId ? <p className="mih-strategy-search-note">{result.evidence.idempotentReplay ? '原请求回放' : '本次返回'} · 请求 {result.evidence.requestId}</p> : null}
    </section> : <section className="qp-panel mih-panel mih-strategy-result-empty"><ChatCircleText size={32} weight="duotone" /><h3>{replies ? '回复将在这里展示' : '评论将在这里展示'}</h3><p>选择平台并输入 ID 后点击查询。</p></section>}
    {rows && page?.nextCursor ? <button className="qp-button qp-button--outline mih-strategy-next" type="button" disabled={!key || busy}
      onClick={() => send({ ...result.input.body, cursor: page.nextCursor })}><ArrowDown size={16} aria-hidden="true" />读取下一页（按当前规则计量）</button> : null}
    {rows ? <details className="qp-panel mih-panel mih-strategy-response"><summary>完整响应与请求证据</summary><pre className="mih-api-response" role="region" aria-label="完整响应 JSON" tabIndex={0}>{JSON.stringify(result.payload, null, 2)}</pre><AdminExecutionEvidence requestId={result.evidence?.requestId} /></details> : null}
  </div>
}
